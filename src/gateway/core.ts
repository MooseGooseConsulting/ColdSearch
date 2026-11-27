import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { APP_VERSION } from "../app.js";
import { KeyPoolManager } from "../engine/keypool.js";
import { safeKeyRef } from "../logging/usage.js";
import { toolAllowed, type GatewayConfig, type UpstreamConfig } from "./config.js";
import { connectOpenApi } from "./openapi.js";
import { extractCost, Ledger, redact, type LedgerEntry, type LedgerSummaryRow } from "./ledger.js";

/** The part of an MCP client the gateway needs from an upstream connection. */
export interface UpstreamClient {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean }
  ): Promise<unknown>;
  close(): Promise<void>;
}

/** Opens a connection to one upstream with one resolved key. */
export type Connector = (upstream: UpstreamConfig, keyValue: string) => Promise<UpstreamClient>;

/** Resolves a key reference to its value. */
export type KeyResolver = (keyRef: string) => Promise<string>;

export interface GatewayTool {
  /** Name the agent sees: `<upstream>__<tool>`. */
  name: string;
  upstream: string;
  tool: Tool;
}

export interface CallContext {
  session: string;
  client?: string;
}

type KeyFault = "quota" | "auth";

interface KeyState {
  until: number;
  reason: KeyFault;
  since: string;
}

export interface GatewayStatus {
  mode: string;
  ledger: string;
  upstreams: Array<{
    name: string;
    tools: number | null;
    error?: string;
    keys: Array<{ key: string; state: "active" | "standby" | "skipped"; reason?: KeyFault; retry_at?: string }>;
  }>;
  last_24h: LedgerSummaryRow[];
  last_7d: LedgerSummaryRow[];
}

/** Separator between upstream name and tool name in gateway tool names. */
export const NAME_SEPARATOR = "__";

const CALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Error text that means "this account has no credit left", as documented by
 * the vendors: HTTP 402 (Exa, Firecrawl, Parallel), Tavily's 432, and their
 * error codes. Rate limiting (429) is deliberately absent: it clears in
 * seconds and must not sideline a key for hours.
 */
const QUOTA_PATTERN =
  /\b402\b|\b432\b|payment required|insufficient[ _]credits?|no_more_credits|out of credits|credits? (?:are )?(?:exhausted|depleted)|quota (?:exceeded|exhausted)|exceeds your plan|budget_exceeded/i;
const AUTH_PATTERN = /\b401\b|invalid[ _]api[ _]key|unauthorized|invalid token|missing authorization/i;

export function classifyFault(text: string): KeyFault | undefined {
  if (QUOTA_PATTERN.test(text)) return "quota";
  if (AUTH_PATTERN.test(text)) return "auth";
  return undefined;
}

function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text") parts.push(item.text);
  }
  return parts.join("\n");
}

/**
 * A copy of `value` with every known key value replaced in each string it
 * holds, property names included. A provider can echo the credential it was
 * sent (in an error body, or a URL that carries it as a query parameter), and
 * the result is about to be handed to an agent.
 */
function withoutSecrets<T>(value: T, secrets: Set<string>): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => withoutSecrets(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key, secrets), withoutSecrets(item, secrets)])
    ) as T;
  }
  return value;
}

/**
 * Some upstreams report a failed call as a successful tool result whose text
 * is a small JSON error object (Tavily returns `{"error": ..., "status": 432}`
 * this way when a plan is used up). Returns that text when the result has
 * this shape, so it is handled like any other upstream error.
 */
function errorPayload(result: CallToolResult): string | undefined {
  const text = resultText(result).trim();
  if (!text.startsWith("{") || text.length > 2000) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && parsed.error !== undefined ? text : undefined;
  } catch {
    return undefined;
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Streamable HTTP to a vendor's hosted MCP server. */
export const httpConnector: Connector = async (upstream, keyValue) => {
  const url = new URL(upstream.url);
  const headers: Record<string, string> = { ...upstream.headers };
  if (upstream.auth === "header") {
    headers[upstream.authName] = `${upstream.authPrefix}${keyValue}`;
  } else if (upstream.auth === "query") {
    url.searchParams.set(upstream.authName, keyValue);
  }
  const client = new Client({ name: "coldsearch-gateway", version: APP_VERSION });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await client.connect(transport);
  return client as unknown as UpstreamClient;
};

/** Connect by the upstream's kind: its API document, or its hosted MCP server. */
export const defaultConnector: Connector = (upstream, keyValue) =>
  upstream.kind === "openapi" ? connectOpenApi(upstream, keyValue) : httpConnector(upstream, keyValue);

/**
 * The shared heart of the gateway: one instance serves every connected agent.
 * It owns upstream connections, decides which key each call uses, moves to the
 * next key when one is out of credit, and writes the ledger.
 */
export class GatewayCore {
  readonly ledger: Ledger;
  private readonly upstreams: Map<string, UpstreamConfig>;
  private readonly connections = new Map<string, { fingerprint: string; client: UpstreamClient }>();
  private readonly toolCache = new Map<string, { at: number; tools: Tool[] }>();
  private readonly upstreamErrors = new Map<string, string>();
  private readonly secrets = new Set<string>();
  private keyStates: Record<string, KeyState>;
  private readonly connector: Connector;
  private readonly resolveKey: KeyResolver;
  private readonly now: () => number;

  constructor(
    readonly config: GatewayConfig,
    options: { connector?: Connector; resolveKey?: KeyResolver; now?: () => number } = {}
  ) {
    this.ledger = new Ledger(config.ledgerPath, config.logArguments, config.payloadDir);
    this.upstreams = new Map(config.upstreams.map((upstream) => [upstream.name, upstream]));
    this.connector = options.connector ?? defaultConnector;
    if (options.resolveKey) {
      this.resolveKey = options.resolveKey;
    } else {
      const pool = new KeyPoolManager();
      this.resolveKey = (ref) => pool.resolveRef(ref);
    }
    this.now = options.now ?? Date.now;
    this.keyStates = this.loadState();
  }

  // --- key state -----------------------------------------------------------

  private stateId(upstream: string, keyRef: string): string {
    return `${upstream}|${keyRef}`;
  }

  private loadState(): Record<string, KeyState> {
    try {
      const parsed = JSON.parse(readFileSync(this.config.statePath, "utf8")) as { keys?: Record<string, KeyState> };
      return parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {};
    } catch {
      return {};
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.config.statePath), { recursive: true });
      const tmp = `${this.config.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ keys: this.keyStates }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.config.statePath);
    } catch (error) {
      process.stderr.write(`coldsearch gateway: state write failed (${(error as Error).message})\n`);
    }
  }

  private skipped(upstream: string, keyRef: string): KeyState | undefined {
    const state = this.keyStates[this.stateId(upstream, keyRef)];
    return state && state.until > this.now() ? state : undefined;
  }

  private markKey(upstream: string, keyRef: string, reason: KeyFault): void {
    const now = this.now();
    this.keyStates[this.stateId(upstream, keyRef)] = {
      until: now + this.config.exhaustedCooldownMs,
      reason,
      since: new Date(now).toISOString(),
    };
    this.saveState();
  }

  /**
   * Keys to try, in order: usable keys in configured order, then skipped keys
   * soonest-to-return first, so a call is still attempted when every key is
   * marked and the first one has since been topped up or reset.
   */
  private keyOrder(upstream: UpstreamConfig): string[] {
    if (upstream.auth === "none") return [""];
    const usable = upstream.keys.filter((key) => !this.skipped(upstream.name, key));
    const marked = upstream.keys
      .filter((key) => this.skipped(upstream.name, key))
      .sort((a, b) => this.skipped(upstream.name, a)!.until - this.skipped(upstream.name, b)!.until);
    return [...usable, ...marked];
  }

  // --- connections ---------------------------------------------------------

  private async connect(upstream: UpstreamConfig, keyRef: string): Promise<UpstreamClient> {
    const value = keyRef ? await this.resolveKey(keyRef) : "";
    if (value) this.secrets.add(value);
    // The fingerprint notices a key reference whose value was changed in the
    // secret store, so the next call reconnects with the new value.
    const fingerprint = createHash("sha256").update(value).digest("hex");
    const id = this.stateId(upstream.name, keyRef);
    const existing = this.connections.get(id);
    if (existing && existing.fingerprint === fingerprint) return existing.client;
    if (existing) void existing.client.close().catch(() => undefined);
    const client = await this.connector(upstream, value);
    this.connections.set(id, { fingerprint, client });
    return client;
  }

  private dropConnection(upstream: string, keyRef: string): void {
    const id = this.stateId(upstream, keyRef);
    const existing = this.connections.get(id);
    if (!existing) return;
    this.connections.delete(id);
    void existing.client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const clients = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(clients.map(({ client }) => client.close().catch(() => undefined)));
  }

  // --- tools ---------------------------------------------------------------

  private async upstreamTools(upstream: UpstreamConfig): Promise<Tool[]> {
    const cached = this.toolCache.get(upstream.name);
    if (cached && this.now() - cached.at < this.config.toolListTtlMs) return cached.tools;

    let lastError = "no keys configured";
    for (const keyRef of this.keyOrder(upstream)) {
      try {
        const client = await this.connect(upstream, keyRef);
        const listed = await client.listTools();
        const tools = listed.tools.filter((tool) => toolAllowed(upstream, tool.name));
        this.toolCache.set(upstream.name, { at: this.now(), tools });
        this.upstreamErrors.delete(upstream.name);
        return tools;
      } catch (error) {
        lastError = redact((error as Error).message ?? String(error), this.secrets);
        this.dropConnection(upstream.name, keyRef);
        const fault = classifyFault(lastError);
        if (fault && keyRef) this.markKey(upstream.name, keyRef, fault);
      }
    }
    this.upstreamErrors.set(upstream.name, lastError.slice(0, 300));
    // A stale list is better than hiding an upstream's tools over one bad fetch.
    return cached?.tools ?? [];
  }

  /** Every upstream's tools under gateway names. An upstream that fails is skipped and reported by status(). */
  async listTools(): Promise<GatewayTool[]> {
    const lists = await Promise.all(
      [...this.upstreams.values()].map(async (upstream) => {
        const tools = await this.upstreamTools(upstream);
        return tools.map((tool) => ({ name: `${upstream.name}${NAME_SEPARATOR}${tool.name}`, upstream: upstream.name, tool }));
      })
    );
    return lists.flat();
  }

  /**
   * Forward one tool call. Tries keys in order; an out-of-credit or rejected
   * key is marked and the next one is tried. Any other failure is returned to
   * the agent as the upstream reported it. Every attempt is one ledger line.
   */
  async callTool(name: string, args: Record<string, unknown> | undefined, context: CallContext): Promise<CallToolResult> {
    const split = name.indexOf(NAME_SEPARATOR);
    const upstream = split > 0 ? this.upstreams.get(name.slice(0, split)) : undefined;
    if (!upstream) {
      return errorResult(
        `Unknown tool "${name}". Gateway tool names are <upstream>${NAME_SEPARATOR}<tool>; upstreams: ${[...this.upstreams.keys()].join(", ")}.`
      );
    }
    const tool = name.slice(split + NAME_SEPARATOR.length);
    if (!toolAllowed(upstream, tool)) {
      return errorResult(`Tool "${name}" is not offered by this gateway (hidden by the upstream's include/exclude lists).`);
    }
    const order = this.keyOrder(upstream);
    let last: CallToolResult = errorResult(`No keys configured for upstream "${upstream.name}".`);

    for (let attempt = 0; attempt < order.length; attempt++) {
      const keyRef = order[attempt];
      const started = this.now();
      const entry: LedgerEntry = {
        ts: new Date(started).toISOString(),
        session: context.session,
        client: context.client,
        upstream: upstream.name,
        tool,
        key: keyRef ? safeKeyRef(keyRef, upstream.name) : `${upstream.name}:keyless`,
        attempt: attempt + 1,
        ok: false,
        duration_ms: 0,
      };

      let fault: KeyFault | undefined;
      let response: unknown;
      try {
        const client = await this.connect(upstream, keyRef);
        entry.args = this.ledger.formatArgs(args, this.secrets);
        const result = (await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        })) as CallToolResult;
        entry.duration_ms = this.now() - started;
        entry.result_bytes = JSON.stringify(result).length;
        last = withoutSecrets(result, this.secrets);
        response = result;
        const failure = result.isError ? resultText(result) : errorPayload(result);
        if (failure !== undefined) {
          const text = failure;
          fault = classifyFault(text);
          entry.error_class = fault ?? "upstream";
          entry.error = this.ledger.formatError(text, this.secrets);
        } else {
          entry.ok = true;
          entry.cost = extractCost(result);
        }
      } catch (error) {
        entry.duration_ms = this.now() - started;
        const message = redact((error as Error).message ?? String(error), this.secrets);
        fault = classifyFault(message);
        entry.error_class = fault ?? "upstream";
        entry.error = this.ledger.formatError(message, this.secrets);
        // The connection may be the thing that broke; the next call reconnects.
        this.dropConnection(upstream.name, keyRef);
        last = errorResult(`${upstream.name} ${tool} failed: ${message}`);
        response = { thrown: message };
      }

      entry.payload = this.ledger.writePayload(entry, { name: tool, arguments: args }, response, this.secrets);

      this.ledger.append(entry);
      if (entry.ok || !fault || !keyRef) return last;
      this.markKey(upstream.name, keyRef, fault);
    }

    const tried = order.length;
    const detail = resultText(last);
    return errorResult(
      `${upstream.name}: all ${tried} configured key${tried === 1 ? "" : "s"} failed (out of credit or rejected). Last error: ${detail}`
    );
  }

  // --- status --------------------------------------------------------------

  status(): GatewayStatus {
    const day = 86_400_000;
    return {
      mode: this.config.mode,
      ledger: this.ledger.getPath(),
      upstreams: [...this.upstreams.values()].map((upstream) => {
        let activeAssigned = false;
        return {
          name: upstream.name,
          tools: this.toolCache.get(upstream.name)?.tools.length ?? null,
          error: this.upstreamErrors.get(upstream.name),
          keys: upstream.keys.map((keyRef) => {
            const skipped = this.skipped(upstream.name, keyRef);
            const key = safeKeyRef(keyRef, upstream.name);
            if (skipped) {
              return { key, state: "skipped" as const, reason: skipped.reason, retry_at: new Date(skipped.until).toISOString() };
            }
            if (!activeAssigned) {
              activeAssigned = true;
              return { key, state: "active" as const };
            }
            return { key, state: "standby" as const };
          }),
        };
      }),
      last_24h: this.ledger.summarize(day, this.now()),
      last_7d: this.ledger.summarize(7 * day, this.now()),
    };
  }
}

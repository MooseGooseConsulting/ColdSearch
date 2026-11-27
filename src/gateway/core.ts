import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { APP_VERSION } from "../app.js";
import { KeyPoolManager } from "../engine/keypool.js";
import { safeKeyRef } from "../logging/usage.js";
import { matchesPattern, toolAllowed, type GatewayConfig, type UpstreamConfig } from "./config.js";
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
 * Vendor wording for "this account or key has no credit left". Each holds
 * whatever HTTP status came with it:
 * - `Payment Required`, `Insufficient credits` (Firecrawl, Parallel, Context.dev, TinyFish `INSUFFICIENT_CREDITS`)
 * - `NO_MORE_CREDITS`, `API_KEY_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED` (Exa error tags)
 * - `exceeds your plan's set usage limit` (Tavily, with HTTP 432)
 * - `Not enough credits` (Serper, with HTTP 400)
 * - `free_allowance_exhausted` (TinyFish, with HTTP 429 for Search and Fetch and as a 402 code elsewhere)
 * - `Usage limit reached`, `out of free credits`, `not enough funds`, `client_10100` (Bright Data;
 *   the last is its `x-brd-err-code` response header)
 */
const QUOTA_PATTERN =
  /payment required|insufficient[ _]credits?|not enough credits|no_more_credits|budget_exceeded|out of (?:free )?credits|credits? (?:are )?(?:exhausted|depleted)|exceeds your plan|free_allowance_exhausted|usage limit reached|not enough funds|client_10100/i;
/** HTTP 402 (Exa, Firecrawl, Parallel and others), and Tavily's 432 (plan limit) and 433 (pay-as-you-go limit). Tavily's 434 is a capacity error and is absent. */
const QUOTA_STATUS = /\b(?:402|432|433)\b/;
/**
 * A refusal that shares a quota status and says nothing about the balance.
 * Jina answers HTTP 402 with `TierFeatureConstraintError` (application status
 * 40202) when a call asks for a feature above the key's plan; its empty
 * balance is `InsufficientBalanceError`, 40203. Another key on the same plan
 * gets the same answer, so the key is not held to blame.
 */
const PLAN_REFUSAL_PATTERN = /TierFeatureConstraintError|"status"\s*:\s*40202\b/;
/** Looser wording, trusted only when nothing says the call was rate limited. */
const QUOTA_LOOSE_PATTERN = /quota (?:exceeded|exhausted)/i;
/** A short-lived limit: it clears in seconds and must not sideline a key for hours. */
const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests/i;
/** A rejected key. `SUBSCRIPTION_TOKEN_INVALID` is Brave's code, sent with HTTP 422. */
const AUTH_PATTERN = /invalid[ _]api[ _]key|unauthorized|invalid token|missing authorization|subscription_token_invalid/i;

/**
 * Decide whether an error means the key is out of credit (`quota`) or was
 * rejected (`auth`); anything else is undefined and is not held against the key.
 *
 * Text that starts with `HTTP <status>:`, as every `openapi` upstream error
 * does, is judged by that status, and numbers further in are not read as
 * statuses. Other text (an MCP server's error) is searched for the status
 * numbers. A rate-limited call (HTTP 429, or rate-limit wording when no
 * status leads) is `quota` only when it carries one of the vendor phrases in
 * `QUOTA_PATTERN`. A plan refusal (`PLAN_REFUSAL_PATTERN`) is never `quota`,
 * whatever status it came with.
 */
export function classifyFault(text: string): KeyFault | undefined {
  const status = text.match(/^\s*HTTP (\d{3})\b/)?.[1];
  const planRefusal = PLAN_REFUSAL_PATTERN.test(text);
  if (!planRefusal && QUOTA_PATTERN.test(text)) return "quota";
  const rateLimited = status ? status === "429" : RATE_LIMIT_PATTERN.test(text);
  if (!rateLimited && !planRefusal) {
    if (status ? QUOTA_STATUS.test(status) : QUOTA_STATUS.test(text)) return "quota";
    if (QUOTA_LOOSE_PATTERN.test(text)) return "quota";
  }
  if (status ? status === "401" : /\b401\b/.test(text)) return "auth";
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
 * Some MCP servers report a failed call as a successful tool result whose
 * text is a small JSON error object (Tavily's returns
 * `{"error": ..., "status": 432}` this way when a plan is used up). Returns
 * that text when the result has this shape, so it is handled like any other
 * upstream error.
 *
 * Only for `mcp` upstreams. An `openapi` upstream's failures carry an HTTP
 * status, and a 2xx body with an `error` field is data: the status of a
 * failed run, whose message may quote any status or wording.
 */
function errorPayload(result: CallToolResult): string | undefined {
  const text = resultText(result).trim();
  if (!text.startsWith("{") || text.length > 2000) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // `"error": null` (or false, or "") on a successful body is not an error.
    return parsed && typeof parsed === "object" && parsed.error ? text : undefined;
  } catch {
    return undefined;
  }
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Find the object that holds the last key of a dotted argument path. With
 * `create` a missing step is added as an empty object. `parent` is absent
 * when a step is missing, or holds something other than an object; in the
 * second case `blocked` is the path to that step.
 */
function parentOf(
  args: Record<string, unknown>,
  keys: string[],
  create: boolean
): { parent?: Record<string, unknown>; blocked?: string } {
  let node = args;
  for (let depth = 0; depth < keys.length - 1; depth++) {
    const key = keys[depth];
    if (node[key] === undefined && create) node[key] = {};
    const next = node[key];
    if (next === undefined) return {};
    if (!isPlainObject(next)) return { blocked: keys.slice(0, depth + 1).join(".") };
    node = next;
  }
  return { parent: node };
}

/**
 * Apply an upstream's argument pins to one call. Every pin whose pattern
 * matches the tool applies, in config order. A default fills an argument the
 * agent left out (so the first matching pin's default wins); a max lowers a
 * number above it and adds a note for the agent. A max does not fill a
 * missing argument. The agent's arguments are not modified; `args` is a copy
 * when any pin matches.
 *
 * `refusal` is set, and the call must not be made, in two cases. A pin's
 * `requireOneOf` names arguments and the call, after defaults, supplies none
 * of them (`null` and an empty string count as left out). Or a capped
 * argument is present and cannot be compared with the cap: it holds
 * something that is not a number (`null` included), or an argument on its
 * dotted path holds something that is not an object. Forwarding such a call
 * would hand the decision to the upstream's own default.
 */
function applyPins(
  upstream: UpstreamConfig,
  tool: string,
  args: Record<string, unknown> | undefined
): { args: Record<string, unknown> | undefined; notes: string[]; refusal?: string } {
  const pins = upstream.pins.filter((pin) => matchesPattern(tool, pin.pattern));
  if (pins.length === 0) return { args, notes: [] };
  const out = structuredClone(args ?? {});
  const notes: string[] = [];

  for (const { path, value } of pins.flatMap((pin) => pin.defaults)) {
    const keys = path.split(".");
    const { parent } = parentOf(out, keys, true);
    const key = keys[keys.length - 1];
    if (parent && parent[key] === undefined) parent[key] = structuredClone(value);
  }
  const target = `${upstream.name}${NAME_SEPARATOR}${tool}`;
  for (const required of pins.flatMap((pin) => (pin.requireOneOf?.length ? [pin.requireOneOf] : []))) {
    const supplied = required.some((path) => {
      const keys = path.split(".");
      const given = parentOf(out, keys, false).parent?.[keys[keys.length - 1]];
      return given !== undefined && given !== null && given !== "";
    });
    if (!supplied) {
      const names = required.map((path) => `"${path}"`).join(" or ");
      return {
        args: out,
        notes,
        refusal: `${target} needs ${names}: this gateway does not make the call without ${required.length === 1 ? "it" : "one of them"}. Add ${required.length === 1 ? "it" : "one"} and call again.`,
      };
    }
  }
  for (const { path, limit } of pins.flatMap((pin) => pin.max)) {
    const keys = path.split(".");
    const { parent, blocked } = parentOf(out, keys, false);
    if (blocked) {
      return {
        args: out,
        notes,
        refusal: `Argument "${blocked}" must be an object: this gateway allows at most ${limit} for "${path}" of ${target}. Send an object, or leave "${blocked}" out.`,
      };
    }
    const key = keys[keys.length - 1];
    const given = parent?.[key];
    if (!parent || given === undefined) continue;
    const amount = typeof given === "number" ? given : typeof given === "string" && given.trim() ? Number(given) : Number.NaN;
    if (Number.isNaN(amount)) {
      return {
        args: out,
        notes,
        refusal: `Argument "${path}" must be a number: this gateway allows at most ${limit} for ${target}. Send a number, or leave the argument out.`,
      };
    }
    if (amount > limit) {
      parent[key] = limit;
      notes.push(`Gateway note: "${path}" was lowered from ${amount} to ${limit}, the most this gateway allows for ${target}.`);
    }
  }
  return { args: out, notes };
}

/**
 * `value` with every resolved key value replaced in every string it holds,
 * at any depth. The same object comes back when nothing was replaced.
 */
function redactDeep<T>(value: T, secrets: Iterable<string>): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) {
    const items = value.map((item) => redactDeep(item, secrets));
    return items.some((item, index) => item !== value[index]) ? (items as T) : value;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)] as const);
    return entries.some(([key, item]) => item !== value[key]) ? (Object.fromEntries(entries) as T) : value;
  }
  return value;
}

/** The result with the gateway's notes added after the upstream's own content. */
function withNotes(result: CallToolResult, notes: string[]): CallToolResult {
  if (notes.length === 0) return result;
  return { ...result, content: [...(result.content ?? []), ...notes.map((note) => ({ type: "text" as const, text: note }))] };
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
   * Forward one tool call. The upstream's argument pins are applied first, so
   * the ledger and the upstream both see the arguments as sent. Tries keys in
   * order; an out-of-credit or rejected key is marked and the next one is
   * tried. Any other failure is returned to the agent as the upstream
   * reported it, with resolved key values replaced by `[redacted]` as they
   * are in every result. Every attempt is one ledger line.
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
    const pinned = applyPins(upstream, tool, args);
    if (pinned.refusal) return errorResult(pinned.refusal);
    const sent = pinned.args;
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
        entry.args = this.ledger.formatArgs(sent, this.secrets);
        // An upstream can echo the key it was sent (in an error message, a
        // request URL, a dump of request headers). The agent never gets it.
        const result = redactDeep(
          (await client.callTool({ name: tool, arguments: sent }, undefined, {
            timeout: CALL_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
          })) as CallToolResult,
          this.secrets
        );
        entry.duration_ms = this.now() - started;
        entry.result_bytes = JSON.stringify(result).length;
        last = result;
        response = result;
        const failure = result.isError ? resultText(result) : upstream.kind === "mcp" ? errorPayload(result) : undefined;
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

      entry.payload = this.ledger.writePayload(entry, { name: tool, arguments: sent }, response, this.secrets);

      this.ledger.append(entry);
      if (entry.ok || !fault || !keyRef) return withNotes(last, pinned.notes);
      this.markKey(upstream.name, keyRef, fault);
    }

    const tried = order.length;
    const detail = resultText(last);
    return withNotes(
      errorResult(
        `${upstream.name}: all ${tried} configured key${tried === 1 ? "" : "s"} failed (out of credit or rejected). Last error: ${detail}`
      ),
      pinned.notes
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

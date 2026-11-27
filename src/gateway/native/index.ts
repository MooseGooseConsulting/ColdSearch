import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESERVED_UPSTREAM_NAME, type NativeConfig } from "../config.js";
import type { CallContext, GatewayCore } from "../core.js";
import type { LedgerEntry } from "../ledger.js";
import type { SafeFetchHooks } from "../../safe-fetch.js";
import { ArgumentError } from "./args.js";
import { CANCELLED } from "./cancel.js";
import { CRAWL_TOOL, crawlTool, runCrawl } from "./crawl.js";
import { FETCH_TOOL, fetchTool, runFetch } from "./fetch.js";
import { MAP_TOOL, mapTool, runMap } from "./map.js";
import { HostGate } from "./politeness.js";
import { NativeRuntime, type NativeHandler } from "./runtime.js";

const NATIVE_KEY = `${RESERVED_UPSTREAM_NAME}:keyless`;

/**
 * Seams for tests only: `lookup` and `unsafeAllowAddress` reach the SSRF
 * guard (see SafeFetchHooks), `sleep` replaces the politeness pause. They are
 * a constructor argument; no config key, environment variable or tool
 * argument sets them.
 */
export interface NativeHooks extends SafeFetchHooks {
  sleep?: (ms: number) => Promise<void>;
}

const HANDLERS: Record<string, { tool: Tool; run: NativeHandler }> = {
  [FETCH_TOOL]: { tool: fetchTool, run: runFetch },
  [MAP_TOOL]: { tool: mapTool, run: runMap },
  [CRAWL_TOOL]: { tool: crawlTool, run: runCrawl },
};

/**
 * The gateway's own fetch, map and crawl tools: plain HTTP done here, so the
 * providers are paid only for what plain HTTP cannot do. One instance serves
 * every connected agent and shares one politeness gate between them. Every
 * call writes one ledger line (upstream "coldsearch", key
 * "coldsearch:keyless") and one payload file, like an upstream call; a page
 * sent to the paid fallback adds the upstream's own line.
 */
export class NativeTools {
  private readonly runtime: NativeRuntime;

  constructor(
    private readonly core: GatewayCore,
    config: NativeConfig,
    private readonly now: () => number,
    hooks: NativeHooks = {}
  ) {
    const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const gate = new HostGate(config.delayMs, now, sleep);
    this.runtime = new NativeRuntime(core, config, { hooks: { lookup: hooks.lookup, unsafeAllowAddress: hooks.unsafeAllowAddress }, gate }, now);
  }

  list(): Tool[] {
    return Object.values(HANDLERS).map((entry) => entry.tool);
  }

  has(name: string): boolean {
    return Object.hasOwn(HANDLERS, name);
  }

  /**
   * Run one native tool. Never throws: a failure is an error result, and is in
   * the ledger either way. A call the agent cancelled ends at its next step
   * and is recorded as `cancelled by the client`.
   *
   * A paid-fallback page and a paid-fallback error are text an upstream
   * returned, and an upstream can repeat the key it was sent. So the ledger
   * line and the payload file are redacted with every key value the gateway
   * knows, exactly as an upstream call's are.
   */
  async call(name: string, args: Record<string, unknown>, context: CallContext): Promise<CallToolResult> {
    if (!this.has(name)) {
      return { content: [{ type: "text", text: `No native tool named "${name}". Available: ${Object.keys(HANDLERS).join(", ")}.` }], isError: true };
    }
    const started = this.now();
    const ledger = this.core.ledger;
    const entry: LedgerEntry = {
      ts: new Date(started).toISOString(),
      session: context.session,
      client: context.client,
      upstream: RESERVED_UPSTREAM_NAME,
      tool: name,
      key: NATIVE_KEY,
      attempt: 1,
      ok: false,
      duration_ms: 0,
      // Filled in below, once any key the call used is known.
      args: undefined,
    };

    let result: CallToolResult;
    let error: string | undefined;
    try {
      const outcome = await HANDLERS[name].run(this.runtime, args, context);
      result = outcome.result;
      entry.ok = outcome.ok;
      entry.pages = outcome.pages;
      if (!outcome.ok) error = outcome.error ?? "failed";
    } catch (thrown) {
      const cancelled = context.signal?.aborted === true;
      error = cancelled ? CANCELLED : ((thrown as Error).message ?? String(thrown));
      const text = cancelled || thrown instanceof ArgumentError ? `${name}: ${error}` : `${name} could not fetch: ${error}`;
      result = { content: [{ type: "text", text }], isError: true };
    }
    // A crawl cut short still returns the pages it read; nobody is waiting for them, and the line says so.
    if (context.signal?.aborted) {
      entry.ok = false;
      error = CANCELLED;
    }

    const secrets = this.core.knownSecrets();
    entry.args = ledger.formatArgs(args, secrets);
    if (error !== undefined) {
      entry.error_class = "gateway";
      entry.error = ledger.formatError(error, secrets);
    }
    entry.duration_ms = this.now() - started;
    entry.result_bytes = JSON.stringify(result).length;
    entry.payload = ledger.writePayload(entry, { name, arguments: args }, result, secrets);
    ledger.append(entry);
    return result;
  }
}

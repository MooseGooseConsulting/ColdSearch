import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { RESERVED_UPSTREAM_NAME, type NativeConfig } from "../config.js";
import type { CallContext, GatewayCore } from "../core.js";
import type { LedgerEntry } from "../ledger.js";
import type { SafeFetchHooks } from "../../safe-fetch.js";
import { ArgumentError } from "./args.js";
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

  /** Run one native tool. Never throws: a failure is an error result, and is in the ledger either way. */
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
      args: ledger.formatArgs(args, []),
    };

    let result: CallToolResult;
    try {
      const outcome = await HANDLERS[name].run(this.runtime, args, context);
      result = outcome.result;
      entry.ok = outcome.ok;
      entry.pages = outcome.pages;
      if (!outcome.ok) {
        entry.error_class = "gateway";
        entry.error = ledger.formatError(outcome.error ?? "failed", []);
      }
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const text = error instanceof ArgumentError ? `${name}: ${message}` : `${name} could not fetch: ${message}`;
      result = { content: [{ type: "text", text }], isError: true };
      entry.error_class = "gateway";
      entry.error = ledger.formatError(message, []);
    }

    entry.duration_ms = this.now() - started;
    entry.result_bytes = JSON.stringify(result).length;
    entry.payload = ledger.writePayload(entry, { name, arguments: args }, result, []);
    ledger.append(entry);
    return result;
  }
}

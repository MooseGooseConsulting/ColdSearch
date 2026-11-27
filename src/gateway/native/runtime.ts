import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NativeConfig } from "../config.js";
import type { CallContext, GatewayCore } from "../core.js";
import { fetchUrl, ROBOTS_AGENT, decodeBody, type NativeNet } from "./http.js";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsRules } from "./robots.js";

/** What one native tool call produced, for the agent and for the ledger. */
export interface Outcome {
  result: CallToolResult;
  /** Whether the call gave the agent what it asked for. */
  ok: boolean;
  /** Pages read without a provider. */
  pages?: number;
  /** Ledger text for a call that was not ok. */
  error?: string;
}

/** A site's robots.txt as last read. `unreachable` means the server failed, which RFC 9309 treats as "disallow all". */
export interface RobotsState {
  state: "ok" | "missing" | "unreachable";
  rules: RobotsRules;
}

const ROBOTS_TTL_MS = 10 * 60_000;
const ROBOTS_MAX_BYTES = 512 * 1024;

/** Everything a native tool needs: the network, the config, the core for paid calls, and shared robots.txt answers. */
export class NativeRuntime {
  private readonly robotsCache = new Map<string, { at: number; state: RobotsState }>();

  constructor(
    readonly core: GatewayCore,
    readonly config: NativeConfig,
    readonly net: NativeNet,
    readonly now: () => number
  ) {}

  /**
   * robots.txt for one origin, kept for ten minutes. A 4xx answer means the
   * site has none and everything is allowed; a 5xx answer or no answer means
   * the rules are unknown and nothing is.
   */
  async robots(origin: string): Promise<RobotsState> {
    const cached = this.robotsCache.get(origin);
    if (cached && this.now() - cached.at < ROBOTS_TTL_MS) return cached.state;

    let state: RobotsState;
    try {
      const fetched = await fetchUrl(this.net, `${origin}/robots.txt`, { maxBytes: ROBOTS_MAX_BYTES });
      if (fetched.status >= 200 && fetched.status < 300) {
        state = { state: "ok", rules: parseRobots(decodeBody(fetched.body, fetched.headers), ROBOTS_AGENT) };
      } else if (fetched.status >= 500) {
        state = { state: "unreachable", rules: DISALLOW_ALL };
      } else {
        state = { state: "missing", rules: ALLOW_ALL };
      }
    } catch {
      state = { state: "unreachable", rules: DISALLOW_ALL };
    }
    if (this.robotsCache.size >= 200) this.robotsCache.clear();
    this.robotsCache.set(origin, { at: this.now(), state });
    return state;
  }
}

export type NativeHandler = (runtime: NativeRuntime, args: Record<string, unknown>, context: CallContext) => Promise<Outcome>;

/** A JSON result. `content`, when given, follows as a second text item so long text is not buried in JSON escapes. */
export function jsonResult(meta: unknown, content?: string, isError = false): CallToolResult {
  const items: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(meta, null, 2) }];
  if (content !== undefined) items.push({ type: "text", text: content });
  return { content: items, ...(isError ? { isError: true } : {}) };
}

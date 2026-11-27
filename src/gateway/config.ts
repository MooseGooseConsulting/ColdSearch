import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_DIR_NAME } from "../app.js";

/** How the gateway presents upstream tools to the connecting agent. */
export type GatewayMode = "all" | "lazy";

/** Where the upstream expects its credential. */
export type UpstreamAuth = "header" | "query" | "none";

/** `openapi`: tools built from the vendor's published API spec. `mcp`: the vendor's hosted MCP server, passed through. */
export type UpstreamKind = "openapi" | "mcp";

export interface UpstreamConfig {
  name: string;
  kind: UpstreamKind;
  /** MCP endpoint (`mcp`) or API base URL (`openapi`). */
  url: string;
  /** Where the OpenAPI documents are: https URLs or file paths. `openapi` only. */
  specs: string[];
  /** Fixed headers sent on every request, e.g. a beta opt-in the vendor requires. Not for credentials. */
  headers: Record<string, string>;
  auth: UpstreamAuth;
  /** Header name or query parameter name that carries the credential. */
  authName: string;
  /** Text placed before the key in a header value, e.g. "Bearer ". */
  authPrefix: string;
  /** Key references (`doppler:NAME`, `env:NAME`); order is the drain order. */
  keys: string[];
  /** When non-empty, only upstream tools matching one of these patterns are offered. */
  include: string[];
  /** Upstream tools matching one of these patterns are hidden and refused. `*` is a wildcard. */
  exclude: string[];
}

export interface GatewayConfig {
  mode: GatewayMode;
  ledgerPath: string;
  statePath: string;
  skillsDir: string;
  logArguments: boolean;
  /** Directory for full request and response bodies, or undefined when disabled. */
  payloadDir?: string;
  /** How long a key stays skipped after an out-of-credit error. */
  exhaustedCooldownMs: number;
  /** How long an upstream's tool list is reused before it is fetched again. */
  toolListTtlMs: number;
  upstreams: UpstreamConfig[];
}

type Preset = Pick<UpstreamConfig, "kind" | "url" | "auth" | "authName" | "authPrefix"> & { spec?: string | string[] };

const bearer = { auth: "header", authName: "Authorization", authPrefix: "Bearer " } as const;
const apiKey = { auth: "header", authName: "x-api-key", authPrefix: "" } as const;

/**
 * Connection details for upstreams the gateway knows, checked on 2026-11-27.
 *
 * Vendors that publish an OpenAPI document default to `openapi`, because their
 * hosted MCP servers expose a small part of the API (Exa's lists 3 tools with
 * 3 search parameters; its API document has 64 operations). The `<name>mcp`
 * presets reach the hosted MCP servers for anything only they offer. A config
 * block may override any field, and unknown names work when the block
 * supplies `url` (and `spec` for `openapi`).
 */
export const UPSTREAM_PRESETS: Record<string, Preset> = {
  exa: { kind: "openapi", url: "https://api.exa.ai", spec: "https://exa.ai/docs/exa-spec.yaml", ...apiKey },
  firecrawl: { kind: "openapi", url: "https://api.firecrawl.dev/v2", spec: "https://docs.firecrawl.dev/api-reference/v2-openapi.json", ...bearer },
  parallel: { kind: "openapi", url: "https://api.parallel.ai", spec: "https://docs.parallel.ai/public-openapi.json", ...apiKey },
  tavily: { kind: "openapi", url: "https://api.tavily.com", spec: "https://docs.tavily.com/documentation/api-reference/openapi.json", ...bearer },
  examcp: { kind: "mcp", url: "https://mcp.exa.ai/mcp", ...apiKey },
  firecrawlmcp: { kind: "mcp", url: "https://mcp.firecrawl.dev/v2/mcp", ...bearer },
  parallelmcp: { kind: "mcp", url: "https://mcp.parallel.ai/mcp", ...bearer },
  tavilymcp: { kind: "mcp", url: "https://mcp.tavily.com/mcp/", ...bearer },
  brightdata: { kind: "mcp", url: "https://mcp.brightdata.com/mcp", auth: "query", authName: "token", authPrefix: "" },
  tinyfish: { kind: "mcp", url: "https://agent.tinyfish.ai/mcp", ...bearer },
  context: { kind: "mcp", url: "https://mcp.context.dev/mcp", ...bearer },
};

const UPSTREAM_NAME = /^[a-z][a-z0-9]{0,23}$/;

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function configDir(): string {
  return join(homedir(), ".config", DEFAULT_CONFIG_DIR_NAME);
}

/** `skills/` at the package root, next to `dist/`. */
export function defaultSkillsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
}

function parseDurationMs(value: unknown, fallbackMs: number, field: string): number {
  if (value === undefined) return fallbackMs;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value * 1000;
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)\s*(s|m|h|d)$/);
    if (match) {
      const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
      return Number(match[1]) * unit;
    }
  }
  throw new Error(`[gateway] ${field} must be seconds or a duration such as "30m", "6h"`);
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[gateway] ${field} must be a non-empty string`);
  }
  return value;
}

function specList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`[gateway] ${field} must be a URL or file path, or a list of them`);
  }
  return list as string[];
}

function headerTable(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[gateway] ${field} must be a table of header names to values`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error(`[gateway] ${field} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function patternList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`[gateway] ${field} must be a list of tool-name patterns`);
  }
  return value as string[];
}

/** True when `tool` matches a pattern; `*` matches any run of characters. */
export function matchesPattern(tool: string, pattern: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(tool);
}

/** Whether an upstream's include/exclude lists let this tool through. */
export function toolAllowed(upstream: Pick<UpstreamConfig, "include" | "exclude">, tool: string): boolean {
  if (upstream.exclude.some((pattern) => matchesPattern(tool, pattern))) return false;
  return upstream.include.length === 0 || upstream.include.some((pattern) => matchesPattern(tool, pattern));
}

/**
 * Read the `[gateway]` table of a parsed config into a validated shape.
 * Throws with a `[gateway]`-prefixed message naming the bad field.
 */
export function resolveGatewayConfig(raw: unknown): GatewayConfig {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "[gateway] section missing: add [gateway.upstreams.<name>] blocks to the config (see docs/components/gateway.md)"
    );
  }
  const section = raw as Record<string, unknown>;

  const mode = section.mode ?? "all";
  if (mode !== "all" && mode !== "lazy") {
    throw new Error('[gateway] mode must be "all" or "lazy"');
  }

  const rawUpstreams = section.upstreams;
  if (!rawUpstreams || typeof rawUpstreams !== "object" || Array.isArray(rawUpstreams)) {
    throw new Error("[gateway] no upstreams configured: add at least one [gateway.upstreams.<name>] block");
  }

  const upstreams: UpstreamConfig[] = [];
  for (const [name, value] of Object.entries(rawUpstreams as Record<string, unknown>)) {
    if (!UPSTREAM_NAME.test(name)) {
      throw new Error(`[gateway] upstream name "${name}" must be lowercase letters and digits, at most 24 characters`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`[gateway] upstreams.${name} must be a table`);
    }
    const block = value as Record<string, unknown>;
    const preset = UPSTREAM_PRESETS[name];

    const url = asString(block.url, `upstreams.${name}.url`) ?? preset?.url;
    if (!url) {
      throw new Error(`[gateway] upstreams.${name} has no preset, so it needs a url`);
    }
    try {
      new URL(url);
    } catch {
      throw new Error(`[gateway] upstreams.${name}.url is not a valid URL`);
    }

    const kind = (block.kind ?? preset?.kind ?? "mcp") as UpstreamKind;
    if (kind !== "openapi" && kind !== "mcp") {
      throw new Error(`[gateway] upstreams.${name}.kind must be "openapi" or "mcp"`);
    }
    const specs = specList(block.spec ?? (kind === "openapi" ? preset?.spec : undefined), `upstreams.${name}.spec`);
    if (kind === "openapi" && specs.length === 0) {
      throw new Error(`[gateway] upstreams.${name} is kind "openapi", so it needs spec (a URL or file path to its OpenAPI document, or a list of them)`);
    }

    const auth = (block.auth ?? preset?.auth ?? "header") as UpstreamAuth;
    if (auth !== "header" && auth !== "query" && auth !== "none") {
      throw new Error(`[gateway] upstreams.${name}.auth must be "header", "query" or "none"`);
    }

    const keys = block.keys ?? [];
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !key.trim())) {
      throw new Error(`[gateway] upstreams.${name}.keys must be a list of key references`);
    }
    if (auth !== "none" && keys.length === 0) {
      throw new Error(`[gateway] upstreams.${name} needs at least one entry in keys (or auth = "none")`);
    }

    upstreams.push({
      name,
      kind,
      specs,
      headers: headerTable(block.headers, `upstreams.${name}.headers`),
      url,
      auth,
      authName: asString(block.auth_name, `upstreams.${name}.auth_name`) ?? preset?.authName ?? "Authorization",
      authPrefix:
        typeof block.auth_prefix === "string" ? block.auth_prefix : preset?.authPrefix ?? "Bearer ",
      keys: keys as string[],
      include: patternList(block.include, `upstreams.${name}.include`),
      exclude: patternList(block.exclude, `upstreams.${name}.exclude`),
    });
  }
  if (upstreams.length === 0) {
    throw new Error("[gateway] no upstreams configured: add at least one [gateway.upstreams.<name>] block");
  }

  const ledgerPath = expandHome(asString(section.ledger, "ledger") ?? join(configDir(), "gateway-ledger.jsonl"));
  const logPayloads = section.log_payloads === undefined ? true : section.log_payloads === true;
  return {
    mode,
    payloadDir: logPayloads
      ? expandHome(asString(section.payload_dir, "payload_dir") ?? join(dirname(ledgerPath), "gateway-payloads"))
      : undefined,
    ledgerPath,
    statePath: expandHome(asString(section.state, "state") ?? join(configDir(), "gateway-state.json")),
    skillsDir: expandHome(asString(section.skills_dir, "skills_dir") ?? defaultSkillsDir()),
    logArguments: section.log_arguments === undefined ? true : section.log_arguments === true,
    exhaustedCooldownMs: parseDurationMs(section.exhausted_cooldown, 6 * 3_600_000, "exhausted_cooldown"),
    toolListTtlMs: parseDurationMs(section.tool_list_ttl, 10 * 60_000, "tool_list_ttl"),
    upstreams,
  };
}

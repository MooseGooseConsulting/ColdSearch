import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_DIR_NAME } from "../app.js";
import { UPSTREAM_PRESETS, type HideReason } from "./profiles.js";

// The presets and the tool report are part of this module's surface.
export * from "./profiles.js";

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
  /**
   * The preset's own address, set when the block's `url` replaces it and the
   * documents are still the preset's. A document that names this address as
   * its server follows `url`. `openapi` only.
   */
  presetUrl?: string;
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
  /** Why each `exclude` pattern is there: the preset's reasons, and `config` for the block's own list. */
  hidden: HiddenTools[];
  /** `preset` when the preset's tool lists and pins are in force for this upstream, otherwise `none`. */
  curation: Curation;
  /** Argument defaults and caps applied to matching tools before a call is forwarded, in config order. */
  pins: ArgumentPin[];
  /** Longest an event-stream response is read, counted from when the request was sent. `openapi` only. */
  streamTimeoutMs: number;
  /** Most bytes of an event-stream response that are read. `openapi` only. */
  streamMaxBytes: number;
}

/** Whether a preset's default tool lists and pins apply to a block. */
export type Curation = "preset" | "none";

/** Patterns hidden for one reason. `config` marks the block's own `exclude` list. */
export interface HiddenTools {
  reason: HideReason | "config";
  patterns: string[];
  note: string;
}

/**
 * Arguments the operator fixes for the tools one pattern matches. Paths are
 * argument names; a dot reaches into a nested object (`budget.maxCostDollars`).
 */
export interface ArgumentPin {
  /** Tool-name pattern, matched like `include` and `exclude`. */
  pattern: string;
  /** Value used for an argument the agent left out. */
  defaults: Array<{ path: string; value: unknown }>;
  /** Highest value a numeric argument may have; a larger one is lowered to it. */
  max: Array<{ path: string; limit: number }>;
  /** When set, a call that supplies none of these arguments is refused. */
  requireOneOf?: string[];
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

const UPSTREAM_NAME = /^[a-z][a-z0-9]{0,23}$/;

/** Five minutes: the limit the connector already put on any one request. */
const DEFAULT_STREAM_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STREAM_MAX_BYTES = 4 * 1024 * 1024;

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function configDir(): string {
  return join(homedir(), ".config", DEFAULT_CONFIG_DIR_NAME);
}

/** The installed package's root: the directory that holds `dist/`, `skills/` and `specs/`. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** `skills/` at the package root, next to `dist/`. */
export function defaultSkillsDir(): string {
  return join(packageRoot(), "skills");
}

const PACKAGE_PREFIX = "package:";

/**
 * Turn a spec location into what the connector reads. `package:<path>` names
 * a file shipped with ColdSearch and becomes its absolute path, wherever the
 * process was started; the path must stay inside the package. Anything else
 * (an https URL, a file path) is returned as given.
 */
export function resolveSpecLocation(location: string, field: string): string {
  if (!location.startsWith(PACKAGE_PREFIX)) return location;
  const relative = location.slice(PACKAGE_PREFIX.length);
  const parts = relative.split(/[\\/]/);
  if (!relative || isAbsolute(relative) || parts.includes("..") || parts.includes("")) {
    throw new Error(`[gateway] ${field} "${location}" must be package:<path inside the ColdSearch package>, such as "package:specs/brave.yaml"`);
  }
  return join(packageRoot(), ...parts);
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
  return (list as string[]).map((item) => resolveSpecLocation(item, field));
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

const PIN_SETTINGS = ["default", "max", "require_one_of"];
const PIN_PATH = /^[^.\s]+(?:\.[^.\s]+)*$/;

function isTable(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read an upstream's `pin` table: tool-name pattern to
 * `{ default, max, require_one_of }`. `default` maps argument paths to any
 * value; `max` maps argument paths to numbers; `require_one_of` lists
 * argument paths. Throws naming the pattern and the setting that is wrong.
 */
function pinList(value: unknown, field: string): ArgumentPin[] {
  if (value === undefined) return [];
  if (!isTable(value)) {
    throw new Error(`[gateway] ${field} must be a table of tool-name patterns to { default = {...}, max = {...} }`);
  }
  const pins: ArgumentPin[] = [];
  for (const [pattern, entry] of Object.entries(value)) {
    const at = `${field}."${pattern}"`;
    if (!pattern.trim()) throw new Error(`[gateway] ${field} has an empty tool-name pattern`);
    if (!isTable(entry)) throw new Error(`[gateway] ${at} must be a table with default, max and/or require_one_of`);
    const stray = Object.keys(entry).find((key) => !PIN_SETTINGS.includes(key));
    if (stray !== undefined) {
      throw new Error(`[gateway] ${at}.${stray} is not a pin setting; use default, max or require_one_of`);
    }
    if (entry.default === undefined && entry.max === undefined && entry.require_one_of === undefined) {
      throw new Error(`[gateway] ${at} needs default, max or require_one_of`);
    }
    const required = entry.require_one_of;
    if (required !== undefined) {
      if (!Array.isArray(required) || required.length === 0 || required.some((item) => typeof item !== "string" || !PIN_PATH.test(item))) {
        throw new Error(`[gateway] ${at}.require_one_of must be a list of argument names, such as ["dataset_id", "domain"]`);
      }
    }
    for (const setting of ["default", "max"]) {
      if (entry[setting] !== undefined && !isTable(entry[setting])) {
        const holds = setting === "max" ? "numbers" : "values";
        throw new Error(`[gateway] ${at}.${setting} must be a table of argument names to ${holds}`);
      }
    }
    const paths = (setting: string): Array<[string, unknown]> => {
      const entries = Object.entries((entry[setting] as Record<string, unknown> | undefined) ?? {});
      for (const [path] of entries) {
        if (!PIN_PATH.test(path)) {
          throw new Error(`[gateway] ${at}.${setting}."${path}" is not an argument name or dotted path such as "budget.maxCostDollars"`);
        }
      }
      return entries;
    };
    const max = paths("max").map(([path, limit]) => {
      if (typeof limit !== "number" || !Number.isFinite(limit)) {
        throw new Error(`[gateway] ${at}.max."${path}" must be a number`);
      }
      return { path, limit };
    });
    pins.push({
      pattern,
      defaults: paths("default").map(([path, item]) => ({ path, value: item })),
      max,
      ...(required !== undefined ? { requireOneOf: required as string[] } : {}),
    });
  }
  return pins;
}

function byteCount(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`[gateway] ${field} must be a whole number of bytes, at least 1`);
  }
  return value;
}

function curationSetting(value: unknown, field: string): Curation {
  if (value === undefined || value === "preset") return "preset";
  if (value === "none") return "none";
  throw new Error(`[gateway] ${field} must be "preset" or "none"`);
}

function booleanSetting(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`[gateway] ${field} must be true or false`);
  return value;
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
      throw new Error(
        preset
          ? `[gateway] upstreams.${name}.url is required: the "${name}" preset has no default address, because it is your own deployment's (for example "http://localhost:8080")`
          : `[gateway] upstreams.${name} has no preset, so it needs a url`
      );
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

    // The preset's tool lists name the tools of its own kind, so a block that
    // changes the kind gets none of them.
    const curation = curationSetting(block.curation, `upstreams.${name}.curation`);
    const sameKind = preset !== undefined && preset.kind === kind;
    const curated = sameKind && curation === "preset" ? preset : undefined;
    const allowCredentials = booleanSetting(block.allow_credential_tools, `upstreams.${name}.allow_credential_tools`);

    const hidden: HiddenTools[] = [];
    const presetHides = sameKind ? preset.hide ?? [] : [];
    if (!allowCredentials) hidden.push(...presetHides.filter((rule) => rule.reason === "credentials"));
    if (block.exclude !== undefined) {
      const patterns = patternList(block.exclude, `upstreams.${name}.exclude`);
      if (patterns.length > 0) hidden.push({ reason: "config", patterns, note: "this block's exclude list" });
    } else if (curated) {
      hidden.push(...presetHides.filter((rule) => rule.reason !== "credentials"));
    }

    // A block that moves a preset to another address, and keeps the preset's
    // documents, moves every document that names the preset's address.
    const movedFrom =
      kind === "openapi" && sameKind && block.spec === undefined && block.url !== undefined && preset?.url !== url
        ? preset?.url
        : undefined;

    upstreams.push({
      name,
      kind,
      specs,
      headers: headerTable(block.headers, `upstreams.${name}.headers`),
      url,
      ...(movedFrom ? { presetUrl: movedFrom } : {}),
      auth,
      authName: asString(block.auth_name, `upstreams.${name}.auth_name`) ?? preset?.authName ?? "Authorization",
      authPrefix:
        typeof block.auth_prefix === "string" ? block.auth_prefix : preset?.authPrefix ?? "Bearer ",
      keys: keys as string[],
      include:
        block.include !== undefined ? patternList(block.include, `upstreams.${name}.include`) : [...(curated?.include ?? [])],
      exclude: hidden.flatMap((rule) => rule.patterns),
      hidden,
      curation: curated ? "preset" : "none",
      pins:
        block.pin !== undefined
          ? pinList(block.pin, `upstreams.${name}.pin`)
          : pinList(curated?.pin, `the "${name}" preset's pin`),
      streamTimeoutMs: parseDurationMs(block.stream_timeout, DEFAULT_STREAM_TIMEOUT_MS, `upstreams.${name}.stream_timeout`),
      streamMaxBytes: byteCount(block.stream_max_bytes, DEFAULT_STREAM_MAX_BYTES, `upstreams.${name}.stream_max_bytes`),
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

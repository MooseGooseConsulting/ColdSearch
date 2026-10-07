import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Config,
  ErrorCategory,
  ToolWiringStatus,
} from "./types.js";
import { UsageLogger } from "./logging/usage.js";
import { CacheStore } from "./cache/cache.js";
import { PROVIDER_DEFAULT_DOPPLER_SECRETS } from "./engine/keypool.js";
import {
  HARD_EXCLUDED_TOOLS,
  isHardExcluded,
  listToolProfiles,
} from "./registry/tool-profiles.js";
// Side-effect: install Bright Data tool profiles so provider-tool coverage is
// complete without importing src/providers.ts.
import "./registry/brightdata-tool-profiles.js";
import {
  getProviderMetadata,
  listRegisteredProviders,
  providerSupportsCapability,
} from "./providers.js";
import { LLM_PROVIDERS, REASONING_EFFORTS } from "./agent/llm.js";

/**
 * Status and `config doctor` output builders.
 *
 * Both are pure over a loaded Config + local filesystem state. They never
 * contact providers, never resolve `doppler:` references, and never print
 * secret values — key pools are reported as counts/references only.
 */

const BUILT_IN_CAPABILITIES = new Set(["search", "extract", "crawl"]);

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A provider needs no credential refs when SearXNG or all its tools are keyless. */
function isKeylessProvider(provider: string): boolean {
  if (provider === "searxng") return true;
  return listToolProfiles({ provider }).some((p) => p.features.keyless === true);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Usage-log tail read window: ~2 MB so `status` never loads an unbounded
 * append-only JSONL into memory; the window still covers the 5000-line cap
 * with room to spare for realistic entries. */
const USAGE_TAIL_BYTES = 2 * 1024 * 1024;

/**
 * Read the usage JSONL (last 5000 lines, trailing 7 days) into a per-provider
 * call/success summary. Best-effort: parse or I/O failures yield an empty map.
 * For logs larger than the read window only the tail bytes are read (the first
 * partial line at the window start is dropped) — the summary is identical to a
 * full read because the window is anchored at EOF.
 */
function readUsageSummary(
  usagePath: string
): Record<string, { calls: number; successes: number; success_rate: number }> {
  const summary: Record<string, { calls: number; successes: number; success_rate: number }> = {};
  try {
    const resolved = expandHome(usagePath);
    if (resolved && fs.existsSync(resolved)) {
      const { size } = fs.statSync(resolved);
      let text: string;
      if (size > USAGE_TAIL_BYTES) {
        const fd = fs.openSync(resolved, "r");
        try {
          const buffer = Buffer.alloc(USAGE_TAIL_BYTES);
          const bytesRead = fs.readSync(fd, buffer, 0, USAGE_TAIL_BYTES, size - USAGE_TAIL_BYTES);
          text = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        // The window may start mid-line; drop the partial first line.
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1) {
          text = text.slice(firstNewline + 1);
        }
      } else {
        text = fs.readFileSync(resolved, "utf8");
      }
      const allLines = text.split("\n").filter(Boolean);
      const lines = allLines.length > 5000 ? allLines.slice(-5000) : allLines;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const provider = entry.provider;
        if (typeof provider !== "string") continue;
        if (!summary[provider]) {
          summary[provider] = { calls: 0, successes: 0, success_rate: 0 };
        }
        summary[provider].calls += 1;
        if (entry.success === true) summary[provider].successes += 1;
      }

      for (const value of Object.values(summary)) {
        value.success_rate = value.calls > 0 ? value.successes / value.calls : 0;
      }
    }
  } catch {
    // best-effort: ignore usage parsing errors
  }
  return summary;
}

/**
 * Locally-detectable missing credential env vars: `env:` key-pool references
 * whose variable is not set. `doppler:` refs are never resolved or probed here.
 */
export function collectMissingEnvVars(
  config: Config
): Array<{ provider: string; var: string }> {
  const missing: Array<{ provider: string; var: string }> = [];
  for (const [provider, cfg] of Object.entries(config.providers ?? {})) {
    const refs = Array.isArray(cfg?.keyPool?.keys) ? cfg.keyPool.keys : [];
    for (const ref of refs) {
      if (typeof ref === "string" && ref.startsWith("env:")) {
        const varName = ref.slice(4).trim();
        if (varName && !process.env[varName]) {
          missing.push({ provider, var: varName });
        }
      }
    }
  }
  return missing;
}

/** Adapter-backed capability surface per registered provider (registry state). */
export function buildProviderCapabilities(
  config: Config
): Record<string, { capabilities: string[]; configured: boolean }> {
  const out: Record<string, { capabilities: string[]; configured: boolean }> = {};
  for (const name of listRegisteredProviders()) {
    out[name] = {
      capabilities: [...getProviderMetadata(name).capabilities],
      configured: (config.providers ?? {})[name] !== undefined,
    };
  }
  return out;
}

/**
 * Provider-tool coverage from the registry: counts and listing of tool
 * profiles by wiring status. This is registry state only — never live provider
 * health, and no provider is contacted.
 */
export function buildToolCoverage(): {
  wired: number;
  direct: number;
  available: number;
  deferred: number;
  total: number;
  hard_excluded: number;
  by_provider: Record<string, Record<ToolWiringStatus, number>>;
  tools: Array<{
    id: string;
    provider: string;
    tool: string;
    status: ToolWiringStatus;
    categories: string[];
  }>;
} {
  const counts: Record<ToolWiringStatus, number> = {
    wired: 0,
    direct: 0,
    available: 0,
    deferred: 0,
  };
  const byProvider: Record<string, Record<ToolWiringStatus, number>> = {};
  const tools: Array<{
    id: string;
    provider: string;
    tool: string;
    status: ToolWiringStatus;
    categories: string[];
  }> = [];
  // Hard-excluded = explicit HARD_EXCLUDED_TOOLS entries (including any whose
  // profile is not registered) plus profiles whose status is `deferred` —
  // same semantics as isHardExcluded. Seeded with the set so ids without a
  // profile still count.
  const hardExcluded = new Set<string>(HARD_EXCLUDED_TOOLS);

  for (const profile of listToolProfiles()) {
    counts[profile.status] += 1;
    if (isHardExcluded(`${profile.provider}.${profile.tool}`)) {
      hardExcluded.add(`${profile.provider}.${profile.tool}`);
    }
    const perProvider = (byProvider[profile.provider] ??= {
      wired: 0,
      direct: 0,
      available: 0,
      deferred: 0,
    });
    perProvider[profile.status] += 1;
    tools.push({
      id: `${profile.provider}.${profile.tool}`,
      provider: profile.provider,
      tool: profile.tool,
      status: profile.status,
      categories: profile.categories,
    });
  }
  tools.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ...counts,
    total: tools.length,
    hard_excluded: hardExcluded.size,
    by_provider: byProvider,
    tools,
  };
}

/**
 * Build the `coldsearch status` machine-readable payload.
 *
 * `config_path` is the effective config file path (display only). Cache state
 * and usage path come from the same stores the runtime uses, so the reported
 * paths match what actually runs.
 */
export function buildStatus(config: Config, configPath: string): Record<string, unknown> {
  const byCapability = Object.fromEntries(
    Object.entries(config.capabilities ?? {}).map(([capability, cfg]) => [
      capability,
      {
        providers: cfg?.providers ?? [],
        strategy: cfg?.strategy ?? null,
        effective_strategy: cfg?.strategy ?? "all",
      },
    ])
  );

  const keyPools = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([provider, cfg]) => [
      provider,
      {
        keys: cfg?.keyPool?.keys?.length ?? 0,
        strategy: cfg?.keyPool?.strategy || "round-robin",
      },
    ])
  );

  const cachePath = new CacheStore({
    enabled: config.cache?.enabled !== false,
    path: config.cache?.path,
  }).getPath();
  const usagePath = new UsageLogger({ path: config.logging?.usage?.path }).getPath();
  const usageSummary = readUsageSummary(usagePath);

  return {
    config_path: configPath,
    capabilities: byCapability,
    key_pools: keyPools,
    cache: {
      enabled: config.cache?.enabled !== false,
      path: cachePath,
    },
    usage_log: usagePath,
    recent_usage_summary_7d: Object.keys(usageSummary).length ? usageSummary : undefined,
    missing_env_vars: collectMissingEnvVars(config),
    provider_capabilities: buildProviderCapabilities(config),
    tool_coverage: buildToolCoverage(),
  };
}

// ---------------------------------------------------------------------------
// config doctor
// ---------------------------------------------------------------------------

export interface DoctorIssue {
  category: ErrorCategory;
  message: string;
}

export interface DoctorReport {
  config_path: string;
  valid: boolean;
  errors: DoctorIssue[];
  warnings: DoctorIssue[];
}

/**
 * Local diagnostics over a parsed Config. Never contacts provider APIs, never
 * consumes provider credits, never resolves `doppler:` references (syntax and
 * presence only), and the SearXNG base URL check is presence/format only — no
 * liveness probe. Secret values are never echoed.
 *
 * Structural problems are `errors` (invalid config); operational gaps (missing
 * env vars, empty key pools, unpopulated capability pools) are `warnings` so a
 * structurally valid starter config still reports `valid: true`.
 */
export function buildDoctorReport(config: Config, configPath: string): DoctorReport {
  const errors: DoctorIssue[] = [];
  const warnings: DoctorIssue[] = [];

  // Required sections. Routing indexes these by name at runtime, so they must
  // be real tables: arrays/scalars parse but are unusable (structural error),
  // while a genuinely absent section is just "missing".
  const caps = config.capabilities;
  const provs = config.providers;
  const capsIsTable = caps !== null && typeof caps === "object" && !Array.isArray(caps);
  const provsIsTable = provs !== null && typeof provs === "object" && !Array.isArray(provs);
  if (!capsIsTable) {
    errors.push({
      category: "config",
      message: caps == null ? "Missing [capabilities] section" : "[capabilities] must be a table",
    });
  }
  if (!provsIsTable) {
    errors.push({
      category: "config",
      message: provs == null ? "Missing [providers] section" : "[providers] must be a table",
    });
  }
  if (!capsIsTable || !provsIsTable) {
    return { config_path: configPath, valid: errors.length === 0, errors, warnings };
  }

  // Provider names must be recognized.
  const knownProviders = new Set<string>(listRegisteredProviders());
  for (const name of Object.keys(provs)) {
    if (!knownProviders.has(name)) {
      errors.push({
        category: "provider",
        message: `Unknown provider '${name}' in [providers]`,
      });
    }
  }

  // Capability compatibility: configured providers must exist and support the
  // capability they are assigned to.
  for (const [capability, cfg] of Object.entries(caps)) {
    if (!BUILT_IN_CAPABILITIES.has(capability)) {
      warnings.push({
        category: "unsupported_capability",
        message: `Capability '${capability}' is not one of the built-in capabilities (search, extract, crawl)`,
      });
      continue;
    }
    // Each capability entry must be a table; a scalar/array here crashes
    // runtime provider resolution (it reads capConfig.providers.length).
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
      errors.push({
        category: "config",
        message: `Capability '${capability}' must be a table with providers and optional strategy`,
      });
      continue;
    }
    // Strategy drives fanout semantics at runtime (src/engine): anything other
    // than "random"/"all" is treated as fanout-to-all, so reject it here. The
    // invalid value is never echoed — it could be a pasted credential.
    const strategy = cfg?.strategy;
    if (strategy !== undefined && strategy !== "all" && strategy !== "random") {
      errors.push({
        category: "config",
        message: `Capability '${capability}' strategy must be "all" or "random"`,
      });
    }
    const rawProviders = cfg?.providers;
    if (rawProviders !== undefined && !Array.isArray(rawProviders)) {
      // Wrong schema (e.g. a bare string): routing expects an array.
      errors.push({
        category: "config",
        message: `Capability '${capability}' providers must be an array of provider names`,
      });
      continue;
    }
    const providers = Array.isArray(rawProviders) ? rawProviders : [];
    if (providers.length === 0) {
      warnings.push({
        category: "config",
        message: `Capability '${capability}' has no providers configured`,
      });
    }
    for (const provider of providers) {
      if (!provs[provider]) {
        errors.push({
          category: "config",
          message: `Capability '${capability}' references provider '${provider}' which is not configured in [providers]`,
        });
        continue;
      }
      if (!knownProviders.has(provider)) {
        // Already reported as unknown; skip capability-specific noise.
        continue;
      }
      if (!providerSupportsCapability(provider, capability as "search" | "extract" | "crawl")) {
        errors.push({
          category: "unsupported_capability",
          message: `Provider '${provider}' does not support capability '${capability}'`,
        });
      }
    }
  }

  // Key references: syntax/presence only. Refs are names (`env:`/`doppler:`),
  // never resolved and never printed.
  for (const [provider, cfg] of Object.entries(provs)) {
    const refs = Array.isArray(cfg?.keyPool?.keys) ? cfg.keyPool.keys : [];
    if (refs.length === 0) {
      // defaultSecretName is a runtime-consumed fallback (src/engine/keypool.ts),
      // so an empty keys array is not an operator gap when it is set.
      const hasDefaultSecret =
        typeof cfg?.keyPool?.defaultSecretName === "string" &&
        cfg.keyPool.defaultSecretName.trim().length > 0;
      // Built-in per-provider Doppler defaults are runtime-consumed too; keep
      // the shared source (src/engine/keypool.ts) so this never drifts.
      const hasBuiltInDefault = PROVIDER_DEFAULT_DOPPLER_SECRETS[provider] !== undefined;
      if (!isKeylessProvider(provider) && !hasDefaultSecret && !hasBuiltInDefault) {
        warnings.push({
          category: "credentials",
          message: `Provider '${provider}' has no key references configured`,
        });
      }
      continue;
    }
    for (const ref of refs) {
      if (typeof ref !== "string") {
        errors.push({
          category: "config",
          message: `Provider '${provider}' key pool contains a non-string key reference`,
        });
        continue;
      }
      if (ref.startsWith("bws:")) {
        errors.push({
          category: "credentials",
          message: `Provider '${provider}' uses the removed bws: reference '${ref}' — migrate to doppler: or env:`,
        });
        continue;
      }
      if (ref.startsWith("env:")) {
        const varName = ref.slice(4).trim();
        if (!varName) {
          errors.push({
            category: "credentials",
            message: `Provider '${provider}' has an empty env: key reference`,
          });
        } else if (!process.env[varName]) {
          warnings.push({
            category: "credentials",
            message: `Provider '${provider}' references unset environment variable ${varName}`,
          });
        }
        continue;
      }
      if (ref.startsWith("doppler:")) {
        // Syntax/presence only — never resolved, never contacted.
        if (!ref.slice(8).trim()) {
          errors.push({
            category: "credentials",
            message: `Provider '${provider}' has an empty doppler: key reference`,
          });
        }
        continue;
      }
      // Raw literal — the value is a secret and must never be echoed.
      warnings.push({
        category: "credentials",
        message: `Provider '${provider}' uses a raw literal key reference (discouraged); prefer env: or doppler:`,
      });
    }
  }

  // SearXNG base URL: presence/format only, no liveness probe.
  const searxng = provs["searxng"];
  if (searxng) {
    const options = searxng.options as Record<string, unknown> | undefined;
    const configuredUrl = typeof options?.baseUrl === "string" ? options.baseUrl : undefined;
    const envUrl = process.env.SEARXNG_BASE_URL;
    if (configuredUrl === undefined && !envUrl) {
      warnings.push({
        category: "provider",
        message:
          "Provider 'searxng' has no baseUrl in [providers.searxng.options] and SEARXNG_BASE_URL is not set",
      });
    } else {
      const candidate = configuredUrl ?? envUrl;
      if (!candidate || !isHttpUrl(candidate)) {
        // Never echo the configured value — it may be a pasted secret.
        errors.push({
          category: "config",
          message: `Provider 'searxng' baseUrl is not a valid http(s) URL`,
        });
      }
    }
  }

  // Agent LLM endpoint: local validation only — no network, no secret echo.
  // Malformed `[agent.llm]` shapes (non-table) and bad values surface here
  // instead of failing only at agent runtime.
  const llm = (config.agent as { llm?: unknown } | undefined)?.llm;
  if (llm !== undefined) {
    if (llm === null || typeof llm !== "object" || Array.isArray(llm)) {
      errors.push({ category: "config", message: "[agent.llm] must be a table" });
    } else {
      const llmCfg = llm as Record<string, unknown>;
      if (llmCfg.provider !== undefined) {
        if (
          typeof llmCfg.provider !== "string" ||
          !(LLM_PROVIDERS as readonly unknown[]).includes(llmCfg.provider)
        ) {
          errors.push({
            category: "config",
            message: `[agent.llm] provider must be one of: ${LLM_PROVIDERS.join(", ")}`,
          });
        }
      }
      const effort = llmCfg.reasoningEffort ?? llmCfg.reasoning_effort;
      if (effort !== undefined && !(REASONING_EFFORTS as readonly unknown[]).includes(effort)) {
        errors.push({ category: "config", message: `[agent.llm] reasoning_effort must be one of: ${REASONING_EFFORTS.join(", ")}` });
      }
      const keyRef = llmCfg.keyRef ?? llmCfg.key_ref;
      if (keyRef !== undefined && (typeof keyRef !== "string" || !/^(env:|doppler:)[A-Za-z_][A-Za-z0-9_]*$/.test(keyRef))) {
        errors.push({ category: "config", message: "[agent.llm] key_ref must be an env: or doppler: secret name" });
      }
      const baseUrlValue = llmCfg.baseUrl ?? llmCfg.base_url;
      if (baseUrlValue !== undefined) {
        if (typeof baseUrlValue !== "string" || !isHttpUrl(baseUrlValue)) {
          errors.push({
            category: "config",
            message: "[agent.llm] base_url must be a valid http(s) URL",
          });
        }
      }
      if (
        llmCfg.model !== undefined &&
        (typeof llmCfg.model !== "string" || llmCfg.model.trim().length === 0)
      ) {
        errors.push({
          category: "config",
          message: "[agent.llm] model must be a non-empty string",
        });
      }
    }
  }

  return { config_path: configPath, valid: errors.length === 0, errors, warnings };
}

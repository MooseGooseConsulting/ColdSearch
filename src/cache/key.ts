import { createHash } from "node:crypto";

/**
 * Stable JSON stringify: object keys are emitted in sorted order so that
 * semantically-equal option objects hash to the same string regardless of
 * the order their keys were inserted.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  // Explicit comparator (satisfies SonarCloud S2871), written as sequential
  // returns rather than a nested ternary (avoids S3358). `<`/`>` on strings is
  // the same UTF-16 code-unit order the bare `.sort()` already used —
  // deterministic and locale-independent, exactly what a reproducible cache key
  // needs (localeCompare would make the key locale-sensitive, i.e. worse here).
  const keys = Object.keys(obj).sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const entries = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Compute a provider-agnostic cache key for a capability call.
 *
 * The key intentionally excludes invocation-level provider scope
 * (singleProvider / per-call providers / noCache). The execution backend
 * bypasses the cache for explicitly scoped calls and for --no-cache, so those
 * invocations do not replay this provider-agnostic key. For default calls,
 * what invalidates the entry is the config that decides which upstream
 * answers and what it returns — the capability's configured provider pool,
 * routing strategy, endpoint identity, and non-secret request-shaping
 * provider options (via capabilityCacheIdentity in
 * src/contracts/endpoint-identity.ts). Callers must also pass invocation
 * options that affect the returned payload:
 *   - search:  { limit, rerankStrategy, ...capabilityCacheIdentity(config, "search") }
 *              (default rerankStrategy to "rrf")
 *   - extract: { ...capabilityCacheIdentity(config, "extract") }
 *              (the URL alone identifies the request payload)
 *
 * @returns sha256 hex digest of `capability | queryOrUrl | stableStringify(options)`.
 */
export function cacheKey(
  capability: string,
  queryOrUrl: string,
  normalizedOptions: Record<string, unknown>
): string {
  const payload = `${capability}\n${queryOrUrl}\n${stableStringify(normalizedOptions)}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Parse a human-friendly duration string into seconds.
 *
 * Supports a numeric value with a trailing unit suffix: `s` (seconds),
 * `m` (minutes), `h` (hours), `d` (days). A bare number is treated as seconds.
 * Anything unparseable falls back to `fallbackSeconds`.
 *
 *   parseDuration("6h")  // 21600
 *   parseDuration("30m") // 1800
 *   parseDuration("90")  // 90
 */
export function parseDuration(str: string | number, fallbackSeconds = 21600): number {
  // TOML may yield a bare number (e.g. `search_ttl = 21600`) — treat it as seconds.
  if (typeof str === "number") {
    return Number.isFinite(str) && str > 0 ? Math.round(str) : fallbackSeconds;
  }
  if (typeof str !== "string") return fallbackSeconds;
  const trimmed = str.trim();
  const match = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(trimmed);
  if (!match) return fallbackSeconds;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return fallbackSeconds;

  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    "": 1,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) return fallbackSeconds;

  const result = Math.round(value * multiplier);
  if (result <= 0) return fallbackSeconds;
  return result;
}

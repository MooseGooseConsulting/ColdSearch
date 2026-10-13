import type { CapabilityName, Config } from "../types.js";

/**
 * Non-secret request-shaping provider config that must participate in a cache
 * key. SearXNG's resolved endpoint (configured base URL or its environment
 * fallback) decides which instance answers the request; a cache entry sourced
 * from one instance would replay stale results after the endpoint changes.
 * Fixed-host adapters do not consume provider-specific base URL environment
 * variables, so those unused values must not shape the key.
 *
 * NOTE: src/tools/substrate.ts has a separate tool-cache helper. This
 * capability-cache resolver does not change that path; align the tool helper
 * when its owning stack is updated.
 */
export function endpointKeyMaterial(config: Config, provider: string): Record<string, string> {
  if (provider.toLowerCase() !== "searxng") return {};

  const configuredBaseUrl = config.providers.searxng?.options?.baseUrl;
  const baseUrl = typeof configuredBaseUrl === "string"
    ? configuredBaseUrl
    : process.env.SEARXNG_BASE_URL;

  return baseUrl ? { baseUrl } : {};
}

const SECRET_OPTION_NAME = /key|token|secret|credential|password|auth|cookie/i;

/** Keep request-shaping options in cache identity without copying secret fields. */
function cacheSafeOptionValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;

  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => cacheSafeOptionValue(item, seen))
      .filter((item) => item !== undefined);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (SECRET_OPTION_NAME.test(name)) continue;
    const safeItem = cacheSafeOptionValue(item, seen);
    if (safeItem !== undefined) safe[name] = safeItem;
  }
  return safe;
}

function providerOptionKeyMaterial(config: Config, provider: string): Record<string, unknown> {
  const options = config.providers[provider]?.options;
  if (!options) return {};
  return (cacheSafeOptionValue(options) as Record<string, unknown> | undefined) ?? {};
}

/**
 * Config-level cache identity for a capability: the configured provider pool,
 * routing strategy, each pooled provider's endpoint, and its non-secret
 * request-shaping options. Changing any of these can change which upstream
 * answers or what response it returns, so older cached entries must not replay.
 *
 * Deliberately excludes invocation-level scoping (per-call --providers /
 * --singleProvider): provider-agnostic serving is preserved WITHIN an
 * identical config (see the doc comment in src/cache/key.ts).
 */
export function capabilityCacheIdentity(
  config: Config,
  capability: CapabilityName
): Record<string, unknown> {
  const capabilityConfig = config.capabilities[capability];
  const providers = capabilityConfig?.providers ?? [];

  const endpoints: Record<string, Record<string, string>> = {};
  const providerOptions: Record<string, Record<string, unknown>> = {};
  for (const provider of providers) {
    const material = endpointKeyMaterial(config, provider);
    if (Object.keys(material).length > 0) endpoints[provider] = material;
    const options = providerOptionKeyMaterial(config, provider);
    if (Object.keys(options).length > 0) providerOptions[provider] = options;
  }

  return {
    providers,
    strategy: capabilityConfig?.strategy ?? "all",
    ...(Object.keys(endpoints).length > 0 ? { endpoints } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
}

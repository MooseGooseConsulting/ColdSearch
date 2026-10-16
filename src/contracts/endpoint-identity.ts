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

/**
 * Config-level cache identity for a capability: the configured provider pool,
 * the routing strategy, and the endpoint identity of each pooled provider.
 * Changing any of these changes which upstream answers a request, so cached
 * entries keyed without them could replay stale or wrong-instance results.
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
  for (const provider of providers) {
    const material = endpointKeyMaterial(config, provider);
    if (Object.keys(material).length > 0) endpoints[provider] = material;
  }

  return {
    providers,
    strategy: capabilityConfig?.strategy ?? "all",
    ...(Object.keys(endpoints).length > 0 ? { endpoints } : {}),
  };
}

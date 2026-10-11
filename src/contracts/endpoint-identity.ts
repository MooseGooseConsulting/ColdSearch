import type { CapabilityName, Config } from "../types.js";

/**
 * Non-secret request-shaping provider config that must participate in a cache
 * key. A provider's resolved endpoint (configured base URL or
 * `<PROVIDER>_BASE_URL` env fallback) decides which instance answers the
 * request; a cache entry sourced from one instance would replay stale results
 * after the endpoint changes. Only endpoint-like option values are included —
 * never credential material. Kept generic: any configured endpoint-like option
 * shapes the key, not a searxng-specific carve-out.
 *
 * NOTE: this mirrors `endpointKeyMaterial` in src/tools/substrate.ts, which
 * is frozen by the PR-B adapter-fix stack and cannot be edited here. A later
 * PR should switch the tool path to import this shared copy so both cache
 * surfaces derive endpoint identity from one implementation.
 */
export function endpointKeyMaterial(config: Config, provider: string): Record<string, string> {
  const options = (config.providers[provider]?.options ?? {}) as Record<string, unknown>;
  const material: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "string" || value === "") continue;
    if (!/(base|endpoint|api|url|host|origin)/i.test(name)) continue;
    // Endpoint-like NAME only: exclude anything that could be credential
    // material (e.g. an api_key option) from the key material.
    if (/(key|token|secret|credential|password|authorization)/i.test(name)) continue;
    material[name] = value;
  }
  const envName = `${provider.toUpperCase()}_BASE_URL`;
  const envValue = process.env[envName];
  if (envValue) material[envName] = envValue;
  return material;
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

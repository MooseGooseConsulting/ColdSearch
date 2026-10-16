import type { CapabilityName, Config } from "../types.js";

/**
 * Canonical fixed endpoints used by registered providers. Keep host and API
 * version in the identity so a code-level endpoint change cannot replay data
 * cached against the previous upstream. Values are deliberately explicit:
 * fixed-host adapters do not consume arbitrary provider-specific *_BASE_URL
 * variables.
 */
const BUILTIN_ENDPOINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  brave: {
    apiRoot: "https://api.search.brave.com/res/v1",
    webSearch: "https://api.search.brave.com/res/v1/web/search",
    newsSearch: "https://api.search.brave.com/res/v1/news/search",
    imageSearch: "https://api.search.brave.com/res/v1/images/search",
    videoSearch: "https://api.search.brave.com/res/v1/videos/search",
    llmContext: "https://api.search.brave.com/res/v1/llm/context",
    answers: "https://api.search.brave.com/res/v1/chat/completions",
  },
  brightdata: {
    request: "https://api.brightdata.com/request",
    datasetsList: "https://api.brightdata.com/datasets/list",
    datasetMetadata: "https://api.brightdata.com/datasets/{id}/metadata",
    scrape: "https://api.brightdata.com/datasets/v3/scrape",
    trigger: "https://api.brightdata.com/datasets/v3/trigger",
    progress: "https://api.brightdata.com/datasets/v3/progress/{id}",
    snapshotMetadata: "https://api.brightdata.com/datasets/snapshots/{id}",
    cancel: "https://api.brightdata.com/datasets/v3/snapshot/{id}/cancel",
    snapshot: "https://api.brightdata.com/datasets/v3/snapshot/{id}",
    discover: "https://api.brightdata.com/discover",
  },
  exa: {
    tool: "https://api.exa.ai/{tool}",
    search: "https://api.exa.ai/search",
    contents: "https://api.exa.ai/contents",
    findSimilar: "https://api.exa.ai/findSimilar",
  },
  firecrawl: {
    tool: "https://api.firecrawl.dev/v2/{tool}",
    search: "https://api.firecrawl.dev/v2/search",
    scrape: "https://api.firecrawl.dev/v2/scrape",
    crawl: "https://api.firecrawl.dev/v2/crawl",
    crawlStatus: "https://api.firecrawl.dev/v2/crawl/{id}",
  },
  jina: {
    reader: "https://r.jina.ai/{target}",
    search: "https://s.jina.ai/",
    apiV1: "https://api.jina.ai/v1/{tool}",
  },
  serper: {
    search: "https://google.serper.dev/search",
    tool: "https://google.serper.dev/{tool}",
  },
  tavily: {
    tool: "https://api.tavily.com/{tool}",
    search: "https://api.tavily.com/search",
    extract: "https://api.tavily.com/extract",
    crawl: "https://api.tavily.com/crawl",
  },
};

/**
 * Non-secret request-shaping provider config that must participate in a cache
 * key. SearXNG's resolved endpoint (configured base URL or its environment
 * fallback) decides which instance answers the request; a cache entry sourced
 * from one instance would replay stale results after the endpoint changes.
 * Fixed endpoints are listed explicitly below so unused environment values do
 * not shape either capability or tool cache keys.
 */
export function endpointKeyMaterial(config: Config, provider: string): Record<string, string> {
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider !== "searxng") {
    return { ...(BUILTIN_ENDPOINTS[normalizedProvider] ?? {}) };
  }

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

/** Include non-secret environment fallbacks that actually shape a capability request. */
function providerEnvironmentKeyMaterial(
  config: Config,
  provider: string,
  capability: CapabilityName
): Record<string, string> {
  if (provider !== "brightdata") return {};

  const options = config.providers[provider]?.options ?? {};
  const hasConfiguredValue = (keys: string[]) =>
    keys.some((key) => {
      const value = options[key];
      return typeof value === "string" && value.trim() !== "";
    });

  const fallback =
    capability === "search"
      ? { keys: ["zone", "serpZone"], envName: "BRIGHTDATA_SERP_ZONE" }
      : capability === "extract"
        ? { keys: ["unlockerZone", "zone"], envName: "BRIGHTDATA_UNLOCKER_ZONE" }
        : undefined;

  if (!fallback || hasConfiguredValue(fallback.keys)) return {};
  const value = process.env[fallback.envName];
  return value?.trim() ? { [fallback.envName]: value.trim() } : {};
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
  const providerEnvironment: Record<string, Record<string, string>> = {};
  for (const provider of providers) {
    const material = endpointKeyMaterial(config, provider);
    if (Object.keys(material).length > 0) endpoints[provider] = material;
    const options = providerOptionKeyMaterial(config, provider);
    if (Object.keys(options).length > 0) providerOptions[provider] = options;
    const environment = providerEnvironmentKeyMaterial(config, provider, capability);
    if (Object.keys(environment).length > 0) providerEnvironment[provider] = environment;
  }

  return {
    providers,
    strategy: capabilityConfig?.strategy ?? "all",
    ...(Object.keys(endpoints).length > 0 ? { endpoints } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(Object.keys(providerEnvironment).length > 0 ? { providerEnvironment } : {}),
  };
}

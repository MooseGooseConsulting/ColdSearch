import { fetchJson, fetchText, HTTPRequestError, type RequestPolicy } from "../http.js";
import { KeyPoolManager } from "../engine/keypool.js";
// Side-effect: register Bright Data tool profiles so the dispatch path sees
// them as catalogued without importing src/providers.ts.
import "../registry/brightdata-tool-profiles.js";
import { getToolProfile, isHardExcluded } from "../registry/tool-profiles.js";
import { UsageLogger } from "../logging/usage.js";
import { CacheStore, type CacheEntryMeta } from "../cache/cache.js";
import { cacheKey, parseDuration } from "../cache/key.js";
import { HistoryStore } from "../history/store.js";
import { redactForPersistence, redactSensitive } from "../history/redact.js";
import { newExecutionId, type ExecutionRecord } from "../history/types.js";
import { isReplaySafeTool } from "./replay.js";
import type { Config } from "../types.js";
import { performance } from "node:perf_hooks";
import {
  buildBrightDataSummary,
  buildBrightDataToolRequest,
} from "./brightdata.js";
import { braveToolPath, jinaDispatch, serperToolUrl } from "./dispatch-paths.js";

export interface ToolCallResult {
  provider: string;
  tool: string;
  ok: boolean;
  catalogued: boolean;
  summary: Record<string, any> | null;
  raw: any | null;
  error?: {
    code: string;
    message: string;
  };
  meta: {
    duration_ms: number;
    safe_key_ref: string | null;
    warnings: string[];
  };
}

/**
 * Builds standard summaries for catalogued tools (non-lossy additions only).
 */
function buildToolSummary(provider: string, tool: string, raw: any): Record<string, any> | null {
  if (!raw) return null;

  try {
    if (provider === "brightdata") {
      return buildBrightDataSummary(tool, raw);
    }

    if (provider === "exa") {
      if (tool === "search" || tool === "findSimilar") {
        return {
          results_count: raw.results?.length ?? 0,
          top_links: (raw.results || []).slice(0, 3).map((r: any) => r.url),
        };
      }
      if (tool === "contents") {
        return {
          results_count: raw.results?.length ?? 0,
          titles: (raw.results || []).map((r: any) => r.title ?? ""),
        };
      }
      if (tool === "answer") {
        return {
          has_answer: typeof raw.answer === "string" && raw.answer.length > 0,
          answer_preview: typeof raw.answer === "string" ? raw.answer.slice(0, 100) : "",
        };
      }
    }

    if (provider === "tavily") {
      if (tool === "search" || tool === "answer") {
        return {
          results_count: raw.results?.length ?? 0,
          top_links: (raw.results || []).slice(0, 3).map((r: any) => r.url),
          has_answer: typeof raw.answer === "string" && raw.answer.length > 0,
        };
      }
      if (tool === "extract") {
        return {
          results_count: raw.results?.length ?? 0,
          titles: (raw.results || []).map((r: any) => r.title ?? ""),
        };
      }
      if (tool === "crawl") {
        return {
          results_count: raw.results?.length ?? 0,
          top_links: (raw.results || []).slice(0, 3).map((r: any) => r.url),
        };
      }
      if (tool === "map") {
        return {
          results_count: raw.results?.length ?? 0,
        };
      }
      if (tool === "research") {
        return {
          has_report: typeof raw.report === "string" && raw.report.length > 0,
        };
      }
    }

    if (provider === "firecrawl") {
      if (tool === "search") {
        return {
          results_count: raw.data?.web?.length ?? raw.data?.length ?? 0,
        };
      }
      if (tool === "scrape") {
        return {
          success: raw.success ?? false,
          content_length: raw.data?.markdown?.length ?? 0,
          title: raw.data?.metadata?.title ?? "",
        };
      }
      if (tool === "crawl") {
        return {
          success: raw.success ?? false,
          job_id: raw.id ?? null,
          status: raw.status ?? null,
        };
      }
      if (tool === "map") {
        return {
          success: raw.success ?? false,
          links_count: raw.links?.length ?? raw.data?.length ?? 0,
        };
      }
      if (tool === "extract") {
        return {
          success: raw.success ?? false,
        };
      }
    }

    if (provider === "brave") {
      if (tool === "webSearch" || tool === "llmContext") {
        return {
          results_count: raw.web?.results?.length ?? 0,
        };
      }
    }

    if (provider === "serper") {
      if (tool === "search") {
        return {
          results_count: raw.organic?.length ?? 0,
        };
      }
    }

    if (provider === "jina") {
      if (tool === "reader") {
        return {
          length:
            typeof raw === "string"
              ? raw.length
              : typeof raw.data?.content === "string"
                ? raw.data.content.length
                : 0,
        };
      }
    }

    if (provider === "searxng") {
      if (tool === "search") {
        return {
          results_count: raw.results?.length ?? 0,
        };
      }
    }
  } catch {
    // Treat any error in framing summary as non-blocking: fallback to null
  }

  return null;
}

function normalizeJinaReaderAccept(value: unknown): string {
  if (typeof value !== "string") return "text/plain";
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return ["application/json", "text/event-stream", "text/plain"].includes(mediaType)
    ? mediaType
    : "text/plain";
}

/**
 * Bright Data usage-log enrichment: masked zone suffix (never the full zone —
 * zone names embed the customer ID), provider-reported cost, and result/record
 * counts where the tool summary extracts them. Fields are emitted only when
 * present, so non-Bright Data providers keep writing their existing shape.
 */
function brightDataUsageDetails(
  summary: Record<string, any> | null,
  maskedZone: string | undefined
): Record<string, any> {
  const details: Record<string, any> = {};
  if (maskedZone) details.zone = maskedZone;
  if (summary && typeof summary.cost_usd === "number") {
    details.cost_usd = summary.cost_usd;
  }
  const count =
    summary && typeof summary.records_count === "number"
      ? summary.records_count
      : summary && typeof summary.results_count === "number"
        ? summary.results_count
        : undefined;
  if (typeof count === "number") details.result_count = count;
  return details;
}

/**
 * Execute a generic provider tool call against the upstream API.
 * Handles key resolution, timeout/error logic, warn-but-forward, and usage
 * logging. Returns the result plus any resolved credential values (in-memory
 * only — used by the caller to redact persisted history/cache content, never
 * persisted itself).
 */
async function dispatchToolCall(
  provider: string,
  tool: string,
  params: Record<string, any>,
  config: Config
): Promise<{ result: ToolCallResult; secrets: string[] }> {
  const startTime = performance.now();
  const warnings: string[] = [];

  // 1. Validate known/configured provider
  const knownProviders = [
    "tavily",
    "brave",
    "brightdata",
    "exa",
    "serper",
    "jina",
    "firecrawl",
    "searxng",
  ];
  const isConfigured = config.providers[provider] !== undefined;
  if (!isConfigured && !knownProviders.includes(provider)) {
    return {
      result: {
        provider,
        tool,
        ok: false,
        catalogued: false,
        summary: null,
        raw: null,
        error: {
          code: "UNKNOWN_PROVIDER",
          message: `Provider '${provider}' is not configured or recognized.`,
        },
        meta: { duration_ms: 0, safe_key_ref: null, warnings },
      },
      secrets: [],
    };
  }

  // 2. Validate hard exclusions (registry-driven; see HARD_EXCLUDED_TOOLS)
  const toolId = `${provider}.${tool}`;
  const registryProfile = getToolProfile(toolId);

  if (isHardExcluded(toolId)) {
    return {
      result: {
        provider,
        tool,
        ok: false,
        catalogued: registryProfile !== undefined,
        summary: null,
        raw: null,
        error: {
          code: "HARD_EXCLUDED",
          message: `Tool '${provider}.${tool}' is hard-excluded: it runs an autonomous agent, mutates remote state, or requires complex stateful setup.`,
        },
        meta: { duration_ms: 0, safe_key_ref: null, warnings },
      },
      secrets: [],
    };
  }

  // 3. Inform uncatalogued tool warnings
  const catalogued = registryProfile !== undefined;
  if (!catalogued) {
    warnings.push(`Tool '${provider}.${tool}' is uncatalogued.`);
  }

  // 4. Resolve key from key pool managers
  const keyPool = new KeyPoolManager();
  for (const [p, providerConfig] of Object.entries(config.providers)) {
    keyPool.register(p, providerConfig.keyPool);
  }

  let keyResult = { value: "", ref: "keyless" };
  // Keyless is per-tool, not per-provider: jina.reader is keyless but
  // jina.embeddings/rerank require auth, so don't blanket-exempt jina. SearXNG
  // is self-hosted and always keyless even for uncatalogued tools.
  const expectsKey = !(
    registryProfile?.features?.keyless === true ||
    provider === "searxng"
  );
  // Keyless tools can still use an explicitly configured key. In particular,
  // Jina Reader supports unauthenticated requests but offers higher limits
  // when a key is supplied.
  const supportsOptionalKey = provider === "jina" && tool === "reader";
  const hasConfiguredKey = supportsOptionalKey && keyPool.hasKeys(provider);

  if ((expectsKey || hasConfiguredKey) && isConfigured) {
    try {
      keyResult = await keyPool.getNextKeyWithRef(provider);
    } catch (err: any) {
      if (!expectsKey && supportsOptionalKey) {
        warnings.push("Optional Jina Reader key could not be resolved; continuing keyless.");
      } else {
        return {
          result: {
            provider,
            tool,
            ok: false,
            catalogued,
            summary: null,
            raw: null,
            error: {
              code: "KEY_RESOLUTION_FAILED",
              message: `Key resolution failed: ${err.message}`,
            },
            meta: { duration_ms: 0, safe_key_ref: null, warnings },
          },
          secrets: [],
        };
      }
    }
  }

  const apiKey = keyResult.value;
  const safeKeyRefStr = keyResult.ref;

  // Bright Data is explicit-config-only: never dispatch a real request with an
  // empty bearer token. An unconfigured brightdata block has no key pool to
  // resolve, so fail before any HTTP request (mirrors the preflight failures
  // above; no provider attempt is recorded).
  if (provider === "brightdata" && !apiKey) {
    return {
      result: {
        provider,
        tool,
        ok: false,
        catalogued,
        summary: null,
        raw: null,
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message:
            "provider brightdata is not configured; add [providers.brightdata] with a keyPool " +
            '(e.g. keys = ["doppler:BRIGHTDATA_API_KEY"])',
        },
        meta: { duration_ms: 0, safe_key_ref: null, warnings },
      },
      secrets: [],
    };
  }

  // 5. Fire HTTP Request depending on mapper
  let url = "";
  let method = "POST";
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: string | null = null;
  let useTextParser = false;
  let requestTimeoutMs: number | undefined;
  let requestMaskedZone: string | undefined;

  // Construct Provider Call
  try {
    if (provider === "exa") {
      url = `https://api.exa.ai/${tool}`;
      headers["x-api-key"] = apiKey;
      body = JSON.stringify(params);
    } else if (provider === "tavily") {
      const activePath = tool === "answer" ? "search" : tool;
      url = `https://api.tavily.com/${activePath}`;
      headers["Authorization"] = `Bearer ${apiKey}`;
      const payload = { ...params };
      if (tool === "answer") {
        payload.include_answer = true;
      }
      payload.api_key = apiKey; // safety double compliance
      body = JSON.stringify(payload);
    } else if (provider === "firecrawl") {
      url = `https://api.firecrawl.dev/v2/${tool}`;
      headers["Authorization"] = `Bearer ${apiKey}`;
      body = JSON.stringify(params);
    } else if (provider === "brave") {
      headers = {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      };
      if (tool === "answers") {
        method = "POST";
        url = "https://api.search.brave.com/res/v1/chat/completions";
        useTextParser = params.stream === true;
        headers["Accept"] = useTextParser ? "text/event-stream" : "application/json";
        headers["Content-Type"] = "application/json";
        // Brave defaults this endpoint to streaming. Set false explicitly when
        // omitted so the ordinary JSON path stays parseable; preserve true.
        body = JSON.stringify({ ...params, stream: useTextParser });
      } else {
        method = "GET";
        const urlObj = new URL(`https://api.search.brave.com${braveToolPath(tool)}`);
        for (const [k, v] of Object.entries(params)) {
          urlObj.searchParams.set(k, String(v));
        }
        url = urlObj.toString();
      }
    } else if (provider === "brightdata") {
      const request = buildBrightDataToolRequest(tool, params, apiKey, config);
      url = request.url;
      method = request.method;
      headers = request.headers;
      body = request.body;
      useTextParser = request.useTextParser;
      requestTimeoutMs = request.timeoutMs;
      requestMaskedZone = request.maskedZone;
    } else if (provider === "serper") {
      url = serperToolUrl(tool);
      headers["X-API-KEY"] = apiKey;
      body = JSON.stringify(params);
    } else if (provider === "jina") {
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const dispatched = jinaDispatch(tool, params);
      if (dispatched.kind === "reader" || dispatched.kind === "search") {
        delete headers["Content-Type"];
        const acceptEntry = Object.entries(params)
          .filter(([key]) => key.toLowerCase() === "accept")
          .at(-1);
        const accept = dispatched.kind === "reader"
          ? normalizeJinaReaderAccept(acceptEntry?.[1])
          : "text/plain";
        headers["Accept"] = accept;
        useTextParser = accept !== "application/json";
        // Reader options are HTTP headers, not query or JSON-body fields.
        // Only forward the documented header surface so arbitrary parameters
        // cannot change transport-level headers such as Host or Authorization.
        const readerProfileParams = new Map(
          (registryProfile?.optionalParams ?? []).map((param) => [param.toLowerCase(), param])
        );
        if (dispatched.kind === "reader") {
          for (const [key, value] of Object.entries(params)) {
            const normalized = key.toLowerCase();
            if (normalized === "accept") continue;
            const headerName = readerProfileParams.get(normalized);
            if (headerName && value != null) {
              headers[headerName] = String(value);
            }
          }
        }
        method = "GET";
        url = dispatched.url;
      } else {
        method = "POST";
        url = dispatched.url;
        body = JSON.stringify(params);
      }
    } else if (provider === "searxng") {
      method = "GET";
      const configuredBaseUrl = config.providers.searxng?.options?.baseUrl;
      const baseUrl = typeof configuredBaseUrl === "string"
        ? configuredBaseUrl
        : process.env.SEARXNG_BASE_URL;

      if (!baseUrl) {
        throw new Error("SearXNG requires providers.searxng.options.baseUrl or SEARXNG_BASE_URL");
      }

      const endpointBase = new URL(baseUrl);
      endpointBase.pathname = endpointBase.pathname.endsWith("/")
        ? endpointBase.pathname
        : `${endpointBase.pathname}/`;

      const searchUrl = new URL(tool === "search" ? "search" : tool, endpointBase);
      for (const [k, v] of Object.entries(params)) {
        searchUrl.searchParams.set(k, String(v));
      }
      if (!searchUrl.searchParams.has("format")) {
        searchUrl.searchParams.set("format", "json");
      }
      url = searchUrl.toString();
    }

    // Fire HTTP call
    const requestPolicy: RequestPolicy = {
      label: `${provider}.${tool}`,
      ...(requestTimeoutMs ? { timeoutMs: requestTimeoutMs } : {}),
    };
    let rawResponse: any;
    if (useTextParser) {
      rawResponse = await fetchText(
        url,
        { method, headers, ...(body ? { body } : {}) },
        requestPolicy
      );
    } else {
      rawResponse = await fetchJson(
        url,
        { method, headers, ...(body ? { body } : {}) },
        requestPolicy
      );
    }

    const duration = Math.round(performance.now() - startTime);

    const summary = buildToolSummary(provider, tool, rawResponse);

    // Logging
    const logger = new UsageLogger({ path: config.logging?.usage?.path });
    logger.write({
      timestamp: new Date().toISOString(),
      provider,
      tool,
      catalogued,
      key: safeKeyRefStr || "keyless",
      success: true,
      response_time_ms: duration,
      ...brightDataUsageDetails(summary, requestMaskedZone),
    });

    return {
      result: {
        provider,
        tool,
        ok: true,
        catalogued,
        summary,
        raw: rawResponse,
        meta: {
          duration_ms: duration,
          safe_key_ref: safeKeyRefStr || null,
          warnings,
        },
      },
      secrets: apiKey ? [apiKey] : [],
    };
  } catch (err: any) {
    const duration = Math.round(performance.now() - startTime);

    // The provider's response body is untrusted and may echo secrets back
    // (e.g. Tavily reflects api_key in the request body). Keep it OUT of the
    // logged and returned error *string* — preserve it only in `raw`, which
    // already sits at the caller's trust boundary. This removes any need to
    // scrub keys from error text after the fact.
    let errBody: string | undefined;
    let errorMsg = err.message;
    if (err instanceof HTTPRequestError) {
      errBody = err.body;
      errorMsg = `API request to ${provider}.${tool} failed with HTTP ${err.status}`;
    }

    const logger = new UsageLogger({ path: config.logging?.usage?.path });
    logger.write({
      timestamp: new Date().toISOString(),
      provider,
      tool,
      catalogued,
      key: safeKeyRefStr || "keyless",
      success: false,
      response_time_ms: duration,
      error: errorMsg,
      ...brightDataUsageDetails(null, requestMaskedZone),
    });

    let parsedRawError: any = null;
    if (errBody) {
      try {
        parsedRawError = JSON.parse(errBody);
      } catch {
        parsedRawError = errBody;
      }
    }

    return {
      result: {
        provider,
        tool,
        ok: false,
        catalogued,
        summary: null,
        raw: parsedRawError,
        error: {
          code: "PROVIDER_ERROR",
          message: errorMsg,
        },
        meta: {
          duration_ms: duration,
          safe_key_ref: safeKeyRefStr || null,
          warnings,
        },
      },
      secrets: apiKey ? [apiKey] : [],
    };
  }
}

export interface ToolCallOptions {
  /**
   * Per-invocation `--freshness <duration>` override of `[cache].tool_ttl`.
   * Honored only for explicitly replay-safe tools (see `./replay.js`);
   * ignored (with a warning) for everything else.
   */
  freshness?: string;
  /**
   * Per-invocation `--no-cache` bypass: skip both the exact-replay lookup AND
   * the cache store for this call. History recording still happens as a
   * normal live execution.
   */
  noCache?: boolean;
}

/**
 * Non-secret request-shaping provider config that must participate in an
 * exact tool cache key. A provider's resolved endpoint (configured base URL or
 * `<PROVIDER>_BASE_URL` env fallback) decides which instance answers the
 * request; a cache entry sourced from one instance would replay stale results
 * after the endpoint changes. Only endpoint-like option values are included —
 * never credential material. Kept generic: any configured endpoint-like option
 * shapes the key, not a searxng-specific carve-out.
 */
function endpointKeyMaterial(config: Config, provider: string): Record<string, string> {
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

function isFreshEntry(meta: CacheEntryMeta, ttlSeconds: number): boolean {
  return Date.now() - meta.created_at <= ttlSeconds * 1000;
}

/** Shape guard so a malformed tool-cache file is a miss, never a replay crash. */
const isToolCachePayload = (p: unknown): p is ToolCallResult =>
  !!p &&
  typeof p === "object" &&
  typeof (p as ToolCallResult).ok === "boolean" &&
  !!(p as ToolCallResult).meta &&
  typeof (p as ToolCallResult).meta === "object" &&
  Array.isArray((p as ToolCallResult).meta.warnings);

function requestsJinaReplayBypass(
  provider: string,
  tool: string,
  params: Record<string, unknown>
): boolean {
  if (provider !== "jina" || tool !== "reader") return false;
  return Object.entries(params).some(([name, value]) => {
    const normalizedName = name.toLowerCase();
    if (
      normalizedName === "x-no-cache" &&
      (value === true || (typeof value === "string" && value.trim().toLowerCase() === "true"))
    ) {
      return true;
    }
    return normalizedName === "x-set-cookie" &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== "";
  });
}

/**
 * Execute a provider tool call with the PR 2 history/replay behavior:
 *
 * - EVERY invocation that reaches the substrate is recorded as one top-level
 *   history execution (live or cache replay), with credential values and
 *   signed-URL tokens redacted before persistence.
 * - Exact replay (read-through cache + `--freshness`) applies ONLY to tools
 *   on the explicit replay-safe allowlist. All other tools are history-only
 *   and always execute live.
 * - A failed history write surfaces as a non-secret warning in
 *   `meta.warnings` instead of silently dropping the record.
 */
export async function executeToolCall(
  provider: string,
  tool: string,
  params: Record<string, any>,
  config: Config,
  options?: ToolCallOptions
): Promise<ToolCallResult> {
  const history = new HistoryStore({ path: config.history?.path });
  const toolId = `${provider}.${tool}`;
  const warnings: string[] = [];

  const replaySafe = isReplaySafeTool(provider, tool);
  if (options?.freshness && !replaySafe) {
    warnings.push(
      `--freshness ignored: '${toolId}' has no explicit replay-safe policy; it always executes live.`
    );
  }

  const cacheEnabled = config.cache?.enabled !== false;
  const noCache = options?.noCache === true || requestsJinaReplayBypass(provider, tool, params);
  const toolTtl = parseDuration(config.cache?.tool_ttl ?? "6h", 21600);
  const effectiveTtl = options?.freshness
    ? parseDuration(options.freshness, toolTtl)
    : toolTtl;

  // --no-cache bypasses both the lookup and the store for this invocation;
  // history recording below is untouched.
  const cache = replaySafe && cacheEnabled && !noCache
    ? new CacheStore({ enabled: true, path: config.cache?.path })
    : null;
  const key = cache
    ? cacheKey("tool", toolId, { ...params, ...endpointKeyMaterial(config, provider) })
    : null;

  const recordExecution = (record: ExecutionRecord): void => {
    try {
      history.append(record);
    } catch (error) {
      warnings.push(
        `Execution ${record.id} was not recorded in history: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  // Exact replay path — explicitly replay-safe tools only.
  if (cache && key) {
    const entry = cache.getEntry("tool", key, isToolCachePayload);
    if (entry && isFreshEntry(entry.meta, effectiveTtl)) {
      recordExecution({
        id: newExecutionId(),
        timestamp: new Date().toISOString(),
        command: "tool",
        input: redactSensitive(toolId),
        options: redactSensitive(params),
        routing: { providers_attempted: [] },
        source: "cache",
        origin_execution_id: entry.meta.origin_execution_id,
        cache: {
          created_at: new Date(entry.meta.created_at).toISOString(),
          age_seconds: Math.round((Date.now() - entry.meta.created_at) / 1000),
          ttl_seconds: entry.meta.ttl_seconds,
        },
        attempts: [],
        result: redactForPersistence(entry.payload.summary) ?? undefined,
        result_count:
          typeof entry.payload.summary?.results_count === "number"
            ? entry.payload.summary.results_count
            : undefined,
        raw: redactForPersistence(entry.payload.raw) ?? undefined,
        raw_available: entry.payload.raw !== null && entry.payload.raw !== undefined,
        duration_ms: 0,
        outcome: entry.payload.ok ? "success" : "failed",
      });
      return {
        ...entry.payload,
        meta: { ...entry.payload.meta, warnings: [...entry.payload.meta.warnings, ...warnings] },
      };
    }
  }

  // Live execution.
  const executionId = newExecutionId();
  const startTime = performance.now();
  const { result, secrets } = await dispatchToolCall(provider, tool, params, config);

  // A provider/tool attempt happened only once the request was actually
  // dispatched; preflight failures (unknown provider, hard-excluded, key
  // resolution) never reached the provider.
  const attempted = result.ok || result.error?.code === "PROVIDER_ERROR";
  const scrubbedRaw =
    result.raw !== null && result.raw !== undefined
      ? redactForPersistence(result.raw, secrets)
      : null;

  recordExecution({
    id: executionId,
    timestamp: new Date().toISOString(),
    command: "tool",
    input: redactSensitive(toolId, secrets),
    options: redactSensitive(params, secrets),
    routing: { providers_attempted: attempted ? [provider] : [] },
    source: "live",
    attempts: attempted
      ? [
          {
            provider,
            tool,
            success: result.ok,
            error: result.error ? redactSensitive(result.error.message, secrets) : undefined,
            duration_ms: result.meta.duration_ms,
            key_ref: result.meta.safe_key_ref ?? undefined,
            result_count:
              typeof result.summary?.results_count === "number"
                ? result.summary.results_count
                : undefined,
          },
        ]
      : [],
    result: redactForPersistence(result.summary, secrets) ?? undefined,
    result_count:
      typeof result.summary?.results_count === "number"
        ? result.summary.results_count
        : undefined,
    raw: scrubbedRaw ?? undefined,
    // The tool path preserves raw provider detail; if it cannot be scrubbed
    // safely it is recorded as unavailable rather than persisted verbatim.
    raw_available: result.raw !== null && result.raw !== undefined && scrubbedRaw !== null,
    errors: result.error
      ? { [toolId]: redactSensitive(result.error.message, secrets) }
      : undefined,
    duration_ms: Math.round(performance.now() - startTime),
    outcome: result.ok ? "success" : "failed",
  });

  // Store eligible exact results for replay, scrubbed of resolved credential
  // values — the replay cache must never become a local secret store either.
  // The entry always records the CONFIG TTL: --freshness decides only whether
  // THIS invocation may read an entry; it must never persist into the entry.
  if (cache && key && result.ok) {
    // An exact replay must be an exact equivalent of the live response. If
    // scrubbing CHANGED the payload (e.g. a signed URL inside the response),
    // a later replay would return a different value than the live call did —
    // worse than no replay. Skip exact caching in that case; history above
    // still records the scrubbed copy, and the next invocation executes live.
    const scrubbed = redactSensitive(result, secrets);
    if (JSON.stringify(scrubbed) === JSON.stringify(result)) {
      cache.set("tool", key, scrubbed, toolTtl, {
        originExecutionId: executionId,
      });
    }
  }

  if (warnings.length > 0) {
    return {
      ...result,
      meta: { ...result.meta, warnings: [...result.meta.warnings, ...warnings] },
    };
  }
  return result;
}

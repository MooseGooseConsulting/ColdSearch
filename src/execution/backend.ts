import { performance } from "node:perf_hooks";
import { effectiveJinaReturnFormat } from "../adapters/jina.js";
import { loadConfig } from "../config.js";
import {
  AllProvidersFailedError,
  FanoutEngine,
  type FanoutAttempt,
  type FanoutOptions,
} from "../engine/fanout.js";
import { CacheStore, type CacheEntryMeta } from "../cache/cache.js";
import { cacheKey, parseDuration } from "../cache/key.js";
import { capabilityCacheIdentity } from "../contracts/endpoint-identity.js";
import { resolveCapabilityProviders } from "../providers.js";
import {
  IntentRejectionError,
  resolveOptionsForIntent,
} from "../dispatch/intents.js";
import { UnsupportedCommonOptionsError } from "../dispatch/translate.js";
import { HistoryStore } from "../history/store.js";
import { redactForPersistence, redactSensitive } from "../history/redact.js";
import {
  newExecutionId,
  type ExecutionRecord,
  type ProviderAttempt,
} from "../history/types.js";
import type {
  CapabilityName,
  Config,
  CrawlResult,
  PendingCrawlJob,
  ExtractResult,
  NormalizedResult,
} from "../types.js";

// Exported: these outcome types ARE the ExecutionBackend contract — the seam
// a remote/hybrid backend must implement against (docs/architecture.md).
export type SearchResult = {
  results: NormalizedResult[];
  providersUsed: string[];
  errors: Record<string, string>;
  /** Providers excluded before dispatch because they could not honor filters. */
  skippedProviders?: Record<string, string>;
  /** Non-secret warnings (e.g. the execution could not be recorded in history). */
  warnings?: string[];
};

export type ExtractOutcome = {
  result: ExtractResult | null;
  provider: string;
  errors?: Record<string, string>;
  warnings?: string[];
};

export type CrawlOutcome = {
  results: CrawlResult[];
  pendingJobs: PendingCrawlJob[];
  provider: string;
  status: "completed" | "pending";
  fallbackCompleted?: boolean;
  fallbackProvider?: string;
  errors?: Record<string, string>;
  warnings?: string[];
};

const SEARCH_PROVIDER_LIMIT_OPTIONS = [
  "numResults",
  "max_results",
  "count",
  "num",
  "limit",
] as const;

/** Cache identity for provider-defined search counts when the CLI limit is implicit. */
function searchProviderLimitIdentity(
  config: Config,
  includeConfiguredLimits: boolean
): Record<string, unknown> {
  const providers = config.capabilities.search?.providers ?? [];
  return {
    providers,
    ...(includeConfiguredLimits
      ? {
          configuredLimits: Object.fromEntries(
            providers.map((provider) => {
              const options = config.providers[provider]?.options ?? {};
              const configured = Object.fromEntries(
                SEARCH_PROVIDER_LIMIT_OPTIONS
                  .filter((key) => options[key] !== undefined)
                  .map((key) => [key, options[key]])
              );
              return [provider, configured];
            })
          ),
        }
      : {}),
  };
}

/**
 * Non-secret search filters that reach the provider wire and therefore shape
 * the returned payload. Mirrors the read sites in each search adapter:
 * serper (location), brave (safesearch), firecrawl (sources), tavily
 * (search_depth/topic/time_range), searxng (categories/engines/language/pageno/
 * time_range/safesearch/theme), exa (type/category/highlights/maxCharacters/
 * maxAgeHours/includeDomains/excludeDomains), brightdata (zone/searchEngine/
 * country). Values are normalized the way the adapters normalize them
 * (trimmed, validated) so the key matches effective requests, not raw config.
 */
const SEARCH_FILTER_OPTIONS: Record<string, readonly string[]> = {
  serper: ["location"],
  brave: ["safesearch"],
  firecrawl: ["sources"],
  tavily: ["search_depth", "topic", "time_range"],
  searxng: ["categories", "engines", "language", "pageno", "time_range", "safesearch", "theme"],
  exa: ["searchType", "category", "highlights", "maxCharacters", "maxAgeHours", "includeDomains", "excludeDomains"],
  brightdata: ["zone", "serpZone", "searchEngine", "searchCountry", "country"],
};

function normalizeFilterValue(
  provider: string,
  key: string,
  value: unknown,
  allOptions: Record<string, unknown> = {}
): unknown {
  // Mirror the adapter: highlights mode ignores maxCharacters entirely.
  if (provider === "exa" && key === "maxCharacters" && allOptions.highlights === true) {
    return undefined;
  }
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (provider === "brave" && key === "safesearch") {
      // Match the adapter exactly: only the lowercase enum reaches the wire
      // (BraveAdapter checks BRAVE_SAFESEARCH_VALUES without case folding).
      // A case-variant config omits the param, so it must key identically
      // to an absent value rather than to the corrected lowercase form.
      return ["off", "moderate", "strict"].includes(trimmed) ? trimmed : undefined;
    }
    if (provider === "firecrawl" && key === "sources") {
      // Key the raw config value, not the sanitized subset: sanitizeSources
      // throws on invalid entries while a filtered key would silently map
      // distinct invalid configs to the same entry.
      if (!Array.isArray(value)) return undefined;
      return value.length > 0 ? value : undefined;
    }
    if (provider === "tavily" && key === "search_depth") {
      return ["basic", "advanced", "fast", "ultra-fast"].includes(trimmed) ? trimmed : undefined;
    }
    return trimmed;
  }
  if (typeof value === "number") {
    if (key === "pageno" || key === "maxCharacters" || key === "maxAgeHours") return value;
    return undefined;
  }
  if (typeof value === "boolean") {
    if (key === "highlights") return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    if (provider === "firecrawl" && key === "sources") {
      return value.length > 0 ? value : undefined;
    }
    if (
      (provider === "exa" && (key === "includeDomains" || key === "excludeDomains")) ||
      (provider === "searxng" && (key === "categories" || key === "engines"))
    ) {
      return value.length > 0 ? value : undefined;
    }
    return undefined;
  }
  return undefined;
}

/** Cache identity for effective provider search filters (Codex P2 on #83). */
function searchFilterIdentity(config: Config): Record<string, unknown> {
  const providers = config.capabilities.search?.providers ?? [];
  return Object.fromEntries(
    providers.map((provider) => {
      const keys = SEARCH_FILTER_OPTIONS[provider] ?? [];
      const options = config.providers[provider]?.options ?? {};
      const filters = Object.fromEntries(
        keys
          .map((key) => [key, normalizeFilterValue(provider, key, options[key], options)] as const)
          .filter(([, v]) => v !== undefined)
      );
      return [provider, filters];
    })
  );
}

/** Effective content format for each provider in the default extract pool. */
function extractProviderFormatIdentity(
  config: Config,
  options: FanoutOptions
): Record<string, string> {
  const providers = config.capabilities.extract?.providers ?? [];
  return Object.fromEntries(
    providers.map((provider) => {
      const providerOptions = config.providers[provider]?.options ?? {};
      const configuredValue = (name: string): unknown =>
        Object.entries(providerOptions).find(([key]) => key.toLowerCase() === name)?.[1];
      let format: unknown = options.format;
      if (format === undefined) {
        if (provider === "jina") {
          format = effectiveJinaReturnFormat({ providerOptions });
        } else if (provider === "brightdata") {
          format = configuredValue("data_format") ?? "markdown";
        } else if (provider === "tavily") {
          format = configuredValue("format") ?? "markdown";
        } else {
          // Exa and Firecrawl normalize their extract content to Markdown.
          format = "markdown";
        }
      }
      return [provider, String(format)];
    })
  );
}

/**
 * Effective Bright Data extract country per provider in the default extract
 * pool (Codex on #83: country/searchCountry reach the Unlocker wire via
 * optionalStringOption but were absent from the extract cache key).
 * Mirrors the adapter precedence: country, then searchCountry, default "us".
 */
function brightdataCountryIdentity(config: Config): Record<string, string> {
  const providers = config.capabilities.extract?.providers ?? [];
  return Object.fromEntries(
    providers
      .filter((provider) => provider === "brightdata")
      .map((provider) => {
        const providerOptions = config.providers[provider]?.options ?? {};
        const pick = (name: string): unknown =>
          Object.entries(providerOptions).find(([key]) => key.toLowerCase() === name)?.[1];
        const raw = pick("country") ?? pick("searchcountry");
        const country =
          typeof raw === "string" && raw.trim() ? raw.trim() : "us";
        return [provider, country];
      })
  );
}

/** Shape guards so a malformed cache file is a miss, never a replay crash. */
const isSearchCachePayload = (p: unknown): p is SearchResult =>
  !!p &&
  typeof p === "object" &&
  Array.isArray((p as SearchResult).results) &&
  Array.isArray((p as SearchResult).providersUsed);

const isExtractCachePayload = (p: unknown): p is ExtractOutcome =>
  !!p && typeof p === "object" && "result" in (p as Record<string, unknown>);

export interface ExecutionBackend {
  search(query: string, options: FanoutOptions): Promise<SearchResult>;
  extract(url: string, options: FanoutOptions): Promise<ExtractOutcome>;
  crawl(url: string, options: FanoutOptions): Promise<CrawlOutcome>;
}

export class LocalExecutionBackend implements ExecutionBackend {
  private readonly config: Config;
  private readonly engine: FanoutEngine;
  private readonly cache: CacheStore;
  private readonly history: HistoryStore;
  private readonly cacheEnabled: boolean;
  private readonly searchTtl: number;
  private readonly extractTtl: number;

  constructor(configPath?: string) {
    this.config = loadConfig(configPath);
    this.engine = new FanoutEngine(this.config);

    // Cache is on by default — enabled unless [cache].enabled is explicitly false.
    this.cacheEnabled = this.config.cache?.enabled !== false;
    this.cache = new CacheStore({
      enabled: this.cacheEnabled,
      path: this.config.cache?.path,
    });
    this.history = new HistoryStore({ path: this.config.history?.path });
    this.searchTtl = parseDuration(this.config.cache?.search_ttl ?? "6h", 21600);
    this.extractTtl = parseDuration(this.config.cache?.extract_ttl ?? "24h", 86400);
  }

  /**
   * The cache applies only to the default provider pool. An explicit
   * --providers or --single-provider scope is a deliberate per-request choice,
   * so it bypasses the (provider-agnostic) cache rather than risk serving a hit
   * sourced from a different provider set. --no-cache and [cache].enabled=false
   * disable it too. Requirement-aware routing, non-default intents, and
   * common filters/content options change provider results without changing
   * the config-keyed cache identity, so they bypass the cache too.
   */
  private shouldUseCache(capability: CapabilityName, options: FanoutOptions): boolean {
    if (!this.cacheEnabled || options.noCache) return false;
    if (options.singleProvider) return false;
    if (Array.isArray(options.providers) && options.providers.length > 0) return false;
    if (
      capability === "search" &&
      options.limitSet === false &&
      options.commonOptions?.limit !== undefined
    ) return false;
    if (options.requireFeatures && options.requireFeatures.length > 0) return false;
    const defaultIntent = {
      search: "web-link-search",
      extract: "known-url-extraction",
      crawl: "crawl",
    }[capability];
    if (options.intent && options.intent !== defaultIntent) return false;
    if (
      options.commonOptions?.timeRange ||
      options.commonOptions?.includeContent ||
      options.commonOptions?.includeDomains?.length ||
      options.commonOptions?.excludeDomains?.length
    ) return false;
    return true;
  }

  private validateCapability(capability: CapabilityName, options: FanoutOptions): void {
    resolveCapabilityProviders(this.config, capability, {
      providers: options.providers,
      singleProvider: options.singleProvider,
      requireFeatures: options.requireFeatures,
    });
  }

  /**
   * Capability/preflight validation is part of the audit surface: a rejected
   * invocation is recorded as a failed execution (mirroring the tool path's
   * preflight records) instead of exiting without a history trace.
   */
  private validateAndRecord(
    capability: CapabilityName,
    input: string,
    options: FanoutOptions
  ): void {
    try {
      this.validateCapability(capability, options);
    } catch (error) {
      const warnings: string[] = [];
      this.recordExecution(
        this.failedRecord(capability, input, options, error, performance.now()),
        warnings
      );
      this.flushWarnings(warnings);
      throw error;
    }
  }

  /**
   * Effective TTL for this invocation: config `[cache]` TTLs are the default;
   * a `--freshness <duration>` flag wins for this invocation only (it neither
   * persists nor changes the configured defaults).
   */
  private effectiveTtl(configTtl: number, options: FanoutOptions): number {
    if (!options.freshness) return configTtl;
    return parseDuration(options.freshness, configTtl);
  }

  /** A cache entry is replayable only while it satisfies the effective TTL. */
  private isFresh(meta: CacheEntryMeta, ttlSeconds: number): boolean {
    return Date.now() - meta.created_at <= ttlSeconds * 1000;
  }

  /**
   * Persist one execution record. History is the audit trail that an execution
   * occurred, so a failed write is surfaced as a non-secret warning (stderr /
   * JSON metadata at the CLI) rather than silently dropped like a cache miss.
   */
  private recordExecution(record: ExecutionRecord, warnings: string[]): void {
    try {
      this.history.append(record);
    } catch (error) {
      warnings.push(
        `Execution ${record.id} was not recorded in history: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Surface accumulated non-secret warnings on stderr. Called when an
   * execution is about to throw: the caller (CLI/agent) sees only the error,
   * so without this flush an audit-loss warning pushed during `recordExecution`
   * would be discarded and the lost history record would never be observable.
   */
  private flushWarnings(warnings: string[]): void {
    if (warnings.length === 0) return;
    for (const warning of warnings) {
      console.error(`Warning: ${warning}`);
    }
  }

  private requestOptions(options: FanoutOptions): Record<string, unknown> {
    const requestedProviders = options.requestedProviders ?? options.providers;
    return {
      limit: options.limit,
      limitSet: options.limitSet !== false,
      ...(options.rerankStrategy ? { rerankStrategy: options.rerankStrategy } : {}),
      ...(requestedProviders?.length ? { providers: requestedProviders } : {}),
      ...(options.singleProvider ? { singleProvider: true } : {}),
      ...(options.noCache ? { noCache: true } : {}),
      ...(options.freshness ? { freshness: options.freshness } : {}),
      ...(options.format ? { format: options.format } : {}),
      ...(options.depth !== undefined ? { depth: options.depth } : {}),
      // Intent provenance (issue #79): which intent backed this invocation,
      // what it required of tools, and all common invocation options.
      ...(options.intent ? { intent: options.intent } : {}),
      ...(options.requireFeatures?.length ? { requireFeatures: options.requireFeatures } : {}),
      ...(options.commonOptions ? { commonOptions: options.commonOptions } : {}),
    };
  }

  /** Resolve intent options for non-CLI callers and audit preflight rejection. */
  private resolveIntentOptions(
    capability: CapabilityName,
    input: string,
    options: FanoutOptions
  ): FanoutOptions {
    const requestedOptions: FanoutOptions = {
      ...options,
      requestedProviders: [...(options.requestedProviders ?? options.providers ?? [])],
    };
    try {
      return resolveOptionsForIntent(capability, this.config, requestedOptions);
    } catch (error) {
      if (error instanceof IntentRejectionError) {
        this.flushWarnings(this.recordIntentRejection(capability, input, requestedOptions, error));
      }
      throw error;
    }
  }

  /** Record an intent rejected by preflight before normal backend dispatch. */
  recordIntentRejection(
    capability: CapabilityName,
    input: string,
    options: FanoutOptions,
    error: unknown
  ): string[] {
    const warnings: string[] = [];
    this.recordExecution(
      this.failedRecord(capability, input, options, error, performance.now()),
      warnings
    );
    return warnings;
  }

  private routingInfo(
    capability: CapabilityName,
    options: FanoutOptions,
    providersAttempted: string[],
    reranker?: string,
    providersSkipped?: Record<string, string>
  ): ExecutionRecord["routing"] {
    const requestedProviders = options.requestedProviders ?? options.providers;
    return {
      strategy: options.singleProvider
        ? "single-provider"
        : this.config.capabilities[capability]?.strategy ?? "all",
      requested_providers: requestedProviders?.length ? requestedProviders : undefined,
      providers_attempted: providersAttempted,
      ...(reranker ? { reranker } : {}),
      ...(providersSkipped && Object.keys(providersSkipped).length > 0
        ? { providers_skipped: providersSkipped }
        : {}),
    };
  }

  private static toAttempts(attempts: FanoutAttempt[], secrets: string[] = []): ProviderAttempt[] {
    return attempts.map((attempt) => ({
      ...attempt,
      // Provider errors can echo credentials (adapters embed provider-supplied
      // error bodies); scrub them like the errors map before persistence.
      error: attempt.error === undefined ? undefined : redactSensitive(attempt.error, secrets),
    }));
  }

  private cacheProvenance(meta: CacheEntryMeta): ExecutionRecord["cache"] {
    return {
      created_at: new Date(meta.created_at).toISOString(),
      age_seconds: Math.round((Date.now() - meta.created_at) / 1000),
      ttl_seconds: meta.ttl_seconds,
    };
  }

  async search(query: string, options: FanoutOptions): Promise<SearchResult> {
    options = this.resolveIntentOptions("search", query, options);
    this.validateAndRecord("search", query, options);
    const useCache = this.shouldUseCache("search", options);
    const warnings: string[] = [];
    const ttl = this.effectiveTtl(this.searchTtl, options);
    const reranker = options.rerankStrategy ?? "rrf";

    // The key carries config identity (pool, strategy, endpoint material) so
    // editing the configured pool or an endpoint invalidates stale entries;
    // per-call provider scoping is excluded by shouldUseCache() instead.
    const key = useCache
      ? cacheKey("search", query, {
          limit: options.limit,
          limitSet: options.limitSet !== false,
          rerankStrategy: reranker,
          ...capabilityCacheIdentity(this.config, "search"),
          searchProviderLimitIdentity: searchProviderLimitIdentity(
            this.config,
            options.limitSet === false
          ),
          searchFilterIdentity: searchFilterIdentity(this.config),
        })
      : null;

    if (key) {
      const entry = this.cache.getEntry("search", key, isSearchCachePayload);
      if (entry && this.isFresh(entry.meta, ttl)) {
        // Exact cache hit: a new execution with zero provider calls, linked
        // to the originating execution when provenance is known.
        this.recordExecution(
          {
            id: newExecutionId(),
            timestamp: new Date().toISOString(),
            command: "search",
            input: redactSensitive(query),
            options: this.requestOptions(options),
            routing: this.routingInfo("search", options, [], reranker),
            source: "cache",
            origin_execution_id: entry.meta.origin_execution_id,
            cache: this.cacheProvenance(entry.meta),
            attempts: [],
            result: redactForPersistence(entry.payload.results) ?? undefined,
            result_count: entry.payload.results.length,
            raw_available: false,
            duration_ms: 0,
            outcome: "success",
          },
          warnings
        );
        return { ...entry.payload, warnings };
      }
    }

    const id = newExecutionId();
    const start = performance.now();
    try {
      const result = await this.engine.search(query, options);
      const secrets = result.secretsUsed;
      this.recordExecution(
        {
          id,
          timestamp: new Date().toISOString(),
          command: "search",
          input: redactSensitive(query, secrets),
          options: redactSensitive(this.requestOptions(options), secrets),
          routing: this.routingInfo(
            "search",
            options,
            result.attempts.map((a) => a.provider),
            reranker,
            result.skippedProviders
          ),
          source: "live",
          attempts: LocalExecutionBackend.toAttempts(result.attempts, secrets),
          partitions: redactSensitive(result.partitions, secrets),
          result: redactForPersistence(result.results, secrets) ?? undefined,
          result_count: result.results.length,
          raw_available: false,
          errors:
            Object.keys(result.errors).length > 0
              ? redactSensitive(result.errors, secrets)
              : undefined,
          duration_ms: Math.round(performance.now() - start),
          outcome: Object.keys(result.errors).length > 0 ? "partial" : "success",
        },
        warnings
      );

      if (key && result.results.length > 0) {
        // Only cache non-empty results; drop transient per-provider errors from
        // the stored payload so a hit doesn't replay stale error messages.
        // The entry always records the CONFIG TTL: --freshness decides only
        // whether THIS invocation may read an entry; it must never shorten or
        // extend the stored entry for later invocations.
        this.cache.set(
          "search",
          key,
          { results: result.results, providersUsed: result.providersUsed, errors: {} },
          this.searchTtl,
          { originExecutionId: id }
        );
      }
      return {
        results: result.results,
        providersUsed: result.providersUsed,
        errors: result.errors,
        ...(Object.keys(result.skippedProviders).length > 0
          ? { skippedProviders: result.skippedProviders }
          : {}),
        warnings,
      };
    } catch (error) {
      this.recordExecution(this.failedRecord("search", query, options, error, start), warnings);
      this.flushWarnings(warnings);
      throw error;
    }
  }

  async extract(url: string, options: FanoutOptions): Promise<ExtractOutcome> {
    options = this.resolveIntentOptions("extract", url, options);
    this.validateAndRecord("extract", url, options);
    const jinaOptions = this.config.providers.jina?.options ?? {};
    const jinaIsInDefaultExtractPool =
      this.config.capabilities.extract?.providers?.includes("jina") ?? false;
    const hasStatefulJinaHeader = jinaIsInDefaultExtractPool &&
      Object.entries(jinaOptions).some(([name, value]) => {
        const normalizedName = name.toLowerCase();
        if (normalizedName === "x-no-cache") {
          return value === true ||
            (typeof value === "string" && value.trim().toLowerCase() === "true");
        }
        return normalizedName === "x-set-cookie" &&
          value !== undefined &&
          value !== null &&
          String(value).trim() !== "";
      });
    const useCache = this.shouldUseCache("extract", options) && !hasStatefulJinaHeader;
    const warnings: string[] = [];
    const ttl = this.effectiveTtl(this.extractTtl, options);

    const effectiveReturnFormat = effectiveJinaReturnFormat({
      format: options.format,
      providerOptions: jinaOptions,
    });
    const jinaCacheHeaders = Object.fromEntries(
      Object.entries(jinaOptions)
        .filter(([name, value]) => {
          const normalizedName = name.toLowerCase();
          return normalizedName.startsWith("x-") &&
            ![
              "x-return-format",
              "x-proxy",
              "x-proxy-url",
              "x-no-cache",
              "x-set-cookie",
            ].includes(normalizedName) &&
            value !== undefined &&
            value !== null;
        })
        .map(([name, value]) => [name.toLowerCase(), String(value)])
    );
    const key = useCache
      ? cacheKey("extract", url, {
          ...capabilityCacheIdentity(this.config, "extract"),
          format: effectiveReturnFormat,
          providerFormats: extractProviderFormatIdentity(this.config, options),
          providerHeaders: jinaCacheHeaders,
          brightdataCountry: brightdataCountryIdentity(this.config),
        })
      : null;

    if (key) {
      const entry = this.cache.getEntry("extract", key, isExtractCachePayload);
      if (entry && this.isFresh(entry.meta, ttl)) {
        this.recordExecution(
          {
            id: newExecutionId(),
            timestamp: new Date().toISOString(),
            command: "extract",
            input: redactSensitive(url),
            options: this.requestOptions(options),
            routing: this.routingInfo("extract", options, []),
            source: "cache",
            origin_execution_id: entry.meta.origin_execution_id,
            cache: this.cacheProvenance(entry.meta),
            attempts: [],
            result: redactForPersistence(entry.payload.result) ?? undefined,
            result_count: entry.payload.result ? 1 : 0,
            raw_available: false,
            duration_ms: 0,
            outcome: "success",
          },
          warnings
        );
        return { ...entry.payload, warnings };
      }
    }

    const id = newExecutionId();
    const start = performance.now();
    try {
      // extract throws when all providers fail, so a returned value is a success.
      const result = await this.engine.extract(url, options);
      const secrets = result.secretsUsed;
      this.recordExecution(
        {
          id,
          timestamp: new Date().toISOString(),
          command: "extract",
          input: redactSensitive(url, secrets),
          options: redactSensitive(this.requestOptions(options), secrets),
          routing: this.routingInfo(
            "extract",
            options,
            result.attempts.map((a) => a.provider)
          ),
          source: "live",
          attempts: LocalExecutionBackend.toAttempts(result.attempts, secrets),
          result: redactForPersistence(result.result, secrets) ?? undefined,
          result_count: result.result ? 1 : 0,
          raw_available: false,
          errors: result.errors ? redactSensitive(result.errors, secrets) : undefined,
          duration_ms: Math.round(performance.now() - start),
          outcome:
            result.errors && Object.keys(result.errors).length > 0 ? "partial" : "success",
        },
        warnings
      );

      // Only cache when content was actually extracted; omit transient errors
      // from the stored payload so a hit doesn't replay stale error messages.
      if (key && result.result !== null) {
        this.cache.set(
          "extract",
          key,
          { result: result.result, provider: result.provider },
          this.extractTtl,
          { originExecutionId: id }
        );
      }
      return {
        result: result.result,
        provider: result.provider,
        errors: result.errors,
        warnings,
      };
    } catch (error) {
      this.recordExecution(this.failedRecord("extract", url, options, error, start), warnings);
      this.flushWarnings(warnings);
      throw error;
    }
  }

  async crawl(url: string, options: FanoutOptions): Promise<CrawlOutcome> {
    options = this.resolveIntentOptions("crawl", url, options);
    // Exact crawl replay stays disabled in PR 2 (broad site snapshots are
    // sensitive to site state/depth/limit) — but every crawl is recorded.
    this.validateAndRecord("crawl", url, options);
    const warnings: string[] = [];
    const start = performance.now();

    try {
      const result = await this.engine.crawl(url, options);
      const secrets = result.secretsUsed;
      this.recordExecution(
        {
          id: newExecutionId(),
          timestamp: new Date().toISOString(),
          command: "crawl",
          input: redactSensitive(url, secrets),
          options: redactSensitive(this.requestOptions(options), secrets),
          routing: this.routingInfo(
            "crawl",
            options,
            result.attempts.map((a) => a.provider)
          ),
          source: "live",
          attempts: LocalExecutionBackend.toAttempts(result.attempts, secrets),
          result: redactForPersistence(result.results, secrets) ?? undefined,
          result_count: result.results.length,
          pending_jobs: redactSensitive(result.pendingJobs, secrets),
          raw_available: false,
          errors: result.errors ? redactSensitive(result.errors, secrets) : undefined,
          duration_ms: Math.round(performance.now() - start),
          outcome:
            result.status === "pending"
              ? "pending"
              : result.errors && Object.keys(result.errors).length > 0
                ? "partial"
                : "success",
        },
        warnings
      );
      return {
        results: result.results,
        pendingJobs: result.pendingJobs,
        provider: result.provider,
        status: result.status,
        fallbackCompleted: result.fallbackCompleted,
        fallbackProvider: result.fallbackProvider,
        errors: result.errors,
        warnings,
      };
    } catch (error) {
      this.recordExecution(this.failedRecord("crawl", url, options, error, start), warnings);
      this.flushWarnings(warnings);
      throw error;
    }
  }

  /** History record for an execution where every provider failed. */
  private failedRecord(
    command: CapabilityName,
    input: string,
    options: FanoutOptions,
    error: unknown,
    start: number
  ): ExecutionRecord {
    const allFailed = error instanceof AllProvidersFailedError ? error : null;
    const skippedProviders = allFailed?.skippedProviders ??
      (error instanceof UnsupportedCommonOptionsError ? error.skippedProviders : undefined);
    const secrets = allFailed?.secretsUsed ?? [];
    const errors = allFailed?.providerErrors ?? {
      error: error instanceof Error ? error.message : String(error),
    };
    return {
      id: newExecutionId(),
      timestamp: new Date().toISOString(),
      command,
      input: redactSensitive(input, secrets),
      options: redactSensitive(this.requestOptions(options), secrets),
      routing: this.routingInfo(
        command,
        options,
        (allFailed?.attempts ?? []).map((a) => a.provider),
        undefined,
        skippedProviders
      ),
      source: "live",
      attempts: allFailed ? LocalExecutionBackend.toAttempts(allFailed.attempts, secrets) : [],
      raw_available: false,
      errors: redactSensitive(errors, secrets),
      duration_ms: Math.round(performance.now() - start),
      outcome: "failed",
    };
  }
}

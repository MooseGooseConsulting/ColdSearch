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
import {
  NoEligibleProviderFeatureError,
  resolveCapabilityProviders,
  validateSelectedProviders,
} from "../providers.js";
import {
  IntentRejectionError,
  resolveOptionsForIntent,
} from "../dispatch/intents.js";
import { UnsupportedCommonOptionsError } from "../dispatch/translate.js";
import { HistoryStore } from "../history/store.js";
import {
  redactForPersistence,
  redactSensitiveForPersistence,
} from "../history/redact.js";
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
  /** Present when the caller supplied a run id for this invocation. */
  run_id?: string;
};

export type ExtractOutcome = {
  result: ExtractResult | null;
  provider: string;
  errors?: Record<string, string>;
  skippedProviders?: Record<string, string>;
  warnings?: string[];
  /** Present when the caller supplied a run id for this invocation. */
  run_id?: string;
};

export type CrawlOutcome = {
  results: CrawlResult[];
  pendingJobs: PendingCrawlJob[];
  provider: string;
  status: "completed" | "pending";
  fallbackCompleted?: boolean;
  fallbackProvider?: string;
  errors?: Record<string, string>;
  skippedProviders?: Record<string, string>;
  warnings?: string[];
  /** Present when the caller supplied a run id for this invocation. */
  run_id?: string;
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

/** Shape guards so a malformed cache file is a miss, never a replay crash. */
const isSearchCachePayload = (p: unknown): p is SearchResult =>
  !!p &&
  typeof p === "object" &&
  Array.isArray((p as SearchResult).results) &&
  Array.isArray((p as SearchResult).providersUsed);

interface SearchHistorySnapshot {
  input: string;
  options?: Record<string, unknown>;
  results: NormalizedResult[];
  providers: string[];
  result_count: number;
}

/** A malformed or legacy snapshot must not make cache replay fail. */
const isSearchHistorySnapshot = (value: unknown): value is SearchHistorySnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.input === "string" &&
    Array.isArray(snapshot.results) &&
    snapshot.results.every((item) =>
      !!item &&
      typeof item === "object" &&
      typeof (item as NormalizedResult).title === "string" &&
      typeof (item as NormalizedResult).url === "string" &&
      typeof (item as NormalizedResult).snippet === "string" &&
      typeof (item as NormalizedResult).score === "number" &&
      typeof (item as NormalizedResult).source === "string"
    ) &&
    Array.isArray(snapshot.providers) &&
    snapshot.providers.every((provider) => typeof provider === "string") &&
    typeof snapshot.result_count === "number" &&
    (snapshot.options === undefined ||
      (!!snapshot.options &&
        typeof snapshot.options === "object" &&
        !Array.isArray(snapshot.options)))
  );
};

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
      intent: options.intent,
    });
  }

  /**
   * Capability/preflight validation is part of the audit surface: a rejected
   * invocation is recorded as a failed execution (mirroring the tool path's
   * preflight records) instead of exiting without a history trace.
   */
  private async validateAndRecord(
    capability: CapabilityName,
    input: string,
    options: FanoutOptions
  ): Promise<void> {
    try {
      this.validateCapability(capability, options);
    } catch (error) {
      const warnings: string[] = [];
      this.recordExecution(
        await this.failedRecord(capability, input, options, error, performance.now()),
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
  private async resolveIntentOptions(
    capability: CapabilityName,
    input: string,
    options: FanoutOptions
  ): Promise<FanoutOptions> {
    const requestedOptions: FanoutOptions = {
      ...options,
      requestedProviders: [...(options.requestedProviders ?? options.providers ?? [])],
    };
    // Native-only intents narrow the override before capability validation.
    // Reject unknown or incapable providers against the original selection.
    if (requestedOptions.providers?.length) {
      try {
        validateSelectedProviders(this.config, capability, requestedOptions.providers);
      } catch (error) {
        this.flushWarnings(
          await this.recordIntentRejection(capability, input, requestedOptions, error)
        );
        throw error;
      }
    }
    try {
      return resolveOptionsForIntent(capability, this.config, requestedOptions);
    } catch (error) {
      if (error instanceof IntentRejectionError) {
        this.flushWarnings(
          await this.recordIntentRejection(capability, input, requestedOptions, error)
        );
      }
      throw error;
    }
  }

  /** Keep resolved credentials available to in-memory agent history redaction. */
  private reportSecretsUsed(
    options: FanoutOptions,
    secrets: string[],
    collectionComplete = true
  ): void {
    let complete = collectionComplete;
    if (options.onSecretsUsed && secrets.length > 0) {
      try {
        options.onSecretsUsed(secrets);
      } catch {
        // A redaction observer must never change provider execution behavior,
        // but persisted agent text must fail closed when it missed a secret.
        complete = false;
      }
    }
    if (!complete) {
      try {
        options.onSecretCollectionIncomplete?.();
      } catch {
        // A redaction observer must never change provider execution behavior.
      }
    }
  }

  /** Signal that the complete configured key set was checked for this live search. */
  private reportConfiguredSecretsResolved(options: FanoutOptions): void {
    try {
      options.onConfiguredSecretsResolved?.();
    } catch {
      try {
        options.onSecretCollectionIncomplete?.();
      } catch {
        // Observer failures must not alter provider execution.
      }
    }
  }

  /** Resolve current provider credentials for history and report the result. */
  private async resolveConfiguredSecretsForHistory(
    options: FanoutOptions
  ): Promise<{ secrets: string[]; complete: boolean }> {
    let resolved: { secrets: string[]; complete: boolean };
    try {
      resolved = await this.engine.resolveConfiguredSecrets();
    } catch {
      resolved = { secrets: [], complete: false };
    }
    this.reportSecretsUsed(options, resolved.secrets, resolved.complete);
    this.reportConfiguredSecretsResolved(options);
    return resolved;
  }

  /** Resolve configured provider credentials for persistence redaction. */
  resolveProviderSecrets(): Promise<{ secrets: string[]; complete: boolean }> {
    return this.engine.resolveConfiguredSecrets();
  }

  /** Record an intent rejected by CLI preflight before normal backend dispatch. */
  async recordIntentRejection(
    capability: CapabilityName,
    input: string,
    options: FanoutOptions,
    error: unknown
  ): Promise<string[]> {
    const warnings: string[] = [];
    this.recordExecution(
      await this.failedRecord(capability, input, options, error, performance.now()),
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
      error:
        attempt.error === undefined
          ? undefined
          : redactSensitiveForPersistence(attempt.error, secrets),
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
    options = await this.resolveIntentOptions("search", query, options);
    await this.validateAndRecord("search", query, options);
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
        })
      : null;

    if (key) {
      const entry = this.cache.getEntry("search", key, isSearchCachePayload);
      if (entry && this.isFresh(entry.meta, ttl)) {
        const historySnapshot = isSearchHistorySnapshot(entry.meta.history_snapshot)
          ? entry.meta.history_snapshot
          : undefined;
        const configuredSecrets = await this.resolveConfiguredSecretsForHistory(options);
        const secrets = configuredSecrets.secrets;
        const historySafe = configuredSecrets.complete && historySnapshot !== undefined;
        const historyInput = historySafe && historySnapshot
          ? redactSensitiveForPersistence(historySnapshot.input, secrets)
          : "[REDACTED]";
        const replayOptionsInput = historySafe && historySnapshot
          ? { ...(historySnapshot.options ?? {}), ...this.requestOptions(options) }
          : null;
        // Freshness is an invocation-level read policy, not part of the cache
        // identity. If this replay omitted --freshness, don't retain an older
        // origin value from the snapshot.
        if (replayOptionsInput) {
          if (options.freshness) {
            replayOptionsInput.freshness = options.freshness;
          } else {
            delete replayOptionsInput.freshness;
          }
        }
        const replayOptionsValue = replayOptionsInput
          ? redactForPersistence(replayOptionsInput, secrets)
          : null;
        const replayOptions = replayOptionsValue &&
          typeof replayOptionsValue === "object" && !Array.isArray(replayOptionsValue)
          ? replayOptionsValue as Record<string, unknown>
          : undefined;
        const historyResultsValue = historySafe && historySnapshot
          ? redactForPersistence(historySnapshot.results, secrets)
          : null;
        const historyResults = Array.isArray(historyResultsValue)
          ? historyResultsValue as NormalizedResult[]
          : undefined;
        // Exact cache hit: a new execution with zero provider calls, linked
        // to the originating execution when provenance is known.
        // Re-check current credentials because the safe snapshot may predate
        // key rotation. Keep the replay content-free if the full key set is
        // unavailable; otherwise redact the snapshot again with current keys.
        this.recordExecution(
          {
            id: newExecutionId(),
            timestamp: new Date().toISOString(),
            command: "search",
            ...(options.runId ? { run_id: options.runId } : {}),
            input: historyInput,
            ...(replayOptions ? { options: replayOptions } : {}),
            routing: this.routingInfo(
              "search",
              options,
              // The replay makes no provider calls. Origin providers remain
              // available through origin_execution_id and cache provenance.
              [],
              reranker
            ),
            source: "cache",
            origin_execution_id: entry.meta.origin_execution_id,
            cache: this.cacheProvenance(entry.meta),
            attempts: [],
            ...(historyResults ? { result: historyResults } : {}),
            result_count: historySnapshot?.result_count ?? entry.payload.results.length,
            raw_available: false,
            duration_ms: 0,
            outcome: "success",
          },
          warnings
        );
        return {
          ...entry.payload,
          warnings,
          ...(options.runId ? { run_id: options.runId } : {}),
        };
      }
    }

    const id = newExecutionId();
    const start = performance.now();
    // Resolve every configured key concurrently with provider dispatch. The
    // result is still awaited before history is persisted, since a missing
    // ref means free-text history must fail closed.
    const configuredSecretsPromise = this.resolveConfiguredSecretsForHistory(options);
    const secrets = new Set<string>();
    try {
      const result = await this.engine.search(query, options);
      const configuredSecrets = await configuredSecretsPromise;
      for (const secret of configuredSecrets.secrets) secrets.add(secret);
      for (const secret of result.secretsUsed) secrets.add(secret);
      this.reportSecretsUsed(options, result.secretsUsed);
      const historySafe = configuredSecrets.complete;
      const historyInput = historySafe
        ? redactSensitiveForPersistence(query, [...secrets])
        : "[REDACTED]";
      const optionsValue = historySafe
        ? redactForPersistence(this.requestOptions(options), [...secrets])
        : null;
      const historyOptions = optionsValue &&
        typeof optionsValue === "object" && !Array.isArray(optionsValue)
        ? optionsValue as Record<string, unknown>
        : undefined;
      const historyResults = historySafe
        ? redactForPersistence(result.results, [...secrets])
        : null;
      const historySnapshot: SearchHistorySnapshot | undefined = Array.isArray(historyResults)
        ? {
            input: historyInput,
            options: historyOptions,
            results: historyResults as NormalizedResult[],
            providers: [...result.providersUsed],
            result_count: result.results.length,
          }
        : undefined;
      this.recordExecution(
        {
          id,
          timestamp: new Date().toISOString(),
          command: "search",
          ...(options.runId ? { run_id: options.runId } : {}),
          input: historyInput,
          ...(historyOptions ? { options: historyOptions } : {}),
          routing: this.routingInfo(
            "search",
            options,
            result.attempts.map((a) => a.provider),
            reranker,
            this.redactSkippedProviders(
              result.skippedProviders,
              [...secrets],
              historySafe
            )
          ),
          source: "live",
          attempts: LocalExecutionBackend.toAttempts(result.attempts, [...secrets]).map(
            (attempt) => {
              if (!historySafe) delete attempt.error;
              return attempt;
            }
          ),
          ...(historySafe
            ? { partitions: redactSensitiveForPersistence(result.partitions, [...secrets]) }
            : {}),
          result: Array.isArray(historyResults) ? historyResults : undefined,
          result_count: result.results.length,
          raw_available: false,
          errors: historySafe &&
            Object.keys(result.errors).length > 0
              ? redactSensitiveForPersistence(result.errors, [...secrets])
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
          { originExecutionId: id, ...(historySnapshot ? { historySnapshot } : {}) }
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
        ...(options.runId ? { run_id: options.runId } : {}),
      };
    } catch (error) {
      const configuredSecrets = await configuredSecretsPromise;
      for (const secret of configuredSecrets.secrets) secrets.add(secret);
      const errorSecrets = error instanceof AllProvidersFailedError
        ? error.secretsUsed
        : [];
      for (const secret of errorSecrets) secrets.add(secret);
      if (error instanceof AllProvidersFailedError) {
        this.reportSecretsUsed(options, errorSecrets);
      }
      this.recordExecution(
        await this.failedRecord("search", query, options, error, start, {
          secrets: [...secrets],
          complete: configuredSecrets.complete,
        }),
        warnings
      );
      this.flushWarnings(warnings);
      throw error;
    }
  }

  async extract(url: string, options: FanoutOptions): Promise<ExtractOutcome> {
    options = await this.resolveIntentOptions("extract", url, options);
    await this.validateAndRecord("extract", url, options);
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
            ...(options.runId ? { run_id: options.runId } : {}),
            input: redactSensitiveForPersistence(url),
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
        return {
          ...entry.payload,
          warnings,
          ...(options.runId ? { run_id: options.runId } : {}),
        };
      }
    }

    const id = newExecutionId();
    const start = performance.now();
    const configuredSecretsPromise = this.resolveConfiguredSecretsForHistory(options);
    try {
      // extract throws when all providers fail, so a returned value is a success.
      const result = await this.engine.extract(url, options);
      const configuredSecrets = await configuredSecretsPromise;
      const secrets = result.secretsUsed;
      this.reportSecretsUsed(options, secrets);
      this.recordExecution(
        {
          id,
          timestamp: new Date().toISOString(),
          command: "extract",
          ...(options.runId ? { run_id: options.runId } : {}),
          input: redactSensitiveForPersistence(url, secrets),
          options: redactSensitiveForPersistence(this.requestOptions(options), secrets),
          routing: this.routingInfo(
            "extract",
            options,
            result.attempts.map((a) => a.provider),
            undefined,
            this.redactSkippedProviders(
              result.skippedProviders,
              [...new Set([...configuredSecrets.secrets, ...secrets])],
              configuredSecrets.complete
            )
          ),
          source: "live",
          attempts: LocalExecutionBackend.toAttempts(result.attempts, secrets),
          result: redactForPersistence(result.result, secrets) ?? undefined,
          result_count: result.result ? 1 : 0,
          raw_available: false,
          errors:
            result.errors
              ? redactSensitiveForPersistence(result.errors, secrets)
              : undefined,
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
        ...(Object.keys(result.skippedProviders).length > 0
          ? { skippedProviders: result.skippedProviders }
          : {}),
        warnings,
        ...(options.runId ? { run_id: options.runId } : {}),
      };
    } catch (error) {
      const configuredSecrets = await configuredSecretsPromise;
      this.recordExecution(
        await this.failedRecord("extract", url, options, error, start, {
          secrets: [
            ...new Set([
              ...configuredSecrets.secrets,
              ...(error instanceof AllProvidersFailedError ? error.secretsUsed : []),
            ]),
          ],
          complete: configuredSecrets.complete,
        }),
        warnings
      );
      this.flushWarnings(warnings);
      throw error;
    }
  }

  async crawl(url: string, options: FanoutOptions): Promise<CrawlOutcome> {
    options = await this.resolveIntentOptions("crawl", url, options);
    // Exact crawl replay stays disabled in PR 2 (broad site snapshots are
    // sensitive to site state/depth/limit) — but every crawl is recorded.
    await this.validateAndRecord("crawl", url, options);
    const warnings: string[] = [];
    const start = performance.now();
    const configuredSecretsPromise = this.resolveConfiguredSecretsForHistory(options);

    try {
      const result = await this.engine.crawl(url, options);
      const configuredSecrets = await configuredSecretsPromise;
      const secrets = result.secretsUsed;
      this.reportSecretsUsed(options, secrets);
      this.recordExecution(
        {
          id: newExecutionId(),
          timestamp: new Date().toISOString(),
          command: "crawl",
          ...(options.runId ? { run_id: options.runId } : {}),
          input: redactSensitiveForPersistence(url, secrets),
          options: redactSensitiveForPersistence(this.requestOptions(options), secrets),
          routing: this.routingInfo(
            "crawl",
            options,
            result.attempts.map((a) => a.provider),
            undefined,
            this.redactSkippedProviders(
              result.skippedProviders,
              [...new Set([...configuredSecrets.secrets, ...secrets])],
              configuredSecrets.complete
            )
          ),
          source: "live",
          attempts: LocalExecutionBackend.toAttempts(result.attempts, secrets),
          result: redactForPersistence(result.results, secrets) ?? undefined,
          result_count: result.results.length,
          pending_jobs: redactSensitiveForPersistence(result.pendingJobs, secrets),
          raw_available: false,
          errors:
            result.errors
              ? redactSensitiveForPersistence(result.errors, secrets)
              : undefined,
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
        ...(Object.keys(result.skippedProviders).length > 0
          ? { skippedProviders: result.skippedProviders }
          : {}),
        warnings,
        ...(options.runId ? { run_id: options.runId } : {}),
      };
    } catch (error) {
      const configuredSecrets = await configuredSecretsPromise;
      this.recordExecution(
        await this.failedRecord("crawl", url, options, error, start, {
          secrets: [
            ...new Set([
              ...configuredSecrets.secrets,
              ...(error instanceof AllProvidersFailedError ? error.secretsUsed : []),
            ]),
          ],
          complete: configuredSecrets.complete,
        }),
        warnings
      );
      this.flushWarnings(warnings);
      throw error;
    }
  }

  /** History record for an execution where every provider failed. */
  private async failedRecord(
    command: CapabilityName,
    input: string,
    options: FanoutOptions,
    error: unknown,
    start: number,
    redaction?: { secrets: string[]; complete: boolean }
  ): Promise<ExecutionRecord> {
    const allFailed = error instanceof AllProvidersFailedError ? error : null;
    const skippedProviders = allFailed?.skippedProviders ??
      (error instanceof UnsupportedCommonOptionsError || error instanceof NoEligibleProviderFeatureError
        ? error.skippedProviders
        : undefined);
    let secrets = [...(redaction?.secrets ?? allFailed?.secretsUsed ?? [])];
    let complete = redaction?.complete;
    if (complete === undefined) {
      try {
        const resolved = await this.engine.resolveConfiguredSecrets();
        complete = resolved.complete;
        secrets = [...new Set([...resolved.secrets, ...secrets])];
      } catch {
        complete = false;
      }
    }
    // Feature-rejection diagnostics can echo caller-supplied feature names.
    // Without a complete key set, do not persist the request or error text.
    // Other preflight failures still need the resolved key set: a pasted
    // credential must not land in history when resolution is incomplete.
    const historySafe = complete === true &&
      !(error instanceof NoEligibleProviderFeatureError);
    const safeSkippedProviders = this.redactSkippedProviders(
      skippedProviders,
      secrets,
      complete === true
    );
    const errors = allFailed?.providerErrors ?? {
      error: error instanceof Error ? error.message : String(error),
    };
    return {
      id: newExecutionId(),
      timestamp: new Date().toISOString(),
      command,
      ...(options.runId ? { run_id: options.runId } : {}),
      input: historySafe ? redactSensitiveForPersistence(input, secrets) : "[REDACTED]",
      ...(historySafe
        ? { options: redactSensitiveForPersistence(this.requestOptions(options), secrets) }
        : {}),
      routing: this.routingInfo(
        command,
        options,
        (allFailed?.attempts ?? []).map((a) => a.provider),
        undefined,
        safeSkippedProviders
      ),
      source: "live",
      attempts: allFailed
        ? LocalExecutionBackend.toAttempts(allFailed.attempts, secrets).map((attempt) => {
            if (!historySafe) delete attempt.error;
            return attempt;
          })
        : [],
      raw_available: false,
      ...(historySafe ? { errors: redactSensitiveForPersistence(errors, secrets) } : {}),
      duration_ms: Math.round(performance.now() - start),
      outcome: "failed",
    };
  }

  /** Redact routing explanations only when the configured key set is complete. */
  private redactSkippedProviders(
    skippedProviders: Record<string, string> | undefined,
    secrets: string[],
    complete: boolean
  ): Record<string, string> | undefined {
    if (!complete || !skippedProviders) return undefined;
    const safe = redactSensitiveForPersistence(skippedProviders, secrets);
    return safe && typeof safe === "object" && !Array.isArray(safe)
      ? safe as Record<string, string>
      : undefined;
  }
}

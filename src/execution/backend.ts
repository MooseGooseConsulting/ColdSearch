import { performance } from "node:perf_hooks";
import { loadConfig } from "../config.js";
import {
  AllProvidersFailedError,
  FanoutEngine,
  type FanoutAttempt,
  type FanoutOptions,
} from "../engine/fanout.js";
import { CacheStore, type CacheEntryMeta } from "../cache/cache.js";
import { cacheKey, parseDuration } from "../cache/key.js";
import { resolveCapabilityProviders } from "../providers.js";
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
  ExtractResult,
  NormalizedResult,
} from "../types.js";

type SearchResult = {
  results: NormalizedResult[];
  providersUsed: string[];
  errors: Record<string, string>;
  /** Non-secret warnings (e.g. the execution could not be recorded in history). */
  warnings?: string[];
};

type ExtractOutcome = {
  result: ExtractResult | null;
  provider: string;
  errors?: Record<string, string>;
  warnings?: string[];
};

type CrawlOutcome = {
  results: CrawlResult[];
  provider: string;
  errors?: Record<string, string>;
  warnings?: string[];
};

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
   * disable it too.
   */
  private shouldUseCache(options: FanoutOptions): boolean {
    if (!this.cacheEnabled || options.noCache) return false;
    if (options.singleProvider) return false;
    if (Array.isArray(options.providers) && options.providers.length > 0) return false;
    return true;
  }

  private validateCapability(capability: CapabilityName, options: FanoutOptions): void {
    resolveCapabilityProviders(this.config, capability, {
      providers: options.providers,
      singleProvider: options.singleProvider,
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
    return {
      limit: options.limit,
      ...(options.rerankStrategy ? { rerankStrategy: options.rerankStrategy } : {}),
      ...(options.providers?.length ? { providers: options.providers } : {}),
      ...(options.singleProvider ? { singleProvider: true } : {}),
      ...(options.noCache ? { noCache: true } : {}),
      ...(options.freshness ? { freshness: options.freshness } : {}),
    };
  }

  private routingInfo(
    capability: CapabilityName,
    options: FanoutOptions,
    providersAttempted: string[],
    reranker?: string
  ): ExecutionRecord["routing"] {
    return {
      strategy: options.singleProvider
        ? "single-provider"
        : this.config.capabilities[capability]?.strategy ?? "all",
      requested_providers: options.providers?.length ? options.providers : undefined,
      providers_attempted: providersAttempted,
      ...(reranker ? { reranker } : {}),
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
    this.validateAndRecord("search", query, options);
    const useCache = this.shouldUseCache(options);
    const warnings: string[] = [];
    const ttl = this.effectiveTtl(this.searchTtl, options);
    const reranker = options.rerankStrategy ?? "rrf";

    const key = useCache
      ? cacheKey("search", query, { limit: options.limit, rerankStrategy: reranker })
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
            ...(options.runId ? { run_id: options.runId } : {}),
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
          ...(options.runId ? { run_id: options.runId } : {}),
          input: redactSensitive(query, secrets),
          options: redactSensitive(this.requestOptions(options), secrets),
          routing: this.routingInfo(
            "search",
            options,
            result.attempts.map((a) => a.provider),
            reranker
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
        warnings,
      };
    } catch (error) {
      this.recordExecution(this.failedRecord("search", query, options, error, start), warnings);
      this.flushWarnings(warnings);
      throw error;
    }
  }

  async extract(url: string, options: FanoutOptions): Promise<ExtractOutcome> {
    this.validateAndRecord("extract", url, options);
    const useCache = this.shouldUseCache(options);
    const warnings: string[] = [];
    const ttl = this.effectiveTtl(this.extractTtl, options);

    const key = useCache ? cacheKey("extract", url, {}) : null;

    if (key) {
      const entry = this.cache.getEntry("extract", key, isExtractCachePayload);
      if (entry && this.isFresh(entry.meta, ttl)) {
        this.recordExecution(
          {
            id: newExecutionId(),
            timestamp: new Date().toISOString(),
            command: "extract",
            ...(options.runId ? { run_id: options.runId } : {}),
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
          ...(options.runId ? { run_id: options.runId } : {}),
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
          ...(options.runId ? { run_id: options.runId } : {}),
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
          raw_available: false,
          errors: result.errors ? redactSensitive(result.errors, secrets) : undefined,
          duration_ms: Math.round(performance.now() - start),
          outcome:
            result.errors && Object.keys(result.errors).length > 0 ? "partial" : "success",
        },
        warnings
      );
      return {
        results: result.results,
        provider: result.provider,
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
    const secrets = allFailed?.secretsUsed ?? [];
    const errors = allFailed?.providerErrors ?? {
      error: error instanceof Error ? error.message : String(error),
    };
    return {
      id: newExecutionId(),
      timestamp: new Date().toISOString(),
      command,
      ...(options.runId ? { run_id: options.runId } : {}),
      input: redactSensitive(input, secrets),
      options: redactSensitive(this.requestOptions(options), secrets),
      routing: this.routingInfo(
        command,
        options,
        (allFailed?.attempts ?? []).map((a) => a.provider)
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

import { createAdapter } from "../adapters/index.js";
import { KeyPoolManager, createKeyPoolManager } from "./keypool.js";
import { rerank, type RerankerOptions } from "./reranker.js";
import { providerSupportsCapability, resolveCapabilityProviders } from "../providers.js";
import { FirecrawlCrawlTerminalError } from "../adapters/firecrawl.js";
import { isQuotaExhausted } from "../http.js";
import { UsageLogger } from "../logging/usage.js";
import { assertNormalizedResult } from "../contracts/envelope.js";
import { HTTPRequestError } from "../http.js";
import type {
  CapabilityName,
  Config,
  NormalizedResult,
  ExtractResult,
  CrawlResult,
  PendingCrawlJob,
} from "../types.js";
import { performance } from "node:perf_hooks";

/**
 * Fanout operation type.
 */
export type OperationType = "search" | "extract" | "crawl";

/**
 * Fanout search options.
 */
export interface FanoutOptions {
  /** Maximum results to return */
  limit: number;
  /** Whether `limit` was supplied by the caller. False preserves provider defaults. */
  limitSet?: boolean;
  /** Specific providers to use (defaults to all configured) */
  providers?: string[];
  /** Reranker strategy */
  rerankStrategy?: "rrf" | "score" | "none";
  /** Operation type */
  operation?: OperationType;
  /** Force single provider mode (random selection) */
  singleProvider?: boolean;
  /**
   * Bypass the read-through result cache. Threaded from the CLI to the
   * execution backend; FanoutEngine itself ignores this flag.
   */
  noCache?: boolean;
  /**
   * Per-invocation `--freshness <duration>` override of the config `[cache]`
   * TTL. Threaded from the CLI to the execution backend; FanoutEngine itself
   * ignores this flag. This is not a provider published-date filter.
   */
  freshness?: string;
  /** Extract `--format`. Search and crawl ignore it. */
  format?: "markdown" | "text";
  /** Crawl `--depth`. Search and extract ignore it. */
  depth?: number;
  /** Existing async jobs supplied by batch resume. */
  resumePendingJobs?: PendingCrawlJob[];
  /** Whether a fallback provider already completed while saved crawl jobs were pending. */
  resumeFallbackCompleted?: boolean;
  /** Provider that produced the completed fallback pages retained for a pending crawl. */
  resumeFallbackProvider?: string;
}

/**
 * Result from a single provider.
 */
interface ProviderResult {
  provider: string;
  results: NormalizedResult[];
  error?: string;
  quotaExhausted?: boolean;
  durationMs: number;
  keyRef: string;
  /** Resolved credential value used for this call, when any. */
  secret?: string;
  /** Retained in-memory so the CLI can classify an all-provider failure. */
  httpError?: HTTPRequestError;
}

/**
 * One provider attempt inside a fanout execution, as observed by the engine.
 * Surfaced for history recording; the key is a safe reference, never a value.
 */
export interface FanoutAttempt {
  provider: string;
  success: boolean;
  /** Provider accepted the crawl but the async job has not completed. */
  pending?: boolean;
  error?: string;
  quota_exhausted?: boolean;
  duration_ms?: number;
  key_ref?: string;
  result_count?: number;
}

/**
 * Thrown when every provider for a capability failed. Carries the per-provider
 * attempts/errors (and resolved secrets, in-memory only for history
 * redaction) so a failed execution stays inspectable in history.
 */
export class AllProvidersFailedError extends Error {
  readonly attempts: FanoutAttempt[];
  readonly providerErrors: Record<string, string>;
  readonly secretsUsed: string[];
  readonly terminalResumeJobs: Array<Pick<PendingCrawlJob, "provider" | "jobId">>;
  readonly discardedResumeJobs: Array<Pick<PendingCrawlJob, "provider" | "jobId">>;
  readonly providerHttpErrors: Record<string, HTTPRequestError>;

  constructor(
    errors: Record<string, string>,
    attempts: FanoutAttempt[],
    secretsUsed: string[],
    providerHttpErrors: Record<string, HTTPRequestError> = {},
    terminalResumeJobs: PendingCrawlJob[] = [],
    discardedResumeJobs: PendingCrawlJob[] = []
  ) {
    super(`All providers failed: ${JSON.stringify(errors)}`);
    this.name = "AllProvidersFailedError";
    this.providerErrors = errors;
    this.attempts = attempts;
    this.secretsUsed = secretsUsed;
    this.terminalResumeJobs = terminalResumeJobs.map(({ provider, jobId }) => ({ provider, jobId }));
    this.discardedResumeJobs = discardedResumeJobs.map(({ provider, jobId }) => ({ provider, jobId }));
    this.providerHttpErrors = providerHttpErrors;
    // In-memory redaction context only: keep resolved credentials off the
    // serialized surface. JSON.stringify on a caught error picks up
    // enumerable own properties, so an enumerable secretsUsed would leak
    // every resolved key to any wrapper/structured logger that serializes it.
    Object.defineProperty(this, "secretsUsed", { enumerable: false });
    Object.defineProperty(this, "terminalResumeJobs", { enumerable: false });
    Object.defineProperty(this, "discardedResumeJobs", { enumerable: false });
    // HTTP error bodies may contain echoed request credentials. Keep structured
    // status/label/body available in memory for classification and debugging,
    // but off the enumerable surface used by loggers and JSON serializers.
    Object.defineProperty(this, "providerHttpErrors", { enumerable: false });
  }
}

function findHttpRequestError(error: unknown): HTTPRequestError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof HTTPRequestError) return current;
    if (!(current instanceof Error)) return undefined;
    current = current.cause;
  }
  return undefined;
}

/**
 * Fanout search engine.
 * Executes search across multiple providers in parallel,
 * then reranks and returns combined results.
 */
export class FanoutEngine {
  private config: Config;
  private usageLogger: UsageLogger;
  private keyPool: KeyPoolManager;

  constructor(config: Config) {
    this.config = config;
    this.usageLogger = new UsageLogger({ path: config.logging?.usage?.path });
    this.keyPool = createKeyPoolManager();
    this.initializeKeyPools();
  }

  /**
   * Initialize key pools from config.
   */
  private initializeKeyPools(): void {
    for (const [provider, providerConfig] of Object.entries(
      this.config.providers
    )) {
      this.keyPool.register(provider, providerConfig.keyPool);
    }
  }

  /**
   * Get providers for a capability, applying strategy.
   * Delegates to the shared resolveCapabilityProviders() so that
   * dry-run and actual execution use the same selection logic.
   */
  private getProvidersForCapability(
    capability: CapabilityName,
    options: FanoutOptions
  ): ReturnType<typeof resolveCapabilityProviders> {
    return resolveCapabilityProviders(
      this.config,
      capability,
      { providers: options.providers, singleProvider: options.singleProvider }
    );
  }

  /**
   * Execute search across all configured providers.
   *
   * Beyond the merged/reranked output, returns the pre-merge per-provider
   * partitions and per-provider attempts so the execution backend can record
   * them in history instead of discarding them after reranking.
   *
   * `secretsUsed` holds resolved credential values from this call, in memory
   * only — it exists so the history writer can redact them from persisted
   * content. It must never be persisted or logged.
   */
  async search(query: string, options: FanoutOptions): Promise<{
    results: NormalizedResult[];
    providersUsed: string[];
    errors: Record<string, string>;
    partitions: Record<string, NormalizedResult[]>;
    attempts: FanoutAttempt[];
    secretsUsed: string[];
  }> {
    // Get providers to use
    const plan = this.getProvidersForCapability("search", options);
    const providers: string[] = [];
    const results: PromiseSettledResult<ProviderResult>[] = [];
    // Keep the output cap separate from provider-specific configured counts.
    // A CLI default of 10 should cap merged results without overriding each
    // provider's configured upstream count.
    const providerLimit = options.limitSet === false ? undefined : options.limit;

    if (plan.quotaFallbackProviders !== undefined) {
      // Random/single-provider: stop after one success. Account exhaustion
      // tries each remaining eligible provider at most once, sequentially.
      let recoveringQuota = false;
      for (const provider of [...plan.providers, ...plan.quotaFallbackProviders]) {
        const value = await this.searchProvider(provider, query, providerLimit);
        providers.push(provider);
        results.push({ status: "fulfilled", value });
        if (!value.error) break;
        recoveringQuota ||= value.quotaExhausted === true;
        if (!recoveringQuota) break;
      }
    } else {
      providers.push(...plan.providers);
      results.push(...await Promise.allSettled(
        providers.map((provider) => this.searchProvider(provider, query, providerLimit))
      ));
    }

    // Collect results and errors
    const resultsByProvider = new Map<string, NormalizedResult[]>();
    const errors: Record<string, string> = {};
    const providersUsed: string[] = [];
    const attempts: FanoutAttempt[] = [];
    const secretsUsed: string[] = [];
    const providerHttpErrors: Record<string, HTTPRequestError> = {};

    results.forEach((result, index) => {
      const provider = providers[index];

      if (result.status === "fulfilled") {
        const value = result.value;
        if (value.secret) secretsUsed.push(value.secret);
        if (value.error) {
          errors[provider] = value.error;
          if (value.httpError) providerHttpErrors[provider] = value.httpError;
          attempts.push({
            provider,
            success: false,
            error: value.error,
            ...(value.quotaExhausted ? { quota_exhausted: true } : {}),
            duration_ms: value.durationMs,
            key_ref: value.keyRef,
          });
        } else {
          resultsByProvider.set(provider, value.results);
          providersUsed.push(provider);
          attempts.push({
            provider,
            success: true,
            duration_ms: value.durationMs,
            key_ref: value.keyRef,
            result_count: value.results.length,
          });
        }
      } else {
        const message = result.reason?.message || "Unknown error";
        errors[provider] = message;
        if (result.reason instanceof HTTPRequestError) {
          providerHttpErrors[provider] = result.reason;
        }
        attempts.push({ provider, success: false, error: message });
      }
    });

    // If all providers failed, throw error
    if (providersUsed.length === 0) {
      throw new AllProvidersFailedError(errors, attempts, secretsUsed, providerHttpErrors);
    }

    // Rerank results
    const rerankOptions: RerankerOptions = {
      limit: options.limit,
      strategy: options.rerankStrategy || "rrf",
      rrfK: 60,
    };

    const rankedResults = rerank(resultsByProvider, rerankOptions);

    return {
      results: rankedResults,
      providersUsed,
      errors,
      partitions: Object.fromEntries(resultsByProvider),
      attempts,
      secretsUsed,
    };
  }

  /**
   * Extract content from a URL.
   * `secretsUsed` is in-memory only (history redaction); never persist it.
   */
  async extract(url: string, options: FanoutOptions): Promise<{
    result: ExtractResult | null;
    provider: string;
    errors?: Record<string, string>;
    attempts: FanoutAttempt[];
    secretsUsed: string[];
  }> {
    const { providers, quotaFallbackProviders } = this.getProvidersForCapability("extract", options);
    const errors: Record<string, string> = {};
    const attempts: FanoutAttempt[] = [];
    const secretsUsed: string[] = [];
    const providerHttpErrors: Record<string, HTTPRequestError> = {};
    let recoveringQuota = false;

    // Random mode unlocks the remaining pool only after quota exhaustion.
    for (const provider of [...providers, ...(quotaFallbackProviders ?? [])]) {
      const start = performance.now();
      let keyRef = "none";
      try {
        const adapter = createAdapter(provider);

        if (!adapter.extract) {
          const error = "Adapter does not support extract";
          const durationMs = Math.round(performance.now() - start);
          errors[provider] = error;
          this.usageLogger.write({
            timestamp: new Date().toISOString(),
            provider,
            capability: "extract",
            key: keyRef,
            success: false,
            response_time_ms: durationMs,
            error,
          });
          attempts.push({
            provider,
            success: false,
            error,
            duration_ms: durationMs,
          });
          if (quotaFallbackProviders !== undefined && !recoveringQuota) break;
          continue;
        }

        // Get API key + safe logging reference (keyless providers like Jina return empty string)
        const keyResult = await this.keyPool.getNextKeyWithRefOrEmpty(provider);
        const apiKey = keyResult.value;
        keyRef = keyResult.ref;
        if (apiKey) secretsUsed.push(apiKey);
        const result = await adapter.extract(url, apiKey, {
          providerOptions: this.config.providers[provider]?.options,
          format: options.format,
        });
        // Engine-boundary shape guard (issue #79, PR-C): a malformed adapter
        // normalization throws here (classified as a provider error) instead
        // of propagating garbage downstream.
        assertNormalizedResult("extract", provider, result);

        const durationMs = Math.round(performance.now() - start);
        this.usageLogger.write({
          timestamp: new Date().toISOString(),
          provider,
          capability: "extract",
          key: keyRef,
          success: true,
          response_time_ms: durationMs,
        });
        attempts.push({
          provider,
          success: true,
          duration_ms: durationMs,
          key_ref: keyRef,
        });
        return {
          result,
          provider,
          errors: Object.keys(errors).length > 0 ? errors : undefined,
          attempts,
          secretsUsed,
        };
      } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const quotaExhausted = isQuotaExhausted(error);
        recoveringQuota ||= quotaExhausted;
        errors[provider] = (error as Error).message;
        if (error instanceof HTTPRequestError) providerHttpErrors[provider] = error;
        this.usageLogger.write({
          timestamp: new Date().toISOString(),
          provider,
          capability: "extract",
          key: keyRef,
          success: false,
          response_time_ms: durationMs,
          error: (error as Error).message,
          ...(quotaExhausted ? { quota_exhausted: true } : {}),
        });
        attempts.push({
          provider,
          success: false,
          error: (error as Error).message,
          duration_ms: durationMs,
          key_ref: keyRef,
          ...(quotaExhausted ? { quota_exhausted: true } : {}),
        });
        if (quotaFallbackProviders !== undefined && !recoveringQuota) break;
      }
    }

    throw new AllProvidersFailedError(errors, attempts, secretsUsed, providerHttpErrors);
  }

  /**
   * Crawl a website.
   * `secretsUsed` is in-memory only (history redaction); never persist it.
   */
  async crawl(url: string, options: FanoutOptions): Promise<{
    results: CrawlResult[];
    pendingJobs: PendingCrawlJob[];
    provider: string;
    status: "completed" | "pending";
    fallbackCompleted?: boolean;
    fallbackProvider?: string;
    errors?: Record<string, string>;
    attempts: FanoutAttempt[];
    secretsUsed: string[];
  }> {
    const errors: Record<string, string> = {};
    const attempts: FanoutAttempt[] = [];
    const secretsUsed: string[] = [];
    const providerHttpErrors: Record<string, HTTPRequestError> = {};
    let recoveringQuota = false;
    const requestedUrl = url.trim();
    const resumePendingJobs: PendingCrawlJob[] = [];
    const pendingJobs: PendingCrawlJob[] = [];
    const terminalResumeJobs: PendingCrawlJob[] = [];
    const discardedResumeJobs: PendingCrawlJob[] = [];
    const resumeProviders = new Set<string>();

    // A batch resume is tied to its saved provider job, even if the current
    // invocation uses random or single-provider selection. Providers removed
    // from configuration or without crawl support cannot resume that handle;
    // report it and discard it instead of keeping it pending forever.
    for (const job of options.resumePendingJobs ?? []) {
      let unavailableReason: string | undefined;
      if (job.url.trim() !== requestedUrl) {
        unavailableReason = `saved URL ${JSON.stringify(job.url)} does not match requested URL ${JSON.stringify(requestedUrl)}`;
      } else if (!this.config.providers[job.provider]) {
        unavailableReason = "provider is no longer configured";
      } else {
        try {
          if (!providerSupportsCapability(job.provider, "crawl")) {
            unavailableReason = "provider no longer supports crawl";
          }
        } catch {
          unavailableReason = "provider is no longer available in this build";
        }
      }

      if (unavailableReason) {
        const message =
          `Cannot resume ${job.provider} crawl job '${job.jobId}': ${unavailableReason}. ` +
          "Restore the provider configuration or remove the stale pending job from the batch output.";
        errors[job.provider] = message;
        attempts.push({ provider: job.provider, success: false, error: message });
        discardedResumeJobs.push(job);
        continue;
      }

      resumePendingJobs.push(job);
      resumeProviders.add(job.provider);
    }

    const { providers: selectedProviders, quotaFallbackProviders } =
      this.getProvidersForCapability("crawl", options);
    const resumeJobsToPoll = resumePendingJobs.splice(0);
    let completedResumeProvider: string | undefined;
    const completedResumeResults: CrawlResult[] = [];

    // Poll every saved handle before starting fallback work. A provider can
    // own several outstanding jobs for the same URL, and each job must be
    // polled independently even when an earlier one remains pending.
    for (const provider of resumeProviders) {
      const providerJobs = resumeJobsToPoll.filter((job) => job.provider === provider);
      for (const resumeJob of providerJobs) {
        const start = performance.now();
        let keyRef = "none";
        let resumeHandleIsUsable = true;
        try {
          const adapter = createAdapter(provider);
          if (!adapter.crawl) {
            resumeHandleIsUsable = false;
            throw new Error(
              `Cannot resume ${provider} crawl job '${resumeJob.jobId}': provider adapter no longer supports crawl.`
            );
          }

          const keyResult = await this.keyPool.getNextKeyWithRefOrEmpty(provider);
          const apiKey = keyResult.value;
          keyRef = keyResult.ref;
          if (apiKey) secretsUsed.push(apiKey);
          const results = await adapter.crawl(url, apiKey, {
            limit: options.limit,
            depth: options.depth,
            providerOptions: this.config.providers[provider]?.options,
            resumeJobId: resumeJob.jobId,
          });
          assertNormalizedResult("crawl", provider, results);

          const durationMs = Math.round(performance.now() - start);
          const pendingResults = results.filter((result) => result.status === "pending");
          const pageResults = results.filter((result) => result.status !== "pending");
          if (pendingResults.length > 0) {
            if (pageResults.length > 0) {
              completedResumeProvider ??= provider;
              completedResumeResults.push(...pageResults);
            }
            const providerPendingJobs = pendingResults.map((result) => {
              if (!result.jobId) {
                throw new Error(`Provider ${provider} returned a pending crawl without a job ID`);
              }
              return {
                provider,
                jobId: result.jobId,
                url: result.url || url,
              };
            });
            pendingJobs.push(...providerPendingJobs);
            const pendingMessage = "Provider crawl is still pending";
            this.usageLogger.write({
              timestamp: new Date().toISOString(),
              provider,
              capability: "crawl",
              key: keyRef,
              success: false,
              pending: true,
              response_time_ms: durationMs,
              error: pendingMessage,
            });
            attempts.push({
              provider,
              success: false,
              pending: true,
              error: pendingMessage,
              duration_ms: durationMs,
              key_ref: keyRef,
              result_count: pageResults.length,
            });
            continue;
          }

          this.usageLogger.write({
            timestamp: new Date().toISOString(),
            provider,
            capability: "crawl",
            key: keyRef,
            success: true,
            response_time_ms: durationMs,
          });
          attempts.push({
            provider,
            success: true,
            duration_ms: durationMs,
            key_ref: keyRef,
            result_count: pageResults.length,
          });
          completedResumeProvider ??= provider;
          completedResumeResults.push(...pageResults);
        } catch (error) {
          // A failed poll does not prove that an accepted async job stopped.
          if (resumeHandleIsUsable && !(error instanceof FirecrawlCrawlTerminalError)) {
            pendingJobs.push(resumeJob);
          } else if (error instanceof FirecrawlCrawlTerminalError) {
            terminalResumeJobs.push(resumeJob);
          }
          const durationMs = Math.round(performance.now() - start);
          const quotaExhausted = isQuotaExhausted(error);
          recoveringQuota ||= quotaExhausted;
          errors[provider] = (error as Error).message;
          const httpError = findHttpRequestError(error);
          if (httpError) providerHttpErrors[provider] = httpError;
          this.usageLogger.write({
            timestamp: new Date().toISOString(),
            provider,
            capability: "crawl",
            key: keyRef,
            success: false,
            response_time_ms: durationMs,
            error: (error as Error).message,
          });
          attempts.push({
            provider,
            success: false,
            error: (error as Error).message,
            duration_ms: durationMs,
            key_ref: keyRef,
            ...(quotaExhausted ? { quota_exhausted: true } : {}),
          });
        }
      }
    }

    // A completed fallback remains usable even if its saved handles later
    // terminate without results, so never repeat it once the marker is set.
    if (options.resumeFallbackCompleted) {
      const pending = pendingJobs.length > 0;
      return {
        results: completedResumeResults,
        pendingJobs,
        provider:
          completedResumeProvider ??
          options.resumeFallbackProvider ??
          pendingJobs[0]?.provider ??
          options.resumePendingJobs?.[0]?.provider ??
          selectedProviders[0] ??
          "unknown",
        status: pending ? "pending" : "completed",
        ...(pending ? { fallbackCompleted: true } : {}),
        ...(options.resumeFallbackProvider
          ? { fallbackProvider: options.resumeFallbackProvider }
          : {}),
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        attempts,
        secretsUsed,
      };
    }

    // If the resumed provider completed and no handles remain, it supplied the
    // final result. Otherwise a fallback may still complete while handles wait.
    if (completedResumeProvider && pendingJobs.length === 0) {
      return {
        results: completedResumeResults,
        pendingJobs,
        provider: completedResumeProvider,
        status: "completed",
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        attempts,
        secretsUsed,
      };
    }

    // In random mode, an unfinished saved crawl does not unlock another
    // provider. Only a quota failure while polling that handle can do so.
    if (pendingJobs.length > 0 && quotaFallbackProviders !== undefined && !recoveringQuota) {
      return {
        results: [],
        pendingJobs,
        provider: pendingJobs[0]!.provider,
        status: "pending",
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        attempts,
        secretsUsed,
      };
    }

    const providers = selectedProviders.filter((provider) => !resumeProviders.has(provider));
    const quotaProviders = (quotaFallbackProviders ?? []).filter(
      (provider) => !resumeProviders.has(provider)
    );
    const fallbackPartialResults: CrawlResult[] = [...completedResumeResults];

    // Random mode unlocks the remaining pool only after quota exhaustion.
    for (const provider of [...providers, ...quotaProviders]) {
      const start = performance.now();
      let keyRef = "none";
      try {
        const adapter = createAdapter(provider);

        if (!adapter.crawl) {
          const error = "Adapter does not support crawl";
          const durationMs = Math.round(performance.now() - start);
          errors[provider] = error;
          this.usageLogger.write({
            timestamp: new Date().toISOString(),
            provider,
            capability: "crawl",
            key: keyRef,
            success: false,
            response_time_ms: durationMs,
            error,
          });
          attempts.push({
            provider,
            success: false,
            error,
            duration_ms: durationMs,
          });
          if (quotaFallbackProviders !== undefined && !recoveringQuota) break;
          continue;
        }

        // Get API key + safe logging reference (keyless providers return empty string)
        const keyResult = await this.keyPool.getNextKeyWithRefOrEmpty(provider);
        const apiKey = keyResult.value;
        keyRef = keyResult.ref;
        if (apiKey) secretsUsed.push(apiKey);
        const results = await adapter.crawl(url, apiKey, {
          limit: options.limit,
          depth: options.depth,
          providerOptions: this.config.providers[provider]?.options,
        });
        // Engine-boundary shape guard (issue #79, PR-C): fail loudly on a
        // malformed adapter normalization rather than caching/rendering it.
        assertNormalizedResult("crawl", provider, results);
        const durationMs = Math.round(performance.now() - start);
        const pendingResults = results.filter((result) => result.status === "pending");
        const pageResults = results.filter((result) => result.status !== "pending");
        if (pendingResults.length > 0) {
          fallbackPartialResults.push(...pageResults);
          const providerPendingJobs = pendingResults.map((result) => {
            if (!result.jobId) {
              throw new Error(`Provider ${provider} returned a pending crawl without a job ID`);
            }
            return {
              provider,
              jobId: result.jobId,
              url: result.url || url,
            };
          });
          pendingJobs.push(...providerPendingJobs);
          const pendingMessage = "Provider crawl is still pending";
          this.usageLogger.write({
            timestamp: new Date().toISOString(),
            provider,
            capability: "crawl",
            key: keyRef,
            success: false,
            pending: true,
            response_time_ms: durationMs,
            error: pendingMessage,
          });
          attempts.push({
            provider,
            success: false,
            pending: true,
            error: pendingMessage,
            duration_ms: durationMs,
            key_ref: keyRef,
            result_count: pageResults.length,
          });
          // An unfinished crawl does not unlock random-mode quota fallbacks.
          if (quotaFallbackProviders !== undefined && !recoveringQuota) break;
          continue;
        }

        this.usageLogger.write({
          timestamp: new Date().toISOString(),
          provider,
          capability: "crawl",
          key: keyRef,
          success: true,
          response_time_ms: durationMs,
        });
        attempts.push({
          provider,
          success: true,
          duration_ms: durationMs,
          key_ref: keyRef,
          result_count: pageResults.length,
        });
        return {
          results: [...fallbackPartialResults, ...pageResults],
          pendingJobs: [...pendingJobs, ...resumePendingJobs],
          provider,
          status: pendingJobs.length + resumePendingJobs.length > 0 ? "pending" : "completed",
          ...(
            pendingJobs.length + resumePendingJobs.length > 0
              ? { fallbackCompleted: true }
              : {}
          ),
          ...(pendingJobs.length + resumePendingJobs.length > 0
            ? { fallbackProvider: provider }
            : {}),
          errors: Object.keys(errors).length > 0 ? errors : undefined,
          attempts,
          secretsUsed,
        };
      } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const quotaExhausted = isQuotaExhausted(error);
        recoveringQuota ||= quotaExhausted;
        errors[provider] = (error as Error).message;
        // Firecrawl wraps non-transient polling HTTP errors to add job context.
        // Keep the original response status for the final operator-facing category.
        const httpError = findHttpRequestError(error);
        if (httpError) providerHttpErrors[provider] = httpError;
        this.usageLogger.write({
          timestamp: new Date().toISOString(),
          provider,
          capability: "crawl",
          key: keyRef,
          success: false,
          response_time_ms: durationMs,
          error: (error as Error).message,
          ...(quotaExhausted ? { quota_exhausted: true } : {}),
        });
        attempts.push({
          provider,
          success: false,
          error: (error as Error).message,
          duration_ms: durationMs,
          key_ref: keyRef,
          ...(quotaExhausted ? { quota_exhausted: true } : {}),
        });
        if (quotaFallbackProviders !== undefined && !recoveringQuota) break;
      }
    }

    const remainingPendingJobs = [...pendingJobs, ...resumePendingJobs];
    if (remainingPendingJobs.length > 0) {
      return {
        results: fallbackPartialResults,
        pendingJobs: remainingPendingJobs,
        provider: remainingPendingJobs[0]!.provider,
        status: "pending",
        ...(options.resumeFallbackCompleted
          ? {
              fallbackCompleted: true,
              ...(options.resumeFallbackProvider
                ? { fallbackProvider: options.resumeFallbackProvider }
                : {}),
            }
          : {}),
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        attempts,
        secretsUsed,
      };
    }

    throw new AllProvidersFailedError(
      errors,
      attempts,
      secretsUsed,
      providerHttpErrors,
      terminalResumeJobs,
      discardedResumeJobs
    );
  }

  /**
   * Search a single provider.
   */
  private async searchProvider(
    provider: string,
    query: string,
    limit?: number
  ): Promise<ProviderResult> {
    const start = performance.now();
    let keyRef = "none";
    let resolvedSecret: string | undefined;
    try {
      const keyResult = await this.keyPool.getNextKeyWithRefOrEmpty(provider);
      const apiKey = keyResult.value;
      keyRef = keyResult.ref;
      if (apiKey) resolvedSecret = apiKey;
      const adapter = createAdapter(provider);
      const results = await adapter.search(query, apiKey, {
        ...(limit !== undefined ? { limit } : {}),
        providerOptions: this.config.providers[provider]?.options,
      });
      // Engine-boundary shape guard (issue #79, PR-C): a malformed adapter
      // normalization throws here (classified as a provider error) instead of
      // propagating garbage into rerank/history.
      assertNormalizedResult("search", provider, results);

      const durationMs = Math.round(performance.now() - start);
      this.usageLogger.write({
        timestamp: new Date().toISOString(),
        provider,
        capability: "search",
        key: keyRef,
        success: true,
        response_time_ms: durationMs,
      });

      return {
        provider,
        results,
        durationMs,
        keyRef,
        ...(resolvedSecret ? { secret: resolvedSecret } : {}),
      };
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const quotaExhausted = isQuotaExhausted(error);
      this.usageLogger.write({
        timestamp: new Date().toISOString(),
        provider,
        capability: "search",
        key: keyRef,
        success: false,
        response_time_ms: durationMs,
        error: (error as Error).message,
        ...(quotaExhausted ? { quota_exhausted: true } : {}),
      });
      return {
        provider,
        results: [],
        error: (error as Error).message,
        ...(error instanceof HTTPRequestError ? { httpError: error } : {}),
        quotaExhausted,
        durationMs,
        keyRef,
        // The secret may have resolved before the call failed; the error
        // string can echo it, so keep it available for history redaction.
        ...(resolvedSecret ? { secret: resolvedSecret } : {}),
      };
    }
  }
}

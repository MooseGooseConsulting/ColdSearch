import { createAdapter } from "../adapters/index.js";
import { KeyPoolManager, createKeyPoolManager } from "./keypool.js";
import { rerank, type RerankerOptions } from "./reranker.js";
import { resolveCapabilityProviders } from "../providers.js";
import { UsageLogger } from "../logging/usage.js";
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
}

/**
 * Result from a single provider.
 */
interface ProviderResult {
  provider: string;
  results: NormalizedResult[];
  error?: string;
  durationMs: number;
  keyRef: string;
  /** Resolved credential value used for this call, when any. */
  secret?: string;
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

  constructor(
    errors: Record<string, string>,
    attempts: FanoutAttempt[],
    secretsUsed: string[]
  ) {
    super(`All providers failed: ${JSON.stringify(errors)}`);
    this.name = "AllProvidersFailedError";
    this.providerErrors = errors;
    this.attempts = attempts;
    this.secretsUsed = secretsUsed;
    // In-memory redaction context only: keep resolved credentials off the
    // serialized surface. JSON.stringify on a caught error picks up
    // enumerable own properties, so an enumerable secretsUsed would leak
    // every resolved key to any wrapper/structured logger that serializes it.
    Object.defineProperty(this, "secretsUsed", { enumerable: false });
  }
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
  ): string[] {
    const { providers } = resolveCapabilityProviders(
      this.config,
      capability,
      { providers: options.providers, singleProvider: options.singleProvider }
    );
    return providers;
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
    const providers = this.getProvidersForCapability("search", options);

    // Execute searches in parallel
    const results = await Promise.allSettled(
      providers.map((provider) => this.searchProvider(provider, query, options.limit))
    );

    // Collect results and errors
    const resultsByProvider = new Map<string, NormalizedResult[]>();
    const errors: Record<string, string> = {};
    const providersUsed: string[] = [];
    const attempts: FanoutAttempt[] = [];
    const secretsUsed: string[] = [];

    results.forEach((result, index) => {
      const provider = providers[index];

      if (result.status === "fulfilled") {
        const value = result.value;
        if (value.secret) secretsUsed.push(value.secret);
        if (value.error) {
          errors[provider] = value.error;
          attempts.push({
            provider,
            success: false,
            error: value.error,
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
        attempts.push({ provider, success: false, error: message });
      }
    });

    // If all providers failed, throw error
    if (providersUsed.length === 0) {
      throw new AllProvidersFailedError(errors, attempts, secretsUsed);
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
    const providers = this.getProvidersForCapability("extract", options);
    const errors: Record<string, string> = {};
    const attempts: FanoutAttempt[] = [];
    const secretsUsed: string[] = [];

    // Try providers in order (or single random provider)
    for (const provider of providers) {
      const start = performance.now();
      let keyRef = "none";
      try {
        const adapter = createAdapter(provider);

        if (!adapter.extract) {
          errors[provider] = "Adapter does not support extract";
          attempts.push({
            provider,
            success: false,
            error: errors[provider],
          });
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
        errors[provider] = (error as Error).message;
        this.usageLogger.write({
          timestamp: new Date().toISOString(),
          provider,
          capability: "extract",
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
        });
      }
    }

    throw new AllProvidersFailedError(errors, attempts, secretsUsed);
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
    errors?: Record<string, string>;
    attempts: FanoutAttempt[];
    secretsUsed: string[];
  }> {
    const providers = this.getProvidersForCapability("crawl", options);
    const errors: Record<string, string> = {};
    const attempts: FanoutAttempt[] = [];
    const secretsUsed: string[] = [];
    const resumePendingJobs = [...(options.resumePendingJobs ?? [])];
    const pendingJobs: PendingCrawlJob[] = [];

    // Try providers in order (or single random provider)
    for (const provider of providers) {
      const start = performance.now();
      let keyRef = "none";
      let resumeJob: PendingCrawlJob | undefined;
      try {
        const adapter = createAdapter(provider);

        if (!adapter.crawl) {
          errors[provider] = "Adapter does not support crawl";
          attempts.push({
            provider,
            success: false,
            error: errors[provider],
          });
          continue;
        }

        const resumeJobIndex = resumePendingJobs.findIndex(
          (job) => job.provider === provider && job.url === url.trim()
        );
        if (resumeJobIndex >= 0) resumeJob = resumePendingJobs.splice(resumeJobIndex, 1)[0];

        // Get API key + safe logging reference (keyless providers return empty string)
        const keyResult = await this.keyPool.getNextKeyWithRefOrEmpty(provider);
        const apiKey = keyResult.value;
        keyRef = keyResult.ref;
        if (apiKey) secretsUsed.push(apiKey);
        const results = await adapter.crawl(url, apiKey, {
          limit: options.limit,
          depth: options.depth,
          providerOptions: this.config.providers[provider]?.options,
          ...(resumeJob ? { resumeJobId: resumeJob.jobId } : {}),
        });

        const durationMs = Math.round(performance.now() - start);
        const pendingResults = results.filter((result) => result.status === "pending");
        const pageResults = results.filter((result) => result.status !== "pending");
        if (pendingResults.length > 0) {
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
          // A pending async job is not a completed crawl. Try the next
          // configured provider so it can produce usable results now.
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
          results: pageResults,
          pendingJobs: [...pendingJobs, ...resumePendingJobs],
          provider,
          status: pendingJobs.length + resumePendingJobs.length > 0 ? "pending" : "completed",
          errors: Object.keys(errors).length > 0 ? errors : undefined,
          attempts,
          secretsUsed,
        };
      } catch (error) {
        // A failed poll does not prove that an accepted async job stopped.
        if (resumeJob) pendingJobs.push(resumeJob);
        const durationMs = Math.round(performance.now() - start);
        errors[provider] = (error as Error).message;
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
        });
      }
    }

    const remainingPendingJobs = [...pendingJobs, ...resumePendingJobs];
    if (remainingPendingJobs.length > 0) {
      return {
        results: [],
        pendingJobs: remainingPendingJobs,
        provider: remainingPendingJobs[0]!.provider,
        status: "pending",
        errors: Object.keys(errors).length > 0 ? errors : undefined,
        attempts,
        secretsUsed,
      };
    }

    throw new AllProvidersFailedError(errors, attempts, secretsUsed);
  }

  /**
   * Search a single provider.
   */
  private async searchProvider(
    provider: string,
    query: string,
    limit: number
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
        providerOptions: this.config.providers[provider]?.options,
        limit,
      });

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
      this.usageLogger.write({
        timestamp: new Date().toISOString(),
        provider,
        capability: "search",
        key: keyRef,
        success: false,
        response_time_ms: durationMs,
        error: (error as Error).message,
      });
      return {
        provider,
        results: [],
        error: (error as Error).message,
        durationMs,
        keyRef,
        // The secret may have resolved before the call failed; the error
        // string can echo it, so keep it available for history redaction.
        ...(resolvedSecret ? { secret: resolvedSecret } : {}),
      };
    }
  }
}

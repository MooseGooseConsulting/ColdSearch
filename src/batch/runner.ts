import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { LocalExecutionBackend } from "../execution/backend.js";
import { KeyPoolManager } from "../engine/keypool.js";
import type { FanoutOptions } from "../engine/fanout.js";
import { redactSensitive } from "../history/redact.js";
import { executeToolCall } from "../tools/substrate.js";
import type { CapabilityName, Config, CrawlResult, PendingCrawlJob } from "../types.js";
import { appendBatchOutput, readBatchInput } from "./jsonl.js";
import {
  buildBatchPlan,
  crawlUrlFingerprint,
  loadResumeIndex,
  type BatchPlanEntry,
} from "./resume.js";
import { DEFAULT_BATCH_LIMIT, type BatchInputRecord, type BatchOutputRecord } from "./types.js";

/** Executes one validated batch input record into an output record. */
export interface BatchExecutor {
  execute(
    record: BatchInputRecord,
    config: Config,
    resumePendingJobs?: PendingCrawlJob[],
    resumeCompletedResults?: CrawlResult[],
    resumeFallbackCompleted?: boolean
  ): Promise<BatchOutputRecord>;
}

export interface BatchRunOptions {
  /** Input JSONL path. */
  input: string;
  /** Output JSONL path (append-only; resumed from existing content). */
  output: string;
  /** Maximum number of items executing at once. */
  concurrency: number;
  /** Retry records that errored in a prior run. */
  retryErrors: boolean;
  /** Config file path, threaded to the backend / tool substrate. */
  configPath?: string;
  /** Report the planned records without any provider calls or writes. */
  dryRun?: boolean;
  /** Test seam: replaces the default LocalExecutionBackend executor. */
  executor?: BatchExecutor;
}

/** JSON-safe projection of one plan entry for dry-run reporting. */
export interface BatchPlanReportEntry {
  id: string;
  capability?: CapabilityName;
  tool?: string;
  action: "execute" | "skip" | "conflict";
  reason?: string;
}

export interface BatchRunSummary {
  dry_run: boolean;
  input: string;
  output: string;
  concurrency: number;
  retry_errors: boolean;
  total: number;
  /** Plan entries with action "execute". */
  to_execute: number;
  /** Plan entries with action "skip" (resume or duplicate skips). */
  skipped: number;
  /** Plan entries with action "conflict" (duplicate/conflict error records). */
  conflicts: number;
  /** Real runs only. */
  executed?: number;
  succeeded?: number;
  pending?: number;
  failed?: number;
  /** Dry runs only: the planned records. */
  records?: BatchPlanReportEntry[];
}

/**
 * Dependency-free promise pool: run `fn` over `items` with at most
 * `concurrency` in-flight at once. Side effects inside `fn` (e.g. appends)
 * happen in completion order, not input order.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.floor(concurrency));
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/** Default executor: same backend/tool substrate as the standalone commands. */
export class LocalBatchExecutor implements BatchExecutor {
  private readonly backend: LocalExecutionBackend;

  constructor(configPath?: string) {
    this.backend = new LocalExecutionBackend(configPath);
  }

  async execute(
    record: BatchInputRecord,
    config: Config,
    resumePendingJobs?: PendingCrawlJob[],
    resumeCompletedResults?: CrawlResult[],
    resumeFallbackCompleted?: boolean
  ): Promise<BatchOutputRecord> {
    const base = {
      id: record.id,
      ...(record.capability ? { capability: record.capability } : {}),
      ...(record.tool ? { tool: record.tool } : {}),
    };
    try {
      if (record.capability === "search") {
        const result = await this.backend.search(record.query!, {
          ...this.fanoutOptions(record),
          rerankStrategy: "rrf",
        });
        this.warn(result.warnings);
        return {
          ...base,
          status: "success",
          result: {
            results: result.results,
            providers_used: result.providersUsed,
            ...(Object.keys(result.errors).length > 0 ? { errors: result.errors } : {}),
          },
          error: null,
        };
      }
      if (record.capability === "extract") {
        const result = await this.backend.extract(record.url!, this.fanoutOptions(record));
        this.warn(result.warnings);
        return {
          ...base,
          status: "success",
          result: {
            result: result.result,
            provider: result.provider,
            ...(result.errors && Object.keys(result.errors).length > 0
              ? { errors: result.errors }
              : {}),
          },
          error: null,
        };
      }
      if (record.capability === "crawl") {
        const result = await this.backend.crawl(record.url!, {
          ...this.fanoutOptions(record),
          resumePendingJobs,
          resumeFallbackCompleted,
        });
        this.warn(result.warnings);
        return {
          ...base,
          status: result.status === "pending" ? "pending" : "success",
          result: {
            results: result.results,
            pendingJobs: result.pendingJobs,
            provider: result.provider,
            status: result.status,
            ...(result.fallbackCompleted ? { fallbackCompleted: true } : {}),
            ...(result.errors && Object.keys(result.errors).length > 0
              ? { errors: result.errors }
              : {}),
          },
          error: null,
        };
      }
      // Provider-tool record.
      const [provider, tool] = record.tool!.split(".");
      const result = await executeToolCall(provider, tool, record.input ?? {}, config, {
        noCache: record.noCache,
      });
      // Warning parity with the standalone `tool call` command: surface every
      // substrate warning (failed history writes, ignored --freshness, ...).
      this.warn(result.meta.warnings);
      if (result.ok) {
        return { ...base, status: "success", result, error: null };
      }
      return {
        ...base,
        status: "error",
        result: null,
        error: {
          ...(result.error?.code ? { code: result.error.code } : {}),
          message: result.error?.message ?? "Tool call failed",
        },
      };
    } catch (error) {
      // The backend throws when every provider for a capability fails; a
      // failed item becomes an error record and never aborts sibling items.
      return {
        ...base,
        status: "error",
        result: null,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private fanoutOptions(record: BatchInputRecord): FanoutOptions {
    return {
      limit: record.limit ?? DEFAULT_BATCH_LIMIT,
      format: record.format,
      depth: record.depth,
      limitSet: record.limit !== undefined,
      providers: record.providers,
      singleProvider: record.singleProvider,
      noCache: record.noCache,
    };
  }

  private warn(warnings: string[] | undefined): void {
    for (const warning of warnings ?? []) {
      console.error(`Warning: ${warning}`);
    }
  }
}

/**
 * Accumulates resolved credential values for output redaction. Re-resolving on
 * every append closes the timing gap where a transient resolution failure at
 * startup is followed by a successful resolution mid-run: successes accumulate
 * and failures are retried on each append. The single KeyPoolManager instance
 * is kept for the whole run, so Doppler lookups stay cached (TTL-bounded) and
 * env:/literal refs are direct reads — per-append re-resolution is cheap.
 */
class SecretAccumulator {
  private readonly keyPool = new KeyPoolManager();
  private readonly resolved = new Set<string>();

  constructor(config: Config) {
    for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
      if (providerConfig?.keyPool) this.keyPool.register(provider, providerConfig.keyPool);
    }
  }

  /** Re-resolve configured secrets, merge newly resolved values, return the accumulated set. */
  async knownSecrets(): Promise<string[]> {
    for (const secret of await this.keyPool.resolveAllSecrets()) {
      this.resolved.add(secret);
    }
    return [...this.resolved];
  }
}

/**
 * Lexically resolve `p`, then realpath its nearest existing ancestor so
 * symlinked parents (and the file itself, when it exists) canonicalize. Same
 * approach as scripts/provider-pass-through.mjs.
 */
function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  let existing = resolved;
  const trailing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    // No existing ancestor at all (e.g. a non-existent Windows drive root):
    // realpathSync would throw, so fall back to the lexical path.
    if (parent === existing) return resolved;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...trailing);
}

function batchAliasError(input: string, output: string): Error {
  return new Error(
    `Batch input and output resolve to the same file (${input}). ` +
      `Use a distinct --output path so results are not appended to the input.`
  );
}

/**
 * Refuse to run when --input and --output alias the same file: appended
 * results would corrupt the input. The canonical comparison catches lexical
 * and symlink aliasing; when both files exist, an inode comparison catches
 * hardlinks (which realpath does not collapse).
 */
function assertDistinctBatchPaths(input: string, output: string): void {
  if (canonicalizePath(input) === canonicalizePath(output)) {
    throw batchAliasError(input, output);
  }
  let inputStat: fs.Stats;
  let outputStat: fs.Stats;
  try {
    inputStat = fs.statSync(input);
    outputStat = fs.statSync(output);
  } catch (error) {
    // One of them does not exist yet; the canonical comparison above already
    // covered every existing path segment.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) {
    throw batchAliasError(input, output);
  }
}

/**
 * Run one batch: read + validate input, plan against the output file's prior
 * outcomes, then execute with bounded concurrency, appending each record to
 * the output JSONL as it completes. Conflicts are deterministic from the input
 * alone and appended before execution starts. No item failure aborts the run.
 */
export async function runBatch(options: BatchRunOptions): Promise<BatchRunSummary> {
  assertDistinctBatchPaths(options.input, options.output);

  const records = await readBatchInput(options.input);
  const resumeIndex = await loadResumeIndex(options.output);
  const plan = buildBatchPlan(records, resumeIndex, { retryErrors: options.retryErrors });
  const dryRun = options.dryRun === true;

  const report = (entry: BatchPlanEntry): BatchPlanReportEntry => ({
    id: entry.record.id,
    ...(entry.record.capability ? { capability: entry.record.capability } : {}),
    ...(entry.record.tool ? { tool: entry.record.tool } : {}),
    action: entry.action,
    ...(entry.reason ? { reason: entry.reason } : {}),
  });

  const summary: BatchRunSummary = {
    dry_run: dryRun,
    input: options.input,
    output: options.output,
    concurrency: options.concurrency,
    retry_errors: options.retryErrors,
    total: plan.length,
    to_execute: plan.filter((e) => e.action === "execute").length,
    skipped: plan.filter((e) => e.action === "skip").length,
    conflicts: plan.filter((e) => e.action === "conflict").length,
  };

  if (dryRun) {
    summary.records = plan.map(report);
    return summary;
  }

  // Nothing will be appended — a fully-resumed run (or an empty plan) needs
  // no config, no preflight, and no provider calls, and must succeed even
  // without a valid config file.
  if (!plan.some((e) => e.action === "execute" || e.action === "conflict")) {
    summary.executed = 0;
    summary.succeeded = 0;
    summary.failed = 0;
    return summary;
  }

  const config = loadConfig(options.configPath);

  // Output preflight: verify the output path is appendable before any provider
  // call burns budget. Creates the file when missing; throws on unwritable
  // paths so the whole run fails fast instead of mid-batch.
  try {
    await fs.promises.appendFile(options.output, "");
  } catch (error) {
    throw new Error(
      `Cannot write batch output file ${options.output}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const secrets = new SecretAccumulator(config);
  const executor = options.executor ?? new LocalBatchExecutor(options.configPath);

  // Serialized append queue: fs.appendFile may split a large payload across
  // multiple write() calls, so concurrent workers' appends must never
  // interleave. Each append re-resolves secrets and redacts with the
  // accumulated set (see SecretAccumulator).
  let appendQueue: Promise<void> = Promise.resolve();
  const persist = (record: BatchOutputRecord): Promise<void> => {
    const enqueued = appendQueue.then(async () => {
      const known = await secrets.knownSecrets();
      const redactedRecord = redactSensitive(record, known);
      await appendBatchOutput(options.output, dedupeRedactedCrawlResults(redactedRecord));
    });
    appendQueue = enqueued;
    return enqueued;
  };

  // Conflict records are determined by the input alone: append them before
  // execution starts, in plan order. Redacted like every other output record.
  for (const entry of plan) {
    if (entry.action === "conflict" && entry.conflict) {
      await persist(entry.conflict);
    }
  }

  let executed = 0;
  let succeeded = 0;
  let pending = 0;
  let failed = 0;
  await runWithConcurrency(
    plan.filter((e) => e.action === "execute"),
    options.concurrency,
    async (entry) => {
      const executedRecord = await safeExecute(
        executor,
        entry.record,
        config,
        entry.resumePendingJobs,
        entry.resumeCompletedResults,
        entry.resumeFallbackCompleted
      );
      const outputRecord = mergeResumedCrawlResults(
        entry.record,
        executedRecord,
        entry.resumeCompletedResults
      );
      await persist(outputRecord);
      executed += 1;
      if (outputRecord.status === "success") succeeded += 1;
      else if (outputRecord.status === "pending") pending += 1;
      else failed += 1;
    }
  );

  summary.executed = executed;
  summary.succeeded = succeeded;
  summary.pending = pending;
  summary.failed = failed;
  return summary;
}

/** Keep pages already returned by an earlier pending crawl in every later outcome. */
function mergeResumedCrawlResults(
  record: BatchInputRecord,
  outputRecord: BatchOutputRecord,
  priorResults?: CrawlResult[]
): BatchOutputRecord {
  if (
    record.capability !== "crawl" ||
    outputRecord.result === null ||
    typeof outputRecord.result !== "object" ||
    Array.isArray(outputRecord.result)
  ) {
    return outputRecord;
  }

  const result = outputRecord.result as Record<string, unknown>;
  const currentResults = Array.isArray(result.results) ? result.results : [];
  let updatedResult: Record<string, unknown> = result;
  if (priorResults?.length) {
    // Keep the current resume's pages first, followed by prior fallback pages.
    // Exact deduplication happens after redaction in persist, so a raw page and
    // its previously redacted copy compare in the same representation.
    updatedResult = { ...updatedResult, results: [...currentResults, ...priorResults] };
  }

  if (outputRecord.status === "pending" && typeof record.url === "string" && record.url.trim()) {
    updatedResult = {
      ...updatedResult,
      requestedUrlFingerprint: crawlUrlFingerprint(record.url),
    };
  }

  if (updatedResult === result) return outputRecord;
  return {
    ...outputRecord,
    result: updatedResult,
  };
}

/** Remove exact duplicate crawl pages after redaction, matching persisted data. */
function dedupeRedactedCrawlResults(record: BatchOutputRecord): BatchOutputRecord {
  if (
    record.capability !== "crawl" ||
    record.result === null ||
    typeof record.result !== "object" ||
    Array.isArray(record.result)
  ) {
    return record;
  }

  const result = record.result as Record<string, unknown>;
  if (!Array.isArray(result.results)) return record;

  const seen = new Set<string>();
  const dedupedResults: unknown[] = [];
  for (const page of result.results) {
    const signature = stableResultSerialization(page);
    if (seen.has(signature)) continue;
    seen.add(signature);
    dedupedResults.push(page);
  }
  if (dedupedResults.length === result.results.length) return record;

  return {
    ...record,
    result: { ...result, results: dedupedResults },
  };
}

/** Stable JSON key used only to remove exact redacted crawl result objects. */
function stableResultSerialization(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableResultSerialization).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableResultSerialization(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Belt-and-braces: an unexpected executor throw becomes an error record. */
async function safeExecute(
  executor: BatchExecutor,
  record: BatchInputRecord,
  config: Config,
  resumePendingJobs?: PendingCrawlJob[],
  resumeCompletedResults?: CrawlResult[],
  resumeFallbackCompleted?: boolean
): Promise<BatchOutputRecord> {
  try {
    return await executor.execute(
      record,
      config,
      resumePendingJobs,
      resumeCompletedResults,
      resumeFallbackCompleted
    );
  } catch (error) {
    return {
      id: record.id,
      ...(record.capability ? { capability: record.capability } : {}),
      ...(record.tool ? { tool: record.tool } : {}),
      status: "error",
      result: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

import type { CapabilityName, CrawlResult, PendingCrawlJob } from "../types.js";

/**
 * One batch input record (one JSON object per line of the input JSONL).
 *
 * Exactly one of `capability` | `tool` must be set; `id` is the stable,
 * non-empty identity used as the resume key and duplicate key. Optional
 * execution knobs mirror the standalone CLI flags so a batch item behaves
 * identically to the equivalent capability invocation.
 */
export interface BatchInputRecord {
  /** Stable, non-empty identity; the resume key and duplicate key. */
  id: string;
  /** Normalized capability (`search` | `extract` | `crawl`). */
  capability?: CapabilityName;
  /** Provider-tool id (`<provider>.<tool>`) exposed by `coldsearch tool list`. */
  tool?: string;
  /** `search` input. */
  query?: string;
  /** `extract` / `crawl` input. */
  url?: string;
  /** Provider-tool params. */
  input?: Record<string, any>;
  /** Maximum results (default: 10, matching the CLI). */
  limit?: number;
  /** Extract output format. */
  format?: "markdown" | "text";
  /** Crawl link depth. */
  depth?: number;
  /** Provider scope for capability records. */
  providers?: string[];
  /** Force single-provider mode for capability records. */
  singleProvider?: boolean;
  /** Bypass the read-through replay cache for this record. */
  noCache?: boolean;
}

/** Per-record error detail in a batch output record. */
export interface BatchError {
  /** Stable machine code; `DUPLICATE_ID_CONFLICT` marks non-retriable conflicts. */
  code?: string;
  message: string;
}

/** Crawl state retained when an error interrupts a resumed batch item. */
export interface BatchResumeState {
  pendingJobs?: PendingCrawlJob[];
  completedResults?: CrawlResult[];
  fallbackCompleted?: boolean;
  requestedUrlFingerprint?: string;
}

/**
 * One batch output record (one JSON object per line of the output JSONL).
 *
 * - `status: "success"` records have `result` set and `error: null`.
 * - `status: "pending"` records preserve an async job but are not resumable successes.
 * - `status: "error"` records have `result: null` and a non-null `error`.
 * - Duplicate/conflict records carry `error.code === DUPLICATE_ID_CONFLICT`
 *   and are never retried by `--retry-errors`.
 */
export interface BatchOutputRecord {
  id: string;
  capability?: CapabilityName;
  tool?: string;
  status: "success" | "pending" | "error";
  /** Execution result; `null` on error. */
  result: unknown;
  /** `null` on success; `{ message }` (or conflict details) on error. */
  error: BatchError | null;
  /** Resume data retained on errors that interrupt an existing crawl. */
  resumeState?: BatchResumeState;
}

/**
 * Stable code for duplicate/conflict records: a repeated `id` with different
 * input is emitted as a visible error record and is never retried, keeping
 * reruns deterministic.
 */
export const DUPLICATE_ID_CONFLICT = "DUPLICATE_ID_CONFLICT";

/** True for duplicate/conflict error records, which `--retry-errors` never retries. */
export function isConflictError(error: BatchError | null): boolean {
  return error?.code === DUPLICATE_ID_CONFLICT;
}

/** Default `limit` applied when a batch record omits it (mirrors the CLI default). */
export const DEFAULT_BATCH_LIMIT = 10;

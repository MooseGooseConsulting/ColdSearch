import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  DUPLICATE_ID_CONFLICT,
  isConflictError,
  type BatchError,
  type BatchInputRecord,
  type BatchOutputRecord,
} from "./types.js";
import type { CrawlResult, PendingCrawlJob } from "../types.js";

/** Compact per-id resume outcome; pending crawls retain handles and prior pages. */
export interface ResumeOutcome {
  status: "success" | "pending" | "error";
  /** True for duplicate/conflict error records, which --retry-errors never retries. */
  conflict: boolean;
  pendingJobs?: PendingCrawlJob[];
  /** Completed pages already returned alongside pending crawl handles. */
  completedResults?: CrawlResult[];
  /** Hash of the original trimmed crawl URL, when available. */
  requestedUrlFingerprint?: string;
}

/** Persist a stable URL fingerprint without storing the URL itself. */
export function crawlUrlFingerprint(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex");
}

/** Maps batch `id` -> compact outcomes already present in the output file. */
export type ResumeIndex = Map<string, ResumeOutcome[]>;

/** Per-record run actions in batch plan order. */
export type BatchPlanAction = "execute" | "skip" | "conflict";

export interface BatchPlanEntry {
  record: BatchInputRecord;
  action: BatchPlanAction;
  /** Existing async jobs to poll instead of starting duplicate work. */
  resumePendingJobs?: PendingCrawlJob[];
  /** Completed pages from the previous pending record, retained in later output. */
  resumeCompletedResults?: CrawlResult[];
  /** For `skip`: stable machine reason. */
  reason?: "resume-success" | "resume-error" | "resume-conflict" | "duplicate-identical";
  /** For `conflict`: the output record to append (never executed, never retried). */
  conflict?: BatchOutputRecord;
}

/**
 * Load the resume index from an existing output file. Malformed, partial, or
 * contract-invalid lines (an interrupted run's last write, foreign data) are
 * ignored — they carry no resumable outcome. A missing file yields an empty
 * index. Pending crawl outcomes retain their job handles and completed pages
 * so those pages survive subsequent resume records.
 */
export async function loadResumeIndex(outputPath: string): Promise<ResumeIndex> {
  const index: ResumeIndex = new Map();
  let content: string;
  try {
    content = await fs.promises.readFile(outputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return index;
    throw new Error(
      `Cannot read batch output file ${outputPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial line from an interrupted write; nothing to resume
    }
    const outcome = toResumeOutcome(parsed);
    if (!outcome) continue;
    const outcomes = index.get(outcome.id) ?? [];
    outcomes.push(outcome);
    index.set(outcome.id, outcomes);
  }
  return index;
}

/**
 * Validate one parsed output line against the batch output contract and reduce
 * it to the compact resume outcome. A success must have `error: null` and a
 * present, non-null `result`; an error must have `result: null` and an `error`
 * object with a string `message`. Pending records are valid non-successes and
 * retain their job handles and any completed pages for the next resume.
 */
function toResumeOutcome(
  raw: unknown
): {
  id: string;
  status: "success" | "pending" | "error";
  conflict: boolean;
  pendingJobs?: PendingCrawlJob[];
  completedResults?: CrawlResult[];
  requestedUrlFingerprint?: string;
} | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return null;

  if (record.status === "success") {
    if (record.error !== null) return null;
    if (record.result === undefined || record.result === null) return null;
    return { id: record.id, status: "success", conflict: false };
  }

  if (record.status === "pending") {
    if (record.error !== null) return null;
    const result = record.result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
    const resultRecord = result as Record<string, unknown>;
    const rawJobs = resultRecord.pendingJobs;
    const pendingJobs = Array.isArray(rawJobs)
      ? rawJobs.filter((job): job is PendingCrawlJob => {
          if (!job || typeof job !== "object" || Array.isArray(job)) return false;
          const candidate = job as Record<string, unknown>;
          return (
            typeof candidate.provider === "string" &&
            typeof candidate.jobId === "string" &&
            candidate.jobId.length > 0 &&
            typeof candidate.url === "string" &&
            candidate.url.length > 0
          );
        })
      : [];
    const rawResults = resultRecord.results;
    const completedResults = Array.isArray(rawResults)
      ? rawResults.filter((page): page is CrawlResult => {
          if (!page || typeof page !== "object" || Array.isArray(page)) return false;
          const candidate = page as Record<string, unknown>;
          return (
            typeof candidate.url === "string" &&
            typeof candidate.title === "string" &&
            typeof candidate.content === "string" &&
            (candidate.status === undefined || candidate.status === "completed")
          );
        })
      : [];
    const storedFingerprint = resultRecord.requestedUrlFingerprint;
    const requestedUrlFingerprint =
      typeof storedFingerprint === "string" && /^[a-f0-9]{64}$/i.test(storedFingerprint)
        ? storedFingerprint
        : (() => {
            const pendingUrls = [...new Set(pendingJobs.map((job) => job.url.trim()))];
            return pendingUrls.length === 1 ? crawlUrlFingerprint(pendingUrls[0]!) : undefined;
          })();
    return {
      id: record.id,
      status: "pending",
      conflict: false,
      pendingJobs,
      ...(completedResults.length > 0 ? { completedResults } : {}),
      ...(requestedUrlFingerprint ? { requestedUrlFingerprint } : {}),
    };
  }

  if (record.status === "error") {
    if (record.result !== null) return null;
    const error = record.error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
    if (typeof (error as Record<string, unknown>).message !== "string") return null;
    return { id: record.id, status: "error", conflict: isConflictError(error as BatchError) };
  }

  return null;
}

/** Key-order-stable serialization of a record (minus its `id`) for duplicate comparison. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical form of a record's input (id excluded) for duplicate detection. */
export function canonicalizeRecord(record: BatchInputRecord): string {
  const { id: _id, ...rest } = record;
  return stableSerialize(rest);
}

/** Output record marking a repeated `id` with different input. */
export function conflictRecord(record: BatchInputRecord): BatchOutputRecord {
  return {
    id: record.id,
    ...(record.capability ? { capability: record.capability } : {}),
    ...(record.tool ? { tool: record.tool } : {}),
    status: "error",
    result: null,
    error: {
      code: DUPLICATE_ID_CONFLICT,
      message: `Duplicate id '${record.id}' with different input; the first occurrence wins and this record was not executed.`,
    },
  };
}

export interface BuildPlanOptions {
  retryErrors: boolean;
}

/**
 * Build the deterministic execution plan for one batch run.
 *
 * Resume (from the output file, by stable `id`):
 * - Existing success records are skipped.
 * - Existing retriable error records are retried only with `retryErrors`.
 * - Existing duplicate/conflict records are never retried.
 *
 * Duplicate ids within the input are resolved by the FIRST occurrence:
 * - Later identical records are skipped without output.
 * - Later records with different input become visible conflict error records
 *   (never executed, never retried) so reruns stay deterministic.
 */
export function buildBatchPlan(
  records: BatchInputRecord[],
  resumeIndex: ResumeIndex,
  options: BuildPlanOptions
): BatchPlanEntry[] {
  const plan: BatchPlanEntry[] = [];
  const seen = new Map<string, string>(); // id -> canonical input of first occurrence

  for (const record of records) {
    const existing = resumeIndex.get(record.id) ?? [];
    const hasSuccess = existing.some((r) => r.status === "success");
    const hasRetriableError = existing.some((r) => r.status === "error" && !r.conflict);
    const hasConflict = existing.some((r) => r.status === "error" && r.conflict);
    const latest = existing[existing.length - 1];

    const firstInput = seen.get(record.id);
    if (firstInput === undefined) {
      // First occurrence: the primary record for this id.
      seen.set(record.id, canonicalizeRecord(record));
      if (hasSuccess) {
        plan.push({ record, action: "skip", reason: "resume-success" });
      } else if (
        hasRetriableError &&
        !options.retryErrors &&
        latest?.status !== "pending"
      ) {
        plan.push({ record, action: "skip", reason: "resume-error" });
      } else {
        // Execute, including when the id only has a conflict record so far
        // (the primary never produced its own outcome) and retriable-error
        // retries when --retry-errors is set.
        const requestedUrl = record.capability === "crawl" ? record.url?.trim() : undefined;
        const pendingRecordMatchesRequest =
          requestedUrl !== undefined &&
          latest?.status === "pending" &&
          latest.requestedUrlFingerprint === crawlUrlFingerprint(requestedUrl);
        let pendingJobsForRequest: PendingCrawlJob[] | undefined;
        if (requestedUrl !== undefined && latest?.status === "pending") {
          // The persisted job URL may have been redacted. The fingerprint
          // binds this record to the request, so rebind its jobs to the
          // current input URL before FanoutEngine validates them.
          pendingJobsForRequest = pendingRecordMatchesRequest
            ? latest.pendingJobs?.map((job) => ({ ...job, url: requestedUrl }))
            : latest.pendingJobs?.filter((job) => job.url.trim() === requestedUrl);
        }
        plan.push({
          record,
          action: "execute",
          ...(latest?.status === "pending"
            ? {
                ...(pendingJobsForRequest?.length
                  ? { resumePendingJobs: pendingJobsForRequest }
                  : {}),
                ...(pendingRecordMatchesRequest && latest.completedResults?.length
                  ? { resumeCompletedResults: latest.completedResults }
                  : {}),
              }
            : {}),
        });
      }
      continue;
    }

    // Later occurrence of an existing id: pure duplicate handling.
    if (canonicalizeRecord(record) === firstInput) {
      plan.push({ record, action: "skip", reason: "duplicate-identical" });
    } else if (hasConflict) {
      // A conflict for this id is already visible in the output; do not
      // re-emit it, keeping reruns append-once.
      plan.push({ record, action: "skip", reason: "resume-conflict" });
    } else {
      plan.push({ record, action: "conflict", conflict: conflictRecord(record) });
    }
  }

  return plan;
}

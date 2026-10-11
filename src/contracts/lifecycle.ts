/**
 * Lifecycle contract for provider async jobs (e.g. Firecrawl crawl).
 *
 * Firecrawl crawl jobs move pending → scraping → completed | failed, and the
 * API additionally reports "cancelled" for operator-cancelled jobs. The
 * adapter layer narrows to a subset today; this shared union is the contract
 * the adapter will be brought up to in a later PR (issue #79 stack).
 */
export type AsyncJobStatus = "pending" | "scraping" | "completed" | "failed" | "cancelled";

/**
 * Discriminated result of an async provider job:
 * - completed carries the job's data payload;
 * - failed/cancelled carry an error description;
 * - pending/scraping carry nothing (the job is still running — keep polling).
 */
export type AsyncJobResult<T> =
  | { status: "completed"; data: T }
  | { status: "failed" | "cancelled"; error: string }
  | { status: "pending" | "scraping" };

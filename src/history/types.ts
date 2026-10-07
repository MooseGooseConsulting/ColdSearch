import { randomBytes } from "node:crypto";
import type { NormalizedResult } from "../types.js";

/**
 * One top-level history execution is recorded per `coldsearch search`,
 * `extract`, `crawl`, or `tool call` invocation. A multi-provider fanout is a
 * single execution with provider attempts/partitions beneath it — never one
 * history item per provider leg.
 */
export type ExecutionCommand = "search" | "extract" | "crawl" | "tool";

/** `live`: providers were called. `cache`: exact replay, zero provider calls. */
export type ExecutionSource = "live" | "cache";

export type ExecutionOutcome = "success" | "partial" | "failed";

/**
 * One provider/tool attempt inside an execution. Carries only what the runtime
 * actually observed; the key is a safe reference, never a value.
 */
export interface ProviderAttempt {
  provider: string;
  tool?: string;
  success: boolean;
  error?: string;
  duration_ms?: number;
  key_ref?: string;
  result_count?: number;
}

/** Cache provenance explaining an exact replay. */
export interface CacheProvenance {
  created_at: string | null;
  age_seconds: number | null;
  ttl_seconds: number | null;
}

export interface ExecutionRouting {
  strategy?: string | null;
  requested_providers?: string[];
  providers_attempted?: string[];
  reranker?: string;
}

export interface ExecutionRecord {
  /** Stable execution ID, e.g. `exec-20260810T134615-a1b2c3d4`. */
  id: string;
  /** ISO 8601 timestamp of the invocation. */
  timestamp: string;
  command: ExecutionCommand;
  /**
   * Agent run ID this execution belongs to, when the invocation was triggered
   * by an agent run. Present only then; non-agent executions stay valid
   * without it. `run_id` never replaces `id` — every execution keeps its own
   * PR 2 execution ID.
   */
  run_id?: string;
  /**
   * Original query or URL (`provider.tool` for tool calls), already redacted
   * of signed-URL tokens and credential values before persistence.
   */
  input: string;
  /** Relevant request options/parameters, redacted before persistence. */
  options?: Record<string, unknown>;
  routing?: ExecutionRouting;
  source: ExecutionSource;
  /** Origin execution for an exact-cache replay, when known. */
  origin_execution_id?: string | null;
  /** Present for cache replays: age/freshness provenance of the replay. */
  cache?: CacheProvenance | null;
  attempts: ProviderAttempt[];
  /** Pre-merge per-provider normalized partitions (fanout search only). */
  partitions?: Record<string, NormalizedResult[]>;
  /** Final normalized/merged output returned to the caller, redacted. */
  result?: unknown;
  result_count?: number;
  /**
   * Raw provider detail, only where the execution path already preserves it
   * (provider-tool calls). Scrubbed of resolved credential values; when it
   * cannot be scrubbed safely this is null and `raw_available` is false.
   */
  raw?: unknown;
  raw_available: boolean;
  errors?: Record<string, string>;
  duration_ms: number;
  outcome: ExecutionOutcome;
}

/**
 * Generate a stable, roughly time-sortable execution ID.
 */
export function newExecutionId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `exec-${stamp}-${randomBytes(4).toString("hex")}`;
}

import type { ErrorCategory } from "./types.js";

export interface RequestPolicy {
  label?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  allowNonIdempotentRetries?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
/** Node filesystem error codes: operator-environment (config/local state) issues. */
const FS_ERROR_CODES = new Set(["EPERM", "ENOTDIR", "EACCES", "ENOENT"]);

export class HTTPRequestError extends Error {
  status?: number;
  body?: string;
  url: string;

  constructor(message: string, options: { url: string; status?: number; body?: string }) {
    super(message);
    this.name = "HTTPRequestError";
    this.url = options.url;
    this.status = options.status;
    this.body = options.body;
  }
}

/** Detect account exhaustion without publishing provider response bodies.
 * HTTP 402 is definitive; other statuses need an explicit quota/balance
 * message. A generic 429 rate limit is not evidence that credits ran out.
 */
export function isQuotaExhausted(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const detail = error as { status?: number; statusCode?: number; message?: unknown; body?: unknown; cause?: unknown };
  if (detail.status === 402 || detail.statusCode === 402) return true;
  const text = [detail.message, detail.body]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replace(/[_-]/g, " ");
  const account = "(?:credits?|quota|funds?|balance|budget|(?:usage|billing|spending) limit)";
  const depletion = "(?:insufficient|not enough|does not have enough|out of|no remaining|no available|exhausted|exceed(?:ed|s)?|depleted|used up|too low|reached)";
  const exhausted = new RegExp(`${depletion}.{0,60}${account}|${account}.{0,60}${depletion}`, "i");
  return /payment required/i.test(text) || exhausted.test(text) || isQuotaExhausted(detail.cause, depth + 1);
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError("Sleep aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError("Sleep aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldRetryStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function shouldRetryError(error: unknown, externalAborted: boolean): boolean {
  if (error instanceof HTTPRequestError) {
    return error.status !== undefined && shouldRetryStatus(error.status);
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return !externalAborted;
    }

    return error.name === "TypeError";
  }

  return false;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export async function fetchWithPolicy(
  input: string | URL,
  init: RequestInit = {},
  policy: RequestPolicy = {}
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = (init.method || "GET").toUpperCase();
  const canRetry = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"].includes(method) ||
    policy.allowNonIdempotentRetries === true;
  const retries = canRetry ? (policy.retries ?? DEFAULT_RETRIES) : 0;
  const retryDelayMs = policy.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const requestUrl = input.toString();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const externalSignal = init.signal ?? undefined;

    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeout);
        throw createAbortError(`Request aborted before start: ${requestUrl}`);
      }
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        return response;
      }

      if (attempt < retries && shouldRetryStatus(response.status)) {
        await response.body?.cancel();
        await sleep(retryDelayMs * (attempt + 1), externalSignal);
        continue;
      }

      const body = await safeReadText(response);
      throw new HTTPRequestError(
        `${policy.label || "Request"} failed with HTTP ${response.status}`,
        { url: requestUrl, status: response.status, body }
      );
    } catch (error) {
      lastError = error;
      const externalAborted = externalSignal?.aborted === true;

      if (attempt < retries && shouldRetryError(error, externalAborted)) {
        await sleep(retryDelayMs * (attempt + 1), externalSignal);
        continue;
      }

      if (error instanceof Error && error.name === "AbortError") {
        if (externalAborted) {
          throw createAbortError(`${policy.label || "Request"} was aborted by caller`);
        }

        throw new Error(`${policy.label || "Request"} timed out after ${timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${requestUrl}`);
}

export async function fetchJson<T>(
  input: string | URL,
  init: RequestInit = {},
  policy: RequestPolicy = {}
): Promise<T> {
  const response = await fetchWithPolicy(input, init, policy);

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(
      `${policy.label || "Request"} returned invalid JSON: ${(error as Error).message}`
    );
  }
}

export async function fetchText(
  input: string | URL,
  init: RequestInit = {},
  policy: RequestPolicy = {}
): Promise<string> {
  const response = await fetchWithPolicy(input, init, policy);
  return response.text();
}

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
}

/**
 * Classify an unknown error into one of the machine-readable categories used
 * by status/doctor output and user-facing CLI errors.
 *
 * Rule-based on error type and message text. The original message is always
 * preserved in full next to the category — classification never redacts or
 * replaces it. Pattern checks are ordered so specific pairings
 * (unsupported_capability / unsupported_tool) win over generic ones.
 */
export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (error instanceof HTTPRequestError) {
    // Authentication/authorization rejections are credential problems, not
    // transport problems.
    if (error.status === 401 || error.status === 403) {
      return { category: "credentials", message };
    }
    return { category: "network", message };
  }
  if (name === "AbortError") {
    return { category: "network", message };
  }
  if (name === "TypeError" && /fetch|network|dns|lookup/i.test(message)) {
    return { category: "network", message };
  }
  // fetchWithPolicy converts its internal abort into a plain Error whose
  // message carries the timeout — not an AbortError, so match the message.
  if (/timed out after \d+ms/i.test(message)) {
    return { category: "network", message };
  }
  if (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    FS_ERROR_CODES.has((error as NodeJS.ErrnoException).code as string)
  ) {
    // Missing/unreadable/unwritable files and bad paths are operator-local
    // (config/state) problems, not provider problems.
    return { category: "config", message };
  }

  // Specific pairings first: a capability the provider cannot back, and a tool
  // the provider/registry does not expose.
  if (/does not implement capability/i.test(message)) {
    return { category: "unsupported_capability", message };
  }
  if (
    /unknown provider tool|hard-excluded|unsupported tool/i.test(message)
  ) {
    return { category: "unsupported_tool", message };
  }

  if (/unknown provider/i.test(message)) {
    return { category: "provider", message };
  }
  if (
    /unknown option|unknown '.*' subcommand|invalid limit|invalid rerank|invalid freshness|requires a .* argument|is only valid with|no configuration found for capability|not configured|config file|legacy config found|failed to parse config|invalid llm provider|unknown llm provider|unsupported llm provider|no execution found with id|no providers configured for/i.test(
      message
    )
  ) {
    return { category: "config", message };
  }
  if (
    /environment variable .*not set|api[_-]?key|failed to resolve doppler|doppler cli not found|\bbws:/i.test(
      message
    )
  ) {
    return { category: "credentials", message };
  }

  // Default: provider — most unclassified runtime errors surface from provider
  // calls. The original message is always kept.
  return { category: "provider", message };
}

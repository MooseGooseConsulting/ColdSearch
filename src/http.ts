import type { ErrorCategory } from "./types.js";
import {
  captureEnabled,
  readCaptureResponsePrefix,
  recordCapture,
  reserveCaptureRecord,
  trackCaptureTask,
} from "./testing/capture.js";

export interface RequestPolicy {
  label?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  allowNonIdempotentRetries?: boolean;
  /**
   * Resolved secret values (API keys/tokens) for this call. Only consulted by
   * the opt-in capture harness (COLDSEARCH_CAPTURE_DIR) to redact secrets
   * from captured request/response values; never sent anywhere.
   */
  secrets?: string[];
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
/**
 * Upper bound for a server-supplied Retry-After hint. A provider asking for a
 * very long wait must not stall an interactive CLI invocation indefinitely —
 * beyond this cap we treat the hint as clamped, not authoritative.
 */
export const MAX_RETRY_AFTER_MS = 30_000;
/** Statuses whose Retry-After response header is honored before retrying. */
const RETRY_AFTER_STATUSES = new Set([429, 503]);
/** Node filesystem error codes: operator-environment (config/local state) issues. */
const FS_ERROR_CODES = new Set(["EPERM", "ENOTDIR", "EACCES", "ENOENT"]);

export class HTTPRequestError extends Error {
  status?: number;
  body?: string;
  url: string;
  /** RequestPolicy.label of the failed call (e.g. "SearXNG search"), when set. */
  label?: string;

  constructor(
    message: string,
    options: { url: string; status?: number; body?: string; label?: string }
  ) {
    super(message);
    this.name = "HTTPRequestError";
    this.url = options.url;
    this.status = options.status;
    this.body = options.body;
    this.label = options.label;
  }
}

/** Detect account exhaustion without publishing provider response bodies.
 * Only HTTP statuses classified as quota exhaustion (402, 432, and 433) count,
 * including when wrapped in a cause. A generic 429 or response-body message
 * does not trigger provider fallback.
 */
export function isQuotaExhausted(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const detail = error as { status?: number; statusCode?: number; cause?: unknown };
  const status = typeof detail.status === "number"
    ? detail.status
    : typeof detail.statusCode === "number"
      ? detail.statusCode
      : undefined;
  if (typeof status === "number" && classifyHttpStatus(status) === "quota") return true;
  return isQuotaExhausted(detail.cause, depth + 1);
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

/**
 * Parse a Retry-After header value into milliseconds. Supports both
 * delta-seconds and HTTP-date forms. Returns undefined when absent/invalid or
 * already in the past; clamps anything valid to MAX_RETRY_AFTER_MS.
 * Exported for tests.
 */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;

  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) {
    ms = Number(trimmed) * 1000;
  } else {
    const dateMs = Date.parse(trimmed);
    if (Number.isNaN(dateMs)) return undefined;
    ms = dateMs - Date.now();
  }

  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Add positive jitter to an authoritative hint without exceeding the wait cap. */
export function retryAfterDelayMs(hintedMs: number): number {
  return Math.min(
    MAX_RETRY_AFTER_MS,
    hintedMs + Math.round(Math.random() * hintedMs * 0.2)
  );
}

/**
 * Apply ±20% jitter to a backoff delay so parallel callers (and retrying
 * providers) do not synchronize their retry storms. Exported for tests.
 */
export function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
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

function retryableTransportErrorName(
  error: unknown
): "TypeError" | "AbortError" | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.name === "TypeError" || error.name === "AbortError"
    ? error.name
    : undefined;
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
  // Capture harness (issue #79 PR-E): one env check per call; zero further
  // overhead when COLDSEARCH_CAPTURE_DIR is unset.
  const captureOn = captureEnabled();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const attemptStart = captureOn ? Date.now() : 0;
    // Set once the attempt's outcome has been recorded, so the catch block
    // does not double-record the HTTPRequestError thrown below.
    let attemptCaptured = false;
    const recordAttempt = (outcome: {
      status?: number;
      responseHeaders?: Headers;
      responseBodyText?: string;
      error?: string;
      errorName?: "TypeError" | "AbortError";
    }, durationMs = Date.now() - attemptStart): void => {
      if (!captureOn || attemptCaptured) return;
      attemptCaptured = true;
      void recordCapture({
        label: policy.label,
        method,
        url: requestUrl,
        requestHeaders: init.headers,
        requestBody: init.body,
        durationMs,
        secrets: policy.secrets,
        ...outcome,
      });
    };
    const recordResponse = (response: Response, durationMs: number): void => {
      if (!captureOn || attemptCaptured) return;
      let captureResponse: Response;
      try {
        captureResponse = response.clone();
      } catch {
        recordAttempt(
          { status: response.status, responseHeaders: response.headers },
          durationMs
        );
        return;
      }
      attemptCaptured = true;
      const commitCapture = reserveCaptureRecord();
      trackCaptureTask(
        Promise.resolve()
          .then(() => readCaptureResponsePrefix(captureResponse, policy.secrets))
          .catch(() => undefined)
          .then((responseBodyText) =>
            commitCapture({
              label: policy.label,
              method,
              url: requestUrl,
              requestHeaders: init.headers,
              requestBody: init.body,
              durationMs,
              secrets: policy.secrets,
              status: response.status,
              responseHeaders: response.headers,
              responseBodyText,
            })
          )
      );
    };

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
        if (captureOn) {
          // Read a bounded clone asynchronously. The request timeout is only
          // for receiving the response headers; capture must not delay or
          // abort the caller while it consumes the original body.
          const captureDurationMs = Date.now() - attemptStart;
          recordResponse(response, captureDurationMs);
        }
        return response;
      }

      if (attempt < retries && shouldRetryStatus(response.status)) {
        // Record the complete transient exchange from a clone before the
        // original response is discarded for retry.
        recordResponse(response, Date.now() - attemptStart);
        const cancelResponseBody = response.body?.cancel();
        if (captureOn) {
          // A cloned response tees the body, so awaiting cancellation of the
          // original can wait for the asynchronous capture reader to finish.
          void cancelResponseBody?.catch(() => undefined);
        } else {
          await cancelResponseBody;
        }
        // Honor the server's Retry-After hint on 429/503 (capped); otherwise
        // fall back to linear backoff. Jitter spreads retries of parallel
        // callers sharing the same rate limiter.
        const hinted =
          RETRY_AFTER_STATUSES.has(response.status)
            ? retryAfterMs(response.headers)
            : undefined;
        const delay =
          hinted !== undefined
            ? retryAfterDelayMs(hinted)
            : withJitter(retryDelayMs * (attempt + 1));
        await sleep(delay, externalSignal);
        continue;
      }

      const body = await safeReadText(response);
      recordAttempt({
        status: response.status,
        responseHeaders: response.headers,
        responseBodyText: body,
      });
      throw new HTTPRequestError(
        `${policy.label || "Request"} failed with HTTP ${response.status}`,
        { url: requestUrl, status: response.status, body, label: policy.label }
      );
    } catch (error) {
      lastError = error;
      const externalAborted = externalSignal?.aborted === true;

      if (attempt < retries && shouldRetryError(error, externalAborted)) {
        recordAttempt({
          error: error instanceof Error ? error.message : String(error),
          errorName: retryableTransportErrorName(error),
        });
        await sleep(withJitter(retryDelayMs * (attempt + 1)), externalSignal);
        continue;
      }

      if (error instanceof Error && error.name === "AbortError") {
        if (externalAborted) {
          const aborted = createAbortError(`${policy.label || "Request"} was aborted by caller`);
          recordAttempt({ error: aborted.message });
          throw aborted;
        }

        const timedOut = new Error(`${policy.label || "Request"} timed out after ${timeoutMs}ms`);
        recordAttempt({ error: timedOut.message });
        throw timedOut;
      }

      recordAttempt({
        error: error instanceof Error ? error.message : String(error),
        errorName: retryableTransportErrorName(error),
      });
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
 * HTTP status → category table for HTTPRequestError. Evaluated BEFORE any
 * message-regex rule: the status code is the structured, trustworthy signal;
 * message text is only a fallback for errors that never reached HTTP.
 */
function classifyHttpStatus(status: number): ErrorCategory {
  switch (status) {
    case 401:
    case 403:
      // Authentication/authorization rejections are credential problems, not
      // transport problems.
      return "credentials";
    case 402:
      // Payment/quota exhaustion (e.g. Exa X402_PAYMENT_REQUIRED).
      return "quota";
    case 429:
      return "rate_limit";
    case 432:
    case 433:
      // Tavily plan/usage limits (kept provider-agnostic: any 432/433 is a
      // quota-style rejection, not a transport failure).
      return "quota";
    case 408:
      return "network";
    case 400:
    case 422:
      // The request itself was rejected as malformed/unprocessable.
      return "validation";
    default:
      // Any 5xx is a server-side transport condition (Kilo WARNING on #84:
      // 501/505+ fell through to "provider"). All other non-2xx are
      // provider-side conditions we cannot name more precisely.
      if (status >= 500 && status <= 599) return "network";
      return "provider";
  }
}

const SEARXNG_JSON_HINT =
  " — SearXNG returned 403 — if keyless, the instance likely has JSON format disabled; " +
  "enable `search: formats: [json]` in settings.yml";

function classifyHttpRequestError(error: HTTPRequestError): ClassifiedError {
  if (error.status === undefined) {
    return { category: "network", message: error.message };
  }

  const isKeylessSearxng403 =
    error.status === 403 && error.label?.startsWith("SearXNG");
  const category = isKeylessSearxng403
    ? "config"
    : classifyHttpStatus(error.status);
  const message = isKeylessSearxng403
    ? error.message + SEARXNG_JSON_HINT
    : error.message;
  return { category, message };
}

function underlyingHttpErrors(error: unknown): HTTPRequestError[] {
  if (!error || typeof error !== "object") return [];
  const candidate = (error as { providerHttpErrors?: unknown }).providerHttpErrors;
  if (!candidate || typeof candidate !== "object") return [];
  return Object.values(candidate).filter(
    (item): item is HTTPRequestError => item instanceof HTTPRequestError
  );
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
    return classifyHttpRequestError(error);
  }
  const httpErrors = underlyingHttpErrors(error);
  if (httpErrors.length > 0) {
    const classified = httpErrors.map(classifyHttpRequestError);
    const categories = new Set(classified.map((item) => item.category));
    const providerErrors =
      error &&
      typeof error === "object" &&
      "providerErrors" in error
        ? (error as { providerErrors?: unknown }).providerErrors
        : undefined;
    const allFailuresAreHttp =
      providerErrors !== null &&
      typeof providerErrors === "object" &&
      Object.keys(providerErrors).length === httpErrors.length;
    const category =
      allFailuresAreHttp && categories.size === 1
        ? classified[0]!.category
        : "provider";
    // The wrapper message contains safe request labels/statuses. Preserve the
    // operator hint for a SearXNG 403, but never append an untrusted body.
    const hints = httpErrors
      .filter((item) => item.status === 403 && item.label?.startsWith("SearXNG"))
      .map(() => SEARXNG_JSON_HINT);
    return { category, message: message + [...new Set(hints)].join("") };
  }
  const declaredCategory =
    error && typeof error === "object" && "category" in error
      ? (error as { category?: unknown }).category
      : undefined;
  if (
    typeof declaredCategory === "string" &&
    [
      "config",
      "credentials",
      "quota",
      "rate_limit",
      "network",
      "validation",
      "unsupported_capability",
      "unsupported_tool",
      "provider",
    ].includes(declaredCategory)
  ) {
    return { category: declaredCategory as ErrorCategory, message };
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
    /unknown option|unknown '.*' subcommand|invalid limit|invalid rerank|invalid freshness|invalid time range|invalid intent|--intent requires|--time-range requires|invalid reasoning effort|invalid agent llm reasoning effort|--llm-key-ref requires|agent llm key_ref|\[agent\.llm\].*key_ref|\[agent\.llm\].*reasoning_effort|requires a .* argument|is only valid with|no configuration found for capability|not configured|config file|legacy config found|failed to parse config|invalid llm provider|unknown llm provider|unsupported llm provider|no execution found with id|no providers configured for/i.test(
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

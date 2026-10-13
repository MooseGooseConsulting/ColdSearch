import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Request/response capture harness (issue #79, PR-E test proof layer 2).
 *
 * When the operator sets COLDSEARCH_CAPTURE_DIR, every HTTP exchange that
 * flows through fetchWithPolicy is appended as one JSON line to
 * `<dir>/capture-<YYYYMMDD-HHMMSS>.jsonl`. When the variable is unset the
 * recorder is a complete no-op — the only cost is one env lookup per call.
 *
 * Redaction guarantees (a capture line must NEVER contain a secret value):
 * - the `authorization`, `proxy-authorization`, `x-api-key`, and
 *   `x-subscription-token` request headers are always replaced by "REDACTED";
 * - every configured secret value (RequestPolicy.secrets and/or
 *   setCaptureSecrets) is replaced by "REDACTED" wherever it appears in
 *   request/response headers, URLs, bodies, or error messages;
 * - well-known credential query/body keys (api_key, access_token, jwt, …) are
 *   redacted even when the secret value was not threaded through, as a
 *   defense-in-depth net.
 */

const REDACTED = "REDACTED";
const RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;

/** Header names whose values are always redacted (compared lowercase). */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-subscription-token",
]);

/** Query/body keys whose values carry credentials on keyless probes. */
const SENSITIVE_VALUE_KEYS = [
  "api_key",
  "apikey",
  "access_token",
  "redir_token",
  "jwt",
  "token",
];

export interface CaptureRecord {
  /** ISO-8601 timestamp of the exchange. */
  ts: string;
  /** RequestPolicy.label of the call, when set. */
  label?: string;
  method: string;
  /** URL after secret/query-value redaction. */
  url: string;
  /** Request headers with credentials redacted. */
  requestHeaders: Record<string, string>;
  /** Request body after secret redaction, when the call carried one. */
  requestBody?: string;
  /** HTTP status of the final response, when one was received. */
  status?: number;
  /** Selected response headers: content-type, retry-after, x-ratelimit-*. */
  responseHeaders?: Record<string, string>;
  /** Response body text, truncated at 64 KiB, after secret redaction. */
  responseBodyText?: string;
  durationMs: number;
  /** Error message for exchanges that never produced a response. */
  error?: string;
}

export interface CaptureInput {
  label?: string;
  method: string;
  url: string;
  requestHeaders?: NonNullable<RequestInit["headers"]>;
  requestBody?: RequestInit["body"];
  status?: number;
  responseHeaders?: Headers;
  responseBodyText?: string;
  durationMs: number;
  error?: string;
  /** Resolved secret values from the caller's RequestPolicy, when available. */
  secrets?: string[];
}

/** Process-wide secrets registered by tests/tools outside a RequestPolicy. */
let globalCaptureSecrets: string[] = [];

/** Register additional secret values to redact from every capture line. */
export function setCaptureSecrets(secrets: string[]): void {
  globalCaptureSecrets = [...secrets];
}

/** Clear process-wide capture secrets (test teardown). */
export function clearCaptureSecrets(): void {
  globalCaptureSecrets = [];
}

/** True when capture is active (COLDSEARCH_CAPTURE_DIR is set and non-empty). */
export function captureEnabled(): boolean {
  return Boolean(process.env.COLDSEARCH_CAPTURE_DIR?.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace every occurrence of each known secret with REDACTED. */
function redactKnownSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  return out;
}

/**
 * Defense-in-depth: redact the VALUE of well-known credential keys in
 * `key=value` (query string) and `"key":"value"` (JSON body) shapes, even
 * when the concrete secret was never threaded through.
 */
function redactCredentialKeys(text: string): string {
  const keys = SENSITIVE_VALUE_KEYS.join("|");
  return text
    .replace(
      new RegExp(`([?&](?:${keys})=)[^&#"\\s]+`, "gi"),
      `$1${REDACTED}`
    )
    .replace(
      new RegExp(`("(?:${keys})"\\s*:\\s*")[^"]*(")`, "gi"),
      `$1${REDACTED}$2`
    );
}

export function redactText(text: string, secrets: string[]): string {
  return redactCredentialKeys(redactKnownSecrets(text, secrets));
}

function normalizeHeaders(
  headers: NonNullable<RequestInit["headers"]> | undefined,
  secrets: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  const set = (name: string, value: string) => {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower)) {
      out[lower] = REDACTED;
      return;
    }
    // If any known secret appears anywhere in the value, redact the whole
    // header value rather than leaking its surrounding context.
    const redacted = redactKnownSecrets(value, secrets);
    out[lower] = redacted === value ? value : REDACTED;
  };

  if (headers instanceof Headers) {
    headers.forEach((value, name) => set(name, value));
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers) set(name, value);
  } else {
    for (const [name, value] of Object.entries(headers)) set(name, String(value));
  }
  return out;
}

function selectResponseHeaders(headers: Headers | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  const contentType = headers.get("content-type");
  if (contentType) out["content-type"] = contentType;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) out["retry-after"] = retryAfter;
  headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-ratelimit-")) {
      out[name.toLowerCase()] = value;
    }
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

function redactResponseHeaders(
  headers: Record<string, string> | undefined,
  secrets: string[]
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, redactText(value, secrets)])
  );
}

function truncateBody(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= RESPONSE_BODY_LIMIT_BYTES) return text;
  // Truncate on a character boundary well under the byte cap to avoid
  // splitting a multi-byte sequence.
  let out = text.slice(0, RESPONSE_BODY_LIMIT_BYTES);
  while (Buffer.byteLength(out, "utf8") > RESPONSE_BODY_LIMIT_BYTES) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return `${out}…[truncated at 64 KiB]`;
}

function bodyToText(body: NonNullable<RequestInit["body"]> | null | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  try {
    return String(body);
  } catch {
    return undefined;
  }
}

function captureFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `capture-${stamp}.jsonl`;
}

/**
 * Build the capture record for one exchange. Exported (with redactText) so
 * tests can verify redaction without touching the filesystem.
 */
export function buildCaptureRecord(input: CaptureInput, now = new Date()): CaptureRecord {
  const secrets = [...globalCaptureSecrets, ...(input.secrets ?? [])].filter(Boolean);
  const record: CaptureRecord = {
    ts: now.toISOString(),
    method: input.method.toUpperCase(),
    url: redactText(input.url, secrets),
    requestHeaders: normalizeHeaders(input.requestHeaders, secrets),
    durationMs: Math.round(input.durationMs),
  };
  if (input.label) record.label = input.label;
  const requestBody = bodyToText(input.requestBody);
  if (requestBody !== undefined) {
    record.requestBody = redactText(requestBody, secrets);
  }
  if (input.status !== undefined) record.status = input.status;
  const responseHeaders = redactResponseHeaders(
    selectResponseHeaders(input.responseHeaders),
    secrets
  );
  if (responseHeaders) record.responseHeaders = responseHeaders;
  if (input.responseBodyText !== undefined) {
    record.responseBodyText = redactText(truncateBody(input.responseBodyText), secrets);
  }
  if (input.error) record.error = redactText(input.error, secrets);
  return record;
}

/**
 * Pending capture writes, serialized so callers may fire-and-forget
 * recordCapture without interleaving partial lines.
 */
let writeChain: Promise<void> = Promise.resolve();
const pendingCaptureTasks = new Set<Promise<void>>();

/** Keep asynchronous response-prefix reads visible to flushCaptures(). */
export function trackCaptureTask(task: Promise<void>): void {
  const tracked = task.catch(() => undefined);
  pendingCaptureTasks.add(tracked);
  void tracked.then(() => pendingCaptureTasks.delete(tracked));
}

/** Read and decode at most the capture limit without consuming the caller's response. */
export async function readCaptureResponsePrefix(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (totalBytes < RESPONSE_BODY_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = RESPONSE_BODY_LIMIT_BYTES - totalBytes;
      const length = Math.min(value.byteLength, remaining);
      if (length > 0) {
        chunks.push(value.subarray(0, length));
        totalBytes += length;
      }
      if (length < value.byteLength || totalBytes === RESPONSE_BODY_LIMIT_BYTES) {
        truncated = true;
        break;
      }
    }
  } catch {
    // A capture read is best effort and must not affect the provider response.
  } finally {
    if (truncated) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return truncated ? `${text}…[capture truncated at 64 KiB]` : text;
}

/**
 * Append one exchange to today's capture file. No-op when
 * COLDSEARCH_CAPTURE_DIR is unset. Never throws — capture is observability
 * and must not break the request it observes. Writes are chained; await
 * flushCaptures() (tests) to guarantee they have landed.
 */
export function recordCapture(input: CaptureInput): Promise<void> {
  const dir = process.env.COLDSEARCH_CAPTURE_DIR?.trim();
  if (!dir) return writeChain;

  const write = writeChain.then(async () => {
    try {
      const now = new Date();
      const record = buildCaptureRecord(input, now);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const file = path.join(dir, captureFileName(now));
      await appendFile(
        file,
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      await chmod(file, 0o600);
    } catch {
      // Capture failures are swallowed: the operator's request must not fail
      // because an evidence file could not be written.
    }
  });
  writeChain = write;
  return write;
}

/** Resolve once every capture write queued so far has completed. */
export async function flushCaptures(): Promise<void> {
  while (pendingCaptureTasks.size > 0) {
    await Promise.all([...pendingCaptureTasks]);
  }
  await writeChain;
}

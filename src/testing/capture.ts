import { appendFile, chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactUrlUserInfo } from "../history/redact.js";

/**
 * Request/response capture harness (issue #79, PR-E test proof layer 2).
 *
 * When the operator sets COLDSEARCH_CAPTURE_DIR, every HTTP exchange that
 * flows through fetchWithPolicy is appended as one JSON line to
 * `<dir>/capture-<YYYYMMDD-HHMMSS>.jsonl`. When the variable is unset the
 * recorder is a complete no-op — the only cost is one env lookup per call.
 *
 * Redaction guarantees (a capture line must NEVER contain a secret value):
 * - known authorization headers and custom header names containing credential
 *   segments (key, token, secret, credential, password, or cookie) are
 *   replaced by "REDACTED";
 * - every configured secret value (RequestPolicy.secrets and/or
 *   setCaptureSecrets) is replaced by "REDACTED" wherever it appears in
 *   request/response headers, URLs, bodies, or error messages;
 * - well-known credential query/body keys (api_key, access_token, jwt, …) are
 *   redacted even when the secret value was not threaded through, as a
 *   defense-in-depth net.
 */

const REDACTED = "REDACTED";
const RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
const RESPONSE_BODY_READ_TIMEOUT_MS = 500;
const INCOMPLETE_CAPTURE_MARKER = "…[capture prefix incomplete]";

/** Header names whose values are always redacted (compared lowercase). */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-subscription-token",
]);
const SENSITIVE_HEADER_NAME_PATTERN =
  /(?:^|[-_])(?:auth(?:orization|entication)?|api[-_]?key|apikey|key|token|secret|credential|password|cookie)(?:$|[-_])/i;

/** URL parameters whose values carry credentials, matching history redaction. */
const SENSITIVE_URL_PARAMETER_NAMES = new Set([
  "api_key",
  "apikey",
  "access_token",
  "auth_token",
  "client_secret",
  "credential",
  "redir_token",
  "jwt",
  "key",
  "password",
  "secret",
  "sessionid",
  "sig",
  "signature",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
]);
const SENSITIVE_FIELD_NAME_PATTERN =
  /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|authorization|credential|pass(word|phrase)|secret|signature|bearer|cookie|proxy[_-]?url)/i;
const SENSITIVE_EXACT_FIELD_NAME_PATTERN = /^(token|key|jwt|sig|session(id)?|zone)$/i;

function isSensitiveCredentialKey(key: string): boolean {
  return SENSITIVE_FIELD_NAME_PATTERN.test(key) ||
    SENSITIVE_EXACT_FIELD_NAME_PATTERN.test(key) ||
    SENSITIVE_URL_PARAMETER_NAMES.has(key.toLowerCase());
}

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
  /** Retryable transport error class, when the live request retried it. */
  errorName?: "TypeError" | "AbortError";
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
  /** Retryable transport error class, when the live request retried it. */
  errorName?: "TypeError" | "AbortError";
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

function encodedSecretVariants(secret: string): string[] {
  const formEncoded = new URLSearchParams({ value: secret }).toString().slice("value=".length);
  return [...new Set([secret, encodeURIComponent(secret), formEncoded])].filter(Boolean);
}

function secretPattern(secret: string): string {
  return escapeRegExp(secret).replace(/%([0-9a-f]{2})/gi, (_match, byte: string) => {
    const first = byte[0]!;
    const second = byte[1]!;
    return `%[${first.toLowerCase()}${first.toUpperCase()}][${second.toLowerCase()}${second.toUpperCase()}]`;
  });
}

/** Replace every occurrence of each known secret with REDACTED. */
function redactKnownSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of encodedSecretVariants(secret)) {
      out = out.replace(new RegExp(secretPattern(variant), "g"), REDACTED);
    }
  }
  return out;
}

function captureSecrets(secrets: string[] = []): string[] {
  return [...globalCaptureSecrets, ...secrets].filter(Boolean);
}

/**
 * Defense-in-depth: redact values for credential-like keys recognized by
 * history redaction, plus signed-URL parameters, even when the concrete secret
 * was never threaded through.
 */
function redactCredentialKeys(text: string): string {
  return text
    .replace(
      /(^|[?&])([^=&#"'\s]+)=([^&#"'\s]+)/gi,
      (match, boundary: string, key: string) =>
        isSensitiveCredentialKey(key)
          ? `${boundary}${key}=${REDACTED}`
          : match
    );
}

function redactJsonCredentialValues(text: string): string {
  const keyPattern = /"((?:[^"\\]|\\.)*)"\s*:\s*"/g;
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = keyPattern.exec(text)) !== null) {
    const valueStart = keyPattern.lastIndex;
    let key = match[1]!;
    try {
      key = JSON.parse(`"${key}"`) as string;
    } catch {
      // A malformed key is not a credential key we can safely identify.
    }
    const sensitive = isSensitiveCredentialKey(key);
    let valueEnd = valueStart;
    while (valueEnd < text.length) {
      if (text[valueEnd] === "\\") {
        valueEnd += 2;
      } else if (text[valueEnd] === "\"") {
        break;
      } else {
        valueEnd += 1;
      }
    }

    const complete = valueEnd < text.length;
    if (!sensitive) {
      if (!complete) break;
      keyPattern.lastIndex = valueEnd + 1;
      continue;
    }

    output += text.slice(cursor, valueStart) + REDACTED;
    if (complete) {
      output += "\"";
      cursor = valueEnd + 1;
      keyPattern.lastIndex = cursor;
    } else {
      const markerStart = text.endsWith(INCOMPLETE_CAPTURE_MARKER)
        ? text.length - INCOMPLETE_CAPTURE_MARKER.length
        : text.length;
      output += text.slice(Math.max(valueStart, markerStart));
      cursor = text.length;
      break;
    }
  }

  return output + text.slice(cursor);
}

export function redactText(text: string, secrets: string[]): string {
  const redacted = redactCredentialKeys(redactKnownSecrets(text, secrets));
  return redactUrlUserInfo(redactJsonCredentialValues(redacted), REDACTED);
}

function normalizeHeaders(
  headers: NonNullable<RequestInit["headers"]> | undefined,
  secrets: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;

  const set = (name: string, value: string) => {
    const lower = name.toLowerCase();
    if (
      SENSITIVE_HEADER_NAMES.has(lower) ||
      SENSITIVE_HEADER_NAME_PATTERN.test(lower)
    ) {
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
  const secrets = captureSecrets(input.secrets);
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
    record.responseBodyText = truncateBody(redactText(input.responseBodyText, secrets));
  }
  if (input.error) record.error = redactText(input.error, secrets);
  if (input.errorName) record.errorName = input.errorName;
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

class UnsafeCaptureDirectoryError extends Error {}

let unsafeCaptureDirectoryWarningIssued = false;

function warnUnsafeCaptureDirectory(): void {
  if (unsafeCaptureDirectoryWarningIssued) return;
  unsafeCaptureDirectoryWarningIssued = true;
  try {
    process.emitWarning(
      "Capture records are being skipped because COLDSEARCH_CAPTURE_DIR or one of its parent directories is unsafe; choose a private directory with trusted ancestors.",
      { code: "COLDSEARCH_UNSAFE_CAPTURE_DIR" }
    );
  } catch {
    // Capture diagnostics must not affect the operator's request either.
  }
}

function assertSafeCaptureDirectory(
  directory: string,
  info: Awaited<ReturnType<typeof lstat>>,
  isTarget: boolean,
  currentUid: number | undefined
): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafeCaptureDirectoryError(
      `Capture path component is not a real directory: ${directory}`
    );
  }

  // Windows does not expose POSIX ownership/mode semantics through getuid()
  // and Stats.mode. Keep the structural checks above, but only apply these
  // permission checks on platforms where the metadata is meaningful.
  if (currentUid === undefined) return;

  // Trust root-owned system directories and directories owned by this process.
  // An untrusted owner can change a directory's mode or replace its entries.
  const trustedOwner = info.uid === 0 || (currentUid !== undefined && info.uid === currentUid);
  if (!trustedOwner) {
    throw new UnsafeCaptureDirectoryError(
      `Capture path component has an untrusted owner: ${directory}`
    );
  }

  const mode = Number(info.mode);
  const writableByOthers = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  // A sticky shared ancestor (such as /tmp) protects entries owned by this
  // process. Never write directly into a shared-writable capture directory.
  if (writableByOthers && (isTarget || !sticky)) {
    throw new UnsafeCaptureDirectoryError(
      `Capture directory is writable by other users: ${directory}`
    );
  }
}

/** Create missing components privately and reject unsafe or symlinked paths. */
async function ensureSafeCaptureDirectory(directory: string): Promise<string> {
  const target = path.resolve(directory);
  const root = path.parse(target).root;
  const segments = target.slice(root.length).split(path.sep).filter(Boolean);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let current = root;
  let info = await lstat(current);
  assertSafeCaptureDirectory(current, info, segments.length === 0, currentUid);

  for (let index = 0; index < segments.length; index++) {
    const next = path.join(current, segments[index]!);
    try {
      info = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(next);
    }
    assertSafeCaptureDirectory(next, info, index === segments.length - 1, currentUid);
    current = next;
  }

  return target;
}

/** Read a bounded prefix without exposing a partial known secret at its edge. */
export async function readCaptureResponsePrefix(
  response: Response,
  secrets: string[] = []
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  let releaseAfterRead = false;
  const deadline = Date.now() + RESPONSE_BODY_READ_TIMEOUT_MS;
  try {
    while (totalBytes < RESPONSE_BODY_LIMIT_BYTES) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        truncated = true;
        break;
      }

      const pendingRead = reader.read();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        pendingRead.then(
          (read) => ({ kind: "read" as const, read }),
          () => ({ kind: "read-error" as const })
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (result.kind === "timeout") {
        truncated = true;
        releaseAfterRead = true;
        // A pending read cannot be released synchronously. Cancellation should
        // settle it; release later without making capture wait for the stream.
        void pendingRead.then(
          () => reader.releaseLock(),
          () => reader.releaseLock()
        ).catch(() => undefined);
        break;
      }
      if (result.kind === "read-error") {
        truncated = true;
        break;
      }
      const { done, value } = result.read;
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
    truncated = true;
  } finally {
    if (truncated) void reader.cancel().catch(() => undefined);
    if (!releaseAfterRead) reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  const allSecrets = captureSecrets(secrets);
  if (!truncated) return text;

  // A known secret may straddle the bounded read boundary, leaving only its
  // leading fragment in `text`. Drop enough trailing characters to ensure
  // that incomplete fragment cannot be written to the capture file.
  const longestSecret = allSecrets
    .flatMap(encodedSecretVariants)
    .reduce((longest, secret) => Math.max(longest, secret.length), 0);
  const safePrefix = longestSecret > 1
    ? text.slice(0, Math.max(0, text.length - longestSecret + 1))
    : text;
  return `${safePrefix}${INCOMPLETE_CAPTURE_MARKER}`;
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

  return enqueueCaptureWrite(Promise.resolve(input), dir);
}

/**
 * Reserve the next JSONL position before an asynchronous response-body read.
 * The returned writer fills that position once the bounded read completes.
 */
export function reserveCaptureRecord(): (input: CaptureInput) => Promise<void> {
  const dir = process.env.COLDSEARCH_CAPTURE_DIR?.trim();
  if (!dir) return () => writeChain;

  let resolveInput!: (input: CaptureInput) => void;
  const input = new Promise<CaptureInput>((resolve) => {
    resolveInput = resolve;
  });
  const write = enqueueCaptureWrite(input, dir);
  let committed = false;
  return (captureInput) => {
    if (!committed) {
      committed = true;
      resolveInput(captureInput);
    }
    return write;
  };
}

function enqueueCaptureWrite(
  input: Promise<CaptureInput>,
  dir: string
): Promise<void> {
  const write = writeChain.then(async () => {
    const captureInput = await input;
    try {
      const now = new Date();
      const record = buildCaptureRecord(captureInput, now);
      const safeDir = await ensureSafeCaptureDirectory(dir);
      const file = path.join(safeDir, captureFileName(now));
      await appendFile(
        file,
        `${JSON.stringify(record)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      await chmod(file, 0o600);
    } catch (error) {
      if (error instanceof UnsafeCaptureDirectoryError) warnUnsafeCaptureDirectory();
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

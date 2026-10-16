/**
 * Recursive credential redaction for anything persisted to history or the
 * replay cache.
 *
 * Two threat shapes are covered:
 *
 * 1. Resolved credential values (API keys resolved from doppler:/env:/literal
 *    refs). Provider error bodies and raw payloads can echo them back, and
 *    callers can paste them into request inputs. Any string containing a
 *    resolved secret has the secret substring replaced before persistence.
 *
 * 2. Signed URLs and credential-bearing fields. Caller-supplied URLs (and
 *    URLs adapters echo into normalized/final results) can carry signature
 *    tokens in query params; request options can carry credential fields.
 *    Sensitive query-param values and object fields are replaced by name.
 *
 * Redaction is fail-closed at the call site: if a value cannot be scrubbed
 * (e.g. not JSON-serializable), the caller marks that content unavailable
 * instead of persisting it.
 */

export const REDACTED = "[REDACTED]";

/** Object field names whose string values are always redacted. */
const SENSITIVE_FIELD_PATTERN =
  /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|authorization|credential|pass(word|phrase)|secret|signature|bearer|cookie|proxy[_-]?url)/i;

/**
 * Exact field names that are credential material on their own — e.g. a
 * `token` or `key` field inside `tool call --json-input`. Kept separate from
 * the substring pattern above so ordinary fields like `monkey` or
 * `tokenizer` are not mangled. `zone` is included because Bright Data zone
 * names embed the customer ID (e.g. `brd-customer_<id>-zone-serp`).
 */
const SENSITIVE_EXACT_FIELD_PATTERN = /^(token|key|jwt|sig|session(id)?|zone)$/i;

/**
 * URL query parameters whose values are signature/credential material.
 * Matched exactly (case-insensitive) against the param name.
 */
const SENSITIVE_URL_PARAMS = [
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "client_secret",
  "credential",
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
];

const URL_PARAM_PATTERN = new RegExp(
  `([?&](?:${SENSITIVE_URL_PARAMS.join("|")})=)[^&\\s"'\\])}]*`,
  "gi"
);
/**
 * WHATWG URL accepts whitespace/quotes/brackets in userinfo (percent-encoded
 * into username), so the authority class must not stop at them — otherwise
 * credential userinfo containing those chars leaks (Codex on #86). The
 * existing quote-boundary logic below trims field delimiters after capture.
 */
const URL_AUTHORITY_PATTERN = /\b([a-z][a-z\d+.-]*:\/\/)([^/?#]*)/gi;

/**
 * Secrets shorter than this are not substring-replaced inside larger strings:
 * a short value would mangle unrelated content (e.g. a 4-char literal key).
 * Exact full-string matches are still redacted regardless of length.
 */
const MIN_SUBSTRING_SECRET_LENGTH = 8;

function redactString(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    if (out === secret) return REDACTED;
    if (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return redactUrlUserInfo(out.replace(URL_PARAM_PATTERN, `$1${REDACTED}`));
}

/** Redact URL authority credentials in arbitrary text, preserving the scheme and host. */
export function redactUrlUserInfo(text: string, replacement = REDACTED): string {
  return text.replace(
    URL_AUTHORITY_PATTERN,
    (_match, scheme: string, authority: string, offset: number, input: string) => {
      // Keep apostrophes available inside user-info (passwords commonly
      // contain them). Treat quote punctuation as a boundary only when the URL
      // itself is inside a single-quoted field; otherwise `';` may be literal
      // password data and the final `@` still marks the host boundary.
      const singleQuotedUrl = input[offset - 1] === "'";
      // Like the semicolon guard below: a quote-comma pair inside credentials
      // is data when the eventual `@` has not arrived yet (CodeRabbit on #86).
      const fieldQuoteCandidate = singleQuotedUrl
        ? /'\s*,\s*'/.exec(authority)?.index
        : undefined;
      const fieldQuoteBoundary = fieldQuoteCandidate !== undefined &&
        authority.slice(0, fieldQuoteCandidate).includes("@")
        ? fieldQuoteCandidate
        : undefined;
      const semicolonQuoteCandidate = singleQuotedUrl
        ? /'\s*;/.exec(authority)?.index
        : undefined;
      // A quote-semicolon pair inside credentials is data when the eventual
      // `@` has not arrived yet. A real quoted URL boundary follows its host,
      // so retain the boundary only after the URL's user-info separator.
      const semicolonQuoteBoundary = semicolonQuoteCandidate !== undefined &&
        authority.slice(0, semicolonQuoteCandidate).includes("@")
        ? semicolonQuoteCandidate
        : undefined;
      const terminalQuoteBoundary = singleQuotedUrl
        ? /'(?=\s*(?:[\]}]|$))/.exec(authority)?.index
        : undefined;
      const explicitQuoteBoundaries = [fieldQuoteBoundary, semicolonQuoteBoundary]
        .filter((boundary): boundary is number => boundary !== undefined)
        .sort((left, right) => left - right);
      // A terminal quote/bracket pair is a boundary only when no later `@`
      // appears in the captured text. Otherwise the quote may be part of
      // user-info, and the final `@` still marks the host boundary.
      const quoteBoundary = explicitQuoteBoundaries[0] ?? (
        terminalQuoteBoundary !== undefined &&
        !authority.slice(terminalQuoteBoundary + 1).includes("@")
          ? terminalQuoteBoundary
          : undefined
      );
      const end = quoteBoundary ?? authority.length;
      const urlAuthority = authority.slice(0, end);
      const suffix = authority.slice(end);
      const userInfoEnd = urlAuthority.lastIndexOf("@");
      if (userInfoEnd < 0) return `${scheme}${authority}`;
      return `${scheme}${replacement}@${urlAuthority.slice(userInfoEnd + 1)}${suffix}`;
    }
  );
}

/**
 * Return a redacted deep copy of `value`. Never mutates the input.
 * `secrets` are resolved credential values to scrub wherever they appear.
 */
export function redactSensitive<T>(value: T, secrets: string[] = []): T {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value, secrets) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, secrets)) as T;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      // A matching field NAME is credential material on its own: replace the
      // entire value with REDACTED regardless of its type (arrays, objects,
      // numbers included) and do not recurse into it. Otherwise a value like
      // `{"authorization": ["Bearer customer-secret"]}` would survive into
      // history through a non-string container.
      if (SENSITIVE_FIELD_PATTERN.test(key) || SENSITIVE_EXACT_FIELD_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactSensitive(fieldValue, secrets);
      }
    }
    return out as T;
  }

  // numbers, booleans, etc. carry no credential material
  return value;
}

/**
 * Redact for persistence, fail-closed: returns the scrubbed value, or null
 * when the value cannot be scrubbed safely (not JSON-serializable). A null
 * result must be recorded as "unavailable", never persisted verbatim.
 */
export function redactForPersistence(value: unknown, secrets: string[] = []): unknown | null {
  try {
    const scrubbed = redactSensitive(value, secrets);
    JSON.stringify(scrubbed);
    return scrubbed;
  } catch {
    return null;
  }
}

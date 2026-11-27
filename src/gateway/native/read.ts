import { needsFallback } from "./detect.js";
import { readHtml, type HtmlPage } from "./html.js";
import { decodeBody, fetchUrl, isHtmlType, type NativeNet } from "./http.js";

/** Why a direct read did not yield the page. */
export interface ReadProblem {
  /** `http_<status>`, `challenge_page`, `no_text` or `unsupported_content_type`. */
  reason: string;
  detail: string;
  /** True when a paid provider tool might read what the gateway could not. */
  fallback: boolean;
}

/** One URL as the gateway read it, without a provider. */
export interface DirectRead {
  /** Where the content came from, after redirects, without a fragment. */
  finalUrl: string;
  status: number;
  contentType: string;
  /** Decoded body; "" when the response was not text. */
  body: string;
  /** Present when the body is HTML. */
  html?: HtmlPage;
  /** The body passed the size cap and was cut. */
  truncated: boolean;
  /** Absent when the page was read. */
  problem?: ReadProblem;
}

/**
 * Fetch one URL and judge the answer. Returns a `problem` for anything short
 * of a readable page; throws only when no HTTP answer was obtained (the SSRF
 * guard refused the URL, DNS failed, the connection failed or timed out, or
 * `signal` fired).
 */
export async function readPage(net: NativeNet, url: string, signal?: AbortSignal): Promise<DirectRead> {
  const fetched = await fetchUrl(net, url, { signal });
  const read: DirectRead = {
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    contentType: fetched.contentType,
    body: fetched.bodySkipped ? "" : decodeBody(fetched.body, fetched.headers),
    truncated: fetched.truncated,
  };
  if (isHtmlType(fetched.contentType) || (fetched.contentType === "" && /^\s*<(?:!doctype|html)/i.test(read.body))) {
    read.html = readHtml(read.body, fetched.finalUrl);
  }

  const need = needsFallback({ status: fetched.status, headers: fetched.headers, body: read.body, html: read.html });
  if (need) {
    read.problem = { ...need, fallback: true };
  } else if (fetched.status < 200 || fetched.status >= 300) {
    read.problem = { reason: `http_${fetched.status}`, detail: `The site answered HTTP ${fetched.status}.`, fallback: false };
  } else if (fetched.bodySkipped) {
    read.problem = {
      reason: "unsupported_content_type",
      detail: `The URL is ${fetched.contentType}, which the gateway does not convert to text. A provider fetch tool may.`,
      fallback: false,
    };
  }
  return read;
}

/** Cut `text` to `maxChars`, saying whether anything was lost. */
export function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

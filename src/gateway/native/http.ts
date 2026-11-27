import type { IncomingHttpHeaders } from "node:http";
import { APP_USER_AGENT } from "../../app.js";
import { requestValidated, validateFetchUrl, type SafeFetchHooks } from "../../safe-fetch.js";
import { throwIfCancelled } from "./cancel.js";
import type { HostGate } from "./politeness.js";

/** What the native tools need to reach the network. One instance per gateway process. */
export interface NativeNet {
  /** Test seams of the SSRF guard; empty in production. */
  hooks: SafeFetchHooks;
  gate: HostGate;
}

/** The name robots.txt rules are matched against. */
export const ROBOTS_AGENT = "coldsearch";
const USER_AGENT = `Mozilla/5.0 (compatible; ${APP_USER_AGENT})`;

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 15_000;
const DEADLINE_MS = 45_000;
/** Largest page body kept, after decompression. A longer body is cut here and marked truncated. */
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedUrl {
  /** Where the last request went, after redirects. */
  finalUrl: string;
  status: number;
  headers: IncomingHttpHeaders;
  /** Media type in lower case without parameters; "" when the server sent none. */
  contentType: string;
  body: Buffer;
  /** True when the body was left unread because `wantBody` turned its type down. */
  bodySkipped: boolean;
  truncated: boolean;
}

function mediaType(headers: IncomingHttpHeaders): string {
  return String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

/** Media types the gateway can turn into text. */
export function isTextType(contentType: string): boolean {
  return (
    contentType === "" ||
    contentType.startsWith("text/") ||
    contentType === "application/xhtml+xml" ||
    contentType === "application/xml" ||
    contentType === "application/json" ||
    contentType.endsWith("+xml") ||
    contentType.endsWith("+json")
  );
}

export function isHtmlType(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

/**
 * GET one URL. Every hop, the first and each redirect, goes through the SSRF
 * guard and connects to the address it approved, and waits its turn at the
 * host gate. Up to five redirects are followed; a sixth comes back as the 3xx
 * it is. Throws when the guard refuses a hop or the connection fails, and
 * when `signal` fires: a request in flight is dropped and no further hop is
 * made.
 */
export async function fetchUrl(
  net: NativeNet,
  url: string,
  options: { maxBytes?: number; wantBody?: (contentType: string) => boolean; signal?: AbortSignal } = {}
): Promise<FetchedUrl> {
  const wantBody = options.wantBody ?? isTextType;
  let current = url;
  for (let hop = 0; ; hop++) {
    throwIfCancelled(options.signal);
    const target = await validateFetchUrl(current, net.hooks);
    let bodySkipped = false;
    const response = await net.gate.run(target.url.host, () =>
      requestValidated(target, {
        label: "Fetch",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
        },
        timeoutMs: IDLE_TIMEOUT_MS,
        deadlineMs: DEADLINE_MS,
        maxBytes: options.maxBytes ?? PAGE_MAX_BYTES,
        overflow: "truncate",
        decompress: true,
        signal: options.signal,
        inspect: (status, headers) => {
          const redirect = status >= 300 && status < 400 && headers.location !== undefined;
          if (redirect || !wantBody(mediaType(headers))) {
            bodySkipped = !redirect;
            return false;
          }
        },
      }),
      options.signal
    );

    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location && hop < MAX_REDIRECTS) {
      try {
        current = new URL(location, target.url).href;
      } catch {
        throw new Error(`Redirect from ${target.url.href} has an unusable Location header`);
      }
      continue;
    }
    return {
      finalUrl: target.url.href,
      status: response.status,
      headers: response.headers,
      contentType: mediaType(response.headers),
      body: response.body,
      bodySkipped,
      truncated: response.truncated,
    };
  }
}

/** Decode a text body using the charset the server or the document declares; UTF-8 otherwise. */
export function decodeBody(body: Buffer, headers: IncomingHttpHeaders): string {
  const declared =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(headers["content-type"] ?? ""))?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared).decode(body);
    } catch {
      // An unknown label: read as UTF-8 rather than fail the page.
    }
  }
  return new TextDecoder("utf-8").decode(body);
}

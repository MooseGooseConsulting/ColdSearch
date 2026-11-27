import type { IncomingHttpHeaders } from "node:http";

/**
 * Decides whether a direct fetch got the page or got a wall: a blocking
 * status, a bot-protection challenge, or a page whose content only appears
 * after JavaScript runs. The gateway cannot get past any of these; a paid
 * provider tool sometimes can.
 */
export interface FallbackNeed {
  /** Short machine-readable class: `http_403`, `challenge_page`, `no_text`. */
  reason: string;
  /** One sentence for the agent. */
  detail: string;
}

export interface FetchedDocument {
  status: number;
  headers: IncomingHttpHeaders;
  /** Decoded body; empty when the body was not text. */
  body: string;
  /** HTML facts, when the body was HTML. */
  html?: { textChars: number; emptyAppRoot: boolean; noscriptAsksForJavascript: boolean };
}

/** Statuses that mean "refused or failing", not "this page does not exist". */
const BLOCKING_STATUS = (status: number): boolean => status === 401 || status === 403 || status === 429 || status >= 500;

/** Response headers a protection layer sets when it serves a challenge instead of the page. */
const CHALLENGE_HEADERS: Array<[header: string, value: RegExp, name: string]> = [
  ["cf-mitigated", /challenge/i, "Cloudflare"],
  ["x-vercel-mitigated", /challenge/i, "Vercel"],
];

/**
 * Markup that challenge pages carry. Some of it (Cloudflare's script path)
 * also appears on ordinary protected pages, so a body marker counts only on a
 * page with little text of its own.
 */
const CHALLENGE_MARKERS: Array<[marker: RegExp, name: string]> = [
  [/\/cdn-cgi\/challenge-platform\//i, "Cloudflare"],
  [/challenges\.cloudflare\.com\/turnstile/i, "Cloudflare Turnstile"],
  [/<title>\s*Just a moment/i, "Cloudflare"],
  [/captcha-delivery\.com/i, "DataDome"],
  [/px-captcha|\/_px\w*\/|perimeterx/i, "PerimeterX"],
  [/_Incapsula_Resource/i, "Imperva"],
  [/errors\.edgesuite\.net/i, "Akamai"],
  [/anubis_challenge|within\.website\/x\/cmd\/anubis/i, "Anubis"],
  [/(?:hcaptcha\.com|google\.com\/recaptcha)\/[^"'\s]*api/i, "CAPTCHA"],
];

/** A challenge page says little; a real page that merely loads one of the scripts above says more than this. */
const CHALLENGE_TEXT_LIMIT = 1500;
/** Below this much visible text, a large HTML document is an empty shell. */
const SHELL_TEXT_LIMIT = 200;
const SHELL_HTML_BYTES = 5 * 1024;

/**
 * Returns why the document needs a paid fallback, or undefined when it reads
 * as a real page. A missing page (404, 410) and other 4xx statuses are not a
 * reason: paying a provider would return the same answer.
 */
export function needsFallback(document: FetchedDocument): FallbackNeed | undefined {
  for (const [header, value, name] of CHALLENGE_HEADERS) {
    if (value.test(String(document.headers[header] ?? ""))) {
      return { reason: "challenge_page", detail: `${name} served a bot-protection challenge (${header} header).` };
    }
  }

  const textChars = document.html?.textChars ?? document.body.trim().length;
  if (textChars < CHALLENGE_TEXT_LIMIT) {
    for (const [marker, name] of CHALLENGE_MARKERS) {
      if (marker.test(document.body)) {
        return { reason: "challenge_page", detail: `The response is a ${name} bot-protection challenge, not the page.` };
      }
    }
  }

  if (BLOCKING_STATUS(document.status)) {
    return { reason: `http_${document.status}`, detail: `The site answered HTTP ${document.status}.` };
  }

  if (document.status >= 200 && document.status < 300 && document.html) {
    const { emptyAppRoot, noscriptAsksForJavascript } = document.html;
    const large = Buffer.byteLength(document.body) > SHELL_HTML_BYTES;
    if (textChars < SHELL_TEXT_LIMIT && (large || emptyAppRoot || noscriptAsksForJavascript)) {
      return {
        reason: "no_text",
        detail: `The page has ${textChars} characters of text; its content is probably drawn by JavaScript, which the gateway does not run.`,
      };
    }
  }
  return undefined;
}

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
 * Markup that only a wall carries: the challenge itself, or the vendor's
 * block page. These run on the whole body, so each is a literal or a pattern
 * that cannot back up over a long run.
 */
const WALL_MARKERS: Array<[marker: RegExp, name: string]> = [
  [/<title>\s*Just a moment/i, "Cloudflare"],
  [/\/cdn-cgi\/challenge-platform\/[^"'\s]{0,40}\/orchestrate\/|_cf_chl_opt/i, "Cloudflare"],
  [/captcha-delivery\.com/i, "DataDome"],
  [/px-captcha/i, "PerimeterX"],
  [/errors\.edgesuite\.net/i, "Akamai"],
  [/anubis_challenge|within\.website\/x\/cmd\/anubis/i, "Anubis"],
];

/**
 * Markup a wall carries and an ordinary page can carry too: Cloudflare adds a
 * /cdn-cgi/challenge-platform/ script to pages it serves normally, Imperva
 * and PerimeterX add their own, and a contact or sign-in form loads a CAPTCHA
 * or Turnstile widget. One of these means a wall only together with a second
 * sign: a refusing status, or a page with next to no text.
 */
const SHARED_MARKERS: Array<[marker: RegExp, name: string]> = [
  [/\/cdn-cgi\/challenge-platform\//i, "Cloudflare"],
  [/challenges\.cloudflare\.com\/turnstile/i, "Cloudflare Turnstile"],
  [/\/_px\w*\/|perimeterx/i, "PerimeterX"],
  [/_Incapsula_Resource/i, "Imperva"],
  [/(?:hcaptcha\.com|google\.com\/recaptcha)\/[^"'\s]{0,64}api/i, "CAPTCHA"],
];

/** A wall says little; a page with more text than this is a page, whatever scripts it loads. */
const CHALLENGE_TEXT_LIMIT = 1500;
/** Below this much visible text, a large HTML document is an empty shell. */
const SHELL_TEXT_LIMIT = 200;
const SHELL_HTML_BYTES = 5 * 1024;

function firstMarker(markers: Array<[marker: RegExp, name: string]>, body: string): string | undefined {
  return markers.find(([marker]) => marker.test(body))?.[1];
}

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
    const success = document.status >= 200 && document.status < 300;
    // On a page the site served normally, a shared marker is most often an
    // ordinary script; it counts there only when the page says almost nothing.
    const sharedCounts = BLOCKING_STATUS(document.status) || (success && textChars < SHELL_TEXT_LIMIT);
    const name = firstMarker(WALL_MARKERS, document.body) ?? (sharedCounts ? firstMarker(SHARED_MARKERS, document.body) : undefined);
    if (name) {
      return { reason: "challenge_page", detail: `The response is a ${name} bot-protection challenge, not the page.` };
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

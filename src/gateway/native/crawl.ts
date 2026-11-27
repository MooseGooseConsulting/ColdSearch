import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { validateFetchUrl } from "../../safe-fetch.js";
import { boolArg, intArg, patternsArg, urlArg } from "./args.js";
import { readThroughFallback } from "./fallback.js";
import { clip, readPage, type DirectRead } from "./read.js";
import { jsonResult, type NativeHandler } from "./runtime.js";
import { looksLikePage, pageUrl, pathAllowed, sameSite } from "./urls.js";

export const CRAWL_TOOL = "coldsearch_crawl";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 10;
const DEFAULT_PAGE_CHARS = 20_000;
/** This many refusals in a row and the site is treating the gateway as a bot: stop asking. */
const BLOCKED_IN_A_ROW = 3;

export const crawlTool: Tool = {
  name: CRAWL_TOOL,
  description:
    `Read many pages of one site, following same-site links breadth-first from a start URL, and return each as markdown. The gateway fetches the pages itself, so they cost no provider credit: use this before any provider crawl tool. It obeys the site's robots.txt, makes one request at a time with a pause between them (about a second a page, all inside this one call), does not run JavaScript, and cannot get past bot protection. Pages it cannot read are listed under skipped with the reason; with allow_paid_fallback: true, pages that need JavaScript or are blocked go through the operator's configured paid tool, up to a per-crawl cap. It stops early with stopped: "site_protected" after ${BLOCKED_IN_A_ROW} refusals in a row. To pick pages yourself, call coldsearch_map and then coldsearch_fetch. Returns JSON: pages [{url, title, markdown, source "direct" or "paid"}], skipped [{url, reason}], stats.`,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http or https URL to start from." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most pages to request (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` },
      max_depth: { type: "integer", minimum: 0, maximum: MAX_DEPTH, description: `How many links away from the start URL to go (default ${DEFAULT_DEPTH}; 0 reads only the start URL).` },
      include: { type: "array", items: { type: "string" }, description: 'Only follow links whose path matches one of these patterns, e.g. ["/docs/*"]. * matches any characters. The start URL is always read.' },
      exclude: { type: "array", items: { type: "string" }, description: 'Do not follow links whose path matches one of these patterns, e.g. ["/blog/*"].' },
      allow_paid_fallback: { type: "boolean", description: "Send pages the gateway cannot read to the configured paid provider tool (spends provider credit, capped per crawl). Default false." },
      max_chars_per_page: { type: "integer", minimum: 1, description: `Longest markdown kept per page (default ${DEFAULT_PAGE_CHARS}). Longer pages are cut and marked truncated.` },
    },
    required: ["url"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
  source: "direct" | "paid";
  truncated?: true;
}

interface Skipped {
  url: string;
  reason: string;
  detail?: string;
}

const REFUSALS = new Set(["http_401", "http_403", "http_429", "challenge_page"]);

export const runCrawl: NativeHandler = async (runtime, args, context) => {
  const start = urlArg(args, "url");
  const limit = intArg(args, "limit", { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
  const maxDepth = intArg(args, "max_depth", { min: 0, max: MAX_DEPTH, fallback: DEFAULT_DEPTH });
  const include = patternsArg(args, "include");
  const exclude = patternsArg(args, "exclude");
  const allowPaid = boolArg(args, "allow_paid_fallback");
  const pageChars = intArg(args, "max_chars_per_page", { min: 1, max: 5_000_000, fallback: DEFAULT_PAGE_CHARS });

  // Refuse a start URL the SSRF guard would refuse before anything else, so
  // the agent hears why instead of an empty crawl.
  await validateFetchUrl(start, runtime.net.hooks);

  const started = runtime.now();
  const pages: CrawledPage[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>([start.href]);
  const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }];
  let site = start;
  let requested = 0;
  let paid = 0;
  let filtered = 0;
  let deepest = 0;
  let refusalsInARow = 0;
  let stopped: "done" | "limit" | "site_protected" = "done";

  const keep = (url: string, title: string, markdown: string, source: CrawledPage["source"]): void => {
    const cut = clip(markdown, pageChars);
    pages.push({ url, title, markdown: cut.text, source, ...(cut.truncated ? { truncated: true as const } : {}) });
  };

  for (let next = 0; next < queue.length; next++) {
    if (requested >= limit) {
      stopped = "limit";
      break;
    }
    if (refusalsInARow >= BLOCKED_IN_A_ROW) {
      stopped = "site_protected";
      break;
    }
    const { url, depth } = queue[next];

    const robots = await runtime.robots(url.origin);
    if (!robots.rules.allowed(url)) {
      skipped.push({ url: url.href, reason: robots.state === "unreachable" ? "robots_unreachable" : "robots_disallowed" });
      continue;
    }

    requested++;
    let read: DirectRead;
    try {
      read = await readPage(runtime.net, url.href);
    } catch (error) {
      skipped.push({ url: url.href, reason: "fetch_failed", detail: (error as Error).message });
      continue;
    }

    const landed = pageUrl(read.finalUrl)!;
    if (next === 0) site = landed;
    if (landed.href !== url.href) {
      if (!sameSite(landed, site)) {
        skipped.push({ url: url.href, reason: "redirected_off_site", detail: landed.href });
        continue;
      }
      // Two links that redirect to one page are one page.
      if (seen.has(landed.href)) continue;
      seen.add(landed.href);
      // The rules that count are those of the place the redirect led to.
      if (!(await runtime.robots(landed.origin)).rules.allowed(landed)) {
        skipped.push({ url: landed.href, reason: "robots_disallowed", detail: `redirected from ${url.href}` });
        continue;
      }
    }
    deepest = Math.max(deepest, depth);

    if (read.problem) {
      const { reason, detail, fallback } = read.problem;
      // Any other answer, a 404 included, shows the site is still talking to us.
      refusalsInARow = REFUSALS.has(reason) ? refusalsInARow + 1 : 0;
      if (!fallback) {
        skipped.push({ url: landed.href, reason, detail });
      } else if (!allowPaid || !runtime.config.fallback) {
        skipped.push({ url: landed.href, reason: "needs_fallback", detail: `${reason}: ${detail}` });
      } else if (paid >= runtime.config.maxPaidPages) {
        skipped.push({
          url: landed.href,
          reason: "paid_cap_reached",
          detail: `${reason}: ${detail} This crawl already sent ${paid} pages to the paid tool (max_paid_pages).`,
        });
      } else {
        paid++;
        const bought = await readThroughFallback(runtime.core, runtime.config, landed.href, context);
        if (bought.ok) keep(landed.href, bought.title ?? "", bought.markdown, "paid");
        else skipped.push({ url: landed.href, reason: "paid_fallback_failed", detail: `${reason}; ${bought.error}` });
      }
      continue;
    }

    refusalsInARow = 0;
    keep(landed.href, read.html?.title ?? "", read.html ? read.html.markdown() : read.body, "direct");

    if (depth >= maxDepth) continue;
    for (const link of read.html?.links ?? []) {
      const target = pageUrl(link);
      if (!target || seen.has(target.href) || !sameSite(target, site)) continue;
      seen.add(target.href);
      if (!looksLikePage(target) || !pathAllowed(target, include, exclude)) {
        filtered++;
        continue;
      }
      queue.push({ url: target, depth: depth + 1 });
    }
  }

  const direct = pages.filter((page) => page.source === "direct").length;
  const stats = {
    requested,
    pages: pages.length,
    direct,
    paid: pages.length - direct,
    paid_attempts: paid,
    skipped: skipped.length,
    filtered_links: filtered,
    depth_reached: deepest,
    stopped,
    limit,
    max_depth: maxDepth,
    delay_ms: runtime.config.delayMs,
    duration_ms: runtime.now() - started,
  };
  const ok = pages.length > 0;
  return {
    ok,
    pages: direct,
    error: ok ? undefined : `no pages read; first skip: ${skipped[0]?.reason ?? "none"}`,
    result: jsonResult({ pages, skipped, stats }, undefined, !ok),
  };
};

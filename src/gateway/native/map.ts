import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { boolArg, intArg, urlArg } from "./args.js";
import { decodeBody, fetchUrl } from "./http.js";
import { readPage } from "./read.js";
import { jsonResult, type NativeHandler } from "./runtime.js";
import { parseSitemap, unpackIfGzip } from "./sitemap.js";
import { pageUrl, sameSite } from "./urls.js";

export const MAP_TOOL = "coldsearch_map";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;
/** Most sitemap files one call reads, however many an index lists. */
const MAX_SITEMAP_FILES = 20;
const SITEMAP_MAX_BYTES = 20 * 1024 * 1024;

export const mapTool: Tool = {
  name: MAP_TOOL,
  description:
    `List the URLs of a site without paying a provider: use this before any provider map tool, and before a crawl, to choose which pages to read. The gateway reads the site's robots.txt and sitemaps (sitemap indexes and .gz files included). Only when the site publishes no sitemap does it fetch the given page and return the same-site links found there. It finds what the site lists or links, not pages only a search index knows about, and it does not run JavaScript, so a page whose links are drawn by script yields few. Returns JSON: source ("sitemap" or "links"), urls, truncated.`,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Any http or https URL on the site." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most URLs to return (default ${DEFAULT_LIMIT}).` },
      include_subdomains: { type: "boolean", description: "Also return URLs on subdomains of the given URL's host. Default false." },
    },
    required: ["url"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export const runMap: NativeHandler = async (runtime, args) => {
  const site = urlArg(args, "url");
  const limit = intArg(args, "limit", { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
  const includeSubdomains = boolArg(args, "include_subdomains");

  const urls = new Set<string>();
  const notes: string[] = [];
  let truncated = false;
  const add = (candidate: string, base?: string): void => {
    const url = pageUrl(candidate, base);
    if (!url || !sameSite(url, site, includeSubdomains)) return;
    if (urls.size >= limit) truncated ||= !urls.has(url.href);
    else urls.add(url.href);
  };

  const robots = await runtime.robots(site.origin);
  const queue = robots.rules.sitemaps.length > 0 ? [...robots.rules.sitemaps] : [`${site.origin}/sitemap.xml`];
  const read: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0 && !truncated) {
    const location = pageUrl(queue.shift()!, site)?.href;
    if (!location || visited.has(location)) continue;
    if (visited.size >= MAX_SITEMAP_FILES) {
      notes.push(`Stopped after ${MAX_SITEMAP_FILES} sitemap files; more are listed.`);
      truncated = true;
      break;
    }
    visited.add(location);
    try {
      const fetched = await fetchUrl(runtime.net, location, { maxBytes: SITEMAP_MAX_BYTES, wantBody: () => true });
      if (fetched.status < 200 || fetched.status >= 300) {
        // A site with no sitemap answers 404 here; that is the ordinary case, not a note.
        if (fetched.status !== 404) notes.push(`${location}: HTTP ${fetched.status}`);
        continue;
      }
      const body = await unpackIfGzip(fetched.body, SITEMAP_MAX_BYTES);
      const sitemap = parseSitemap(decodeBody(body, {}));
      read.push(location);
      if (sitemap.kind === "index") queue.push(...sitemap.locs);
      else for (const loc of sitemap.locs) add(loc);
    } catch (error) {
      notes.push(`${location}: ${(error as Error).message}`);
    }
  }

  let source: "sitemap" | "links" = "sitemap";
  if (urls.size === 0) {
    source = "links";
    const page = await readPage(runtime.net, site.href);
    if (page.problem) {
      const { reason, detail } = page.problem;
      return {
        ok: false,
        error: `no sitemap; page ${reason}`,
        result: jsonResult(
          { url: site.href, error: reason, detail: `The site lists no sitemap, and its page could not be read for links. ${detail}`, notes },
          undefined,
          true
        ),
      };
    }
    add(page.finalUrl);
    for (const link of page.html?.links ?? []) add(link);
  }

  return {
    ok: true,
    result: jsonResult({
      url: site.href,
      source,
      ...(read.length > 0 ? { sitemaps: read } : {}),
      urls: [...urls],
      returned: urls.size,
      truncated,
      ...(notes.length > 0 ? { notes } : {}),
    }),
  };
};

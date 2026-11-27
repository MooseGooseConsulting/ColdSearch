import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FALLBACK_URL_PLACEHOLDER, type NativeConfig } from "../config.js";
import type { CallContext, GatewayCore } from "../core.js";
import { pageUrl } from "./urls.js";

/** A page read through the configured paid tool, or why that did not work. */
export type PaidRead = { ok: true; markdown: string; title?: string; tool: string } | { ok: false; error: string };

function fill(template: unknown, url: string): unknown {
  if (typeof template === "string") return template.split(FALLBACK_URL_PLACEHOLDER).join(url);
  if (Array.isArray(template)) return template.map((item) => fill(item, url));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fill(value, url)]));
  }
  return template;
}

/** The first string stored under one of `keys`, nearest the top of `value` first. */
function findString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    let level: unknown[] = [value];
    for (let depth = 0; depth < 5 && level.length > 0; depth++) {
      const next: unknown[] = [];
      for (const item of level) {
        if (!item || typeof item !== "object") continue;
        if (!Array.isArray(item)) {
          const found = (item as Record<string, unknown>)[key];
          if (typeof found === "string" && found.trim()) return found;
        }
        next.push(...Object.values(item));
      }
      level = next;
    }
  }
  return undefined;
}

/**
 * Read one URL through the tool named in `[gateway.native] fallback`. The
 * call goes through GatewayCore.callTool, so it uses the upstream's key
 * order, moves to the next key on an exhausted one, and writes its own ledger
 * line under the upstream's name. Providers answer in different shapes: when
 * the result is JSON, the page is the first `markdown`, `raw_content`,
 * `content` or `text` string in it; otherwise the result text is the page.
 */
export async function readThroughFallback(
  core: GatewayCore,
  config: NativeConfig,
  url: string,
  context: CallContext
): Promise<PaidRead> {
  const tool = config.fallback;
  if (!tool) return { ok: false, error: "no paid fallback is configured ([gateway.native] fallback)" };

  const args = fill(config.fallbackArguments, url) as Record<string, unknown>;
  // The operator named this tool for the gateway's own use; an include or
  // exclude list that hides it from agents does not stop the gateway.
  const result: CallToolResult = await core.callTool(tool, args, context, { includeHidden: true });
  const text = (result.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n").trim();
  if (result.isError) return { ok: false, error: `${tool} failed: ${text.slice(0, 500)}` };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text ? { ok: true, markdown: text, tool } : { ok: false, error: `${tool} returned nothing` };
  }
  const markdown = findString(parsed, ["markdown", "raw_content", "content", "text"]);
  if (!markdown) {
    return { ok: false, error: `${tool} returned no page content: ${text.slice(0, 500)}` };
  }
  return { ok: true, markdown, title: findString(parsed, ["title"]), tool };
}

/**
 * The targets of the inline links (`[words](target)`) in markdown a paid tool
 * returned, as absolute http(s) URLs without fragments, once each, in order.
 * A crawl follows these from a page it had to buy, as it follows the <a>
 * elements of a page it read itself. Image targets come back too; the crawl
 * drops those that end like a file. Reference-style links and bare URLs are
 * not read.
 */
export function markdownLinks(markdown: string, base: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let at = markdown.indexOf("](");
  while (at !== -1) {
    // The target runs to its closing bracket, a space (a title follows) or the end of the line.
    let end = at + 2;
    let open = 0;
    for (; end < markdown.length; end++) {
      const char = markdown[end];
      if (char === " " || char === "\n" || char === "\t" || char === "\r") break;
      if (char === "(") open++;
      else if (char === ")" && open-- === 0) break;
    }
    let target = markdown.slice(at + 2, end);
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    const url = target ? pageUrl(target, base) : undefined;
    if (url && !seen.has(url.href)) {
      seen.add(url.href);
      links.push(url.href);
    }
    // Search on from where this target ended, so no character is read twice.
    at = markdown.indexOf("](", end);
  }
  return links;
}

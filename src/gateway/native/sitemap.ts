import { promisify } from "node:util";
import zlib from "node:zlib";

const gunzip = promisify(zlib.gunzip);

/** One sitemap file: either a list of pages or a list of further sitemap files. */
export interface SitemapFile {
  kind: "urlset" | "index";
  locs: string[];
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] !== "#") return XML_ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Read the <loc> entries of a sitemap or sitemap index. Extension elements
 * such as <image:loc> are not page locations and are left out. A body with no
 * markup is read as the plain-text form: one URL per line.
 */
export function parseSitemap(text: string): SitemapFile {
  if (!text.includes("<")) {
    return { kind: "urlset", locs: text.split(/\s+/).filter((line) => /^https?:\/\//i.test(line)) };
  }
  const locs: string[] = [];
  for (const match of text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
    locs.push(decodeXml(match[1]));
  }
  return { kind: /<sitemapindex[\s>]/i.test(text) ? "index" : "urlset", locs };
}

/**
 * Sitemaps are often served as .gz files, which is not a transfer encoding,
 * so the body arrives still compressed. Returns the body unpacked when it
 * starts with the gzip signature, unchanged otherwise. Throws when the
 * unpacked size would pass `maxBytes`.
 */
export async function unpackIfGzip(body: Buffer, maxBytes: number): Promise<Buffer> {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return body;
  return gunzip(body, { maxOutputLength: maxBytes });
}

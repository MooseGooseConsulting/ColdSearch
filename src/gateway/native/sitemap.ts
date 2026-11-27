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

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/**
 * The text of every <loc>…</loc> element, in document order. One pass over
 * the text, with no pattern that can back up: a sitemap is whatever the site
 * sends, and a search that backs up can be made to take hours by a body of a
 * few hundred bytes.
 */
function locValues(text: string): string[] {
  const values: string[] = [];
  const open = /<loc>/gi;
  while (open.exec(text)) {
    const start = open.lastIndex;
    const tag = text.indexOf("<", start);
    if (tag === -1) break;

    let value: string;
    let close = tag;
    if (text.startsWith(CDATA_OPEN, tag) && !text.slice(start, tag).trim()) {
      const end = text.indexOf(CDATA_CLOSE, tag + CDATA_OPEN.length);
      // An unclosed CDATA section swallows the rest of the document.
      if (end === -1) break;
      value = text.slice(tag + CDATA_OPEN.length, end);
      // Whatever sits inside the section is its text, a "<loc>" included: search on from its end.
      open.lastIndex = end + CDATA_CLOSE.length;
      close = text.indexOf("<", open.lastIndex);
      if (close === -1) break;
      if (text.slice(open.lastIndex, close).trim()) continue;
    } else {
      value = text.slice(start, tag);
    }
    if (text.slice(close, close + "</loc>".length).toLowerCase() !== "</loc>") continue;
    value = value.trim();
    if (value) values.push(value);
  }
  return values;
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
  return { kind: /<sitemapindex[\s>]/i.test(text) ? "index" : "urlset", locs: locValues(text).map(decodeXml) };
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

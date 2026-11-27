import { matchesPattern } from "../config.js";

/** Parse an http(s) URL and drop its fragment; undefined for anything else. */
export function pageUrl(value: string | URL, base?: string | URL): URL | undefined {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function siteHost(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

/**
 * Whether `candidate` belongs to the same site as `site`: the same hostname
 * (a leading "www." ignored, http and https treated alike) and port. With
 * `includeSubdomains`, hostnames under the site's hostname count too:
 * docs.example.com is on the site of example.com, but not the reverse.
 */
export function sameSite(candidate: URL, site: URL, includeSubdomains = false): boolean {
  if (candidate.port !== site.port) return false;
  const host = siteHost(candidate);
  const root = siteHost(site);
  return host === root || (includeSubdomains && host.endsWith(`.${root}`));
}

/** File types a crawl does not request: they are not pages. */
const NOT_A_PAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|css|js|mjs|map|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|webm|ogg|wav|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|exe|msi|deb|rpm|apk|iso|bin|pdf|docx?|xlsx?|pptx?|epub)$/i;

export function looksLikePage(url: URL): boolean {
  return !NOT_A_PAGE.test(url.pathname);
}

/**
 * Apply a crawl's `include` and `exclude` lists to a URL's path. A pattern
 * matches the whole path; `*` stands for any run of characters, slashes
 * included, so "/docs/*" covers everything under /docs/.
 */
export function pathAllowed(url: URL, include: string[], exclude: string[]): boolean {
  if (exclude.some((pattern) => matchesPattern(url.pathname, pattern))) return false;
  return include.length === 0 || include.some((pattern) => matchesPattern(url.pathname, pattern));
}

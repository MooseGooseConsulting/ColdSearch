/**
 * robots.txt as RFC 9309 describes it: groups of rules per user agent, the
 * longest matching rule decides, Allow wins a tie, and `*` and `$` are the
 * only special characters.
 */
export interface RobotsRules {
  /** Whether the rules for this gateway's user agent let it request the URL. */
  allowed(url: URL): boolean;
  /** Every `Sitemap:` line, whichever group it sits in. */
  sitemaps: string[];
}

interface Rule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true, sitemaps: [] };
export const DISALLOW_ALL: RobotsRules = { allowed: (url) => url.pathname === "/robots.txt", sitemaps: [] };

function ruleMatcher(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

/**
 * Parse a robots.txt body for one crawler. `agent` is the crawler's product
 * token ("coldsearch"). Groups naming it are used when there are any;
 * otherwise the `*` groups; with neither, everything is allowed.
 */
export function parseRobots(text: string, agent: string): RobotsRules {
  const token = agent.toLowerCase();
  const groups = new Map<string, Rule[]>();
  const sitemaps: string[] = [];
  let current: string[] = [];
  let inAgentLines = false;

  for (const rawLine of text.split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (field === "user-agent") {
      // Consecutive User-agent lines share one group; one after rules starts the next.
      if (!inAgentLines) current = [];
      inAgentLines = true;
      const name = value.toLowerCase().split("/")[0];
      current.push(name);
      if (!groups.has(name)) groups.set(name, []);
    } else if (field === "allow" || field === "disallow") {
      inAgentLines = false;
      if (!value) continue; // "Disallow:" with nothing after it disallows nothing.
      for (const name of current) {
        groups.get(name)!.push({ allow: field === "allow", pattern: value, matcher: ruleMatcher(value) });
      }
    } else {
      inAgentLines = false;
    }
  }

  const rules = groups.get(token) ?? groups.get("*") ?? [];
  return {
    sitemaps,
    allowed(url: URL): boolean {
      const path = `${url.pathname}${url.search}`;
      if (url.pathname === "/robots.txt") return true;
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!rule.matcher.test(path)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

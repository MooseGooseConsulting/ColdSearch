import { globMatch } from "../glob.js";

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
  /** The pattern as a whole-path glob: the `$` anchor removed, or `*` added when the rule is a prefix. */
  glob: string;
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true, sitemaps: [] };
export const DISALLOW_ALL: RobotsRules = { allowed: (url) => url.pathname === "/robots.txt", sitemaps: [] };

/**
 * Longest path and query a rule is matched against. Matching costs time in
 * proportion to path length times rule length, and both are the site's to
 * choose: its robots.txt and its links. Past this length a URL is not
 * requested when the site has any rules at all, since they cannot be checked.
 */
const MAX_MATCHED_PATH = 4096;

/** A rule matches from the start of the path; `$` at its end means it must also reach the end. */
function ruleGlob(pattern: string): string {
  return pattern.endsWith("$") ? pattern.slice(0, -1) : `${pattern}*`;
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
    // A comment runs from "#" to the end of the line.
    const hash = rawLine.indexOf("#");
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
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
        groups.get(name)!.push({ allow: field === "allow", pattern: value, glob: ruleGlob(value) });
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
      if (path.length > MAX_MATCHED_PATH) return rules.length === 0;
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!globMatch(path, rule.glob)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

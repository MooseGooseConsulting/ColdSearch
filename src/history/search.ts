import type { ExecutionRecord } from "./types.js";

/**
 * Why an execution matched a `history search` query.
 * Ordered strongest-weakest; the first tier that matches also ranks the hit.
 */
export type HistoryMatchReason =
  | "run_id"
  | "request"
  | "result_title"
  | "result_url"
  | "content"
  | "provider";

export interface MatchingResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface HistorySearchMatch {
  execution: ExecutionRecord;
  matched_on: HistoryMatchReason[];
  /** Stored results that caused the match (bounded), when results matched. */
  matching_results?: MatchingResultItem[];
}

const REASON_ORDER: HistoryMatchReason[] = [
  "run_id",
  "request",
  "result_title",
  "result_url",
  "content",
  "provider",
];

const MAX_MATCHING_RESULTS = 5;

/**
 * Normalized stored results for match scanning: final output plus pre-merge
 * partitions (search), the extracted document (extract), or crawled pages
 * (crawl). Tool calls preserve raw provider payloads, which are intentionally
 * NOT indexed here.
 */
interface ScannedResult {
  title?: string;
  url?: string;
  text?: string;
}

function collectResults(record: ExecutionRecord): ScannedResult[] {
  const out: ScannedResult[] = [];

  const push = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    out.push({
      title: typeof item.title === "string" ? item.title : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      text:
        (typeof item.snippet === "string" ? item.snippet : undefined) ??
        (typeof item.content === "string" ? item.content : undefined),
    });
  };

  if (record.command === "agent" && typeof record.result === "string") {
    // Agent answers are persisted as redacted text, so index them as content
    // without treating step payloads or arbitrary string results as documents.
    out.push({ text: record.result });
  } else if (Array.isArray(record.result)) {
    for (const item of record.result) push(item);
  } else {
    push(record.result);
  }

  if (record.partitions) {
    for (const results of Object.values(record.partitions)) {
      if (Array.isArray(results)) {
        for (const item of results) push(item);
      }
    }
  }

  return out;
}

/**
 * Local-only retrieval over execution records. Makes zero provider/network
 * calls; raw provider JSON is not indexed by default.
 *
 * Match semantics: for request/options and result text (titles, URLs,
 * snippets/content) every whitespace-separated term of the query must appear
 * (case-insensitive substring); provider/tool metadata matches when any query
 * term appears in a provider/tool name. Executions are ranked by strongest
 * matching tier, then recency. The result set is bounded by `limit`.
 */
export function searchHistory(
  records: ExecutionRecord[],
  query: string,
  limit = 20
): HistorySearchMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const matchesAll = (text: string | undefined): boolean => {
    if (!text) return false;
    const haystack = text.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const exactRunIdQuery = query.trim().toLowerCase();

  const matches: { match: HistorySearchMatch; rank: number }[] = [];

  for (const record of records) {
    const reasons = new Set<HistoryMatchReason>();
    const matchingResults: MatchingResultItem[] = [];

    // Run IDs are exact correlation keys and rank ahead of broader text matches.
    if (
      exactRunIdQuery.length > 0 &&
      record.run_id?.trim().toLowerCase() === exactRunIdQuery
    ) {
      reasons.add("run_id");
    }

    // Original request/query or URL (plus request parameters).
    if (
      matchesAll(record.input) ||
      (record.options !== undefined && matchesAll(JSON.stringify(record.options)))
    ) {
      reasons.add("request");
    }

    // 2/3/4. stored normalized results: titles, URLs/domains, snippets/content
    for (const result of collectResults(record)) {
      let hit = false;
      if (matchesAll(result.title)) {
        reasons.add("result_title");
        hit = true;
      }
      if (matchesAll(result.url)) {
        reasons.add("result_url");
        hit = true;
      }
      if (matchesAll(result.text)) {
        reasons.add("content");
        hit = true;
      }
      if (hit && matchingResults.length < MAX_MATCHING_RESULTS) {
        matchingResults.push({
          title: result.title,
          url: result.url,
          snippet: result.text?.slice(0, 200),
        });
      }
    }

    // 5. provider/tool metadata. Provider names are short identifiers, so a
    // single query term hitting one is a match even when other terms matched
    // elsewhere; requiring every term inside a provider name would make this
    // dimension useless for multi-word queries.
    const providerTerms = [
      ...(record.routing?.providers_attempted ?? []),
      ...record.attempts.map((attempt) =>
        attempt.tool ? `${attempt.provider}.${attempt.tool}` : attempt.provider
      ),
    ];
    if (
      providerTerms.some((name) =>
        terms.some((term) => name.toLowerCase().includes(term))
      )
    ) {
      reasons.add("provider");
    }

    if (reasons.size === 0) continue;

    const matched_on = REASON_ORDER.filter((reason) => reasons.has(reason));
    matches.push({
      rank: REASON_ORDER.indexOf(matched_on[0]),
      match: {
        execution: record,
        matched_on,
        matching_results: matchingResults.length > 0 ? matchingResults : undefined,
      },
    });
  }

  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Recency breaks otherwise similar matches; no relevance scoring system.
    return b.match.execution.timestamp.localeCompare(a.match.execution.timestamp);
  });

  return matches.slice(0, Math.max(0, limit)).map((entry) => entry.match);
}

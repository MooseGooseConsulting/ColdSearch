import { fetchJson } from "../http.js";
import type {
  SearchAdapter,
  NormalizedResult,
  AdapterCallOptions,
} from "../types.js";

/**
 * Brave Search API response types
 */
interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  relevance_score?: number;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

const BRAVE_SAFESEARCH_VALUES: readonly string[] = ["off", "moderate", "strict"];

/** Clamp a configured integer option into [min, max], defaulting when absent/invalid. */
function clampIntegerOption(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Brave Search adapter.
 * Uses Brave's Web Search API directly.
 * @see https://api.search.brave.com/app/documentation/web-search/get-started
 */
export class BraveAdapter implements SearchAdapter {
  name = "brave";
  capabilities: SearchAdapter["capabilities"] = ["search"];

  async search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    const count = typeof options?.limit === "number" && Number.isFinite(options.limit)
      ? Math.min(20, Math.max(1, Math.floor(options.limit)))
      : clampIntegerOption(options?.providerOptions?.count, 1, 20, 10);
    url.searchParams.set("q", query);
    // Brave caps `count` at 20 results per request.
    url.searchParams.set("count", String(count));
    url.searchParams.set("offset", "0");

    const safesearch = options?.providerOptions?.safesearch;
    if (
      typeof safesearch === "string" &&
      BRAVE_SAFESEARCH_VALUES.includes(safesearch)
    ) {
      url.searchParams.set("safesearch", safesearch);
    }

    const data = await fetchJson<BraveSearchResponse>(url.toString(), {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    }, {
      label: "Brave search",
    });

    // Normalize Brave results to shared schema
    return (data.web?.results || []).map((result, index) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.description || "",
      // Brave scores are 0-1 when available, otherwise fall back to
      // position-based with a 0.1 floor so deep ranks never go negative.
      score: result.relevance_score ?? Math.max(0.1, 1 - index * 0.1),
      source: this.name,
    }));
  }
}

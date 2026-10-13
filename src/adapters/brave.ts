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
      ? Math.max(1, Math.floor(options.limit))
      : 10;
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("offset", "0");

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
      // Brave scores are 0-1 when available, otherwise fall back to position-based
      score: result.relevance_score ?? (1 - index * 0.1),
      source: this.name,
    }));
  }
}

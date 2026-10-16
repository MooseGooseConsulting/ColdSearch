import { fetchJson } from "../http.js";
import type {
  SearchAdapter,
  NormalizedResult,
  AdapterCallOptions,
} from "../types.js";

/**
 * SearXNG search adapter.
 * Implements the SearchAdapter interface for an operator-managed SearXNG instance.
 * No API key is required; the provider is configured by endpoint.
 */
export class SearXNGAdapter implements SearchAdapter {
  name = "searxng";
  capabilities: SearchAdapter["capabilities"] = ["search"];

  async search(
    query: string,
    _apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const configuredBaseUrl = options?.providerOptions?.baseUrl;
    const baseUrl = typeof configuredBaseUrl === "string"
      ? configuredBaseUrl
      : process.env.SEARXNG_BASE_URL;

    if (!baseUrl) {
      throw new Error(
        "SearXNG requires providers.searxng.options.baseUrl or SEARXNG_BASE_URL"
      );
    }

    const endpointBase = new URL(baseUrl);
    endpointBase.pathname = endpointBase.pathname.endsWith("/")
      ? endpointBase.pathname
      : `${endpointBase.pathname}/`;

    const searchUrl = new URL("search", endpointBase);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");

    // Optional SearXNG query params, sent only when configured.
    const providerOptions = options?.providerOptions ?? {};
    for (const key of [
      "categories",
      "engines",
      "language",
      "pageno",
      "time_range",
      "safesearch",
      "theme",
    ] as const) {
      const value = providerOptions[key];
      if (value === undefined || value === null) continue;
      searchUrl.searchParams.set(key, String(value));
    }

    const data = await fetchJson<{
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        engine?: string;
      }>;
    }>(searchUrl.toString(), {}, {
      label: "SearXNG search",
    });

    // Normalize SearXNG results to the shared schema
    return (data.results || []).map((result, index) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.content || "",
      // SearXNG scores are relative; use a descending fallback if unavailable
      score: result.score ?? Math.max(0.1, 1 - index * 0.05),
      source: this.name,
    }));
  }
}

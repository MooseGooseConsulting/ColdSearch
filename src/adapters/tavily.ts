import { fetchJson } from "../http.js";
import type {
  SearchAdapter,
  NormalizedResult,
  ExtractResult,
  CrawlResult,
  AdapterCallOptions,
  CrawlCallOptions,
} from "../types.js";

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
}

interface TavilyExtractResponse {
  results?: Array<{
    title?: string;
    url?: string;
    rawContent?: string;
    raw_content?: string;
  }>;
  failed_results?: Array<{ error?: string; reason?: string }>;
  failedResults?: Array<{ error?: string; reason?: string }>;
}

interface TavilyCrawlResponse {
  results?: Array<{
    title?: string;
    url?: string;
    rawContent?: string;
    raw_content?: string;
  }>;
}

/**
 * Tavily search adapter.
 * Implements the SearchAdapter interface for Tavily's search API.
 * Also supports extract and crawl capabilities.
 */
export class TavilyAdapter implements SearchAdapter {
  name = "tavily";
  capabilities: SearchAdapter["capabilities"] = ["search", "extract", "crawl"];
  private readonly baseUrl = "https://api.tavily.com";

  private sanitizeCrawlLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return 10;
    }

    // Tavily's crawl `limit` is a link-processing budget, not search's
    // `max_results` field; do not apply the search endpoint's 20-result cap.
    return Math.max(1, Math.floor(limit));
  }

  /** Clamp a configured integer option into [min, max], defaulting when absent/invalid. */
  private clampIntegerOption(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  }

  async search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const providerOptions = options?.providerOptions ?? {};
    const requestedIncludeAnswer = providerOptions.include_answer;
    const includeAnswerRequested =
      requestedIncludeAnswer === true ||
      requestedIncludeAnswer === "basic" ||
      requestedIncludeAnswer === "advanced";
    if (includeAnswerRequested) {
      throw new Error(
        "Tavily search synthesis cannot be represented in normalized search results; " +
          "use the Tavily answer tool for include_answer output."
      );
    }

    const requestedDepth = providerOptions.search_depth;
    const searchDepth = ["basic", "advanced", "fast", "ultra-fast"].includes(
      String(requestedDepth)
    )
      ? String(requestedDepth)
      : "basic";

    const body: Record<string, unknown> = {
      query,
      max_results: this.clampIntegerOption(
        options?.limit ?? providerOptions.max_results,
        0,
        20,
        10
      ),
      search_depth: searchDepth,
      include_answer: false,
    };
    if (typeof providerOptions.topic === "string" && providerOptions.topic.trim()) {
      body.topic = providerOptions.topic.trim();
    }
    if (typeof providerOptions.time_range === "string" && providerOptions.time_range.trim()) {
      body.time_range = providerOptions.time_range.trim();
    }

    const response = await fetchJson<TavilySearchResponse>(
      `${this.baseUrl}/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { label: "Tavily search" }
    );

    // Normalize Tavily results to the shared schema
    return (response.results || []).map((result, index) => ({
      title: result.title || "",
      url: result.url || "",
      snippet: result.content || "",
      // Tavily scores are 0-1, higher is better
      score: result.score ?? Math.max(0.1, 1 - index * 0.1),
      source: this.name,
    }));
  }

  async extract(
    url: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<ExtractResult> {
    const providerOptions = options?.providerOptions ?? {};

    const body: Record<string, unknown> = {
      urls: [url],
      include_images: false,
    };
    const format = options?.format ?? providerOptions.format;
    if (format === "markdown" || format === "text") {
      body.format = format;
    }
    if (providerOptions.extract_depth === "basic" || providerOptions.extract_depth === "advanced") {
      body.extract_depth = providerOptions.extract_depth;
    }

    const response = await fetchJson<TavilyExtractResponse>(
      `${this.baseUrl}/extract`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          ...body,
          format:
            options?.format === "text" || options?.format === "markdown"
              ? options.format
              : providerOptions.format === "text"
                ? "text"
                : "markdown",
        }),
      },
      { label: "Tavily extract" }
    );

    const result = response.results?.[0];
    if (!result) {
      const failed = response.failed_results?.[0] ?? response.failedResults?.[0];
      const reason = failed?.error ?? failed?.reason;
      throw new Error(
        reason
          ? `Failed to extract content from ${url}: ${reason}`
          : `Failed to extract content from ${url}`
      );
    }

    return {
      content: result.rawContent || result.raw_content || "",
      url: result.url || url,
      title: result.title || "",
      source: this.name,
    };
  }

  async crawl(
    url: string,
    apiKey: string,
    options?: CrawlCallOptions
  ): Promise<CrawlResult[]> {
    // Validate URL
    if (!url || !url.trim()) {
      throw new Error("URL is required");
    }

    const limit = this.sanitizeCrawlLimit(options?.limit);
    const depth = options?.depth;
    const normalizedUrl = url.trim();

    const response = await fetchJson<TavilyCrawlResponse>(
      `${this.baseUrl}/crawl`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          url: normalizedUrl,
          // Tavily's crawl cap is `limit` (total links processed); the legacy
          // `max_results` name is silently ignored upstream.
          limit,
          extract_depth: "basic",
          ...(depth !== undefined
            ? { max_depth: this.clampIntegerOption(depth, 1, 5, 1) }
            : {}),
        }),
      },
      { label: "Tavily crawl", timeoutMs: 120_000 }
    );

    return (response.results || []).map((result) => ({
      url: result.url || "",
      title: result.title || "",
      content: result.rawContent || result.raw_content || "",
    }));
  }
}

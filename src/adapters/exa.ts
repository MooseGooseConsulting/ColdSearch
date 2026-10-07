import { fetchJson } from "../http.js";
import type {
  SearchAdapter,
  NormalizedResult,
  ExtractResult,
  AdapterCallOptions,
  CrawlResult,
  CrawlCallOptions,
} from "../types.js";

/**
 * Exa provider-specific options (configured in config.toml under [providers.exa.options])
 */
interface ExaProviderOptions {
  /** Use highlights (token-efficient excerpts) instead of full text. Default: false */
  highlights?: boolean;
  /** Max characters for text content. Default: 15000 */
  maxCharacters?: number;
  /**
   * Category filter. Exa's first-class categories are space-separated:
   * "company", "people", "research paper", "news", "personal site",
   * "financial report". Other strings are accepted as category hints.
   */
  category?: string;
  /**
   * Search type. Current upstream enum is
   * auto (default) | fast | instant | deep-lite | deep | deep-reasoning;
   * the retired keyword/neural modes were removed from the API.
   */
  searchType?: "auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning";
  /** Max age of indexed content in hours. 0 = always livecrawl, -1 = never livecrawl */
  maxAgeHours?: number;
  /** Domains to include in search results */
  includeDomains?: string[];
  /** Domains to exclude from search results */
  excludeDomains?: string[];
  /** Number of results. Default: 10 */
  numResults?: number;
}

/**
 * Exa API response types
 */
interface ExaSearchResult {
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  highlights?: string[];
  publishedDate?: string;
  author?: string;
}

interface ExaSearchResponse {
  results?: ExaSearchResult[];
  costDollars?: {
    total: number;
    breakDown: Record<string, number>;
  };
}

interface ExaContentsResult {
  title?: string;
  url?: string;
  text?: string;
  publishedDate?: string;
  author?: string;
}

interface ExaContentsResponse {
  results?: ExaContentsResult[];
}

interface ExaFindSimilarResponse {
  results?: Array<{
    title?: string;
    url?: string;
    score?: number;
    text?: string;
    highlights?: string[];
  }>;
}

/**
 * Exa (formerly Metaphor) search adapter.
 * Uses Exa's REST API directly.
 * @see https://docs.exa.ai/reference/getting-started
 *
 * Provider options are configured in config.toml:
 * ```toml
 * [providers.exa.options]
 * highlights = true        # Token-efficient mode for agents
 * searchType = "fast"      # Lower latency
 * category = "company"     # Use specialized indexes
 * maxAgeHours = 24         # Cache freshness
 * ```
 */
export class ExaAdapter implements SearchAdapter {
  name = "exa";
  capabilities: SearchAdapter["capabilities"] = ["search", "extract", "crawl"];

  /**
   * Extract Exa-specific options from adapter call options
   */
  private getExaOptions(options?: AdapterCallOptions): ExaProviderOptions {
    return (options?.providerOptions as ExaProviderOptions) || {};
  }

  /**
   * Build the request body for Exa search
   */
  private buildSearchBody(
    query: string,
    opts: ExaProviderOptions
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      query,
      numResults: opts.numResults ?? 10,
      // `useAutoprompt` was retired upstream; `type` selects the search mode.
      type: opts.searchType ?? "auto",
    };

    // Category filter
    if (opts.category) {
      body.category = opts.category;
    }

    // Content mode: highlights (token-efficient) vs full text
    const contents: Record<string, unknown> = opts.highlights
      ? { highlights: true }
      : { text: { maxCharacters: opts.maxCharacters ?? 15000 } };

    // Freshness control. Exa expects maxAgeHours nested under `contents`, not at
    // the top level (0 = always livecrawl, -1 = never livecrawl).
    // See https://exa.ai/docs/reference/search.
    if (opts.maxAgeHours !== undefined) {
      contents.maxAgeHours = opts.maxAgeHours;
    }
    body.contents = contents;

    // Domain filters
    if (opts.includeDomains?.length) {
      body.includeDomains = opts.includeDomains;
    }
    if (opts.excludeDomains?.length) {
      body.excludeDomains = opts.excludeDomains;
    }

    return body;
  }

  async search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const opts = this.getExaOptions(options);
    const body = this.buildSearchBody(query, opts);

    const data = await fetchJson<ExaSearchResponse>(
      "https://api.exa.ai/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      },
      { label: "Exa search" }
    );

    // Normalize Exa results to shared schema
    return (data.results || []).map((result, index) => {
      // If highlights mode, join highlights into snippet; otherwise use text
      const snippet = opts.highlights && result.highlights?.length
        ? result.highlights.join(" ... ")
        : (result.text || "");

      return {
        title: result.title || "",
        url: result.url || "",
        snippet,
        // Exa scores are 0-1, higher is better; clamp fallback to [0, 1]
        score: result.score ?? Math.max(0, 1 - index * 0.1),
        source: this.name,
      };
    });
  }

  async extract(
    url: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<ExtractResult> {
    if (!url || !url.trim()) {
      throw new Error("URL is required");
    }

    const normalizedUrl = url.trim();
    const opts = this.getExaOptions(options);

    const extractBody: Record<string, unknown> = {
      urls: [normalizedUrl],
      text: { maxCharacters: opts.maxCharacters ?? 15000 },
      livecrawl: "preferred",
    };
    // Freshness control. On /contents, maxAgeHours is a top-level field
    // (0 = always livecrawl, -1 = never livecrawl). See https://exa.ai/docs/reference/get-contents.
    if (opts.maxAgeHours !== undefined) {
      extractBody.maxAgeHours = opts.maxAgeHours;
    }

    const data = await fetchJson<ExaContentsResponse>(
      "https://api.exa.ai/contents",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(extractBody),
      },
      { label: "Exa extract" }
    );

    const result = data.results?.[0];
    if (!result) {
      throw new Error(`Failed to extract content from ${url}`);
    }

    return {
      content: result.text || "",
      url: result.url || normalizedUrl,
      title: result.title || "",
      source: this.name,
    };
  }

  async crawl(
    url: string,
    apiKey: string,
    options?: CrawlCallOptions
  ): Promise<CrawlResult[]> {
    if (!url || !url.trim()) {
      throw new Error("URL is required");
    }

    const normalizedUrl = url.trim();
    const opts = this.getExaOptions(options);
    const rawLimit = options?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.floor(rawLimit))
        : opts.numResults ?? 10;

    let domain: string;
    try {
      domain = new URL(normalizedUrl).hostname;
    } catch {
      throw new Error(`Invalid crawl URL: ${normalizedUrl}`);
    }

    // Discover candidate pages via Exa search with configured options.
    // excludeDomains is cleared: combining it with includeDomains: [domain] would
    // be self-contradictory if the target domain appears in excludeDomains.
    const searchOpts: ExaProviderOptions = {
      ...opts,
      numResults: limit,
      includeDomains: [domain],
      excludeDomains: undefined,
    };
    const body = this.buildSearchBody(`site:${domain}`, searchOpts);

    const searchData = await fetchJson<ExaSearchResponse>(
      "https://api.exa.ai/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      },
      { label: "Exa crawl discover" }
    );

    const candidateUrls = [
      normalizedUrl,
      ...(searchData.results || [])
        .map((r) => r.url)
        .filter((candidate): candidate is string => !!candidate),
    ]
      .filter((candidate, idx, all) => all.indexOf(candidate) === idx)
      .slice(0, limit);

    const contents = await fetchJson<ExaContentsResponse>(
      "https://api.exa.ai/contents",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          urls: candidateUrls,
          text: { maxCharacters: opts.maxCharacters ?? 12000 },
          livecrawl: "preferred",
          // Exa's field is camelCase `livecrawlTimeout`; the snake_case
          // spelling is silently ignored upstream.
          livecrawlTimeout: 10000,
          ...(opts.maxAgeHours !== undefined
            ? { maxAgeHours: opts.maxAgeHours }
            : {}),
        }),
      },
      { label: "Exa crawl contents" }
    );

    return (contents.results || []).map((result) => ({
      url: result.url || "",
      title: result.title || "",
      content: result.text || "",
    }));
  }

  /**
   * Find similar URLs (Exa-unique capability).
   * Not exposed via the standard adapter interface yet, but available for future use.
   * @see https://docs.exa.ai/reference/find-similar
   */
  async findSimilar(
    url: string,
    apiKey: string,
    options?: AdapterCallOptions & { numResults?: number }
  ): Promise<NormalizedResult[]> {
    if (!url || !url.trim()) {
      throw new Error("URL is required");
    }

    const normalizedUrl = url.trim();
    const opts = this.getExaOptions(options);

    const data = await fetchJson<ExaFindSimilarResponse>(
      "https://api.exa.ai/findSimilar",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          url: normalizedUrl,
          numResults: options?.numResults ?? opts.numResults ?? 10,
          contents: opts.highlights
            ? { highlights: true }
            : { text: { maxCharacters: opts.maxCharacters ?? 15000 } },
        }),
      },
      { label: "Exa findSimilar" }
    );

    return (data.results || []).map((result, index) => {
      const snippet = opts.highlights && result.highlights?.length
        ? result.highlights.join(" ... ")
        : (result.text || "");
      return {
        title: result.title || "",
        url: result.url || "",
        snippet,
        score: result.score ?? Math.max(0, 1 - index * 0.1),
        source: this.name,
      };
    });
  }
}

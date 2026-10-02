import { fetchJson, HTTPRequestError, isQuotaExhausted } from "../http.js";
import type {
  SearchAdapter,
  ExtractResult,
  CrawlResult,
  NormalizedResult,
  AdapterCallOptions,
  CrawlCallOptions,
} from "../types.js";

/**
 * Firecrawl adapter.
 * Provides extract (scrape) and crawl capabilities.
 * @see https://docs.firecrawl.dev
 */
export class FirecrawlAdapter implements SearchAdapter {
  name = "firecrawl";
  capabilities: SearchAdapter["capabilities"] = ["search", "extract", "crawl"];
  private baseUrl = "https://api.firecrawl.dev/v2";

  async search(
    query: string,
    apiKey: string,
    _options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const data = await fetchJson<{
      success?: boolean;
      data?: {
        web?: Array<{
          title?: string;
          url?: string;
          description?: string;
          markdown?: string;
          score?: number;
          metadata?: {
            title?: string;
            description?: string;
            sourceURL?: string;
          };
        }>;
      };
      error?: string;
    }>(
      `${this.baseUrl}/search`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          limit: 10,
          scrapeOptions: {
            formats: ["markdown"],
          },
        }),
      },
      { label: "Firecrawl search" }
    );

    if (!data.success || data.error) {
      throw new Error(`Firecrawl error: ${data.error || "Unknown error"}`);
    }

    const results = data.data?.web || [];
    return results.map((result, index) => {
      const url = result.url || result.metadata?.sourceURL || "";
      const title = result.title || result.metadata?.title || "";
      const snippetSource = result.description || result.metadata?.description || result.markdown || "";
      const snippet = snippetSource.length > 500 ? `${snippetSource.slice(0, 497)}...` : snippetSource;

      return {
        title,
        url,
        snippet,
        score: result.score ?? Math.max(0.1, 1 - index * 0.1),
        source: this.name,
      };
    });
  }

  async extract(
    url: string,
    apiKey: string,
    _options?: AdapterCallOptions
  ): Promise<ExtractResult> {
    // Validate URL
    if (!url || !url.trim()) {
      throw new Error("URL is required");
    }

    const normalizedUrl = url.trim();

    const data = await fetchJson<{
      success?: boolean;
      data?: {
        markdown?: string;
        metadata?: {
          title?: string;
          sourceURL?: string;
        };
      };
      error?: string;
    }>(`${this.baseUrl}/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: normalizedUrl,
        formats: ["markdown"],
      }),
    }, {
      label: "Firecrawl extract",
    });

    if (!data.success || data.error) {
      throw new Error(`Firecrawl error: ${data.error || "Unknown error"}`);
    }

    return {
      content: data.data?.markdown || "",
      url: data.data?.metadata?.sourceURL || url,
      title: data.data?.metadata?.title || "",
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

    const normalizedUrl = url.trim();
    const rawLimit = options?.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.max(1, Math.floor(rawLimit))
        : 10;

    // Start crawl job
    const startData = await fetchJson<{
      success?: boolean;
      id?: string;
      error?: string;
    }>(`${this.baseUrl}/crawl`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: normalizedUrl,
        limit,
        scrapeOptions: {
          formats: ["markdown"],
        },
      }),
    }, {
      label: "Firecrawl crawl start",
    });

    if (!startData.success || !startData.id) {
      throw new Error(`Firecrawl crawl failed: ${startData.error || "No job ID"}`);
    }

    // Poll for completion
    const jobId = startData.id;
    const maxAttempts = 30;
    const pollInterval = 2000; // 2 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      let statusData: {
        success?: boolean;
        status?: "scraping" | "completed" | "failed";
        data?: Array<{
          markdown?: string;
          metadata?: {
            title?: string;
            sourceURL?: string;
          };
        }>;
        error?: string;
      };

      try {
        statusData = await fetchJson(`${this.baseUrl}/crawl/${jobId}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        }, {
          label: "Firecrawl crawl poll",
          retries: 0,
          timeoutMs: 5000,
        });
      } catch (error) {
        if (error instanceof HTTPRequestError) {
          const isTransientStatus =
            error.status === undefined ||
            error.status >= 500 ||
            error.status === 408 ||
            error.status === 429;

          if (!isTransientStatus || isQuotaExhausted(error)) {
            throw new Error(`Firecrawl crawl poll failed for job ${jobId}: ${error.message}`, { cause: error });
          }

          continue;
        }

        if (
          error instanceof Error &&
          (error.name === "TypeError" || error.name === "AbortError" || /timed out/i.test(error.message))
        ) {
          continue;
        }

        throw new Error(
          `Firecrawl crawl poll failed for job ${jobId}: ${(error as Error).message}`
        );
      }

      if (statusData.success === false || statusData.error) {
        throw new Error(`Firecrawl crawl failed for job ${jobId}: ${statusData.error || "Unknown error"}`);
      }

      if (statusData.status === "completed" && statusData.data) {
        return statusData.data.map((item) => ({
          url: item.metadata?.sourceURL || "",
          title: item.metadata?.title || "",
          content: item.markdown || "",
        }));
      }

      if (statusData.status === "failed") {
        throw new Error(`Firecrawl crawl failed: ${statusData.error || "Unknown error"}`);
      }
      // If still scraping, continue polling
    }

    throw new Error("Firecrawl crawl timed out");
  }
}

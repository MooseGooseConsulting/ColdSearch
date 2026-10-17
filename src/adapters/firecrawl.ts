import { fetchJson, HTTPRequestError, isQuotaExhausted } from "../http.js";
import type {
  SearchAdapter,
  ExtractResult,
  CrawlResult,
  NormalizedResult,
  AdapterCallOptions,
  CrawlCallOptions,
} from "../types.js";

/** Polling failed after Firecrawl accepted a job. The job may still be running. */
export class FirecrawlCrawlPollError extends Error {
  readonly jobId: string;

  constructor(jobId: string, detail: string, options?: { cause?: unknown }) {
    super(`Firecrawl crawl poll failed for job ${jobId}: ${detail}`, options);
    this.name = "FirecrawlCrawlPollError";
    this.jobId = jobId;
  }
}

/** The provider explicitly reported that an accepted crawl job is terminal. */
export class FirecrawlCrawlTerminalError extends Error {
  readonly jobId: string;

  constructor(jobId: string, detail: string, status: "failed" | "cancelled" = "failed") {
    super(
      status === "cancelled"
        ? `Firecrawl crawl job '${jobId}' was cancelled: ${detail}`
        : `Firecrawl crawl job '${jobId}' failed: ${detail}`
    );
    this.name = "FirecrawlCrawlTerminalError";
    this.jobId = jobId;
  }
}

/**
 * Live v2 scrape accepts markdown, html, rawHtml, and rawBase64.
 * It rejects the common "text" value. Markdown is the page-content format.
 */
function firecrawlScrapeFormat(format?: AdapterCallOptions["format"]): "markdown" {
  if (format === "text") {
    throw new Error(
      'Firecrawl does not support plain-text extract output; use format "markdown" or select another provider'
    );
  }

  return "markdown";
}

const FIRECRAWL_FORMATS: readonly string[] = [
  "markdown",
  "html",
  "rawHtml",
  "rawBase64",
  "links",
  "screenshot",
  "json",
];

const FIRECRAWL_SOURCES: readonly string[] = ["web", "news", "images"];

interface FirecrawlSearchResult {
  title?: string;
  url?: string;
  imageUrl?: string;
  image_url?: string;
  imageURL?: string;
  sourceURL?: string;
  description?: string;
  snippet?: string;
  markdown?: string;
  score?: number;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
  };
}

/** Validate a configured `formats` array against Firecrawl's supported values. */
function sanitizeFormats(value: unknown): string[] {
  if (value === undefined) return ["markdown"];
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid Firecrawl formats: expected an array of ${FIRECRAWL_FORMATS.join(", ")}.`
    );
  }
  const mapped = value.map((entry) => (entry === "text" ? "markdown" : entry));
  for (const entry of mapped) {
    if (typeof entry !== "string" || !FIRECRAWL_FORMATS.includes(entry)) {
      throw new Error(
        `Invalid Firecrawl format "${String(entry)}". ` +
          `Supported values: ${FIRECRAWL_FORMATS.join(", ")}.`
      );
    }
  }
  return mapped.length > 0 ? [...mapped] : ["markdown"];
}

/** Request Markdown alongside configured formats for the normalized content field. */
function normalizedTextFormats(value: unknown): string[] {
  const formats = sanitizeFormats(value);
  return formats.includes("markdown") ? formats : [...formats, "markdown"];
}

/** Validate a configured `sources` array against Firecrawl's supported values. */
function sanitizeSources(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid Firecrawl sources: expected an array of ${FIRECRAWL_SOURCES.join(", ")}.`
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !FIRECRAWL_SOURCES.includes(entry)) {
      throw new Error(
        `Invalid Firecrawl source "${String(entry)}". ` +
          `Supported values: ${FIRECRAWL_SOURCES.join(", ")}.`
      );
    }
  }
  return value.length > 0 ? [...value] : undefined;
}

/** Clamp a configured integer option into [min, max], defaulting when absent/invalid. */
function clampIntegerOption(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

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
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const providerOptions = options?.providerOptions ?? {};
    const body: Record<string, unknown> = {
      query,
      limit: clampIntegerOption(options?.limit ?? providerOptions.limit, 1, 100, 10),
      scrapeOptions: {
        formats: ["markdown"],
      },
    };
    if (Array.isArray(providerOptions.includeDomains) && providerOptions.includeDomains.length) {
      body.includeDomains = providerOptions.includeDomains;
    }
    if (Array.isArray(providerOptions.excludeDomains) && providerOptions.excludeDomains.length) {
      body.excludeDomains = providerOptions.excludeDomains;
    }
    const sources = sanitizeSources(providerOptions.sources);
    if (sources) {
      body.sources = sources;
    }
    const data = await fetchJson<{
      success?: boolean;
      data?: {
        web?: FirecrawlSearchResult[];
        news?: FirecrawlSearchResult[];
        images?: FirecrawlSearchResult[];
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
        body: JSON.stringify(body),
      },
      { label: "Firecrawl search" }
    );

    if (!data.success || data.error) {
      throw new Error(`Firecrawl error: ${data.error || "Unknown error"}`);
    }

    const requestedSources = sources ?? ["web"];
    const results = requestedSources.flatMap((source) => {
      if (source === "news") return data.data?.news ?? [];
      if (source === "images") return data.data?.images ?? [];
      return data.data?.web ?? [];
    });
    const includeContent = options?.commonOptions?.includeContent === true;
    const normalized = results.flatMap((result, index) => {
      const url =
        result.url ||
        result.metadata?.sourceURL ||
        result.sourceURL ||
        result.imageUrl ||
        result.image_url ||
        result.imageURL ||
        "";
      const title = result.title || result.metadata?.title || "";
      const content = result.markdown;
      if (includeContent && !content?.trim()) return [];

      const snippetSource = includeContent
        ? content!
        : result.description || result.snippet || result.metadata?.description || result.markdown || "";
      const snippet = includeContent || snippetSource.length <= 500
        ? snippetSource
        : `${snippetSource.slice(0, 497)}...`;

      return [{
        title,
        url,
        snippet,
        score: result.score ?? Math.max(0.1, 1 - index * 0.1),
        source: this.name,
      }];
    });
    if (includeContent && results.length > 0 && normalized.length === 0) {
      throw new Error("Firecrawl returned no page markdown for content-backed retrieval");
    }
    return normalized;
  }

  async extract(
    url: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<ExtractResult> {
    // Validate URL
    if (!url || !url.trim()) {
      throw new Error("URL is required");
    }

    const normalizedUrl = url.trim();
    const formats =
      options?.format === undefined || options.format === "markdown"
        ? normalizedTextFormats(options?.providerOptions?.formats)
        : [firecrawlScrapeFormat(options.format)];

    const data = await fetchJson<{
      success?: boolean;
      data?: {
        markdown?: string;
        html?: string;
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
        formats,
      }),
    }, {
      label: "Firecrawl extract",
    });

    if (!data.success || data.error) {
      throw new Error(`Firecrawl error: ${data.error || "Unknown error"}`);
    }

    return {
      content: data.data?.markdown || data.data?.html || "",
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
    const formats =
      options?.format !== undefined
        ? [firecrawlScrapeFormat(options.format)]
        : normalizedTextFormats(options?.providerOptions?.formats);

    // Resume an existing batch job when a prior output record retained its
    // handle. Starting another job here would duplicate provider work.
    const rawResumeJobId = options?.resumeJobId;
    let jobId = rawResumeJobId?.trim();
    if (rawResumeJobId !== undefined && !jobId) {
      throw new Error("Firecrawl resume job ID must be a non-empty string");
    }
    if (!jobId) {
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
          ...(options?.depth !== undefined
            ? { maxDiscoveryDepth: Math.max(0, Math.floor(options.depth)) }
            : {}),
          scrapeOptions: {
            formats,
          },
        }),
      }, {
        label: "Firecrawl crawl start",
      });

      if (!startData.success || !startData.id) {
        throw new Error(`Firecrawl crawl failed: ${startData.error || "No job ID"}`);
      }
      jobId = startData.id;
    }

    // Poll for completion
    const maxAttempts = 30;
    const pollInterval = 2000; // 2 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      let statusData: {
        success?: boolean;
        status?: "scraping" | "completed" | "failed" | "cancelled";
        data?: Array<{
          markdown?: string;
          html?: string;
          metadata?: {
            title?: string;
            sourceURL?: string;
          };
        }>;
        error?: string;
      };

      try {
        statusData = await fetchJson(`${this.baseUrl}/crawl/${encodeURIComponent(jobId)}`, {
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
            throw new FirecrawlCrawlPollError(jobId, error.message, { cause: error });
          }

          continue;
        }

        if (
          error instanceof Error &&
          (error.name === "TypeError" || error.name === "AbortError" || /timed out/i.test(error.message))
        ) {
          continue;
        }

        throw new FirecrawlCrawlPollError(
          jobId,
          error instanceof Error ? error.message : String(error),
          { cause: error }
        );
      }

      if (statusData.status === "failed" || statusData.status === "cancelled") {
        const terminalStatus = statusData.status;
        const detail =
          statusData.error ||
          (terminalStatus === "cancelled"
            ? "Provider reported that the crawl was cancelled"
            : "Provider reported terminal failure");
        throw new FirecrawlCrawlTerminalError(jobId, detail, terminalStatus);
      }

      if (statusData.success === false || statusData.error) {
        throw new FirecrawlCrawlPollError(jobId, statusData.error || "Unknown error");
      }

      if (statusData.status === "completed" && statusData.data) {
        return statusData.data.map((item) => ({
          url: item.metadata?.sourceURL || "",
          title: item.metadata?.title || "",
          content: item.markdown || item.html || "",
          status: "completed" as const,
          jobId,
        }));
      }
      // If still scraping, continue polling
    }

    return [{
      url: normalizedUrl,
      title: "",
      content: "",
      status: "pending",
      jobId,
    }];
  }
}

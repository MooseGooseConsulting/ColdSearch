import { fetchJson, fetchText } from "../http.js";
import { searchUrlFromQuery } from "../tools/brightdata.js";
import type {
  AdapterCallOptions,
  ExtractResult,
  NormalizedResult,
  SearchAdapter,
} from "../types.js";

interface BrightDataSerpOrganicResult {
  title?: string;
  link?: string;
  description?: string;
  snippet?: string;
  source?: string;
  global_rank?: number;
}

interface BrightDataSerpResponse {
  organic?: BrightDataSerpOrganicResult[];
}

function requireStringOption(
  options: AdapterCallOptions | undefined,
  key: string,
  envName?: string
): string {
  const configured = options?.providerOptions?.[key];
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv?.trim()) return fromEnv.trim();
  }
  throw new Error(
    `Bright Data requires providers.brightdata.options.${key}` +
      (envName ? ` or ${envName}` : "")
  );
}

function optionalStringOption(
  options: AdapterCallOptions | undefined,
  key: string,
  fallback: string
): string {
  const configured = options?.providerOptions?.[key];
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : fallback;
}

/**
 * Bright Data adapter.
 *
 * Normalized `search` uses Bright Data SERP API. Normalized `extract` uses
 * Web Unlocker with Markdown output. Bright Data's site-specific Web Scraper
 * APIs remain provider-native tools because their structured schemas are not a
 * generic page-extraction contract.
 */
export class BrightDataAdapter implements SearchAdapter {
  name = "brightdata";
  capabilities: SearchAdapter["capabilities"] = ["search", "extract"];
  private baseUrl = "https://api.brightdata.com";

  async search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    if (!query?.trim()) throw new Error("Query is required");

    const zone = requireStringOption(options, "serpZone", "BRIGHTDATA_SERP_ZONE");
    const engine = optionalStringOption(options, "searchEngine", "google");
    const country = optionalStringOption(options, "searchCountry", "us");

    const data = await fetchJson<BrightDataSerpResponse>(
      `${this.baseUrl}/request`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zone,
          url: searchUrlFromQuery(query.trim(), engine),
          format: "json",
          method: "GET",
          country,
        }),
      },
      { label: "Bright Data SERP search" }
    );

    return (data.organic || []).map((result, index) => {
      // Bright Data parsed SERP organic entries report `global_rank`, not
      // position/rank.
      const resolvedPosition =
        typeof result.global_rank === "number" && result.global_rank > 0
          ? result.global_rank
          : index + 1;

      return {
        title: result.title || result.source || "",
        url: result.link || "",
        snippet: result.description || result.snippet || "",
        score: 1 / resolvedPosition,
        source: this.name,
      };
    });
  }

  async extract(
    url: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<ExtractResult> {
    if (!url?.trim()) throw new Error("URL is required");

    const zone = requireStringOption(options, "unlockerZone", "BRIGHTDATA_UNLOCKER_ZONE");
    const country = optionalStringOption(options, "searchCountry", "us");
    const normalizedUrl = url.trim();

    // JS-rendered pages routinely exceed the default 10s fetch timeout; allow
    // an operator to raise it via unlockerTimeoutMs (milliseconds).
    const configuredTimeout = options?.providerOptions?.["unlockerTimeoutMs"];
    const timeoutMs =
      typeof configuredTimeout === "number" &&
      Number.isFinite(configuredTimeout) &&
      configuredTimeout > 0
        ? Math.floor(configuredTimeout)
        : typeof configuredTimeout === "string" &&
            /^\d+$/.test(configuredTimeout) &&
            Number(configuredTimeout) > 0
          ? Number(configuredTimeout)
          : undefined;

    const content = await fetchText(
      `${this.baseUrl}/request`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          zone,
          url: normalizedUrl,
          format: "raw",
          method: "GET",
          country,
          data_format: options?.format ?? "markdown",
        }),
      },
      {
        label: "Bright Data Web Unlocker extract",
        ...(timeoutMs ? { timeoutMs } : {}),
      }
    );

    // An empty/whitespace-only body means the page yielded nothing; surface it
    // as a failed attempt so the caller can fall back to another provider
    // (matches the Jina adapter's empty-extract contract).
    if (!content || content.trim().length === 0) {
      throw new Error(`No content extracted from ${url}`);
    }

    return {
      content,
      url: normalizedUrl,
      source: this.name,
    };
  }
}

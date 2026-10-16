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

/**
 * Read a required string option, accepting the profile-declared key first and
 * then any legacy aliases, before falling back to the environment.
 */
function requireStringOption(
  options: AdapterCallOptions | undefined,
  keys: string[],
  envName?: string
): string {
  for (const key of keys) {
    const configured = options?.providerOptions?.[key];
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  }
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv?.trim()) return fromEnv.trim();
  }
  throw new Error(
    `Bright Data requires providers.brightdata.options.${keys[0]}` +
      (keys.length > 1 ? ` (legacy alias: ${keys.slice(1).join(", ")})` : "") +
      (envName ? ` or ${envName}` : "")
  );
}

/**
 * Read an optional string option, accepting the profile-declared key first and
 * then any legacy aliases, before falling back to `fallback`.
 */
function optionalStringOption(
  options: AdapterCallOptions | undefined,
  keys: string[],
  fallback: string
): string {
  for (const key of keys) {
    const configured = options?.providerOptions?.[key];
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  }
  return fallback;
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

    // `zone`/`country` are the profile-declared keys; serpZone/searchCountry
    // are accepted as legacy aliases.
    const zone = requireStringOption(options, ["zone", "serpZone"], "BRIGHTDATA_SERP_ZONE");
    const engine = optionalStringOption(options, ["searchEngine"], "google");
    const country = optionalStringOption(options, ["country", "searchCountry"], "us");
    const format = optionalStringOption(options, ["format"], "json");
    if (format.toLowerCase() !== "json") {
      throw new Error(
        `Normalized Bright Data search requires format="json"; received "${format}".`
      );
    }

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
          format,
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
    if (options?.format === "text") {
      throw new Error(
        'Bright Data Web Unlocker does not support plain-text extract output; use format "markdown" or select another provider'
      );
    }

    // Prefer the capability-specific zone when both SERP and Unlocker zones
    // are configured in the shared provider options.
    const zone = requireStringOption(options, ["unlockerZone", "zone"], "BRIGHTDATA_UNLOCKER_ZONE");
    const country = optionalStringOption(options, ["country", "searchCountry"], "us");
    // Normalized extract returns page text, so request the raw unlocker body
    // even when shared provider config selects a JSON envelope for other tools.
    const format = "raw";
    const dataFormat =
      options?.format === "markdown"
        ? "markdown"
        : optionalStringOption(options, ["data_format"], "markdown");
    if (dataFormat === "screenshot") {
      throw new Error(
        "Bright Data unlocker data_format 'screenshot' returns binary PNG that cannot be normalized as text; " +
          "use a text format such as 'markdown' or 'html'"
      );
    }
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
          format,
          method: "GET",
          country,
          data_format: dataFormat,
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

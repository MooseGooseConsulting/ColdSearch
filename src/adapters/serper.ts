import { fetchJson } from "../http.js";
import type {
  SearchAdapter,
  NormalizedResult,
  AdapterCallOptions,
} from "../types.js";

/**
 * Serper.dev (Google Search API) response types
 */
interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
}

/** Clamp a configured integer option into [min, max], defaulting when absent/invalid. */
function clampIntegerOption(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Serper.dev Google Search adapter.
 * Uses Serper's REST API for Google search results.
 * @see https://serper.dev (serper.dev/docs 404s; docs live on the homepage
 * demo and the login-gated playground)
 */
export class SerperAdapter implements SearchAdapter {
  name = "serper";
  capabilities: SearchAdapter["capabilities"] = ["search"];

  async search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const body: Record<string, unknown> = {
      q: query,
      // Serper accepts up to 100 results per request.
      num: clampIntegerOption(options?.providerOptions?.num, 1, 100, 10),
    };
    const location = options?.providerOptions?.location;
    if (typeof location === "string" && location.trim()) {
      body.location = location.trim();
    }

    const data = await fetchJson<SerperSearchResponse>("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        num: clampIntegerOption(options?.limit ?? options?.providerOptions?.num, 1, 100, 10),
      }),
    }, {
      label: "Serper search",
    });

    // Normalize Serper results to shared schema
    return (data.organic || []).map((result, index) => {
      const resolvedPosition = result.position && result.position > 0
        ? result.position
        : index + 1;

      return ({
      title: result.title || "",
      url: result.link || "",
      snippet: result.snippet || "",
      // Serper doesn't provide relevance scores, use position-based
      score: 1 / resolvedPosition,
      source: this.name,
      });
    });
  }
}

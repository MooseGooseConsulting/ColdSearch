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

/**
 * Serper.dev Google Search adapter.
 * Uses Serper's REST API for Google search results.
 * @see https://serper.dev/docs
 */
export class SerperAdapter implements SearchAdapter {
  name = "serper";
  capabilities: SearchAdapter["capabilities"] = ["search"];

  async search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]> {
    const data = await fetchJson<SerperSearchResponse>("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        num: typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.min(100, Math.max(1, Math.floor(options.limit)))
          : 10,
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

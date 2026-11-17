import { fetchText } from "../http.js";
import type {
  SearchAdapter,
  ExtractResult,
  NormalizedResult,
  AdapterCallOptions,
} from "../types.js";

/** Resolve the effective Reader format shared by request construction and cache identity. */
export function effectiveJinaReturnFormat(
  options?: Pick<AdapterCallOptions, "format" | "providerOptions">
): string {
  const configuredFormat = Object.entries(options?.providerOptions ?? {}).find(
    ([name, value]) =>
      name.toLowerCase() === "x-return-format" && value !== undefined && value !== null
  )?.[1];

  return String(options?.format ?? configuredFormat ?? "markdown");
}

/**
 * Jina AI Reader adapter.
 * Provides simple URL-to-markdown extraction.
 * No API key required for basic usage.
 * @see https://jina.ai/reader
 */
export class JinaAdapter implements SearchAdapter {
  name = "jina";
  capabilities: SearchAdapter["capabilities"] = ["extract"];

  async search(_query: string, _apiKey: string): Promise<NormalizedResult[]> {
    throw new Error("Jina does not support search");
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

    // Normalize URL - ensure it has a protocol
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // Jina AI Reader endpoint - preserve the caller's scheme (http or https)
    const jinaUrl = `https://r.jina.ai/${normalizedUrl}`;

    const headers: Record<string, string> = {
      Accept: "text/plain",
      "X-Return-Format": options?.format ?? "markdown",
    };
    // Keyless usage stays supported; send the key only when one is configured.
    if (apiKey?.trim()) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    // Jina's Reader surface is controlled via X-* request headers; pass through
    // all configured X-* options except X-Return-Format, which uses the same
    // precedence as the normalized format and cache identity. Proxy overrides
    // are excluded because they can change the network context used to fetch
    // the target URL.
    for (const [key, value] of Object.entries(options?.providerOptions ?? {})) {
      const normalizedKey = key.toLowerCase();
      if (
        !normalizedKey.startsWith("x-") ||
        normalizedKey === "x-return-format" ||
        normalizedKey === "x-proxy" ||
        normalizedKey === "x-proxy-url" ||
        value === undefined ||
        value === null
      ) {
        continue;
      }
      headers[key] = String(value);
    }
    headers["X-Return-Format"] = effectiveJinaReturnFormat(options);

    const content = await fetchText(jinaUrl, {
      headers,
    }, {
      label: "Jina extract",
      secrets: apiKey ? [apiKey] : [],
    });

    if (!content || content.trim().length === 0) {
      throw new Error(`No content extracted from ${url}`);
    }

    // Extract title from first line if it looks like a title
    const lines = content.split("\n");
    let title = "";
    let bodyContent = content;

    // Jina often returns "Title: actual title" format
    if (lines[0]?.startsWith("Title:")) {
      title = lines[0].replace("Title:", "").trim();
      bodyContent = lines.slice(1).join("\n").trim();
    }

    return {
      content: bodyContent,
      url: normalizedUrl,
      title: title,
      source: this.name,
    };
  }
}

/** Serper verticals named in docs/PROVIDERS.md. `search` is the normalized backer. */
export const SERPER_TOOLS = [
  "search",
  "images",
  "news",
  "videos",
  "shopping",
  "maps",
  "places",
  "scholar",
  "patents",
  "autocomplete",
  "reviews",
] as const;

export function serperToolUrl(tool: string): string {
  if (!(SERPER_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(
      `Unsupported Serper tool '${tool}'. Supported: ${SERPER_TOOLS.join(", ")}.`
    );
  }
  return `https://google.serper.dev/${tool}`;
}

/**
 * Brave path table. Image search uses the documented plural `/images/search`.
 * A live call confirms or corrects that path.
 */
export function braveToolPath(tool: string): string {
  switch (tool) {
    case "webSearch":
    case "web":
      return "/res/v1/web/search";
    case "newsSearch":
    case "news":
      return "/res/v1/news/search";
    case "imageSearch":
    case "images":
    case "image":
      return "/res/v1/images/search";
    case "videoSearch":
    case "videos":
    case "video":
      return "/res/v1/videos/search";
    case "llmContext":
      return "/res/v1/summarizer/llm_context";
    default:
      throw new Error(
        `Unsupported Brave tool '${tool}'. Supported: webSearch, newsSearch, imageSearch, videoSearch, llmContext.`
      );
  }
}

export type JinaDispatch =
  | { kind: "reader"; url: string }
  | { kind: "search"; url: string }
  | { kind: "json"; url: string };

/** Reader, s.jina.ai search, or the JSON API. Unknown tools stay on the JSON API. */
export function jinaDispatch(tool: string, params: Record<string, unknown>): JinaDispatch {
  if (tool === "reader" || (typeof params.url === "string" && params.url && !params.q)) {
    const target = String(params.url || params.q || "");
    return { kind: "reader", url: `https://r.jina.ai/${target}` };
  }
  if (tool === "search") {
    const q = typeof params.q === "string" ? params.q : typeof params.query === "string" ? params.query : "";
    const url = new URL("https://s.jina.ai/");
    if (q) url.searchParams.set("q", q);
    return { kind: "search", url: url.toString() };
  }
  return { kind: "json", url: `https://api.jina.ai/v1/${tool}` };
}

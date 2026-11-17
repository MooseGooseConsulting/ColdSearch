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
  "lens",
] as const;

export function serperToolUrl(tool: string): string {
  if (!(SERPER_TOOLS as readonly string[]).includes(tool)) {
    throw new Error(
      `Unsupported Serper tool '${tool}'. Supported: ${SERPER_TOOLS.join(", ")}.`
    );
  }
  return `https://google.serper.dev/${tool}`;
}

/** Brave path table. Image and video search use the plural paths confirmed by live calls. */
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
      return "/res/v1/llm/context";
    default:
      // Preserve the substrate's warn-and-forward behavior for uncatalogued
      // provider tools. Restrict fallback to a single path segment so callers
      // cannot change the fixed Brave host or escape its versioned API path.
      if (/^[A-Za-z0-9_-]+$/.test(tool)) return `/res/v1/${tool}`;
      throw new Error(`Unsupported Brave tool '${tool}': invalid path segment.`);
  }
}

export type JinaDispatch =
  | { kind: "reader"; url: string }
  | { kind: "search"; url: string }
  | { kind: "json"; url: string };

/** Reader, s.jina.ai search, or the JSON API. Unknown tools stay on the JSON API. */
export function jinaDispatch(tool: string, params: Record<string, unknown>): JinaDispatch {
  if (tool === "reader") {
    const rawTarget = params.url;
    if (typeof rawTarget !== "string" || !rawTarget.trim()) {
      throw new Error("Jina Reader requires a non-empty URL");
    }
    const target = rawTarget.trim();
    const normalizedTarget = /^[a-z][a-z\d+.-]*:\/\//i.test(target)
      ? target
      : `https://${target}`;
    let parsedTarget: URL;
    try {
      parsedTarget = new URL(normalizedTarget);
    } catch {
      throw new Error("Jina Reader requires a valid HTTP(S) URL");
    }
    if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
      throw new Error("Jina Reader requires a valid HTTP(S) URL");
    }
    return { kind: "reader", url: `https://r.jina.ai/${normalizedTarget}` };
  }
  if (tool === "search") {
    const q = typeof params.q === "string" ? params.q : typeof params.query === "string" ? params.query : "";
    if (!q.trim()) throw new Error("Jina search requires a non-empty query");
    const url = new URL("https://s.jina.ai/");
    if (q) url.searchParams.set("q", q);
    return { kind: "search", url: url.toString() };
  }
  return { kind: "json", url: `https://api.jina.ai/v1/${tool}` };
}

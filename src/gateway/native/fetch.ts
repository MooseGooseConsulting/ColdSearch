import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { boolArg, enumArg, intArg, urlArg } from "./args.js";
import { readThroughFallback } from "./fallback.js";
import { clip, readPage } from "./read.js";
import { jsonResult, type NativeHandler } from "./runtime.js";

export const FETCH_TOOL = "coldsearch_fetch";
const DEFAULT_MAX_CHARS = 100_000;
const FORMATS = ["markdown", "text", "html"] as const;

export const fetchTool: Tool = {
  name: FETCH_TOOL,
  description:
    "Read one URL you already have and return it as markdown, plain text or raw HTML. The gateway fetches the page itself with a plain HTTP GET, so it costs no provider credit: use this before any provider fetch, scrape or extract tool. It does not run JavaScript and cannot get past bot protection or a login. When a page needs either, the result says needs_fallback with the reason, and you can call again with allow_paid_fallback: true to read it through the operator's configured paid tool, or use a provider tool yourself. PDFs and other non-text files are not converted. The first result item is JSON (url, status, source \"direct\" or \"paid\", title, truncated); the second is the content.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The http or https URL to read." },
      format: { type: "string", enum: [...FORMATS], description: "markdown (default), text, or html (the page source as received)." },
      max_chars: { type: "integer", minimum: 1, description: `Longest content to return, in characters (default ${DEFAULT_MAX_CHARS}). Longer content is cut and marked truncated.` },
      allow_paid_fallback: { type: "boolean", description: "When the gateway cannot read the page, read it through the configured paid provider tool instead (spends provider credit). Default false." },
    },
    required: ["url"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export const runFetch: NativeHandler = async (runtime, args, context) => {
  const url = urlArg(args, "url").href;
  const format = enumArg(args, "format", FORMATS, "markdown");
  const maxChars = intArg(args, "max_chars", { min: 1, max: 5_000_000, fallback: DEFAULT_MAX_CHARS });
  const allowPaid = boolArg(args, "allow_paid_fallback");

  const read = await readPage(runtime.net, url);
  const base = {
    url,
    ...(read.finalUrl !== url ? { final_url: read.finalUrl } : {}),
    status: read.status,
  };

  if (!read.problem) {
    const whole = format === "html" || !read.html ? read.body : format === "text" ? read.html.text() : read.html.markdown();
    const content = clip(whole, maxChars);
    return {
      ok: true,
      pages: 1,
      result: jsonResult(
        {
          ...base,
          source: "direct",
          title: read.html?.title ?? "",
          format: read.html ? format : read.contentType || "text/plain",
          chars: whole.length,
          truncated: content.truncated || read.truncated,
        },
        content.text
      ),
    };
  }

  const { reason, detail } = read.problem;
  if (!read.problem.fallback) {
    return { ok: false, pages: 0, error: `${reason}: ${detail}`, result: jsonResult({ ...base, error: reason, detail }, undefined, true) };
  }

  const fallback = runtime.config.fallback;
  if (!allowPaid || !fallback) {
    const next = !fallback
      ? "No paid fallback is configured on this gateway; use a provider fetch or scrape tool for this URL."
      : `Call again with allow_paid_fallback: true to read it through ${fallback} (spends provider credit), or use a provider tool.`;
    return {
      ok: false,
      pages: 0,
      error: `needs_fallback ${reason}`,
      result: jsonResult({ ...base, needs_fallback: true, reason, detail, next }, undefined, true),
    };
  }

  const paid = await readThroughFallback(runtime.core, runtime.config, url, context);
  if (!paid.ok) {
    return {
      ok: false,
      pages: 0,
      error: `needs_fallback ${reason}; ${paid.error}`,
      result: jsonResult({ ...base, needs_fallback: true, reason, detail, paid_fallback_error: paid.error }, undefined, true),
    };
  }
  const content = clip(paid.markdown, maxChars);
  return {
    ok: true,
    pages: 0,
    result: jsonResult(
      {
        ...base,
        source: "paid",
        paid_tool: paid.tool,
        direct_problem: reason,
        title: paid.title ?? "",
        format: "as returned by the paid tool",
        chars: paid.markdown.length,
        truncated: content.truncated,
      },
      content.text
    ),
  };
};

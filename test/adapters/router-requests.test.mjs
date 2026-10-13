import test from "node:test";
import assert from "node:assert/strict";
import { TavilyAdapter } from "../../dist/adapters/tavily.js";
import { FirecrawlAdapter } from "../../dist/adapters/firecrawl.js";
import { ExaAdapter } from "../../dist/adapters/exa.js";
import { BraveAdapter } from "../../dist/adapters/brave.js";
import { SerperAdapter } from "../../dist/adapters/serper.js";
import { JinaAdapter } from "../../dist/adapters/jina.js";
import { braveToolPath, jinaDispatch, serperToolUrl } from "../../dist/tools/dispatch-paths.js";
import { installFetchMock, jsonResponse, rawResponse } from "./_fetch-mock.mjs";

function bodyOf(init) {
  return JSON.parse(init.body);
}

test("search adapters send the caller limit on the provider's count field", async () => {
  const seen = {};
  const restore = installFetchMock({
    "POST https://api.tavily.com/search": async ({ init }) => {
      seen.tavily = bodyOf(init);
      return jsonResponse({ results: [] });
    },
    "POST https://api.firecrawl.dev/v2/search": async ({ init }) => {
      seen.firecrawl = bodyOf(init);
      return jsonResponse({ success: true, data: { web: [] } });
    },
    "POST https://api.exa.ai/search": async ({ init }) => {
      seen.exa = bodyOf(init);
      return jsonResponse({ results: [] });
    },
    "GET https://api.search.brave.com/res/v1/web/search?q=q&count=3&offset=0": async ({ url }) => {
      seen.brave = new URL(url).searchParams.get("count");
      return jsonResponse({ web: { results: [] } });
    },
    "POST https://google.serper.dev/search": async ({ init }) => {
      seen.serper = bodyOf(init);
      return jsonResponse({ organic: [] });
    },
  });
  try {
    await new TavilyAdapter().search("q", "k", { limit: 3 });
    await new FirecrawlAdapter().search("q", "k", { limit: 3 });
    await new ExaAdapter().search("q", "k", { limit: 3 });
    await new BraveAdapter().search("q", "k", { limit: 3 });
    await new SerperAdapter().search("q", "k", { limit: 3 });
    assert.equal(seen.tavily.max_results, 3);
    assert.equal(seen.firecrawl.limit, 3);
    assert.equal(seen.exa.numResults, 3);
    assert.equal(seen.brave, "3");
    assert.equal(seen.serper.num, 3);
  } finally {
    restore();
  }
});

test("extract adapters send format on the provider field and Jina keeps the URL scheme", async () => {
  const seen = {};
  const restore = installFetchMock({
    "POST https://api.tavily.com/extract": async ({ init }) => {
      seen.tavily = bodyOf(init);
      return jsonResponse({ results: [{ url: "https://example.com", raw_content: "x", title: "t" }] });
    },
    "POST https://api.firecrawl.dev/v2/scrape": async ({ init }) => {
      seen.firecrawl = bodyOf(init);
      return jsonResponse({ success: true, data: { markdown: "x", metadata: { title: "t", sourceURL: "https://example.com" } } });
    },
    "GET https://r.jina.ai/https://example.com": async ({ url, init }) => {
      seen.jinaUrl = url;
      seen.jinaAccept = init.headers.Accept;
      return rawResponse("Title: t\nbody", { headers: { "Content-Type": "text/plain" } });
    },
  });
  try {
    await new TavilyAdapter().extract("https://example.com", "k", { format: "text" });
    await new FirecrawlAdapter().extract("https://example.com", "k", { format: "text" });
    await new JinaAdapter().extract("https://example.com", "", { format: "text" });
    assert.equal(seen.tavily.format, "text");
    // Live Firecrawl v2 scrape rejects formats:["text"]; markdown is the content format.
    assert.deepEqual(seen.firecrawl.formats, ["markdown"]);
    assert.equal(seen.jinaUrl, "https://r.jina.ai/https://example.com");
    assert.equal(seen.jinaAccept, "text/plain");
  } finally {
    restore();
  }
});

test("tavily extract surfaces failed_results instead of an empty miss", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/extract": async () =>
      jsonResponse({ results: [], failed_results: [{ error: "blocked" }] }),
  });
  try {
    await assert.rejects(
      () => new TavilyAdapter().extract("https://example.com", "k"),
      /blocked/
    );
  } finally {
    restore();
  }
});

test("crawl depth is sent for Tavily and Firecrawl and Exa results stay derived", async () => {
  const seen = {};
  const restore = installFetchMock({
    "POST https://api.tavily.com/crawl": async ({ init }) => {
      seen.tavily = bodyOf(init);
      return jsonResponse({ results: [] });
    },
    "POST https://api.firecrawl.dev/v2/crawl": async ({ init }) => {
      seen.firecrawl = bodyOf(init);
      return jsonResponse({ success: true, id: "job-1" });
    },
    "GET https://api.firecrawl.dev/v2/crawl/job-1": async () =>
      jsonResponse({ success: true, status: "completed", data: [] }),
    "POST https://api.exa.ai/search": async () => jsonResponse({ results: [{ url: "https://example.com/a" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://example.com/a", title: "A", text: "body" }] }),
  });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args);
  try {
    await new TavilyAdapter().crawl("https://example.com", "k", { limit: 2, depth: 2 });
    assert.equal(seen.tavily.max_depth, 2);
    await new TavilyAdapter().crawl("https://example.com", "k", { limit: 2, depth: 0 });
    await new FirecrawlAdapter().crawl("https://example.com", "k", { limit: 2, depth: 1 });
    const exa = await new ExaAdapter().crawl("https://example.com", "k", { limit: 2, depth: 4 });
    assert.equal(seen.tavily.max_depth, 1);
    assert.equal(seen.tavily.limit, 2);
    assert.equal(seen.firecrawl.maxDiscoveryDepth, 1);
    assert.equal(exa[0].derived, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    restore();
  }
});

test("dispatch path table covers Serper verticals, Brave images, and Jina search", () => {
  const serperTools = [
    "search", "images", "news", "videos", "shopping", "maps",
    "places", "scholar", "patents", "autocomplete", "reviews",
  ];
  for (const tool of serperTools) {
    assert.equal(serperToolUrl(tool), `https://google.serper.dev/${tool}`);
  }
  assert.throws(() => serperToolUrl("agent"), /Unsupported Serper tool/);
  assert.equal(braveToolPath("webSearch"), "/res/v1/web/search");
  assert.equal(braveToolPath("newsSearch"), "/res/v1/news/search");
  assert.equal(braveToolPath("imageSearch"), "/res/v1/images/search");
  assert.equal(braveToolPath("videoSearch"), "/res/v1/videos/search");
  assert.equal(braveToolPath("llmContext"), "/res/v1/summarizer/llm_context");
  const search = jinaDispatch("search", { q: "openai" });
  assert.equal(search.kind, "search");
  assert.equal(search.url, "https://s.jina.ai/?q=openai");
  const reader = jinaDispatch("reader", { url: "https://example.com" });
  assert.equal(reader.url, "https://r.jina.ai/https://example.com");
  const embeddings = jinaDispatch("embeddings", { input: ["q"] });
  assert.equal(embeddings.kind, "json");
  assert.equal(embeddings.url, "https://api.jina.ai/v1/embeddings");
});

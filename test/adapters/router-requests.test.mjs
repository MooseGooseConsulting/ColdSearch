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
      (seen.exa ??= []).push(bodyOf(init));
      return jsonResponse({ results: [] });
    },
    "GET": async ({ url }) => {
      (seen.brave ??= []).push(new URL(url).searchParams.get("count"));
      return jsonResponse({ web: { results: [] } });
    },
    "POST https://google.serper.dev/search": async ({ init }) => {
      (seen.serper ??= []).push(bodyOf(init));
      return jsonResponse({ organic: [] });
    },
  });
  try {
    await new TavilyAdapter().search("q", "k", { limit: 3 });
    await new FirecrawlAdapter().search("q", "k", { limit: 3 });
    await new ExaAdapter().search("q", "k", { limit: 3 });
    await new ExaAdapter().search("q", "k", { limit: 500 });
    await new BraveAdapter().search("q", "k", { limit: 3 });
    await new BraveAdapter().search("q", "k", { limit: 50 });
    await new SerperAdapter().search("q", "k", { limit: 3 });
    await new SerperAdapter().search("q", "k", { limit: 500 });
    assert.equal(seen.tavily.max_results, 3);
    assert.equal(seen.firecrawl.limit, 3);
    assert.deepEqual(seen.exa.map((request) => request.numResults), [3, 100]);
    assert.deepEqual(seen.brave, ["3", "20"]);
    assert.deepEqual(seen.serper.map((request) => request.num), [3, 100]);
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
      seen.jinaFormat = init.headers["X-Return-Format"];
      return rawResponse("Title: t\nbody", { headers: { "Content-Type": "text/plain" } });
    },
  });
  try {
    await new TavilyAdapter().extract("https://example.com", "k", { format: "text" });
    await new FirecrawlAdapter().extract("https://example.com", "k", { format: "markdown" });
    await new JinaAdapter().extract("https://example.com", "", { format: "text" });
    await assert.rejects(
      () => new FirecrawlAdapter().extract("https://example.com", "k", { format: "text" }),
      /does not support plain-text/
    );
    assert.equal(seen.tavily.format, "text");
    assert.deepEqual(seen.firecrawl.formats, ["markdown"]);
    assert.equal(seen.jinaUrl, "https://r.jina.ai/https://example.com");
    assert.equal(seen.jinaFormat, "text");
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
    await assert.rejects(
      () => new TavilyAdapter().crawl("https://example.com", "k", { limit: 2, depth: 0 }),
      /depth must be an integer from 1 to 5/
    );
    await new FirecrawlAdapter().crawl("https://example.com", "k", { limit: 2, depth: 1 });
    const exa = await new ExaAdapter().crawl("https://example.com", "k", { limit: 2, depth: 4 });
    assert.equal(seen.tavily.max_depth, 2);
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
  assert.equal(braveToolPath("llmContext"), "/res/v1/llm/context");
  const search = jinaDispatch("search", { q: "openai" });
  assert.equal(search.kind, "search");
  assert.equal(search.url, "https://s.jina.ai/?q=openai");
  const reader = jinaDispatch("reader", { url: "https://example.com" });
  assert.equal(reader.url, "https://r.jina.ai/https://example.com");
  assert.equal(jinaDispatch("reader", { url: "example.com/path" }).url,
    "https://r.jina.ai/https://example.com/path");
  assert.throws(() => jinaDispatch("reader", {}), /non-empty URL/);
  assert.throws(() => jinaDispatch("reader", { url: "ftp://example.com" }), /HTTP\(S\) URL/);
  assert.throws(() => jinaDispatch("search", { q: " " }), /non-empty query/);
  const embeddings = jinaDispatch("embeddings", { input: ["q"] });
  assert.equal(embeddings.kind, "json");
  assert.equal(embeddings.url, "https://api.jina.ai/v1/embeddings");
  const embeddingsWithUrl = jinaDispatch("embeddings", {
    url: "https://example.com",
    input: ["q"],
  });
  assert.equal(embeddingsWithUrl.kind, "json");
  assert.equal(embeddingsWithUrl.url, "https://api.jina.ai/v1/embeddings");
});

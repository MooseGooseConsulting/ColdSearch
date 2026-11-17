import test from "node:test";
import assert from "node:assert/strict";
import { TavilyAdapter } from "../../dist/adapters/tavily.js";
import { installFetchMock, jsonResponse, rawResponse } from "./_fetch-mock.mjs";

test("tavily search normalizes results", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/search": async () =>
      jsonResponse({
        results: [
          { title: "A", url: "https://a.example", content: "aa", score: 0.9 },
          { title: "B", url: "https://b.example", content: "bb" },
        ],
      }),
  });
  try {
    const adapter = new TavilyAdapter();
    const results = await adapter.search("q", "k");
    assert.equal(results.length, 2);
    assert.deepEqual(Object.keys(results[0]).sort(), ["score", "snippet", "source", "title", "url"]);
    assert.equal(results[0].source, "tavily");
    assert.equal(results[0].url, "https://a.example");
  } finally {
    restore();
  }
});

test("tavily search caps max_results at the provider limit", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/search": async ({ init }) => {
      assert.equal(JSON.parse(init.body).max_results, 20);
      return jsonResponse({ results: [] });
    },
  });
  try {
    await new TavilyAdapter().search("q", "k", { limit: 100 });
  } finally {
    restore();
  }
});

test("tavily crawl does not reuse the search max_results cap", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/crawl": async ({ init }) => {
      assert.equal(JSON.parse(init.body).limit, 50);
      return jsonResponse({ results: [] });
    },
  });
  try {
    await new TavilyAdapter().crawl("https://example.com", "k", { limit: 50 });
  } finally {
    restore();
  }
});

test("tavily crawl uses native /crawl endpoint", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/crawl": async ({ init }) => {
      const body = JSON.parse(init.body);
      assert.equal(typeof body.url, "string");
      // Upstream caps crawls via `limit`; the retired `max_results` name is
      // silently ignored and must not come back.
      assert.equal(body.limit, 2);
      assert.equal("max_results" in body, false);
      return jsonResponse({
        results: [
          { title: "P1", url: "https://x.example/1", rawContent: "c1" },
          { title: "P2", url: "https://x.example/2", raw_content: "c2" },
        ],
      });
    },
  });
  try {
    const adapter = new TavilyAdapter();
    const results = await adapter.crawl("https://x.example", "k", { limit: 2 });
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], {
      url: "https://x.example/1",
      title: "P1",
      content: "c1",
    });
  } finally {
    restore();
  }
});

test("tavily errors on invalid JSON", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/search": async () =>
      rawResponse("{not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  try {
    const adapter = new TavilyAdapter();
    await assert.rejects(() => adapter.search("q", "k"), /invalid json/i);
  } finally {
    restore();
  }
});

test("tavily crawl clamps depth to the provider range", async () => {
  const depths = [];
  const restore = installFetchMock({
    "POST https://api.tavily.com/crawl": async ({ init }) => {
      depths.push(JSON.parse(init.body).max_depth);
      return jsonResponse({ results: [] });
    },
  });
  try {
    const adapter = new TavilyAdapter();
    await adapter.crawl("https://example.com", "k", { depth: 5 });
    await adapter.crawl("https://example.com", "k", { depth: 6 });
    await adapter.crawl("https://example.com", "k", { depth: 1.5 });
    await adapter.crawl("https://example.com", "k", { depth: 0 });
    assert.deepEqual(depths, [5, 5, 1, 1]);
  } finally {
    restore();
  }
});

test("tavily search honors providerOptions (max_results clamped, depth/topic/answer/time_range)", async () => {
  const bodies = [];
  const restore = installFetchMock({
    "POST https://api.tavily.com/search": async ({ init }) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ results: [] });
    },
  });
  try {
    const adapter = new TavilyAdapter();
    // Defaults: unchanged wire contract when nothing is configured.
    await adapter.search("q", "k");
    await assert.rejects(
      () => adapter.search("q", "k", {
        providerOptions: { include_answer: true },
      }),
      /cannot be represented in normalized search results/
    );
    await adapter.search("q", "k", {
      providerOptions: {
        max_results: 500,
        search_depth: "advanced",
        topic: "news",
        time_range: "week",
      },
    });
  } finally {
    restore();
  }

  assert.deepEqual(bodies[0], {
    query: "q",
    max_results: 10,
    search_depth: "basic",
    include_answer: false,
  });
  assert.deepEqual(bodies[1], {
    query: "q",
    max_results: 20, // Tavily accepts at most 20 search results
    search_depth: "advanced",
    include_answer: false,
    topic: "news",
    time_range: "week",
  });
});

test("tavily extract honors format and extract_depth only when configured", async () => {
  const bodies = [];
  const restore = installFetchMock({
    "POST https://api.tavily.com/extract": async ({ init }) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({
        results: [{ url: "https://x.example", title: "T", rawContent: "c" }],
      });
    },
  });
  try {
    const adapter = new TavilyAdapter();
    await adapter.extract("https://x.example", "k");
    await adapter.extract("https://x.example", "k", {
      providerOptions: { format: "text", extract_depth: "advanced" },
    });
  } finally {
    restore();
  }

  assert.deepEqual(bodies[0], {
    urls: ["https://x.example"],
    include_images: false,
    format: "markdown",
  });
  assert.equal(bodies[1].format, "text");
  assert.equal(bodies[1].extract_depth, "advanced");
});

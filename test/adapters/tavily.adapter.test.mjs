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


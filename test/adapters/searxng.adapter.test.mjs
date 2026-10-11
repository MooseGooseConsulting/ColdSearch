import test from "node:test";
import assert from "node:assert/strict";
import { SearXNGAdapter } from "../../dist/adapters/searxng.js";
import { installFetchMock, jsonResponse } from "./_fetch-mock.mjs";

test("searxng errors when no baseUrl is configured", async () => {
  const adapter = new SearXNGAdapter();
  await assert.rejects(() => adapter.search("q", ""), /requires providers\.searxng\.options\.baseUrl/i);
});

test("searxng search normalizes results", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      assert.match(url, /^https:\/\/search\.example\.internal\/search\?/);
      return jsonResponse({
        results: [{ title: "A", url: "https://a.example", content: "aa", score: 0.2 }],
      });
    },
  });
  try {
    const adapter = new SearXNGAdapter();
    const results = await adapter.search("q", "", { providerOptions: { baseUrl: "https://search.example.internal" } });
    assert.equal(results.length, 1);
    assert.equal(results[0].source, "searxng");
    assert.equal(results[0].snippet, "aa");
  } finally {
    restore();
  }
});


test("searxng wires optional query params from providerOptions only when present", async () => {
  const urls = [];
  const restore = installFetchMock({
    "*": async ({ url }) => {
      urls.push(url);
      return jsonResponse({ results: [] });
    },
  });
  try {
    const adapter = new SearXNGAdapter();
    const base = { baseUrl: "https://search.example.internal" };
    await adapter.search("q", "", { providerOptions: base });
    await adapter.search("q", "", {
      providerOptions: {
        ...base,
        categories: "general",
        engines: "google,bing",
        language: "en",
        pageno: 2,
        time_range: "week",
        safesearch: 1,
      },
    });
  } finally {
    restore();
  }

  const [plain, configured] = urls.map((u) => new URL(u).searchParams);
  for (const key of ["categories", "engines", "language", "pageno", "time_range", "safesearch"]) {
    assert.equal(plain.get(key), null, `${key} must not be sent when unconfigured`);
  }
  assert.equal(configured.get("categories"), "general");
  assert.equal(configured.get("engines"), "google,bing");
  assert.equal(configured.get("language"), "en");
  assert.equal(configured.get("pageno"), "2");
  assert.equal(configured.get("time_range"), "week");
  assert.equal(configured.get("safesearch"), "1");
});

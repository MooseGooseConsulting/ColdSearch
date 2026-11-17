import test from "node:test";
import assert from "node:assert/strict";
import { BraveAdapter } from "../../dist/adapters/brave.js";
import { installFetchMock, jsonResponse } from "./_fetch-mock.mjs";

test("brave search clamps providerOptions count to 1..20 (default 10)", async () => {
  const urls = [];
  const restore = installFetchMock({
    "*": async ({ url }) => {
      urls.push(url);
      return jsonResponse({ web: { results: [] } });
    },
  });
  try {
    const adapter = new BraveAdapter();
    await adapter.search("q", "k");
    await adapter.search("q", "k", { providerOptions: { count: 50 } });
    await adapter.search("q", "k", { providerOptions: { count: 0 } });
  } finally {
    restore();
  }

  const counts = urls.map((u) => new URL(u).searchParams.get("count"));
  assert.deepEqual(counts, ["10", "20", "1"]);
});

test("brave search sends safesearch only for valid configured values", async () => {
  const urls = [];
  const restore = installFetchMock({
    "*": async ({ url }) => {
      urls.push(url);
      return jsonResponse({ web: { results: [] } });
    },
  });
  try {
    const adapter = new BraveAdapter();
    await adapter.search("q", "k");
    await adapter.search("q", "k", { providerOptions: { safesearch: "strict" } });
    await adapter.search("q", "k", { providerOptions: { safesearch: "bogus" } });
  } finally {
    restore();
  }

  const params = urls.map((u) => new URL(u).searchParams);
  assert.equal(params[0].get("safesearch"), null);
  assert.equal(params[1].get("safesearch"), "strict");
  assert.equal(params[2].get("safesearch"), null);
});

test("brave position-based score fallback floors at 0.1", async () => {
  const restore = installFetchMock({
    "*": async () =>
      jsonResponse({
        web: {
          results: Array.from({ length: 15 }, (_, i) => ({
            title: `R${i}`,
            url: `https://x.example/${i}`,
            description: "d",
          })),
        },
      }),
  });
  try {
    const adapter = new BraveAdapter();
    const results = await adapter.search("q", "k");
    for (const r of results) {
      assert.ok(r.score >= 0.1, `score ${r.score} must not go below 0.1`);
    }
  } finally {
    restore();
  }
});

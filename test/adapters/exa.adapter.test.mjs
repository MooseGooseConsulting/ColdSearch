import test from "node:test";
import assert from "node:assert/strict";
import { ExaAdapter } from "../../dist/adapters/exa.js";
import { installFetchMock, jsonResponse } from "./_fetch-mock.mjs";

test("exa crawl discovers then fetches contents", async () => {
  let searchCalled = 0;
  let contentsCalled = 0;

  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      searchCalled++;
      const body = JSON.parse(init.body);
      assert.match(body.query, /^site:/);
      // `useAutoprompt` was retired upstream; `type` selects the mode.
      assert.equal("useAutoprompt" in body, false);
      return jsonResponse({
        results: [{ url: "https://x.example/a", title: "A" }],
      });
    },
    "POST https://api.exa.ai/contents": async ({ init }) => {
      contentsCalled++;
      const body = JSON.parse(init.body);
      assert.ok(Array.isArray(body.urls));
      // Exa's field is camelCase `livecrawlTimeout`; the snake_case spelling is
      // silently ignored upstream and must not come back.
      assert.equal(body.livecrawlTimeout, 10000);
      assert.equal("livecrawl_timeout" in body, false);
      return jsonResponse({
        results: [
          { url: "https://x.example", title: "Root", text: "r" },
          { url: "https://x.example/a", title: "A", text: "a" },
        ],
      });
    },
  });

  try {
    const adapter = new ExaAdapter();
    const results = await adapter.crawl("https://x.example", "k", { limit: 2 });
    assert.equal(searchCalled, 1);
    assert.equal(contentsCalled, 1);
    assert.equal(results.length, 2);
    assert.deepEqual(Object.keys(results[0]).sort(), ["content", "title", "url"]);
  } finally {
    restore();
  }
});

test("exa search highlights mode sets contents.highlights and joins highlights into snippet", async () => {
  let capturedBody;

  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        results: [
          { title: "T", url: "https://x.example/h", highlights: ["a", "b"], score: 0.9 },
        ],
      });
    },
  });

  try {
    const adapter = new ExaAdapter();
    const results = await adapter.search("q", "k", {
      providerOptions: { highlights: true },
    });

    // Request body: highlights content block, NOT a text block.
    assert.deepEqual(capturedBody.contents, { highlights: true });
    assert.ok(!("text" in capturedBody.contents), "contents must not include a text block");

    // Normalization: highlights joined with " ... " into snippet.
    assert.equal(results.length, 1);
    assert.equal(results[0].snippet, "a ... b");
  } finally {
    restore();
  }
});


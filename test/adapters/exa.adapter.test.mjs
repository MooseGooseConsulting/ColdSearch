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
      // Domain scoping comes from includeDomains; no redundant `site:` operator.
      assert.equal(body.query, "x.example");
      assert.deepEqual(body.includeDomains, ["x.example"]);
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
      // The deprecated `livecrawl` flag must never be sent, and
      // `livecrawlTimeout` is only meaningful alongside maxAgeHours — without
      // maxAgeHours both stay out of the body.
      assert.equal("livecrawl" in body, false);
      assert.equal("livecrawlTimeout" in body, false);
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
    assert.deepEqual(Object.keys(results[0]).sort(), ["content", "derived", "status", "title", "url"]);
    assert.equal(results[0].derived, true);
    assert.equal(results[0].status, "completed");
  } finally {
    restore();
  }
});

test("exa findSimilar maps common limit to numResults", async () => {
  const restore = installFetchMock({
    "POST https://api.exa.ai/findSimilar": async ({ init }) => {
      assert.equal(JSON.parse(init.body).numResults, 7);
      return jsonResponse({ results: [] });
    },
  });
  try {
    await new ExaAdapter().findSimilar("https://example.com", "k", { limit: 7 });
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

test("exa search rejects an invalid searchType before calling upstream", async () => {
  let fetchCalled = 0;
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async () => {
      fetchCalled++;
      return jsonResponse({ results: [] });
    },
  });

  try {
    const adapter = new ExaAdapter();
    await assert.rejects(
      adapter.search("q", "k", { providerOptions: { searchType: "neurl" } }),
      /Invalid Exa searchType "neurl"/
    );
    assert.equal(fetchCalled, 0, "must fail fast before any upstream call");
  } finally {
    restore();
  }
});

test("exa extract never sends livecrawl; sends top-level maxAgeHours only when configured", async () => {
  const bodies = [];
  const restore = installFetchMock({
    "POST https://api.exa.ai/contents": async ({ init }) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({
        results: [{ url: "https://x.example", title: "T", text: "body" }],
      });
    },
  });

  try {
    const adapter = new ExaAdapter();
    await adapter.extract("https://x.example", "k");
    await adapter.extract("https://x.example", "k", {
      providerOptions: { maxAgeHours: 24 },
    });
  } finally {
    restore();
  }

  assert.equal("livecrawl" in bodies[0], false);
  assert.equal("maxAgeHours" in bodies[0], false);
  assert.equal("livecrawl" in bodies[1], false);
  assert.equal(bodies[1].maxAgeHours, 24);
});

test("exa crawl sends livecrawlTimeout only alongside maxAgeHours", async () => {
  let contentsBody;
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A" }] }),
    "POST https://api.exa.ai/contents": async ({ init }) => {
      contentsBody = JSON.parse(init.body);
      return jsonResponse({
        results: [{ url: "https://x.example", title: "Root", text: "r" }],
      });
    },
  });

  try {
    const adapter = new ExaAdapter();
    await adapter.crawl("https://x.example", "k", {
      limit: 1,
      providerOptions: { maxAgeHours: 0 },
    });
  } finally {
    restore();
  }

  assert.equal("livecrawl" in contentsBody, false);
  assert.equal(contentsBody.maxAgeHours, 0);
  // camelCase `livecrawlTimeout`; the snake_case spelling is silently ignored
  // upstream and must not come back.
  assert.equal(contentsBody.livecrawlTimeout, 10000);
  assert.equal("livecrawl_timeout" in contentsBody, false);
});

test("exa search accepts the lite tier and sends it as type", async () => {
  let capturedBody;
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({ results: [] });
    },
  });
  try {
    await new ExaAdapter().search("q", "k", { providerOptions: { searchType: "lite" } });
    assert.equal(capturedBody.type, "lite");
  } finally {
    restore();
  }
});

test("exa code-context shape: one lite request, highlights only, first two lines as snippet", async () => {
  let calls = 0;
  let capturedBody;
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      calls++;
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        results: [
          {
            title: "React 19 upgrade guide",
            url: "https://react.dev/blog/react-19-upgrade-guide",
            highlights: ["ref as a prop", "useActionState replaces useFormState", "third line"],
            score: 0.9,
          },
          { title: "No highlights", url: "https://x.example/none", text: "fallback text" },
        ],
      });
    },
  });
  try {
    const results = await new ExaAdapter().search("React 19 migration", "k", {
      limit: 5,
      providerOptions: { searchType: "lite", highlights: true, snippetHighlightLines: 2 },
    });
    // Exactly one request, in the template's shape; no text block, no LLM.
    assert.equal(calls, 1);
    assert.equal(capturedBody.type, "lite");
    assert.equal(capturedBody.numResults, 5);
    assert.deepEqual(capturedBody.contents, { highlights: true });
    // Snippet is the first two highlight lines; every highlight is preserved.
    assert.equal(results[0].snippet, "ref as a prop\nuseActionState replaces useFormState");
    assert.deepEqual(results[0].highlights, [
      "ref as a prop",
      "useActionState replaces useFormState",
      "third line",
    ]);
    assert.equal(results[0].tokens, undefined, "no token report without measureText");
    // A result without highlights falls back to its text and an empty array.
    assert.equal(results[1].snippet, "fallback text");
    assert.deepEqual(results[1].highlights, []);
  } finally {
    restore();
  }
});

test("exa measureText co-requests text in the same call and reports the token reduction", async () => {
  let calls = 0;
  let capturedBody;
  const longText = Array.from({ length: 400 }, (_, i) => `sentence number ${i} about hooks.`).join(" ");
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      calls++;
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        results: [
          {
            title: "T",
            url: "https://x.example/h",
            highlights: ["ref as a prop", "useActionState"],
            text: longText,
            score: 0.9,
          },
          { title: "U", url: "https://x.example/u", highlights: ["only highlights"] },
        ],
      });
    },
  });
  try {
    const results = await new ExaAdapter().search("q", "k", {
      providerOptions: {
        searchType: "lite",
        highlights: true,
        snippetHighlightLines: 2,
        measureText: true,
        maxCharacters: 5000,
      },
    });
    assert.equal(calls, 1, "measurement must not add a second request");
    assert.deepEqual(capturedBody.contents, { highlights: true, text: { maxCharacters: 5000 } });

    const measured = results[0].tokens;
    assert.equal(measured.tokenizer, "o200k_base");
    assert.ok(measured.highlights > 0);
    assert.ok(measured.text > measured.highlights);
    assert.ok(measured.reductionPct > 50, `expected a large reduction, got ${measured.reductionPct}`);
    // The page text is measured, never echoed into the normalized result.
    assert.equal("text" in results[0], false);
    assert.equal(results[0].snippet, "ref as a prop\nuseActionState");

    // No text returned for a result: counted highlights, unmeasured reduction.
    assert.equal(results[1].tokens.text, null);
    assert.equal(results[1].tokens.reductionPct, null);
    assert.ok(results[1].tokens.highlights > 0);
  } finally {
    restore();
  }
});

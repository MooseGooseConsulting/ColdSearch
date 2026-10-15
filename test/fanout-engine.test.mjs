import test from "node:test";
import assert from "node:assert/strict";
import { FanoutEngine } from "../dist/engine/fanout.js";
import { installFetchMock, jsonResponse, textResponse, rawResponse } from "./adapters/_fetch-mock.mjs";

function makeConfig(overrides) {
  return {
    capabilities: {
      search: { providers: ["brave", "serper"], strategy: "all" },
      extract: { providers: ["exa", "jina"], strategy: "all" },
      crawl: { providers: ["tavily", "exa"], strategy: "all" },
      ...(overrides?.capabilities || {}),
    },
    providers: {
      brave: { keyPool: { keys: ["k"] } },
      serper: { keyPool: { keys: ["k"] } },
      exa: { keyPool: { keys: ["k"] } },
      jina: { keyPool: { keys: [] } },
      tavily: { keyPool: { keys: ["k"] } },
      ...(overrides?.providers || {}),
    },
  };
}

test('strategy: "random" selects exactly one provider', async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.9; // pick last provider

  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("brave.com")) return jsonResponse({ web: { results: [] } });
      if (url.includes("serper.dev")) return jsonResponse({ organic: [] });
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { search: { providers: ["brave", "serper"], strategy: "random" } },
      })
    );

    const out = await engine.search("q", { limit: 5 });
    assert.equal(out.providersUsed.length, 1);
    assert.equal(out.providersUsed[0], "serper");
  } finally {
    restore();
    Math.random = originalRandom;
  }
});

test("parallel fanout collects and merges results from multiple providers", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("brave.com")) {
        return jsonResponse({
          web: { results: [{ title: "B", url: "https://b.example", description: "bb", relevance_score: 0.9 }] },
        });
      }
      if (url.includes("serper.dev")) {
        return jsonResponse({
          organic: [{ title: "S", link: "https://s.example", snippet: "ss", position: 1 }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.search("q", { limit: 10, rerankStrategy: "none" });
    assert.deepEqual(new Set(out.providersUsed), new Set(["brave", "serper"]));
    assert.equal(out.results.length, 2);
    assert.ok(out.results.some((r) => r.url === "https://b.example"));
    assert.ok(out.results.some((r) => r.url === "https://s.example"));
  } finally {
    restore();
  }
});

test("sequential extract tries providers in order and returns on first success", async () => {
  const restore = installFetchMock({
    "POST https://api.exa.ai/contents": async () => rawResponse("nope", { status: 500 }),
    "*": async ({ url }) => {
      if (url.startsWith("https://r.jina.ai/")) {
        return textResponse("Title: T\n\nBody");
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.extract("https://x.example", { limit: 1 });
    assert.equal(out.provider, "jina");
    assert.equal(out.result?.content, "Body");
    assert.ok(out.errors?.exa);
  } finally {
    restore();
  }
});

test("sequential crawl tries providers in order and returns on first success", async () => {
  const restore = installFetchMock({
    "POST https://api.tavily.com/crawl": async () => rawResponse("no", { status: 401 }),
    "POST https://api.exa.ai/search": async () => jsonResponse({ results: [{ url: "https://x.example/a" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "a" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["tavily", "exa"], strategy: "all" } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });
    assert.equal(out.provider, "exa");
    assert.equal(out.results.length, 1);
    assert.ok(out.errors?.tavily);
  } finally {
    restore();
  }
});

test("pending Firecrawl crawl falls through to a completed provider", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-pending", url: "https://x.example" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-pending": async () =>
      jsonResponse({ success: true, status: "scraping" }),
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "a" }] }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "exa"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });
    assert.equal(out.provider, "exa");
    assert.equal(out.status, "pending");
    assert.equal(out.results.length, 1, "pending jobs are not counted as crawled pages");
    assert.equal(out.results[0].url, "https://x.example/a");
    assert.equal(out.results[0].status, "completed");
    assert.deepEqual(out.pendingJobs, [
      { provider: "firecrawl", jobId: "job-pending", url: "https://x.example" },
    ]);
    assert.equal(out.attempts[0].provider, "firecrawl");
    assert.equal(out.attempts[0].success, false);
    assert.equal(out.attempts[0].pending, true);
    assert.equal(out.attempts[1].provider, "exa");
    assert.equal(out.attempts[1].success, true);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pending crawl fallback preserves every pending job id and status", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  let nextJob = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: `job-${++nextJob}`, url: "https://x.example" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-1": async () =>
      jsonResponse({ success: true, status: "scraping" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-2": async () =>
      jsonResponse({ success: true, status: "scraping" }),
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { crawl: { providers: ["firecrawl", "firecrawl"], strategy: "all" } },
        providers: { firecrawl: { keyPool: { keys: ["k"] } } },
      })
    );
    const out = await engine.crawl("https://x.example", { limit: 1 });
    assert.equal(out.status, "pending");
    assert.deepEqual(out.results, [], "pending handles are not page results");
    assert.deepEqual(out.pendingJobs.map((job) => job.jobId), ["job-1", "job-2"]);
    assert.ok(out.pendingJobs.every((job) => job.provider === "firecrawl"));
    assert.ok(out.attempts.every((attempt) => attempt.pending && !attempt.success));
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});


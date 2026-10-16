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
      jina: { keyPool: [] },
      tavily: { keyPool: { keys: ["k"] } },
      ...(overrides?.providers || {}),
    },
  };
}

test("search attempts carry tool/nativeName/executionMode provenance", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("brave.com")) return jsonResponse({ web: { results: [] } });
      if (url.includes("serper.dev")) return jsonResponse({ organic: [] });
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.search("q", { limit: 5 });
    assert.equal(out.attempts.length, 2);
    const byProvider = Object.fromEntries(out.attempts.map((a) => [a.provider, a]));

    assert.equal(byProvider.brave.tool, "webSearch");
    assert.equal(byProvider.brave.toolNativeName, "GET /res/v1/web/search");
    assert.equal(byProvider.brave.executionMode, "sync");

    assert.equal(byProvider.serper.tool, "search");
    assert.equal(byProvider.serper.toolNativeName, "POST /search");
    assert.equal(byProvider.serper.executionMode, "sync");
  } finally {
    restore();
  }
});

test("failed search attempts keep provenance too", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("brave.com")) return rawResponse("boom", { status: 500 });
      if (url.includes("serper.dev")) return jsonResponse({ organic: [] });
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.search("q", { limit: 5 });
    const braveAttempt = out.attempts.find((a) => a.provider === "brave");
    assert.equal(braveAttempt.success, false);
    assert.equal(braveAttempt.tool, "webSearch");
    assert.equal(braveAttempt.toolNativeName, "GET /res/v1/web/search");
    assert.equal(braveAttempt.executionMode, "sync");
  } finally {
    restore();
  }
});

test("limit is wired upstream through commonOptions translation", async () => {
  let serperNum;
  let braveCount;
  const restore = installFetchMock({
    "*": async ({ url, init }) => {
      if (url.includes("brave.com")) {
        braveCount = new URL(url).searchParams.get("count");
        return jsonResponse({ web: { results: [] } });
      }
      if (url.includes("serper.dev")) {
        serperNum = JSON.parse(init.body).num;
        return jsonResponse({ organic: [] });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    await engine.search("q", { limit: 3 });
    // brave.webSearch count and serper num come from the translated limit,
    // not from config providerOptions (none configured here).
    assert.equal(braveCount, "3");
    assert.equal(serperNum, 3);
  } finally {
    restore();
  }
});

test("unsupported weekly filters exclude SearXNG before any provider call", async () => {
  let fetchCount = 0;
  const restore = installFetchMock({
    "*": async () => {
      fetchCount++;
      return jsonResponse({ results: [] });
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { search: { providers: ["searxng"], strategy: "all" } },
        providers: {
          searxng: { keyPool: { keys: [] }, options: { baseUrl: "http://searxng.test" } },
        },
      })
    );
    await assert.rejects(
      engine.search("q", { limit: 5, commonOptions: { timeRange: "week" } }),
      /can honor the requested common filters/i
    );
    assert.equal(fetchCount, 0);
  } finally {
    restore();
  }
});

test("domain filters are passed only to providers that honor them", async () => {
  let tavilyBody;
  const calls = [];
  const restore = installFetchMock({
    "*": async ({ url, init }) => {
      calls.push(url);
      if (url.includes("api.tavily.com")) {
        tavilyBody = JSON.parse(init.body);
        return jsonResponse({ results: [] });
      }
      throw new Error(`unexpected provider call: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({ capabilities: { search: { providers: ["tavily", "brave"], strategy: "all" } } })
    );
    const out = await engine.search("q", {
      limit: 5,
      commonOptions: {
        includeDomains: ["allowed.example"],
        excludeDomains: ["blocked.example"],
      },
    });
    assert.deepEqual(calls.length, 1);
    assert.deepEqual(tavilyBody.include_domains, ["allowed.example"]);
    assert.deepEqual(tavilyBody.exclude_domains, ["blocked.example"]);
    assert.match(out.skippedProviders.brave, /cannot honor the requested filters/);
    assert.equal(out.attempts.some((attempt) => attempt.provider === "brave"), false);
  } finally {
    restore();
  }
});

test("direct url-similarity intent callers route only to Exa findSimilar", async () => {
  const paths = [];
  const restore = installFetchMock({
    "*": async ({ url }) => {
      paths.push(new URL(url).pathname);
      if (url.includes("api.exa.ai/findSimilar")) return jsonResponse({ results: [] });
      throw new Error(`unexpected provider call: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({ capabilities: { search: { providers: ["tavily", "exa"], strategy: "all" } } })
    );
    const out = await engine.search("https://seed.example", {
      limit: 5,
      intent: "url-similarity",
    });
    assert.deepEqual(out.providersUsed, ["exa"]);
    assert.deepEqual(paths, ["/findSimilar"]);
  } finally {
    restore();
  }
});

test("direct content-backed intent callers request provider content", async () => {
  let tavilyBody;
  const restore = installFetchMock({
    "*": async ({ url, init }) => {
      if (!url.includes("api.tavily.com")) throw new Error(`unexpected provider call: ${url}`);
      tavilyBody = JSON.parse(init.body);
      return jsonResponse({
        results: [{ title: "T", url: "https://x.example", content: "Summary", raw_content: "Full page" }],
      });
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({ capabilities: { search: { providers: ["tavily", "brave"], strategy: "all" } } })
    );
    const out = await engine.search("q", { limit: 5, intent: "content-backed-retrieval" });
    assert.equal(tavilyBody.include_raw_content, "markdown");
    assert.deepEqual(out.providersUsed, ["tavily"]);
    assert.equal(out.results[0].snippet, "Full page");
  } finally {
    restore();
  }
});

test("requireFeatures narrows the provider pool (content-backed retrieval)", async () => {
  const calls = [];
  const restore = installFetchMock({
    "*": async ({ url }) => {
      calls.push(url);
      if (url.includes("api.tavily.com")) return jsonResponse({ results: [] });
      if (url.includes("brave.com")) return jsonResponse({ web: { results: [] } });
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(
      makeConfig({
        capabilities: { search: { providers: ["tavily", "brave"], strategy: "all" } },
      })
    );
    const out = await engine.search("q", {
      limit: 5,
      requireFeatures: ["integratedContent"],
    });
    assert.deepEqual(out.providersUsed, ["tavily"]);
    assert.ok(calls.every((url) => !url.includes("brave.com")), "brave was never called");
  } finally {
    restore();
  }
});

test("extract attempts carry provenance (firecrawl backed by scrape)", async () => {
  const restore = installFetchMock({
    "POST https://api.exa.ai/contents": async () => rawResponse("nope", { status: 500 }),
    "*": async ({ url }) => {
      if (url.startsWith("https://r.jina.ai/")) return textResponse("Title: T\n\nBody");
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const engine = new FanoutEngine(makeConfig());
    const out = await engine.extract("https://x.example", { limit: 1 });
    const exaAttempt = out.attempts.find((a) => a.provider === "exa");
    assert.equal(exaAttempt.tool, "contents");
    assert.equal(exaAttempt.toolNativeName, "POST /contents");
    assert.equal(exaAttempt.executionMode, "sync");
    const jinaAttempt = out.attempts.find((a) => a.provider === "jina");
    assert.equal(jinaAttempt.tool, "reader");
    assert.equal(jinaAttempt.toolNativeName, "GET r.jina.ai");
  } finally {
    restore();
  }
});

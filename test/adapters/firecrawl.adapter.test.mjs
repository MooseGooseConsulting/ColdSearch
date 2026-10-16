import test from "node:test";
import assert from "node:assert/strict";
import { FirecrawlAdapter, FirecrawlCrawlTerminalError } from "../../dist/adapters/firecrawl.js";
import { installFetchMock, jsonResponse } from "./_fetch-mock.mjs";

test("firecrawl search normalizes results", async () => {
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/search": async () =>
      jsonResponse({
        success: true,
        data: {
          web: [
            { title: "A", url: "https://a.example", description: "aa", score: 0.8 },
            { metadata: { title: "B", sourceURL: "https://b.example", description: "bb" } },
          ],
        },
      }),
  });
  try {
    const adapter = new FirecrawlAdapter();
    const results = await adapter.search("q", "k");
    assert.equal(results.length, 2);
    assert.equal(results[0].source, "firecrawl");
    assert.equal(results[0].url, "https://a.example");
    assert.equal(results[1].url, "https://b.example");
  } finally {
    restore();
  }
});

test("firecrawl search clamps the provider limit to 1 through 100", async () => {
  const seen = [];
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/search": async ({ init }) => {
      seen.push(JSON.parse(init.body).limit);
      return jsonResponse({ success: true, data: { web: [] } });
    },
  });
  try {
    const adapter = new FirecrawlAdapter();
    await adapter.search("q", "k", { limit: 101 });
    await adapter.search("q", "k", { limit: 0 });
    assert.deepEqual(seen, [100, 1]);
  } finally {
    restore();
  }
});

test("firecrawl crawl polls until completion", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  // Avoid real sleeps from the adapter polling loop.
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args);
  globalThis.clearTimeout = (...args) => originalClearTimeout(...args);

  let pollCount = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-1" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-1": async () => {
      pollCount++;
      if (pollCount < 2) {
        return jsonResponse({ success: true, status: "scraping" });
      }
      return jsonResponse({
        success: true,
        status: "completed",
        data: [{ markdown: "c", metadata: { title: "T", sourceURL: "https://x.example/1" } }],
      });
    },
  });
  try {
    const adapter = new FirecrawlAdapter();
    const results = await adapter.crawl("https://x.example", "k", { limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://x.example/1");
    assert.equal(pollCount >= 2, true);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("firecrawl crawl keeps the 30-poll budget and returns a resumable pending job", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args);

  let pollCount = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-pending" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-pending": async () => {
      pollCount++;
      return jsonResponse({ success: true, status: "scraping" });
    },
  });
  try {
    const results = await new FirecrawlAdapter().crawl("https://example.com", "k", { limit: 1 });
    assert.deepEqual(results, [{
      url: "https://example.com",
      title: "",
      content: "",
      status: "pending",
      jobId: "job-pending",
    }]);
    assert.equal(pollCount, 30);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("firecrawl resume polls the encoded job ID without starting a duplicate crawl", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args);

  let startCount = 0;
  const jobId = "job/a?b#c";
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () => {
      startCount++;
      return jsonResponse({ success: true, id: "unexpected-new-job" });
    },
    "GET https://api.firecrawl.dev/v2/crawl/job%2Fa%3Fb%23c": async () =>
      jsonResponse({
        success: true,
        status: "completed",
        data: [{ markdown: "# Resumed", metadata: { title: "Resumed", sourceURL: "https://x.example" } }],
      }),
  });
  try {
    const results = await new FirecrawlAdapter().crawl("  https://x.example  ", "k", {
      limit: 1,
      resumeJobId: jobId,
    });
    assert.equal(startCount, 0, "resume must not POST a duplicate crawl");
    assert.equal(results[0].content, "# Resumed");
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("firecrawl poll errors take precedence over completed response data", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => originalSetTimeout(fn, 0, ...args);
  const restore = installFetchMock({
    "GET https://api.firecrawl.dev/v2/crawl/completed-error": async () =>
      jsonResponse({
        success: false,
        status: "completed",
        error: "partial failure",
        data: [{ markdown: "must not be accepted", metadata: { sourceURL: "https://x.example/bad" } }],
      }),
    "GET https://api.firecrawl.dev/v2/crawl/failed-with-data": async () =>
      jsonResponse({
        success: true,
        status: "failed",
        error: "crawl failed",
        data: [{ markdown: "must not be accepted", metadata: { sourceURL: "https://x.example/bad" } }],
      }),
  });

  try {
    const adapter = new FirecrawlAdapter();
    await assert.rejects(
      adapter.crawl("https://x.example", "k", { limit: 1, resumeJobId: "completed-error" }),
      (error) => {
        assert.equal(error instanceof FirecrawlCrawlTerminalError, false);
        assert.match(error.message, /partial failure/);
        return true;
      }
    );
    await assert.rejects(
      adapter.crawl("https://x.example", "k", { limit: 1, resumeJobId: "failed-with-data" }),
      (error) => {
        assert.ok(error instanceof FirecrawlCrawlTerminalError);
        assert.match(error.message, /crawl failed/);
        return true;
      }
    );
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
  }
});


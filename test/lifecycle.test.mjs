import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FirecrawlAdapter } from "../dist/adapters/firecrawl.js";
import { ExaAdapter } from "../dist/adapters/exa.js";
import { executeToolCall } from "../dist/tools/substrate.js";
import { assertNormalizedResult } from "../dist/contracts/envelope.js";
import { installFetchMock, jsonResponse } from "./adapters/_fetch-mock.mjs";

/**
 * Lifecycle tests (issue #79, PR-E): async provider jobs driven through
 * scripted fetch-mock response sequences — pending/scraping/completed/failed,
 * transient poll failures, timeouts, and Bright Data snapshot threading.
 */

/** Patch timers so poll loops run without real sleeps; restores on exit. */
async function withFastTimers(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (cb, _ms, ...args) => originalSetTimeout(cb, 0, ...args);
  globalThis.clearTimeout = (...args) => originalClearTimeout(...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test("firecrawl crawl: pending → scraping → completed returns results", async () => {
  const statuses = ["pending", "scraping", "completed"];
  let pollCount = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-lc1" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-lc1": async () => {
      const status = statuses[Math.min(pollCount++, statuses.length - 1)];
      if (status !== "completed") return jsonResponse({ success: true, status });
      return jsonResponse({
        success: true,
        status,
        data: [
          { markdown: "# Page", metadata: { title: "Page", sourceURL: "https://x.example/1" } },
        ],
      });
    },
  });
  try {
    await withFastTimers(async () => {
      const adapter = new FirecrawlAdapter();
      const results = await adapter.crawl("https://x.example", "k", { limit: 1 });
      assert.equal(results.length, 1);
      assert.equal(results[0].url, "https://x.example/1");
      assert.equal(results[0].content, "# Page");
      assert.equal(pollCount, 3, "expected pending, scraping, then completed polls");
      assertNormalizedResult("crawl", "firecrawl", results);
    });
  } finally {
    restore();
  }
});

test("firecrawl crawl: failed job throws with the upstream error", async () => {
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-lc2" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-lc2": async () =>
      jsonResponse({ success: true, status: "failed", error: "Upstream render exploded" }),
  });
  try {
    await withFastTimers(async () => {
      const adapter = new FirecrawlAdapter();
      await assert.rejects(
        adapter.crawl("https://x.example", "k", { limit: 1 }),
        /Firecrawl crawl job 'job-lc2' failed: Upstream render exploded/
      );
    });
  } finally {
    restore();
  }
});

test("firecrawl crawl: transient 500 on a poll is retried through to completion", async () => {
  let pollCount = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-lc3" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-lc3": async () => {
      pollCount++;
      if (pollCount === 1) {
        return jsonResponse({ success: false, error: "boom" }, { status: 500 });
      }
      return jsonResponse({
        success: true,
        status: "completed",
        data: [
          { markdown: "ok", metadata: { title: "T", sourceURL: "https://x.example/2" } },
        ],
      });
    },
  });
  try {
    await withFastTimers(async () => {
      const adapter = new FirecrawlAdapter();
      const results = await adapter.crawl("https://x.example", "k", { limit: 1 });
      assert.equal(results.length, 1);
      assert.equal(results[0].url, "https://x.example/2");
      assert.equal(pollCount, 2, "the 500 poll must not abort the crawl");
    });
  } finally {
    restore();
  }
});

test("firecrawl crawl: returns a pending result with the jobId at the poll cap (F-B13)", async () => {
  let pollCount = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "job-lc4" }),
    "GET https://api.firecrawl.dev/v2/crawl/job-lc4": async () => {
      pollCount++;
      return jsonResponse({ success: true, status: "scraping" });
    },
  });
  try {
    await withFastTimers(async () => {
      const adapter = new FirecrawlAdapter();
      const results = await adapter.crawl("https://x.example", "k", { limit: 1 });
      assert.equal(pollCount, 30, "polls until the attempt cap, then preserves the pending job");
      assert.equal(results.length, 1);
      assert.equal(results[0].status, "pending");
      assert.equal(results[0].jobId, "job-lc4");
    });
  } finally {
    restore();
  }
});

test("brightdata substrate: trigger → progress → snapshot threads snapshot_id and status", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-lifecycle-"));
  process.env.BRIGHTDATA_TEST_KEY = "brightdata-lifecycle-key";
  const cfg = {
    capabilities: {
      search: { providers: ["brightdata"], strategy: "random" },
      extract: { providers: ["brightdata"], strategy: "random" },
      crawl: { providers: [], strategy: "random" },
    },
    providers: {
      brightdata: {
        keyPool: { keys: ["env:BRIGHTDATA_TEST_KEY"], strategy: "round-robin" },
        options: { maxStructuredInputsPerCall: 2 },
      },
    },
    logging: { usage: { path: path.join(tmpDir, "usage.jsonl") } },
    history: { path: path.join(tmpDir, "history.jsonl") },
    cache: { enabled: false },
  };

  const seenUrls = [];
  try {
    await withMockSequence(seenUrls, async () => {
      const trigger = await executeToolCall(
        "brightdata",
        "trigger",
        { dataset_id: "gd_lc", input: [{ url: "https://example.com" }] },
        cfg
      );
      assert.equal(trigger.ok, true);
      const snapshotId = trigger.summary.snapshot_id;
      assert.equal(snapshotId, "s_lc1");

      const progress = await executeToolCall(
        "brightdata",
        "progress",
        { snapshot_id: snapshotId },
        cfg
      );
      assert.equal(progress.ok, true);
      assert.equal(progress.summary.snapshot_id, "s_lc1");
      assert.equal(progress.summary.status, "running");

      const snapshot = await executeToolCall(
        "brightdata",
        "snapshot",
        { snapshot_id: snapshotId, format: "json" },
        cfg
      );
      assert.equal(snapshot.ok, true);
      assert.equal(snapshot.summary.records_count, 1);
      assert.equal(snapshot.raw[0].url, "https://example.com/1");
    });

    assert.ok(
      seenUrls.some((u) => u.includes("/datasets/v3/progress/s_lc1")),
      "progress call must be addressed by the triggered snapshot_id"
    );
    assert.ok(
      seenUrls.some((u) => u.includes("/datasets/v3/snapshot/s_lc1")),
      "snapshot download must be addressed by the triggered snapshot_id"
    );
  } finally {
    delete process.env.BRIGHTDATA_TEST_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

async function withMockSequence(seenUrls, fn) {
  const restore = installFetchMock({
    "*": async ({ url, method }) => {
      seenUrls.push(`${method} ${url}`);
      if (url.includes("/datasets/v3/trigger")) {
        return jsonResponse({ snapshot_id: "s_lc1" });
      }
      if (url.includes("/datasets/v3/progress/s_lc1")) {
        return jsonResponse({ snapshot_id: "s_lc1", dataset_id: "gd_lc", status: "running" });
      }
      if (url.includes("/datasets/v3/snapshot/s_lc1")) {
        return jsonResponse([{ url: "https://example.com/1", ok: true }]);
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  try {
    return await fn();
  } finally {
    restore();
  }
}

test("exa findSimilar: highlights envelope and text envelope normalize per contract", async () => {
  const bodies = [];
  let call = 0;
  const restore = installFetchMock({
    "POST https://api.exa.ai/findSimilar": async ({ init }) => {
      bodies.push(JSON.parse(init.body));
      call++;
      if (call === 1) {
        return jsonResponse({
          results: [
            { title: "H", url: "https://h.example", score: 0.9, highlights: ["frag one", "frag two"] },
          ],
        });
      }
      return jsonResponse({
        results: [
          { title: "T", url: "https://t.example", text: "full text body" },
        ],
      });
    },
  });
  try {
    const adapter = new ExaAdapter();

    const withHighlights = await adapter.findSimilar("https://seed.example", "k", {
      providerOptions: { highlights: true },
    });
    assert.equal(withHighlights[0].snippet, "frag one ... frag two");
    assert.equal(withHighlights[0].score, 0.9);
    assert.deepEqual(bodies[0].contents, { highlights: true });
    assertNormalizedResult("search", "exa", withHighlights);

    const withText = await adapter.findSimilar("https://seed.example", "k");
    assert.equal(withText[0].snippet, "full text body");
    // No score on the wire: index-based fallback.
    assert.equal(withText[0].score, 1);
    assert.deepEqual(bodies[1].contents, { text: { maxCharacters: 15000 } });
    assertNormalizedResult("search", "exa", withText);
  } finally {
    restore();
  }
});

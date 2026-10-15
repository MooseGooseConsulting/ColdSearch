import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../dist/history/store.js";
import { searchHistory } from "../dist/history/search.js";
import { redactSensitive, redactForPersistence, REDACTED } from "../dist/history/redact.js";
import { CacheStore } from "../dist/cache/cache.js";
import { cacheKey } from "../dist/cache/key.js";
import { LocalExecutionBackend } from "../dist/execution/backend.js";
import { installFetchMock, jsonResponse, textResponse } from "./adapters/_fetch-mock.mjs";

function makeTempDir(tag = "coldsearch-hist-") {
  return mkdtempSync(join(tmpdir(), tag));
}

function readRecords(historyPath) {
  return new HistoryStore({ path: historyPath }).list();
}

/**
 * Temp config: brave+serper fanout search, jina extract, exa crawl, with
 * cache and history pointed at temp dirs.
 */
function writeTempConfig() {
  const dir = makeTempDir();
  const cacheDir = join(dir, "cache");
  const historyPath = join(dir, "history.jsonl");
  const configPath = join(dir, "config.toml");
  const toml = `
[capabilities.search]
providers = ["brave", "serper"]
strategy = "all"

[capabilities.extract]
providers = ["jina"]
strategy = "all"

[capabilities.crawl]
providers = ["exa"]
strategy = "all"

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]

[providers.serper]
[providers.serper.keyPool]
keys = ["k"]

[providers.jina]
[providers.jina.keyPool]
keys = []

[providers.exa]
[providers.exa.keyPool]
keys = ["k"]

[cache]
enabled = true
search_ttl = "6h"
extract_ttl = "24h"
path = ${JSON.stringify(cacheDir)}

[history]
path = ${JSON.stringify(historyPath)}
`;
  writeFileSync(configPath, toml, "utf8");
  return { dir, cacheDir, historyPath, configPath };
}

function makeSearchMock(counter, { failSerper = false } = {}) {
  return {
    "*": async ({ url }) => {
      counter.calls++;
      if (url.includes("brave.com")) {
        return jsonResponse({
          web: {
            results: [
              { title: "B", url: "https://b.example", description: "bb", relevance_score: 0.9 },
            ],
          },
        });
      }
      if (url.includes("serper.dev")) {
        if (failSerper) return jsonResponse({ error: "serper exploded" }, { status: 500 });
        return jsonResponse({
          organic: [{ title: "S", url: "https://s.example", snippet: "ss", position: 1 }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  };
}

// ---------------------------------------------------------------------------
// HistoryStore
// ---------------------------------------------------------------------------

test("store: append/list/recent/get/clear round trip, corrupt lines skipped", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "history.jsonl");
    const store = new HistoryStore({ path });
    const base = {
      timestamp: new Date().toISOString(),
      command: "search",
      input: "q",
      source: "live",
      attempts: [],
      raw_available: false,
      duration_ms: 1,
      outcome: "success",
    };
    store.append({ ...base, id: "exec-1" });
    store.append({ ...base, id: "exec-2" });
    store.append({ ...base, id: "exec-3" });
    // A corrupt line must not make history unreadable.
    writeFileSync(path, "{ not json\n", { flag: "a" });

    assert.equal(store.list().length, 3);
    assert.deepEqual(
      store.recent(2).map((r) => r.id),
      ["exec-3", "exec-2"],
      "recent returns newest first, bounded"
    );
    assert.equal(store.get("exec-2")?.input, "q");
    assert.equal(store.get("nope"), null);

    assert.equal(store.clear(), 3);
    assert.equal(store.list().length, 0);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redactSensitive scrubs resolved credential values anywhere in content", () => {
  const secret = "tvly-ABCDEFGHIJKLMNOP";
  const raw = { error: `invalid key ${secret} provided`, nested: [{ msg: secret }] };
  const scrubbed = redactSensitive(raw, [secret]);
  assert.equal(JSON.stringify(scrubbed).includes(secret), false);
  assert.ok(JSON.stringify(scrubbed).includes(REDACTED));
  // Input is not mutated.
  assert.ok(raw.error.includes(secret));
});

test("redactSensitive redacts signed-URL tokens and credential fields recursively", () => {
  const signed =
    "https://s3.example/obj?X-Amz-Signature=abc123&X-Amz-Credential=AKIA%2Fxyz&token=t0ken&keep=this";
  const value = {
    url: signed,
    options: { api_key: "should-go", note: "stays" },
    results: [{ title: "t", url: "https://x.example/?sig=zzz&a=1" }],
  };
  const scrubbed = redactSensitive(value, []);
  assert.equal(scrubbed.options.api_key, REDACTED);
  assert.equal(scrubbed.options.note, "stays");
  assert.ok(scrubbed.url.includes("X-Amz-Signature=[REDACTED]"));
  assert.ok(scrubbed.url.includes("token=[REDACTED]"));
  assert.ok(scrubbed.url.includes("keep=this"));
  assert.ok(scrubbed.results[0].url.includes("sig=[REDACTED]"));
  assert.ok(scrubbed.results[0].url.includes("a=1"));
});

test("redactSensitive redacts zone names that embed customer IDs", () => {
  const value = {
    options: { zone: "brd-customer_abc123-zone-serp", query: "pizza" },
    nested: { serpZone: "brd-customer_abc123-zone-serp" },
  };
  const scrubbed = redactSensitive(value, []);
  // Exact `zone` field is redacted; `serpZone` is a config option name that
  // never appears in persisted params.
  assert.equal(scrubbed.options.zone, REDACTED);
  assert.equal(scrubbed.options.query, "pizza");
  assert.equal(scrubbed.nested.serpZone, "brd-customer_abc123-zone-serp");
});

test("redactForPersistence returns null for unserializable content (fail-closed)", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(redactForPersistence(circular, []), null);
  assert.ok(redactForPersistence({ a: 1 }, []) !== null);
});

// ---------------------------------------------------------------------------
// searchHistory (local retrieval)
// ---------------------------------------------------------------------------

function fakeRecord(overrides) {
  return {
    id: overrides.id,
    timestamp: overrides.timestamp ?? "2026-08-10T00:00:00.000Z",
    command: overrides.command ?? "search",
    input: overrides.input ?? "unrelated query",
    options: overrides.options,
    routing: overrides.routing ?? { providers_attempted: ["brave"] },
    source: "live",
    attempts: overrides.attempts ?? [{ provider: "brave", success: true }],
    partitions: overrides.partitions,
    result: overrides.result,
    result_count: Array.isArray(overrides.result) ? overrides.result.length : undefined,
    raw_available: false,
    duration_ms: 5,
    outcome: "success",
  };
}

test("history search matches request, titles, urls, content, provider — with reasons", () => {
  const records = [
    fakeRecord({ id: "e-request", input: "strix halo inference benchmarks" }),
    fakeRecord({
      id: "e-title",
      result: [{ title: "Strix Halo review", url: "https://a.example", snippet: "x" }],
    }),
    fakeRecord({
      id: "e-url",
      result: [{ title: "t", url: "https://strix-halo.example/article", snippet: "x" }],
    }),
    fakeRecord({
      id: "e-content",
      command: "extract",
      result: { title: "t", url: "https://b.example", content: "deep dive on strix halo thermals" },
    }),
    fakeRecord({
      id: "e-provider",
      attempts: [{ provider: "strix", success: true }],
      routing: { providers_attempted: ["strix"] },
    }),
    fakeRecord({ id: "e-nomatch", input: "something else entirely" }),
  ];

  const matches = searchHistory(records, "strix halo");
  const byId = Object.fromEntries(matches.map((m) => [m.execution.id, m]));

  assert.equal(byId["e-nomatch"], undefined);
  assert.deepEqual(byId["e-request"].matched_on, ["request"]);
  assert.deepEqual(byId["e-title"].matched_on, ["result_title"]);
  assert.deepEqual(byId["e-url"].matched_on, ["result_url"]);
  assert.deepEqual(byId["e-content"].matched_on, ["content"]);
  assert.deepEqual(byId["e-provider"].matched_on, ["provider"]);
  // Request matches rank strongest.
  assert.equal(matches[0].execution.id, "e-request");
  // Matching results are exposed beneath the execution.
  assert.equal(byId["e-title"].matching_results[0].url, "https://a.example");
});

test("history search bounds output by default (20) and honors an explicit limit", () => {
  const records = [];
  for (let i = 0; i < 25; i++) {
    records.push(
      fakeRecord({
        id: `e-${String(i).padStart(2, "0")}`,
        timestamp: `2026-08-10T00:00:${String(i).padStart(2, "0")}.000Z`,
        input: "common term query",
      })
    );
  }
  assert.equal(searchHistory(records, "common term").length, 20);
  assert.equal(searchHistory(records, "common term", 5).length, 5);
  // Newest first within a tier.
  assert.equal(searchHistory(records, "common term", 3)[0].execution.id, "e-24");
});

// ---------------------------------------------------------------------------
// Backend integration: recording, partitions, cache-hit provenance, freshness
// ---------------------------------------------------------------------------

test("one fanout invocation writes one top-level record with partitions + merged output", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    await backend.search("strix halo inference", { limit: 10, rerankStrategy: "rrf" });

    const records = readRecords(historyPath);
    assert.equal(records.length, 1, "exactly one top-level execution for a fanout");
    const record = records[0];
    assert.equal(record.command, "search");
    assert.equal(record.input, "strix halo inference");
    assert.equal(record.source, "live");
    assert.equal(record.outcome, "success");
    assert.match(record.id, /^exec-/);
    assert.deepEqual(new Set(record.routing.providers_attempted), new Set(["brave", "serper"]));
    assert.equal(record.attempts.length, 2);
    assert.ok(record.attempts.every((a) => a.success && typeof a.duration_ms === "number"));
    assert.ok(record.attempts.every((a) => a.key_ref), "attempts carry a safe key reference");
    // Pre-merge partitions preserved alongside the merged output.
    assert.equal(record.partitions.brave.length, 1);
    assert.equal(record.partitions.serper.length, 1);
    assert.equal(record.result.length, 2);
    assert.equal(record.result_count, 2);
    // Normalized path does not preserve raw provider detail.
    assert.equal(record.raw_available, false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider failure inside partial fanout remains inspectable", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter, { failSerper: true }));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const result = await backend.search("partial fanout", { limit: 10, rerankStrategy: "rrf" });
    assert.ok(result.errors.serper, "live result still reports the serper error");

    const record = readRecords(historyPath)[0];
    assert.equal(record.outcome, "partial");
    assert.ok(record.errors.serper);
    const serperAttempt = record.attempts.find((a) => a.provider === "serper");
    assert.equal(serperAttempt.success, false);
    assert.ok(serperAttempt.error);
    // Successful provider partition still preserved.
    assert.equal(record.partitions.brave.length, 1);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fully failed execution is recorded as failed with provider attempts", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  const restore = installFetchMock({
    "*": async () => jsonResponse({ error: "down" }, { status: 500 }),
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    await assert.rejects(
      () => backend.search("total failure", { limit: 10, rerankStrategy: "rrf" }),
      /All providers failed/
    );

    const record = readRecords(historyPath)[0];
    assert.equal(record.outcome, "failed");
    assert.equal(record.source, "live");
    assert.equal(record.attempts.length, 2);
    assert.ok(record.attempts.every((a) => !a.success));
    assert.ok(record.errors.brave && record.errors.serper);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exact cache hit writes a new execution with origin linkage and zero provider calls", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };
    await backend.search("cache provenance query", opts);
    const callsAfterFirst = counter.calls;

    await backend.search("cache provenance query", opts);
    assert.equal(counter.calls, callsAfterFirst, "second call served from cache");

    const records = readRecords(historyPath);
    assert.equal(records.length, 2, "cache hit is its own execution record");
    const [live, replay] = records;
    assert.equal(replay.source, "cache");
    assert.equal(replay.attempts.length, 0, "replay records zero provider calls");
    assert.equal(replay.origin_execution_id, live.id, "replay links the origin execution");
    assert.ok(replay.cache, "replay carries cache provenance");
    assert.ok(typeof replay.cache.age_seconds === "number");
    assert.equal(replay.cache.ttl_seconds, 21600);
    assert.equal(replay.result_count, live.result_count);
    assert.equal(replay.outcome, "success");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("old cache entries without provenance replay as origin unknown", async () => {
  const { dir, cacheDir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };
    await backend.search("legacy entry query", opts);

    // Strip provenance from the stored entry (simulates a pre-PR2 entry).
    const searchDir = join(cacheDir, "search");
    const file = join(searchDir, readdirSync(searchDir)[0]);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    delete entry.origin_execution_id;
    writeFileSync(file, JSON.stringify(entry), "utf8");

    await backend.search("legacy entry query", opts);
    const replay = readRecords(historyPath)[1];
    assert.equal(replay.source, "cache");
    assert.equal(replay.origin_execution_id, null, "provenance unknown, not migrated");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing or expiring the replay cache does not remove execution history", async () => {
  const { dir, cacheDir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    await backend.search("durable history query", { limit: 10, rerankStrategy: "rrf" });

    const cache = new CacheStore({ path: cacheDir });
    const cleared = cache.clear();
    assert.ok(cleared.removed >= 1, "cache clear removed the entry");

    const records = readRecords(historyPath);
    assert.equal(records.length, 1, "history survives cache clear");
    assert.equal(records[0].input, "durable history query");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalized-path exact replay obeys --freshness", async () => {
  const { dir, cacheDir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };
    await backend.search("freshness query", opts);
    assert.equal(counter.calls, 2);

    // Age the stored entry to 2 hours old (still inside the 6h config TTL).
    const searchDir = join(cacheDir, "search");
    const file = join(searchDir, readdirSync(searchDir)[0]);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    entry.created_at = Date.now() - 2 * 3600 * 1000;
    writeFileSync(file, JSON.stringify(entry), "utf8");

    // No freshness flag: config TTL (6h) applies -> cache hit.
    await backend.search("freshness query", opts);
    assert.equal(counter.calls, 2, "entry within config TTL is a hit");

    // --freshness 1h wins for this invocation: 2h-old entry is stale -> live.
    await backend.search("freshness query", { ...opts, freshness: "1h" });
    assert.equal(counter.calls, 4, "--freshness 1h forces a live execution");

    const records = readRecords(historyPath);
    assert.equal(records[1].source, "cache");
    assert.equal(records[2].source, "live");
    assert.equal(records[2].options.freshness, "1h", "freshness override is recorded");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crawl executions are recorded but never served from exact replay", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock({
    "*": async ({ url }) => {
      counter.calls++;
      if (url.includes("api.exa.ai/search")) {
        return jsonResponse({ results: [{ url: "https://x.example/a" }] });
      }
      if (url.includes("api.exa.ai/contents")) {
        return jsonResponse({ results: [{ url: "https://x.example/a", title: "A", text: "a" }] });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    await backend.crawl("https://x.example", { limit: 1 });
    const callsAfterFirst = counter.calls;
    await backend.crawl("https://x.example", { limit: 1 });
    assert.ok(counter.calls > callsAfterFirst, "crawl never replays from cache");

    const records = readRecords(historyPath);
    assert.equal(records.length, 2);
    assert.ok(records.every((r) => r.command === "crawl" && r.source === "live"));
    assert.equal(records[0].result_count, 1);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending Firecrawl job and fallback pages are recorded separately", async () => {
  const dir = makeTempDir();
  const historyPath = join(dir, "history.jsonl");
  const usagePath = join(dir, "usage.jsonl");
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    `
[capabilities.crawl]
providers = ["firecrawl", "exa"]
strategy = "all"

[providers.firecrawl]
[providers.firecrawl.keyPool]
keys = ["firecrawl-test-key"]

[providers.exa]
[providers.exa.keyPool]
keys = ["exa-test-key"]

[history]
path = ${JSON.stringify(historyPath)}

[logging.usage]
path = ${JSON.stringify(usagePath)}
`,
    "utf8"
  );
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: "history-pending-job", url: "https://x.example" }),
    "GET https://api.firecrawl.dev/v2/crawl/history-pending-job": async () =>
      jsonResponse({ success: true, status: "scraping" }),
    "POST https://api.exa.ai/search": async () =>
      jsonResponse({ results: [{ url: "https://x.example/fallback", title: "Fallback" }] }),
    "POST https://api.exa.ai/contents": async () =>
      jsonResponse({ results: [{ url: "https://x.example/fallback", title: "Fallback", text: "page content" }] }),
  });

  try {
    const result = await new LocalExecutionBackend(configPath).crawl("https://x.example", { limit: 1 });
    assert.equal(result.status, "pending");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].url, "https://x.example/fallback");
    assert.deepEqual(result.pendingJobs, [
      { provider: "firecrawl", jobId: "history-pending-job", url: "https://x.example" },
    ]);

    const [record] = readRecords(historyPath);
    assert.equal(record.outcome, "pending");
    assert.equal(record.result.length, 1);
    assert.equal(record.result[0].url, "https://x.example/fallback");
    assert.equal(record.result_count, 1);
    assert.deepEqual(record.pending_jobs, result.pendingJobs);
    assert.equal(record.attempts[0].success, false);
    assert.equal(record.attempts[0].pending, true);
    assert.equal(record.attempts[1].success, true);

    const usage = readFileSync(usagePath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(usage.length, 2);
    assert.equal(usage[0].success, false);
    assert.equal(usage[0].pending, true);
    assert.equal(usage[1].success, true);
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signed caller URLs are redacted from persisted inputs AND echoed results", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  const signedUrl = "https://example.com/private?token=supersecrettoken123&sig=abc123&keep=1";
  const restore = installFetchMock({
    "*": async ({ url }) => {
      if (url.includes("r.jina.ai")) {
        return textResponse("Title: T\n\nBody");
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    await backend.extract(signedUrl, { limit: 1 });

    const rawHistory = readFileSync(historyPath, "utf8");
    assert.equal(rawHistory.includes("supersecrettoken123"), false, "token never persisted");
    assert.equal(rawHistory.includes("sig=abc123"), false, "signature never persisted");
    assert.ok(rawHistory.includes("token=[REDACTED]"), "input token redacted");
    assert.ok(rawHistory.includes("keep=1"), "non-sensitive params preserved");

    const record = readRecords(historyPath)[0];
    assert.ok(record.input.includes("[REDACTED]"), "original input redacted");
    // The adapter echoes the caller URL into the normalized result — the
    // redaction covers the result side too.
    assert.ok(record.result.url.includes("token=[REDACTED]"), "echoed result URL redacted");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed history write surfaces a visible non-secret warning; the result stays accurate", async () => {
  const dir = makeTempDir();
  // History path whose parent is an existing FILE: mkdir/append must fail.
  const blockerFile = join(dir, "blocker");
  writeFileSync(blockerFile, "not a directory", "utf8");

  const cacheDir = join(dir, "cache");
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    `
[capabilities.search]
providers = ["brave", "serper"]
strategy = "all"

[capabilities.extract]
providers = ["jina"]
strategy = "all"

[capabilities.crawl]
providers = ["exa"]
strategy = "all"

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]

[providers.serper]
[providers.serper.keyPool]
keys = ["k"]

[providers.jina]
[providers.jina.keyPool]
keys = []

[providers.exa]
[providers.exa.keyPool]
keys = ["k"]

[cache]
enabled = false

[history]
path = ${JSON.stringify(join(blockerFile, "history.jsonl"))}
`,
    "utf8"
  );

  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const result = await backend.search("unrecorded execution", { limit: 10, rerankStrategy: "rrf" });

    assert.equal(result.results.length, 2, "command result stays accurate");
    assert.ok(result.warnings?.length >= 1, "warning surfaced");
    assert.match(result.warnings[0], /not recorded in history/);
    // The warning is non-secret.
    assert.equal(JSON.stringify(result.warnings).includes('"k"'), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence never contains raw secret values from provider errors", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  // Literal pool key long enough to be scrubbed as a substring.
  const secretKey = "literal-key-ABCDEFGHIJ";
  const toml = readFileSync(configPath, "utf8").replaceAll('"k"', JSON.stringify(secretKey));
  writeFileSync(configPath, toml, "utf8");

  const restore = installFetchMock({
    "*": async () =>
      jsonResponse({ message: `request denied for key ${secretKey}` }, { status: 403 }),
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    await assert.rejects(() =>
      backend.search("secret echo", { limit: 10, rerankStrategy: "rrf" })
    );

    const rawHistory = existsSync(historyPath) ? readFileSync(historyPath, "utf8") : "";
    assert.ok(rawHistory.length > 0, "failed execution was recorded");
    assert.equal(rawHistory.includes(secretKey), false, "credential never persisted verbatim");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactSensitive redacts standalone token/key fields without mangling ordinary fields", () => {
  const scrubbed = redactSensitive(
    {
      query: "x",
      token: "caller-token-value-123",
      key: "caller-key-123",
      monkey: "stays",
      tokenizer: "stays",
    },
    []
  );
  assert.equal(scrubbed.token, REDACTED);
  assert.equal(scrubbed.key, REDACTED);
  assert.equal(scrubbed.monkey, "stays");
  assert.equal(scrubbed.tokenizer, "stays");
  assert.equal(scrubbed.query, "x");
});

test("provider attempt error strings are redacted before persistence", async () => {
  // Firecrawl embeds the provider-supplied error body in the thrown message
  // (src/adapters/firecrawl.ts), so a credential echoed there must not reach
  // the durable attempts[].error field.
  const dir = makeTempDir();
  const historyPath = join(dir, "history.jsonl");
  const cacheDir = join(dir, "cache");
  const configPath = join(dir, "config.toml");
  const secretKey = "fc-literal-key-ABCDEFGHIJ";
  writeFileSync(
    configPath,
    `
[capabilities.extract]
providers = ["firecrawl"]
strategy = "all"

[providers.firecrawl]
[providers.firecrawl.keyPool]
keys = [${JSON.stringify(secretKey)}]

[cache]
enabled = true
search_ttl = "6h"
extract_ttl = "24h"
path = ${JSON.stringify(cacheDir)}

[history]
path = ${JSON.stringify(historyPath)}
`,
    "utf8"
  );

  const restore = installFetchMock({
    "*": async () => jsonResponse({ success: false, error: `invalid api key ${secretKey}` }),
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    await assert.rejects(() => backend.extract("https://example.com", {}));

    const rawHistory = existsSync(historyPath) ? readFileSync(historyPath, "utf8") : "";
    assert.ok(rawHistory.length > 0, "failed execution was recorded");
    assert.equal(
      rawHistory.includes(secretKey),
      false,
      "attempt error never persists the credential"
    );
    const record = readRecords(historyPath)[0];
    assert.equal(record.outcome, "failed");
    assert.ok(record.attempts[0].error.includes(REDACTED));
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--freshness does not persist into the stored cache entry", async () => {
  const { dir, cacheDir, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };
    await backend.search("ttl persistence", { ...opts, freshness: "1h" });

    const searchDir = join(cacheDir, "search");
    const file = join(searchDir, readdirSync(searchDir)[0]);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(stored.ttl_seconds, 21600, "entry keeps the config TTL, not the override");

    // Age the entry to 2h: a default read must still treat it as fresh (6h
    // config TTL) — the earlier 1h override must not have shortened it.
    stored.created_at = Date.now() - 2 * 3600 * 1000;
    writeFileSync(file, JSON.stringify(stored), "utf8");
    await backend.search("ttl persistence", opts);
    assert.equal(counter.calls, 2, "override did not shorten the entry for later reads");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed cache payload is a miss, not a crash", async () => {
  const { dir, cacheDir, configPath } = writeTempConfig();
  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };
    const key = cacheKey("search", "malformed payload", { limit: 10, rerankStrategy: "rrf" });
    const searchDir = join(cacheDir, "search");
    mkdirSync(searchDir, { recursive: true });
    writeFileSync(
      join(searchDir, `${key}.json`),
      JSON.stringify({
        key,
        payload: { bogus: true },
        created_at: Date.now(),
        ttl_seconds: 21600,
      })
    );

    const result = await backend.search("malformed payload", opts);
    assert.equal(counter.calls, 2, "malformed entry falls back to live providers");
    assert.equal(result.results.length, 2);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests: PR 54 bot review findings
// ---------------------------------------------------------------------------

test("redactSensitive replaces non-string sensitive values wholesale (review #6)", () => {
  const scrubbed = redactSensitive(
    {
      authorization: ["Bearer customer-secret"],
      api_key: ["x", "y"],
      key: { nested: "value" },
      passphrase: 12345,
      safe: { token: "nested-token-xyz", note: "kept" },
    },
    []
  );
  // A matching field NAME is credential material on its own: the entire value
  // is replaced regardless of type — an array/object/number container must
  // never smuggle a secret into history.
  assert.equal(scrubbed.authorization, REDACTED);
  assert.equal(scrubbed.api_key, REDACTED);
  assert.equal(scrubbed.key, REDACTED);
  assert.equal(scrubbed.passphrase, REDACTED);
  // Non-sensitive fields still recurse normally.
  assert.equal(scrubbed.safe.token, REDACTED);
  assert.equal(scrubbed.safe.note, "kept");
  // Nothing survived the array value.
  assert.equal(JSON.stringify(scrubbed).includes("customer-secret"), false);
});

test("a non-Error provider failure is recorded with a usable error string (review #2)", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();
  try {
    const backend = new LocalExecutionBackend(configPath);
    // Simulate a provider leg throwing a raw non-Error value (a string) so the
    // search catch records it via failedRecord.
    backend.engine.search = async () => {
      throw "boom-non-error";
    };

    let caught;
    try {
      await backend.search("non-error throw", { limit: 10, rerankStrategy: "rrf" });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, "boom-non-error", "the original value is rethrown");

    const record = readRecords(historyPath)[0];
    assert.equal(record.outcome, "failed");
    assert.equal(record.errors.error, "boom-non-error", "coerced via String(), not undefined");
    assert.ok(!JSON.stringify(record).includes("undefined"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an existing but unreadable history file throws instead of reporting empty (review #11)", () => {
  const dir = makeTempDir();
  try {
    // A DIRECTORY where the history file should be: existsSync passes but
    // readFileSync cannot read it.
    const dirPath = join(dir, "history.jsonl");
    mkdirSync(dirPath);
    const store = new HistoryStore({ path: dirPath });
    assert.throws(() => store.list(), /Cannot read history file/);
    assert.throws(() => store.clear(), /Cannot read history file/);

    // A genuinely missing file is still an empty list.
    const missing = new HistoryStore({ path: join(dir, "absent.jsonl") });
    assert.deepEqual(missing.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list skips parseable lines that lack the minimal record shape (review #12)", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "history.jsonl");
    const store = new HistoryStore({ path });
    const base = {
      timestamp: new Date().toISOString(),
      command: "search",
      input: "q",
      source: "live",
      attempts: [],
      raw_available: false,
      duration_ms: 1,
      outcome: "success",
    };
    store.append({ ...base, id: "exec-ok" });
    // Parseable JSON that is not a usable ExecutionRecord: id+timestamp only,
    // and id+timestamp+command with no attempts. Both must be skipped like
    // corrupt lines, never surfaced to consumers that would crash on them.
    writeFileSync(
      path,
      JSON.stringify({ id: "exec-min", timestamp: "2026-08-10T00:00:00.000Z" }) + "\n",
      { flag: "a" }
    );
    writeFileSync(
      path,
      JSON.stringify({
        id: "exec-noattempts",
        timestamp: "2026-08-10T00:00:00.000Z",
        command: "search",
        input: "q",
        source: "live",
        outcome: "success",
      }) + "\n",
      { flag: "a" }
    );

    const records = store.list();
    assert.deepEqual(
      records.map((r) => r.id),
      ["exec-ok"]
    );
    assert.deepEqual(store.recent(10).map((r) => r.id), ["exec-ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Make a directory unlistable for the cache-clear regression test.
 * Windows needs an ACL deny (readdirSync throws EPERM, statSync still works);
 * POSIX needs a chmod drop (readdirSync throws EACCES).
 */
function denyDirectoryListing(dir) {
  if (process.platform === "win32") {
    const who = spawnSync("whoami", { encoding: "utf8" }).stdout.trim();
    const res = spawnSync("icacls", [dir, "/deny", `${who}:(OI)(CI)RD`], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`icacls deny failed: ${res.stderr || res.stdout}`);
    }
  } else {
    chmodSync(dir, 0o000);
  }
}

function restoreDirectoryListing(dir) {
  if (process.platform === "win32") {
    const who = spawnSync("whoami", { encoding: "utf8" }).stdout.trim();
    const res = spawnSync("icacls", [dir, "/remove:d", who], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`icacls restore failed: ${res.stderr || res.stdout}`);
    }
  } else {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Best-effort restore.
    }
  }
}

test("cache clear survives an unreadable capability directory and reports it (review #8)", (t) => {
  const dir = makeTempDir();
  try {
    const cacheDir = join(dir, "cache");
    mkdirSync(join(cacheDir, "search"), { recursive: true });
    mkdirSync(join(cacheDir, "locked"), { recursive: true });
    writeFileSync(join(cacheDir, "search", "a.json"), "{}");
    writeFileSync(join(cacheDir, "locked", "b.json"), "{}");

    const lockedDir = join(cacheDir, "locked");
    try {
      denyDirectoryListing(lockedDir);
    } catch (error) {
      t.skip(`cannot make a directory unreadable on this platform: ${error.message}`);
      return;
    }

    try {
      const result = new CacheStore({ path: cacheDir }).clear();
      assert.equal(result.removed, 1, "the readable capability directory is still cleared");
      assert.equal(result.errors.length, 1, "the unreadable directory is reported, not fatal");
      assert.match(result.errors[0], /could not enumerate locked/);
      assert.equal(
        readdirSync(join(cacheDir, "search")).length,
        0,
        "remaining directories are processed after the failure"
      );
    } finally {
      restoreDirectoryListing(lockedDir);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed history write surfaces on stderr when every provider also fails (review #5)", async () => {
  const dir = makeTempDir();
  // History path whose parent is an existing FILE: mkdir/append must fail.
  const blockerFile = join(dir, "blocker");
  writeFileSync(blockerFile, "not a directory", "utf8");

  const cacheDir = join(dir, "cache");
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    `
[capabilities.search]
providers = ["brave", "serper"]
strategy = "all"

[capabilities.extract]
providers = ["jina"]
strategy = "all"

[capabilities.crawl]
providers = ["exa"]
strategy = "all"

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]

[providers.serper]
[providers.serper.keyPool]
keys = ["k"]

[providers.jina]
[providers.jina.keyPool]
keys = []

[providers.exa]
[providers.exa.keyPool]
keys = ["k"]

[cache]
enabled = false

[history]
path = ${JSON.stringify(join(blockerFile, "history.jsonl"))}
`,
    "utf8"
  );

  const restore = installFetchMock({
    "*": async () => jsonResponse({ error: "down" }, { status: 500 }),
  });

  const stderrLines = [];
  const originalError = console.error;
  console.error = (msg) => stderrLines.push(String(msg));

  try {
    const backend = new LocalExecutionBackend(configPath);
    await assert.rejects(
      () => backend.search("unrecorded failed execution", { limit: 10, rerankStrategy: "rrf" }),
      /All providers failed/
    );
  } finally {
    console.error = originalError;
    restore();
    rmSync(dir, { recursive: true, force: true });
  }

  // The audit-loss warning pushed inside recordExecution must not be discarded
  // by the rethrow: it has to be observable on stderr.
  assert.ok(
    stderrLines.some((line) => line.includes("not recorded in history")),
    "audit-loss warning is flushed to stderr before rethrowing"
  );
  assert.ok(
    stderrLines.some((line) => /^Warning: Execution exec-/.test(line)),
    "the warning names the execution"
  );
  assert.equal(
    JSON.stringify(stderrLines).includes('"k"'),
    false,
    "flushed warnings are non-secret"
  );
});

test("resolved credentials never appear on the serialized thrown error", async () => {
  const { dir, configPath } = writeTempConfig();
  const secretKey = "literal-key-ABCDEFGHIJ";
  const toml = readFileSync(configPath, "utf8").replaceAll('"k"', JSON.stringify(secretKey));
  writeFileSync(configPath, toml, "utf8");

  const restore = installFetchMock({
    "*": async () => jsonResponse({ error: "down" }, { status: 500 }),
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    const error = await backend
      .search("serialized error", { limit: 10, rerankStrategy: "rrf" })
      .then(() => null, (e) => e);
    assert.ok(error, "execution failed");
    assert.equal(
      JSON.stringify(error).includes(secretKey),
      false,
      "secretsUsed stays off the serialized error surface"
    );
    // But the redaction context is still available in memory for history.
    assert.ok(Array.isArray(error.secretsUsed));
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a longer --freshness window is honored for the invocation", async () => {
  const { dir, cacheDir, configPath } = writeTempConfig();
  // Tighten the config TTL to 1h so the override can be longer than config.
  const toml = readFileSync(configPath, "utf8").replace('search_ttl = "6h"', 'search_ttl = "1h"');
  writeFileSync(configPath, toml, "utf8");

  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };
    await backend.search("wide freshness", opts);
    assert.equal(counter.calls, 2);

    // Age the stored entry to 2h — beyond the 1h config TTL, inside 6h.
    const searchDir = join(cacheDir, "search");
    const file = join(searchDir, readdirSync(searchDir)[0]);
    const entry = JSON.parse(readFileSync(file, "utf8"));
    entry.created_at = Date.now() - 2 * 3600 * 1000;
    writeFileSync(file, JSON.stringify(entry), "utf8");

    // --freshness 6h wins for this invocation: the 2h-old entry replays.
    await backend.search("wide freshness", { ...opts, freshness: "6h" });
    assert.equal(counter.calls, 2, "longer --freshness honors the widened window");

    // A default invocation still applies the 1h config TTL: entry is stale.
    await backend.search("wide freshness", opts);
    assert.equal(counter.calls, 4, "default read still enforces the config TTL");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capability-validation failures are recorded as failed executions", async () => {
  const { dir, historyPath, configPath } = writeTempConfig();

  try {
    const backend = new LocalExecutionBackend(configPath);
    await assert.rejects(() =>
      backend.search("bad provider", { providers: ["nosuchprovider"] })
    );

    const record = readRecords(historyPath)[0];
    assert.ok(record, "validation failure was recorded");
    assert.equal(record.outcome, "failed");
    assert.equal(record.command, "search");
    assert.deepEqual(record.attempts, [], "no provider was attempted");
    assert.ok(record.errors?.error, "the validation error is inspectable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

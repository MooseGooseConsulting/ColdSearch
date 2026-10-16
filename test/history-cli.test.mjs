import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeDir(tag = "coldsearch-history-cli-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function runCli(args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

/**
 * Fixture history records exercising live fanout, cache replay, extract
 * content, failed, and raw-preserving tool shapes — the full spread of what
 * `history recent` must list and `history show` must reconstruct.
 */
const SEED = [
  {
    id: "exec-1",
    timestamp: "2026-08-10T12:00:00.000Z",
    command: "search",
    run_id: "run_seed_123",
    input: "strix halo inference benchmarks",
    options: { limit: 10, rerankStrategy: "rrf" },
    routing: {
      strategy: "all",
      providers_attempted: ["brave", "serper"],
      reranker: "rrf",
    },
    source: "live",
    attempts: [
      { provider: "brave", success: true, duration_ms: 120, key_ref: "env:BRAVE_API_KEY", result_count: 1 },
      { provider: "serper", success: true, duration_ms: 90, key_ref: "env:SERPER_API_KEY", result_count: 1 },
    ],
    partitions: {
      brave: [{ title: "B", url: "https://b.example", snippet: "bb" }],
      serper: [{ title: "S", url: "https://s.example", snippet: "ss" }],
    },
    result: [
      { title: "B", url: "https://b.example", snippet: "bb" },
      { title: "S", url: "https://s.example", snippet: "ss" },
    ],
    result_count: 2,
    raw_available: false,
    duration_ms: 210,
    outcome: "success",
  },
  {
    id: "exec-2",
    timestamp: "2026-08-10T13:00:00.000Z",
    command: "search",
    input: "strix halo inference benchmarks",
    routing: { strategy: "all", providers_attempted: [], reranker: "rrf" },
    source: "cache",
    origin_execution_id: "exec-1",
    cache: {
      created_at: "2026-08-10T12:00:00.000Z",
      age_seconds: 3600,
      ttl_seconds: 21600,
    },
    attempts: [],
    result: [
      { title: "B", url: "https://b.example", snippet: "bb" },
      { title: "S", url: "https://s.example", snippet: "ss" },
    ],
    result_count: 2,
    raw_available: false,
    duration_ms: 0,
    outcome: "success",
  },
  {
    id: "exec-3",
    timestamp: "2026-08-10T14:00:00.000Z",
    command: "extract",
    input: "https://example.com/article",
    options: { limit: 1 },
    routing: { strategy: "all", providers_attempted: ["jina"] },
    source: "live",
    attempts: [{ provider: "jina", success: true, duration_ms: 800, key_ref: "env:JINA_API_KEY", result_count: 1 }],
    result: {
      title: "t",
      url: "https://example.com/article",
      content: "deep dive on strix halo thermals",
    },
    result_count: 1,
    raw_available: false,
    duration_ms: 810,
    outcome: "success",
  },
  {
    id: "exec-4",
    timestamp: "2026-08-10T15:00:00.000Z",
    command: "search",
    input: "failed query",
    routing: { strategy: "all", providers_attempted: ["brave", "serper"], reranker: "rrf" },
    source: "live",
    attempts: [
      { provider: "brave", success: false, error: "boom", duration_ms: 50 },
      { provider: "serper", success: false, error: "kaboom", duration_ms: 60 },
    ],
    errors: { brave: "boom", serper: "kaboom" },
    raw_available: false,
    duration_ms: 120,
    outcome: "failed",
  },
  {
    id: "exec-5",
    timestamp: "2026-08-10T16:00:00.000Z",
    command: "tool",
    input: "exa.search",
    routing: { providers_attempted: ["exa"] },
    source: "live",
    attempts: [{ provider: "exa", tool: "search", success: true, duration_ms: 300, key_ref: "env:EXA_API_KEY", result_count: 1 }],
    result: { results_count: 1, top_links: ["https://x.example"] },
    raw: { results: [{ url: "https://x.example" }] },
    raw_available: true,
    duration_ms: 310,
    outcome: "success",
  },
  {
    id: "exec-6",
    timestamp: "2026-08-10T17:00:00.000Z",
    command: "crawl",
    input: "https://example.com",
    routing: { strategy: "all", providers_attempted: ["firecrawl", "exa"] },
    source: "live",
    attempts: [
      { provider: "firecrawl", success: false, pending: true, result_count: 0 },
      { provider: "exa", success: true, result_count: 1 },
    ],
    result: [{ url: "https://example.com/fallback", title: "Fallback", content: "page" }],
    result_count: 1,
    pending_jobs: [
      { provider: "firecrawl", jobId: "firecrawl-job-1", url: "https://example.com" },
    ],
    raw_available: false,
    duration_ms: 450,
    outcome: "pending",
  },
];

function seedHistory(historyPath) {
  fs.writeFileSync(historyPath, SEED.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function readHistoryLines(historyPath) {
  return fs
    .readFileSync(historyPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
}

function writeConfig(dir, cacheBlock = "[cache]\nenabled = false\n") {
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []
[providers.searxng.options]
baseUrl = "http://127.0.0.1:1"

${cacheBlock}
[history]
path = ${JSON.stringify(path.join(dir, "history.jsonl"))}
`.trim() + "\n",
    "utf8"
  );
  return configPath;
}

test("history recent lists newest first including live, cache, and failed records", () => {
  const dir = makeDir();
  try {
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(dir);

    const result = runCli(["history", "recent", "--config", configPath, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.command, "history recent");
    assert.equal(out.total, SEED.length);
    assert.equal(out.executions[0].id, "exec-6", "newest execution first");
    assert.equal(out.executions[0].pending_jobs[0].jobId, "firecrawl-job-1");
    assert.equal(out.executions[out.executions.length - 1].id, "exec-1");
    assert.equal(out.executions[out.executions.length - 1].run_id, "run_seed_123");

    const human = runCli(["history", "recent", "--config", configPath]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /pending_jobs=firecrawl:firecrawl-job-1/);

    const sources = new Set(out.executions.map((e) => e.source));
    assert.ok(sources.has("live") && sources.has("cache"), "live and cache records listed");
    const outcomes = new Set(out.executions.map((e) => e.outcome));
    assert.ok(outcomes.has("failed"), "failed executions listed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history recent honors --limit", () => {
  const dir = makeDir();
  try {
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(dir);

    const result = runCli(["history", "recent", "--config", configPath, "--json", "--limit", "2"]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.executions.length, 2);
    assert.deepEqual(
      out.executions.map((e) => e.id),
      ["exec-6", "exec-5"]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history search matches locally and makes zero provider/network calls", async () => {
  const dir = makeDir();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    seedHistory(path.join(dir, "history.jsonl"));
    // Providers point at the counting server: if history search dispatched any
    // provider call, requests would be non-zero.
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []
[providers.searxng.options]
baseUrl = "http://127.0.0.1:${server.address().port}"

[cache]
enabled = false

[history]
path = ${JSON.stringify(path.join(dir, "history.jsonl"))}
`.trim() + "\n",
      "utf8"
    );

    // Query positional follows the flags, exactly as the plan's validation
    // commands invoke it (`history search --config <c> --json "<query>"`).
    const result = runCli(["history", "search", "--config", configPath, "--json", "strix halo"]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.command, "history search");
    assert.ok(out.total >= 1, "matching executions found locally");
    assert.ok(Array.isArray(out.matches[0].matched_on) && out.matches[0].matched_on.length >= 1);
    assert.ok(
      out.matches.some((m) => m.matched_on.includes("content")),
      "extracted content is searchable"
    );

    const runIdResult = runCli([
      "history", "search", "--config", configPath, "--json", "run_seed_123",
    ]);
    assert.equal(runIdResult.status, 0, runIdResult.stderr);
    const runIdMatches = JSON.parse(runIdResult.stdout).matches;
    assert.ok(runIdMatches.some((match) =>
      match.execution.run_id === "run_seed_123" && match.matched_on.includes("run_id")
    ));
    assert.equal(requests, 0, "history search must never call a provider");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history show reconstructs request, routing, provenance, attempts, output, and errors", () => {
  const dir = makeDir();
  try {
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(dir);

    // Live fanout record.
    const live = JSON.parse(
      runCli(["history", "show", "exec-1", "--config", configPath, "--json"]).stdout
    );
    assert.equal(live.command, "search");
    assert.equal(live.input, "strix halo inference benchmarks");
    assert.equal(live.source, "live");
    assert.equal(live.outcome, "success");
    assert.deepEqual(live.routing.providers_attempted, ["brave", "serper"]);
    assert.equal(live.attempts.length, 2);
    assert.ok(live.attempts.every((a) => a.key_ref), "attempts carry safe key references");
    assert.equal(live.result.length, 2);

    const pending = JSON.parse(
      runCli(["history", "show", "exec-6", "--config", configPath, "--json"]).stdout
    );
    assert.equal(pending.outcome, "pending");
    assert.equal(pending.result_count, 1);
    assert.equal(pending.pending_jobs[0].jobId, "firecrawl-job-1");

    const pendingHuman = runCli(["history", "show", "exec-6", "--config", configPath]);
    assert.equal(pendingHuman.status, 0, pendingHuman.stderr);
    assert.match(pendingHuman.stdout, /Pending:\s+firecrawl job firecrawl-job-1 \(https:\/\/example\.com\)/);

    // Cache replay record: provenance + zero provider calls.
    const replay = JSON.parse(
      runCli(["history", "show", "exec-2", "--config", configPath, "--json"]).stdout
    );
    assert.equal(replay.source, "cache");
    assert.equal(replay.origin_execution_id, "exec-1");
    assert.equal(replay.attempts.length, 0);
    assert.equal(replay.cache.age_seconds, 3600);
    assert.equal(replay.cache.ttl_seconds, 21600);

    // Failed record: errors are preserved and inspectable.
    const failed = JSON.parse(
      runCli(["history", "show", "exec-4", "--config", configPath, "--json"]).stdout
    );
    assert.equal(failed.outcome, "failed");
    assert.deepEqual(failed.errors, { brave: "boom", serper: "kaboom" });
    assert.ok(failed.attempts.every((a) => !a.success));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history show --by-provider exposes stored partitions and merged output without provider calls", async () => {
  const dir = makeDir();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []
[providers.searxng.options]
baseUrl = "http://127.0.0.1:${server.address().port}"

[cache]
enabled = false

[history]
path = ${JSON.stringify(path.join(dir, "history.jsonl"))}
`.trim() + "\n",
      "utf8"
    );

    const result = runCli([
      "history", "show", "exec-1", "--config", configPath, "--json", "--by-provider",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.command, "history show --by-provider");
    assert.deepEqual(
      new Set(out.providers.map((p) => p.provider)),
      new Set(["brave", "serper"]),
      "stored pre-merge partitions exposed per provider"
    );
    const brave = out.providers.find((p) => p.provider === "brave");
    assert.equal(brave.result_count, 1);
    assert.equal(brave.results[0].url, "https://b.example");
    assert.ok(Array.isArray(out.merged), "merged output included");
    assert.equal(out.merged.length, 2);
    assert.equal(typeof out.url_overlap.shared_urls, "number");
    assert.equal(requests, 0, "--by-provider must not call providers");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history show exposes preserved raw detail and marks unavailable where not captured", () => {
  const dir = makeDir();
  try {
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(dir);

    // Tool execution preserved raw provider detail.
    const tool = JSON.parse(
      runCli(["history", "show", "exec-5", "--config", configPath, "--json"]).stdout
    );
    assert.equal(tool.raw_available, true);
    assert.ok(tool.raw && typeof tool.raw === "object", "raw detail persisted where preserved");

    // Normalized path did not capture raw detail — reported as unavailable.
    const search = JSON.parse(
      runCli(["history", "show", "exec-1", "--config", configPath, "--json"]).stdout
    );
    assert.equal(search.raw_available, false);

    // Human view states it explicitly.
    const human = runCli(["history", "show", "exec-1", "--config", configPath]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Raw detail: unavailable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history clear requires --all and deletes history while keeping replay cache", () => {
  const dir = makeDir();
  try {
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(path.join(cacheDir, "search"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "search", "k.json"),
      JSON.stringify({
        key: "k",
        payload: { results: [], providersUsed: ["brave"], errors: {} },
        created_at: Date.now(),
        ttl_seconds: 21600,
      }),
      "utf8"
    );
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(
      dir,
      `[cache]\nenabled = true\npath = ${JSON.stringify(cacheDir)}\n`
    );

    // Destructive operation requires --all.
    const denied = runCli(["history", "clear", "--config", configPath, "--json"]);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /--all/);
    assert.equal(readHistoryLines(path.join(dir, "history.jsonl")).length, SEED.length);

    const ok = runCli(["history", "clear", "--config", configPath, "--json", "--all"]);
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.command, "history clear");
    assert.equal(out.removed, SEED.length);
    assert.equal(fs.existsSync(path.join(dir, "history.jsonl")), false, "history file removed");
    assert.equal(
      fs.readdirSync(path.join(cacheDir, "search")).length,
      1,
      "replay-cache material left untouched"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cache stats describes replay-cache state; cache clear removes entries and preserves history", () => {
  const dir = makeDir();
  try {
    const cacheDir = path.join(dir, "cache");
    fs.mkdirSync(path.join(cacheDir, "search"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "search", "k.json"),
      JSON.stringify({
        key: "k",
        payload: { results: [], providersUsed: ["brave"], errors: {} },
        created_at: Date.now() - 1000,
        ttl_seconds: 21600,
      }),
      "utf8"
    );
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(
      dir,
      `[cache]\nenabled = true\npath = ${JSON.stringify(cacheDir)}\n`
    );

    const stats = runCli(["cache", "stats", "--config", configPath, "--json"]);
    assert.equal(stats.status, 0, stats.stderr);
    const statsOut = JSON.parse(stats.stdout);
    assert.equal(statsOut.command, "cache stats");
    assert.equal(statsOut.total_entries, 1);
    assert.equal(statsOut.capabilities.search.entries, 1);
    assert.equal(typeof statsOut.total_bytes, "number");
    assert.equal(statsOut.path, cacheDir);

    const cleared = runCli(["cache", "clear", "--config", configPath, "--json"]);
    assert.equal(cleared.status, 0, cleared.stderr);
    const clearOut = JSON.parse(cleared.stdout);
    assert.equal(clearOut.command, "cache clear");
    assert.equal(clearOut.removed, 1);
    assert.equal(fs.readdirSync(path.join(cacheDir, "search")).length, 0);

    // History survives cache clear untouched.
    assert.equal(readHistoryLines(path.join(dir, "history.jsonl")).length, SEED.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests: PR 54 bot review findings
// ---------------------------------------------------------------------------

test("--all is rejected for history subcommands other than clear (review #1)", () => {
  const dir = makeDir();
  try {
    seedHistory(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(dir);

    for (const args of [
      ["history", "recent", "--config", configPath, "--all"],
      ["history", "search", "--config", configPath, "--all", "strix"],
      ["history", "show", "--config", configPath, "--all", "exec-1"],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, `${args.join(" ")} must be rejected`);
      assert.match(result.stderr, /--all is only valid with 'history clear'/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crawl --freshness warns that exact crawl replay is disabled (review #3)", () => {
  const dir = makeDir();
  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `
[capabilities.crawl]
providers = ["exa"]
strategy = "all"

[providers.exa]
[providers.exa.keyPool]
keys = ["k"]

[history]
path = ${JSON.stringify(path.join(dir, "history.jsonl"))}
`.trim() + "\n",
      "utf8"
    );

    // Dry-run keeps the test hermetic: the warning fires before the plan is
    // printed, and no network call is made.
    const result = runCli([
      "crawl",
      "--config",
      configPath,
      "--freshness",
      "1h",
      "--dry-run",
      "--json",
      "https://example.com",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /--freshness ignored for crawl/);
    const out = JSON.parse(result.stdout);
    assert.equal(out.capability, "crawl");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history show (human) renders the final result (review #10)", () => {
  const dir = makeDir();
  try {
    seedHistory(path.join(dir, "history.jsonl"));
    // Add a record with more than 10 array results to exercise the bound.
    fs.appendFileSync(
      path.join(dir, "history.jsonl"),
      JSON.stringify({
        id: "exec-many",
        timestamp: "2026-08-10T17:00:00.000Z",
        command: "search",
        input: "bounded",
        routing: { providers_attempted: ["brave"] },
        source: "live",
        attempts: [{ provider: "brave", success: true }],
        result: Array.from({ length: 12 }, (_, i) => ({
          title: `T${i}`,
          url: `https://n.example/${i}`,
        })),
        result_count: 12,
        raw_available: false,
        duration_ms: 10,
        outcome: "success",
      }) + "\n",
      "utf8"
    );
    const configPath = writeConfig(dir);

    // Array result: index/title/url.
    const array = runCli(["history", "show", "exec-1", "--config", configPath]);
    assert.equal(array.status, 0, array.stderr);
    assert.match(array.stdout, /Result\[0\]: B\s+https:\/\/b\.example/);
    assert.match(array.stdout, /Result\[1\]: S\s+https:\/\/s\.example/);

    // Non-array result: bounded pretty-print.
    const object = runCli(["history", "show", "exec-3", "--config", configPath]);
    assert.equal(object.status, 0, object.stderr);
    assert.match(object.stdout, /Result:\s*\n\s*\{\s*\n\s*"title"/);
    assert.match(object.stdout, /"content": "deep dive on strix halo thermals"/);

    // Absent result: stated explicitly.
    const absent = runCli(["history", "show", "exec-4", "--config", configPath]);
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /Result:\s+\(no result recorded\)/);

    // Bounded: first 10 shown, "+N more" for the rest.
    const bounded = runCli(["history", "show", "exec-many", "--config", configPath]);
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.match(bounded.stdout, /Result\[9\]: T9\s+https:\/\/n\.example\/9/);
    assert.match(bounded.stdout, /\+2 more results/);
    assert.doesNotMatch(bounded.stdout, /Result\[10\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("history commands fail loudly when the history file exists but cannot be read (review #11)", () => {
  const dir = makeDir();
  try {
    // A DIRECTORY where the history file should be: it "exists" but cannot be
    // read, so commands must error instead of reporting zero executions.
    fs.mkdirSync(path.join(dir, "history.jsonl"));
    const configPath = writeConfig(dir);

    const recent = runCli(["history", "recent", "--config", configPath]);
    assert.equal(recent.status, 1);
    assert.match(recent.stderr, /Cannot read history file/);

    const cleared = runCli(["history", "clear", "--config", configPath, "--json", "--all"]);
    assert.equal(cleared.status, 1);
    assert.match(cleared.stderr, /Cannot read history file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pre-dispatch tool-call failures still record one failed history entry
// ---------------------------------------------------------------------------

test("tool call pre-dispatch failure records history (malformed tool ID)", () => {
  const dir = makeDir();
  try {
    const configPath = writeConfig(dir);

    const result = runCli([
      "tool", "call", "exa.search.extra", "--config", configPath, "--json",
    ]);
    assert.equal(result.status, 1, result.stderr);

    const lines = readHistoryLines(path.join(dir, "history.jsonl"));
    assert.equal(lines.length, 1, "exactly one history record for the invocation");
    const record = JSON.parse(lines[0]);
    assert.equal(record.outcome, "failed");
    assert.equal(record.command, "tool");
    assert.deepEqual(record.attempts, [], "no provider attempt happened pre-dispatch");
    assert.equal(record.source, "live");
    assert.equal(record.duration_ms, 0);
    assert.deepEqual(record.routing.providers_attempted, []);
    assert.equal(record.input, "exa.search.extra");
    assert.match(record.errors["exa.search.extra"], /^Invalid tool ID:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tool call pre-dispatch failure records history (missing input file)", () => {
  const dir = makeDir();
  try {
    const configPath = writeConfig(dir);
    const missing = path.join(dir, "does-not-exist.json");

    const result = runCli([
      "tool", "call", "exa.search", "--json-input", missing, "--config", configPath, "--json",
    ]);
    assert.equal(result.status, 1, result.stderr);

    const lines = readHistoryLines(path.join(dir, "history.jsonl"));
    assert.equal(lines.length, 1, "exactly one history record for the invocation");
    const record = JSON.parse(lines[0]);
    assert.equal(record.outcome, "failed");
    assert.equal(record.command, "tool");
    assert.deepEqual(record.attempts, [], "no provider attempt happened pre-dispatch");
    assert.equal(record.source, "live");
    assert.equal(record.duration_ms, 0);
    assert.deepEqual(record.routing.providers_attempted, []);
    assert.equal(record.input, "exa.search");
    assert.match(record.errors["exa.search"], /^JSON input file not found:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tool call pre-dispatch failure records history (invalid JSON params)", () => {
  const dir = makeDir();
  try {
    const configPath = writeConfig(dir);
    // Deliberately unparseable JSON containing a secret-looking token: the
    // persisted record must not echo the parser's excerpt of the input.
    const badJson = path.join(dir, "bad.json");
    fs.writeFileSync(badJson, '{"api_key": "sekrit"', "utf8");

    const result = runCli([
      "tool", "call", "exa.search", "--json-input", badJson, "--config", configPath, "--json",
    ]);
    assert.equal(result.status, 1, result.stderr);

    const lines = readHistoryLines(path.join(dir, "history.jsonl"));
    assert.equal(lines.length, 1, "exactly one history record for the invocation");
    const record = JSON.parse(lines[0]);
    assert.equal(record.outcome, "failed");
    assert.equal(record.command, "tool");
    assert.deepEqual(record.attempts, [], "no provider attempt happened pre-dispatch");
    assert.equal(record.source, "live");
    assert.equal(record.duration_ms, 0);
    assert.deepEqual(record.routing.providers_attempted, []);
    assert.equal(record.input, "exa.search");
    assert.match(record.errors["exa.search"], /^Failed to parse JSON input:/);
    assert.ok(
      !lines[0].includes("sekrit"),
      "history record must not contain the parser's excerpt of the input"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

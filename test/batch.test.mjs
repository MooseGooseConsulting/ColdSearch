import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBatchInput, validateBatchInput } from "../dist/batch/jsonl.js";
import {
  buildBatchPlan,
  conflictRecord,
  loadResumeIndex,
} from "../dist/batch/resume.js";
import { runBatch, runWithConcurrency } from "../dist/batch/runner.js";
import { DUPLICATE_ID_CONFLICT } from "../dist/batch/types.js";
import { installFetchMock, jsonResponse } from "./adapters/_fetch-mock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeDir(tag = "coldsearch-batch-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** Minimal hermetic config so runBatch's loadConfig does not touch the user's. */
function writeMinimalConfig(dir) {
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, "# minimal hermetic config\n", "utf8");
  return configPath;
}

/** Records which ids executed; always succeeds. */
function fakeExecutor() {
  const calls = [];
  return {
    calls,
    execute: async (record) => {
      calls.push(record.id);
      return {
        id: record.id,
        ...(record.capability ? { capability: record.capability } : {}),
        ...(record.tool ? { tool: record.tool } : {}),
        status: "success",
        result: { ok: true },
        error: null,
      };
    },
  };
}

function writeInput(dir, records) {
  const inputPath = path.join(dir, "in.jsonl");
  fs.writeFileSync(inputPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return inputPath;
}

function outputRecords(outputPath) {
  return fs
    .readFileSync(outputPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

function runBatchIn(dir, records, overrides = {}) {
  const inputPath = writeInput(dir, records);
  const outputPath = path.join(dir, "out.jsonl");
  return runBatch({
    input: inputPath,
    output: outputPath,
    concurrency: 2,
    retryErrors: false,
    configPath: writeMinimalConfig(dir),
    executor: fakeExecutor(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("accepts valid search records", () => {
  assert.doesNotThrow(() =>
    validateBatchInput({
      id: "node-lts",
      capability: "search",
      query: "current node lts version",
      limit: 5,
    })
  );
  // Optional knobs are accepted.
  assert.doesNotThrow(() =>
    validateBatchInput({
      id: "s2",
      capability: "search",
      query: "q",
      providers: ["exa"],
      singleProvider: true,
      noCache: false,
    })
  );
});

test("accepts valid extract records", () => {
  assert.doesNotThrow(() =>
    validateBatchInput({ id: "example-extract", capability: "extract", url: "https://example.com" })
  );
});

test("accepts valid crawl records", () => {
  assert.doesNotThrow(() =>
    validateBatchInput({
      id: "example-crawl",
      capability: "crawl",
      url: "https://example.com",
      limit: 10,
    })
  );
});

test("accepts valid provider-tool records", () => {
  assert.doesNotThrow(() =>
    validateBatchInput({
      id: "tavily-answer",
      tool: "tavily.answer",
      input: { query: "current node lts version" },
    })
  );
  assert.doesNotThrow(() =>
    validateBatchInput({ id: "exa-search", tool: "exa.search", input: { query: "q" } })
  );
});

test("rejects missing id", () => {
  assert.throws(
    () => validateBatchInput({ capability: "search", query: "q" }),
    /'id' is required/
  );
  assert.throws(
    () => validateBatchInput({ id: "", capability: "search", query: "q" }),
    /'id' is required/
  );
});

test("rejects missing query for search", () => {
  assert.throws(
    () => validateBatchInput({ id: "a", capability: "search" }),
    /'search' records require a non-empty 'query'/
  );
});

test("rejects missing url for extract/crawl", () => {
  assert.throws(
    () => validateBatchInput({ id: "a", capability: "extract" }),
    /'extract' records require a non-empty 'url'/
  );
  assert.throws(
    () => validateBatchInput({ id: "a", capability: "crawl", url: "" }),
    /'crawl' records require a non-empty 'url'/
  );
});

test("rejects missing input for provider-tool records", () => {
  assert.throws(
    () => validateBatchInput({ id: "a", tool: "tavily.answer" }),
    /'tool' records require an 'input' object/
  );
});

test("rejects records that specify both capability and tool", () => {
  assert.throws(
    () =>
      validateBatchInput({
        id: "a",
        capability: "search",
        tool: "tavily.answer",
        query: "q",
        input: {},
      }),
    /exactly one of 'capability' or 'tool'/
  );
  assert.throws(() => validateBatchInput({ id: "a" }), /exactly one of 'capability' or 'tool'/);
});

test("rejects unknown tool ids not exposed by 'tool list'", () => {
  assert.throws(
    () => validateBatchInput({ id: "a", tool: "exa.not-a-real-tool", input: {} }),
    /exposed by 'coldsearch tool list'/
  );
});

test("readBatchInput aggregates validation errors with line numbers", async () => {
  const dir = makeDir();
  try {
    const inputPath = path.join(dir, "bad.jsonl");
    fs.writeFileSync(
      inputPath,
      [
        JSON.stringify({ id: "ok", capability: "search", query: "q" }),
        "not json at all",
        JSON.stringify({ id: "x", capability: "search" }),
      ].join("\n") + "\n",
      "utf8"
    );
    await assert.rejects(() => readBatchInput(inputPath), (error) => {
      assert.equal(error.name, "BatchInputError");
      assert.match(error.message, /line 2: invalid JSON/);
      assert.match(error.message, /line 3: 'search' records require a non-empty 'query'/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Duplicate ID detection (input-level, unit)
// ---------------------------------------------------------------------------

test("identical duplicate ids are skipped; conflicting duplicate ids emit a conflict record", () => {
  const records = [
    { id: "a", capability: "search", query: "same" },
    { id: "a", capability: "search", query: "same" },
    { id: "b", capability: "search", query: "one" },
    { id: "b", capability: "search", query: "two" },
  ];
  const plan = buildBatchPlan(records, new Map(), { retryErrors: false });

  const a = plan.filter((e) => e.record.id === "a");
  assert.equal(a[0].action, "execute");
  assert.equal(a[1].action, "skip");
  assert.equal(a[1].reason, "duplicate-identical");

  const b = plan.filter((e) => e.record.id === "b");
  assert.equal(b[0].action, "execute");
  assert.equal(b[1].action, "conflict");
  assert.equal(b[1].conflict.status, "error");
  assert.equal(b[1].conflict.error.code, DUPLICATE_ID_CONFLICT);
  assert.equal(b[1].conflict.result, null);
});

test("conflict records are stable and never carry a result", () => {
  const record = conflictRecord({ id: "b", capability: "search", query: "two" });
  assert.equal(record.id, "b");
  assert.equal(record.capability, "search");
  assert.equal(record.status, "error");
  assert.equal(record.result, null);
  assert.equal(record.error.code, DUPLICATE_ID_CONFLICT);
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test("skips already-successful IDs on resume", async () => {
  const dir = makeDir();
  try {
    const outputPath = path.join(dir, "out.jsonl");
    // Prior run: id "a" already succeeded.
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        id: "a",
        capability: "search",
        status: "success",
        result: { results: [], providers_used: ["exa"] },
        error: null,
      }) + "\n",
      "utf8"
    );
    const executor = fakeExecutor();
    const summary = await runBatchIn(dir, [
      { id: "a", capability: "search", query: "aa" },
      { id: "b", capability: "search", query: "bb" },
    ], { executor });

    assert.deepEqual(executor.calls, ["b"], "only the unfinished id executes");
    assert.equal(summary.executed, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.succeeded, 1);
    const records = outputRecords(outputPath);
    assert.equal(records.filter((r) => r.id === "a").length, 1, "a is not re-appended");
    assert.equal(records.filter((r) => r.id === "b").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retries existing errors only with retryErrors", async () => {
  const dir = makeDir();
  try {
    // Prior run: id "a" errored with a retriable error.
    const seedOutput = (outputPath) =>
      fs.writeFileSync(
        outputPath,
        JSON.stringify({
          id: "a",
          capability: "search",
          status: "error",
          result: null,
          error: { message: "transient failure" },
        }) + "\n",
        "utf8"
      );

    const outputPath1 = path.join(dir, "out1.jsonl");
    seedOutput(outputPath1);
    const noRetry = fakeExecutor();
    const summary1 = await runBatchIn(dir, [{ id: "a", capability: "search", query: "aa" }], {
      executor: noRetry,
      output: outputPath1,
    });
    assert.deepEqual(noRetry.calls, [], "errors are not retried without --retry-errors");
    assert.equal(summary1.executed, 0);
    assert.equal(summary1.skipped, 1);

    const outputPath2 = path.join(dir, "out2.jsonl");
    seedOutput(outputPath2);
    const withRetry = fakeExecutor();
    const summary2 = await runBatchIn(dir, [{ id: "a", capability: "search", query: "aa" }], {
      executor: withRetry,
      output: outputPath2,
      retryErrors: true,
    });
    assert.deepEqual(withRetry.calls, ["a"], "errors are retried with --retry-errors");
    assert.equal(summary2.executed, 1);
    assert.equal(summary2.succeeded, 1);
    const records = outputRecords(outputPath2);
    assert.equal(records.length, 2, "error record kept; success record appended");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("conflict error records are never retried, even with retryErrors", () => {
  // Compact resume index: the output holds one conflict outcome for id "b".
  const resumeIndex = new Map([["b", [{ status: "error", conflict: true }]]]);
  // The input still repeats the id with different inputs: the primary has no
  // outcome of its own yet, and the secondary's conflict is already recorded.
  const records = [
    { id: "b", capability: "search", query: "x" },
    { id: "b", capability: "search", query: "y" },
  ];

  for (const retryErrors of [false, true]) {
    const plan = buildBatchPlan(records, resumeIndex, { retryErrors });
    assert.equal(plan[0].action, "execute", "primary without its own outcome executes");
    assert.equal(plan[1].action, "skip");
    assert.equal(plan[1].reason, "resume-conflict", "conflict record is never re-emitted or retried");
  }
});

test("loadResumeIndex ignores malformed/partial lines and missing files", async () => {
  const dir = makeDir();
  try {
    const missing = await loadResumeIndex(path.join(dir, "nope.jsonl"));
    assert.equal(missing.size, 0);

    const outputPath = path.join(dir, "out.jsonl");
    fs.writeFileSync(
      outputPath,
      [
        JSON.stringify({ id: "a", status: "success", result: {}, error: null }),
        '{"id":"b","status":"error","result":null,"error":{"message":"x"}}',
        '{"id":"c","status":"suc', // partial trailing write from an interrupted run
      ].join("\n") + "\n",
      "utf8"
    );
    const index = await loadResumeIndex(outputPath);
    assert.equal(index.size, 2);
    assert.equal(index.get("a")[0].status, "success");
    assert.equal(index.get("b")[0].status, "error");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test("enforces concurrency limit", async () => {
  const dir = makeDir();
  try {
    const records = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      capability: "search",
      query: `q${i}`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const executor = {
      execute: async (record) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return {
          id: record.id,
          capability: "search",
          status: "success",
          result: { ok: true },
          error: null,
        };
      },
    };

    const summary = await runBatchIn(dir, records, { concurrency: 2, executor });
    assert.ok(maxInFlight <= 2, `max in-flight ${maxInFlight} exceeded concurrency 2`);
    assert.equal(summary.executed, 5);
    assert.equal(summary.succeeded, 5);
    assert.equal(summary.failed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runWithConcurrency propagates a task failure to the caller", async () => {
  await assert.rejects(
    runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
    }),
    /boom/
  );
});

test("dry run reports the plan without executing or writing", async () => {
  const dir = makeDir();
  try {
    const executor = fakeExecutor();
    const summary = await runBatchIn(
      dir,
      [
        { id: "a", capability: "search", query: "aa" },
        { id: "a", capability: "search", query: "bb" },
        { id: "c", capability: "search", query: "cc" },
      ],
      { executor, dryRun: true }
    );
    assert.equal(summary.dry_run, true);
    assert.equal(summary.to_execute, 2);
    assert.equal(summary.conflicts, 1);
    assert.equal(summary.records.length, 3);
    assert.equal(summary.records[1].action, "conflict");
    assert.deepEqual(executor.calls, [], "dry run makes no executor calls");
    assert.equal(fs.existsSync(path.join(dir, "out.jsonl")), false, "dry run writes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Output redaction
// ---------------------------------------------------------------------------

test("redacts configured secrets from written output records", async () => {
  const dir = makeDir();
  try {
    const secret = "the-batch-literal-secret-123456";
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[providers.tavily]",
        "[providers.tavily.keyPool]",
        `keys = [${JSON.stringify(secret)}]`,
      ].join("\n") + "\n",
      "utf8"
    );

    const executor = {
      calls: [],
      execute: async (record) => {
        executor.calls.push(record.id);
        const base = { id: record.id, capability: "search" };
        if (record.id === "err") {
          // A provider error string can echo the resolved key back.
          return { ...base, status: "error", result: null, error: { message: `All providers failed: ${secret}` } };
        }
        // A tool success record can carry the key in raw provider output.
        return {
          ...base,
          status: "success",
          result: { raw: `echo ${secret} here`, api_key: secret },
          error: null,
        };
      },
    };

    // Note: call runBatch directly (not runBatchIn) — runBatchIn rewrites
    // config.toml with the empty minimal config, which would drop the key.
    const inputPath = writeInput(dir, [
      { id: "ok", capability: "search", query: "ok" },
      { id: "err", capability: "search", query: "err" },
    ]);
    const summary = await runBatch({
      input: inputPath,
      output: path.join(dir, "out.jsonl"),
      concurrency: 2,
      retryErrors: false,
      configPath,
      executor,
    });
    assert.equal(summary.executed, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);

    const written = fs.readFileSync(path.join(dir, "out.jsonl"), "utf8");
    assert.ok(!written.includes(secret), "secret value must not appear in the output file");
    // Completion order is not input order under concurrency: index by id.
    const records = outputRecords(path.join(dir, "out.jsonl"));
    const ok = records.find((r) => r.id === "ok");
    const err = records.find((r) => r.id === "err");
    assert.equal(ok.result.api_key, "[REDACTED]");
    assert.ok(!ok.result.raw.includes(secret), "secret scrubbed from result.raw");
    assert.ok(!err.error.message.includes(secret), "secret scrubbed from error message");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Output preflight
// ---------------------------------------------------------------------------

test("unwritable output path rejects before the executor is called", async () => {
  const dir = makeDir();
  try {
    // A path whose parent directory does not exist: readable-as-missing (so
    // the resume index is empty) but not appendable — the preflight must
    // reject before any provider work happens.
    const outputPath = path.join(dir, "no-such-dir", "out.jsonl");
    const executor = fakeExecutor();
    await assert.rejects(
      () =>
        runBatchIn(dir, [{ id: "a", capability: "search", query: "aa" }], {
          executor,
          output: outputPath,
        }),
      /Cannot write batch output file/
    );
    assert.deepEqual(executor.calls, [], "preflight rejects before any executor call");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Serialized appends
// ---------------------------------------------------------------------------

test("serializes concurrent appends of large records into clean JSONL lines", async () => {
  const dir = makeDir();
  try {
    const records = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      capability: "search",
      query: `q${i}`,
    }));
    // Large payloads are where fs.appendFile may split a write into several
    // syscalls, so an un-serialized append would interleave between workers.
    const payload = "x".repeat(100 * 1024);
    const executor = {
      execute: async (record) => ({
        id: record.id,
        capability: "search",
        status: "success",
        result: { blob: payload, id: record.id },
        error: null,
      }),
    };

    const summary = await runBatchIn(dir, records, { concurrency: 8, executor });
    assert.equal(summary.executed, 50);
    assert.equal(summary.succeeded, 50);

    const written = fs.readFileSync(path.join(dir, "out.jsonl"), "utf8");
    const lines = written.trim().split("\n");
    assert.equal(lines.length, 50, "exactly 50 output lines, none interleaved");
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if two records interleaved
      assert.equal(parsed.status, "success");
      assert.equal(parsed.result.blob.length, payload.length);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Input/output aliasing
// ---------------------------------------------------------------------------

test("input and output aliasing the same file rejects before any execution", async () => {
  const dir = makeDir();
  try {
    const inputPath = writeInput(dir, [{ id: "a", capability: "search", query: "aa" }]);
    const executor = fakeExecutor();
    await assert.rejects(
      () =>
        runBatch({
          input: inputPath,
          output: inputPath,
          concurrency: 2,
          retryErrors: false,
          configPath: writeMinimalConfig(dir),
          executor,
        }),
      /same file/
    );
    assert.deepEqual(executor.calls, [], "alias rejection happens before any executor call");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hardlinked input and output are rejected as the same file", async (t) => {
  const dir = makeDir();
  try {
    const inputPath = writeInput(dir, [{ id: "a", capability: "search", query: "aa" }]);
    const outputPath = path.join(dir, "out-hardlink.jsonl");
    try {
      fs.linkSync(inputPath, outputPath);
    } catch {
      t.skip("hard links are not supported on this filesystem");
      return;
    }
    // Realpath does not collapse hardlinks; the dev/ino comparison must catch
    // the alias so results cannot be appended onto the input.
    await assert.rejects(
      () =>
        runBatch({
          input: inputPath,
          output: outputPath,
          concurrency: 2,
          retryErrors: false,
          configPath: writeMinimalConfig(dir),
          executor: fakeExecutor(),
        }),
      /same file/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Resume record validation + compaction
// ---------------------------------------------------------------------------

test("loadResumeIndex compacts outcomes and discards contract-invalid lines", async () => {
  const dir = makeDir();
  try {
    const outputPath = path.join(dir, "out.jsonl");
    fs.writeFileSync(
      outputPath,
      [
        JSON.stringify({ id: "a", status: "success" }), // invalid: no result payload
        JSON.stringify({ id: "b", status: "success", result: {}, error: null }), // valid
        JSON.stringify({ id: "c", status: "error", result: null, error: { message: "x" } }), // valid
        JSON.stringify({ id: "d", status: "error", result: {}, error: { message: "x" } }), // invalid: result not null
        JSON.stringify({ id: "e", status: "success", result: {}, error: { message: "x" } }), // invalid: success with error
      ].join("\n") + "\n",
      "utf8"
    );
    const index = await loadResumeIndex(outputPath);
    assert.deepEqual([...index.keys()].sort(), ["b", "c"]);
    assert.deepEqual(index.get("b"), [{ id: "b", status: "success", conflict: false }]);
    assert.deepEqual(index.get("c"), [{ id: "c", status: "error", conflict: false }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("contract-invalid output lines do not count as completed outcomes", async () => {
  const dir = makeDir();
  try {
    // Parseable but contract-invalid: a success without a result payload must
    // not be treated as an already-completed outcome (which would skip it).
    const outputPath = path.join(dir, "out.jsonl");
    fs.writeFileSync(outputPath, JSON.stringify({ id: "a", status: "success" }) + "\n", "utf8");
    const executor = fakeExecutor();
    const summary = await runBatchIn(dir, [{ id: "a", capability: "search", query: "aa" }], {
      executor,
    });
    assert.deepEqual(executor.calls, ["a"], "invalid success line must not skip the record");
    assert.equal(summary.executed, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(outputRecords(outputPath).length, 2, "invalid line kept verbatim; valid record appended");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pending crawl batch records are preserved and re-executed on resume", async () => {
  const dir = makeDir();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _delay, ...args) => originalSetTimeout(fn, 0, ...args);
  let nextJob = 0;
  const restore = installFetchMock({
    "POST https://api.firecrawl.dev/v2/crawl": async () =>
      jsonResponse({ success: true, id: `batch-job-${++nextJob}`, url: "https://example.com" }),
    "*": async ({ url, method }) => {
      assert.equal(method, "GET");
      assert.match(url, /\/v2\/crawl\/batch-job-\d+$/);
      return jsonResponse({ success: true, status: "scraping" });
    },
  });

  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `
[capabilities.crawl]
providers = ["firecrawl"]
strategy = "all"

[providers.firecrawl]
[providers.firecrawl.keyPool]
keys = ["firecrawl-test-key"]

[cache]
enabled = false

[logging.usage]
path = ${JSON.stringify(path.join(dir, "usage.jsonl"))}

[history]
path = ${JSON.stringify(path.join(dir, "history.jsonl"))}
`,
      "utf8"
    );
    const inputPath = writeInput(dir, [
      { id: "crawl-pending", capability: "crawl", url: "https://example.com" },
    ]);
    const outputPath = path.join(dir, "out.jsonl");
    const options = {
      input: inputPath,
      output: outputPath,
      concurrency: 1,
      retryErrors: false,
      configPath,
    };

    const first = await runBatch(options);
    assert.equal(first.succeeded, 0);
    assert.equal(first.pending, 1);
    assert.equal(first.failed, 0);
    assert.equal(outputRecords(outputPath)[0].status, "pending");
    assert.equal(outputRecords(outputPath)[0].result.results[0].jobId, "batch-job-1");

    const second = await runBatch(options);
    assert.equal(second.executed, 1, "pending output is not treated as completed on resume");
    assert.equal(second.pending, 1);
    assert.equal(nextJob, 2, "resume creates a fresh crawl instead of skipping the pending job");
    assert.deepEqual(outputRecords(outputPath).map((record) => record.status), ["pending", "pending"]);
    assert.equal(outputRecords(outputPath)[1].result.results[0].jobId, "batch-job-2");
  } finally {
    restore();
    globalThis.setTimeout = originalSetTimeout;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fully-resumed runs
// ---------------------------------------------------------------------------

test("fully-resumed runs resolve without a valid config", async () => {
  const dir = makeDir();
  try {
    const outputPath = path.join(dir, "out.jsonl");
    // Prior run: id "a" succeeded; nothing remains to execute or append.
    fs.writeFileSync(
      outputPath,
      JSON.stringify({
        id: "a",
        capability: "search",
        status: "success",
        result: { results: [], providers_used: ["exa"] },
        error: null,
      }) + "\n",
      "utf8"
    );
    const inputPath = writeInput(dir, [{ id: "a", capability: "search", query: "aa" }]);
    const summary = await runBatch({
      input: inputPath,
      output: outputPath,
      concurrency: 2,
      retryErrors: false,
      // A nonexistent config would throw if loadConfig were reached.
      configPath: path.join(dir, "missing-config.toml"),
      executor: fakeExecutor(),
    });
    assert.equal(summary.executed, 0);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.conflicts, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

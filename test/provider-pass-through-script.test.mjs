import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_STATUSES,
  REQUIRED_PROVIDER_PATHS,
  REQUIRED_PROVIDER_TOOLS,
  RUNNABLE_PROVIDER_TOOLS,
  SUPPORTED_PROVIDER_PATHS,
  compareToolTarget,
  makeColdSearchToolResult,
  missingRequiredEvidenceRows,
  notRunRow,
  redact,
  redactSensitiveText,
  renderSummary,
  selectTargets,
  targetId,
  verifyAllRows,
  writeEvidence,
} from "../scripts/provider-pass-through.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "provider-pass-through.mjs");

function runScript(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("Gate 0 harness enumerates every required provider path", () => {
  assert.deepEqual(
    REQUIRED_PROVIDER_PATHS.map(({ provider, path }) => `${provider}:${path}`),
    [
      "tavily:search",
      "tavily:extract",
      "tavily:crawl",
      "firecrawl:search",
      "firecrawl:extract",
      "firecrawl:crawl",
      "exa:search",
      "exa:extract",
      "exa:crawl",
      "brave:search",
      "serper:search",
      "jina:extract",
      "searxng:search",
    ]
  );
});

test("Gate 0 harness enumerates required provider-tool rows", () => {
  assert.deepEqual(
    REQUIRED_PROVIDER_TOOLS.map(({ provider, tool }) => `${provider}.${tool}`),
    [
      "exa.search", "exa.contents", "exa.findSimilar", "exa.answer",
      "tavily.search", "tavily.extract", "tavily.crawl", "tavily.map", "tavily.research", "tavily.answer",
      "firecrawl.search", "firecrawl.scrape", "firecrawl.crawl", "firecrawl.map", "firecrawl.extract",
      "brave.webSearch", "brave.llmContext", "brave.answers", "serper.search",
      "jina.reader", "jina.embeddings", "jina.rerank", "searxng.search",
      "brightdata.serp", "brightdata.unlocker", "brightdata.datasetsList", "brightdata.datasetMetadata",
      "brightdata.scrape", "brightdata.trigger", "brightdata.progress", "brightdata.snapshotMetadata",
      "brightdata.cancel", "brightdata.snapshot", "brightdata.crawl", "brightdata.discover",
    ]
  );
});

test("all wired provider-tool profiles remain visible in the conformance inventory", () => {
  const sourceFiles = [
    "src/registry/tool-profiles.ts",
    "src/registry/brightdata-tool-profiles.ts",
  ];
  const sourceIds = new Set();
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const [, provider, tool] of source.matchAll(/^\s*"([^."]+)\.([^"]+)":\s*(?:\{|directPassThroughProfile\()/gm)) {
      sourceIds.add(`${provider}.${tool}`);
    }
  }
  assert.deepEqual(
    new Set(REQUIRED_PROVIDER_TOOLS.map(targetId)),
    sourceIds
  );
});

test("modern evidence keeps requiring tool rows even if every tool row is removed", () => {
  const fullRows = [...SUPPORTED_PROVIDER_PATHS, ...REQUIRED_PROVIDER_TOOLS]
    .map((target) => notRunRow(target));
  const damagedRows = fullRows.filter((row) => !row.tool);
  const summary = renderSummary(damagedRows);

  assert.match(summary, /Inventory schema version: 2/);
  assert.deepEqual(
    missingRequiredEvidenceRows(damagedRows, summary),
    REQUIRED_PROVIDER_TOOLS.map(targetId)
  );
});

test("evidence validation fails closed when the inventory version is missing", () => {
  assert.throws(
    () => missingRequiredEvidenceRows([], "# Gate 0 evidence"),
    /missing an inventory schema version/
  );
});

test("Bright Data normalized paths stay visible without routine live fixtures", () => {
  assert.ok(SUPPORTED_PROVIDER_PATHS.some((target) => target.provider === "brightdata" && target.path === "search"));
  assert.ok(SUPPORTED_PROVIDER_PATHS.some((target) => target.provider === "brightdata" && target.path === "extract"));
  assert.ok(RUNNABLE_PROVIDER_TOOLS.every((target) => REQUIRED_PROVIDER_TOOLS.some((entry) => targetId(entry) === targetId(target))));
});

test("Gate 0 harness only emits plan-approved row statuses", () => {
  assert.deepEqual(ALLOWED_STATUSES, [
    "pass",
    "fail",
    "blocked_missing_secret",
    "blocked_provider",
    "not_run",
    "waived_by_user",
  ]);
});

test("Gate 0 harness can scope to one provider path", () => {
  assert.deepEqual(selectTargets({ provider: "jina", path: "extract" }), [
    { provider: "jina", path: "extract" },
  ]);
});

test("Gate 0 harness rejects unsupported provider paths", () => {
  assert.throws(
    () => selectTargets({ provider: "jina", path: "search" }),
    /No Gate 0 target matches provider=jina path=search/
  );
});

test("provider/path/tool filters select only requested rows", () => {
  // path filter stays path-only even when the provider also has tool rows
  assert.deepEqual(selectTargets({ provider: "tavily", path: "extract" }), [
    { provider: "tavily", path: "extract" },
  ]);
  // tool filter selects only that tool
  assert.deepEqual(selectTargets({ provider: "tavily", tool: "map" }), [
    { provider: "tavily", tool: "map", kind: "tool" },
  ]);
  // tool filter without a provider selects every provider's tool of that name
  assert.deepEqual(selectTargets({ tool: "map" }).map(targetId), [
    "tavily.map",
    "firecrawl.map",
  ]);
  // provider-only selection covers that provider's paths and tools
  assert.deepEqual(selectTargets({ provider: "tavily" }).map(targetId), [
    "tavily:search",
    "tavily:extract",
    "tavily:crawl",
    "tavily.search",
    "tavily.extract",
    "tavily.crawl",
    "tavily.map",
    "tavily.research",
    "tavily.answer",
  ]);
});

test("--all selection covers the full matrix of paths and tools", () => {
  const targets = selectTargets();
  assert.equal(
    targets.length,
    SUPPORTED_PROVIDER_PATHS.length + REQUIRED_PROVIDER_TOOLS.length
  );
  const toolRows = targets.filter((target) => target.kind === "tool");
  assert.deepEqual(
    toolRows.map(targetId),
    REQUIRED_PROVIDER_TOOLS.map(({ provider, tool }) => `${provider}.${tool}`)
  );
});

test("selectTargets rejects tools outside the catalogued inventory", () => {
  assert.throws(
    () => selectTargets({ provider: "tavily", tool: "ghost" }),
    /No conformance target matches provider=tavily tool=ghost/
  );
});

test("a path filter matching a catalogued tool name hints at --tool", () => {
  assert.throws(
    () => selectTargets({ provider: "tavily", path: "map" }),
    /use --tool map/
  );
});

test("every supported row maps to one allowed status, including not_run", () => {
  assert.ok(ALLOWED_STATUSES.includes("not_run"));
  const rows = selectTargets().map((target) => notRunRow(target));
  assert.ok(rows.every((row) => ALLOWED_STATUSES.includes(row.status)));
  assert.equal(rows.filter((row) => row.status === "not_run").length, rows.length);
  // the full inventory of not_run rows satisfies the harness row invariant
  verifyAllRows(rows);
});

test("verifyAllRows rejects rows outside the inventory and unsupported statuses", () => {
  assert.throws(
    () => verifyAllRows([{ provider: "ghost", path: "search", status: "pass" }]),
    /did not emit rows for: /
  );
  const badStatuses = selectTargets().map((target) => ({
    ...notRunRow(target),
    status: "maybe",
  }));
  assert.throws(() => verifyAllRows(badStatuses), /unsupported statuses: maybe/);
});

test("results.jsonl emits one machine-readable row per provider-tool entry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-evidence-"));
  const samplesDir = path.join(dir, "samples");
  fs.mkdirSync(samplesDir, { recursive: true });
  try {
    const rows = [
      {
        provider: "tavily",
        path: "search",
        status: "pass",
        native: { result_count: 2 },
        coldsearch: { result_count: 2 },
        comparison: { passed: true, notes: [], checks: [], detail_loss: [] },
      },
      {
        provider: "tavily",
        tool: "map",
        status: "pass",
        native: { result_count: 2 },
        coldsearch: { result_count: 2 },
        comparison: { passed: true, notes: [], checks: [], detail_loss: [] },
      },
      notRunRow({ provider: "exa", tool: "contents", kind: "tool" }),
    ];
    writeEvidence(dir, samplesDir, rows);
    const lines = fs.readFileSync(path.join(dir, "results.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      parsed.map((row) => [row.provider, row.tool ?? row.path, row.status]),
      [
        ["tavily", "search", "pass"],
        ["tavily", "map", "pass"],
        ["exa", "contents", "not_run"],
      ]
    );
    const pathSample = JSON.parse(fs.readFileSync(path.join(samplesDir, "tavily-search.json"), "utf8"));
    assert.equal(pathSample.path, "search");
    assert.equal(Object.hasOwn(pathSample, "tool"), false);
    const toolSample = JSON.parse(fs.readFileSync(path.join(samplesDir, "tavily-map.json"), "utf8"));
    assert.equal(toolSample.tool, "map");
    assert.equal(Object.hasOwn(toolSample, "path"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful workflow summary discloses blocked/not-run rows without calling them passes", () => {
  const rows = [
    {
      provider: "tavily",
      path: "search",
      status: "pass",
      native: { result_count: 5 },
      coldsearch: { result_count: 5 },
      comparison: { passed: true, notes: [], checks: [], detail_loss: [] },
    },
    {
      provider: "firecrawl",
      path: "search",
      status: "blocked_missing_secret",
      missing_requirement: "FIRECRAWL_API_KEY",
      native: { skipped: true },
      coldsearch: { skipped: true },
      comparison: { passed: false, notes: ["missing FIRECRAWL_API_KEY"] },
    },
    notRunRow({ provider: "brave", tool: "webSearch", kind: "tool" }),
  ];
  const summary = renderSummary(rows);
  assert.match(summary, /\n\|---\|---\|---:\|---:\|---\|\n/);
  assert.match(summary, /\| tavily:search \| pass \| 5 \| 5 \|/);
  assert.match(summary, /\| firecrawl:search \| blocked_missing_secret \| - \| - \|/);
  assert.match(summary, /\| brave.webSearch \| not_run \| - \| - \|/);
  // status counts include not_run
  assert.match(summary, /\| not_run \| 1 \|/);
  assert.match(summary, /not_run/, "summary text explains not_run rows");
  // the not_run row is never presented as a pass
  assert.ok(!summary.includes("brave.webSearch | pass"));
  assert.ok(!summary.includes("firecrawl:search | pass"));
});

test("secrets and signed URLs are redacted from evidence and summaries", () => {
  process.env.TAVILY_API_KEY = "tvly-test-secret-value";
  process.env.BRAVE_API_KEY = "brave-test-secret";
  try {
    const redacted = redact({
      url: "https://signed.example.com/file?redir_token=abc123&access_token=def456",
      headers: { Authorization: "Bearer tvly-test-secret-value" },
      raw: '{"X-API-KEY":"brave-test-secret"}',
    });
    const json = JSON.stringify(redacted);
    assert.ok(!json.includes("tvly-test-secret-value"));
    assert.ok(!json.includes("brave-test-secret"));
    assert.ok(!json.includes("abc123"));
    assert.ok(!json.includes("def456"));
    assert.ok(json.includes("REDACTED"));
  } finally {
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
  }
});

test("short credential values are removed from failure text and raw samples", () => {
  process.env.TAVILY_API_KEY = "tiny";
  try {
    assert.equal(redactSensitiveText("provider rejected key tiny"), "provider rejected key REDACTED");
    const cold = makeColdSearchToolResult(
      { provider: "tavily", tool: "map" },
      {
        ok: true,
        raw: {
          results: ["https://example.com"],
          authorization: "Bearer tiny",
          detail: "provider echoed tiny",
        },
      }
    );
    const serialized = JSON.stringify(cold.raw_sample);
    assert.ok(!serialized.includes("tiny"));
    assert.ok(!serialized.includes("provider echoed"));
    assert.ok(!serialized.includes("authorization"), "credential field names are omitted from raw schema evidence");
  } finally {
    delete process.env.TAVILY_API_KEY;
  }
});

test("smoke agent and Doppler credentials are redacted from error text", () => {
  const credentials = {
    OPENROUTER_API_KEY: "openrouter-smoke-secret",
    ISOQUANT_API_KEY: "isoquant-smoke-secret",
    DOPPLER_TOKEN: "doppler-smoke-secret",
  };
  const previous = Object.fromEntries(Object.keys(credentials).map((name) => [name, process.env[name]]));
  try {
    for (const [name, secret] of Object.entries(credentials)) {
      process.env[name] = secret;
      assert.equal(redactSensitiveText(`CLI error echoed ${secret}`), "CLI error echoed REDACTED", name);
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("raw provider evidence stores bounded schema without provider values", () => {
  const fields = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [
    `field_${index}`,
    Array.from({ length: 10 }, () => `unknown-credential-${index}`),
  ]));
  const cold = makeColdSearchToolResult(
    { provider: "tavily", tool: "map" },
    { ok: true, raw: { results: ["https://example.com"], ...fields } }
  );
  assert.equal(cold.raw_sample.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(cold.raw_sample), "utf8") <= 12_000);
  assert.ok(!JSON.stringify(cold.raw_sample).includes("unknown-credential"));
});

test("tavily.map parses its result array from raw.results, matching the substrate surface", () => {
  // Tavily Map returns discovered URLs under `results`; a `urls`-only payload
  // must not be treated as the endpoint's result array.
  const tavilyMap = { provider: "tavily", tool: "map", kind: "tool" };
  const parsed = makeColdSearchToolResult(tavilyMap, {
    ok: true,
    catalogued: true,
    provider: "tavily",
    tool: "map",
    raw: { results: ["https://docs.tavily.com", "https://docs.tavily.com/api"], base_url: "docs.tavily.com" },
  });
  assert.equal(parsed.result_count, 2);
  assert.equal(parsed.catalogued, true);
  assert.equal(parsed.raw_available, true);

  const urlsOnly = makeColdSearchToolResult(tavilyMap, {
    ok: true,
    catalogued: true,
    provider: "tavily",
    tool: "map",
    raw: { urls: ["https://docs.tavily.com"] },
  });
  assert.equal(urlsOnly.result_count, 0, "urls is not the Tavily Map result field");
});

test("tool-call results disclose whether the expected raw response field is available", () => {
  const tavilyMap = { provider: "tavily", tool: "map", kind: "tool" };
  assert.equal(
    makeColdSearchToolResult(tavilyMap, {
      ok: true,
      catalogued: true,
      provider: "tavily",
      tool: "map",
      raw: { results: ["https://docs.tavily.com"] },
    }).raw_available,
    true
  );
  assert.equal(
    makeColdSearchToolResult(tavilyMap, {
      ok: true,
      catalogued: true,
      provider: "tavily",
      tool: "map",
      raw: {},
    }).raw_available,
    false,
    "an empty object does not contain the expected response field"
  );
  assert.equal(
    makeColdSearchToolResult(tavilyMap, {
      ok: true,
      catalogued: true,
      provider: "tavily",
      tool: "map",
      raw: { unrelated: true },
    }).raw_available,
    false,
    "an unrelated non-empty object is not a Tavily Map response shape"
  );
  assert.equal(
    makeColdSearchToolResult(tavilyMap, {
      ok: true,
      catalogued: true,
      provider: "tavily",
      tool: "map",
    }).raw_available,
    false,
    "a missing raw payload has no expected response field"
  );
});

test("Firecrawl Map unwraps object links and preserves the tool metadata envelope", () => {
  const target = { provider: "firecrawl", tool: "map", kind: "tool" };
  const raw = {
    links: [{
      url: "https://docs.firecrawl.dev/api",
      title: "API reference",
      description: "Firecrawl API documentation",
    }],
  };
  const output = {
    ok: true,
    catalogued: true,
    provider: "firecrawl",
    tool: "map",
    meta: { duration_ms: 12, safe_key_ref: "env:FIRECRAWL_API_KEY", warnings: [] },
    raw,
  };
  const cold = makeColdSearchToolResult(target, output);

  assert.deepEqual(cold.items, [{
    title: "API reference",
    url: "https://docs.firecrawl.dev/api",
    content: "Firecrawl API documentation",
    source: "firecrawl",
  }]);
  assert.deepEqual(cold.meta, output.meta);
  assert.equal(cold.raw_available, true);
  assert.deepEqual(cold.raw_sample.schema.fields.links.items[0].fields, {
    description: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
  });
  assert.ok(!JSON.stringify(cold.raw_sample).includes("docs.firecrawl.dev"));

  const native = {
    result_count: 1,
    items: cold.items,
    raw_available: true,
    raw_sample: cold.raw_sample,
  };
  assert.equal(compareToolTarget(target, native, cold).passed, true);

  const mislabelled = makeColdSearchToolResult(target, { ...output, provider: "exa" });
  const comparison = compareToolTarget(target, native, mislabelled);
  assert.equal(comparison.passed, false);
  assert.equal(
    comparison.checks.find(({ label }) => label === "ColdSearch tool result names the selected provider").pass,
    false
  );
});

test("map conformance tolerates changing result sets across independent calls", () => {
  const target = { provider: "tavily", tool: "map", kind: "tool" };
  const nativeItems = [
    { url: "https://docs.example/a", title: "A" },
    { url: "https://docs.example/b", title: "B" },
  ];
  const native = {
    result_count: 2,
    items: nativeItems,
    raw_available: true,
  };
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "tavily",
    tool: "map",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: ["https://docs.example/a", "https://docs.example/c"] },
  });
  native.raw_sample = cold.raw_sample;
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, true);
  assert.match(comparison.notes.join(" "), /provider variance/);
});

test("map conformance records fully changed result sets as live variance", () => {
  const target = { provider: "tavily", tool: "map", kind: "tool" };
  const native = {
    result_count: 2,
    items: [
      { url: "https://docs.example/a", title: "A" },
      { url: "https://docs.example/b", title: "B" },
    ],
    raw_available: true,
  };
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "tavily",
    tool: "map",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: ["https://docs.example/c"] },
  });
  native.raw_sample = cold.raw_sample;
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, true);
  assert.match(comparison.notes.join(" "), /no overlapping URLs or titles/);
});

test("tool conformance rejects content fields dropped from a partial response", () => {
  const target = { provider: "exa", tool: "contents", kind: "tool" };
  const native = {
    result_count: 1,
    items: [{ url: "https://example.com", title: "Example", content: "Native page text" }],
    raw_available: true,
  };
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "exa",
    tool: "contents",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: [{ url: "https://example.com", title: "Example" }] },
  });
  native.raw_sample = cold.raw_sample;
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, false);
  assert.equal(
    comparison.checks.find(({ label }) => label === "ColdSearch tool output retains populated native fields for overlapping results").pass,
    false
  );
});

test("provider raw metadata fields are checked without comparing live result values", () => {
  const target = { provider: "brave", tool: "webSearch", kind: "tool" };
  const nativeSample = makeColdSearchToolResult(target, {
    ok: true,
    raw: {
      query: { original: "openai", show_strict_warning: false },
      web: { results: [{ title: "A", url: "https://a.example" }] },
    },
  }).raw_sample;
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "brave",
    tool: "webSearch",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: {
      query: { original: "openai" },
      web: { results: [{ title: "A changed", url: "https://a.example" }] },
    },
  });
  const native = {
    result_count: 1,
    items: [{ title: "A", url: "https://a.example", snippet: "text" }],
    raw_available: true,
    raw_sample: nativeSample,
  };
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, false);
  assert.equal(
    comparison.checks.find(({ label }) => label === "ColdSearch tool output preserves stable provider raw metadata schema").pass,
    false
  );
});

test("Exa contents conformance catches dropped statuses metadata", () => {
  const target = { provider: "exa", tool: "contents", kind: "tool" };
  const nativeSample = makeColdSearchToolResult(target, {
    ok: true,
    raw: {
      results: [{ url: "https://example.com", text: "native" }],
      statuses: [{ id: "request-1", status: "success" }],
    },
  }).raw_sample;
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "exa",
    tool: "contents",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: [{ url: "https://example.com", text: "changed" }] },
  });
  const comparison = compareToolTarget(target, {
    result_count: 1,
    items: [{ url: "https://example.com", title: "", content: "native" }],
    raw_available: true,
    raw_sample: nativeSample,
  }, cold);
  assert.equal(
    comparison.checks.find(({ label }) => label === "ColdSearch tool output preserves stable provider raw metadata schema").pass,
    false
  );
});

test("Exa contents rejects an empty status array when native returned status entries", () => {
  const target = { provider: "exa", tool: "contents", kind: "tool" };
  const native = makeColdSearchToolResult(target, {
    ok: true,
    raw: {
      results: [{ url: "https://example.com", text: "native" }],
      statuses: [{ id: "request-1", status: "success" }],
    },
  });
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "exa",
    tool: "contents",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: {
      results: [{ url: "https://example.com", text: "changed" }],
      statuses: [],
    },
  });
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, false);
  assert.equal(
    comparison.checks.find(({ label }) => label === "ColdSearch tool output preserves stable provider raw metadata schema").pass,
    false
  );
});

test("stable raw metadata fields are required for Tavily and Firecrawl map", () => {
  const cases = [
    {
      target: { provider: "tavily", tool: "map", kind: "tool" },
      nativeRaw: { base_url: "https://docs.example", results: ["https://docs.example/a"] },
      coldRaw: { results: ["https://docs.example/a"] },
    },
    {
      target: { provider: "firecrawl", tool: "map", kind: "tool" },
      nativeRaw: {
        success: true,
        metadata: { creditsUsed: 1 },
        links: [{ url: "https://docs.example/a", title: "A" }],
      },
      coldRaw: { links: [{ url: "https://docs.example/a", title: "A" }] },
    },
  ];

  for (const { target, nativeRaw, coldRaw } of cases) {
    const native = makeColdSearchToolResult(target, { ok: true, raw: nativeRaw });
    const cold = makeColdSearchToolResult(target, {
      ok: true,
      catalogued: true,
      provider: target.provider,
      tool: target.tool,
      meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
      raw: coldRaw,
    });
    const comparison = compareToolTarget(target, native, cold);
    assert.equal(comparison.passed, false, targetId(target));
    assert.equal(
      comparison.checks.find(({ label }) => label === "ColdSearch tool output preserves stable provider raw metadata schema").pass,
      false,
      targetId(target)
    );
  }
});

test("stable raw metadata uses an independent schema budget", () => {
  const target = { provider: "brave", tool: "webSearch", kind: "tool" };
  const makeRaw = (news) => ({
    mixed: [],
    news,
    query: { original: "openai", show_strict_warning: false },
    videos: [],
    web: { results: [{ title: "Example", url: "https://example.com", description: "text" }] },
  });
  const largeNews = Array.from({ length: 3 }, () =>
    Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, "value"]))
  );
  const native = makeColdSearchToolResult(target, { ok: true, raw: makeRaw(largeNews) });
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "brave",
    tool: "webSearch",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: makeRaw([]),
  });
  assert.equal(native.raw_sample.schema.fields.query, undefined);
  assert.deepEqual(Object.keys(native.raw_sample.stable.query.fields), ["original", "show_strict_warning"]);
  assert.deepEqual(
    Object.keys(native.raw_sample.result_array_schemas.results.items[0].fields),
    ["description", "title", "url"]
  );
  assert.equal(compareToolTarget(target, native, cold).passed, true);
});

test("different URLs with the same title are live variance, not a false match", () => {
  const target = { provider: "brave", tool: "webSearch", kind: "tool" };
  const makeResult = (url) => makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "brave",
    tool: "webSearch",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: {
      query: { original: "openai" },
      web: { results: [{ title: "Same result", url, description: "description" }] },
    },
  });
  const native = makeResult("https://correct.example");
  const cold = makeResult("https://changed.example");
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, true);
  assert.match(comparison.notes.join(" "), /provider variance/);
});

test("Exa contents keeps its fixed requested URL identity", () => {
  const target = { provider: "exa", tool: "contents", kind: "tool" };
  const makeResult = (url) => makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "exa",
    tool: "contents",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: [{ url, title: "Example", text: "page text" }] },
  });
  const comparison = compareToolTarget(
    target,
    makeResult("https://example.com"),
    makeResult("https://other.example")
  );
  assert.equal(comparison.passed, false);
  assert.equal(
    comparison.checks.find(({ label }) => label === "native and ColdSearch results retain the same requested-page URL identity, including a shared canonical URL").pass,
    false
  );
});

test("Exa contents accepts the same canonical URL from both calls", () => {
  const target = { provider: "exa", tool: "contents", kind: "tool" };
  const makeResult = () => makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "exa",
    tool: "contents",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: [{ url: "https://www.example.com/", title: "Example", text: "page text" }] },
  });
  const comparison = compareToolTarget(target, makeResult(), makeResult());
  assert.equal(comparison.passed, true);
  assert.equal(
    comparison.checks.find(({ label }) => label === "native and ColdSearch results retain the same requested-page URL identity, including a shared canonical URL").pass,
    true
  );
});

test("tool conformance rejects invalid provider result-array item types", () => {
  const target = { provider: "tavily", tool: "map", kind: "tool" };
  const native = makeColdSearchToolResult(target, {
    ok: true,
    raw: { results: ["https://docs.example/a"] },
  });
  const cold = makeColdSearchToolResult(target, {
    ok: true,
    catalogued: true,
    provider: "tavily",
    tool: "map",
    meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
    raw: { results: [{ url: "https://docs.example/a" }] },
  });
  assert.deepEqual(native.raw_sample.result_array_item_types.results, ["string"]);
  assert.deepEqual(cold.raw_sample.result_array_item_types.results, ["object"]);
  const comparison = compareToolTarget(target, native, cold);
  assert.equal(comparison.passed, false);
  assert.equal(
    comparison.checks.find(({ label }) => label === "native and ColdSearch tool result arrays retain expected item types").pass,
    false
  );
});

test("tool conformance checks nested raw schemas when provider result values vary", () => {
  const cases = [
    {
      target: { provider: "brave", tool: "webSearch", kind: "tool" },
      nativeRaw: {
        query: { original: "query" },
        web: { results: [{
          title: "Native result",
          url: "https://native.example",
          description: "provider description",
          profile: { name: "provider profile" },
        }] },
      },
      coldRaw: {
        query: { original: "query" },
        web: { results: [{ title: "Different result", url: "https://cold.example" }] },
      },
    },
    {
      target: { provider: "exa", tool: "contents", kind: "tool" },
      nativeRaw: {
        results: [{
          url: "https://example.com",
          title: "Native title",
          text: "Native content",
          page: { language: "en" },
        }],
      },
      coldRaw: {
        results: [{
          url: "https://example.com",
          title: "ColdSearch title",
          text: "ColdSearch content",
          page: {},
        }],
      },
    },
    {
      target: { provider: "firecrawl", tool: "map", kind: "tool" },
      nativeRaw: {
        success: true,
        metadata: { creditsUsed: 1 },
        links: [{
          url: "https://native.example",
          title: "Native result",
          metadata: { source: "provider catalog" },
        }],
      },
      coldRaw: {
        success: true,
        metadata: { creditsUsed: 1 },
        links: [{ url: "https://cold.example", title: "Different result" }],
      },
    },
  ];

  for (const { target, nativeRaw, coldRaw } of cases) {
    const native = makeColdSearchToolResult(target, { ok: true, raw: nativeRaw });
    const cold = makeColdSearchToolResult(target, {
      ok: true,
      catalogued: true,
      provider: target.provider,
      tool: target.tool,
      meta: { duration_ms: 12, safe_key_ref: null, warnings: [] },
      raw: coldRaw,
    });
    const comparison = compareToolTarget(target, native, cold);
    assert.equal(
      comparison.checks.find(({ label }) => label === "ColdSearch tool output retains populated native fields for overlapping results").pass,
      true,
      targetId(target)
    );
    assert.equal(
      comparison.checks.find(({ label }) => label === "ColdSearch tool result arrays preserve sampled native object schemas").pass,
      false,
      targetId(target)
    );
  }
});

test("raw provider id and status values are omitted from schema-only evidence", () => {
  const secret = "short-provider-key";
  const previous = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = secret;
  try {
    const result = makeColdSearchToolResult(
      { provider: "exa", tool: "contents", kind: "tool" },
      {
        ok: true,
        raw: {
          results: [{ url: "https://example.com", text: "content" }],
          statuses: [{ id: secret, status: secret }],
        },
      }
    );
    const serialized = JSON.stringify(result.raw_sample);
    assert.ok(!serialized.includes(secret));
    assert.equal(result.raw_sample.stable.statuses.items[0].fields.id.type, "string");
    assert.equal(result.raw_sample.stable.statuses.items[0].fields.status.type, "string");
  } finally {
    if (previous === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = previous;
  }
});

test("short credentials are redacted from evidence text without changing row status", () => {
  process.env.TAVILY_API_KEY = "pass";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-short-key-evidence-"));
  const samplesDir = path.join(dir, "samples");
  fs.mkdirSync(samplesDir, { recursive: true });
  try {
    const rows = [{
      provider: "tavily",
      path: "search",
      status: "pass",
      native: {
        sample: [{ snippet: "the provider echoed pass", status: "pass" }],
        authorization: "pass",
        raw_sample: { schema: { type: "object" }, truncated: false },
      },
      coldsearch: { result_count: 1 },
      comparison: { passed: true, notes: [], checks: [], detail_loss: [] },
    }];
    writeEvidence(dir, samplesDir, rows);
    const [persisted] = fs.readFileSync(path.join(dir, "results.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(persisted.status, "pass");
    assert.equal(persisted.provider, "tavily");
    assert.equal(persisted.native.sample[0].snippet, "the provider echoed REDACTED");
    assert.equal(persisted.native.sample[0].status, "pass");
    assert.equal(persisted.native.authorization, "REDACTED");
    assert.equal(persisted.native.raw_sample.schema.type, "object");
    assert.match(fs.readFileSync(path.join(dir, "summary.md"), "utf8"), /\| tavily:search \| pass \|/);
  } finally {
    delete process.env.TAVILY_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogued tools without fixtures remain visible as not_run", () => {
  const row = notRunRow({ provider: "exa", tool: "findSimilar", kind: "tool" });
  assert.equal(row.status, "not_run");
  assert.deepEqual(row.input, { unavailable: "no native conformance fixture" });
});

test("--list shows the full matrix including provider-tool rows without network", () => {
  const result = runScript(["--list"]);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(
    listed.paths.map(({ provider, path }) => `${provider}:${path}`),
    SUPPORTED_PROVIDER_PATHS.map(({ provider, path }) => `${provider}:${path}`)
  );
  assert.deepEqual(
    listed.tools.map(({ provider, tool }) => `${provider}.${tool}`),
    REQUIRED_PROVIDER_TOOLS.map(({ provider, tool }) => `${provider}.${tool}`)
  );
});

test("canary workflow is scheduled/manual-only and never gates PRs", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "canary.yml"),
    "utf8"
  );
  assert.match(workflow, /schedule:/, "scheduled coverage");
  assert.match(workflow, /workflow_dispatch:/, "manual dispatch");
  assert.ok(!/pull_request:/.test(workflow), "no PR trigger");
  assert.ok(!/push:/.test(workflow), "no push trigger");
  // The PIPESTATUS-based run step pins its shell so it cannot silently switch
  // to a non-Bash shell on a different runner image.
  assert.match(workflow, /shell: bash/, "PIPESTATUS step pins shell: bash");
});

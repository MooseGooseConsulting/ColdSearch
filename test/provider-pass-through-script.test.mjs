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
  notRunRow,
  redact,
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
    ["tavily.map", "brave.webSearch", "exa.contents", "firecrawl.map"]
  );
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
    "tavily.map",
  ]);
});

test("--all selection covers the full matrix of paths and tools", () => {
  const targets = selectTargets();
  assert.equal(
    targets.length,
    REQUIRED_PROVIDER_PATHS.length + REQUIRED_PROVIDER_TOOLS.length
  );
  const toolRows = targets.filter((target) => target.kind === "tool");
  assert.deepEqual(
    toolRows.map(targetId),
    REQUIRED_PROVIDER_TOOLS.map(({ provider, tool }) => `${provider}.${tool}`)
  );
});

test("selectTargets rejects unsupported provider tools", () => {
  assert.throws(
    () => selectTargets({ provider: "tavily", tool: "extract" }),
    /No conformance target matches provider=tavily tool=extract/
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
      notRunRow({ provider: "tavily", tool: "map", kind: "tool" }),
    ];
    writeEvidence(dir, samplesDir, rows);
    const lines = fs.readFileSync(path.join(dir, "results.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 2);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      parsed.map((row) => [row.provider, row.tool ?? row.path, row.status]),
      [
        ["tavily", "search", "pass"],
        ["tavily", "map", "not_run"],
      ]
    );
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

test("--list shows the full matrix including provider-tool rows without network", () => {
  const result = runScript(["--list"]);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(
    listed.paths.map(({ provider, path }) => `${provider}:${path}`),
    REQUIRED_PROVIDER_PATHS.map(({ provider, path }) => `${provider}:${path}`)
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
});

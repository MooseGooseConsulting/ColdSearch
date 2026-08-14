import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageRows,
  coverageTotals,
  renderCoverageTable,
} from "../scripts/smoke.mjs";
import {
  REQUIRED_PROVIDER_PATHS,
  REQUIRED_PROVIDER_TOOLS,
} from "../scripts/provider-pass-through.mjs";

function rowId(row) {
  return row.tool
    ? `${row.provider}.${row.tool}`
    : `${row.provider}:${row.path}`;
}

test("smoke coverage table seeds every supported row as not_run", () => {
  const rows = buildCoverageRows();
  assert.equal(
    rows.length,
    REQUIRED_PROVIDER_PATHS.length + REQUIRED_PROVIDER_TOOLS.length
  );
  for (const entry of rows) {
    assert.equal(entry.conformance, "not_run");
    assert.equal(entry.smoke, "not covered");
  }
  const ids = new Set(rows.map((entry) => rowId(entry.row)));
  for (const target of REQUIRED_PROVIDER_PATHS) {
    assert.ok(ids.has(`${target.provider}:${target.path}`));
  }
  for (const target of REQUIRED_PROVIDER_TOOLS) {
    assert.ok(ids.has(`${target.provider}.${target.tool}`));
  }
});

test("smoke coverage table maps check outcomes onto rows", () => {
  const rows = buildCoverageRows([
    { coverage: { provider: "jina", path: "extract" }, status: "pass" },
    { coverage: { provider: "tavily", path: "search" }, status: "skip" },
    { coverage: { provider: "brave", path: "search" }, status: "fail" },
    // checks without a conformance row (e.g. agent mode) do not appear
    { coverage: null, status: "pass" },
  ]);
  const byId = new Map(rows.map((entry) => [rowId(entry.row), entry]));
  assert.equal(byId.get("jina:extract").smoke, "pass");
  assert.equal(byId.get("tavily:search").smoke, "skip");
  assert.equal(byId.get("brave:search").smoke, "fail");
  // smoke-only rows never become a conformance pass, even on smoke success
  assert.equal(byId.get("jina:extract").conformance, "not_run");
  assert.equal(byId.get("brave:search").conformance, "not_run");
});

test("renderCoverageTable labels rows smoke-only and never reports a conformance pass", () => {
  const table = renderCoverageTable([
    { coverage: { provider: "tavily", path: "search" }, status: "pass" },
    { coverage: { provider: "brave", path: "search" }, status: "fail" },
    { coverage: { provider: "searxng", path: "search" }, status: "skip" },
  ]);
  assert.match(table, /smoke-only/, "table carries the explicit smoke-only label");
  assert.match(table, /Conformance/);
  const dataLines = table
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Row"));
  assert.ok(dataLines.length >= REQUIRED_PROVIDER_PATHS.length + REQUIRED_PROVIDER_TOOLS.length);
  for (const line of dataLines) {
    const [rowIdCell, conformance, smoke] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    assert.equal(
      conformance,
      "not_run",
      `every coverage row stays not_run in conformance vocabulary: ${line}`
    );
    assert.ok(
      rowIdCell && smoke,
      `row id and smoke columns are present: ${line}`
    );
  }
  assert.ok(
    dataLines.some((line) => /\| fail \|/.test(line)),
    "failed smoke checks stay visible in the smoke column"
  );
  assert.ok(
    dataLines.some((line) => /\| skip \|/.test(line)),
    "skipped keyed checks stay visible in the smoke column"
  );
});

test("coverage totals reconcile with the rows, one smoke status per inventory entry", () => {
  const totals = coverageTotals([
    { coverage: { provider: "tavily", path: "search" }, status: "pass" },
    { coverage: { provider: "brave", path: "search" }, status: "fail" },
    { coverage: { provider: "searxng", path: "search" }, status: "skip" },
    // checks without a conformance row (e.g. agent mode) must not inflate totals
    { coverage: null, status: "pass" },
  ]);
  const rows = buildCoverageRows([
    { coverage: { provider: "tavily", path: "search" }, status: "pass" },
    { coverage: { provider: "brave", path: "search" }, status: "fail" },
    { coverage: { provider: "searxng", path: "search" }, status: "skip" },
  ]);
  const sum = totals.pass + totals.skip + totals.fail + totals["not covered"];
  assert.equal(
    sum,
    REQUIRED_PROVIDER_PATHS.length + REQUIRED_PROVIDER_TOOLS.length,
    "totals cover every inventory row exactly once"
  );
  assert.equal(totals.pass, rows.filter((r) => r.smoke === "pass").length);
  assert.equal(totals.skip, rows.filter((r) => r.smoke === "skip").length);
  assert.equal(totals.fail, rows.filter((r) => r.smoke === "fail").length);
  assert.equal(totals["not covered"], rows.filter((r) => r.smoke === "not covered").length);
});

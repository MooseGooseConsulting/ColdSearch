#!/usr/bin/env node
/**
 * Live smoke test against real providers.
 *
 * Unlike the offline unit suite (which mocks fetch), this runs the built CLI
 * end-to-end against real provider APIs and asserts the normalized output shape.
 * It is the canary that catches provider drift the mocked tests cannot.
 *
 * - Keyless checks (Jina extract) always run — they exercise the full stack
 *   (config load -> adapter dispatch -> real HTTP -> normalize -> JSON) with no
 *   secrets, so this script is meaningful even before any keys are configured.
 * - Keyed checks run only when their API key env var is present; otherwise they
 *   are skipped (not failed), so the canary is green with zero secrets.
 * - Coverage: search (tavily/brave/exa/serper), extract (jina keyless +
 *   tavily/exa/firecrawl), crawl (tavily), and agent mode (OpenRouter free; optional Isoquant conformance).
 *
 * Exit code is non-zero only when a check that actually ran fails.
 *
 * Usage:
 *   npm run build && node scripts/smoke.mjs
 *   TAVILY_API_KEY=... node scripts/smoke.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

if (!fs.existsSync(cliPath)) {
  console.error(`dist/cli.js not found at ${cliPath} — run "npm run build" first.`);
  process.exit(1);
}

/** Each check: name, the env var it needs (null = keyless), and how to run + assert. */
const CHECKS = [
  {
    name: "jina extract (keyless)",
    requiredEnv: null,
    config: `
[capabilities.extract]
providers = ["jina"]
strategy = "random"

[providers.jina]
[providers.jina.keyPool]
keys = []

[cache]
enabled = false
`,
    args: (cfg) => ["extract", "--config", cfg, "--json", "https://example.com"],
    assert: (out) => {
      assertEqual(out.command, "extract", "command");
      assertEqual(out.provider, "jina", "provider");
      assertOk(out.result && typeof out.result.content === "string" && out.result.content.length > 0, "result.content is non-empty");
      assertEqual(out.result.source, "jina", "result.source");
    },
  },
  searchCheck("tavily", "TAVILY_API_KEY"),
  searchCheck("brave", "BRAVE_API_KEY"),
  searchCheck("exa", "EXA_API_KEY"),
  searchCheck("serper", "SERPER_API_KEY"),
  extractCheck("tavily", "TAVILY_API_KEY", "https://docs.tavily.com"),
  extractCheck("exa", "EXA_API_KEY"),
  extractCheck("firecrawl", "FIRECRAWL_API_KEY"),
  crawlCheck("tavily", "TAVILY_API_KEY"),
  agentCheck("openrouter", "OPENROUTER_API_KEY", "openrouter/free"),
  ...(process.env.COLDSEARCH_SMOKE_ISOQUANT === "true"
    ? [agentCheck("isoquant", "ISOQUANT_API_KEY", "glm-5.3-flash", "medium")]
    : []),
];

function searchCheck(provider, envVar) {
  return {
    name: `${provider} search`,
    requiredEnv: envVar,
    config: `
[capabilities.search]
providers = ["${provider}"]
strategy = "all"

[providers.${provider}]
[providers.${provider}.keyPool]
keys = ["env:${envVar}"]

[cache]
enabled = false
`,
    args: (cfg) => ["search", "--config", cfg, "--json", "--limit", "3", "openai"],
    assert: (out) => {
      assertEqual(out.command, "search", "command");
      assertOk(Array.isArray(out.results) && out.results.length > 0, "results is non-empty array");
      const r = out.results[0];
      for (const field of ["title", "url", "snippet", "score", "source"]) {
        assertOk(field in r, `result has '${field}'`);
      }
      assertOk(typeof r.url === "string" && r.url.startsWith("http"), "result.url is a URL");
      assertOk(typeof r.score === "number", "result.score is a number");
    },
  };
}

function extractCheck(provider, envVar, url = "https://example.com") {
  return {
    name: `${provider} extract`,
    requiredEnv: envVar,
    config: `
[capabilities.extract]
providers = ["${provider}"]
strategy = "random"

[providers.${provider}]
[providers.${provider}.keyPool]
keys = ["env:${envVar}"]

[cache]
enabled = false
`,
    args: (cfg) => ["extract", "--config", cfg, "--json", url],
    assert: (out) => {
      assertEqual(out.command, "extract", "command");
      assertEqual(out.provider, provider, "provider");
      assertOk(out.result && typeof out.result.content === "string" && out.result.content.length > 0, "result.content is non-empty");
      assertEqual(out.result.source, provider, "result.source");
    },
  };
}

function crawlCheck(provider, envVar) {
  return {
    name: `${provider} crawl`,
    requiredEnv: envVar,
    // Use a real multi-page site: example.com crawls to zero pages (single thin page),
    // which is a valid-but-empty API response, not a useful smoke signal.
    timeoutMs: 150000,
    config: `
[capabilities.crawl]
providers = ["${provider}"]
strategy = "random"

[providers.${provider}]
[providers.${provider}.keyPool]
keys = ["env:${envVar}"]

[cache]
enabled = false
`,
    args: (cfg) => ["crawl", "--config", cfg, "--json", "--limit", "3", "https://docs.tavily.com"],
    assert: (out) => {
      assertEqual(out.command, "crawl", "command");
      assertOk(Array.isArray(out.results) && out.results.length > 0, "results is non-empty array");
      const r = out.results[0];
      for (const field of ["url", "title", "content"]) {
        assertOk(field in r, `result has '${field}'`);
      }
      assertOk(typeof r.content === "string" && r.content.length > 0, "result.content is non-empty");
    },
  };
}

function agentCheck(provider, envVar, model, reasoningEffort) {
  return {
    name: `agent research (${provider})`,
    // Requires both the LLM key and TAVILY_API_KEY (the agent's search tool uses tavily).
    requiredEnv: [envVar, "TAVILY_API_KEY"],
    timeoutMs: 120000,
    // Free router is the routine LLM canary; Isoquant is explicit conformance.
    config: `
[capabilities.search]
providers = ["tavily"]
strategy = "all"

[providers.tavily]
[providers.tavily.keyPool]
keys = ["env:TAVILY_API_KEY"]

[cache]
enabled = false
`,
    args: (cfg) => ["--agent", "--llm", provider, "--model", model, ...(reasoningEffort ? ["--reasoning-effort", reasoningEffort] : []), "--config", cfg, "--json", "--max-steps", "2", "--max-sources", "2", "what is the capital of France"],
    assert: (out) => {
      assertEqual(out.mode, "agent", "mode");
      assertOk(typeof out.answer === "string" && out.answer.length > 0, "answer is non-empty");
      assertOk(typeof out.steps === "number", "steps is a number");
    },
  };
}

function assertOk(cond, label) {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`assertion failed: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function runCheck(check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-smoke-"));
  try {
    const cfg = path.join(dir, "config.toml");
    fs.writeFileSync(cfg, check.config.trim(), "utf8");
    const res = spawnSync(process.execPath, [cliPath, ...check.args(cfg)], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: check.timeoutMs ?? 60000,
      env: process.env,
    });
    if (res.status !== 0) {
      throw new Error(`CLI exited ${res.status}: ${(res.stderr || "").trim() || "(no stderr)"}`);
    }
    let out;
    try {
      out = JSON.parse(res.stdout);
    } catch {
      throw new Error(`output was not valid JSON: ${res.stdout.slice(0, 200)}`);
    }
    check.assert(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let passed = 0;
let skipped = 0;
let failed = 0;

for (const check of CHECKS) {
  const requiredEnv = Array.isArray(check.requiredEnv)
    ? check.requiredEnv
    : check.requiredEnv
      ? [check.requiredEnv]
      : [];
  const missingEnv = requiredEnv.find((name) => !process.env[name]);
  if (missingEnv) {
    console.log(`SKIP  ${check.name} (${missingEnv} not set)`);
    skipped++;
    continue;
  }
  try {
    runCheck(check);
    console.log(`PASS  ${check.name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL  ${check.name}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-intent-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir, toml) {
  const p = path.join(dir, "config.toml");
  // Keep execution history hermetic: without an explicit [history] path the
  // CLI would write to the real ~/.config/coldsearch/history.jsonl.
  fs.writeFileSync(
    p,
    `${toml}\n\n[history]\npath = ${JSON.stringify(path.join(dir, "history.jsonl"))}\n`,
    "utf8"
  );
  return p;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const SEARCH_CONFIG = `
[capabilities.search]
providers = ["exa", "tavily"]

[capabilities.extract]
providers = ["tavily"]

[capabilities.crawl]
providers = ["tavily"]

[providers.exa]
[providers.exa.keyPool]
keys = ["k"]

[providers.tavily]
[providers.tavily.keyPool]
keys = ["k"]

[cache]
enabled = false
`.trim();

test("--intent rejects an unknown intent id as a config error", () => {
  const result = runCli(["search", "--intent", "bogus", "hello"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error \(config\): Invalid intent: bogus/);
});

test("--intent rejects a category mismatch as a config error", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(dir, SEARCH_CONFIG);
    const result = runCli(["search", "--intent", "answer", "--config", configPath, "hello"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error \(config\): Invalid intent for 'search'/);
    assert.match(result.stderr, /'answer' backs the 'answer' category/);
  });
});

test("unroutable intent is rejected before network calls and recorded in history", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(dir, SEARCH_CONFIG);
    // No wired extract tool sets the structuredExtraction predicate; this must
    // fail pre-dispatch (no provider contact, no hang).
    const result = runCli([
      "extract",
      "--intent",
      "structured-extraction",
      "--config",
      configPath,
      "https://x.example",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error \(unsupported_capability\)/);
    assert.match(result.stderr, /structured-extraction/);
    assert.match(result.stderr, /required-features-unsatisfied/);
    const history = JSON.parse(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trim());
    assert.equal(history.command, "extract");
    assert.equal(history.outcome, "failed");
    assert.equal(history.options.intent, "structured-extraction");
  });
});

test("intent whose requirements exclude the configured pool is rejected", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["brave"]

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]

[cache]
enabled = false
`.trim()
    );
    const result = runCli([
      "search",
      "--intent",
      "content-backed-retrieval",
      "--config",
      configPath,
      "hello",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error \(unsupported_capability\)/);
    assert.match(result.stderr, /not-in-configured-pool/);
  });
});

test("url-similarity dry-run resolves with the deprecation note rendered", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(dir, SEARCH_CONFIG);
    const result = runCli([
      "search",
      "--intent",
      "url-similarity",
      "--dry-run",
      "--json",
      "--config",
      configPath,
      "https://x.example",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /deprecated upstream/i);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, "dry-run");
    assert.equal(out.intent, "url-similarity");
  });
});

test("default intents label dry-run plans (behavior otherwise unchanged)", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(dir, SEARCH_CONFIG);
    const result = runCli(["search", "--dry-run", "--json", "--config", configPath, "hello"]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.intent, "web-link-search");
    assert.equal(out.require_features, undefined);

    const extracted = runCli([
      "extract",
      "--dry-run",
      "--json",
      "--config",
      configPath,
      "https://x.example",
    ]);
    assert.equal(JSON.parse(extracted.stdout).intent, "known-url-extraction");
  });
});

test("--time-range is only valid with search", () => {
  const result = runCli(["crawl", "--time-range", "day", "https://x.example"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error \(config\): --time-range is only valid with search/);
});

test("code-context dry-run routes to exa only and defaults to five results", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(dir, SEARCH_CONFIG);
    const result = runCli([
      "search",
      "--intent",
      "code-context",
      "--dry-run",
      "--json",
      "--config",
      configPath,
      "React 19 migration guide useActionState ref as prop breaking changes",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.intent, "code-context");
    assert.equal(out.limit, 5);
    assert.deepEqual(out.require_features, ["highlights"]);
    assert.deepEqual(out.providers.map((p) => p.provider), ["exa"]);
    assert.deepEqual(out.providers[0].intent_provider_options, {
      searchType: "lite",
      highlights: true,
      snippetHighlightLines: 2,
    });
    assert.equal(out.estimated_provider_attempts, 1, "tavily is narrowed out by the native-only intent");
  });
});

test("--measure-tokens is rejected outside search --intent code-context", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(dir, SEARCH_CONFIG);
    const result = runCli([
      "search",
      "--measure-tokens",
      "--dry-run",
      "--json",
      "--config",
      configPath,
      "hello",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--measure-tokens is only valid with search --intent code-context/);
  });
});

test("code-context warns when it overrides a configured exa option", () => {
  withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      SEARCH_CONFIG.replace(
        "[providers.exa]\n",
        "[providers.exa]\n[providers.exa.options]\nsearchType = \"deep\"\n"
      )
    );
    // The mock provider endpoint is unreachable, so the call fails after the
    // warning is printed; the warning is what this test is about.
    const result = runCli([
      "search",
      "--intent",
      "code-context",
      "--json",
      "--config",
      configPath,
      "hello",
    ]);
    assert.match(
      result.stderr,
      /Warning: intent 'code-context' sets exa option searchType="lite", overriding configured searchType="deep"/
    );
  });
});

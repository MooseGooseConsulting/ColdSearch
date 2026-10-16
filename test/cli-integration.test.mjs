import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cacheKey } from "../dist/cache/key.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-"));
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

function runCliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code ?? 0, stdout, stderr }));
  });
}

test("cli search returns expected output shape (searxng via local server)", async () => {
  await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/search")) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const payload = {
        results: [{ title: "A", url: "https://a.example", content: "aa", score: 0.9 }],
      };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-"));
      const configPath = writeConfig(
        dir,
        `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "${baseUrl}"

[cache]
enabled = false
`.trim()
      );

      runCliAsync(["search", "--config", configPath, "--json", "hello"])
        .then((result) => {
          server.close(() => {
            try {
              assert.equal(result.status, 0, result.stderr);
              const out = JSON.parse(result.stdout);
              assert.equal(out.command, "search");
              assert.equal(out.query, "hello");
              assert.ok(Array.isArray(out.results));
              assert.deepEqual(out.providers_used, ["searxng"]);
            } catch (e) {
              reject(e);
              return;
            }
            fs.rmSync(dir, { recursive: true, force: true });
            resolve();
          });
        })
        .catch(reject);
    });
  });
});

test("--providers filters provider selection (avoids external provider calls)", () => {
  const result = withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng", "brave"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "http://127.0.0.1:1"

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]

[cache]
enabled = false
`.trim()
    );

    return runCli(["search", "--config", configPath, "--providers", "searxng", "--json", "hello"]);
  });

  // We don't assert success (baseUrl is unreachable), only that the error is about the chosen provider.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /searxng/i);
  assert.doesNotMatch(result.stderr, /brave/i);
});

test("query parser stops at the next flag token", () => {
  const result = withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["brave"]

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]
`.trim()
    );

    return runCli([
      "search",
      "--config",
      configPath,
      "--dry-run",
      "--json",
      "hello world",
      "--limit",
      "3",
    ]);
  });

  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.query_or_url, "hello world");
  assert.equal(out.capability, "search");
});

test("dry-run discloses conditional quota alternatives separately from the initial random selection", () => {
  const result = withTempDir((dir) => {
    const configPath = writeConfig(dir, `
[capabilities.extract]
providers = ["firecrawl", "tavily", "exa"]
strategy = "random"
[providers.firecrawl.keyPool]
keys = ["env:FIRECRAWL_API_KEY"]
[providers.tavily.keyPool]
keys = ["env:TAVILY_API_KEY"]
[providers.exa.keyPool]
keys = ["env:EXA_API_KEY"]
`);
    return runCli(["extract", "--config", configPath, "--dry-run", "--json", "https://x.example"]);
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.providers.length, 1);
  assert.equal(out.estimated_provider_attempts, 1);
  assert.equal(out.max_provider_attempts, 3);
  assert.equal(out.estimated_api_calls, undefined);
  assert.equal(out.max_api_calls, undefined);
  assert.equal(out.quota_fallback_providers.length, 2);
  assert.deepEqual(new Set([out.providers[0].provider, ...out.quota_fallback_providers]), new Set(["firecrawl", "tavily", "exa"]));
});

test("flags after the query positional are still parsed", () => {
  const result = withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["brave"]

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]
`.trim()
    );

    const env = { ...process.env };
    delete env.OPENAI_API_KEY;

    return runCli(
      ["search", "--config", configPath, "topic", "--agent", "--llm", "openai"],
      env
    );
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENAI_API_KEY/i);
});

test("cli errors clearly on missing capability config", () => {
  const result = withTempDir((dir) => {
    const cachePath = path.join(dir, "cache");
    const key = cacheKey("extract", "https://example.com", {});
    const cacheEntryDir = path.join(cachePath, "extract");
    fs.mkdirSync(cacheEntryDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheEntryDir, `${key}.json`),
      JSON.stringify({
        key,
        payload: {
          result: {
            content: "cached content that must not mask missing config",
            url: "https://example.com",
            title: "Cached",
            source: "jina",
          },
          provider: "jina",
        },
        created_at: Date.now(),
        ttl_seconds: 86400,
      }),
      "utf8"
    );

    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "http://127.0.0.1:1"

[cache]
path = "${cachePath.replaceAll("\\", "/")}"
`.trim()
    );

    return runCli(["extract", "--config", configPath, "--json", "https://example.com"]);
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No configuration found for capability: extract/i);
});

// ---------------------------------------------------------------------------
// config init / config doctor / status
// ---------------------------------------------------------------------------

test("config init creates a starter config at a temp path", () => {
  withTempDir((dir) => {
    const target = path.join(dir, "config.toml");
    const result = runCli(["config", "init", "--config", target]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(target), "config file must exist");
    const content = fs.readFileSync(target, "utf8");
    assert.match(content, /\[capabilities\.search\]/);
    assert.match(content, /\[capabilities\.extract\]/);
    assert.match(content, /\[capabilities\.crawl\]/);
  });
});

test("config init refuses to overwrite an existing config", () => {
  withTempDir((dir) => {
    const target = path.join(dir, "config.toml");
    fs.writeFileSync(target, 'original = true\n', "utf8");
    const result = runCli(["config", "init", "--config", target]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/i);
    assert.equal(fs.readFileSync(target, "utf8"), 'original = true\n');
  });
});

test("config init --config with a missing or flag value fails clearly", () => {
  const flagResult = runCli(["config", "init", "--config", "--json"]);
  assert.equal(flagResult.status, 1);
  assert.match(flagResult.stderr, /missing value for --config/i);

  const shortFlagResult = runCli(["config", "init", "--config", "-j"]);
  assert.equal(shortFlagResult.status, 1);
  assert.match(shortFlagResult.stderr, /missing value for --config/i);
  assert.ok(!fs.existsSync(path.join(repoRoot, "-j")), "no short-flag-named file written");

  const missingResult = runCli(["config", "init", "--config"]);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /missing value for --config/i);
  assert.ok(!fs.existsSync(path.join(repoRoot, "--json")), "no flag-named file written");
});

test("config doctor does not leak TOML parse-error source excerpts", () => {
  const { result } = withTempDir((dir) => {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      '[providers.tavily]\n[providers.tavily.keyPool]\nkeys = ["sk-fake-secret-xyz" oops]\n',
      "utf8"
    );
    return { result: runCli(["config", "doctor", "--config", configPath, "--json"]) };
  });

  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /sk-fake-secret-xyz/);
  // Position survives sanitization (line of the malformed entry) without the
  // source excerpt.
  assert.match(output, /line 3/);
});

test("config doctor --json reports valid config success", () => {
  const { result, configPath } = withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "https://search.example.internal"
`.trim()
    );
    return { result: runCli(["config", "doctor", "--config", configPath, "--json"]), configPath };
  });

  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.command, "config doctor");
  assert.equal(out.config_path, configPath);
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
  assert.ok(Array.isArray(out.warnings));
});

test("config doctor --json reports missing env vars without printing secret values", () => {
  const { result } = withTempDir((dir) => {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["brave", "tavily"]

[providers.brave]
[providers.brave.keyPool]
keys = ["env:COLDSEARCH_TEST_UNSET_VAR"]

[providers.tavily]
[providers.tavily.keyPool]
keys = ["sk-literal-secret-abc123"]
`.trim()
    );
    const env = { ...process.env };
    delete env.COLDSEARCH_TEST_UNSET_VAR;
    return { result: runCli(["config", "doctor", "--config", configPath, "--json"], env) };
  });

  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.valid, true);
  const warnings = out.warnings.map((w) => `${w.category}: ${w.message}`).join("\n");
  // The unset env var NAME is reported…
  assert.match(warnings, /COLDSEARCH_TEST_UNSET_VAR/);
  // …the raw literal key is flagged…
  assert.match(warnings, /raw literal/);
  // …but the secret VALUE is never echoed anywhere.
  assert.doesNotMatch(result.stdout + result.stderr, /sk-literal-secret-abc123/);
});

test("missing --llm-key-ref is reported as a config error", () => {
  const result = runCli(["search", "--agent", "--llm-key-ref"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Error \(config\): --llm-key-ref requires/);
});

test("invalid --reasoning-effort is reported as a config error", () => {
  const result = runCli(["search", "--agent", "--reasoning-effort", "turbo", "query"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Error \(config\): Invalid reasoning effort/);
});

test("--depth rejects missing, blank, fractional, negative, and trailing-junk values", () => {
  for (const depthArgs of [
    ["--depth"],
    ["--depth", ""],
    ["--depth", "1.5"],
    ["--depth", "-1"],
    ["--depth", "2pages"],
  ]) {
    const result = runCli(["crawl", ...depthArgs, "https://example.com"]);
    assert.equal(result.status, 1, JSON.stringify(depthArgs));
    assert.match(result.stderr, /^Error \([^)]*\): Invalid depth:/);
  }
});

test("status --json includes the config path", () => {
  const { result, configPath } = withTempDir((dir) => {
    const usagePath = path.join(dir, "usage.jsonl").replaceAll("\\", "/");
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "https://search.example.internal"

[logging.usage]
path = "${usagePath}"
`.trim()
    );
    return { result: runCli(["status", "--config", configPath, "--json"]), configPath };
  });

  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.command, "status");
  assert.equal(out.config_path, configPath);
});

test("status --json includes cache state and usage path", () => {
  const { result, cachePath, usagePath } = withTempDir((dir) => {
    const cachePath = path.join(dir, "cache").replaceAll("\\", "/");
    const usagePath = path.join(dir, "usage.jsonl").replaceAll("\\", "/");
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "https://search.example.internal"

[cache]
path = "${cachePath}"

[logging.usage]
path = "${usagePath}"
`.trim()
    );
    return {
      result: runCli(["status", "--config", configPath, "--json"]),
      cachePath,
      usagePath,
    };
  });

  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.cache.enabled, true);
  assert.equal(out.cache.path, cachePath);
  assert.equal(out.usage_log, usagePath);
});

// ---------------------------------------------------------------------------
// agent mode: run IDs (PR 5)
// ---------------------------------------------------------------------------

/** Start a mock OpenAI-compatible /chat/completions server with canned replies. */
function startLlmServer(responses, { failAt } = {}) {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (callCount === failAt) {
        callCount += 1;
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "synthetic completion failure" } }));
        return;
      }
      const content = responses[Math.min(callCount, responses.length - 1)];
      callCount += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/** Start a mock SearXNG JSON endpoint. */
function startSearxngServer() {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/search")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const payload = {
      results: [
        { title: "Result A", url: "https://a.example", content: "content a", score: 0.9 },
        { title: "Result B", url: "https://b.example", content: "content b", score: 0.7 },
      ],
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("agent mode: --run-id threads through output, usage log, and history", async () => {
  const llm = await startLlmServer([
    JSON.stringify({ type: "tool", tool: "search", args: ["fake-provider-key-in-agent-step"] }),
    JSON.stringify({ type: "final", answer: "research complete" }),
  ]);
  const searxng = await startSearxngServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-"));
  try {
    const usagePath = path.join(dir, "usage.jsonl");
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = ["env:SEARXNG_AGENT_TEST_KEY"]

[providers.searxng.options]
baseUrl = "${searxng.baseUrl}"

[cache]
enabled = false

[logging.usage]
path = "${usagePath.replaceAll("\\", "/")}"
`.trim()
    );

    const env = { ...process.env, OPENAI_API_KEY: "fake-openai-key-pr5" };
    env.SEARXNG_AGENT_TEST_KEY = "fake-provider-key-in-agent-step";
    const result = await runCliAsync(
      [
        "--agent",
        "--llm",
        "openai",
        "--run-id",
        "  run_cli_test_123  ",
        "--llm-base-url",
        llm.baseUrl,
        "--config",
        configPath,
        "--json",
        "test research goal",
      ],
      env
    );

    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, "agent");
    assert.equal(out.run_id, "run_cli_test_123");
    // CLI output stays compact; the complete step trace is persisted in the
    // agent execution record and correlated with provider history by run_id.
    assert.equal(typeof out.steps, "number");

    const usageLines = fs
      .readFileSync(usagePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(usageLines.length > 0, "agent-triggered search wrote usage entries");
    for (const line of usageLines) {
      const entry = JSON.parse(line);
      assert.equal(entry.run_id, "run_cli_test_123");
      // Safe agent/tool-flow metadata: provider, capability, timing, outcome.
      assert.equal(entry.provider, "searxng");
      assert.equal(entry.capability, "search");
      assert.equal(typeof entry.response_time_ms, "number");
      assert.equal(typeof entry.success, "boolean");
      assert.equal(entry.key, "env:SEARXNG_AGENT_TEST_KEY");
    }

    const historyText = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8");
    const historyLines = historyText
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(historyLines.length > 0, "agent-triggered search wrote history records");
    const historyRecords = historyLines.map((line) => JSON.parse(line));
    for (const record of historyRecords) {
      assert.equal(record.run_id, "run_cli_test_123");
      assert.equal(record.source, "live");
      assert.equal(typeof record.duration_ms, "number");
    }
    const providerSearch = historyRecords.find((record) => record.command === "search");
    assert.deepEqual(providerSearch.routing.providers_attempted, ["searxng"]);
    const agentRecord = historyRecords.find((record) => record.command === "agent");
    assert.ok(agentRecord, "agent run wrote its own durable history record");
    assert.equal(agentRecord.agent_steps.length, out.steps);
    assert.ok(agentRecord.agent_steps.length > 0);
    assert.ok(agentRecord.agent_steps.every((step) => step.run_id === "run_cli_test_123"));
    assert.ok(agentRecord.agent_steps.every((step) => step.outcome === "success"));
    assert.ok(agentRecord.agent_steps.every((step) => typeof step.duration_ms === "number"));
    assert.equal(agentRecord.result_count, out.sources.length);

    const recent = JSON.parse(
      runCli(["history", "recent", "--config", configPath, "--json"]).stdout
    );
    const recentAgent = recent.executions.find((entry) => entry.command === "agent");
    assert.equal(recentAgent.run_id, "run_cli_test_123");
    assert.equal(recentAgent.agent_step_count, agentRecord.agent_steps.length);

    const byRunId = JSON.parse(
      runCli(["history", "search", "--config", configPath, "--json", "run_cli_test_123"]).stdout
    );
    const matchedAgent = byRunId.matches.find((entry) => entry.execution.command === "agent");
    assert.ok(matchedAgent);
    assert.ok(matchedAgent.matched_on.includes("run_id"));

    const shownAgent = JSON.parse(
      runCli(["history", "show", agentRecord.id, "--config", configPath, "--json"]).stdout
    );
    assert.equal(shownAgent.agent_steps.length, agentRecord.agent_steps.length);

    // No raw credential value anywhere in output or logs.
    const allOutput = result.stdout + result.stderr + fs.readFileSync(usagePath, "utf8") + historyText;
    assert.doesNotMatch(allOutput, /fake-openai-key-pr5|fake-provider-key-in-agent-step/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    llm.server.close();
    searxng.server.close();
  }
});

test("agent mode: generated run_id when --run-id is absent", async () => {
  const llm = await startLlmServer([
    JSON.stringify({ type: "tool", tool: "search", args: ["goal"] }),
    JSON.stringify({ type: "final", answer: "done" }),
  ]);
  const searxng = await startSearxngServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-"));
  try {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "${searxng.baseUrl}"

[cache]
enabled = false
`.trim()
    );

    const env = { ...process.env, OPENAI_API_KEY: "fake-openai-key-pr5" };
    const result = await runCliAsync(
      ["--agent", "--llm", "openai", "--llm-base-url", llm.baseUrl, "--config", configPath, "--json", "goal"],
      env
    );

    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.match(out.run_id, /^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    llm.server.close();
    searxng.server.close();
  }
});

test("agent mode: generated run_id is included when a later LLM request fails", async () => {
  const llm = await startLlmServer(
    [JSON.stringify({ type: "tool", tool: "search", args: ["goal"] })],
    { failAt: 1 }
  );
  const searxng = await startSearxngServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-agent-failure-"));
  try {
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "${searxng.baseUrl}"

[cache]
enabled = false
`.trim()
    );
    const result = await runCliAsync(
      ["--agent", "--llm", "openai", "--llm-base-url", llm.baseUrl, "--config", configPath, "--json", "goal"],
      { OPENAI_API_KEY: "fake-openai-key-pr5" }
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^Error \(network\): OpenAI completion failed with HTTP 500 \(run_id=run_/,
      "the original HTTPRequestError status controls classification after the run ID is appended"
    );
    assert.ok(!result.stderr.includes("synthetic completion failure"), "provider response body stays out of public error text");
    const runId = result.stderr.match(/run_id=(run_[\dTZ_a-f]+)/)?.[1];
    assert.ok(runId, "failure output includes the generated run ID");
    const history = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8");
    assert.match(history, new RegExp(`\\"run_id\\":\\"${runId}\\"`));
    const records = history.trim().split("\n").map((line) => JSON.parse(line));
    const failedAgent = records.find((record) => record.command === "agent");
    assert.ok(failedAgent, "failed agent run is persisted");
    assert.equal(failedAgent.outcome, "failed");
    assert.equal(failedAgent.agent_steps.length, 1);
    assert.equal(failedAgent.agent_steps[0].outcome, "success");
    assert.equal(failedAgent.result_count, 0);
    assert.equal(failedAgent.errors.agent, "OpenAI completion failed with HTTP 500");
    assert.ok(!history.includes("synthetic completion failure"), "raw provider response body is not persisted in public history");
    const shownFailure = runCli([
      "history", "show", failedAgent.id, "--config", configPath,
    ]);
    assert.match(shownFailure.stdout, /search success \(\d+ms\):/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    llm.server.close();
    searxng.server.close();
  }
});

test("non-agent usage entries remain valid without run_id", async () => {
  const searxng = await startSearxngServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-"));
  try {
    const usagePath = path.join(dir, "usage.jsonl");
    const configPath = writeConfig(
      dir,
      `
[capabilities.search]
providers = ["searxng"]

[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "${searxng.baseUrl}"

[cache]
enabled = false

[logging.usage]
path = "${usagePath.replaceAll("\\", "/")}"
`.trim()
    );

    const result = await runCliAsync(["search", "--config", configPath, "--json", "hello"]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    // Non-agent output contract unchanged.
    assert.equal(out.command, "search");
    assert.ok(Array.isArray(out.results));
    assert.deepEqual(out.providers_used, ["searxng"]);
    assert.equal(out.run_id, undefined);

    const usageLines = fs
      .readFileSync(usagePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(usageLines.length > 0);
    for (const line of usageLines) {
      const entry = JSON.parse(line);
      assert.equal(entry.run_id, undefined, "non-agent usage entry has no run_id");
      assert.equal(typeof entry.response_time_ms, "number");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    searxng.server.close();
  }
});

test("--run-id rejects empty and whitespace-only values early", () => {
  const whitespace = runCli(["--agent", "--run-id", "   ", "--json", "goal"]);
  assert.equal(whitespace.status, 1);
  assert.match(whitespace.stderr, /invalid --run-id/i);

  // A flag-looking token after --run-id means the value was omitted.
  const flagAsValue = runCli(["--agent", "--run-id", "--json", "goal"]);
  assert.equal(flagAsValue.status, 1);
  assert.match(flagAsValue.stderr, /invalid --run-id/i);

  const missing = runCli(["--agent", "--run-id"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /invalid --run-id/i);

  for (const unsafeId of ["run_forged\nrow", "run_terminal\u001b[31m"]) {
    const unsafe = runCli(["--agent", "--run-id", unsafeId, "--json", "goal"]);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /Error \(config\): Invalid --run-id/i);
    assert.ok(!unsafe.stderr.includes("forged"));
  }
});

test("--run-id rejects higher-priority commands even when --agent is set", () => {
  const result = runCli(["history", "recent", "--agent", "--run-id", "run_x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /higher-priority command/i);
});

test("--run-id is rejected outside agent mode", () => {
  // Run IDs are agent-mode only; non-agent commands silently ignore the ID,
  // so accepting it there would mislead scripts into trusting correlation
  // that never happens.
  for (const args of [
    ["--run-id", "run_non_agent", "--json", "goal"],
    ["search", "--run-id", "run_non_agent", "--json", "goal"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--run-id requires agent mode/i);
    assert.match(result.stderr, /Error \(config\)/);
  }
});

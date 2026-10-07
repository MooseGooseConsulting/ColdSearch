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
  assert.match(output, /row 3/);
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

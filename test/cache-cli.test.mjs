import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** One temp root per test holds cache/, outside-history/, history.jsonl, config.toml. */
function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-cache-cli-"));
}

function cleanup(root) {
  const resolved = fs.realpathSync(root);
  assert.ok(
    resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) &&
      resolved.includes("coldsearch-cache-cli-"),
    `refusing to remove ${resolved}: outside the task temp root`
  );
  fs.rmSync(resolved, { recursive: true, force: true });
}

function writeConfig(root, cachePath, baseUrl = "http://127.0.0.1:1") {
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "[capabilities.search]",
      'providers = ["searxng"]',
      "[providers.searxng]",
      "[providers.searxng.keyPool]",
      "keys = []",
      "[providers.searxng.options]",
      `baseUrl = ${JSON.stringify(baseUrl)}`,
      "[cache]",
      "enabled = true",
      `path = ${JSON.stringify(cachePath)}`,
      "[history]",
      `path = ${JSON.stringify(path.join(root, "history.jsonl"))}`,
      "",
    ].join("\n"),
    "utf8"
  );
  return configPath;
}

function runCli(args) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], { cwd: repoRoot, encoding: "utf8" });
}

function runCliAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const entry = (overrides = {}) =>
  JSON.stringify({ key: "k", payload: { ok: true }, created_at: Date.now() - 1000, ttl_seconds: 3600, ...overrides });

test("cache stats/clear --json: linked capability dir is not read or deleted; exit 0; history untouched", () => {
  const root = makeRoot();
  try {
    const cache = path.join(root, "cache");
    const outside = path.join(root, "outside-history");
    fs.mkdirSync(path.join(cache, "extract"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(cache, "extract", "own.json"), entry(), "utf8");
    fs.writeFileSync(path.join(outside, "preserve.json"), entry({ key: "external" }), "utf8");
    fs.symlinkSync(outside, path.join(cache, "search"), process.platform === "win32" ? "junction" : "dir");
    const historyBefore = '{"id":"exec-1"}\n';
    fs.writeFileSync(path.join(root, "history.jsonl"), historyBefore, "utf8");
    const configPath = writeConfig(root, cache);

    const stats = runCli(["cache", "stats", "--config", configPath, "--json"]);
    assert.equal(stats.status, 0, stats.stderr);
    const statsOut = JSON.parse(stats.stdout);
    assert.equal(statsOut.command, "cache stats");
    assert.equal(statsOut.path, cache);
    assert.equal(statsOut.total_entries, 1, "external entry is not counted");
    assert.deepEqual(Object.keys(statsOut.capabilities), ["extract"]);
    assert.equal(statsOut.corrupt_entries, 0);
    assert.equal(statsOut.skipped.length, 1);
    assert.match(statsOut.skipped[0], /^search: linked directory/);

    const human = runCli(["cache", "clear", "--config", configPath]);
    // Human mode first (it clears the owned entry), then re-seed for the JSON run.
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Removed 1 replay-cache entry\. \(1 non-owned path\(s\) left untouched\)/);
    assert.match(human.stderr, /left untouched: search: linked directory/);

    fs.writeFileSync(path.join(cache, "extract", "again.json"), entry(), "utf8");
    const cleared = runCli(["cache", "clear", "--config", configPath, "--json"]);
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.equal(cleared.stderr, "", "--json keeps stderr quiet");
    const clearOut = JSON.parse(cleared.stdout);
    assert.equal(clearOut.command, "cache clear");
    assert.equal(clearOut.removed, 1, "removed counts only the owned entry");
    assert.equal(clearOut.errors, undefined);
    assert.equal(clearOut.skipped.length, 1);

    assert.ok(fs.existsSync(path.join(outside, "preserve.json")), "external file survives");
    assert.equal(fs.readdirSync(path.join(cache, "extract")).length, 0);
    assert.equal(fs.readFileSync(path.join(root, "history.jsonl"), "utf8"), historyBefore);
  } finally {
    cleanup(root);
  }
});

test("cache stats --json survives corrupt/overflow metadata and reports it", () => {
  const root = makeRoot();
  try {
    const cache = path.join(root, "cache");
    fs.mkdirSync(path.join(cache, "search"), { recursive: true });
    fs.writeFileSync(
      path.join(cache, "search", "bad.json"),
      '{"key":"bad","payload":{},"created_at":1e999,"ttl_seconds":60}',
      "utf8"
    );
    fs.writeFileSync(path.join(cache, "search", "ok.json"), entry(), "utf8");
    fs.writeFileSync(path.join(cache, "search", "junk.json"), "{ nope", "utf8");

    const stats = runCli(["cache", "stats", "--config", writeConfig(root, cache), "--json"]);
    assert.equal(stats.status, 0, stats.stderr);
    const out = JSON.parse(stats.stdout);
    assert.equal(out.total_entries, 3);
    assert.equal(out.corrupt_entries, 2);
    assert.equal(out.expired_entries, 0);
    assert.ok(out.oldest_created_at && out.newest_created_at, "valid entry still supplies timestamps");

    const human = runCli(["cache", "stats", "--config", writeConfig(root, cache)]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Corrupt: 2 entries unreadable or with invalid metadata/);
  } finally {
    cleanup(root);
  }
});

test("cache stats/clear against a cache path that is a file fail visibly with exit 1", () => {
  const root = makeRoot();
  try {
    const cache = path.join(root, "cache-is-a-file");
    fs.writeFileSync(cache, "not a directory", "utf8");
    const configPath = writeConfig(root, cache);
    for (const sub of ["stats", "clear"]) {
      const result = runCli(["cache", sub, "--config", configPath, "--json"]);
      assert.equal(result.status, 1, `${sub} must fail`);
      assert.match(result.stderr, /Error/i);
    }
    assert.equal(fs.readFileSync(cache, "utf8"), "not a directory");
  } finally {
    cleanup(root);
  }
});

test("end to end: an entry with nonfinite created_at is never replayed; the call goes live", async () => {
  const root = makeRoot();
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ results: [{ title: "Live", url: "https://live.example/1", content: "live" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cache = path.join(root, "cache");
    const configPath = writeConfig(root, cache, `http://127.0.0.1:${server.address().port}`);
    const args = ["search", "--config", configPath, "--json", "nonfinite replay probe"];

    const first = await runCliAsync(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(requests, 1, "first call is live");

    const second = await runCliAsync(args);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(requests, 1, "control: a valid fresh entry is replayed without a provider call");

    // Corrupt the stored timing the same way the parent reproduction did.
    const file = path.join(cache, "search", fs.readdirSync(path.join(cache, "search"))[0]);
    const tampered = fs.readFileSync(file, "utf8").replace(/"created_at":\d+/, '"created_at":1e999');
    assert.match(tampered, /"created_at":1e999/);
    fs.writeFileSync(file, tampered, "utf8");

    const third = await runCliAsync(args);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(requests, 2, "corrupt metadata is a miss: the provider is called live");

    const sources = fs
      .readFileSync(path.join(root, "history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).source);
    assert.deepEqual(sources, ["live", "cache", "live"]);
    assert.match(fs.readFileSync(file, "utf8"), /"created_at":\d+,/, "live result rewrote a valid entry");
  } finally {
    server.close();
    cleanup(root);
  }
});

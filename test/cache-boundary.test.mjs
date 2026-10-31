import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CacheStore } from "../dist/cache/cache.js";

/**
 * Cache ownership + metadata hardening. Every fixture lives under ONE temp
 * root (cache/ + sibling outside-history/ + other-data/), so even a bug that
 * followed a link could only touch that root, and cleanup is confined to it.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "coldsearch-cache-boundary-"));
  const cache = join(root, "cache");
  const outside = join(root, "outside-history");
  const other = join(root, "other-data");
  for (const dir of [cache, outside, other]) mkdirSync(dir);
  return { root, cache, outside, other };
}

function cleanup(root) {
  const resolved = realpathSync(root);
  assert.ok(
    resolved.startsWith(realpathSync(tmpdir()) + sep) && resolved.includes("coldsearch-cache-boundary-"),
    `refusing to remove ${resolved}: outside the task temp root`
  );
  rmSync(resolved, { recursive: true, force: true });
}

/** A junction on Windows (no privilege needed) and a dir symlink elsewhere. */
function linkDir(target, link) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function validEntry(overrides = {}) {
  return JSON.stringify({
    key: "k",
    payload: { ok: true },
    created_at: Date.now() - 1000,
    ttl_seconds: 3600,
    ...overrides,
  });
}

function put(dir, capability, name, body) {
  mkdirSync(join(dir, capability), { recursive: true });
  writeFileSync(join(dir, capability, name), body, "utf8");
}

test("linked capability directory: stats does not read it and clear does not delete through it", () => {
  const { root, cache, outside, other } = fixture();
  try {
    put(cache, "extract", "own.json", validEntry());
    writeFileSync(join(outside, "preserve.json"), validEntry({ key: "external" }), "utf8");
    writeFileSync(join(other, "unrelated.json"), "{}", "utf8");
    linkDir(outside, join(cache, "search"));

    const store = new CacheStore({ path: cache });
    const stats = store.stats();
    assert.equal(stats.total_entries, 1, "only the owned extract entry is counted");
    assert.deepEqual(Object.keys(stats.capabilities), ["extract"]);
    assert.equal(stats.skipped.length, 1);
    assert.match(stats.skipped[0], /^search: linked directory/);

    const result = store.clear();
    assert.equal(result.removed, 1, "removed counts only the owned entry");
    assert.deepEqual(result.errors, []);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /^search: linked directory/);

    assert.ok(existsSync(join(outside, "preserve.json")), "external file survives clear");
    assert.ok(existsSync(join(other, "unrelated.json")));
    assert.equal(readdirSync(join(cache, "extract")).length, 0, "owned entry was cleared");
  } finally {
    cleanup(root);
  }
});

test("linked capability directory: request path neither reads nor writes through it", () => {
  const { root, cache, outside } = fixture();
  try {
    const key = "a".repeat(64);
    writeFileSync(join(outside, `${key}.json`), validEntry({ payload: { leaked: true } }), "utf8");
    linkDir(outside, join(cache, "search"));
    const store = new CacheStore({ path: cache });

    assert.equal(store.get("search", key), null, "external entry is not replayed");
    store.set("search", "b".repeat(64), { written: 1 }, 60);
    assert.deepEqual(readdirSync(outside), [`${key}.json`], "nothing written outside the root");
  } finally {
    cleanup(root);
  }
});

test("linked entry file: skipped by stats/clear/get and its target survives", (t) => {
  const { root, cache, outside } = fixture();
  try {
    const target = join(outside, "external-entry.json");
    writeFileSync(target, validEntry({ key: "external" }), "utf8");
    mkdirSync(join(cache, "search"));
    try {
      symlinkSync(target, join(cache, "search", "linked.json"), "file");
    } catch (error) {
      if (error.code === "EPERM") return t.skip(`file symlink needs privilege on this host: ${error.code}`);
      throw error;
    }
    put(cache, "search", "own.json", validEntry());

    const store = new CacheStore({ path: cache });
    assert.equal(store.get("search", "linked"), null);
    const stats = store.stats();
    assert.equal(stats.total_entries, 1);
    assert.match(stats.skipped.join("\n"), /search\/linked\.json: linked or non-regular/);

    const result = store.clear();
    assert.equal(result.removed, 1);
    assert.match(result.skipped.join("\n"), /search\/linked\.json/);
    assert.ok(existsSync(target), "link target survives");
    assert.ok(existsSync(join(cache, "search", "linked.json")), "the link itself is left in place");
  } finally {
    cleanup(root);
  }
});

test("directory symlink (not junction) is also not followed", (t) => {
  const { root, cache, outside } = fixture();
  try {
    writeFileSync(join(outside, "preserve.json"), validEntry(), "utf8");
    try {
      symlinkSync(outside, join(cache, "tool"), "dir");
    } catch (error) {
      if (error.code === "EPERM") return t.skip(`dir symlink needs privilege on this host: ${error.code}`);
      throw error;
    }
    const store = new CacheStore({ path: cache });
    assert.equal(store.stats().total_entries, 0);
    assert.equal(store.clear().removed, 0);
    assert.ok(existsSync(join(outside, "preserve.json")));
  } finally {
    cleanup(root);
  }
});

test("a non-regular entry (directory named *.json) is skipped, not deleted or counted", () => {
  const { root, cache } = fixture();
  try {
    mkdirSync(join(cache, "search", "bad.json"), { recursive: true });
    writeFileSync(join(cache, "search", "bad.json", "inner.txt"), "keep", "utf8");
    put(cache, "search", "own.json", validEntry());

    const store = new CacheStore({ path: cache });
    const stats = store.stats();
    assert.equal(stats.total_entries, 1);
    assert.match(stats.skipped.join("\n"), /search\/bad\.json/);

    const result = store.clear();
    assert.equal(result.removed, 1);
    assert.deepEqual(result.errors, []);
    assert.ok(existsSync(join(cache, "search", "bad.json", "inner.txt")));
  } finally {
    cleanup(root);
  }
});

test("invalid timing metadata: stats never throws and getEntry misses", () => {
  const { root, cache } = fixture();
  try {
    const now = Date.now();
    const raw = (created, ttl) =>
      `{"key":"k","payload":{"ok":true},"created_at":${created},"ttl_seconds":${ttl}}`;
    const corrupt = {
      "overflow-created": raw("1e999", 60), // parses to Infinity
      "negative-overflow-created": raw("-1e999", 60),
      "overflow-ttl": raw(now, "1e999"),
      "date-range-created": raw("8640000000000001", 60), // 1ms past the Date range
      "negative-ttl": raw(now, -5),
      "string-created": raw('"now"', 60),
      "null-doc": "null",
      "array-doc": "[]",
      "malformed-json": "{ not valid json",
    };
    for (const [name, body] of Object.entries(corrupt)) put(cache, "search", `${name}.json`, body);
    put(cache, "search", "fresh.json", raw(now - 1000, 3600));
    put(cache, "search", "expired.json", raw(now - 10_000_000, 1));
    put(cache, "search", "zero-ttl.json", raw(now - 1000, 0));

    const store = new CacheStore({ path: cache });
    for (const name of Object.keys(corrupt)) {
      assert.equal(store.getEntry("search", name), null, `${name} must be a miss`);
    }
    // Normal, expired, and zero-TTL entries stay readable: freshness is the caller's call.
    for (const name of ["fresh", "expired", "zero-ttl"]) {
      assert.ok(store.getEntry("search", name), `${name} stays readable`);
    }
    assert.equal(store.getEntry("search", "zero-ttl").meta.ttl_seconds, 0);

    const stats = store.stats();
    assert.equal(stats.total_entries, 12, "corrupt files still count as stored material");
    assert.equal(stats.corrupt_entries, Object.keys(corrupt).length);
    assert.equal(stats.expired_entries, 2, "expired + zero-ttl");
    assert.equal(new Date(stats.oldest_created_at).getTime(), now - 10_000_000);
    assert.equal(new Date(stats.newest_created_at).getTime(), now - 1000);
    assert.deepEqual(stats.skipped, []);

    assert.equal(store.clear().removed, 12, "corrupt entries are owned and cleared");
  } finally {
    cleanup(root);
  }
});

test("stats with only corrupt entries reports null timestamps instead of throwing", () => {
  const { root, cache } = fixture();
  try {
    put(cache, "search", "bad.json", '{"key":"bad","payload":{},"created_at":1e999,"ttl_seconds":60}');
    const stats = new CacheStore({ path: cache }).stats();
    assert.equal(stats.total_entries, 1);
    assert.equal(stats.corrupt_entries, 1);
    assert.equal(stats.oldest_created_at, null);
    assert.equal(stats.newest_created_at, null);
  } finally {
    cleanup(root);
  }
});

test("failed writes stay best-effort and leave no tmp file behind", () => {
  const { root, cache } = fixture();
  try {
    const store = new CacheStore({ path: cache });
    const key = "c".repeat(64);

    // Target path occupied by a directory: the final rename fails.
    mkdirSync(join(cache, "search", `${key}.json`), { recursive: true });
    assert.doesNotThrow(() => store.set("search", key, { a: 1 }, 60));
    assert.deepEqual(readdirSync(join(cache, "search")), [`${key}.json`], "tmp file cleaned up");

    // Capability path occupied by a regular file: mkdir/write cannot proceed.
    writeFileSync(join(cache, "tool"), "not a dir", "utf8");
    assert.doesNotThrow(() => store.set("tool", key, { a: 1 }, 60));
    assert.equal(readFileSync(join(cache, "tool"), "utf8"), "not a dir");

    // Normal writes are still atomic and readable.
    store.set("extract", key, { a: 2 }, 60, { originExecutionId: "exec-1" });
    assert.equal(store.getEntry("extract", key).meta.origin_execution_id, "exec-1");
    assert.deepEqual(readdirSync(join(cache, "extract")), [`${key}.json`]);
  } finally {
    cleanup(root);
  }
});

test("an intentionally symlinked cache root keeps working", () => {
  const { root, cache, outside } = fixture();
  try {
    const realRoot = join(outside, "real-cache");
    mkdirSync(realRoot);
    rmSync(cache, { recursive: true });
    linkDir(realRoot, cache);

    const store = new CacheStore({ path: cache });
    const key = "d".repeat(64);
    store.set("search", key, { ok: 1 }, 60);
    assert.deepEqual(store.get("search", key), { ok: 1 });
    assert.equal(store.stats().total_entries, 1);
    assert.equal(store.clear().removed, 1);
    assert.deepEqual(readdirSync(join(realRoot, "search")), []);
  } finally {
    cleanup(root);
  }
});

test("missing cache root: stats and clear report empty, with the additive fields", () => {
  const { root, cache } = fixture();
  try {
    const store = new CacheStore({ path: join(cache, "does-not-exist") });
    const stats = store.stats();
    assert.equal(stats.total_entries, 0);
    assert.equal(stats.corrupt_entries, 0);
    assert.deepEqual(stats.skipped, []);
    assert.deepEqual(store.clear(), { removed: 0, errors: [], skipped: [] });
  } finally {
    cleanup(root);
  }
});

test("set() leaves live and dangling linked entry targets alone; owned writes still work", (t) => {
  const { root, cache, outside } = fixture();
  try {
    const victim = join(outside, "preserve.json");
    const missing = join(outside, "missing.json");
    writeFileSync(victim, "PRESERVE_OUTSIDE_CACHE", "utf8");
    mkdirSync(join(cache, "search"));
    const live = join(cache, "search", "live.json");
    const dangling = join(cache, "search", "dangling.json");
    try {
      symlinkSync(victim, live, "file");
      symlinkSync(missing, dangling, "file");
    } catch (error) {
      if (error.code === "EPERM") return t.skip(`file symlink needs privilege on this host: ${error.code}`);
      throw error;
    }

    const store = new CacheStore({ path: cache });
    assert.doesNotThrow(() => store.set("search", "live", { synthetic: true }, 60));
    assert.doesNotThrow(() => store.set("search", "dangling", { synthetic: true }, 60));

    assert.ok(lstatSync(live).isSymbolicLink(), "live link object survives set()");
    assert.ok(lstatSync(dangling).isSymbolicLink(), "dangling link object survives set()");
    assert.equal(readFileSync(victim, "utf8"), "PRESERVE_OUTSIDE_CACHE", "outside bytes unchanged");
    assert.equal(existsSync(missing), false, "missing outside target is not created");
    assert.deepEqual(readdirSync(join(cache, "search")).sort(), ["dangling.json", "live.json"], "no tmp files left");
    assert.deepEqual(readdirSync(outside), ["preserve.json"]);

    // Ordinary behavior is unchanged: new entry, then atomic replacement of an owned file.
    store.set("search", "fresh", { v: 1 }, 60);
    store.set("search", "fresh", { v: 2 }, 60);
    assert.deepEqual(store.get("search", "fresh"), { v: 2 });
    assert.ok(lstatSync(join(cache, "search", "fresh.json")).isFile());
  } finally {
    cleanup(root);
  }
});

test("only known capability directories are owned: an unrelated child of the root is never read or cleared", () => {
  const { root, cache } = fixture();
  try {
    put(cache, "search", "own.json", validEntry());
    put(cache, "exports", "keep.json", validEntry({ key: "not-cache" }));

    const store = new CacheStore({ path: cache });
    const stats = store.stats();
    assert.equal(stats.total_entries, 1, "only the search entry is counted");
    assert.deepEqual(Object.keys(stats.capabilities), ["search"]);

    const result = store.clear();
    assert.equal(result.removed, 1);
    assert.ok(existsSync(join(cache, "exports", "keep.json")), "unrelated child survives clear");
  } finally {
    cleanup(root);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionBackend } from "../dist/execution/backend.js";
import { installFetchMock, jsonResponse, textResponse } from "./adapters/_fetch-mock.mjs";

/**
 * Write a temp config.toml that backs `search` with brave + serper and points
 * the result cache at a temp dir (so the test never touches ~/.config).
 */
function writeTempConfig({ cacheDir, cacheEnabled = true, searchProvider, exaNumResults }) {
  const dir = mkdtempSync(join(tmpdir(), "coldsearch-rc-"));
  const configPath = join(dir, "config.toml");
  const searchProviders = searchProvider === "exa" ? '["exa"]' : '["brave", "serper"]';
  const exaOptions = exaNumResults === undefined
    ? ""
    : `[providers.exa.options]\nnumResults = ${exaNumResults}\n`;
  const toml = `
[capabilities.search]
providers = ${searchProviders}
strategy = "all"

[capabilities.extract]
providers = ["jina"]
strategy = "all"

[capabilities.crawl]
providers = ["exa"]
strategy = "all"

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]

[providers.serper]
[providers.serper.keyPool]
keys = ["k"]

[providers.jina]
[providers.jina.keyPool]
keys = []

[providers.exa]
${exaOptions}
[providers.exa.keyPool]
keys = ["k"]

[cache]
enabled = ${cacheEnabled}
search_ttl = "6h"
extract_ttl = "24h"
path = ${JSON.stringify(cacheDir)}

[history]
path = ${JSON.stringify(join(dir, "history.jsonl"))}
`;
  writeFileSync(configPath, toml, "utf8");
  return { dir, configPath };
}

/** Standard brave+serper fetch mock that counts calls and returns one result each. */
function makeSearchMock(counter) {
  return {
    "*": async ({ url }) => {
      counter.calls++;
      if (url.includes("brave.com")) {
        return jsonResponse({
          web: { results: [{ title: "B", url: "https://b.example", description: "bb", relevance_score: 0.9 }] },
        });
      }
      if (url.includes("serper.dev")) {
        return jsonResponse({
          organic: [{ title: "S", link: "https://s.example", snippet: "ss", position: 1 }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Original two tests (preserved)
// ---------------------------------------------------------------------------

test("cache ON: two identical searches hit the network once (second served from cache)", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-cache-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  let fetchCalls = 0;
  const restore = installFetchMock({
    "*": async ({ url }) => {
      fetchCalls++;
      if (url.includes("brave.com")) {
        return jsonResponse({
          web: { results: [{ title: "B", url: "https://b.example", description: "bb", relevance_score: 0.9 }] },
        });
      }
      if (url.includes("serper.dev")) {
        return jsonResponse({
          organic: [{ title: "S", link: "https://s.example", snippet: "ss", position: 1 }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf" };

    const first = await backend.search("cache-on query", opts);
    const callsAfterFirst = fetchCalls;
    assert.ok(callsAfterFirst > 0, "first search should hit the network");

    const second = await backend.search("cache-on query", opts);

    // Second call must be served from cache — no additional fetches.
    assert.equal(fetchCalls, callsAfterFirst, "second search must be served from cache");
    // Cached payload has errors:{} stripped; compare the payload fields that matter.
    assert.deepEqual(second.results, first.results);
    assert.deepEqual(second.providersUsed, first.providersUsed);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("implicit and explicit default-valued limits use distinct cache entries", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-limit-set-"));
  const { dir, configPath } = writeTempConfig({
    cacheDir,
    searchProvider: "exa",
    exaNumResults: 4,
  });
  const requestedCounts = [];
  const restore = installFetchMock({
    "POST https://api.exa.ai/search": async ({ init }) => {
      const numResults = JSON.parse(init.body).numResults;
      requestedCounts.push(numResults);
      return jsonResponse({
        results: Array.from({ length: numResults }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://exa.example/${index}`,
          text: "content",
        })),
      });
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    const implicit = await backend.search("same query", { limit: 10, limitSet: false });
    const explicit = await backend.search("same query", { limit: 10, limitSet: true });

    assert.deepEqual(requestedCounts, [4, 10]);
    assert.equal(implicit.results.length, 4);
    assert.equal(explicit.results.length, 10);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("noCache: two identical searches hit the network twice", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-nocache-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  let fetchCalls = 0;
  const restore = installFetchMock({
    "*": async ({ url }) => {
      fetchCalls++;
      if (url.includes("brave.com")) {
        return jsonResponse({
          web: { results: [{ title: "B", url: "https://b.example", description: "bb", relevance_score: 0.9 }] },
        });
      }
      if (url.includes("serper.dev")) {
        return jsonResponse({
          organic: [{ title: "S", link: "https://s.example", snippet: "ss", position: 1 }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf", noCache: true };

    await backend.search("nocache query", opts);
    const callsAfterFirst = fetchCalls;

    await backend.search("nocache query", opts);

    // With noCache, the second call must re-run providers.
    assert.equal(
      fetchCalls,
      callsAfterFirst * 2,
      "noCache must bypass the cache and hit the network again"
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// New tests from code review
// ---------------------------------------------------------------------------

test("singleProvider bypass: two identical searches with singleProvider:true hit the network twice", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-sp-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 10, rerankStrategy: "rrf", singleProvider: true };

    await backend.search("sp query", opts);
    const callsAfterFirst = counter.calls;
    assert.ok(callsAfterFirst > 0, "first search should hit the network");

    await backend.search("sp query", opts);

    // singleProvider bypasses cache — second call must also hit the network.
    assert.equal(
      counter.calls,
      callsAfterFirst * 2,
      "singleProvider must bypass the cache"
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("explicit providers bypass: two identical searches with providers:[...] hit the network twice", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-ep-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    // Pin to a single named provider — this is an explicit scope, cache bypassed.
    const opts = { limit: 10, rerankStrategy: "rrf", providers: ["brave"] };

    await backend.search("ep query", opts);
    const callsAfterFirst = counter.calls;
    assert.ok(callsAfterFirst > 0, "first search should hit the network");

    await backend.search("ep query", opts);

    assert.equal(
      counter.calls,
      callsAfterFirst * 2,
      "explicit providers must bypass the cache"
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("extract hit-once: two identical extracts with cache on hit the network once", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-ext-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  let fetchCalls = 0;
  const restore = installFetchMock({
    // Jina reader keeps the caller scheme: https://r.jina.ai/https://...
    "*": async ({ url }) => {
      fetchCalls++;
      if (url.includes("r.jina.ai")) {
        return textResponse("Title: Test Page\n\nExtracted body content");
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    const opts = { limit: 1 };
    const url = "https://example.com/article";

    const first = await backend.extract(url, opts);
    const callsAfterFirst = fetchCalls;
    assert.ok(callsAfterFirst > 0, "first extract should hit the network");
    assert.ok(first.result !== null, "first extract should return content");

    const second = await backend.extract(url, opts);

    // Second call served from cache — no additional network calls.
    assert.equal(fetchCalls, callsAfterFirst, "second extract must be served from cache");
    assert.equal(second.result?.content, first.result?.content);
    assert.equal(second.provider, first.provider);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("no cross-scope hit: a providers-scoped search does not return a cached default-pool result", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-cs-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  const counter = { calls: 0 };
  const restore = installFetchMock(makeSearchMock(counter));

  try {
    const backend = new LocalExecutionBackend(configPath);
    const query = "cross-scope query";

    // First call: default pool (cache ON) — populates cache.
    await backend.search(query, { limit: 10, rerankStrategy: "rrf" });
    const callsAfterDefault = counter.calls;

    // Second call: explicit providers scope — must NOT get a cache hit.
    await backend.search(query, { limit: 10, rerankStrategy: "rrf", providers: ["brave"] });

    assert.ok(
      counter.calls > callsAfterDefault,
      "providers-scoped search must bypass cache and hit the network"
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("extract all-fail: a failed extract throws and writes nothing to the cache dir", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-extfail-"));
  const { dir, configPath } = writeTempConfig({ cacheDir });

  const restore = installFetchMock({
    "*": async () => {
      throw new Error("provider down");
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);

    await assert.rejects(
      () => backend.extract("https://fail.example/page", { limit: 1 }),
      /All providers failed/,
      "should throw when all providers fail"
    );

    // No cache entry must have been written.
    const extractCacheDir = join(cacheDir, "extract");
    assert.equal(
      existsSync(extractCacheDir),
      false,
      "cache dir for extract must not exist after a total failure"
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

function writeTempBraveCountConfig({ cacheDir }) {
  const dir = mkdtempSync(join(tmpdir(), "coldsearch-rc-limit-"));
  const configPath = join(dir, "config.toml");
  const toml = `
[capabilities.search]
providers = ["brave"]
strategy = "all"

[capabilities.extract]
providers = ["jina"]
strategy = "all"

[capabilities.crawl]
providers = ["exa"]
strategy = "all"

[providers.brave]
[providers.brave.keyPool]
keys = ["k"]
[providers.brave.options]
count = 3

[providers.jina]
[providers.jina.keyPool]
keys = []

[providers.exa]
[providers.exa.keyPool]
keys = ["k"]

[cache]
enabled = true
search_ttl = "6h"
path = ${JSON.stringify(cacheDir)}

[history]
path = ${JSON.stringify(join(dir, "history.jsonl"))}
`;
  writeFileSync(configPath, toml, "utf8");
  return { dir, configPath };
}


test("search cache distinguishes implicit and explicit equal limits", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "coldsearch-rc-limit-cache-"));
  const { dir, configPath } = writeTempBraveCountConfig({ cacheDir });
  const requestedCounts = [];
  const restore = installFetchMock({
    "*": async ({ url }) => {
      const parsed = new URL(url);
      requestedCounts.push(parsed.searchParams.get("count"));
      return jsonResponse({
        web: {
          results: [
            {
              title: "Brave result",
              url: "https://brave.example",
              description: "result",
              relevance_score: 0.9,
            },
          ],
        },
      });
    },
  });

  try {
    const backend = new LocalExecutionBackend(configPath);
    await backend.search("same query", { limit: 10, limitSet: false });
    await backend.search("same query", { limit: 10, limitSet: true });

    assert.deepEqual(
      requestedCounts,
      ["3", "10"],
      "the explicit limit must not replay the implicit configured-count result"
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

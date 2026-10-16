import test from "node:test";
import assert from "node:assert/strict";
import { assertNormalizedResult } from "../dist/contracts/envelope.js";
import {
  capabilityCacheIdentity,
  endpointKeyMaterial,
} from "../dist/contracts/endpoint-identity.js";
import { cacheKey } from "../dist/cache/key.js";
import { classifyError } from "../dist/http.js";

// ---------------------------------------------------------------------------
// Envelope shape guards (C4)
// ---------------------------------------------------------------------------

test("assertNormalizedResult accepts well-formed search/extract/crawl results", () => {
  assert.doesNotThrow(() =>
    assertNormalizedResult("search", "brave", [
      { title: "T", url: "https://x.example", snippet: "s", score: 1, source: "brave" },
    ])
  );
  // An empty array is a valid result, not a violation.
  assert.doesNotThrow(() => assertNormalizedResult("search", "brave", []));
  assert.doesNotThrow(() => assertNormalizedResult("crawl", "exa", []));
  assert.doesNotThrow(() =>
    assertNormalizedResult("crawl", "exa", [{ url: "https://x.example", title: "", content: "" }])
  );
  assert.doesNotThrow(() =>
    assertNormalizedResult("extract", "jina", {
      content: "body",
      url: "https://x.example",
      source: "jina",
    })
  );
  assert.doesNotThrow(() =>
    assertNormalizedResult("extract", "jina", {
      content: "body",
      url: "https://x.example",
      title: "T",
      source: "jina",
    })
  );
});

test("assertNormalizedResult rejects malformed search results", () => {
  assert.throws(
    () => assertNormalizedResult("search", "brave", { results: [] }),
    /Provider 'brave' returned a malformed search result: expected an array/
  );
  assert.throws(
    () => assertNormalizedResult("search", "brave", [{ url: "https://x.example", snippet: "s" }]),
    /missing\/invalid 'title'/
  );
  assert.throws(
    () => assertNormalizedResult("search", "brave", [null]),
    /malformed search result/
  );
});

test("assertNormalizedResult rejects malformed extract and crawl results", () => {
  assert.throws(
    () => assertNormalizedResult("extract", "jina", []),
    /expected an object with \{ content, url, source \}/
  );
  assert.throws(
    () => assertNormalizedResult("extract", "jina", { url: "https://x.example", source: "jina" }),
    /missing\/invalid 'content'/
  );
  assert.throws(
    () =>
      assertNormalizedResult("extract", "jina", {
        content: "c",
        url: "https://x.example",
        source: "jina",
        title: 42,
      }),
    /optional 'title' must be a string/
  );
  assert.throws(
    () => assertNormalizedResult("crawl", "exa", [{ title: "T", content: "c" }]),
    /missing\/invalid 'url'/
  );
});

test("envelope guard failures classify as provider errors", () => {
  try {
    assertNormalizedResult("search", "brave", [{ url: "https://x.example" }]);
    assert.fail("expected throw");
  } catch (error) {
    assert.equal(classifyError(error).category, "provider");
  }
});

test("full 5xx range classifies as network (Kilo WARNING on #84)", async () => {
  const { HTTPRequestError } = await import("../dist/http.js");
  for (const status of [500, 501, 502, 503, 504, 505, 508, 511, 520, 599]) {
    const error = new HTTPRequestError(`status ${status}`, {
      url: "https://x.example",
      status,
    });
    assert.equal(
      classifyError(error).category,
      "network",
      `HTTP ${status} must classify as network`
    );
  }
  // Non-5xx behavior preserved: 400/422 validation, 401 credentials, 429 rate_limit.
  const expectations = [
    [400, "validation"],
    [422, "validation"],
    [401, "credentials"],
    [403, "credentials"],
    [429, "rate_limit"],
    [404, "provider"],
  ];
  for (const [status, category] of expectations) {
    const error = new HTTPRequestError(`status ${status}`, {
      url: "https://x.example",
      status,
    });
    assert.equal(classifyError(error).category, category, `HTTP ${status}`);
  }
});

// ---------------------------------------------------------------------------
// Cache-key identity (C3)
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return {
    capabilities: {
      search: { providers: ["brave", "serper"], strategy: "all" },
      extract: { providers: ["jina"], strategy: "all" },
      ...(overrides.capabilities || {}),
    },
    providers: {
      brave: { keyPool: { keys: ["k"] } },
      serper: { keyPool: { keys: ["k"] } },
      jina: { keyPool: { keys: [] } },
      ...(overrides.providers || {}),
    },
  };
}

function searchKey(config, query = "q") {
  return cacheKey("search", query, {
    limit: 10,
    rerankStrategy: "rrf",
    ...capabilityCacheIdentity(config, "search"),
  });
}

test("cache identity: same config produces the same key", () => {
  assert.equal(searchKey(makeConfig()), searchKey(makeConfig()));
});

test("cache identity: changing the configured pool changes the key", () => {
  const base = searchKey(makeConfig());
  const pooled = searchKey(
    makeConfig({
      capabilities: { search: { providers: ["brave"], strategy: "all" } },
    })
  );
  assert.notEqual(base, pooled);

  // Strategy change invalidates too.
  const strategized = searchKey(
    makeConfig({
      capabilities: { search: { providers: ["brave", "serper"], strategy: "random" } },
    })
  );
  assert.notEqual(base, strategized);
});

test("cache identity: changing a searxng baseUrl changes the key", () => {
  const withSearxng = (baseUrl) =>
    makeConfig({
      capabilities: { search: { providers: ["searxng"], strategy: "all" } },
      providers: {
        searxng: { keyPool: { keys: [] }, options: { baseUrl } },
      },
    });

  const a = searchKey(withSearxng("https://search-a.example"));
  const b = searchKey(withSearxng("https://search-b.example"));
  assert.notEqual(a, b);
  // Identical endpoint config → identical key.
  assert.equal(a, searchKey(withSearxng("https://search-a.example")));
});

test("cache identity: <PROVIDER>_BASE_URL env participates in the key", (t) => {
  const config = makeConfig({
    capabilities: { search: { providers: ["searxng"], strategy: "all" } },
    providers: { searxng: { keyPool: { keys: [] } } },
  });

  const withoutEnv = searchKey(config);
  process.env.SEARXNG_BASE_URL = "https://env-searxng.example";
  t.after(() => {
    delete process.env.SEARXNG_BASE_URL;
  });
  assert.notEqual(withoutEnv, searchKey(config));
});

test("cache identity: credential-shaped options never enter the key", () => {
  const identity = endpointKeyMaterial(
    makeConfig({
      providers: {
        searxng: {
          keyPool: { keys: [] },
          options: {
            baseUrl: "https://search.example",
            api_key: "super-secret",
            apiToken: "also-secret",
          },
        },
      },
    }),
    "searxng"
  );
  assert.deepEqual(identity, { baseUrl: "https://search.example" });
});

test("cache identity: invocation-level singleProvider does not change the key", () => {
  // capabilityCacheIdentity takes only (config, capability) — per-call scoping
  // cannot reach it. The backend additionally bypasses the cache for scoped
  // calls, but the key itself is stable across those invocations.
  const config = makeConfig();
  const identity = capabilityCacheIdentity(config, "search");
  assert.ok(!("singleProvider" in identity));
  assert.ok(!("providers" in identity) || Array.isArray(identity.providers));
  assert.equal(searchKey(config), searchKey(config));
});

// ---------------------------------------------------------------------------
// Async job lifecycle typing (C5) — runtime smoke over the type contract
// ---------------------------------------------------------------------------

test("AsyncJobResult terminal/pending branches are distinguishable", async () => {
  const mod = await import("../dist/contracts/lifecycle.js");
  // Type-only module: no runtime exports expected beyond nothing. The
  // contract is exercised at compile time (tsc); this just pins the module
  // as importable from the dist surface.
  assert.ok(mod !== undefined);

  /** @type {import("../dist/contracts/lifecycle.js").AsyncJobResult<string[]>} */
  const completed = { status: "completed", data: ["https://x.example"] };
  /** @type {import("../dist/contracts/lifecycle.js").AsyncJobResult<string[]>} */
  const cancelled = { status: "cancelled", error: "operator cancelled" };
  /** @type {import("../dist/contracts/lifecycle.js").AsyncJobResult<string[]>} */
  const scraping = { status: "scraping" };

  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.data, ["https://x.example"]);
  assert.equal(cancelled.error, "operator cancelled");
  assert.equal("data" in scraping, false);
});

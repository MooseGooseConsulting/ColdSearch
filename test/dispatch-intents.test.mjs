import test from "node:test";
import assert from "node:assert/strict";
// Side effect: installs the Bright Data tool profiles into the registry.
import "../dist/providers.js";
import {
  INTENT_DEFS,
  IntentRejectionError,
  isSearchIntent,
  listSearchIntents,
  rejectIntent,
  resolveIntent,
} from "../dist/dispatch/intents.js";

function makeConfig(capabilities = {}) {
  return {
    capabilities: {
      search: { providers: ["tavily", "brave", "exa"] },
      extract: { providers: ["tavily", "jina"] },
      crawl: { providers: ["tavily"] },
      ...capabilities,
    },
    providers: {},
  };
}

const EXPECTED_CATEGORIES = {
  "web-link-search": "search",
  "content-backed-retrieval": "search",
  "url-similarity": "search",
  "known-url-extraction": "extract",
  "structured-extraction": "extract",
  "url-discovery-map": "map",
  crawl: "crawl",
  answer: "answer",
  research: "research",
};

test("INTENT_DEFS declares the nine intents with their categories", () => {
  assert.deepEqual(
    [...listSearchIntents()].sort(),
    Object.keys(EXPECTED_CATEGORIES).sort()
  );
  for (const [intent, category] of Object.entries(EXPECTED_CATEGORIES)) {
    assert.equal(INTENT_DEFS[intent].category, category, `${intent} category`);
    assert.ok(isSearchIntent(intent));
  }
  assert.ok(!isSearchIntent("not-an-intent"));
});

test("web-link-search resolves wired search tools, direct fits before derived", () => {
  const resolution = resolveIntent("web-link-search", makeConfig());
  assert.ok(resolution.eligible.length >= 7, "all wired search tools are eligible");
  assert.ok(resolution.eligible.every((e) => e.status === "wired"));

  const fits = resolution.eligible.map((e) => e.semanticFit);
  const firstDerived = fits.indexOf("derived");
  const lastDirect = fits.lastIndexOf("direct");
  assert.ok(firstDerived === -1 || lastDirect < firstDerived, "direct fits sort first");

  // exa.findSimilar backs search only in a derived sense (seed URL, not query).
  const last = resolution.eligible[resolution.eligible.length - 1];
  assert.equal(last.id, "exa.findSimilar");
  assert.equal(last.semanticFit, "derived");

  // Entries carry native endpoint + execution mode provenance.
  const tavily = resolution.eligible.find((e) => e.id === "tavily.search");
  assert.equal(tavily.nativeName, "POST /search");
  assert.equal(tavily.executionMode, "sync");

  // Configured-pool intersection reflects actual routing config.
  assert.deepEqual(resolution.configuredProviders, ["tavily", "brave", "exa"]);
  assert.deepEqual([...resolution.routedProviders].sort(), ["brave", "exa", "tavily"]);
  assert.doesNotThrow(() => rejectIntent(resolution));
});

test("content-backed-retrieval filters to integratedContent tools", () => {
  const resolution = resolveIntent("content-backed-retrieval", makeConfig());
  assert.deepEqual(
    resolution.eligible.map((e) => e.id),
    ["exa.search", "firecrawl.search", "tavily.search"],
    "only search tools with integratedContent qualify"
  );
  // brave.llmContent qualifies feature-wise but is documented-only (available).
  assert.deepEqual(
    resolution.documentedOnly.map((e) => e.id),
    ["brave.llmContext"]
  );
  assert.deepEqual(resolution.requireFeatures, ["integratedContent"]);
});

test("content-backed-retrieval rejects when the configured pool cannot back it", () => {
  const resolution = resolveIntent(
    "content-backed-retrieval",
    makeConfig({ search: { providers: ["brave", "serper"] } })
  );
  assert.ok(resolution.eligible.length > 0, "eligible tools exist in the registry");
  assert.deepEqual(resolution.routedProviders, []);
  assert.throws(
    () => rejectIntent(resolution),
    (error) => {
      assert.ok(error instanceof IntentRejectionError);
      assert.equal(error.rejection.reason, "not-in-configured-pool");
      assert.equal(error.rejection.intent, "content-backed-retrieval");
      assert.equal(error.category, "unsupported_capability");
      return true;
    }
  );
});

test("url-similarity is native-only (exa findSimilar) and surfaces deprecation", () => {
  const resolution = resolveIntent("url-similarity", makeConfig());
  assert.equal(resolution.eligible.length, 1);
  const entry = resolution.eligible[0];
  assert.equal(entry.id, "exa.findSimilar");
  assert.equal(entry.nativeName, "POST /findSimilar");
  assert.equal(entry.semanticFit, "derived");
  assert.match(entry.deprecation ?? "", /deprecated upstream/i);
  // exa is in the configured pool here, so it routes (deprecated but callable).
  assert.deepEqual(resolution.routedProviders, ["exa"]);
  assert.doesNotThrow(() => rejectIntent(resolution));

  // Without exa in the configured pool it rejects instead of silently routing.
  const unroutable = resolveIntent(
    "url-similarity",
    makeConfig({ search: { providers: ["tavily", "brave"] } })
  );
  assert.throws(
    () => rejectIntent(unroutable),
    (error) => error.rejection?.reason === "not-in-configured-pool"
  );
});

test("structured-extraction rejects: no wired extract tool satisfies the predicate", () => {
  const resolution = resolveIntent("structured-extraction", makeConfig());
  assert.deepEqual(resolution.eligible, []);
  assert.throws(
    () => rejectIntent(resolution),
    (error) => {
      assert.ok(error instanceof IntentRejectionError);
      assert.equal(error.rejection.reason, "required-features-unsatisfied");
      assert.match(error.message, /structured-extraction/);
      return true;
    }
  );
});

test("answer and url-discovery-map reject as documented-but-unwired", () => {
  const answer = resolveIntent("answer", makeConfig());
  assert.deepEqual(answer.eligible, []);
  assert.throws(
    () => rejectIntent(answer),
    (error) => {
      assert.equal(error.rejection?.reason, "documented-but-unwired");
      assert.deepEqual(error.rejection.documentedOnly, ["brave.answers", "exa.answer", "tavily.answer"]);
      return true;
    }
  );

  const map = resolveIntent("url-discovery-map", makeConfig());
  assert.throws(
    () => rejectIntent(map),
    (error) => {
      assert.equal(error.rejection?.reason, "documented-but-unwired");
      assert.deepEqual(error.rejection.documentedOnly, ["firecrawl.map", "tavily.map"]);
      return true;
    }
  );
});

test("research resolves to the wired partial-fit exa search tool", () => {
  const resolution = resolveIntent("research", makeConfig());
  assert.deepEqual(
    resolution.eligible.map((e) => [e.id, e.semanticFit]),
    [["exa.search", "partial"]]
  );
  assert.deepEqual(
    resolution.documentedOnly.map((e) => e.id),
    [
      "brave.llmContext",
      "firecrawl.extract",
      "jina.deepSearch",
      "jina.embeddings",
      "jina.rerank",
      "tavily.research",
    ]
  );
});

test("known-url-extraction resolves wired extract tools (firecrawl is scrape)", () => {
  const resolution = resolveIntent("known-url-extraction", makeConfig());
  const ids = resolution.eligible.map((e) => e.id);
  assert.ok(ids.includes("firecrawl.scrape"), "firecrawl extract is backed by scrape");
  assert.ok(ids.includes("exa.contents"));
  assert.ok(ids.includes("tavily.extract"));
  assert.ok(ids.includes("jina.reader"));
  assert.ok(!ids.includes("firecrawl.extract"), "structured-LLM extract is not an extract backer");
  assert.ok(resolution.eligible.every((e) => e.semanticFit === "direct"));
  assert.doesNotThrow(() => rejectIntent(resolution));
});

test("crawl intent resolves wired crawl tools with fit ordering", () => {
  const resolution = resolveIntent("crawl", makeConfig());
  assert.deepEqual(
    resolution.eligible.map((e) => e.id),
    ["firecrawl.crawl", "tavily.crawl", "exa.contents"],
    "direct crawlers first; exa's derived contents-synthesis last"
  );
  assert.equal(resolution.eligible[0].executionMode, "async-job");
});

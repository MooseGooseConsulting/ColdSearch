import test from "node:test";
import assert from "node:assert/strict";
import { providerRegistry } from "../dist/providers.js";
import {
  providerToolProfiles,
  getToolProfile,
  listToolProfiles,
  resolveEligibleTools,
  wiredToolForProviderCategory,
} from "../dist/registry/tool-profiles.js";

const CAPABILITY_NAMES = ["search", "extract", "crawl"];
const SEMANTIC_FITS = new Set(["direct", "partial", "derived", "not-recommended"]);
const EXECUTION_MODES = new Set(["sync", "async-job", "streaming"]);
const STATUSES = new Set(["wired", "available", "deferred", "direct"]);

test("every profile key equals `<provider>.<tool>`", () => {
  for (const [id, profile] of Object.entries(providerToolProfiles)) {
    assert.equal(
      id,
      `${profile.provider}.${profile.tool}`,
      `Profile key '${id}' must equal '${profile.provider}.${profile.tool}'`
    );
  }
});

test("direct Brave tools and nested Exa freshness schema match dispatch", () => {
  assert.equal(getToolProfile("brave.answers")?.status, "direct");
  assert.equal(getToolProfile("brave.llmContext")?.status, "direct");

  const exaSearchParams = getToolProfile("exa.search")?.optionalParams ?? [];
  assert.ok(exaSearchParams.includes("contents.maxAgeHours"));
  assert.ok(exaSearchParams.includes("contents.livecrawlTimeout"));
  assert.ok(!exaSearchParams.includes("maxAgeHours"));
  assert.ok(!exaSearchParams.includes("livecrawlTimeout"));
});

test("every registered provider has at least one tool profile", () => {
  for (const provider of Object.keys(providerRegistry)) {
    const profiles = listToolProfiles({ provider });
    assert.ok(
      profiles.length > 0,
      `Provider '${provider}' has no tool profile in the registry`
    );
  }
});

test("wired profiles are structurally complete and raw-preserving", () => {
  for (const profile of listToolProfiles({ status: "wired" })) {
    const id = `${profile.provider}.${profile.tool}`;
    assert.ok(profile.docsUrl?.startsWith("http"), `${id} missing docsUrl`);
    assert.ok(profile.nativeName, `${id} missing nativeName`);
    assert.ok(profile.description, `${id} missing description`);
    assert.ok(STATUSES.has(profile.status), `${id} invalid status`);
    assert.ok(EXECUTION_MODES.has(profile.execution.mode), `${id} invalid execution.mode`);
    assert.equal(profile.output.rawPreserved, true, `${id} must preserve raw payloads`);
    assert.ok(profile.requiredParams.length > 0, `${id} must enumerate required params`);
    assert.ok(profile.categories.length > 0, `${id} must declare at least one category`);
    assert.ok(profile.commonViews.length > 0, `${id} must declare at least one common view`);
    assert.ok(
      ["official-docs", "official-mcp", "sdk", "handwritten"].includes(profile.schemaSource),
      `${id} invalid schemaSource`
    );
    assert.match(profile.schemaLastVerified, /^\d{4}-\d{2}-\d{2}$/, `${id} bad schemaLastVerified`);
    assert.ok(profile.adapterMethod, `${id} wired tool must name its adapterMethod`);
  }
});

test("every common-view mapping declares fit and supported/unsupported options", () => {
  for (const profile of Object.values(providerToolProfiles)) {
    const id = `${profile.provider}.${profile.tool}`;
    for (const view of profile.commonViews) {
      assert.ok(
        SEMANTIC_FITS.has(view.semanticFit),
        `${id} common view '${view.category}' has invalid semanticFit`
      );
      assert.ok(
        view.mapsCommonOptions && typeof view.mapsCommonOptions === "object",
        `${id} common view '${view.category}' missing mapsCommonOptions`
      );
      assert.ok(
        Array.isArray(view.unsupportedCommonOptions),
        `${id} common view '${view.category}' missing unsupportedCommonOptions[]`
      );
      assert.ok(
        profile.categories.includes(view.category),
        `${id} common view '${view.category}' not listed in profile.categories`
      );
    }
  }
});

test("wired profile categories never claim a capability the registry lacks", () => {
  for (const profile of listToolProfiles({ status: "wired" })) {
    const registryCaps = new Set(providerRegistry[profile.provider].capabilities);
    for (const category of profile.categories) {
      if (!CAPABILITY_NAMES.includes(category)) continue; // map/research/answer are profile-only
      assert.ok(
        registryCaps.has(category),
        `${profile.provider}.${profile.tool} claims category '${category}' but registry capabilities are [${[...registryCaps].join(", ")}]`
      );
    }
  }
});

test("every registry capability is backed by a wired tool (no lying by omission)", () => {
  for (const [provider, metadata] of Object.entries(providerRegistry)) {
    for (const capability of metadata.capabilities) {
      const backer = wiredToolForProviderCategory(provider, capability);
      assert.ok(
        backer && backer.adapterMethod,
        `Provider '${provider}' declares capability '${capability}' but no wired tool profile backs it`
      );
    }
  }
});

test("Firecrawl extract is backed by scrape, not the structured extract endpoint", () => {
  // The whole point of the profile model: provider-native names are not
  // authoritative. Firecrawl `scrape` is known-URL retrieval (ColdSearch
  // extract); Firecrawl `extract` is a different structured-LLM tool.
  const extractBacker = wiredToolForProviderCategory("firecrawl", "extract");
  assert.equal(extractBacker?.tool, "scrape", "ColdSearch extract must map to firecrawl.scrape");

  const structured = getToolProfile("firecrawl.extract");
  assert.ok(structured, "firecrawl.extract profile should exist to document the collision");
  assert.notEqual(structured.status, "wired", "firecrawl.extract must not be wired as extract");
  assert.ok(
    !structured.categories.includes("extract"),
    "firecrawl.extract must not claim the 'extract' category"
  );
});

test("resolveEligibleTools is requirement-aware (feature predicates filter)", () => {
  // No requirements: all wired search tools are eligible.
  const allSearch = resolveEligibleTools("search");
  assert.ok(allSearch.length >= 5, "expected several wired search tools");
  assert.ok(allSearch.every((t) => t.status === "wired"));

  // browserActions is a Firecrawl-scrape-only feature among extract tools.
  const browserExtract = resolveEligibleTools("extract", { requireFeatures: ["browserActions"] });
  assert.deepEqual(
    browserExtract.map((t) => `${t.provider}.${t.tool}`),
    ["firecrawl.scrape"],
    "only firecrawl.scrape supports browserActions for extract"
  );

  // An impossible predicate yields no eligible tools (fail-visible upstream).
  assert.equal(
    resolveEligibleTools("search", { requireFeatures: ["nonexistentFeature"] }).length,
    0
  );
});

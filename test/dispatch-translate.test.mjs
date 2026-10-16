import test from "node:test";
import assert from "node:assert/strict";
// Side effect: installs the Bright Data tool profiles into the registry.
import "../dist/providers.js";
import {
  emitTranslationNotes,
  resolveTranslatedProviderOptions,
  translateCommonOptions,
  unsupportedCommonFilterOptions,
} from "../dist/dispatch/translate.js";
import { getToolProfile } from "../dist/registry/tool-profiles.js";

function viewFor(id, category = "search") {
  const profile = getToolProfile(id);
  assert.ok(profile, `profile ${id} exists`);
  const view = profile.commonViews.find((v) => v.category === category);
  assert.ok(view, `profile ${id} has a ${category} view`);
  return view;
}

test("limit translates to each provider's native scalar param", () => {
  const cases = [
    ["tavily.search", "max_results"],
    ["serper.search", "num"],
    ["brave.webSearch", "count"],
    ["exa.search", "numResults"],
    ["firecrawl.search", "limit"],
  ];
  for (const [id, native] of cases) {
    const { params, skipped } = translateCommonOptions(viewFor(id), { limit: 7 });
    assert.deepEqual(params, { [native]: 7 }, `${id} limit -> ${native}`);
    assert.deepEqual(skipped, []);
  }
});

test("limit is skipped (with a debug note) when no mapping is declared", () => {
  const { params, skipped } = translateCommonOptions(viewFor("searxng.search"), { limit: 7 });
  assert.deepEqual(params, {});
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /'limit' has no declared mapping/);
});

test("common filters and values use only declared provider mappings", () => {
  const exa = translateCommonOptions(viewFor("exa.search"), {
    includeDomains: ["a.example"],
    excludeDomains: ["b.example"],
    freshness: "30d",
    includeContent: true,
    timeRange: "week",
  });
  assert.deepEqual(exa.params, {
    includeDomains: ["a.example"],
    excludeDomains: ["b.example"],
  });
  assert.equal(exa.skipped.length, 3);
  assert.match(exa.skipped[0], /freshness/);
  assert.match(exa.skipped[1], /includeContent/);
  assert.match(exa.skipped[2], /timeRange/);

  const tavily = translateCommonOptions(viewFor("tavily.search"), { timeRange: "week" });
  assert.deepEqual(tavily.params, { time_range: "w" });
  assert.deepEqual(tavily.skipped, []);

  const unsupportedWeek = unsupportedCommonFilterOptions(viewFor("searxng.search"), {
    timeRange: "week",
  });
  assert.deepEqual(unsupportedWeek, ["timeRange value 'week' is unsupported"]);
  assert.deepEqual(
    translateCommonOptions(viewFor("searxng.search"), { timeRange: "week" }),
    {
      params: {},
      skipped: ["common option 'timeRange' value 'week' is unsupported for this view"],
    }
  );
  assert.deepEqual(
    translateCommonOptions(viewFor("searxng.search"), { timeRange: "month" }).params,
    { time_range: "month" }
  );
});

test("resolveTranslatedProviderOptions merges invocation over config without mutating it", () => {
  const configOptions = { topic: "news", max_results: 3 };
  const { providerOptions, notes } = resolveTranslatedProviderOptions(
    "tavily",
    "search",
    { limit: 7, timeRange: "month" },
    configOptions
  );
  assert.deepEqual(providerOptions, { topic: "news", max_results: 7, time_range: "m" });
  assert.deepEqual(configOptions, { topic: "news", max_results: 3 }, "config object untouched");
  assert.deepEqual(notes, []);
});

test("resolveTranslatedProviderOptions keeps undefined when nothing resolves", () => {
  const { providerOptions, notes } = resolveTranslatedProviderOptions(
    "searxng",
    "search",
    { limit: 5 },
    undefined
  );
  assert.equal(providerOptions, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^searxng\.search: /);
});

test("emitTranslationNotes is silent without COLDSEARCH_DEBUG", () => {
  const original = process.env.COLDSEARCH_DEBUG;
  const errors = [];
  const originalError = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    delete process.env.COLDSEARCH_DEBUG;
    emitTranslationNotes(["hidden"]);
    process.env.COLDSEARCH_DEBUG = "1";
    emitTranslationNotes(["shown"]);
  } finally {
    console.error = originalError;
    if (original === undefined) delete process.env.COLDSEARCH_DEBUG;
    else process.env.COLDSEARCH_DEBUG = original;
  }
  assert.deepEqual(errors, ["Debug: shown"]);
});

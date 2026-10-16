import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { FirecrawlAdapter } from "../../dist/adapters/firecrawl.js";
import { fetchJson, classifyError, HTTPRequestError } from "../../dist/http.js";
import { assertNormalizedResult } from "../../dist/contracts/envelope.js";
import {
  loadFixtures,
  replayAdapterTest,
  fixtureResponse,
} from "../../dist/testing/replay.js";
import { installFetchMock } from "./_fetch-mock.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/provider-envelopes/", import.meta.url));

async function loadFixture(name) {
  const [fixture] = await loadFixtures(new URL(name, `file://${FIXTURE_DIR}/`));
  return fixture;
}

/**
 * Replay one error-envelope fixture through fetchWithPolicy (same wire path
 * adapters use) and return the HTTPRequestError it produced.
 */
async function replayError(fixture) {
  const restore = installFetchMock({ "*": async () => fixtureResponse(fixture) });
  try {
    await fetchJson(
      fixture.url,
      {
        method: fixture.method,
        headers: fixture.requestHeaders,
        body: fixture.requestBody,
      },
      { label: fixture.label, retries: 0 }
    );
    assert.fail(`fixture ${fixture.provider} should have thrown`);
  } catch (error) {
    assert.ok(error instanceof HTTPRequestError, `expected HTTPRequestError, got ${error}`);
    return error;
  } finally {
    restore();
  }
}

test("layer-2 fixtures load and are versioned", async () => {
  const fixtures = await loadFixtures(FIXTURE_DIR);
  assert.equal(fixtures.length, 6);
  for (const fixture of fixtures) {
    assert.equal(fixture.fixtureVersion, 1);
    assert.equal(typeof fixture.provider, "string");
    assert.equal(typeof fixture.responseBodyText, "string");
  }
});

test("replay preserves transport failures instead of synthesizing HTTP 200", () => {
  const fixture = {
    fixtureVersion: 1,
    provider: "tavily",
    method: "GET",
    url: "https://api.tavily.com/search",
    durationMs: 12,
    error: "Tavily search timed out after 10000ms",
  };
  assert.throws(() => fixtureResponse(fixture), /Captured transport failure: Tavily search timed out/);
});

test("replay: Firecrawl /v2/search 200 envelope normalizes (position/category preserved on the wire)", async () => {
  const fixture = await loadFixture("firecrawl-search-200.json");

  // The raw envelope carries the 2026-10-12 live shape, including the
  // position + category fields the normalization contract must tolerate.
  const envelope = JSON.parse(fixture.responseBodyText);
  assert.equal(envelope.success, true);
  assert.equal(envelope.data.web[0].position, 1);
  assert.equal(envelope.data.web[0].category, "github");
  assert.equal(envelope.data.creditsUsed, 2);

  const adapter = new FirecrawlAdapter();
  const [results] = await replayAdapterTest(
    () => adapter.search("coldsearch contract probe", "REDACTED"),
    [fixture],
    installFetchMock
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/x");
  assert.equal(results[0].title, "T");
  assert.equal(results[0].snippet, "D");
  assert.equal(results[0].source, "firecrawl");
  // No `score` on the wire: the adapter falls back to its index-based score
  // (position/category are tolerated, not consumed).
  assert.equal(results[0].score, 1);

  // Layer-3 guard: the replayed normalization satisfies the engine envelope.
  assertNormalizedResult("search", "firecrawl", results);
});

test("replay: Firecrawl /v2/scrape 200 markdown envelope normalizes to extract content", async () => {
  const fixture = await loadFixture("firecrawl-scrape-markdown-200.json");
  const adapter = new FirecrawlAdapter();
  const [result] = await replayAdapterTest(
    () => adapter.extract("https://example.com/x", "REDACTED"),
    [fixture],
    installFetchMock
  );

  assert.equal(result.content, "# Example\n\nCaptured markdown body.");
  assert.equal(result.title, "Example Domain");
  assert.equal(result.url, "https://example.com/x");
  assert.equal(result.source, "firecrawl");
  assertNormalizedResult("extract", "firecrawl", result);
});

test("replay: Firecrawl /v2/scrape 200 html envelope — data.html is surfaced as extract content", async () => {
  const fixture = await loadFixture("firecrawl-scrape-html-200.json");
  const envelope = JSON.parse(fixture.responseBodyText);
  assert.equal(typeof envelope.data.html, "string");
  assert.equal("markdown" in envelope.data, false);

  const adapter = new FirecrawlAdapter();
  const [result] = await replayAdapterTest(
    () => adapter.extract("https://example.com/x", "REDACTED", { providerOptions: { formats: ["html"] } }),
    [fixture],
    installFetchMock
  );

  assert.equal(result.content, envelope.data.html);
  assert.equal(result.title, "Example Domain");
  assertNormalizedResult("extract", "firecrawl", result);
});

test("replay: Tavily 401 envelope classifies as credentials without exposing the body", async () => {
  const fixture = await loadFixture("tavily-search-401.json");
  const error = await replayError(fixture);
  assert.equal(error.status, 401);
  assert.equal(error.body, fixture.responseBodyText);

  const { category, message } = classifyError(error);
  assert.equal(category, "credentials");
  assert.equal(message, "Tavily search failed with HTTP 401");
  assert.doesNotMatch(message, /Unauthorized: missing or invalid API key/);
});

test("replay: Serper 403 envelope classifies as credentials without exposing the body", async () => {
  const fixture = await loadFixture("serper-search-403.json");
  const error = await replayError(fixture);
  assert.equal(error.status, 403);
  assert.equal(error.body, fixture.responseBodyText);

  const { category, message } = classifyError(error);
  assert.equal(category, "credentials");
  assert.equal(message, "Serper search failed with HTTP 403");
  assert.doesNotMatch(message, /Unauthorized|provider: 403/);
});

test("replay: Exa 402 envelope classifies as quota without exposing the body", async () => {
  const fixture = await loadFixture("exa-search-402.json");
  const error = await replayError(fixture);
  assert.equal(error.status, 402);
  assert.equal(error.body, fixture.responseBodyText);

  const { category, message } = classifyError(error);
  assert.equal(category, "quota");
  assert.equal(message, "Exa search failed with HTTP 402");
  assert.doesNotMatch(message, /X402_PAYMENT_REQUIRED|Payment required to access this resource/);
});

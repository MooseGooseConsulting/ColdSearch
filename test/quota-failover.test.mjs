import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FanoutEngine, AllProvidersFailedError } from "../dist/engine/fanout.js";
import { HTTPRequestError, isQuotaExhausted } from "../dist/http.js";
import { resolveCapabilityProviders } from "../dist/providers.js";
import { LocalExecutionBackend } from "../dist/execution/backend.js";
import { HistoryStore } from "../dist/history/store.js";
import { installFetchMock, jsonResponse } from "./adapters/_fetch-mock.mjs";

function fixture(t, capability, providers = ["firecrawl", "tavily", "exa"]) {
  const dir = mkdtempSync(join(tmpdir(), "coldsearch-quota-"));
  const random = Math.random;
  Math.random = () => 0;
  t.after(() => { Math.random = random; rmSync(dir, { recursive: true, force: true }); });
  return {
    capabilities: { [capability]: { providers, strategy: "random" } },
    providers: Object.fromEntries(["firecrawl", "tavily", "exa"].map((provider) => [provider, { keyPool: { keys: ["test-key"] } }])),
    logging: { usage: { path: join(dir, "usage.jsonl") } },
    dir,
  };
}

function quotaResponse(status = 402) {
  return jsonResponse({ success: false, error: "Insufficient credits" }, { status });
}

function successResponse(capability, provider) {
  if (provider === "tavily") {
    return jsonResponse({ results: [{ title: "A", url: "https://x.example", content: "body", raw_content: "body" }] });
  }
  if (capability === "search") return jsonResponse({ results: [] });
  return jsonResponse({ results: [{ url: "https://x.example", text: "body" }] });
}

test("quota detection handles HTTP statuses, native error text, and wrapped causes without treating generic failures as exhaustion", () => {
  for (const error of [
    new HTTPRequestError("failed", { url: "https://api.example", status: 402 }),
    new HTTPRequestError("failed", { url: "https://api.example", status: 403, body: '{"error":"Your monthly quota has been exceeded"}' }),
    new HTTPRequestError("failed", { url: "https://api.example", status: 429, body: '{"code":"insufficient_quota"}' }),
    new Error("Firecrawl error: You have used up your included credits"),
    new Error("Your account does not have enough credits"),
    new Error("Credit balance is too low"),
    new Error("You have exceeded your monthly usage limit"),
    new Error("Payment Required"),
    Object.assign(new Error("SDK error"), { statusCode: 402 }),
    new Error("crawl poll failed", { cause: new HTTPRequestError("failed", { url: "https://api.example", status: 403, body: "Out of credits" }) }),
  ]) assert.equal(isQuotaExhausted(error), true, error.message);
  for (const error of [
    new HTTPRequestError("failed", { url: "https://api.example", status: 429, body: "Rate limit exceeded" }),
    new HTTPRequestError("failed", { url: "https://api.example", status: 401, body: "Invalid API key" }),
    new Error("Invalid request: max_results exceeds limit"),
    new Error("Network timed out"),
  ]) assert.equal(isQuotaExhausted(error), false, error.message);
});

for (const capability of ["search", "extract", "crawl"]) {
  test(`${capability} success uses only the randomly selected provider`, async (t) => {
    const config = fixture(t, capability, ["tavily", "firecrawl", "exa"]);
    const calls = [];
    const restore = installFetchMock({ "*": async ({ url }) => {
      calls.push(url);
      assert.ok(url.includes("tavily.com"));
      return successResponse(capability, "tavily");
    } });
    t.after(restore);
    const out = await new FanoutEngine(config)[capability]("https://x.example", { limit: 1 });
    assert.equal(out.attempts.length, 1);
    assert.equal(calls.length, 1);
  });

  test(`${capability} recovers from a native quota rejection in an HTTP 200 response`, async (t) => {
    const config = fixture(t, capability);
    const restore = installFetchMock({ "*": async ({ url }) => url.includes("firecrawl.dev")
      ? jsonResponse({ success: false, error: "You have used up your included credits" })
      : successResponse(capability, "tavily") });
    t.after(restore);
    const out = await new FanoutEngine(config)[capability]("https://x.example", { limit: 1 });
    assert.equal(out.attempts[0].quota_exhausted, true);
    assert.equal(out.attempts[1].provider, "tavily");
    assert.equal(out.attempts[1].success, true);
  });

  for (const exhaustedProvider of ["firecrawl", "tavily"]) {
    test(`${capability} recovers from ${exhaustedProvider} quota exhaustion and logs both attempts`, async (t) => {
      const healthyProvider = exhaustedProvider === "firecrawl" ? "tavily" : "exa";
      const config = fixture(t, capability, [exhaustedProvider, healthyProvider, "firecrawl"]);
      const calls = [];
      const restore = installFetchMock({ "*": async ({ url }) => {
        calls.push(url);
        if (url.includes(exhaustedProvider === "firecrawl" ? "firecrawl.dev" : "tavily.com")) return quotaResponse();
        return successResponse(capability, healthyProvider);
      } });
      t.after(restore);
      const out = await new FanoutEngine(config)[capability]("https://x.example", { limit: 1 });
      assert.deepEqual(out.attempts.map(({ provider, success }) => ({ provider, success })), [
        { provider: exhaustedProvider, success: false }, { provider: healthyProvider, success: true },
      ]);
      assert.equal(out.attempts[0].quota_exhausted, true);
      assert.match(out.errors[exhaustedProvider], /HTTP 402/);
      assert.equal(calls.filter((url) => url.includes(exhaustedProvider === "firecrawl" ? "firecrawl.dev" : "tavily.com")).length, 1);
      assert.equal(capability === "search" ? out.providersUsed[0] : out.provider, healthyProvider);
      const log = readFileSync(config.logging.usage.path, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(log.length, 2);
      assert.equal(log[0].quota_exhausted, true);
      assert.equal(log[1].success, true);
      assert.ok(!readFileSync(config.logging.usage.path, "utf8").includes("test-key"));
    });
  }

  test(`${capability} quota recovery is bounded when every provider is exhausted`, async (t) => {
    const config = fixture(t, capability, ["firecrawl", "tavily", "firecrawl", "exa"]);
    const calls = [];
    const restore = installFetchMock({ "*": async ({ url }) => { calls.push(url); return quotaResponse(); } });
    t.after(restore);
    await assert.rejects(new FanoutEngine(config)[capability]("https://x.example", { limit: 1 }), (error) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.deepEqual(error.attempts.map(({ provider }) => provider), ["firecrawl", "tavily", "exa"]);
      assert.ok(error.attempts.every((attempt) => attempt.quota_exhausted && !attempt.success));
      return true;
    });
    assert.equal(calls.length, 3);
  });

  test(`${capability} keeps an explicit singleton scope even when its credits are exhausted`, async (t) => {
    const config = fixture(t, capability);
    const calls = [];
    const restore = installFetchMock({ "*": async ({ url }) => { calls.push(url); return quotaResponse(); } });
    t.after(restore);
    await assert.rejects(new FanoutEngine(config)[capability]("https://x.example", { limit: 1, providers: ["firecrawl"] }), AllProvidersFailedError);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("firecrawl.dev"));
  });

  test(`${capability} leaves non-quota random failures visible without widening routing`, async (t) => {
    const config = fixture(t, capability);
    const calls = [];
    const restore = installFetchMock({ "*": async ({ url }) => {
      calls.push(url);
      return jsonResponse({ error: "Invalid API key" }, { status: 401 });
    } });
    t.after(restore);
    await assert.rejects(new FanoutEngine(config)[capability]("https://x.example", { limit: 1 }), AllProvidersFailedError);
    assert.equal(calls.length, 1);
  });
}

test("quota recovery continues past an unavailable fallback and stops at success", async (t) => {
  const config = fixture(t, "extract", ["firecrawl", "tavily", "exa"]);
  const calls = [];
  const restore = installFetchMock({ "*": async ({ url }) => {
    calls.push(url);
    if (url.includes("firecrawl.dev")) return quotaResponse(403);
    if (url.includes("tavily.com")) return jsonResponse({ error: "Service unavailable" }, { status: 503 });
    return successResponse("extract", "exa");
  } });
  t.after(restore);
  const out = await new FanoutEngine(config).extract("https://x.example", { limit: 1 });
  assert.equal(out.provider, "exa");
  assert.equal(out.attempts.length, 3);
  assert.equal(calls.length, 3);
  assert.equal(out.attempts[1].quota_exhausted, undefined);
});

test("single-provider search recovers within an explicit multi-provider scope without fanout", async (t) => {
  const config = fixture(t, "search");
  config.capabilities.search.strategy = "all";
  const calls = [];
  const restore = installFetchMock({ "*": async ({ url }) => {
    calls.push(url);
    if (url.includes("tavily.com")) return quotaResponse();
    assert.ok(url.includes("exa.ai"), "must not leave the requested pool");
    return successResponse("search", "exa");
  } });
  t.after(restore);
  const out = await new FanoutEngine(config).search("q", { limit: 1, singleProvider: true, providers: ["tavily", "exa"] });
  assert.deepEqual(out.providersUsed, ["exa"]);
  assert.equal(calls.length, 2);
});

test("quota alternatives respect feature eligibility and do not mutate config pools", (t) => {
  const config = fixture(t, "extract");
  const before = [...config.capabilities.extract.providers];
  const plan = resolveCapabilityProviders(config, "extract", { requireFeatures: ["browserActions"] });
  assert.deepEqual(plan.providers, ["firecrawl"]);
  assert.deepEqual(plan.quotaFallbackProviders, []);
  assert.deepEqual(config.capabilities.extract.providers, before);
});

test("backend persists quota recovery as one partial execution with safe provider attempts", async (t) => {
  const config = fixture(t, "extract", ["firecrawl", "tavily"]);
  const configPath = join(config.dir, "config.toml");
  const historyPath = join(config.dir, "history.jsonl");
  writeFileSync(configPath, `
[capabilities.extract]
providers = ["firecrawl", "tavily"]
strategy = "random"
[providers.firecrawl.keyPool]
keys = ["test-key"]
[providers.tavily.keyPool]
keys = ["test-key"]
[cache]
enabled = false
[history]
path = ${JSON.stringify(historyPath)}
[logging.usage]
path = ${JSON.stringify(config.logging.usage.path)}
`);
  const restore = installFetchMock({ "*": async ({ url }) => url.includes("firecrawl.dev") ? quotaResponse() : successResponse("extract", "tavily") });
  t.after(restore);
  const out = await new LocalExecutionBackend(configPath).extract("https://x.example", { limit: 1 });
  assert.equal(out.provider, "tavily");
  const records = new HistoryStore({ path: historyPath }).list();
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "partial");
  assert.deepEqual(records[0].routing.providers_attempted, ["firecrawl", "tavily"]);
  assert.equal(records[0].attempts[0].quota_exhausted, true);
  assert.ok(!readFileSync(historyPath, "utf8").includes("test-key"));
});

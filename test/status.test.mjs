import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDoctorReport, buildStatus } from "../dist/status.js";
import { loadConfig } from "../dist/config.js";

/** Minimal keyless provider config that passes `config doctor` cleanly. */
function representativeConfig(dir) {
  return {
    capabilities: {
      search: { providers: ["searxng"], strategy: "random" },
      extract: { providers: [], strategy: "random" },
      crawl: { providers: [], strategy: "random" },
    },
    providers: {
      searxng: {
        keyPool: { keys: [] },
        options: { baseUrl: "https://search.example.internal" },
      },
    },
    cache: { path: path.join(dir, "cache") },
    logging: { usage: { path: path.join(dir, "usage.jsonl") } },
  };
}

test("doctor and status never invoke fetch (zero-network guard)", (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    throw new Error("unexpected network call from doctor/status");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-status-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = representativeConfig(dir);
  const configPath = path.join(dir, "config.toml");

  const report = buildDoctorReport(config, configPath);
  assert.equal(report.valid, true);
  assert.deepEqual(report.errors, []);

  const status = buildStatus(config, configPath);
  assert.equal(status.config_path, configPath);

  assert.deepEqual(calls, [], "doctor/status must never make network calls");
});

test("doctor never echoes the SearXNG baseUrl value in errors", () => {
  const report = buildDoctorReport(
    {
      capabilities: {
        search: { providers: ["searxng"], strategy: "random" },
        extract: { providers: [], strategy: "random" },
        crawl: { providers: [], strategy: "random" },
      },
      providers: {
        searxng: {
          keyPool: { keys: [] },
          options: { baseUrl: "sk-super-secret-abc" },
        },
      },
    },
    "/tmp/config.toml"
  );

  assert.equal(report.valid, false);
  const messages = [...report.errors, ...report.warnings]
    .map((issue) => issue.message)
    .join("\n");
  assert.match(messages, /baseUrl/);
  assert.doesNotMatch(messages, /sk-super-secret-abc/);
});

test("doctor skips the no-key warning when a key fallback exists", () => {
  const capability = { search: { providers: ["tavily"], strategy: "random" } };

  const withDefaultSecret = buildDoctorReport(
    {
      capabilities: capability,
      providers: {
        tavily: { keyPool: { keys: [], defaultSecretName: "MY_TAVILY_KEY" } },
      },
    },
    "/tmp/config.toml"
  );
  assert.doesNotMatch(
    withDefaultSecret.warnings.map((w) => w.message).join("\n"),
    /no key references configured/
  );

  // A built-in per-provider Doppler default (runtime fallback) suppresses it too.
  const withBuiltInDefault = buildDoctorReport(
    {
      capabilities: capability,
      providers: { tavily: { keyPool: { keys: [] } } },
    },
    "/tmp/config.toml"
  );
  assert.doesNotMatch(
    withBuiltInDefault.warnings.map((w) => w.message).join("\n"),
    /no key references configured/
  );

  // Control: a provider with neither a default nor a built-in fallback still warns.
  const withoutFallback = buildDoctorReport(
    {
      capabilities: { search: { providers: ["brightdata"], strategy: "random" } },
      providers: { brightdata: { keyPool: { keys: [] } } },
    },
    "/tmp/config.toml"
  );
  assert.match(
    withoutFallback.warnings.map((w) => w.message).join("\n"),
    /no key references configured/
  );
});

test("doctor flags a non-array capability providers as a config error", () => {
  const report = buildDoctorReport(
    {
      capabilities: {
        search: { providers: "tavily" },
        extract: { providers: [], strategy: "random" },
        crawl: { providers: [], strategy: "random" },
      },
      providers: { tavily: { keyPool: { keys: [] } } },
    },
    "/tmp/config.toml"
  );
  assert.equal(report.valid, false);
  assert.match(
    report.errors.map((e) => e.message).join("\n"),
    /providers must be an array/
  );
  assert.ok(report.errors.every((e) => e.category === "config"));

  // A capability with no `providers` key stays a warning, not an error.
  const missingProviders = buildDoctorReport(
    {
      capabilities: {
        search: {},
        extract: { providers: [], strategy: "random" },
        crawl: { providers: [], strategy: "random" },
      },
      providers: { tavily: { keyPool: { keys: [] } } },
    },
    "/tmp/config.toml"
  );
  assert.equal(missingProviders.valid, true);
});

test("doctor rejects non-table [capabilities] and [providers] sections", () => {
  // Arrays parse as TOML but are unusable by runtime routing, which indexes
  // these sections by name — structural error, not a missing-section case.
  const arrayReport = buildDoctorReport(
    {
      capabilities: [],
      providers: [],
    },
    "/tmp/config.toml"
  );
  assert.equal(arrayReport.valid, false);
  assert.match(
    arrayReport.errors.map((e) => e.message).join("\n"),
    /\[capabilities\] must be a table.*\[providers\] must be a table/s
  );
  assert.ok(arrayReport.errors.every((e) => e.category === "config"));

  // Scalars are structural errors too, not just missing sections.
  const scalarReport = buildDoctorReport(
    {
      capabilities: "search",
      providers: 42,
    },
    "/tmp/config.toml"
  );
  assert.equal(scalarReport.valid, false);
  assert.match(
    scalarReport.errors.map((e) => e.message).join("\n"),
    /\[capabilities\] must be a table.*\[providers\] must be a table/s
  );
  assert.ok(scalarReport.errors.every((e) => e.category === "config"));

  // A genuinely absent section keeps the missing-section message.
  const missingReport = buildDoctorReport({}, "/tmp/config.toml");
  assert.equal(missingReport.valid, false);
  assert.match(
    missingReport.errors.map((e) => e.message).join("\n"),
    /Missing \[capabilities\] section.*Missing \[providers\] section/s
  );
});

test("doctor rejects non-table capability entries as config errors", () => {
  for (const bad of ["x", [], 42]) {
    const report = buildDoctorReport(
      {
        capabilities: {
          search: bad,
          extract: { providers: [], strategy: "random" },
          crawl: { providers: [], strategy: "random" },
        },
        providers: {
          searxng: {
            keyPool: { keys: [] },
            options: { baseUrl: "https://search.example.internal" },
          },
        },
      },
      "/tmp/config.toml"
    );
    assert.equal(report.valid, false);
    assert.match(
      report.errors.map((e) => e.message).join("\n"),
      /Capability 'search' must be a table/
    );
  }
});

test("doctor rejects unsupported capability strategies as config errors", () => {
  const report = buildDoctorReport(
    {
      capabilities: {
        search: { providers: ["searxng"], strategy: "randmo-sk-pasted-credential" },
        extract: { providers: [], strategy: "random" },
        crawl: { providers: [], strategy: "random" },
      },
      providers: {
        searxng: {
          keyPool: { keys: [] },
          options: { baseUrl: "https://search.example.internal" },
        },
      },
    },
    "/tmp/config.toml"
  );
  assert.equal(report.valid, false);
  const messages = report.errors.map((e) => e.message).join("\n");
  assert.match(messages, /Capability 'search' strategy must be "all" or "random"/);
  // The invalid value is never echoed — it could be a pasted credential.
  assert.ok(!messages.includes("randmo-sk-pasted-credential"));
  assert.ok(report.errors.every((e) => e.category === "config"));

  // Absent strategy stays valid; supported values stay valid.
  const absent = buildDoctorReport(
    {
      capabilities: {
        search: { providers: ["searxng"] },
        extract: { providers: [], strategy: "random" },
        crawl: { providers: [], strategy: "all" },
      },
      providers: {
        searxng: {
          keyPool: { keys: [] },
          options: { baseUrl: "https://search.example.internal" },
        },
      },
    },
    "/tmp/config.toml"
  );
  assert.equal(absent.valid, true);
});

test("status summary is correct for a usage log larger than the read window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-status-"));
  try {
    const usagePath = path.join(dir, "usage.jsonl");
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const line = (provider, timestamp) =>
      JSON.stringify({ timestamp, provider, success: true, key: "k", response_time_ms: 1 });

    // > 2 MB of recent filler so the file exceeds the tail read window.
    const filler = Array.from({ length: 60000 }, () => line("bulk", recent)).join("\n");
    fs.writeFileSync(usagePath, `${filler}\n`);
    // Probe entries, then one entry older than the 7-day cutoff.
    const tail = [
      line("probe", recent),
      line("probe", recent),
      line("probe", recent),
      line("stale", stale),
    ].join("\n");
    fs.appendFileSync(usagePath, `${tail}\n`);
    assert.ok(fs.statSync(usagePath).size > 2 * 1024 * 1024, "fixture must exceed the window");

    const status = buildStatus(representativeConfig(dir), path.join(dir, "config.toml"));
    const summary = status.recent_usage_summary_7d;
    assert.ok(summary, "summary must be present");
    assert.deepEqual(summary.probe, { calls: 3, successes: 3, success_rate: 1 });
    // The 5000-line cap applies inside the tail window; the last 5000 lines
    // include the 4 appended tail lines, leaving 4996 bulk entries.
    assert.equal(summary.bulk.calls, 4996);
    assert.equal(summary.stale, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor validates [agent.llm]: provider, base_url, and model", () => {
  const withLlm = (overrides) => ({
    capabilities: {
      search: { providers: ["searxng"], strategy: "random" },
      extract: { providers: [], strategy: "random" },
      crawl: { providers: [], strategy: "random" },
    },
    providers: {
      searxng: {
        keyPool: { keys: [] },
        options: { baseUrl: "https://search.example.internal" },
      },
    },
    agent: {
      llm: {
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
        ...overrides,
      },
    },
  });
  const errorMessages = (config) =>
    buildDoctorReport(config, "/tmp/config.toml").errors.map((e) => e.message).join("\n");

  // A well-formed [agent.llm] adds no errors.
  assert.deepEqual(buildDoctorReport(withLlm({}), "/tmp/config.toml").errors, []);

  assert.match(errorMessages(withLlm({ provider: "anthropic" })), /\[agent\.llm\] provider must be one of/);
  assert.match(errorMessages(withLlm({ baseUrl: "not-a-url" })), /\[agent\.llm\] base_url must be a valid http\(s\) URL/);
  assert.match(errorMessages(withLlm({ baseUrl: 123 })), /\[agent\.llm\] base_url/);
  assert.match(errorMessages(withLlm({ model: "" })), /\[agent\.llm\] model must be a non-empty string/);
});

test("agent LLM env refs appear in doctor warnings and status missing_env_vars", (t) => {
  const varName = "COLDSEARCH_AGENT_TEST_MISSING_KEY";
  const previous = process.env[varName];
  delete process.env[varName];
  t.after(() => {
    if (previous === undefined) delete process.env[varName];
    else process.env[varName] = previous;
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-agent-env-ref-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    ...representativeConfig(dir),
    agent: { llm: { provider: "isoquant", keyRef: `env:${varName}`, reasoningEffort: "medium" } },
  };
  const report = buildDoctorReport(config, "/tmp/config.toml");
  assert.equal(report.valid, true);
  assert.ok(report.warnings.some((warning) => warning.category === "credentials" && warning.message.includes(varName)));
  const status = buildStatus(config, "/tmp/config.toml");
  assert.ok(status.missing_env_vars.some((entry) => entry.provider === "agent.llm" && entry.var === varName));
});

test("doctor classifies invalid agent reasoning and key refs as config errors", () => {
  const base = representativeConfig("/tmp");
  const report = buildDoctorReport({
    ...base,
    agent: { llm: { provider: "openrouter", reasoningEffort: "max", keyRef: "env:invalid-name" } },
  }, "/tmp/config.toml");
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.category === "config" && /key_ref/.test(error.message)));
  // `max` is a valid value for OpenRouter according to its current API guide.
  assert.ok(!report.errors.some((error) => /reasoning_effort/.test(error.message)));
  const unsupported = buildDoctorReport({
    ...base,
    agent: { llm: { provider: "isoquant", reasoningEffort: "xhigh" } },
  }, "/tmp/config.toml");
  assert.ok(unsupported.errors.some((error) => error.category === "config" && /reasoning_effort/.test(error.message)));
});

test("doctor validates TOML snake-case agent fields and Doppler Permissive references", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-agent-toml-"));
  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(configPath, `
[capabilities.search]
providers = ["searxng"]
[capabilities.extract]
providers = []
[capabilities.crawl]
providers = []
[providers.searxng.options]
baseUrl = "https://search.example.internal"
[agent.llm]
provider = "openrouter"
reasoning_effort = "xhigh"
key_ref = "doppler:project/isoquant.api-key:prod-v2"
`);
    const config = loadConfig(configPath);
    const report = buildDoctorReport(config, configPath);
    assert.equal(report.valid, true, JSON.stringify(report.errors));
    assert.deepEqual(report.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig survives a non-table [agent.llm] and doctor flags it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-status-"));
  try {
    const configPath = path.join(dir, "config.toml");
    fs.writeFileSync(
      configPath,
      `
[capabilities.search]
providers = []

[providers]

[agent]
llm = "just-a-string"
`.trim() + "\n",
      "utf8"
    );

    const config = loadConfig(configPath); // must not throw
    const report = buildDoctorReport(config, configPath);
    assert.equal(report.valid, false);
    assert.match(
      report.errors.map((e) => e.message).join("\n"),
      /\[agent\.llm\] must be a table/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

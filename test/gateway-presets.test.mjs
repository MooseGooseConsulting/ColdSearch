import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  GatewayCore,
  UPSTREAM_PRESETS,
  classifyFault,
  connectOpenApi,
  defaultConnector,
  formatToolReports,
  listUpstreamTools,
  packageRoot,
  resolveGatewayConfig,
  resolveSpecLocation,
  toolAllowed,
} from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const OFFERED = JSON.parse(readFileSync(path.join(here, "fixtures", "gateway", "offered-tools.json"), "utf8"));
const SECRETS = { "env:KEY_A": "secret-value-aaaaaa", "env:KEY_B": "secret-value-bbbbbb" };
const resolveKey = async (ref) => SECRETS[ref];
const ctx = { session: "s1", client: "test/1.0" };
const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "cs-gwp-"));
}

/** A config block for a preset: keys unless it is keyless, and an address when the preset has none. */
function block(name, extra = {}) {
  const preset = UPSTREAM_PRESETS[name];
  return {
    ...(preset.auth === "none" ? {} : { keys: ["env:KEY_A"] }),
    ...(preset.url ? {} : { url: "http://127.0.0.1:9" }),
    ...extra,
  };
}

function makeConfig(dir, upstreams) {
  return resolveGatewayConfig({
    ledger: path.join(dir, "ledger.jsonl"),
    state: path.join(dir, "state.json"),
    skills_dir: path.join(dir, "skills"),
    upstreams,
  });
}

function upstreamOf(name, extra = {}) {
  return resolveGatewayConfig({ upstreams: { [name]: block(name, extra) } }).upstreams[0];
}

/** A fake upstream that offers `names` and records every call it receives. */
function fakeUpstream(names) {
  const calls = [];
  const connector = async () => ({
    listTools: async () => ({ tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      return ok({ done: name });
    },
    close: async () => undefined,
  });
  return { connector, calls };
}

const exposedOf = (name, extra) => {
  const upstream = upstreamOf(name, extra);
  return OFFERED[name].filter((tool) => toolAllowed(upstream, tool));
};

// --- presets -----------------------------------------------------------------

const PRESET_NAMES = [
  "exa", "examcp", "exaadmin",
  "firecrawl", "firecrawlmcp",
  "parallel", "parallelmcp",
  "tavily", "tavilymcp", "tavilykeys",
  "brightdata", "brightdatamcp",
  "tinyfish", "tinyfishapi", "tinyfishanswer",
  "context", "contextmcp",
  "jina", "jinamcp",
  "kagi", "perplexity", "serper",
  "brave", "braveanswers",
  "searxng",
];

test("every preset resolves from a block that names only its keys", () => {
  assert.deepEqual(Object.keys(UPSTREAM_PRESETS).sort(), [...PRESET_NAMES].sort());
  for (const name of PRESET_NAMES) {
    const upstream = upstreamOf(name);
    const preset = UPSTREAM_PRESETS[name];
    assert.equal(upstream.kind, preset.kind, name);
    assert.equal(upstream.curation, "preset", name);
    assert.doesNotThrow(() => new URL(upstream.url), name);
    if (upstream.kind === "openapi") {
      assert.ok(upstream.specs.length > 0, `${name} has no spec`);
      for (const spec of upstream.specs) {
        // A shipped document is an absolute path to a file that exists; anything else is an https URL.
        assert.ok(/^https:\/\//.test(spec) || (path.isAbsolute(spec) && existsSync(spec)), `${name}: ${spec}`);
      }
    } else {
      assert.deepEqual(upstream.specs, [], name);
    }
    // Every pattern a preset carries is in force, and each hidden group says why.
    const hides = (preset.hide ?? []).flatMap((rule) => rule.patterns);
    assert.deepEqual([...upstream.exclude].sort(), [...hides].sort(), name);
    assert.deepEqual(upstream.include, preset.include ?? [], name);
    for (const rule of upstream.hidden) assert.ok(rule.note.length > 0, `${name} ${rule.reason} has no note`);
    assert.equal(upstream.pins.length, Object.keys(preset.pin ?? {}).length, name);
  }
});

test("searxng has no default address, and says so", () => {
  assert.throws(
    () => resolveGatewayConfig({ upstreams: { searxng: {} } }),
    /upstreams\.searxng\.url is required: the "searxng" preset has no default address/
  );
  const searxng = upstreamOf("searxng", { url: "http://localhost:8080" });
  assert.equal(searxng.auth, "none");
  assert.deepEqual(searxng.keys, []);
});

test("brightdata is the REST API with the key as a bearer token, and brightdatamcp the hosted server", () => {
  const api = upstreamOf("brightdata");
  assert.deepEqual([api.kind, api.url, api.auth, api.authName, api.authPrefix], ["openapi", "https://api.brightdata.com", "header", "Authorization", "Bearer "]);
  assert.equal(api.specs.length, 10);
  const hosted = upstreamOf("brightdatamcp");
  assert.deepEqual([hosted.kind, hosted.url, hosted.auth, hosted.authName], ["mcp", "https://mcp.brightdata.com/mcp", "query", "token"]);
});

// --- shipped documents -------------------------------------------------------

test("package: names a file shipped with ColdSearch, wherever the process was started", async () => {
  assert.equal(packageRoot(), repoRoot);
  assert.equal(resolveSpecLocation("package:specs/serper.yaml", "spec"), path.join(repoRoot, "specs", "serper.yaml"));
  assert.equal(resolveSpecLocation("https://example.com/openapi.json", "spec"), "https://example.com/openapi.json");
  assert.equal(resolveSpecLocation("relative/file.yaml", "spec"), "relative/file.yaml");
  for (const bad of ["package:", "package:../outside.yaml", "package:specs/../../outside.yaml", "package:/etc/hosts", "package:specs//serper.yaml"]) {
    assert.throws(
      () => resolveGatewayConfig({ upstreams: { custom: { kind: "openapi", url: "https://api.example.com", spec: bad, auth: "none" } } }),
      /upstreams\.custom\.spec ".*" must be package:<path inside the ColdSearch package>/,
      bad
    );
  }

  // A block may use the prefix too, and the file is found from another working directory.
  const started = process.cwd();
  process.chdir(tempDir());
  try {
    const [custom] = resolveGatewayConfig({
      upstreams: { custom: { kind: "openapi", url: "https://api.example.com", spec: "package:specs/searxng.yaml", auth: "none" } },
    }).upstreams;
    assert.deepEqual(custom.specs, [path.join(repoRoot, "specs", "searxng.yaml")]);
    const client = await connectOpenApi(custom, "");
    assert.equal((await client.listTools()).tools.length, 4);
  } finally {
    process.chdir(started);
  }
});

const AUTHORED = [
  // [file, operations, operations confirmed against the live API]
  ["serper.yaml", 15, ["locations"]],
  ["brave.yaml", 16, []],
  ["searxng.yaml", 4, []],
  ["firecrawl-additions.yaml", 6, []],
  ["parallel-suggest.yaml", 2, []],
];
const METHODS = ["get", "post", "put", "patch", "delete"];

for (const [file, count, confirmed] of AUTHORED) {
  test(`specs/${file} is an OpenAPI 3.1 document with ${count} operations, each naming its source`, async () => {
    const location = path.join(repoRoot, "specs", file);
    const doc = parseYaml(readFileSync(location, "utf8"));
    assert.match(doc.openapi, /^3\.1\.\d+$/);
    assert.equal(typeof doc.info.title, "string");
    assert.equal(typeof doc.info.version, "string");

    const ids = [];
    for (const [route, item] of Object.entries(doc.paths)) {
      assert.ok(route.startsWith("/"), route);
      for (const method of Object.keys(item)) {
        assert.ok(METHODS.includes(method), `${route} has a key that is not a method: ${method}`);
        const operation = item[method];
        const at = `${method.toUpperCase()} ${route}`;
        ids.push(operation.operationId);
        assert.match(operation.operationId, /^[A-Za-z][A-Za-z0-9_]*$/, at);
        assert.ok(operation.summary?.length > 0, `${at} has no summary`);
        assert.match(operation.description, /Source: \S/, `${at} does not name its source`);
        const unverified = /unverified against the live API/.test(operation.description);
        assert.equal(unverified, !confirmed.includes(operation.operationId), `${at}: wrong "unverified against the live API" marking`);

        const responses = Object.entries(operation.responses ?? {});
        assert.ok(responses.length > 0, `${at} has no responses`);
        for (const [status, response] of responses) {
          assert.match(status, /^[1-5]\d\d$/, at);
          assert.ok(response.$ref ? response.$ref.startsWith("#/components/responses/") : response.description?.length > 0, `${at} ${status}`);
        }
        const local = (node) => (node?.$ref ? node.$ref.slice(2).split("/").reduce((at, key) => at[key], doc) : node);
        const declared = (operation.parameters ?? []).map((entry) => {
          const parameter = local(entry);
          assert.ok(["query", "path", "header"].includes(parameter.in), `${at} ${parameter.name}`);
          assert.ok(parameter.schema && typeof parameter.schema === "object", `${at} ${parameter.name} has no schema`);
          if (parameter.in === "path") assert.equal(parameter.required, true, `${at} ${parameter.name}`);
          return parameter;
        });
        for (const [, name] of route.matchAll(/\{([^}]+)\}/g)) {
          assert.ok(declared.some((parameter) => parameter.in === "path" && parameter.name === name), `${at} does not declare {${name}}`);
        }
        if (operation.requestBody) {
          assert.equal(local(operation.requestBody.content["application/json"].schema).type, "object", at);
        }
      }
    }
    assert.equal(new Set(ids).size, ids.length, "operation ids repeat");
    assert.equal(ids.length, count);

    // The gateway's own loader builds one tool per operation, named by its id.
    const [upstream] = resolveGatewayConfig({
      upstreams: { custom: { kind: "openapi", url: "https://api.example.com", spec: location, auth: "none" } },
    }).upstreams;
    const { tools } = await (await connectOpenApi(upstream, "")).listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...ids].sort());
    for (const tool of tools) assert.equal(tool.inputSchema.type, "object");
  });
}

test("serper's three hosts are reached through operation-level servers, with the key in X-API-KEY", async () => {
  const upstream = upstreamOf("serper");
  const client = await connectOpenApi(upstream, "secret-value-aaaaaa");
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init.method, key: new Headers(init.headers).get("x-api-key"), body: init.body });
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  };
  try {
    await client.callTool({ name: "search", arguments: { q: "llama", num: 5 } });
    await client.callTool({ name: "webpage", arguments: { url: "https://example.com/a", includeMarkdown: true } });
    await client.callTool({ name: "locations", arguments: { q: "Austin", limit: 3 } });
    await client.callTool({ name: "account", arguments: {} });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    "POST https://google.serper.dev/search",
    "POST https://scrape.serper.dev/",
    "GET https://api.serper.dev/locations?q=Austin&limit=3",
    "GET https://google.serper.dev/account",
  ]);
  assert.deepEqual(JSON.parse(requests[0].body), { q: "llama", num: 5 });
  assert.deepEqual(JSON.parse(requests[1].body), { url: "https://example.com/a", includeMarkdown: true });
  assert.ok(requests.every((request) => request.key === "secret-value-aaaaaa"));
});

test("a searxng search always asks for JSON, at the address the config gives", async () => {
  const dir = tempDir();
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ query: "llama", results: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const core = new GatewayCore(makeConfig(dir, { searxng: { url: `http://127.0.0.1:${server.address().port}` } }), { resolveKey });
    assert.deepEqual((await core.listTools()).map((entry) => entry.name), [
      "searxng__search",
      "searxng__autocomplete",
      "searxng__config",
      "searxng__healthz",
    ]);
    const result = await core.callTool("searxng__search", { q: "llama", categories: "general" }, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(seen, ["/search?q=llama&format=json&categories=general"]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- default tool lists ------------------------------------------------------

/**
 * Tools each preset exposes, of the tool names recorded in
 * fixtures/gateway/offered-tools.json. These are the counts in
 * docs/PROVIDERS.md, "Gateway upstreams".
 */
const EXPOSED = {
  exa: 8, examcp: 3, exaadmin: 1,
  firecrawl: 33, firecrawlmcp: 8,
  parallel: 18, parallelmcp: 9,
  tavily: 6, tavilymcp: 5, tavilykeys: 1,
  brightdata: 13, brightdatamcp: 13,
  tinyfish: 8, tinyfishapi: 6, tinyfishanswer: 1,
  context: 13, contextmcp: 1,
  jina: 12, jinamcp: 12,
  kagi: 2, perplexity: 4, serper: 14,
  brave: 9, braveanswers: 1,
  searxng: 4,
};

test("each preset exposes the documented number of the tools its provider offers", () => {
  assert.deepEqual(Object.keys(EXPOSED).sort(), [...PRESET_NAMES].sort());
  for (const name of PRESET_NAMES) {
    assert.equal(exposedOf(name).length, EXPOSED[name], `${name} exposes ${exposedOf(name).join(", ")}`);
  }
});

test("every tool the search-routing skill names is one its preset exposes by default", () => {
  const skill = readFileSync(path.join(repoRoot, "skills", "search-routing", "SKILL.md"), "utf8");
  const named = [...new Set([...skill.matchAll(/`([a-z0-9]+)__([A-Za-z0-9_-]+)`/g)].map(([, upstream, tool]) => `${upstream}__${tool}`))];
  assert.ok(named.length >= 10, "the skill names no gateway tools");
  for (const name of named) {
    const [upstream, tool] = name.split("__");
    assert.ok(PRESET_NAMES.includes(upstream), `${name}: no such preset`);
    assert.ok(exposedOf(upstream).includes(tool), `${name} is not exposed by default`);
  }
});

test("no preset exposes a tool that deletes, pays, manages the account, sends feedback or sets up a schedule", () => {
  const risky = /delete|remove|clear|evict|password|api_?key|top_?up|wallet|recharge|payment|feedback|webhook|monitor|polic|usage|rotate|deactivate|generate_keys|zone(?!s$)/i;
  // Closing something the agent itself opened is not a deletion of anything shared.
  const allowed = new Set(["firecrawl__deleteBrowserSession", "firecrawl__delete_scrape_jobId_interact"]);
  for (const name of PRESET_NAMES) {
    const exposed = exposedOf(name).filter((tool) => risky.test(tool) && !allowed.has(`${name}__${tool}`));
    assert.deepEqual(exposed, [], `${name} exposes ${exposed.join(", ")}`);
  }
});

test("a preset's hidden tools are neither listed nor callable, and its pins reach the call", async () => {
  const dir = tempDir();
  const { connector, calls } = fakeUpstream(OFFERED.tavily);
  const core = new GatewayCore(makeConfig(dir, { tavily: { keys: ["env:KEY_A"] } }), { connector, resolveKey });

  assert.deepEqual((await core.listTools()).map((entry) => entry.name).sort(), [
    "tavily__crawl",
    "tavily__createResearch",
    "tavily__extract",
    "tavily__getResearch",
    "tavily__map",
    "tavily__search",
  ]);
  for (const hidden of ["post_feedback", "getUsage", "post_logs", "post_org_usage"]) {
    const refused = await core.callTool(`tavily__${hidden}`, {}, ctx);
    assert.equal(refused.isError, true, hidden);
    assert.match(refused.content[0].text, /is not offered by this gateway/);
  }
  assert.deepEqual(calls, [], "a hidden tool reached the upstream");

  await core.callTool("tavily__createResearch", { input: "what changed" }, ctx);
  await core.callTool("tavily__createResearch", { input: "what changed", model: "pro" }, ctx);
  await core.callTool("tavily__search", { query: "llama" }, ctx);
  assert.deepEqual(calls, [
    { name: "createResearch", args: { input: "what changed", model: "mini" } },
    { name: "createResearch", args: { input: "what changed", model: "pro" } },
    { name: "search", args: { query: "llama", include_usage: true } },
  ]);
});

test("the pinned defaults and caps for expensive tools are the documented ones", async () => {
  const dir = tempDir();
  const sent = {};
  const connector = async (upstream) => ({
    listTools: async () => ({ tools: [] }),
    callTool: async ({ name, arguments: args }) => {
      sent[`${upstream.name}__${name}`] = args;
      return ok({});
    },
    close: async () => undefined,
  });
  const names = ["exa", "firecrawl", "firecrawlmcp", "parallel", "context", "brightdata"];
  const core = new GatewayCore(makeConfig(dir, Object.fromEntries(names.map((name) => [name, block(name)]))), { connector, resolveKey });

  await core.callTool("exa__createAgentRun", { query: "q" }, ctx);
  assert.deepEqual(sent.exa__createAgentRun, { query: "q", effort: "low", budget: { maxCostDollars: 2 } });
  const raised = await core.callTool("exa__createAgentRun", { query: "q", effort: "ultra", budget: { maxCostDollars: 20 } }, ctx);
  assert.deepEqual(sent.exa__createAgentRun, { query: "q", effort: "ultra", budget: { maxCostDollars: 5 } });
  assert.match(raised.content.at(-1).text, /"budget\.maxCostDollars" was lowered from 20 to 5/);

  await core.callTool("firecrawl__startAgent", { prompt: "p" }, ctx);
  assert.deepEqual(sent.firecrawl__startAgent, { prompt: "p", maxCredits: 200 });
  await core.callTool("firecrawl__startAgent", { prompt: "p", maxCredits: 2500 }, ctx);
  assert.equal(sent.firecrawl__startAgent.maxCredits, 500);
  await core.callTool("firecrawl__crawlUrls", { url: "https://example.com" }, ctx);
  assert.deepEqual(sent.firecrawl__crawlUrls, { url: "https://example.com", limit: 50 });

  await core.callTool("firecrawlmcp__people_company_enrich", { objective: "o" }, ctx);
  assert.deepEqual(sent.firecrawlmcp__people_company_enrich, { objective: "o", max_credits: 100 });

  await core.callTool("parallel__post_v1_search", { objective: "o" }, ctx);
  assert.deepEqual(sent.parallel__post_v1_search, { objective: "o", mode: "fast" });
  await core.callTool("parallel__post_v1_search", { objective: "o", mode: "advanced" }, ctx);
  assert.equal(sent.parallel__post_v1_search.mode, "advanced", "a pin default must not override the agent's choice");
  await core.callTool("parallel__post_v1_responses", { input: "i" }, ctx);
  assert.deepEqual(sent.parallel__post_v1_responses, { input: "i", reasoning: { effort: "low" } });

  await core.callTool("context__post_web_answers", { task: "t" }, ctx);
  assert.deepEqual(sent.context__post_web_answers, { task: "t", mode: "fast" });

  // A Bright Data discover job bills every record it finds, so both of its limits are filled in and capped.
  const discover = { dataset_id: "gd_example", type: "discover_new", discover_by: "keyword", body: [{ keyword: "k" }] };
  await core.callTool("brightdata__triggerScrape", discover, ctx);
  assert.deepEqual(sent.brightdata__triggerScrape, { ...discover, limit_per_input: 10, limit_multiple_results: 100 });
  const lowered = await core.callTool("brightdata__triggerScrape", { ...discover, limit_per_input: 5000, limit_multiple_results: 50000 }, ctx);
  assert.deepEqual(sent.brightdata__triggerScrape, { ...discover, limit_per_input: 100, limit_multiple_results: 1000 });
  assert.match(lowered.content.at(-2).text, /"limit_per_input" was lowered from 5000 to 100/);
  assert.match(lowered.content.at(-1).text, /"limit_multiple_results" was lowered from 50000 to 1000/);
});

test("the Bright Data scraper catalogue is never asked for whole", async () => {
  const dir = tempDir();
  const { connector, calls } = fakeUpstream(OFFERED.brightdata);
  const core = new GatewayCore(makeConfig(dir, { brightdata: block("brightdata") }), { connector, resolveKey });

  // Unfiltered, the vendor's answer is several megabytes: the call is refused before it is made.
  for (const args of [undefined, {}, { domain: "" }, { dataset_id: null }]) {
    const refused = await core.callTool("brightdata__listScrapers", args, ctx);
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(refused.content[0].text, /^brightdata__listScrapers needs "dataset_id" or "domain": this gateway does not make the call without one of them\./);
  }
  assert.deepEqual(calls, [], "an unfiltered catalogue request reached the upstream");

  await core.callTool("brightdata__listScrapers", { domain: "example.com" }, ctx);
  await core.callTool("brightdata__listScrapers", { dataset_id: "gd_example" }, ctx);
  assert.deepEqual(calls, [
    { name: "listScrapers", args: { domain: "example.com" } },
    { name: "listScrapers", args: { dataset_id: "gd_example" } },
  ]);

  // A block may set the same guard, and a block's pin table replaces the preset's, guard included.
  const custom = upstreamOf("tavily", { pin: { search: { require_one_of: ["query"] } } });
  assert.deepEqual(custom.pins, [{ pattern: "search", defaults: [], max: [], requireOneOf: ["query"] }]);
  assert.deepEqual(upstreamOf("brightdata", { pin: {} }).pins, []);
  for (const bad of [[], "domain", ["domain", 3], ["a..b"]]) {
    assert.throws(
      () => upstreamOf("tavily", { pin: { search: { require_one_of: bad } } }),
      /upstreams\.tavily\.pin\."search"\.require_one_of must be a list of argument names/,
      JSON.stringify(bad)
    );
  }
});

test("every pinned tool is one its preset exposes", () => {
  for (const name of PRESET_NAMES) {
    const exposed = exposedOf(name);
    for (const pattern of Object.keys(UPSTREAM_PRESETS[name].pin ?? {})) {
      assert.ok(exposed.some((tool) => new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(tool)), `${name}: the pin "${pattern}" matches no exposed tool`);
    }
  }
});

// --- spend and cancelling ----------------------------------------------------

test("no preset exposes a tool that takes a list of paid runs in one call", async () => {
  // Each queues many agent runs or tasks at once, priced per run by values inside the list, where no pin reaches.
  const batches = { tinyfishapi: ["runBatch"], parallel: ["post_v1_tasks_groups", "post_v1_tasks_groups_taskgroup_id_runs"] };
  for (const [name, tools] of Object.entries(batches)) {
    for (const tool of tools) {
      assert.ok(OFFERED[name].includes(tool), `${name}: ${tool} is not a tool the provider offers`);
      assert.ok(!exposedOf(name).includes(tool), `${name} exposes ${tool}`);
    }
  }

  assert.deepEqual(exposedOf("tinyfishapi").sort(), ["batchCancelRuns", "cancelRunById", "getBrowserContextProfile", "getRunById", "getStepHtml", "run"]);
  const { connector, calls } = fakeUpstream(OFFERED.tinyfishapi);
  const config = makeConfig(tempDir(), { tinyfishapi: block("tinyfishapi") });
  const [report] = await listUpstreamTools(config, { connector, resolveKey });
  assert.deepEqual(report.hidden.find((entry) => entry.tool === "runBatch"), { tool: "runBatch", reason: "spend" });
  const refused = await new GatewayCore(config, { connector, resolveKey }).callTool(
    "tinyfishapi__runBatch",
    { runs: [{ url: "https://example.com", goal: "g" }] },
    ctx
  );
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, [], "a batch of runs reached the upstream");
});

test("whatever a preset lets an agent start, it lets the agent cancel", () => {
  // [what starts or tracks a job, what cancels it], for every job the providers offer a cancel for.
  const pairs = {
    exa: [["createAgentRun", "cancelAgentRun"]],
    firecrawl: [["crawlUrls", "cancelCrawl"], ["scrapeAndExtractFromUrls", "cancelBatchScrape"], ["startAgent", "cancelAgent"]],
    brightdata: [["triggerScrape", "cancelScrape"]],
    tinyfish: [["run_web_automation_async", "cancel_run"], ["batch_status", "batch_cancel"]],
    tinyfishapi: [["runAsync", "cancelRunById"], ["runBatch", "batchCancelRuns"], ["getRunById", "cancelRunById"]],
    context: [["submitBatch", "cancelBatch"]],
  };
  for (const [name, list] of Object.entries(pairs)) {
    const exposed = exposedOf(name);
    for (const [starter, canceller] of list) {
      for (const tool of [starter, canceller]) assert.ok(OFFERED[name].includes(tool), `${name}: ${tool} is not a tool the provider offers`);
      if (exposed.includes(starter)) assert.ok(exposed.includes(canceller), `${name} exposes ${starter} without ${canceller}`);
    }
  }
});

// --- overriding --------------------------------------------------------------

test('curation = "none" exposes everything except tools that return credentials', async () => {
  const { connector, calls } = fakeUpstream(OFFERED.tavilykeys);
  const listed = async (extra) => {
    const core = new GatewayCore(makeConfig(tempDir(), { tavilykeys: { keys: ["env:KEY_A"], ...extra } }), { connector, resolveKey });
    return { core, names: (await core.listTools()).map((entry) => entry.name) };
  };

  assert.deepEqual((await listed({})).names, ["tavilykeys__get_key_info"]);

  const open = await listed({ curation: "none" });
  assert.deepEqual(open.names, ["tavilykeys__get_key_info", "tavilykeys__post_deactivate_keys"]);
  assert.equal(open.core.config.upstreams[0].curation, "none");
  const refused = await open.core.callTool("tavilykeys__post_generate_keys", { count: 1 }, ctx);
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, [], "a credential tool reached the upstream");

  const all = await listed({ curation: "none", allow_credential_tools: true });
  assert.deepEqual(all.names.sort(), ["tavilykeys__get_key_info", "tavilykeys__post_deactivate_keys", "tavilykeys__post_generate_keys"]);

  // With every preset: none of the tools hidden for credentials shows up, and everything else does.
  for (const name of PRESET_NAMES) {
    const credentialPatterns = (UPSTREAM_PRESETS[name].hide ?? []).filter((rule) => rule.reason === "credentials").flatMap((rule) => rule.patterns);
    const exposed = exposedOf(name, { curation: "none" });
    assert.equal(exposed.length, OFFERED[name].length - credentialPatterns.length, name);
    for (const tool of credentialPatterns) {
      assert.ok(OFFERED[name].includes(tool), `${name}: ${tool} is not a tool the provider offers`);
      assert.ok(!exposed.includes(tool), `${name} exposes ${tool}`);
    }
    assert.deepEqual(upstreamOf(name, { curation: "none" }).pins, [], name);
  }
});

test("the tools that return credentials are named, and stay hidden under a block's own lists", () => {
  const credentialTools = Object.fromEntries(
    PRESET_NAMES.map((name) => [name, (UPSTREAM_PRESETS[name].hide ?? []).filter((rule) => rule.reason === "credentials").flatMap((rule) => rule.patterns)]).filter(
      ([, tools]) => tools.length > 0
    )
  );
  assert.deepEqual(credentialTools, {
    exa: ["createMonitor", "webhooks_create"],
    exaadmin: ["list_api_keys", "create_api_key", "get_api_key", "update_api_key", "rotate_api_key", "get_api_key_usage"],
    tavilykeys: ["post_generate_keys"],
    brightdata: ["listZonePasswords", "addZonePassword", "removeZonePassword", "getZone", "getDatasetViewDeliverySettings"],
    context: ["rotateMonitorWebhookSecret", "createMonitor", "getMonitor", "listMonitors", "updateMonitor", "submitBatch"],
    perplexity: ["createMonitor", "updateMonitor"],
  });
  for (const extra of [{ exclude: [] }, { include: ["*"] }, { include: ["listZonePasswords"], exclude: [] }, { curation: "none", include: ["*Zone*"] }]) {
    assert.ok(!exposedOf("brightdata", extra).includes("listZonePasswords"), JSON.stringify(extra));
  }
  assert.ok(exposedOf("brightdata", { include: ["listZonePasswords"], allow_credential_tools: true }).includes("listZonePasswords"));
  assert.throws(() => upstreamOf("brightdata", { allow_credential_tools: "yes" }), /upstreams\.brightdata\.allow_credential_tools must be true or false/);
  assert.throws(() => upstreamOf("exa", { curation: "off" }), /upstreams\.exa\.curation must be "preset" or "none"/);
});

test("a block's include, exclude or pin replaces the preset's value for that setting only", () => {
  // exclude: the preset's reasons go, the block's list stays; include and pin keep the preset's.
  const tavily = upstreamOf("tavily", { exclude: ["extract"] });
  assert.deepEqual(tavily.exclude, ["extract"]);
  assert.deepEqual(tavily.hidden, [{ reason: "config", patterns: ["extract"], note: "this block's exclude list" }]);
  assert.equal(tavily.pins.length, 6);
  assert.deepEqual(exposedOf("tavily", { exclude: ["extract"] }).sort(), OFFERED.tavily.filter((tool) => tool !== "extract").sort());
  assert.equal(exposedOf("tavily", { exclude: [] }).length, 10);

  // include: replaces an allowlist preset's list; the block's exclude is still its own.
  assert.deepEqual(exposedOf("firecrawlmcp", { include: ["firecrawl_scrape", "jobs_search"] }).sort(), ["firecrawl_scrape", "jobs_search"]);
  assert.deepEqual(exposedOf("firecrawlmcp", { exclude: ["people_*"] }).length, 6, "the preset's include still applies when only exclude is set");
  // include on a preset that hides by exclude narrows it further; the hidden tools stay hidden.
  assert.deepEqual(exposedOf("exa", { include: ["search", "delete*"] }), ["search"]);

  // pin: replaces every preset pin.
  const exa = upstreamOf("exa", { pin: { search: { max: { numResults: 5 } } } });
  assert.deepEqual(exa.pins, [{ pattern: "search", defaults: [], max: [{ path: "numResults", limit: 5 }] }]);
  assert.equal(exa.exclude.length > 0, true, "setting pin must not drop the preset's hidden tools");
  assert.deepEqual(upstreamOf("exa", { pin: {} }).pins, []);
});

test("a block that changes a preset's kind gets none of the preset's tool lists", () => {
  const hosted = upstreamOf("brightdata", { kind: "mcp", url: "https://mcp.brightdata.com/mcp", auth: "query", auth_name: "token" });
  assert.deepEqual([hosted.kind, hosted.include, hosted.exclude, hosted.pins, hosted.curation], ["mcp", [], [], [], "none"]);
});

/**
 * Operations whose published success response documents a key, password or
 * signing secret, with the field that carries it. Read from the vendors' API
 * documents on 2026-11-27 by scanning every 2xx response schema and example
 * for secret-like field names, then reading what each document says of the
 * field. Left out after reading: Exa's webhook reads and updates (`secret` is
 * "only returned on Webhook creation"), Perplexity's monitor reads, pause and
 * resume (`secret` is "present only in the response that generated it"),
 * Firecrawl's `apiKey` (a key's name) and Tavily's `api_key` (masked to four
 * characters). The `mcp` presets publish no response schemas to scan.
 */
const SECRET_RESPONSES = {
  exa: { createMonitor: "webhookSecret", webhooks_create: "secret" },
  exaadmin: { create_api_key: "apiKey.secret", rotate_api_key: "apiKey.secret" },
  tavilykeys: { post_generate_keys: "keys" },
  brightdata: {
    listZonePasswords: "passwords",
    getZone: "password",
    getDatasetViewDeliverySettings: "deliver.credentials",
  },
  context: {
    createMonitor: "webhook.secret",
    getMonitor: "webhook.secret",
    listMonitors: "webhook.secret",
    updateMonitor: "webhook.secret",
    rotateMonitorWebhookSecret: "secret",
    submitBatch: "webhook_secret",
  },
  perplexity: { createMonitor: "webhook.secret", updateMonitor: "webhook.secret" },
};

test("no block reaches an operation whose response carries a secret without allow_credential_tools", async () => {
  // What a config block following docs/components/gateway.md may set, and still not get these tools.
  const blocks = [{}, { exclude: [] }, { exclude: ["post_people_*"] }, { include: ["*"] }, { curation: "none" }, { curation: "none", include: ["*"], exclude: [] }];
  for (const [name, tools] of Object.entries(SECRET_RESPONSES)) {
    const credentialPatterns = UPSTREAM_PRESETS[name].hide.filter((rule) => rule.reason === "credentials").flatMap((rule) => rule.patterns);
    for (const [tool, field] of Object.entries(tools)) {
      assert.ok(OFFERED[name].includes(tool), `${name}: ${tool} is not a tool the provider offers`);
      assert.ok(credentialPatterns.includes(tool), `${name}__${tool} answers with ${field} and is not hidden for credentials`);
      for (const extra of blocks) {
        assert.ok(!exposedOf(name, extra).includes(tool), `${name}__${tool} (${field}) is exposed by ${JSON.stringify(extra)}`);
      }
      assert.ok(exposedOf(name, { curation: "none", allow_credential_tools: true }).includes(tool), `${name}__${tool}`);
    }
  }

  // A call is refused too, whatever the list says, and nothing reaches the upstream.
  const { connector, calls } = fakeUpstream(OFFERED.context);
  const core = new GatewayCore(makeConfig(tempDir(), { context: { keys: ["env:KEY_A"], exclude: ["post_people_*"] } }), { connector, resolveKey });
  const listed = (await core.listTools()).map((entry) => entry.name);
  assert.equal(listed.length, OFFERED.context.length - 2 - Object.keys(SECRET_RESPONSES.context).length);
  for (const tool of Object.keys(SECRET_RESPONSES.context)) {
    assert.ok(!listed.includes(`context__${tool}`), tool);
    const refused = await core.callTool(`context__${tool}`, { monitor_id: "m" }, ctx);
    assert.equal(refused.isError, true, tool);
    assert.match(refused.content[0].text, /is not offered by this gateway/);
  }
  assert.deepEqual(calls, [], "a credential tool reached the upstream");
});

// --- moving a preset ---------------------------------------------------------

test("a block that moves a preset with several documents moves every document that names the preset's address", async () => {
  const publishedAt = "https://docs.firecrawl.dev/api-reference/v2-openapi.json";
  const json = { headers: { "Content-Type": "application/json" } };
  // A stand-in for the published document: it names Firecrawl's own host, and repeats three routes of the shipped additions.
  const published = {
    openapi: "3.0.0",
    info: { title: "published", version: "1" },
    servers: [{ url: "https://api.firecrawl.dev/v2" }],
    paths: {
      "/scrape": { post: { operationId: "scrapeAndExtractFromUrl" } },
      "/search": { post: { operationId: "searchAndScrape" } },
      "/parse": { post: { operationId: "parseFile" } },
      "/team/credit-usage/historical": { get: { operationId: "getHistoricalCreditUsage" } },
      "/scrape/{jobId}/interact": {
        post: { operationId: "interactWithScrapeBrowserSession", parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }] },
      },
    },
  };
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === publishedAt) return new Response(JSON.stringify(published), json);
    requests.push(`${init.method} ${url} ${new Headers(init.headers).get("authorization")}`);
    return new Response("{}", json);
  };
  const trace = async (upstream) => {
    requests.length = 0;
    const client = await connectOpenApi(upstream, "secret-value-aaaaaa");
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["scrapeAndExtractFromUrl", "searchAndScrape", "parseUploadedFile", "getHistoricalCreditUsage"]) {
      await client.callTool({ name, arguments: {} });
    }
    return { names, hosts: [...new Set(requests.map((request) => new URL(request.split(" ")[1]).origin))] };
  };
  try {
    // A self-hosted Firecrawl: every call goes there, and the key goes nowhere else.
    const moved = upstreamOf("firecrawl", { url: "http://127.0.0.1:3002/v2" });
    assert.equal(moved.presetUrl, "https://api.firecrawl.dev/v2");
    const selfHosted = await trace(moved);
    assert.deepEqual(requests, [
      "POST http://127.0.0.1:3002/v2/scrape Bearer secret-value-aaaaaa",
      "POST http://127.0.0.1:3002/v2/search Bearer secret-value-aaaaaa",
      "POST http://127.0.0.1:3002/v2/parse Bearer secret-value-aaaaaa",
      "GET http://127.0.0.1:3002/v2/team/credit-usage/historical Bearer secret-value-aaaaaa",
    ]);
    // The shipped additions still replace the published forms, so no hidden tool comes back under a second name.
    assert.deepEqual(selfHosted.names.filter((name) => /_\d+$/.test(name) || name === "parseFile"), []);
    assert.deepEqual(selfHosted.names.filter((name) => !toolAllowed(moved, name)), ["getConcurrency", "getHistoricalCreditUsage"]);

    // At its own address the preset is as it was.
    const usual = upstreamOf("firecrawl");
    assert.equal(usual.presetUrl, undefined);
    const hosted = await trace(usual);
    assert.deepEqual(hosted.hosts, ["https://api.firecrawl.dev"]);
    assert.deepEqual(hosted.names, selfHosted.names);

    // A block that lists its own documents keeps the rule for lists: each goes to the host it names.
    const own = upstreamOf("firecrawl", { url: "http://127.0.0.1:3002/v2", spec: ["package:specs/firecrawl-additions.yaml", publishedAt] });
    assert.equal(own.presetUrl, undefined);
    assert.deepEqual((await trace(own)).hosts.sort(), ["http://127.0.0.1:3002", "https://api.firecrawl.dev"]);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Every preset with more than one document is moved the same way.
  const several = PRESET_NAMES.filter((name) => Array.isArray(UPSTREAM_PRESETS[name].spec) && UPSTREAM_PRESETS[name].spec.length > 1);
  assert.deepEqual(several, ["firecrawl", "parallel", "brightdata", "tinyfishapi"]);
  for (const name of several) {
    assert.equal(upstreamOf(name, { url: "http://127.0.0.1:9/base" }).presetUrl, UPSTREAM_PRESETS[name].url, name);
    assert.equal(upstreamOf(name, { url: UPSTREAM_PRESETS[name].url }).presetUrl, undefined, name);
  }
  assert.equal(upstreamOf("brightdata", { kind: "mcp", url: "https://mcp.brightdata.com/mcp", auth: "query", auth_name: "token" }).presetUrl, undefined);
});

// --- key signals of the added presets ----------------------------------------

test("a Jina plan refusal shares HTTP 402 with an empty balance and does not skip the key", async () => {
  // Shapes from Jina's API document: TierFeatureConstraintError is status 40202, InsufficientBalanceError 40203.
  const tier = 'HTTP 402: {"code":402,"status":40202,"message":"This feature is not available on your plan","readableMessage":"TierFeatureConstraintError: This feature is not available on your plan"}';
  const empty = 'HTTP 402: {"code":402,"status":40203,"message":"Account balance not enough to run this query, please recharge.","readableMessage":"InsufficientBalanceError: Account balance not enough to run this query, please recharge."}';
  assert.equal(classifyFault(tier), undefined);
  assert.equal(classifyFault('HTTP 402: {"code":402,"status":40202,"message":"Payment Required"}'), undefined);
  assert.equal(classifyFault('{"name":"TierFeatureConstraintError","message":"402 Payment Required"}'), undefined);
  assert.equal(classifyFault(empty), "quota");
  assert.equal(classifyFault('HTTP 402: {"code":402,"status":40203}'), "quota");

  const dir = tempDir();
  const attempts = [];
  let answer = tier;
  const connector = async (upstream, keyValue) => ({
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      attempts.push(keyValue === SECRETS["env:KEY_A"] ? "A" : "B");
      return { content: [{ type: "text", text: answer }], isError: true };
    },
    close: async () => undefined,
  });
  const core = new GatewayCore(makeConfig(dir, { jina: { keys: ["env:KEY_A", "env:KEY_B"] } }), { connector, resolveKey });
  const keyStates = () => core.status().upstreams[0].keys.map((key) => key.state);

  // A feature above the plan: one attempt, the error goes back as it is, and both keys stay in use.
  const refused = await core.callTool("jina__reader_get_root", { url: "https://example.com" }, ctx);
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, tier);
  assert.deepEqual(attempts, ["A"]);
  assert.deepEqual(keyStates(), ["active", "standby"]);

  // An empty balance: the key is skipped and the call moves to the next one.
  answer = empty;
  attempts.length = 0;
  await core.callTool("jina__reader_get_root", { url: "https://example.com" }, ctx);
  assert.deepEqual(attempts, ["A", "B"]);
  assert.deepEqual(keyStates(), ["skipped", "skipped"]);
});

// --- --list-tools ------------------------------------------------------------

test("the tool report counts what is offered and exposed without calling a tool or resolving a key it does not need", async () => {
  const dir = tempDir();
  const resolved = [];
  const connects = [];
  const connector = async (upstream, keyValue) => {
    connects.push([upstream.name, keyValue]);
    if (upstream.name === "tinyfish" && keyValue === SECRETS["env:KEY_A"]) {
      throw new Error(`401 Unauthorized for https://agent.tinyfish.ai/mcp?key=${keyValue}`);
    }
    if (upstream.name === "jinamcp") throw new Error(`connect failed with ${keyValue}`);
    return {
      listTools: async () => ({ tools: OFFERED[upstream.name].map((name) => ({ name, inputSchema: { type: "object" } })) }),
      callTool: async () => {
        throw new Error("a tool was called");
      },
      close: async () => undefined,
    };
  };
  const config = makeConfig(dir, {
    tavily: { keys: ["env:KEY_A"] },
    tinyfish: { keys: ["env:KEY_A", "env:KEY_B"] },
    tavilykeys: { keys: ["env:KEY_A"], curation: "none" },
    jinamcp: { keys: ["env:KEY_B"] },
  });
  const reports = await listUpstreamTools(config, {
    connector,
    resolveKey: async (ref) => {
      resolved.push(ref);
      return SECRETS[ref];
    },
  });

  const byName = Object.fromEntries(reports.map((report) => [report.upstream, report]));
  assert.deepEqual(reports.map((report) => report.upstream), ["tavily", "tinyfish", "tavilykeys", "jinamcp"]);

  // An API document is read without a key; an MCP list uses the first key that connects.
  assert.deepEqual(resolved.sort(), ["env:KEY_A", "env:KEY_B", "env:KEY_B"]);
  assert.deepEqual(connects.filter(([name]) => name === "tavily"), [["tavily", ""]]);
  assert.deepEqual(connects.filter(([name]) => name === "tinyfish").map(([, key]) => key), [SECRETS["env:KEY_A"], SECRETS["env:KEY_B"]]);

  assert.deepEqual(
    [byName.tavily.kind, byName.tavily.offered, byName.tavily.exposed.length, byName.tavily.hidden.length, byName.tavily.curation],
    ["openapi", 10, 6, 4, "preset"]
  );
  assert.deepEqual(byName.tavily.source, ["https://docs.tavily.com/documentation/api-reference/openapi.json"]);
  assert.deepEqual(
    byName.tavily.hidden.sort((a, b) => a.tool.localeCompare(b.tool)),
    [
      { tool: "getUsage", reason: "account" },
      { tool: "post_feedback", reason: "feedback" },
      { tool: "post_logs", reason: "account" },
      { tool: "post_org_usage", reason: "account" },
    ]
  );
  assert.deepEqual(byName.tavily.pinned, ["createResearch", "search", "extract", "crawl", "map", "getResearch"]);

  assert.deepEqual([byName.tinyfish.offered, byName.tinyfish.exposed.length], [43, 8]);
  assert.deepEqual(byName.tinyfish.source, ["https://agent.tinyfish.ai/mcp"]);
  assert.deepEqual(byName.tinyfish.exposed.sort(), [
    "batch_cancel",
    "batch_status",
    "cancel_run",
    "fetch_content",
    "get_run",
    "run_web_automation",
    "run_web_automation_async",
    "search",
  ]);

  assert.deepEqual(
    [byName.tavilykeys.curation, byName.tavilykeys.offered, byName.tavilykeys.exposed, byName.tavilykeys.hidden],
    ["none", 3, ["get_key_info", "post_deactivate_keys"], [{ tool: "post_generate_keys", reason: "credentials" }]]
  );

  // An upstream that cannot be read is reported, with the key value redacted.
  assert.equal(byName.jinamcp.offered, null);
  assert.equal(byName.jinamcp.error, "connect failed with [redacted]");

  const text = formatToolReports(reports);
  assert.match(text, /^tavily \(openapi, https:\/\/docs\.tavily\.com\/documentation\/api-reference\/openapi\.json\)\n {2}offered 10, exposed 6, hidden 4\n {2}exposed: /m);
  assert.match(text, /^ {2}hidden: account 3, feedback 1$/m);
  assert.match(text, /^tavilykeys .*\n {2}offered 3, exposed 2, hidden 1 \(curation: none\)$/m);
  assert.match(text, /^jinamcp .*\n {2}could not be read: connect failed with \[redacted\]$/m);
  assert.ok(!text.includes("secret-value"), "a key value reached the report");
});

test("coldsearch mcp --list-tools prints the report and exits, as text or JSON", async () => {
  const dir = tempDir();
  const configPath = path.join(dir, "config.toml");
  // searxng is keyless and its document ships with the package, so this reads nothing from the network.
  writeFileSync(
    configPath,
    [
      "[gateway]",
      `ledger = "${path.join(dir, "ledger.jsonl")}"`,
      `state = "${path.join(dir, "state.json")}"`,
      "",
      "[gateway.upstreams.searxng]",
      'url = "http://127.0.0.1:9"',
      "",
      "[gateway.upstreams.serper]",
      'keys = ["env:COLDSEARCH_TEST_KEY_THAT_IS_NOT_SET"]',
      "",
    ].join("\n")
  );
  const run = promisify(execFile);
  const cli = path.join(repoRoot, "dist", "cli.js");
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "xdg") };

  const text = await run(process.execPath, [cli, "mcp", "--config", configPath, "--list-tools"], { env, cwd: dir });
  assert.match(text.stdout, /^searxng \(openapi, .*specs[\\/]searxng\.yaml\)\n {2}offered 4, exposed 4, hidden 0\n {2}exposed: search, autocomplete, config, healthz\n {2}pinned: search$/m);
  assert.match(text.stdout, /^serper \(openapi, .*\)\n {2}offered 15, exposed 14, hidden 1\n/m);
  assert.match(text.stdout, /^ {2}hidden: account 1$/m);

  const json = await run(process.execPath, [cli, "mcp", "--config", configPath, "--list-tools", "--json"], { env, cwd: dir });
  const reports = JSON.parse(json.stdout);
  assert.deepEqual(reports.map((report) => [report.upstream, report.offered, report.exposed.length]), [["searxng", 4, 4], ["serper", 15, 14]]);
  assert.deepEqual(reports[1].hidden, [{ tool: "account", reason: "account" }]);
  assert.ok(!existsSync(path.join(dir, "ledger.jsonl")), "listing tools must not start the gateway");

  await assert.rejects(run(process.execPath, [cli, "mcp", "--config", configPath, "--json"], { env, cwd: dir }), /--json is only for --list-tools/);
});

test("the default connector lists a shipped document without a key", async () => {
  const [brave] = resolveGatewayConfig({ upstreams: { brave: { keys: ["env:KEY_A"] } } }).upstreams;
  const client = await defaultConnector(brave, "");
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(names.length, 16);
  assert.deepEqual(names.filter((name) => toolAllowed(brave, name)), [
    "webSearch",
    "llmContext",
    "newsSearch",
    "videosSearch",
    "imagesSearch",
    "localPlaceSearch",
    "localPois",
    "localDescriptions",
    "richSearch",
  ]);
  // The key header is the gateway's: it is not offered as an argument, and the location headers are.
  const web = (await client.listTools()).tools.find((tool) => tool.name === "webSearch");
  assert.ok("X-Loc-City" in web.inputSchema.properties);
  assert.ok(!Object.keys(web.inputSchema.properties).some((key) => key.toLowerCase() === "x-subscription-token"));
});

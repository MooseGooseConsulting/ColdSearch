import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "node:http";
import {
  GatewayCore,
  classifyFault,
  createGatewayServer,
  extractCost,
  loadSkills,
  resolveGatewayConfig,
  startHttpGateway,
} from "../dist/index.js";

const SECRETS = { "env:KEY_A": "secret-value-aaaaaa", "env:KEY_B": "secret-value-bbbbbb", "env:KEY_C": "secret-value-cccccc" };

/**
 * A fake upstream MCP client. `behaviour(keyValue, toolName, args)` returns a
 * tool result or throws, so each test scripts exactly what the vendor does.
 */
function fakeUpstreams(behaviours) {
  const connects = [];
  const connector = async (upstream, keyValue) => {
    connects.push({ upstream: upstream.name, keyValue });
    const spec = behaviours[upstream.name];
    if (spec.connectError) throw new Error(spec.connectError);
    return {
      listTools: async () => ({ tools: spec.tools }),
      callTool: async ({ name, arguments: args }) => spec.call(keyValue, name, args),
      close: async () => undefined,
    };
  };
  return { connector, connects };
}

function makeConfig(dir, upstreams, extra = {}) {
  return resolveGatewayConfig({
    ledger: path.join(dir, "ledger.jsonl"),
    state: path.join(dir, "state.json"),
    skills_dir: path.join(dir, "skills"),
    upstreams,
    ...extra,
  });
}

function tool(name, description = `${name} tool`) {
  return { name, description, inputSchema: { type: "object", properties: { query: { type: "string" } } } };
}

function readLedger(dir) {
  return readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const resolveKey = async (ref) => SECRETS[ref];
const ctx = { session: "s1", client: "test/1.0" };

test("tools from every upstream are listed under <upstream>__<tool>, and a broken upstream is reported, not fatal", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const { connector } = fakeUpstreams({
    exa: { tools: [tool("web_search_exa")], call: async () => ok({}) },
    tavily: { tools: [tool("tavily_search"), tool("tavily_extract")], call: async () => ok({}) },
    firecrawl: { connectError: "connect ECONNREFUSED" },
  });
  const core = new GatewayCore(
    makeConfig(dir, {
      exa: { keys: ["env:KEY_A"] },
      tavily: { keys: ["env:KEY_B"] },
      firecrawl: { keys: ["env:KEY_C"] },
    }),
    { connector, resolveKey }
  );

  const names = (await core.listTools()).map((entry) => entry.name).sort();
  assert.deepEqual(names, ["exa__web_search_exa", "tavily__tavily_extract", "tavily__tavily_search"]);

  const status = core.status();
  const firecrawl = status.upstreams.find((upstream) => upstream.name === "firecrawl");
  assert.match(firecrawl.error, /ECONNREFUSED/);
  assert.equal(status.upstreams.find((upstream) => upstream.name === "tavily").tools, 2);
});

test("a call reaches the right upstream tool and leaves a ledger line with the key name, cost, and no key value", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const seen = [];
  const { connector } = fakeUpstreams({
    exa: {
      tools: [tool("web_search_exa")],
      call: async (keyValue, name, args) => {
        seen.push({ keyValue, name, args });
        return ok({ results: [{ url: "https://example.com" }], costDollars: { total: 0.007 } });
      },
    },
  });
  const core = new GatewayCore(makeConfig(dir, { exa: { keys: ["env:KEY_A"] } }), { connector, resolveKey });

  const result = await core.callTool("exa__web_search_exa", { query: "node lts", echo: SECRETS["env:KEY_A"] }, ctx);
  assert.equal(result.isError, undefined);
  assert.deepEqual(seen, [
    { keyValue: SECRETS["env:KEY_A"], name: "web_search_exa", args: { query: "node lts", echo: SECRETS["env:KEY_A"] } },
  ]);

  const [entry] = readLedger(dir);
  assert.equal(entry.upstream, "exa");
  assert.equal(entry.tool, "web_search_exa");
  assert.equal(entry.key, "env:KEY_A");
  assert.equal(entry.ok, true);
  assert.equal(entry.client, "test/1.0");
  assert.deepEqual(entry.cost, { usd: 0.007 });
  assert.match(entry.args, /node lts/);

  // The full request and response are kept in their own file, also without the key.
  const payloadFile = path.join(dir, "gateway-payloads", entry.payload);
  const payloadText = readFileSync(payloadFile, "utf8");
  const payload = JSON.parse(payloadText);
  assert.deepEqual(payload.request, { name: "web_search_exa", arguments: { query: "node lts", echo: "[redacted]" } });
  assert.match(payload.response.content[0].text, /example\.com/);
  assert.equal(payloadText.includes(SECRETS["env:KEY_A"]), false);
  assert.equal(statSync(payloadFile).mode & 0o777, 0o600);

  const raw = readFileSync(path.join(dir, "ledger.jsonl"), "utf8");
  assert.equal(raw.includes(SECRETS["env:KEY_A"]), false, "key value must never reach the ledger");
  assert.equal(statSync(path.join(dir, "ledger.jsonl")).mode & 0o777, 0o600);
});

test("an out-of-credit key is skipped: the call succeeds on the next key and later calls start there", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const used = [];
  const behaviours = {
    firecrawl: {
      tools: [tool("firecrawl_scrape")],
      call: async (keyValue) => {
        used.push(keyValue);
        return keyValue === SECRETS["env:KEY_A"]
          ? fail("Payment Required: Insufficient credits")
          : ok({ markdown: "# page", creditsUsed: 1 });
      },
    },
  };
  const config = makeConfig(dir, { firecrawl: { keys: ["env:KEY_A", "env:KEY_B"] } });
  let clock = Date.parse("2026-11-27T00:00:00Z");
  const core = new GatewayCore(config, { ...fakeUpstreams(behaviours), resolveKey, now: () => clock });

  const first = await core.callTool("firecrawl__firecrawl_scrape", { url: "https://example.com" }, ctx);
  assert.equal(first.isError, undefined);
  assert.deepEqual(used, [SECRETS["env:KEY_A"], SECRETS["env:KEY_B"]]);

  const entries = readLedger(dir);
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.attempt, entry.ok, entry.error_class ?? null]),
    [["env:KEY_A", 1, false, "quota"], ["env:KEY_B", 2, true, null]]
  );
  assert.deepEqual(entries[1].cost, { credits: 1 });

  // A new process reads the saved state and does not go back to the empty key.
  used.length = 0;
  const restarted = new GatewayCore(config, { ...fakeUpstreams(behaviours), resolveKey, now: () => clock });
  await restarted.callTool("firecrawl__firecrawl_scrape", { url: "https://example.com" }, ctx);
  assert.deepEqual(used, [SECRETS["env:KEY_B"]]);
  const keys = restarted.status().upstreams[0].keys;
  assert.deepEqual(keys.map((key) => [key.key, key.state]), [["env:KEY_A", "skipped"], ["env:KEY_B", "active"]]);

  // After the cooldown the first key is tried again.
  clock += 7 * 3_600_000;
  used.length = 0;
  await restarted.callTool("firecrawl__firecrawl_scrape", { url: "https://example.com" }, ctx);
  assert.equal(used[0], SECRETS["env:KEY_A"]);
});

test("when every key is out of credit the agent gets one clear error; an ordinary upstream error is not retried on other keys", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  let calls = 0;
  const { connector } = fakeUpstreams({
    tavily: { tools: [tool("tavily_search")], call: async () => fail("432: This request exceeds your plan's set usage limit") },
    exa: {
      tools: [tool("web_search_exa")],
      call: async () => {
        calls += 1;
        return fail("400: numResults must be at most 100");
      },
    },
  });
  const core = new GatewayCore(
    makeConfig(dir, { tavily: { keys: ["env:KEY_A", "env:KEY_B"] }, exa: { keys: ["env:KEY_A", "env:KEY_B"] } }),
    { connector, resolveKey }
  );

  const exhausted = await core.callTool("tavily__tavily_search", { query: "x" }, ctx);
  assert.equal(exhausted.isError, true);
  assert.match(exhausted.content[0].text, /all 2 configured keys failed/);

  const bad = await core.callTool("exa__web_search_exa", { numResults: 500 }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /numResults/);
  assert.equal(calls, 1);

  const unknown = await core.callTool("nosuch__tool", {}, ctx);
  assert.match(unknown.content[0].text, /Unknown tool/);
});

test("an error object returned as a successful result still moves the call to the next key", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const { connector } = fakeUpstreams({
    tavily: {
      tools: [tool("tavily_search")],
      call: async (keyValue) =>
        keyValue === SECRETS["env:KEY_A"]
          ? ok({ error: "Search failed", status: 432, detail: { error: "This request exceeds your plan's set usage limit." } })
          : ok({ results: [{ url: "https://example.com", title: "an error occurred in 1402" }] }),
    },
  });
  const core = new GatewayCore(makeConfig(dir, { tavily: { keys: ["env:KEY_A", "env:KEY_B"] } }), { connector, resolveKey });

  const result = await core.callTool("tavily__tavily_search", { query: "x" }, ctx);
  assert.match(result.content[0].text, /example\.com/);
  assert.deepEqual(
    readLedger(dir).map((entry) => [entry.key, entry.ok, entry.error_class ?? null]),
    [["env:KEY_A", false, "quota"], ["env:KEY_B", true, null]]
  );
});

test("fault classification and cost extraction follow the vendors' documented shapes", () => {
  assert.equal(classifyFault("402 NO_MORE_CREDITS"), "quota");
  assert.equal(classifyFault("Payment Required: Insufficient credits"), "quota");
  assert.equal(classifyFault("401 INVALID_API_KEY"), "auth");
  assert.equal(classifyFault("429 Rate limit exceeded"), undefined);
  assert.equal(classifyFault("500 upstream exploded"), undefined);

  assert.deepEqual(extractCost({ content: [], _meta: { "parallel/usage": { cost_usd: 0.001 } } }), { usd: 0.001 });
  assert.deepEqual(extractCost(ok({ creditsUsed: 5 })), { credits: 5 });
  assert.deepEqual(extractCost(ok({ costDollars: { total: 0.012, search: { neural: 0.005 } } })), { usd: 0.012 });
  assert.equal(extractCost(ok({ results: [] })), undefined);
});

test("an agent connected over MCP sees namespaced tools, can call them, and can read the curated skill", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  mkdirSync(path.join(dir, "skills", "search-routing"), { recursive: true });
  writeFileSync(
    path.join(dir, "skills", "search-routing", "SKILL.md"),
    "---\nname: search-routing\ndescription: Pick the cheapest tool that fits.\n---\n\n# Routing\n\nFetch before you search.\n"
  );
  mkdirSync(path.join(dir, "skills", "broken"), { recursive: true });
  writeFileSync(path.join(dir, "skills", "broken", "SKILL.md"), "no frontmatter here\n");

  const { connector } = fakeUpstreams({
    exa: { tools: [tool("web_search_exa", "Search the web with Exa")], call: async (_k, _n, args) => ok({ echoed: args.query }) },
  });
  const config = makeConfig(dir, { exa: { keys: ["env:KEY_A"] } });
  const core = new GatewayCore(config, { connector, resolveKey });
  const skills = loadSkills(config.skillsDir);
  assert.deepEqual(skills.map((skill) => skill.name), ["search-routing"]);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createGatewayServer(core, skills).connect(serverSide);
  const client = new Client({ name: "agent-under-test", version: "9.9.9" });
  await client.connect(clientSide);

  assert.match(client.getInstructions(), /search-routing: Pick the cheapest tool/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((entry) => entry.name).sort(), ["coldsearch_read_skill", "coldsearch_status", "exa__web_search_exa"]);

  const called = await client.callTool({ name: "exa__web_search_exa", arguments: { query: "hello" } });
  assert.match(called.content[0].text, /hello/);
  assert.equal(readLedger(dir)[0].client, "agent-under-test/9.9.9");

  const skill = await client.callTool({ name: "coldsearch_read_skill", arguments: { name: "search-routing" } });
  assert.match(skill.content[0].text, /Fetch before you search/);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((prompt) => prompt.name), ["search-routing"]);
  const resource = await client.readResource({ uri: "skill://search-routing" });
  assert.match(resource.contents[0].text, /Fetch before you search/);

  const status = JSON.parse((await client.callTool({ name: "coldsearch_status", arguments: {} })).content[0].text);
  assert.equal(status.last_24h[0].calls, 1);
  await client.close();
});

test("lazy mode lists only the gateway's own tools and reaches upstream tools through find, describe and call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const { connector } = fakeUpstreams({
    firecrawl: {
      tools: [tool("firecrawl_scrape", "Scrape one URL to markdown"), tool("firecrawl_crawl", "Crawl a whole site")],
      call: async (_k, name) => ok({ ran: name }),
    },
  });
  const core = new GatewayCore(makeConfig(dir, { firecrawl: { keys: ["env:KEY_A"] } }, { mode: "lazy" }), { connector, resolveKey });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createGatewayServer(core, []).connect(serverSide);
  const client = new Client({ name: "lazy-agent", version: "1.0.0" });
  await client.connect(clientSide);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((entry) => entry.name).sort(),
    ["coldsearch_call_tool", "coldsearch_describe_tool", "coldsearch_find_tools", "coldsearch_status"]
  );

  const found = await client.callTool({ name: "coldsearch_find_tools", arguments: { query: "crawl site" } });
  assert.match(found.content[0].text.split("\n")[0], /^- firecrawl__firecrawl_crawl:/);

  const described = await client.callTool({ name: "coldsearch_describe_tool", arguments: { name: "firecrawl__firecrawl_scrape" } });
  assert.equal(JSON.parse(described.content[0].text).inputSchema.type, "object");

  const called = await client.callTool({
    name: "coldsearch_call_tool",
    arguments: { name: "firecrawl__firecrawl_crawl", arguments: { url: "https://example.com" } },
  });
  assert.match(called.content[0].text, /firecrawl_crawl/);
  await client.close();
});

test("the HTTP gateway serves MCP at /mcp, rejects a wrong token, and refuses a public bind without one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const { connector } = fakeUpstreams({
    exa: { tools: [tool("web_search_exa")], call: async () => ok({ fine: true }) },
  });
  const core = new GatewayCore(makeConfig(dir, { exa: { keys: ["env:KEY_A"] } }), { connector, resolveKey });

  await assert.rejects(startHttpGateway(core, [], { host: "0.0.0.0", port: 0 }), /without a token/);

  const server = await startHttpGateway(core, [], { host: "127.0.0.1", port: 0, token: "gateway-token" });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  try {
    const denied = await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" });
    assert.equal(denied.status, 401);

    const client = new Client({ name: "http-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer gateway-token" } } })
    );
    const { tools } = await client.listTools();
    assert.ok(tools.some((entry) => entry.name === "exa__web_search_exa"));
    const result = await client.callTool({ name: "exa__web_search_exa", arguments: { query: "q" } });
    assert.match(result.content[0].text, /fine/);
    await client.close();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("include and exclude lists hide upstream tools and refuse calls to them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  let calls = 0;
  const { connector } = fakeUpstreams({
    tinyfish: {
      tools: [tool("search"), tool("fetch_content"), tool("top_up_wallet"), tool("create_monitor"), tool("delete_dataset")],
      call: async () => {
        calls += 1;
        return ok({});
      },
    },
  });
  const core = new GatewayCore(
    makeConfig(dir, { tinyfish: { keys: ["env:KEY_A"], exclude: ["top_up_wallet", "*_monitor", "delete_*"] } }),
    { connector, resolveKey }
  );
  assert.deepEqual((await core.listTools()).map((entry) => entry.name), ["tinyfish__search", "tinyfish__fetch_content"]);
  const refused = await core.callTool("tinyfish__top_up_wallet", { amount: 50 }, ctx);
  assert.equal(refused.isError, true);
  assert.equal(calls, 0);

  const only = new GatewayCore(makeConfig(dir, { tinyfish: { keys: ["env:KEY_A"], include: ["search", "fetch_*"] } }), { connector, resolveKey });
  assert.deepEqual((await only.listTools()).map((entry) => entry.name), ["tinyfish__search", "tinyfish__fetch_content"]);
});

test("gateway config explains what is missing", () => {
  assert.throws(() => resolveGatewayConfig(undefined), /\[gateway\] section missing/);
  assert.throws(() => resolveGatewayConfig({ upstreams: { exa: { keys: [] } } }), /needs at least one entry in keys/);
  assert.throws(() => resolveGatewayConfig({ upstreams: { custom: { keys: ["env:X"] } } }), /needs a url/);
  assert.throws(() => resolveGatewayConfig({ mode: "eager", upstreams: { exa: { keys: ["env:X"] } } }), /mode must be/);

  const config = resolveGatewayConfig({
    exhausted_cooldown: "30m",
    upstreams: { brightdata: { keys: ["env:X"] }, custom: { url: "https://mcp.example.com/mcp", auth: "none" } },
  });
  assert.equal(config.exhaustedCooldownMs, 30 * 60_000);
  assert.deepEqual(
    config.upstreams.map((upstream) => [upstream.name, upstream.auth, upstream.authName]),
    [["brightdata", "query", "token"], ["custom", "none", "Authorization"]]
  );
  assert.throws(() => resolveGatewayConfig({ upstreams: { custom: { kind: "openapi", url: "https://api.example.com", keys: ["env:X"] } } }), /needs spec/);
  const exa = resolveGatewayConfig({ upstreams: { exa: { keys: ["env:X"] }, examcp: { keys: ["env:X"] } } }).upstreams;
  assert.deepEqual(exa.map((upstream) => [upstream.name, upstream.kind]), [["exa", "openapi"], ["examcp", "mcp"]]);
});

test("an OpenAPI upstream turns every API operation into a tool and sends path, query, body and key where the API expects them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-"));
  const requests = [];
  const betas = [];
  const api = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, key: req.headers["x-api-key"], body: body ? JSON.parse(body) : null });
      betas.push(req.headers["x-beta"]);
      res.setHeader("Content-Type", "application/json");
      if (req.url.startsWith("/broke")) {
        res.statusCode = 402;
        res.end(JSON.stringify({ error: "NO_MORE_CREDITS" }));
      } else {
        res.end(JSON.stringify({ results: [], costDollars: { total: 0.004 } }));
      }
    });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const specPath = path.join(dir, "spec.yaml");
  writeFileSync(
    specPath,
    `openapi: 3.1.0
paths:
  /search:
    post:
      operationId: search
      summary: Search the web
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/SearchRequest' }
  /runs/{id}/events:
    get:
      summary: Run events
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: cursor, in: query, schema: { type: string } }
  /broke:
    get: { operationId: broke }
components:
  schemas:
    SearchRequest:
      type: object
      required: [query]
      properties:
        query: { type: string }
        type: { type: string, enum: [auto, deep] }
        contents: { $ref: '#/components/schemas/Contents' }
    Contents:
      type: object
      properties:
        text: { type: boolean }
`
  );
  // A second document adds an operation and repeats one; the repeat is dropped.
  const extraSpecPath = path.join(dir, "extra.json");
  writeFileSync(
    extraSpecPath,
    JSON.stringify({ openapi: "3.1.0", paths: { "/search": { post: { operationId: "searchAgain" } }, "/usage": { get: { operationId: "getUsage" } } } })
  );
  try {
    const core = new GatewayCore(
      makeConfig(dir, {
        api: { kind: "openapi", url: `http://127.0.0.1:${api.address().port}`, spec: [specPath, extraSpecPath], headers: { "x-beta": "2026-11" }, auth_name: "x-api-key", auth_prefix: "", keys: ["env:KEY_A", "env:KEY_B"] },
      }),
      { resolveKey }
    );

    const tools = await core.listTools();
    assert.deepEqual(tools.map((entry) => entry.name), ["api__search", "api__get_runs_id_events", "api__broke", "api__getUsage"]);
    const search = tools[0].tool;
    assert.deepEqual(search.inputSchema.required, ["query"]);
    assert.deepEqual(search.inputSchema.properties.type.enum, ["auto", "deep"]);
    assert.equal(search.inputSchema.properties.contents.properties.text.type, "boolean");

    await core.callTool("api__search", { query: "q", type: "deep", contents: { text: true } }, ctx);
    await core.callTool("api__get_runs_id_events", { id: "run 1", cursor: "c2" }, ctx);
    assert.deepEqual(requests, [
      { method: "POST", url: "/search", key: SECRETS["env:KEY_A"], body: { query: "q", type: "deep", contents: { text: true } } },
      { method: "GET", url: "/runs/run%201/events?cursor=c2", key: SECRETS["env:KEY_A"], body: null },
    ]);
    assert.deepEqual(readLedger(dir)[0].cost, { usd: 0.004 });
    assert.deepEqual(betas, ["2026-11", "2026-11"]);

    // An HTTP 402 from the API moves the call to the next key, like any out-of-credit signal.
    await core.callTool("api__broke", {}, ctx);
    assert.deepEqual(requests.slice(2).map((request) => request.key), [SECRETS["env:KEY_A"], SECRETS["env:KEY_B"]]);
  } finally {
    await new Promise((resolve) => api.close(resolve));
  }
});

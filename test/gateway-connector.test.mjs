import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { GatewayCore, classifyFault, extractCost, resolveGatewayConfig } from "../dist/index.js";

const SECRETS = { "env:KEY_A": "secret-value-aaaaaa", "env:KEY_B": "secret-value-bbbbbb" };
const resolveKey = async (ref) => SECRETS[ref];
const ctx = { session: "s1", client: "test/1.0" };
const ok = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "cs-gwc-"));
}

function makeConfig(dir, upstreams) {
  return resolveGatewayConfig({
    ledger: path.join(dir, "ledger.jsonl"),
    state: path.join(dir, "state.json"),
    skills_dir: path.join(dir, "skills"),
    upstreams,
  });
}

function readLedger(dir) {
  return readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function writeSpec(dir, name, spec) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({ openapi: "3.1.0", ...spec }));
  return file;
}

/** A local HTTP server standing in for a vendor API. `handler(req, res, body)` answers each request. */
async function listen(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A server that records `<label> <METHOD> <path>` for every request and answers with empty JSON. */
async function recorder(label, hits) {
  return listen((req, res) => {
    hits.push(`${label} ${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
}

/** An upstream block for a local API whose key travels in `x-api-key`. */
function api(url, spec, extra = {}) {
  return { kind: "openapi", url, spec, auth_name: "x-api-key", auth_prefix: "", keys: ["env:KEY_A", "env:KEY_B"], ...extra };
}

test("with several documents each one's own server is used, and the same path on two hosts is two tools", async () => {
  const dir = tempDir();
  const hits = [];
  const [a, b, c] = await Promise.all([recorder("A", hits), recorder("B", hits), recorder("C", hits)]);
  try {
    const first = writeSpec(dir, "first.json", {
      servers: [{ url: b.url }],
      paths: {
        "/": { post: { operationId: "search" } },
        "/override": {
          servers: [{ url: c.url }],
          get: { operationId: "pathLevel" },
          post: { operationId: "operationLevel", servers: [{ url: a.url }] },
        },
      },
    });
    const second = writeSpec(dir, "second.json", { servers: [{ url: c.url }], paths: { "/": { post: { operationId: "fetch" } } } });
    // Same method, host and path as `search`: dropped. `/usage` is new: kept.
    const third = writeSpec(dir, "third.json", {
      servers: [{ url: `${b.url}/` }],
      paths: { "/": { post: { operationId: "searchAgain" } }, "/usage": { get: { operationId: "usage" } } },
    });
    // No server of its own, or a relative one: the upstream's url applies.
    const fourth = writeSpec(dir, "fourth.json", { paths: { "/plain": { get: { operationId: "plain" } } } });
    const fifth = writeSpec(dir, "fifth.json", { servers: [{ url: "/v2" }], paths: { "/relative": { get: { operationId: "relative" } } } });

    const core = new GatewayCore(makeConfig(dir, { multi: api(a.url, [first, second, third, fourth, fifth]) }), { resolveKey });
    const names = (await core.listTools()).map((entry) => entry.name);
    assert.deepEqual(names, [
      "multi__search",
      "multi__pathLevel",
      "multi__operationLevel",
      "multi__fetch",
      "multi__usage",
      "multi__plain",
      "multi__relative",
    ]);
    for (const name of names) await core.callTool(name, {}, ctx);
    assert.deepEqual(hits, ["B POST /", "C GET /override", "A POST /override", "C POST /", "B GET /usage", "A GET /plain", "A GET /relative"]);

    // One document: the upstream's url outranks the document's server, so a
    // config can point the same document at a regional or self-hosted base.
    hits.length = 0;
    const single = new GatewayCore(makeConfig(dir, { single: api(a.url, first) }), { resolveKey });
    await single.callTool("single__search", {}, ctx);
    await single.callTool("single__pathLevel", {}, ctx);
    assert.deepEqual(hits, ["A POST /", "C GET /override"]);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});

test("a header parameter is sent when the agent supplies it, and can never set the key's header or a fixed header", async () => {
  const dir = tempDir();
  const seen = [];
  const server = await listen((req, res, body) => {
    seen.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  try {
    const header = (name, required = false) => ({ name, in: "header", required, schema: { type: "string" }, description: `${name} header` });
    const spec = writeSpec(dir, "spec.json", {
      paths: {
        "/crawl": {
          post: {
            operationId: "crawl",
            parameters: [header("x-request-id"), header("x-idempotency-key"), header("x-api-key"), header("X-Beta", true), header("Authorization"), header("Accept")],
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { url: { type: "string" } } } } } },
          },
        },
      },
    });
    const core = new GatewayCore(makeConfig(dir, { api: api(server.url, spec, { headers: { "x-beta": "2026-11" } }) }), { resolveKey });

    const [crawl] = await core.listTools();
    assert.deepEqual(Object.keys(crawl.tool.inputSchema.properties), ["x-request-id", "x-idempotency-key", "Accept", "url"]);
    assert.equal(crawl.tool.inputSchema.required, undefined, "a required header the config fixes is not asked of the agent");

    const sent = await core.callTool("api__crawl", { url: "https://example.com", "x-request-id": "req-1", "x-idempotency-key": "idem-1", Accept: "text/plain" }, ctx);
    assert.equal(sent.isError, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers["x-request-id"], "req-1");
    assert.equal(seen[0].headers["x-idempotency-key"], "idem-1");
    assert.equal(seen[0].headers.accept, "text/plain");
    assert.equal(seen[0].headers["x-beta"], "2026-11");
    assert.equal(seen[0].headers["x-api-key"], SECRETS["env:KEY_A"]);
    assert.deepEqual(seen[0].body, { url: "https://example.com" }, "header arguments stay out of the JSON body");

    for (const [argument, reason] of [
      ["x-api-key", /carries api's key/],
      ["X-Beta", /config fixes it/],
      ["Authorization", /credentials come from the gateway's key list/],
    ]) {
      const refused = await core.callTool("api__crawl", { url: "https://example.com", [argument]: "agent-supplied" }, ctx);
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, new RegExp(`Argument "${argument}" is refused`));
      assert.match(refused.content[0].text, reason);
    }
    const broken = await core.callTool("api__crawl", { "x-request-id": "a\r\nx-api-key: injected" }, ctx);
    assert.match(broken.content[0].text, /not valid in one/);
    assert.equal(seen.length, 1, "a refused call makes no request");
    assert.equal(core.status().upstreams[0].keys[0].state, "active", "a refusal is not held against the key");
  } finally {
    await server.close();
  }
});

test("an event-stream response is returned as a JSON array of events, and is cut short at the time or byte limit", async () => {
  const dir = tempDir();
  const bodies = [];
  const server = await listen((req, res, body) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    if (req.url === "/finished") {
      bodies.push(body);
      res.write(': keep-alive\n\nevent: progress\nid: 7\ndata: {"step":1}\n\n');
      res.write('data: plain text\r\n\r\ndata: {"answer":\n');
      res.write('data: "done","costDollars":{"total":0.02}}\n\nevent: end\n\ndata: [DONE]');
      res.end();
    } else if (req.url === "/open") {
      // Two events, half of a third, then silence: the run is still going.
      res.write('event: progress\ndata: {"step":1}\n\nevent: progress\ndata: {"step":2}\n\nevent: progress\ndata: {"st');
    } else {
      for (let n = 0; n < 200; n++) res.write(`data: {"n":${n},"pad":"${"x".repeat(40)}"}\n\n`);
      res.end();
    }
  });
  try {
    const spec = writeSpec(dir, "spec.json", {
      paths: {
        "/finished": {
          post: {
            operationId: "finished",
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { stream: { type: "boolean" } } } } } },
          },
        },
        "/open": { get: { operationId: "open" } },
        "/long": { get: { operationId: "long" } },
      },
    });
    const core = new GatewayCore(
      makeConfig(dir, { api: api(server.url, spec, { stream_timeout: 0.4, stream_max_bytes: 1000 }) }),
      { resolveKey }
    );

    const finished = await core.callTool("api__finished", { stream: true }, ctx);
    assert.deepEqual(bodies, ['{"stream":true}']);
    assert.equal(finished.content.length, 1);
    assert.deepEqual(JSON.parse(finished.content[0].text), [
      { event: "progress", data: { step: 1 }, id: "7" },
      { event: "message", data: "plain text" },
      { event: "message", data: { answer: "done", costDollars: { total: 0.02 } } },
      { event: "end", data: null },
      { event: "message", data: "[DONE]" },
    ]);
    assert.deepEqual(readLedger(dir)[0].cost, { usd: 0.02 });

    const started = Date.now();
    const open = await core.callTool("api__open", {}, ctx);
    assert.ok(Date.now() - started < 5000, "the call returns at the limit, not when the upstream gives up");
    assert.equal(open.isError, undefined);
    assert.deepEqual(JSON.parse(open.content[0].text), [
      { event: "progress", data: { step: 1 } },
      { event: "progress", data: { step: 2 } },
    ]);
    assert.match(open.content[1].text, /Stream cut short: .*0\.4 s \(stream_timeout\).*2 events/);

    const long = await core.callTool("api__long", {}, ctx);
    const events = JSON.parse(long.content[0].text);
    assert.ok(events.length > 0 && events.length < 20, `expected a few events inside 1000 bytes, got ${events.length}`);
    assert.deepEqual(events[0], { event: "message", data: { n: 0, pad: "x".repeat(40) } });
    assert.match(long.content[1].text, /Stream cut short: .*1000 bytes.*\(stream_max_bytes\)/);

    assert.throws(() => makeConfig(dir, { api: api(server.url, spec, { stream_max_bytes: "1MB" }) }), /upstreams\.api\.stream_max_bytes must be a whole number of bytes/);
    assert.throws(() => makeConfig(dir, { api: api(server.url, spec, { stream_timeout: "soon" }) }), /upstreams\.api\.stream_timeout must be seconds or a duration/);
  } finally {
    await server.close();
  }
});

test("a binary response is described, not passed through, and its bytes reach neither the result nor the payload file", async () => {
  const dir = tempDir();
  const marker = "BINARY-MARKER";
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]), Buffer.from(marker)]);
  const server = await listen((req, res) => {
    if (req.url === "/screenshot") {
      res.setHeader("Content-Type", "image/png");
      res.end(png);
    } else if (req.url === "/download") {
      // No useful type: the bytes decide. A gzip header is not text.
      res.setHeader("Content-Type", "application/octet-stream");
      res.end(Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xfe]), Buffer.from(marker)]));
    } else if (req.url === "/untyped") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end('{"rows":[1,2]}');
    } else {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/pdf");
      res.end(png);
    }
  });
  try {
    const paths = Object.fromEntries(["screenshot", "download", "untyped", "failed"].map((name) => [`/${name}`, { get: { operationId: name } }]));
    const core = new GatewayCore(makeConfig(dir, { api: api(server.url, writeSpec(dir, "spec.json", { paths })) }), { resolveKey });

    const screenshot = await core.callTool("api__screenshot", {}, ctx);
    assert.equal(screenshot.isError, undefined);
    assert.match(screenshot.content[0].text, new RegExp(`image/png, ${png.length} bytes\\. The gateway does not pass binary bodies through`));

    const download = await core.callTool("api__download", {}, ctx);
    assert.match(download.content[0].text, /application\/octet-stream, 18 bytes\. The gateway does not pass binary bodies through/);

    const untyped = await core.callTool("api__untyped", {}, ctx);
    assert.equal(untyped.content[0].text, '{"rows":[1,2]}', "text under a generic content type still comes through");

    const failed = await core.callTool("api__failed", {}, ctx);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /^HTTP 500: The response body is application\/pdf, \d+ bytes/);

    const entries = readLedger(dir);
    assert.deepEqual(entries.map((entry) => entry.ok), [true, true, true, false]);
    for (const entry of entries) {
      const payload = readFileSync(path.join(dir, "gateway-payloads", entry.payload), "utf8");
      assert.equal(payload.includes(marker), false);
      assert.equal(payload.includes("PNG"), false);
    }
    for (const result of [screenshot, download, failed]) assert.equal(JSON.stringify(result).includes(marker), false);
  } finally {
    await server.close();
  }
});

test("out-of-credit and rejected-key wording from each vendor is recognized; rate limiting is not", () => {
  // Tavily: 433 is the pay-as-you-go limit, 434 a capacity error that clears.
  assert.equal(classifyFault('HTTP 433: {"detail":{"error":"This request exceeds the pay-as-you-go limit. You can increase your limit on the Tavily dashboard."}}'), "quota");
  assert.equal(classifyFault("433: This request exceeds the pay-as-you-go limit."), "quota");
  assert.equal(classifyFault('HTTP 434: {"detail":{"error":"Live content fetching is temporarily unavailable on your plan due to high demand."}}'), undefined);
  assert.equal(classifyFault("434: Live content fetching is temporarily unavailable on your plan due to high demand."), undefined);
  // Serper.
  assert.equal(classifyFault('HTTP 400: {"message":"Not enough credits","statusCode":400}'), "quota");
  // Brave.
  assert.equal(classifyFault('HTTP 422: {"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided subscription token is invalid.","status":422}}'), "auth");
  // TinyFish: a used-up daily allowance arrives as 429; its other 429s are ordinary limits.
  assert.equal(classifyFault('HTTP 429: {"error":{"code":"RATE_LIMIT_EXCEEDED","details":{"reason":"free_allowance_exhausted","window_seconds":86400}}}'), "quota");
  assert.equal(classifyFault('RATE_LIMIT_EXCEEDED: {"reason":"free_allowance_exhausted"}'), "quota");
  assert.equal(classifyFault('HTTP 429: {"error":{"code":"RATE_LIMIT_EXCEEDED","details":{"limit":402,"unit":"minute","window_seconds":60}}}'), undefined);
  assert.equal(classifyFault('HTTP 429: {"error":{"code":"RATE_LIMIT_EXCEEDED","details":{"active_count":3}}}'), undefined);
  // Bright Data: three phrases and the code its x-brd-err-code header carries.
  assert.equal(classifyFault("Usage limit reached: add funds to continue"), "quota");
  assert.equal(classifyFault("HTTP 403: Your account is out of free credits"), "quota");
  assert.equal(classifyFault("HTTP 400: not enough funds"), "quota");
  assert.equal(classifyFault("HTTP 403: Forbidden [x-brd-err-code: client_10100]"), "quota");
  // Exa error tags.
  assert.equal(classifyFault('HTTP 402: {"tag":"NO_MORE_CREDITS"}'), "quota");
  assert.equal(classifyFault('{"tag":"NO_MORE_CREDITS"}'), "quota");
  assert.equal(classifyFault('{"tag":"API_KEY_BUDGET_EXCEEDED"}'), "quota");
  assert.equal(classifyFault('{"tag":"TEAM_BUDGET_EXCEEDED"}'), "quota");

  // Ordinary rate limiting never counts, whatever numbers or loose wording come with it.
  assert.equal(classifyFault('HTTP 429: {"detail":{"error":"Your request has been blocked due to excessive requests."}}'), undefined);
  assert.equal(classifyFault("HTTP 429: Rate limited or quota exceeded"), undefined);
  assert.equal(classifyFault("429 Too Many Requests: quota exceeded for this minute, retry in 402 ms"), undefined);
  assert.equal(classifyFault("Rate limit exceeded. Consumed (req/min): 432, Remaining (req/min): 0"), undefined);
  // An openapi error is judged by its own status, not by numbers in its body.
  assert.equal(classifyFault('HTTP 404: {"error":"run 402 not found"}'), undefined);
  assert.equal(classifyFault('HTTP 400: {"error":"offset 401 is past the end"}'), undefined);
  assert.equal(classifyFault("HTTP 402: {}"), "quota");
  assert.equal(classifyFault("HTTP 401: {}"), "auth");
});

test("a TinyFish-style exhausted allowance and a Bright Data error header move the call to the next key; a plain 429 does not", async () => {
  const dir = tempDir();
  const used = [];
  const server = await listen((req, res) => {
    const key = req.headers["x-api-key"];
    used.push(`${req.url} ${key === SECRETS["env:KEY_A"] ? "A" : "B"}`);
    res.setHeader("Content-Type", "application/json");
    if (key !== SECRETS["env:KEY_A"]) {
      res.end('{"results":[]}');
    } else if (req.url === "/allowance") {
      res.statusCode = 429;
      res.end('{"error":{"code":"RATE_LIMIT_EXCEEDED","details":{"reason":"free_allowance_exhausted","window_seconds":86400}}}');
    } else if (req.url === "/header") {
      res.statusCode = 403;
      res.setHeader("x-brd-err-code", "client_10100");
      res.end('{"error":"Forbidden"}');
    } else {
      res.statusCode = 429;
      res.setHeader("Retry-After", "30");
      res.end('{"error":{"code":"RATE_LIMIT_EXCEEDED","details":{"limit":402,"unit":"minute"}}}');
    }
  });
  try {
    const paths = Object.fromEntries(["allowance", "header", "busy"].map((name) => [`/${name}`, { get: { operationId: name } }]));
    const spec = writeSpec(dir, "spec.json", { paths });
    const fresh = (name) => new GatewayCore(makeConfig(path.join(dir, name), { api: api(server.url, spec) }), { resolveKey });

    const allowance = await fresh("one").callTool("api__allowance", {}, ctx);
    assert.equal(allowance.isError, undefined);
    assert.deepEqual(readLedger(path.join(dir, "one")).map((entry) => entry.error_class ?? null), ["quota", null]);

    const header = await fresh("two").callTool("api__header", {}, ctx);
    assert.equal(header.isError, undefined);
    const [rejected] = readLedger(path.join(dir, "two"));
    assert.equal(rejected.error_class, "quota");
    assert.match(rejected.error, /^HTTP 403: \{"error":"Forbidden"\} \[x-brd-err-code: client_10100\]$/);

    const busyCore = fresh("three");
    const busy = await busyCore.callTool("api__busy", {}, ctx);
    assert.equal(busy.isError, true);
    assert.match(busy.content[0].text, /^HTTP 429: /);
    assert.equal(busyCore.status().upstreams[0].keys[0].state, "active");
    assert.deepEqual(used, ["/allowance A", "/allowance B", "/header A", "/header B", "/busy A"]);
  } finally {
    await server.close();
  }
});

test("a successful result that merely mentions 402 or credits is not treated as a failure", async () => {
  const dir = tempDir();
  const results = [
    ok({ results: [{ title: "HTTP 402 Payment Required explained", snippet: "insufficient credits and quota exceeded errors" }], credits: 402 }),
    // Small, and with an `error` key that says there was none.
    ok({ error: null, status: 402, message: "out of credits is a common error" }),
    ok({ error: "", data: "401 unauthorized is returned when the key is wrong" }),
  ];
  let calls = 0;
  const connector = async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async () => results[calls++],
    close: async () => undefined,
  });
  const core = new GatewayCore(
    makeConfig(dir, { serper: { url: "https://mcp.example.com/mcp", keys: ["env:KEY_A", "env:KEY_B"] } }),
    { connector, resolveKey }
  );
  for (const expected of results) assert.equal(await core.callTool("serper__search", { q: "402" }, ctx), expected);

  const entries = readLedger(dir);
  assert.deepEqual(entries.map((entry) => [entry.key, entry.ok, entry.error_class ?? null]), [
    ["env:KEY_A", true, null],
    ["env:KEY_A", true, null],
    ["env:KEY_A", true, null],
  ]);
  assert.deepEqual(core.status().upstreams[0].keys.map((key) => key.state), ["active", "standby"]);
});

test("cost is read from each vendor's field, with dollars and credits kept apart", () => {
  // Firecrawl: an Alexandria execution reports its total as data.creditsCost.
  assert.deepEqual(extractCost(ok({ success: true, data: { alexandria: [{ data: {} }], creditsCost: 7 } })), { credits: 7 });
  assert.deepEqual(extractCost(ok({ success: true, data: { markdown: "x", metadata: { provider: { creditsCost: 30 } } } })), { credits: 30 });
  assert.deepEqual(extractCost(ok({ success: true, data: { creditsCost: 30, metadata: { creditsUsed: 5 } } })), { credits: 5 }, "creditsUsed is the charge when both are present");
  // A catalogue lookup lists a price per capability; none of them was charged.
  assert.equal(extractCost(ok({ success: true, data: { alexandria: [{ data: { tools: [{ capability: "search", creditsCost: 10 }] } }] } })), undefined);
  // Context.dev.
  assert.deepEqual(extractCost(ok({ markdown: "x", key_metadata: { credits_consumed: 3, credits_remaining: 997 } })), { credits: 3 });
  // Serper: top level only.
  assert.deepEqual(extractCost(ok({ organic: [], credits: 2 })), { credits: 2 });
  assert.equal(extractCost(ok({ rows: [{ endpoint: "search", credits: 2 }] })), undefined);
  // Tavily, when the call asked for usage.
  assert.deepEqual(extractCost(ok({ results: [], usage: { credits: 1 } })), { credits: 1 });
  assert.equal(extractCost(ok({ results: [], usage: [{ name: "sku_search", count: 1 }] })), undefined);
  // Units are never merged or converted.
  assert.deepEqual(extractCost(ok({ costDollars: { total: 0.01 }, usage: { credits: 4 } })), { usd: 0.01, credits: 4 });
  assert.deepEqual(extractCost({ content: [], structuredContent: { key_metadata: { credits_consumed: 2 } }, _meta: { "parallel/usage": { cost_usd: 0.005 } } }), { usd: 0.005, credits: 2 });
  assert.equal(extractCost({ content: [{ type: "text", text: "credits: 5 remaining" }] }), undefined);
});

test("argument pins fill what the agent left out, lower what is over the cap, and say so", async () => {
  const dir = tempDir();
  const received = [];
  const connector = async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async ({ name, arguments: args }) => {
      received.push({ name, args });
      return ok({ fine: true });
    },
    close: async () => undefined,
  });
  const core = new GatewayCore(
    makeConfig(dir, {
      exa: {
        url: "https://mcp.example.com/mcp",
        keys: ["env:KEY_A"],
        pin: {
          post_v1_search: { default: { mode: "fast" } },
          createAgentRun: { default: { effort: "low", "budget.maxCostDollars": 0.5 }, max: { "budget.maxCostDollars": 1 } },
          "create*": { default: { effort: "medium", tag: "gateway" }, max: { "budget.maxCostDollars": 3, maxCredits: 100 } },
        },
      },
    }),
    { connector, resolveKey }
  );

  // A default fills only what is missing.
  await core.callTool("exa__post_v1_search", { objective: "q" }, ctx);
  await core.callTool("exa__post_v1_search", { objective: "q", mode: "advanced" }, ctx);
  assert.deepEqual(received.splice(0).map((call) => call.args), [{ objective: "q", mode: "fast" }, { objective: "q", mode: "advanced" }]);

  // Every matching pin applies; the first default wins and the lowest cap wins.
  const given = { query: "q", budget: { maxCostDollars: 5 }, maxCredits: "2500" };
  const clamped = await core.callTool("exa__createAgentRun", given, ctx);
  assert.deepEqual(received.splice(0)[0].args, { query: "q", budget: { maxCostDollars: 1 }, maxCredits: 100, effort: "low", tag: "gateway" });
  assert.deepEqual(given, { query: "q", budget: { maxCostDollars: 5 }, maxCredits: "2500" }, "the agent's own object is left alone");
  assert.equal(clamped.isError, undefined);
  assert.equal(clamped.content[0].text, '{"fine":true}');
  assert.match(clamped.content[1].text, /"budget\.maxCostDollars" was lowered from 5 to 1, the most this gateway allows for exa__createAgentRun/);
  assert.match(clamped.content[2].text, /"maxCredits" was lowered from 2500 to 100/);

  // A cap does not invent an argument; a dotted default does create its parent.
  const within = await core.callTool("exa__createAgentRun", { query: "q" }, ctx);
  assert.deepEqual(received.splice(0)[0].args, { query: "q", effort: "low", budget: { maxCostDollars: 0.5 }, tag: "gateway" });
  assert.equal(within.content.length, 1);

  // Something that cannot be compared with the cap is refused before any call.
  const refused = await core.callTool("exa__createAgentRun", { budget: { maxCostDollars: "unlimited" } }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Argument "budget\.maxCostDollars" must be a number: this gateway allows at most 1/);
  assert.equal(received.length, 0);

  // The ledger and the payload file record the arguments as sent.
  const entries = readLedger(dir);
  assert.equal(entries.length, 4);
  assert.deepEqual(JSON.parse(entries[2].args), { query: "q", budget: { maxCostDollars: 1 }, maxCredits: 100, effort: "low", tag: "gateway" });
  const payload = JSON.parse(readFileSync(path.join(dir, "gateway-payloads", entries[0].payload), "utf8"));
  assert.deepEqual(payload.request.arguments, { objective: "q", mode: "fast" });
});

test("a malformed pin is rejected with the pattern and setting named", () => {
  const withPin = (pin) => () => resolveGatewayConfig({ upstreams: { exa: { keys: ["env:X"], pin } } });
  assert.throws(withPin(["search"]), /upstreams\.exa\.pin must be a table of tool-name patterns/);
  assert.throws(withPin({ search: "fast" }), /upstreams\.exa\.pin\."search" must be a table with default, max and\/or require_one_of/);
  assert.throws(withPin({ search: {} }), /upstreams\.exa\.pin\."search" needs default, max or require_one_of/);
  assert.throws(withPin({ search: { defaults: { mode: "fast" } } }), /upstreams\.exa\.pin\."search"\.defaults is not a pin setting; use default, max or require_one_of/);
  assert.throws(withPin({ search: { default: "fast" } }), /upstreams\.exa\.pin\."search"\.default must be a table of argument names to values/);
  assert.throws(withPin({ search: { max: [1] } }), /upstreams\.exa\.pin\."search"\.max must be a table of argument names to numbers/);
  assert.throws(withPin({ search: { max: { numResults: "10" } } }), /upstreams\.exa\.pin\."search"\.max\."numResults" must be a number/);
  assert.throws(withPin({ search: { max: { budget: { maxCostDollars: 1 } } } }), /upstreams\.exa\.pin\."search"\.max\."budget" must be a number/);
  assert.throws(withPin({ search: { default: { "budget..max": 1 } } }), /upstreams\.exa\.pin\."search"\.default\."budget\.\.max" is not an argument name or dotted path/);

  const [exa] = resolveGatewayConfig({
    upstreams: { exa: { keys: ["env:X"], pin: { "create*": { default: { effort: "low" }, max: { "budget.maxCostDollars": 1 } } } } },
  }).upstreams;
  assert.deepEqual(exa.pins, [
    { pattern: "create*", defaults: [{ path: "effort", value: "low" }], max: [{ path: "budget.maxCostDollars", limit: 1 }] },
  ]);
  assert.deepEqual(resolveGatewayConfig({ upstreams: { custom: { url: "https://mcp.example.com/mcp", keys: ["env:X"] } } }).upstreams[0].pins, []);
});

test("a cap refuses an argument it cannot compare: null, or a dotted name that runs through something that is not an object", async () => {
  const dir = tempDir();
  const received = [];
  const connector = async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async ({ arguments: args }) => {
      received.push(args);
      return ok({ fine: true });
    },
    close: async () => undefined,
  });
  const core = new GatewayCore(
    makeConfig(dir, {
      exa: {
        url: "https://mcp.example.com/mcp",
        keys: ["env:KEY_A"],
        pin: {
          createAgentRun: {
            default: { "budget.maxCostDollars": 0.5, maxCredits: 10 },
            max: { "budget.maxCostDollars": 1, maxCredits: 100, "limits.depth.max": 3 },
          },
        },
      },
    }),
    { connector, resolveKey }
  );

  // Each of these would otherwise reach the upstream with the capped argument
  // unset, leaving the amount to the upstream's own default.
  for (const [args, message] of [
    [{ maxCredits: null }, /^Argument "maxCredits" must be a number: this gateway allows at most 100 for exa__createAgentRun\. Send a number, or leave the argument out\.$/],
    [{ budget: { maxCostDollars: null } }, /^Argument "budget\.maxCostDollars" must be a number: this gateway allows at most 1 for exa__createAgentRun/],
    [{ maxCredits: true }, /^Argument "maxCredits" must be a number/],
    [{ maxCredits: [5000] }, /^Argument "maxCredits" must be a number/],
    [{ budget: null }, /^Argument "budget" must be an object: this gateway allows at most 1 for "budget\.maxCostDollars" of exa__createAgentRun\. Send an object, or leave "budget" out\.$/],
    [{ budget: [{ maxCostDollars: 500 }] }, /^Argument "budget" must be an object/],
    [{ budget: '{"maxCostDollars":500}' }, /^Argument "budget" must be an object/],
    [{ limits: { depth: 9 } }, /^Argument "limits\.depth" must be an object: this gateway allows at most 3 for "limits\.depth\.max"/],
  ]) {
    const refused = await core.callTool("exa__createAgentRun", args, ctx);
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.equal(refused.content.length, 1);
    assert.match(refused.content[0].text, message);
  }
  assert.deepEqual(received, [], "a refused call is not forwarded");

  // Leaving the argument, or the object that holds it, out is still accepted.
  await core.callTool("exa__createAgentRun", { query: "q" }, ctx);
  await core.callTool("exa__createAgentRun", { query: "q", limits: {} }, ctx);
  assert.deepEqual(received, [
    { query: "q", budget: { maxCostDollars: 0.5 }, maxCredits: 10 },
    { query: "q", limits: {}, budget: { maxCostDollars: 0.5 }, maxCredits: 10 },
  ]);
});

test("a 2xx response from an openapi upstream is a successful call, whatever its error field says", async () => {
  const dir = tempDir();
  const used = [];
  const run = { id: "run_1", status: "failed", error: "target site answered 402 Payment Required: unauthorized" };
  const server = await listen((req, res) => {
    used.push(req.headers["x-api-key"] === SECRETS["env:KEY_A"] ? "A" : "B");
    res.setHeader("Content-Type", "application/json");
    // Only the key that started the run can read it.
    if (req.headers["x-api-key"] !== SECRETS["env:KEY_A"]) res.statusCode = 404;
    res.end(req.headers["x-api-key"] === SECRETS["env:KEY_A"] ? JSON.stringify(run) : '{"error":"run not found"}');
  });
  try {
    const spec = writeSpec(dir, "spec.json", {
      paths: { "/runs/{id}": { get: { operationId: "getRun", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } } },
    });
    const core = new GatewayCore(makeConfig(dir, { api: api(server.url, spec) }), { resolveKey });

    const polled = await core.callTool("api__getRun", { id: "run_1" }, ctx);
    assert.equal(polled.isError, undefined);
    assert.deepEqual(JSON.parse(polled.content[0].text), run);
    assert.deepEqual(used, ["A"], "the poll is not re-sent with a key that does not own the run");
    assert.deepEqual(readLedger(dir).map((entry) => [entry.key, entry.ok, entry.error_class ?? null]), [["env:KEY_A", true, null]]);
    assert.deepEqual(core.status().upstreams[0].keys.map((key) => key.state), ["active", "standby"]);
  } finally {
    await server.close();
  }
});

test("a stream whose connection breaks returns the events that arrived, and fails only when none did", async () => {
  const dir = tempDir();
  const server = await listen((req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    const body =
      req.url === "/dropped"
        ? 'event: started\nid: 1\ndata: {"runId":"run_9"}\n\nevent: progress\nid: 2\ndata: {"step":1}\n\nevent: progress\nid: 3\ndata: {"st'
        : 'event: started\nid: 1\ndata: {"runId":"ru';
    // The body is on the wire before the socket goes, as with a proxy's idle timeout.
    res.write(body, () => setTimeout(() => res.socket?.destroy(), 100));
  });
  try {
    const spec = writeSpec(dir, "spec.json", { paths: { "/dropped": { post: { operationId: "dropped" } }, "/dead": { post: { operationId: "dead" } } } });
    const core = new GatewayCore(makeConfig(dir, { api: api(server.url, spec) }), { resolveKey });

    const dropped = await core.callTool("api__dropped", {}, ctx);
    assert.equal(dropped.isError, undefined);
    assert.deepEqual(JSON.parse(dropped.content[0].text), [
      { event: "started", data: { runId: "run_9" }, id: "1" },
      { event: "progress", data: { step: 1 }, id: "2" },
    ]);
    assert.match(dropped.content[1].text, /^Stream cut short: the connection broke before the upstream ended the stream \(.+\)\. The 2 events above arrived before that/);

    const dead = await core.callTool("api__dead", {}, ctx);
    assert.equal(dead.isError, true);
    assert.match(dead.content[0].text, /^api dead failed: /);

    const entries = readLedger(dir);
    assert.deepEqual(entries.map((entry) => [entry.tool, entry.key, entry.ok]), [["dropped", "env:KEY_A", true], ["dead", "env:KEY_A", false]]);
    const payload = readFileSync(path.join(dir, "gateway-payloads", entries[0].payload), "utf8");
    assert.ok(payload.includes("run_9") && payload.includes("Stream cut short"), "the payload file keeps the events and the notice");
    assert.equal(core.status().upstreams[0].keys[0].state, "active", "a broken connection is not held against the key");
  } finally {
    await server.close();
  }
});

test("a key value the upstream echoes is replaced in the tool result, as it is in the ledger", async () => {
  const dir = tempDir();
  const sentKeys = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url, "http://localhost");
    sentKeys.push(req.headers["x-api-key"] ?? url.searchParams.get("token"));
    if (url.pathname === "/rejected") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: `Invalid API key: ${req.headers["x-api-key"]}` }));
    } else if (url.pathname === "/missing") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end(`Cannot GET ${req.url}`);
    } else if (url.pathname === "/stream") {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`data: {"authorizedWith":"${req.headers["x-api-key"]}"}\n\n`);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ headers: req.headers }));
    }
  });
  try {
    const paths = Object.fromEntries(["rejected", "missing", "stream", "echo"].map((name) => [`/${name}`, { get: { operationId: name } }]));
    const spec = writeSpec(dir, "spec.json", { paths });
    const fresh = (name, extra) => new GatewayCore(makeConfig(path.join(dir, name), { api: api(server.url, spec, extra) }), { resolveKey });
    const values = Object.values(SECRETS);
    const results = [];

    const rejected = await fresh("one").callTool("api__rejected", {}, ctx);
    results.push(rejected);
    assert.equal(rejected.isError, true);
    assert.equal(
      rejected.content[0].text,
      'api: all 2 configured keys failed (out of credit or rejected). Last error: HTTP 401: {"error":"Invalid API key: [redacted]"}'
    );

    const missing = await fresh("two", { auth: "query", auth_name: "token" }).callTool("api__missing", {}, ctx);
    results.push(missing);
    assert.equal(missing.content[0].text, "HTTP 404: Cannot GET /missing?token=[redacted]");

    const stream = await fresh("three").callTool("api__stream", {}, ctx);
    results.push(stream);
    assert.deepEqual(JSON.parse(stream.content[0].text), [{ event: "message", data: { authorizedWith: "[redacted]" } }]);

    const echo = await fresh("four").callTool("api__echo", {}, ctx);
    results.push(echo);
    assert.equal(echo.isError, undefined);
    assert.equal(JSON.parse(echo.content[0].text).headers["x-api-key"], "[redacted]");

    assert.deepEqual(sentKeys, [values[0], values[1], values[0], values[0], values[0]], "the upstream itself was sent the real key");

    // An MCP server's result is covered too, wherever in it the value sits.
    const connector = async (_upstream, keyValue) => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({
        content: [{ type: "text", text: `called with ${keyValue}` }, { type: "resource", resource: { uri: "memo://1", text: `key=${keyValue}` } }],
        structuredContent: { request: { headers: [{ name: "authorization", value: `Bearer ${keyValue}` }] }, count: 2 },
      }),
      close: async () => undefined,
    });
    const mcp = new GatewayCore(
      makeConfig(path.join(dir, "five"), { hosted: { url: "https://mcp.example.com/mcp", keys: ["env:KEY_A"] } }),
      { connector, resolveKey }
    );
    const hosted = await mcp.callTool("hosted__search", {}, ctx);
    results.push(hosted);
    assert.deepEqual(hosted, {
      content: [{ type: "text", text: "called with [redacted]" }, { type: "resource", resource: { uri: "memo://1", text: "key=[redacted]" } }],
      structuredContent: { request: { headers: [{ name: "authorization", value: "Bearer [redacted]" }] }, count: 2 },
    });

    for (const result of results) {
      for (const value of values) assert.equal(JSON.stringify(result).includes(value), false);
    }
    for (const name of ["one", "two", "three", "four", "five"]) {
      for (const entry of readLedger(path.join(dir, name))) {
        const payload = readFileSync(path.join(dir, name, "gateway-payloads", entry.payload), "utf8");
        for (const value of values) assert.equal((JSON.stringify(entry) + payload).includes(value), false);
      }
    }
  } finally {
    await server.close();
  }
});

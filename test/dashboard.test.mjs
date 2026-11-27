import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  GatewayCore,
  collectKeyStatus,
  parseGatewayArgs,
  resolveGatewayConfig,
  resolveKeysConfig,
  startHttpGateway,
} from "../dist/index.js";

const TOKEN = "gateway-token-for-tests";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

// Stand-in key values. Each is unique so a leak into a response is detectable.
const KEYS = {
  FIRECRAWL_API_KEY_1: "test-key-firecrawl-one-0001",
  FIRECRAWL_API_KEY_2: "test-key-firecrawl-two-0002",
  FIRECRAWL_API_KEY_3: "test-key-firecrawl-three-0003",
  FIRECRAWL_API_KEY_4: "test-key-firecrawl-four-0004",
};
const UPSTREAM_KEY = "test-key-upstream-exa-0001";
const KEY_VALUES = [...Object.values(KEYS), UPSTREAM_KEY];

/** Firecrawl usage bodies by key. Keys 1 and 2 are one team; key 4 is under the floor of 100. */
const USAGE = {
  [KEYS.FIRECRAWL_API_KEY_1]: { remainingCredits: 1200, planCredits: 1500, billingPeriodStart: "2026-11-10T08:15:42.123Z", billingPeriodEnd: "2026-12-10T08:15:42.123Z" },
  [KEYS.FIRECRAWL_API_KEY_2]: { remainingCredits: 1200, planCredits: 1500, billingPeriodStart: "2026-11-10T08:15:42.123Z", billingPeriodEnd: "2026-12-10T08:15:42.123Z" },
  [KEYS.FIRECRAWL_API_KEY_3]: { remainingCredits: 940, planCredits: 1000, billingPeriodStart: "2026-11-18T10:01:07.456Z", billingPeriodEnd: "2026-12-18T10:01:07.456Z" },
  [KEYS.FIRECRAWL_API_KEY_4]: { remainingCredits: 60, planCredits: 1000, billingPeriodStart: "2026-11-05T19:30:00.789Z", billingPeriodEnd: "2026-12-05T19:30:00.789Z" },
};

const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-dash-"));
  tempDirs.push(dir);
  return dir;
}

/** A stand-in for Firecrawl's usage endpoint: answers by bearer key, 401 for a key it does not know. */
async function usageServer() {
  const server = createServer((req, res) => {
    const usage = USAGE[req.headers.authorization?.replace(/^Bearer /, "")];
    res.writeHead(usage ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(usage ? { success: true, data: usage } : { success: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** An in-memory SecretStore in place of the doppler CLI; `writes` records every set. */
function memoryStore(slotTarget) {
  const secrets = { FIRECRAWL_API_KEY: `\${${slotTarget}}`, ...KEYS };
  const writes = [];
  const resolve = (text) => text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name) => (name in secrets ? resolve(secrets[name]) : whole));
  const need = (name) => {
    if (!(name in secrets)) throw new Error(`Could not read ${name}: not found`);
    return secrets[name];
  };
  const store = () => ({
    get: async (name) => resolve(need(name)),
    getRaw: async (name) => need(name),
    set: async (name, value) => {
      writes.push({ name, value });
      secrets[name] = value;
    },
  });
  return { store, writes, secrets };
}

function keysConfig(usageUrl) {
  return resolveKeysConfig({
    firecrawl: {
      slot: "FIRECRAWL_API_KEY",
      pool: Object.keys(KEYS),
      project: "example-project",
      config: "prd",
      floor: 100,
      base_url: usageUrl,
    },
  });
}

/** A gateway core over fake upstreams (one `exa` unless given), with its ledger and state in `dir`. */
function makeCore(dir, upstreams = { exa: { keys: ["env:EXA_KEY_A", "env:EXA_KEY_B"] } }) {
  const connector = async () => ({
    listTools: async () => ({ tools: [{ name: "search", description: "search", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ costDollars: { total: 0.007 } }) }] }),
    close: async () => undefined,
  });
  const config = resolveGatewayConfig({
    ledger: path.join(dir, "ledger.jsonl"),
    state: path.join(dir, "state.json"),
    skills_dir: path.join(dir, "skills"),
    upstreams,
  });
  return new GatewayCore(config, { connector, resolveKey: async () => UPSTREAM_KEY });
}

/** Start an HTTP gateway on a free loopback port; `stop` shuts it down. */
async function serve(core, options = {}) {
  const server = await startHttpGateway(core, [], { host: "127.0.0.1", port: 0, token: TOKEN, note: () => undefined, ...options });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return { base, stop };
}

function entry(agoMs, fields = {}) {
  return {
    ts: new Date(Date.now() - agoMs).toISOString(),
    session: "s1",
    client: "test/1.0",
    upstream: "exa",
    tool: "search",
    key: "env:EXA_KEY_A",
    attempt: 1,
    ok: true,
    duration_ms: 100,
    ...fields,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One request with exactly the headers given, `Host` included, which `fetch` would not let a caller choose. */
function rawRequest(base, route, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base + route, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A stand-in for a browser's DOM node, with only what the dashboard script uses. */
class FakeNode {
  constructor(tagName, text) {
    this.tagName = tagName;
    this.text = text;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.hidden = false;
    this.className = "";
    this.value = "";
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "class") this.className = value;
  }
  addEventListener(name, listener) {
    (this.listeners[name] ??= []).push(listener);
  }
  focus() {}
  get textContent() {
    return this.text ?? this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.children = value === "" ? [] : [new FakeNode("#text", String(value))];
  }
  /** Every descendant with this tag, in document order. */
  all(tagName) {
    return this.children.flatMap((child) => [...(child.tagName === tagName ? [child] : []), ...child.all(tagName)]);
  }
}

/**
 * Run the served dashboard script against the gateway at `base`, as a tab
 * holding `token` would. The script is the one in the served page, the
 * elements are the ids the served page has, and its fetches go to the real
 * endpoints; only the DOM is a stand-in. Returns the elements by id.
 */
async function openPage(base, token) {
  const html = await (await fetch(`${base}/dashboard`)).text();
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const byId = new Map([...html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"([^>]*)>/g)].map(([tag, name, id]) => {
    const node = new FakeNode(name);
    node.hidden = /\shidden\b/.test(tag);
    return [id, node];
  }));
  const stored = new Map(token ? [["coldsearch.gateway.token", token]] : []);
  vm.runInNewContext(script, {
    document: {
      visibilityState: "visible",
      // An id the page does not have is null, as in a browser, so a script that asks for one fails here too.
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tagName) => new FakeNode(tagName),
      createTextNode: (text) => new FakeNode("#text", String(text)),
    },
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    fetch: (route, init) => fetch(base + route, init),
    setInterval: () => 0,
  });
  return Object.fromEntries(byId);
}

/** Wait for the page to show something; fails naming it when it never does. */
async function until(check, what) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the page never showed ${what}`);
}

test("the JSON endpoints need the bearer token; the page shell and the health check do not", async () => {
  const dir = tempDir();
  const core = makeCore(dir);
  await core.callTool("exa__search", { query: "q" }, { session: "s1", client: "test/1.0" });
  const { base, stop } = await serve(core);
  try {
    for (const [method, route] of [["GET", "/api/status"], ["GET", "/api/ledger"], ["GET", "/api/keys"], ["POST", "/api/keys/rotate"], ["GET", "/api/nothing"]]) {
      const missing = await fetch(base + route, { method });
      assert.equal(missing.status, 401, `${method} ${route} without a token`);
      const wrong = await fetch(base + route, { method, headers: { Authorization: "Bearer wrong" } });
      assert.equal(wrong.status, 401, `${method} ${route} with a wrong token`);
    }
    assert.equal((await fetch(`${base}/dashboard`)).status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    const response = await fetch(`${base}/api/status`, { headers: AUTH });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.deepEqual(status.upstreams[0].keys, [
      { key: "env:EXA_KEY_A", state: "active" },
      { key: "env:EXA_KEY_B", state: "standby" },
    ]);
    assert.equal(status.last_24h[0].calls, 1);
    assert.equal(status.last_24h[0].usd, 0.007);

    assert.equal((await fetch(`${base}/api/status`, { method: "POST", headers: AUTH })).status, 405);
    assert.equal((await fetch(`${base}/api/nothing`, { headers: AUTH })).status, 404);
  } finally {
    await stop();
  }
});

test("/api/ledger returns the newest entries first by start time, within the window, for one upstream, up to the limit", async () => {
  const dir = tempDir();
  const core = makeCore(dir);
  // File order is completion order: the slow call started first and was written last.
  const lines = [
    entry(30 * HOUR, { tool: "outside-the-default-window" }),
    entry(3 * HOUR, { tool: "three-hours" }),
    "not a ledger line",
    entry(20 * MINUTE, { tool: "twenty-minutes", upstream: "tavily", key: "env:TAVILY_KEY" }),
    entry(5 * MINUTE, { tool: "five-minutes", payload: "2026-11-27/no-such-file.json" }),
    entry(40 * MINUTE, { tool: "slow-forty-minutes", duration_ms: 38 * MINUTE }),
  ];
  writeFileSync(path.join(dir, "ledger.jsonl"), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  const { base, stop } = await serve(core);
  const get = async (query) => {
    const response = await fetch(`${base}/api/ledger${query}`, { headers: AUTH });
    return { status: response.status, body: await response.json() };
  };
  const tools = (body) => body.entries.map((item) => item.tool);
  try {
    const day = (await get("")).body;
    assert.deepEqual(tools(day), ["five-minutes", "twenty-minutes", "slow-forty-minutes", "three-hours"]);
    assert.deepEqual({ since: day.since, upstream: day.upstream, limit: day.limit, matched: day.matched }, { since: "24h", upstream: null, limit: 200, matched: 4 });

    // The payload file is named, not opened: it does not exist, and no request or response body is returned.
    assert.equal(day.entries[0].payload, "2026-11-27/no-such-file.json");
    assert.ok(!("request" in day.entries[0]) && !("response" in day.entries[0]));

    assert.deepEqual(tools((await get("?since=1h")).body), ["five-minutes", "twenty-minutes", "slow-forty-minutes"]);
    assert.deepEqual(tools((await get("?since=2d")).body).at(-1), "outside-the-default-window");
    assert.deepEqual(tools((await get("?upstream=tavily")).body), ["twenty-minutes"]);

    const limited = (await get("?limit=2")).body;
    assert.deepEqual(tools(limited), ["five-minutes", "twenty-minutes"]);
    assert.equal(limited.matched, 4);

    const badSince = await get("?since=yesterday");
    assert.equal(badSince.status, 400);
    assert.match(badSince.body.error, /since/);
    for (const limit of ["0", "1001", "ten"]) {
      const bad = await get(`?limit=${limit}`);
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /limit/);
    }
  } finally {
    await stop();
  }
});

test("the ledger reader keeps the newest entries however many lines the file holds and in whatever order, and a ledger not yet written is empty", async () => {
  const dir = tempDir();
  const core = makeCore(dir);
  assert.deepEqual(await core.ledger.recent({ sinceMs: HOUR, limit: 5 }), { entries: [], matched: 0 });

  // 500 entries, ages scattered through the file so the newest are not at the end.
  const lines = [];
  for (let i = 0; i < 500; i++) {
    const age = ((i * 137) % 500) + 1;
    lines.push(JSON.stringify(entry(age * 1000, { tool: `age-${age}`, args: "x".repeat(400) })));
  }
  writeFileSync(path.join(dir, "ledger.jsonl"), lines.join("\n"));
  const page = await core.ledger.recent({ sinceMs: HOUR, limit: 5 });
  assert.deepEqual(page.entries.map((item) => item.tool), ["age-1", "age-2", "age-3", "age-4", "age-5"]);
  assert.equal(page.matched, 500);
});

test("/api/keys is a 404 that says why without a [keys] section, and with one returns what keys status --json prints", async () => {
  const dir = tempDir();
  const usage = await usageServer();
  const without = await serve(makeCore(dir));
  try {
    const response = await fetch(`${without.base}/api/keys`, { headers: AUTH });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /no \[keys\] section/);
  } finally {
    await without.stop();
  }

  const config = keysConfig(usage.url);
  const deps = { store: memoryStore("FIRECRAWL_API_KEY_4").store };
  const withKeys = await serve(makeCore(dir), { keys: config, keysDeps: deps });
  try {
    const response = await fetch(`${withKeys.base}/api/keys`, { headers: AUTH });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-coldsearch-rotate"), "disabled");
    const text = await response.text();
    for (const value of KEY_VALUES) assert.ok(!text.includes(value), "a key value reached /api/keys");

    const body = JSON.parse(text);
    assert.deepEqual(body, (await collectKeyStatus(config, undefined, deps)).report);
    const [firecrawl] = body.providers;
    assert.equal(firecrawl.points_at, "FIRECRAWL_API_KEY_4");
    assert.deepEqual(firecrawl.accounts.map((account) => [account.keys.join("+"), account.remaining, account.in_slot]), [
      ["FIRECRAWL_API_KEY_1+FIRECRAWL_API_KEY_2", 1200, false],
      ["FIRECRAWL_API_KEY_3", 940, false],
      ["FIRECRAWL_API_KEY_4", 60, true],
    ]);

    const unknown = await fetch(`${withKeys.base}/api/keys?provider=tavily`, { headers: AUTH });
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).error, /keys\.tavily/);
  } finally {
    await withKeys.stop();
    await usage.close();
  }
});

test("rotation over HTTP is off unless the gateway was started to allow it, and then needs the confirm header; a dry run writes nothing", async () => {
  const dir = tempDir();
  const usage = await usageServer();
  const config = keysConfig(usage.url);
  const fake = memoryStore("FIRECRAWL_API_KEY_4");
  const deps = { store: fake.store };
  const post = (base, body, headers = {}) =>
    fetch(`${base}/api/keys/rotate`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const confirm = { "X-Coldsearch-Confirm": "rotate" };

  assert.throws(() => parseGatewayArgs(["--allow-rotate"]), /--http/);
  await assert.rejects(
    startHttpGateway(makeCore(dir), [], { host: "127.0.0.1", port: 0, keys: config, allowRotate: true }),
    /without a token/
  );
  await assert.rejects(
    startHttpGateway(makeCore(dir), [], { host: "127.0.0.1", port: 0, token: TOKEN, allowRotate: true }),
    /\[keys\] section/
  );

  const closed = await serve(makeCore(dir), { keys: config, keysDeps: deps });
  try {
    const refused = await post(closed.base, { provider: "firecrawl", dry_run: true }, confirm);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /--allow-rotate/);
  } finally {
    await closed.stop();
  }

  const notes = [];
  const open = await serve(makeCore(dir), { keys: config, keysDeps: deps, allowRotate: true, note: (message) => notes.push(message) });
  try {
    for (const headers of [{}, { "X-Coldsearch-Confirm": "yes" }]) {
      const unconfirmed = await post(open.base, { provider: "firecrawl" }, headers);
      assert.equal(unconfirmed.status, 403);
      assert.match((await unconfirmed.json()).error, /X-Coldsearch-Confirm: rotate/);
    }
    assert.equal((await fetch(`${open.base}/api/keys/rotate`, { headers: { ...AUTH, ...confirm } })).status, 405);
    assert.deepEqual(fake.writes, []);

    const dry = await post(open.base, { provider: "firecrawl", dry_run: true }, confirm);
    assert.equal(dry.status, 200);
    const dryText = await dry.text();
    for (const value of KEY_VALUES) assert.ok(!dryText.includes(value), "a key value reached the rotate response");
    const preview = JSON.parse(dryText);
    assert.match(preview.reason, /^soonest-reset: its period ends 2026-12-10/);
    delete preview.reason;
    assert.deepEqual(preview, {
      provider: "firecrawl",
      slot: "FIRECRAWL_API_KEY",
      outcome: "dry-run",
      before: "FIRECRAWL_API_KEY_4",
      after: "FIRECRAWL_API_KEY_1",
      dry_run: true,
    });
    assert.deepEqual(fake.writes, []);
    assert.equal(fake.secrets.FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY_4}");

    for (const [body, status, pattern] of [
      [{ provider: "tavily" }, 404, /keys\.tavily/],
      [{ provider: "firecrawl", force: true }, 400, /Unknown field "force"/],
      [{ provider: "firecrawl", dry_run: "yes" }, 400, /dry_run/],
      [{ provider: "firecrawl", to: "SOME_OTHER_SECRET" }, 400, /pool/],
    ]) {
      const bad = await post(open.base, body, confirm);
      assert.equal(bad.status, status);
      assert.match((await bad.json()).error, pattern);
    }
    assert.deepEqual(fake.writes, []);

    // The same request without dry_run is the write: one reference, to the slot, and the page can see it took.
    const done = await post(open.base, { provider: "firecrawl", to: "FIRECRAWL_API_KEY_3" }, confirm);
    assert.equal(done.status, 200);
    const result = await done.json();
    assert.deepEqual([result.outcome, result.before, result.after, result.dry_run], ["rotated", "FIRECRAWL_API_KEY_4", "FIRECRAWL_API_KEY_3", false]);
    assert.deepEqual(fake.writes, [{ name: "FIRECRAWL_API_KEY", value: "${FIRECRAWL_API_KEY_3}" }]);
    const after = await (await fetch(`${open.base}/api/keys`, { headers: AUTH })).json();
    assert.equal(after.providers[0].points_at, "FIRECRAWL_API_KEY_3");

    // Every request that reached the rotation left an operator line: the dry run, the refused target, the write.
    assert.equal(notes.length, 3);
    assert.match(notes[0], /rotate firecrawl over HTTP: dry-run \(FIRECRAWL_API_KEY_4 -> FIRECRAWL_API_KEY_1\)/);
    assert.match(notes[1], /rotate firecrawl over HTTP: failed/);
    assert.match(notes[2], /rotate firecrawl over HTTP: rotated \(FIRECRAWL_API_KEY_4 -> FIRECRAWL_API_KEY_3\)/);
  } finally {
    await open.stop();
    await usage.close();
  }
});

test("a rotation the policy refuses is a 409 that says why, and nothing is written", async () => {
  const dir = tempDir();
  // No usage endpoint answers, so no account is known to be above the floor.
  const config = keysConfig("http://127.0.0.1:9");
  const fake = memoryStore("FIRECRAWL_API_KEY_4");
  const { base, stop } = await serve(makeCore(dir), { keys: config, keysDeps: { store: fake.store }, allowRotate: true });
  try {
    const response = await fetch(`${base}/api/keys/rotate`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", "X-Coldsearch-Confirm": "rotate" },
      body: JSON.stringify({ provider: "firecrawl" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.deepEqual([body.outcome, body.before, body.after], ["refused", "FIRECRAWL_API_KEY_4", null]);
    assert.match(body.reason, /could not be read/);
    assert.deepEqual(fake.writes, []);
  } finally {
    await stop();
  }
});

test("/dashboard is one self-contained page that holds no token, no key and no data, and whose script is the only one allowed to run", async () => {
  const dir = tempDir();
  const usage = await usageServer();
  const core = makeCore(dir);
  await core.callTool("exa__search", { query: "q" }, { session: "s1", client: "test/1.0" });
  const { base, stop } = await serve(core, { keys: keysConfig(usage.url), keysDeps: { store: memoryStore("FIRECRAWL_API_KEY_4").store }, allowRotate: true });
  try {
    const response = await fetch(`${base}/dashboard`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    const html = await response.text();

    assert.ok(!html.includes(TOKEN), "the gateway token is in the page");
    for (const value of KEY_VALUES) assert.ok(!html.includes(value), "a key value is in the page");
    // The shell is the same for every gateway: nothing about this one's keys, upstreams or ledger is in it.
    for (const text of ["FIRECRAWL_API_KEY", "EXA_KEY_A", "example-project", dir]) {
      assert.ok(!html.includes(text), `${text} is in the page shell`);
    }

    // Nothing is loaded from anywhere: no URL with a host, no linked stylesheet, script file, image or frame.
    assert.doesNotMatch(html, /https?:\/\/|<link\b|<img\b|<iframe\b|\bsrc=|@import|url\(/i);

    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    const style = html.slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"));
    assert.doesNotThrow(() => new vm.Script(script), "the page script does not compile");
    // API data is written as text only, so a tool name or error from a provider cannot become markup.
    assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);

    const csp = response.headers.get("content-security-policy");
    const hash = (text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
    assert.ok(csp.includes(`script-src ${hash(script)}`), "the CSP does not name the inline script");
    assert.ok(csp.includes(`style-src ${hash(style)}`), "the CSP does not name the inline stylesheet");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  } finally {
    await stop();
    await usage.close();
  }
});

test("a gateway started without a token serves no /api/ data, whatever Host, Origin or token the request carries", async () => {
  const dir = tempDir();
  const usage = await usageServer();
  const core = makeCore(dir);
  await core.callTool("exa__search", { query: "a-private-query" }, { session: "s1", client: "test/1.0" });
  // A secret store that counts its reads: a refused request must not reach it.
  const fake = memoryStore("FIRECRAWL_API_KEY_4");
  let storeReads = 0;
  const store = () => {
    const real = fake.store();
    return {
      ...real,
      get: (name) => ((storeReads += 1), real.get(name)),
      getRaw: (name) => ((storeReads += 1), real.getRaw(name)),
    };
  };
  const { base, stop } = await serve(core, { token: undefined, keys: keysConfig(usage.url), keysDeps: { store } });
  const port = new URL(base).port;
  try {
    const callers = [
      {},
      { Host: `127.0.0.1:${port}`, Origin: base },
      // A page whose hostname was re-pointed at 127.0.0.1 sends its own name as Host and Origin.
      { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` },
      { Host: `127.0.0.1:${port}`, Authorization: "Bearer anything" },
    ];
    const routes = [
      ["GET", "/api/status"],
      ["GET", "/api/ledger?since=3650d&limit=1000"],
      ["GET", "/api/keys"],
      ["POST", "/api/keys/rotate"],
      ["OPTIONS", "/api/ledger"],
      ["GET", "/api/nothing"],
    ];
    for (const headers of callers) {
      for (const [method, route] of routes) {
        const response = await rawRequest(base, route, { method, headers });
        const who = `${method} ${route} as ${JSON.stringify(headers)}`;
        assert.equal(response.status, 403, who);
        assert.equal(response.headers["x-coldsearch-api"], "token-required", who);
        assert.match(JSON.parse(response.text).error, /COLDSEARCH_GATEWAY_TOKEN/, who);
        for (const text of ["a-private-query", "EXA_KEY_A", "FIRECRAWL_API_KEY", "example-project", dir]) {
          assert.ok(!response.text.includes(text), `${who} returned ${text}`);
        }
      }
    }
    assert.equal(storeReads, 0, "a refused request read the secret store");

    // What needs no token still answers, and /mcp keeps its loopback rule: it is not refused for want of a token.
    assert.equal((await fetch(`${base}/dashboard`)).status, 200);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/mcp`)).status, 400);

    // The page says the endpoints are off and does not ask for a token no one can give.
    const page = await openPage(base, "");
    await until(() => !page.gate.hidden, "that the gateway has no token");
    assert.match(page["gate-note"].textContent, /COLDSEARCH_GATEWAY_TOKEN/);
    assert.equal(page["gate-ask"].hidden, true);
    assert.equal(page.app.hidden, true);
    assert.equal(storeReads, 0);
  } finally {
    await stop();
    await usage.close();
  }
});

test("/api/status totals come from one pass over the ledger, agree with /api/ledger, and skip lines that are not entries", async () => {
  const dir = tempDir();
  const core = makeCore(dir);
  const lines = [
    entry(10 * DAY, { tool: "outside-both-windows" }),
    entry(3 * DAY, { ok: false, error_class: "quota", key: "env:EXA_KEY_B" }),
    "not a ledger line",
    "null",
    JSON.stringify({ ts: "not a time", upstream: "exa", tool: "search", key: "env:EXA_KEY_A", ok: true }),
    entry(2 * DAY, { cost: { usd: 0.25 } }),
    entry(5 * MINUTE, { cost: { usd: 0.5, credits: 3 } }),
    entry(20 * MINUTE, { upstream: "tavily", key: "env:TAVILY_KEY", ok: false, error_class: "upstream" }),
  ];
  // No newline after the last line, as when the gateway is read mid-write.
  writeFileSync(path.join(dir, "ledger.jsonl"), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"));
  const { base, stop } = await serve(core);
  const get = async (route) => (await fetch(base + route, { headers: AUTH })).json();
  const figures = (rows) => rows.map((row) => [row.upstream, row.key, row.calls, row.errors, row.quota_errors, row.usd, row.credits]);
  try {
    const status = await get("/api/status");
    assert.ok(!("ledger_error" in status));
    assert.deepEqual(figures(status.last_24h), [
      ["exa", "env:EXA_KEY_A", 1, 0, 0, 0.5, 3],
      ["tavily", "env:TAVILY_KEY", 1, 1, 0, 0, 0],
    ]);
    assert.deepEqual(figures(status.last_7d), [
      ["exa", "env:EXA_KEY_A", 2, 0, 0, 0.75, 3],
      ["exa", "env:EXA_KEY_B", 1, 1, 1, 0, 0],
      ["tavily", "env:TAVILY_KEY", 1, 1, 0, 0, 0],
    ]);
    // The Upstreams table and the Recent calls table are read separately; they must count the same calls.
    const calls = (rows) => rows.reduce((sum, row) => sum + row.calls, 0);
    assert.equal(calls(status.last_24h), (await get("/api/ledger?since=24h")).matched);
    assert.equal(calls(status.last_7d), (await get("/api/ledger?since=7d")).matched);
  } finally {
    await stop();
  }
});

test("a ledger that cannot be read is named in /api/status, not counted as no calls, and the key states are still returned", async () => {
  const dir = tempDir();
  const core = makeCore(dir);
  // A directory where the ledger file should be: every read of it fails, and the path is not missing.
  mkdirSync(path.join(dir, "ledger.jsonl"));
  const { base, stop } = await serve(core);
  try {
    const response = await fetch(`${base}/api/status`, { headers: AUTH });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.match(status.ledger_error, /ledger\.jsonl could not be read \(EISDIR\)/);
    assert.deepEqual([status.last_24h, status.last_7d], [[], []]);
    assert.deepEqual(status.upstreams[0].keys.map((key) => key.state), ["active", "standby"]);

    // Recent calls reads the same file and refuses in its own way; neither reports an empty ledger.
    const recent = await fetch(`${base}/api/ledger`, { headers: AUTH });
    assert.equal(recent.status, 500);
    assert.match((await recent.json()).error, /could not be read/);
  } finally {
    await stop();
  }
});

test("reading the status does not hold the gateway's thread for the length of the ledger", async () => {
  const dir = tempDir();
  const core = makeCore(dir);
  // About 1.5 MB, so the reader needs more than twenty reads to get through it.
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(JSON.stringify(entry((i + 1) * 1000, { args: "x".repeat(400) })));
  writeFileSync(path.join(dir, "ledger.jsonl"), lines.join("\n") + "\n");

  // Count event-loop turns that pass while the status is being read. Other requests are served on those turns;
  // a reader that loads and parses the file in one go would give them none.
  let turns = 0;
  let reading = true;
  const turn = () => {
    if (!reading) return;
    turns += 1;
    setImmediate(turn);
  };
  setImmediate(turn);
  let status;
  try {
    status = await core.readStatus();
  } finally {
    reading = false;
  }

  assert.equal(status.last_24h[0].calls, 3000);
  assert.ok(turns >= 10, `only ${turns} event-loop turns passed during the read`);
});

test("the Upstreams table does not call a key or upstream missing from the config when it is in it", async () => {
  const dir = tempDir();
  const core = makeCore(dir, {
    exa: { keys: ["env:EXA_KEY_A"] },
    // An upstream that takes no key: its key list is empty and its calls are recorded under "<name>:keyless".
    searx: { url: "http://127.0.0.1:9/mcp", auth: "none" },
  });
  await core.callTool("searx__search", { query: "q" }, { session: "s1", client: "test/1.0" });
  await core.callTool("exa__search", { query: "q" }, { session: "s1", client: "test/1.0" });
  // Calls from before a config change: a key no longer listed, and an upstream no longer configured.
  const ledgerPath = path.join(dir, "ledger.jsonl");
  const old = [
    entry(2 * HOUR, { key: "env:EXA_KEY_REMOVED" }),
    entry(2 * HOUR, { upstream: "retired", key: "retired:keyless" }),
  ];
  writeFileSync(ledgerPath, old.map((line) => JSON.stringify(line)).join("\n") + "\n", { flag: "a" });

  const { base, stop } = await serve(core);
  try {
    const status = await (await fetch(`${base}/api/status`, { headers: AUTH })).json();
    assert.deepEqual(status.upstreams.find((upstream) => upstream.name === "searx").keys, []);
    assert.ok(status.last_7d.some((row) => row.key === "searx:keyless"));

    const page = await openPage(base, TOKEN);
    await until(() => page["upstreams-body"].all("tr").length > 2, "the Upstreams table");
    // Each body row as [name or key, state].
    const rows = Object.fromEntries(
      page["upstreams-body"].all("tr").map((row) => row.all("td").map((cell) => cell.textContent)).filter((cells) => cells.length).map((cells) => [cells[0], cells[1]])
    );
    assert.equal(rows["searx:keyless"], "no key: this upstream takes none");
    assert.equal(rows["env:EXA_KEY_A"], "active");
    assert.equal(rows["env:EXA_KEY_REMOVED"], "not in the config now");
    assert.equal(rows.retired, "not in the config now");
    assert.equal(rows["retired:keyless"], "not in the config now");
    assert.match(rows.searx, /tools/);
    assert.equal(page.alert.hidden, true);
    assert.equal(page.app.hidden, false);
  } finally {
    await stop();
  }
});

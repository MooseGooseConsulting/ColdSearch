import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chooseRotationTarget,
  collectKeyStatus,
  readAllowance,
  referencedSecret,
  resolveKeysConfig,
  rotateSlot,
} from "../dist/index.js";

// Stand-in key values. Each is unique so a leak into output or argv is detectable.
const KEYS = {
  FIRECRAWL_API_KEY_1: "test-key-firecrawl-one-0001",
  FIRECRAWL_API_KEY_2: "test-key-firecrawl-two-0002",
  FIRECRAWL_API_KEY_3: "test-key-firecrawl-three-0003",
  FIRECRAWL_API_KEY_4: "test-key-firecrawl-four-0004",
  TAVILY_API_KEY_1: "test-key-tavily-one-0001",
  TAVILY_API_KEY_2: "test-key-tavily-two-0002",
  SERPER_API_KEY_1: "test-key-serper-one-0001",
  EXA_API_KEY_1: "test-key-exa-one-0001",
  EXA_API_KEY_2: "test-key-exa-two-0002",
};
const KEY_VALUES = Object.values(KEYS);

/** Firecrawl usage bodies by key. Keys 1 and 2 are one team: same period and plan. */
const FIRECRAWL = {
  [KEYS.FIRECRAWL_API_KEY_1]: { remainingCredits: 1200, planCredits: 1500, billingPeriodStart: "2026-11-10T08:15:42.123Z", billingPeriodEnd: "2026-12-10T08:15:42.123Z" },
  [KEYS.FIRECRAWL_API_KEY_2]: { remainingCredits: 1200, planCredits: 1500, billingPeriodStart: "2026-11-10T08:15:42.123Z", billingPeriodEnd: "2026-12-10T08:15:42.123Z" },
  [KEYS.FIRECRAWL_API_KEY_3]: { remainingCredits: 940, planCredits: 1000, billingPeriodStart: "2026-11-18T10:01:07.456Z", billingPeriodEnd: "2026-12-18T10:01:07.456Z" },
  [KEYS.FIRECRAWL_API_KEY_4]: { remainingCredits: 60, planCredits: 1000, billingPeriodStart: "2026-11-05T19:30:00.789Z", billingPeriodEnd: "2026-12-05T19:30:00.789Z" },
};

/**
 * A stand-in for the providers' usage endpoints, one path prefix per provider.
 * `overrides` replaces the firecrawl bodies; every request is recorded.
 */
async function usageServer(overrides = {}) {
  const requests = [];
  const firecrawl = { ...FIRECRAWL, ...overrides };
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.url === "/firecrawl/v2/team/credit-usage") {
      return firecrawl[bearer] ? send(200, { success: true, data: firecrawl[bearer] }) : send(401, { success: false, error: `Unauthorized: ${bearer}` });
    }
    if (req.url === "/tavily/usage") {
      if (bearer === KEYS.TAVILY_API_KEY_1) return send(200, { key: { usage: 5 }, account: { current_plan: "Researcher", plan_usage: 720, plan_limit: 1000 } });
      if (bearer === KEYS.TAVILY_API_KEY_2) return send(200, { key: { usage: 5 }, account: { current_plan: "Researcher" } });
      return send(401, { detail: "Unauthorized" });
    }
    if (req.url === "/serper/account") {
      return req.headers["x-api-key"] === KEYS.SERPER_API_KEY_1 ? send(200, { balance: 2420, rateLimit: 50 }) : send(403, {});
    }
    if (req.url === "/broken/v2/team/credit-usage") return send(200, "<html>not json</html>");
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * A stand-in `doppler` executable. It keeps secrets in a JSON file, resolves
 * `${NAME}` references on a plain read, refuses a call without the expected
 * -p and -c, refuses a `set` that carries its value in argv, and appends its
 * argv to a log. PATH for the child holds only this directory, so the real
 * CLI cannot be reached.
 */
const FAKE_DOPPLER = `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOPPLER_LOG, JSON.stringify(argv) + "\\n");
const after = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const fail = (message) => { process.stderr.write("Doppler Error: " + message + "\\n"); process.exit(1); };
if (after("-p") !== "example-project" || after("-c") !== "prd") fail("wrong or missing -p/-c");
const store = JSON.parse(fs.readFileSync(process.env.FAKE_DOPPLER_STORE, "utf8"));
const resolve = (text, depth = 0) =>
  text.replace(/\\$\\{([A-Z0-9_]+)\\}/g, (whole, name) => (name in store && depth < 5 ? resolve(store[name], depth + 1) : whole));
const [group, verb, name] = argv;
if (group !== "secrets") fail("unsupported command");
if (verb === "get") {
  if (!(name in store)) fail("Could not find requested secret: " + name);
  process.stdout.write((argv.includes("--raw") ? store[name] : resolve(store[name])) + "\\n");
} else if (verb === "set") {
  if (argv.length !== 9 || !argv.includes("--silent") || !argv.includes("--no-interactive")) fail("set must take its value on stdin");
  store[name] = fs.readFileSync(0, "utf8");
  fs.writeFileSync(process.env.FAKE_DOPPLER_STORE, JSON.stringify(store));
} else fail("unsupported command");
`;

/** A temp directory holding the stand-in doppler, its secrets, a config file and helpers to run the CLI against them. */
function sandbox(secrets, configToml, { installDoppler = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-keys-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  if (installDoppler) {
    writeFileSync(path.join(bin, "doppler"), FAKE_DOPPLER);
    chmodSync(path.join(bin, "doppler"), 0o755);
  }
  const storePath = path.join(dir, "secrets.json");
  const logPath = path.join(dir, "doppler-argv.jsonl");
  const configPath = path.join(dir, "config.toml");
  writeFileSync(storePath, JSON.stringify(secrets));
  writeFileSync(configPath, configToml);

  const run = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/cli.js", "keys", ...args, "-c", configPath], {
        env: { PATH: bin, HOME: dir, FAKE_DOPPLER_STORE: storePath, FAKE_DOPPLER_LOG: logPath },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  return {
    dir,
    run,
    store: () => JSON.parse(readFileSync(storePath, "utf8")),
    argv: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
  };
}

function firecrawlToml(baseUrl, extra = "") {
  return `[keys.firecrawl]
slot = "FIRECRAWL_API_KEY"
pool = ["FIRECRAWL_API_KEY_1", "FIRECRAWL_API_KEY_2", "FIRECRAWL_API_KEY_3", "FIRECRAWL_API_KEY_4"]
project = "example-project"
config = "prd"
floor = 100
base_url = "${baseUrl}/firecrawl"
${extra}`;
}

function firecrawlSecrets(slotTarget) {
  const { FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2, FIRECRAWL_API_KEY_3, FIRECRAWL_API_KEY_4 } = KEYS;
  return { FIRECRAWL_API_KEY: `\${${slotTarget}}`, FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2, FIRECRAWL_API_KEY_3, FIRECRAWL_API_KEY_4 };
}

/** No key value in anything the command printed or in any argument doppler was started with; every doppler call scoped. */
function assertNoLeak(box, ...outputs) {
  const argv = box.argv();
  assert.ok(argv.length > 0, "the stand-in doppler was never called");
  for (const value of KEY_VALUES) {
    for (const output of outputs) assert.ok(!output.includes(value), "a key value reached command output");
    assert.ok(!JSON.stringify(argv).includes(value), "a key value reached doppler's argv");
  }
  for (const call of argv) {
    assert.equal(call[call.indexOf("-p") + 1], "example-project");
    assert.equal(call[call.indexOf("-c") + 1], "prd");
  }
}

/** An in-memory SecretStore for in-process tests; `writes` records every set. */
function memoryStore(secrets, { ignoreWrites = false } = {}) {
  const writes = [];
  const reads = [];
  const resolve = (text) => text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name) => (name in secrets ? resolve(secrets[name]) : whole));
  const need = (name) => {
    if (!(name in secrets)) throw new Error(`Could not read ${name}: not found`);
    return secrets[name];
  };
  const store = () => ({
    get: async (name) => {
      reads.push(name);
      return resolve(need(name));
    },
    getRaw: async (name) => need(name),
    set: async (name, value) => {
      writes.push({ name, value });
      if (!ignoreWrites) secrets[name] = value;
    },
  });
  return { store, writes, reads, secrets };
}

function status(policy, floor, accounts, pointsAt = null) {
  return {
    provider: "firecrawl",
    policy,
    floor,
    points_at: pointsAt,
    accounts: accounts.map(([keys, remaining, period_end = null]) => ({
      keys: [].concat(keys),
      remaining,
      period_end,
      spent: remaining === null ? null : remaining <= floor,
      unknown: remaining === null ? "usage endpoint returned HTTP 500" : null,
    })),
  };
}

test("[keys] config errors name the field, and defaults are soonest-reset with a floor of 0", () => {
  const good = { slot: "EXA_API_KEY", pool: ["EXA_API_KEY_1"], project: "example-project", config: "prd" };
  const bad = (block, pattern) => assert.throws(() => resolveKeysConfig({ exa: { ...good, ...block } }), pattern);

  assert.throws(() => resolveKeysConfig(undefined), /\[keys\] section missing/);
  assert.throws(() => resolveKeysConfig({ ledger: "/tmp/l.jsonl" }), /\[keys\] no providers configured/);
  assert.throws(() => resolveKeysConfig({ brave: good }), /\[keys\] "brave" is not a supported provider; supported: firecrawl, tavily, serper, exa, parallel/);
  assert.throws(() => resolveKeysConfig({ exa: good, ledger: 5 }), /\[keys\] ledger must be the path/);
  bad({ slot: "exa key" }, /\[keys\] exa\.slot must be a secret name/);
  bad({ slot: undefined }, /\[keys\] exa\.slot/);
  bad({ pool: [] }, /\[keys\] exa\.pool must be a list of at least one/);
  bad({ pool: ["EXA_API_KEY_1", "--raw"] }, /\[keys\] exa\.pool\[1\] must be a secret name/);
  bad({ pool: ["EXA_API_KEY_1", "EXA_API_KEY_1"] }, /\[keys\] exa\.pool lists the same secret name twice/);
  bad({ pool: ["EXA_API_KEY"] }, /\[keys\] exa\.pool must not contain the slot/);
  bad({ project: undefined }, /\[keys\] exa\.project must be the name of the Doppler project/);
  bad({ config: "-c" }, /\[keys\] exa\.config must be the name of the Doppler config/);
  bad({ policy: "random" }, /\[keys\] exa\.policy must be "soonest-reset" or "in-order"/);
  bad({ floor: -1 }, /\[keys\] exa\.floor must be a number, zero or more/);
  bad({ floor: "50" }, /\[keys\] exa\.floor/);
  bad({ base_url: "not a url" }, /\[keys\] exa\.base_url is not a valid URL/);

  const resolved = resolveKeysConfig({ exa: good });
  assert.equal(resolved.providers[0].policy, "soonest-reset");
  assert.equal(resolved.providers[0].floor, 0);
  assert.equal(resolved.ledgerPath, undefined);
});

test("each reader turns its provider's usage response into remaining, limit and period end, sending the key in a header only", async () => {
  const server = await usageServer();
  try {
    assert.deepEqual(await readAllowance("firecrawl", KEYS.FIRECRAWL_API_KEY_3, `${server.url}/firecrawl`), {
      remaining: 940,
      limit: 1000,
      unit: "credits",
      period_end: "2026-12-18T10:01:07.456Z",
      account: "2026-11-18T10:01:07.456Z|2026-12-18T10:01:07.456Z|1000",
    });
    // Tavily reports usage and limit; what is left is the difference.
    assert.deepEqual(await readAllowance("tavily", KEYS.TAVILY_API_KEY_1, `${server.url}/tavily`), { remaining: 280, limit: 1000, unit: "credits" });
    assert.deepEqual(await readAllowance("serper", KEYS.SERPER_API_KEY_1, `${server.url}/serper/`), { remaining: 2420, limit: null, unit: "credits" });

    for (const request of server.requests) {
      for (const value of KEY_VALUES) assert.ok(!request.url.includes(value));
    }
    assert.equal(server.requests[2].headers["x-api-key"], KEYS.SERPER_API_KEY_1);
    assert.equal(server.requests[2].headers.authorization, undefined);

    // exa and parallel have no endpoint: no request is made at all.
    const before = server.requests.length;
    assert.match((await readAllowance("exa", KEYS.EXA_API_KEY_1, server.url)).unknown, /exa has no balance endpoint/);
    assert.match((await readAllowance("parallel", "any-key-value", server.url)).unknown, /parallel has no balance endpoint/);
    assert.equal(server.requests.length, before);
  } finally {
    await server.close();
  }
});

test("a reader that cannot read says why without quoting the key or the response body", async () => {
  const server = await usageServer();
  const reasons = [];
  try {
    // The stand-in echoes the rejected key in its 401 body, as a careless vendor might.
    reasons.push(await readAllowance("firecrawl", "test-key-rejected-9999", `${server.url}/firecrawl`));
    assert.match(reasons.at(-1).unknown, /key rejected by the usage endpoint \(HTTP 401\)/);
    reasons.push(await readAllowance("tavily", KEYS.TAVILY_API_KEY_2, `${server.url}/tavily`));
    assert.match(reasons.at(-1).unknown, /no account\.plan_limit/);
    reasons.push(await readAllowance("firecrawl", KEYS.FIRECRAWL_API_KEY_1, `${server.url}/broken`));
    assert.match(reasons.at(-1).unknown, /did not return JSON/);
    reasons.push(await readAllowance("serper", KEYS.SERPER_API_KEY_1, `${server.url}/nowhere`));
    assert.match(reasons.at(-1).unknown, /returned HTTP 404/);
  } finally {
    await server.close();
  }
  // Nothing is listening on the closed server's port any more.
  reasons.push(await readAllowance("firecrawl", KEYS.FIRECRAWL_API_KEY_1, `${server.url}/firecrawl`));
  assert.match(reasons.at(-1).unknown, /usage endpoint unreachable/);
  for (const reason of reasons) {
    assert.ok(!reason.unknown.includes("test-key-"), reason.unknown);
  }
});

test("only a single same-config reference counts as pointing at a secret", () => {
  assert.equal(referencedSecret("${FIRECRAWL_API_KEY_3}"), "FIRECRAWL_API_KEY_3");
  assert.equal(referencedSecret("${FIRECRAWL_API_KEY_3}\n"), "FIRECRAWL_API_KEY_3");
  assert.equal(referencedSecret("${prd.FIRECRAWL_API_KEY_3}"), undefined);
  assert.equal(referencedSecret("prefix-${FIRECRAWL_API_KEY_3}"), undefined);
  assert.equal(referencedSecret(KEYS.FIRECRAWL_API_KEY_3), undefined);
});

test("keys status: two keys of one team are one account, the slot's target is marked, and no key value is printed", async () => {
  const server = await usageServer();
  const box = sandbox(firecrawlSecrets("FIRECRAWL_API_KEY_2"), firecrawlToml(server.url));
  try {
    const json = await box.run(["status", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const [provider, ...rest] = JSON.parse(json.stdout).providers;
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { provider: provider.provider, slot: provider.slot, slot_state: provider.slot_state, points_at: provider.points_at, policy: provider.policy, floor: provider.floor },
      { provider: "firecrawl", slot: "FIRECRAWL_API_KEY", slot_state: "pool-reference", points_at: "FIRECRAWL_API_KEY_2", policy: "soonest-reset", floor: 100 }
    );
    assert.deepEqual(provider.accounts, [
      { keys: ["FIRECRAWL_API_KEY_1", "FIRECRAWL_API_KEY_2"], in_slot: true, remaining: 1200, limit: 1500, unit: "credits", period_end: "2026-12-10T08:15:42.123Z", spent: false, unknown: null, ledger_usd: null, ledger_calls: null },
      { keys: ["FIRECRAWL_API_KEY_3"], in_slot: false, remaining: 940, limit: 1000, unit: "credits", period_end: "2026-12-18T10:01:07.456Z", spent: false, unknown: null, ledger_usd: null, ledger_calls: null },
      { keys: ["FIRECRAWL_API_KEY_4"], in_slot: false, remaining: 60, limit: 1000, unit: "credits", period_end: "2026-12-05T19:30:00.789Z", spent: true, unknown: null, ledger_usd: null, ledger_calls: null },
    ]);

    const table = await box.run(["status", "--provider", "firecrawl"]);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /firecrawl: FIRECRAWL_API_KEY -> FIRECRAWL_API_KEY_2 {3}policy soonest-reset, floor 100/);
    assert.match(table.stdout, /\* +FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2 +1200 +1500 +2026-12-10 +one account/);
    assert.match(table.stdout, /\n {5}FIRECRAWL_API_KEY_4 +60 +1000 +2026-12-05 +at or below the floor/);

    const missing = await box.run(["status", "--provider", "tavily"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^Error \(config\): \[keys\] no \[keys\.tavily\] block in the config; configured: firecrawl/);

    // Status only reads: the slot raw, each pool key resolved, and nothing written.
    assert.ok(box.argv().some((call) => call.includes("--raw") && call[2] === "FIRECRAWL_API_KEY"));
    assert.ok(!box.argv().some((call) => call[1] === "set"));
    assertNoLeak(box, json.stdout, json.stderr, table.stdout, table.stderr, missing.stderr);
  } finally {
    await server.close();
  }
});

test("keys status reports what it could not read in place: a rejected key, a missing secret, a slot holding its own value", async () => {
  const server = await usageServer();
  const secrets = firecrawlSecrets("FIRECRAWL_API_KEY_1");
  secrets.FIRECRAWL_API_KEY = "test-key-pasted-into-slot-7777";
  secrets.FIRECRAWL_API_KEY_3 = "test-key-revoked-8888";
  delete secrets.FIRECRAWL_API_KEY_4;
  const box = sandbox(secrets, firecrawlToml(server.url));
  try {
    const result = await box.run(["status", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const provider = JSON.parse(result.stdout).providers[0];
    assert.equal(provider.slot_state, "own-value");
    assert.equal(provider.points_at, null);
    assert.match(provider.slot_note, /holds its own value/);
    assert.match(provider.accounts[1].unknown, /key rejected by the usage endpoint \(HTTP 401\)/);
    assert.match(provider.accounts[2].unknown, /Could not read FIRECRAWL_API_KEY_4 in Doppler example-project\/prd: Doppler Error: Could not find requested secret/);
    assert.equal(provider.accounts[2].remaining, null);
    assert.ok(!result.stdout.includes("test-key-"), "a key value reached command output");
  } finally {
    await server.close();
  }
});

test("without a doppler executable, status says so per secret and rotate leaves the slot alone", async () => {
  // PATH for the child is an empty directory, which also shows these tests cannot reach a real doppler.
  const box = sandbox(firecrawlSecrets("FIRECRAWL_API_KEY_1"), firecrawlToml("http://127.0.0.1:9"), { installDoppler: false });
  const shown = await box.run(["status", "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const provider = JSON.parse(shown.stdout).providers[0];
  assert.equal(provider.slot_state, "unreadable");
  assert.match(provider.slot_note, /Could not read FIRECRAWL_API_KEY in Doppler example-project\/prd: Doppler CLI not found on PATH/);
  assert.equal(provider.accounts.length, 4);
  for (const account of provider.accounts) assert.match(account.unknown, /Doppler CLI not found on PATH/);

  const rotated = await box.run(["rotate", "firecrawl", "--to", "FIRECRAWL_API_KEY_2"]);
  assert.equal(rotated.code, 1);
  assert.match(rotated.stderr, /nothing changed: the slot could not be read, so it was left alone/);
  assert.equal(box.store().FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY_1}");
});

test("soonest-reset picks the account above the floor whose period ends first, then falls back to most remaining", () => {
  // The account ending soonest is below the floor, so the next soonest wins even with less left.
  const dated = status("soonest-reset", 100, [
    [["A1", "A2"], 1200, "2026-12-10T00:00:00Z"],
    ["B", 5000, "2026-12-18T00:00:00Z"],
    ["C", 60, "2026-12-05T00:00:00Z"],
  ]);
  assert.equal(chooseRotationTarget(dated).target, "A1");
  assert.match(chooseRotationTarget(dated).why, /soonest-reset: its period ends 2026-12-10, the soonest of 2 accounts above the floor of 100/);

  // Raising C above the floor makes it the soonest.
  dated.accounts[2].remaining = 101;
  dated.accounts[2].spent = false;
  assert.equal(chooseRotationTarget(dated).target, "C");

  // A slot already on a key of the chosen account stays on that key.
  dated.accounts[2].spent = true;
  assert.equal(chooseRotationTarget({ ...dated, points_at: "A2" }).target, "A2");

  // No period ends (Tavily, Serper): most remaining above the floor.
  const undated = status("soonest-reset", 100, [["A", 280], ["B", 661], ["C", 100]]);
  assert.equal(chooseRotationTarget(undated).target, "B");
  assert.match(chooseRotationTarget(undated).why, /no account reports a period end/);

  // An account that could not be read is never picked by this policy.
  const blind = status("soonest-reset", 0, [["A", null], ["B", 0]]);
  assert.equal(chooseRotationTarget(blind).target, null);
  assert.match(chooseRotationTarget(blind).why, /no firecrawl account is known to be above the floor of 0: 1 of 2 could not be read .* pass --to/);
});

test("in-order picks the first pool account above the floor and counts an unknown allowance as above", () => {
  const order = status("in-order", 100, [["A", 100], ["B", 101], ["C", 9000]]);
  assert.equal(chooseRotationTarget(order).target, "B");
  assert.match(chooseRotationTarget(order).why, /in-order: first pool account above the floor of 100 \(101 left; 1 earlier in the pool at or below the floor\)/);

  const unknownFirst = status("in-order", 100, [["A", 50], ["B", null], ["C", 9000]]);
  assert.equal(chooseRotationTarget(unknownFirst).target, "B");
  assert.match(chooseRotationTarget(unknownFirst).why, /allowance unknown, which counts as above the floor/);

  // The default floor of 0: an account with exactly nothing left is spent.
  assert.equal(chooseRotationTarget(status("in-order", 0, [["A", 0], ["B", 1]])).target, "B");

  const spent = status("in-order", 100, [["A", 100], ["B", 0]]);
  assert.equal(chooseRotationTarget(spent).target, null);
  assert.match(chooseRotationTarget(spent).why, /every firecrawl account is at or below the floor of 100/);
});

test("keys rotate rewrites the slot as a reference, sends it on stdin, and prints was, now and why", async () => {
  const server = await usageServer();
  // The slot sits on the nearly spent account; the soonest-ending account above the floor is keys 1 and 2.
  const box = sandbox(firecrawlSecrets("FIRECRAWL_API_KEY_4"), firecrawlToml(server.url));
  try {
    const dry = await box.run(["rotate", "firecrawl", "--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /was: FIRECRAWL_API_KEY_4\n {2}would be: FIRECRAWL_API_KEY_1\n {2}why: soonest-reset: its period ends 2026-12-10/);
    assert.match(dry.stdout, /dry run: nothing changed/);
    assert.equal(box.store().FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY_4}");
    assert.ok(!box.argv().some((call) => call[1] === "set"), "--dry-run must not write");

    const real = await box.run(["rotate", "firecrawl"]);
    assert.equal(real.code, 0, real.stderr);
    assert.match(real.stdout, /firecrawl: FIRECRAWL_API_KEY\n {2}was: FIRECRAWL_API_KEY_4\n {2}now: FIRECRAWL_API_KEY_1\n {2}why: soonest-reset/);
    assert.equal(box.store().FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY_1}");
    assert.equal(box.store().FIRECRAWL_API_KEY_1, KEYS.FIRECRAWL_API_KEY_1, "pool secrets are never rewritten");

    const sets = box.argv().filter((call) => call[1] === "set");
    assert.deepEqual(sets, [["secrets", "set", "FIRECRAWL_API_KEY", "--silent", "--no-interactive", "-p", "example-project", "-c", "prd"]]);

    // Running it again finds the slot where the policy wants it.
    const again = await box.run(["rotate", "firecrawl"]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /unchanged: FIRECRAWL_API_KEY already points at FIRECRAWL_API_KEY_1/);
    assert.equal(box.argv().filter((call) => call[1] === "set").length, 1);

    assertNoLeak(box, dry.stdout, dry.stderr, real.stdout, real.stderr, again.stdout, again.stderr);
  } finally {
    await server.close();
  }
});

test("keys rotate --to accepts only a pool member and overrides the policy and the floor", async () => {
  const server = await usageServer();
  const box = sandbox({ ...firecrawlSecrets("FIRECRAWL_API_KEY_1"), FIRECRAWL_API_KEY_9: "test-key-not-in-pool-9" }, firecrawlToml(server.url));
  try {
    const outsider = await box.run(["rotate", "firecrawl", "--to", "FIRECRAWL_API_KEY_9"]);
    assert.equal(outsider.code, 1);
    assert.match(outsider.stderr, /^Error \(validation\): --to must name a secret in \[keys\.firecrawl\] pool: FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2, FIRECRAWL_API_KEY_3, FIRECRAWL_API_KEY_4/);
    assert.equal(box.argv().length, 0, "a bad --to is refused before doppler is called");

    // Key 4 is below the floor; --to is the operator's explicit choice.
    const chosen = await box.run(["rotate", "firecrawl", "--to", "FIRECRAWL_API_KEY_4"]);
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.match(chosen.stdout, /was: FIRECRAWL_API_KEY_1\n {2}now: FIRECRAWL_API_KEY_4\n {2}why: chosen with --to/);
    assert.equal(box.store().FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY_4}");
    assert.equal(server.requests.length, 0, "--to needs no allowance reading");

    const same = await box.run(["rotate", "firecrawl", "--to", "FIRECRAWL_API_KEY_4"]);
    assert.equal(same.code, 0, same.stderr);
    assert.match(same.stdout, /unchanged: FIRECRAWL_API_KEY already points at FIRECRAWL_API_KEY_4 \(chosen with --to\)/);
    assert.equal(box.argv().filter((call) => call[1] === "set").length, 1);

    const unknownProvider = await box.run(["rotate", "tavily"]);
    assert.equal(unknownProvider.code, 1);
    assert.match(unknownProvider.stderr, /no \[keys\.tavily\] block/);
    assertNoLeak(box, outsider.stderr, chosen.stdout, chosen.stderr, same.stdout, unknownProvider.stderr);
  } finally {
    await server.close();
  }
});

test("keys rotate changes nothing and exits non-zero when every account is at or below the floor", async () => {
  const drained = Object.fromEntries(Object.entries(FIRECRAWL).map(([key, body]) => [key, { ...body, remainingCredits: 100 }]));
  const server = await usageServer(drained);
  const box = sandbox(firecrawlSecrets("FIRECRAWL_API_KEY_3"), firecrawlToml(server.url));
  try {
    const result = await box.run(["rotate", "firecrawl"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /was: FIRECRAWL_API_KEY_3\n {2}nothing changed: every firecrawl account is at or below the floor of 100/);
    assert.equal(box.store().FIRECRAWL_API_KEY, "${FIRECRAWL_API_KEY_3}");
    assert.ok(!box.argv().some((call) => call[1] === "set"));
    assertNoLeak(box, result.stderr);
  } finally {
    await server.close();
  }
});

test("exa has no balance endpoint: pool keys are not read, spend comes from the gateway ledger, and in-order rotates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-keys-ledger-"));
  const ledger = path.join(dir, "ledger.jsonl");
  const line = (upstream, key, usd) =>
    JSON.stringify({ ts: "2026-11-20T10:00:00.000Z", session: "s", upstream, tool: "search", key, attempt: 1, ok: true, duration_ms: 5, ...(usd === undefined ? {} : { cost: { usd } }) });
  writeFileSync(
    ledger,
    [
      line("exa", "doppler:EXA_API_KEY_1", 0.005),
      line("examcp", "doppler:EXA_API_KEY_1", 0.02),
      line("exa", "doppler:EXA_API_KEY_2", 0.5),
      line("exa", "doppler:EXA_API_KEY", 0.25),
      line("exa", "doppler:EXA_API_KEY", undefined),
      line("tavily", "doppler:TAVILY_API_KEY", 9),
      "not json",
    ].join("\n") + "\n"
  );
  const box = sandbox(
    { EXA_API_KEY: "${EXA_API_KEY_2}", EXA_API_KEY_1: KEYS.EXA_API_KEY_1, EXA_API_KEY_2: KEYS.EXA_API_KEY_2 },
    `[keys]
ledger = "${ledger}"

[keys.exa]
slot = "EXA_API_KEY"
pool = ["EXA_API_KEY_1", "EXA_API_KEY_2"]
project = "example-project"
config = "prd"
policy = "in-order"
`
  );

  const json = await box.run(["status", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const provider = JSON.parse(json.stdout).providers[0];
  assert.equal(provider.points_at, "EXA_API_KEY_2");
  assert.deepEqual(
    provider.accounts.map((account) => [account.keys, account.in_slot, account.remaining, account.unknown, Number(account.ledger_usd.toFixed(3)), account.ledger_calls]),
    [
      [["EXA_API_KEY_1"], false, null, "exa has no balance endpoint for an ordinary key", 0.025, 2],
      [["EXA_API_KEY_2"], true, null, "exa has no balance endpoint for an ordinary key", 0.5, 1],
    ]
  );
  assert.deepEqual([provider.slot_ledger_usd, provider.slot_ledger_calls], [0.25, 2]);
  assert.deepEqual(box.argv().map((call) => call[2]), ["EXA_API_KEY"], "only the slot is read; pool keys are not resolved");

  const table = await box.run(["status"]);
  assert.match(table.stdout, /ledger: \$0\.25 over 2 calls made with EXA_API_KEY itself/);
  assert.match(table.stdout, /\* +EXA_API_KEY_2 +\? +- +- +exa has no balance endpoint for an ordinary key; ledger: \$0\.50 over 1 call$/m);

  // Unknown counts as above the floor, so in-order goes to the first pool key.
  const rotated = await box.run(["rotate", "exa"]);
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.match(rotated.stdout, /was: EXA_API_KEY_2\n {2}now: EXA_API_KEY_1\n {2}why: in-order: first pool account above the floor of 0 \(allowance unknown/);
  assert.equal(box.store().EXA_API_KEY, "${EXA_API_KEY_1}");
  assertNoLeak(box, json.stdout, table.stdout, rotated.stdout, rotated.stderr);
});

test("a slot holding its own value is overwritten only when a pool secret holds the same key", async () => {
  const config = resolveKeysConfig({
    exa: { slot: "EXA_API_KEY", pool: ["EXA_API_KEY_1", "EXA_API_KEY_2"], project: "example-project", config: "prd", policy: "in-order" },
  }).providers[0];

  // The slot's key exists nowhere else: a reference written over it would lose it.
  const orphan = memoryStore({ EXA_API_KEY: "test-key-only-copy-5555", EXA_API_KEY_1: KEYS.EXA_API_KEY_1, EXA_API_KEY_2: KEYS.EXA_API_KEY_2 });
  const refused = await rotateSlot(config, undefined, { to: "EXA_API_KEY_1" }, orphan);
  assert.equal(refused.outcome, "refused");
  assert.match(refused.why, /EXA_API_KEY holds its own value and no pool secret holds the same one/);
  assert.equal(orphan.writes.length, 0);
  assert.ok(refused.secrets.includes("test-key-only-copy-5555"), "the slot's own value is handed back for redaction");

  // The slot's key is also EXA_API_KEY_2, so nothing is lost by pointing the slot elsewhere.
  const twin = memoryStore({ EXA_API_KEY: KEYS.EXA_API_KEY_2, EXA_API_KEY_1: KEYS.EXA_API_KEY_1, EXA_API_KEY_2: KEYS.EXA_API_KEY_2 });
  const moved = await rotateSlot(config, undefined, {}, twin);
  assert.equal(moved.outcome, "rotated");
  assert.equal(moved.was, "its own value, the same as EXA_API_KEY_2");
  assert.deepEqual(twin.writes, [{ name: "EXA_API_KEY", value: "${EXA_API_KEY_1}" }]);

  // A slot that cannot be read is left alone, whatever the policy says.
  const absent = memoryStore({ EXA_API_KEY_1: KEYS.EXA_API_KEY_1, EXA_API_KEY_2: KEYS.EXA_API_KEY_2 });
  const untouched = await rotateSlot(config, undefined, {}, absent);
  assert.equal(untouched.outcome, "refused");
  assert.match(untouched.why, /the slot could not be read, so it was left alone/);
  assert.equal(absent.writes.length, 0);
});

test("a write that does not read back as the reference, or a target that does not exist, is an error", async () => {
  const config = resolveKeysConfig({
    exa: { slot: "EXA_API_KEY", pool: ["EXA_API_KEY_1", "EXA_API_KEY_2"], project: "example-project", config: "prd", policy: "in-order" },
  }).providers[0];

  const stuck = memoryStore({ EXA_API_KEY: "${EXA_API_KEY_2}", EXA_API_KEY_1: KEYS.EXA_API_KEY_1, EXA_API_KEY_2: KEYS.EXA_API_KEY_2 }, { ignoreWrites: true });
  await assert.rejects(
    rotateSlot(config, undefined, {}, stuck),
    /EXA_API_KEY was written but does not read back as a reference to EXA_API_KEY_1; check it in Doppler example-project\/prd now/
  );

  // Pointing a slot at a secret that is not there would hand consumers the literal reference text.
  const dangling = memoryStore({ EXA_API_KEY: "${EXA_API_KEY_2}", EXA_API_KEY_2: KEYS.EXA_API_KEY_2 });
  await assert.rejects(rotateSlot(config, undefined, {}, dangling), /Could not read EXA_API_KEY_1/);
  assert.equal(dangling.writes.length, 0);
});

test("collectKeyStatus hands back every key value it read so callers can redact", async () => {
  const server = await usageServer();
  try {
    const config = resolveKeysConfig({
      serper: { slot: "SERPER_API_KEY", pool: ["SERPER_API_KEY_1"], project: "example-project", config: "prd", base_url: `${server.url}/serper` },
    });
    const memory = memoryStore({ SERPER_API_KEY: "${SERPER_API_KEY_1}", SERPER_API_KEY_1: KEYS.SERPER_API_KEY_1 });
    const { report, secrets } = await collectKeyStatus(config, undefined, memory);
    assert.equal(report.providers[0].accounts[0].remaining, 2420);
    assert.deepEqual(secrets, [KEYS.SERPER_API_KEY_1]);
    assert.ok(!JSON.stringify(report).includes(KEYS.SERPER_API_KEY_1));
  } finally {
    await server.close();
  }
});

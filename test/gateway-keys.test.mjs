import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GatewayCore, KeyPoolManager, resolveGatewayConfig } from "../dist/index.js";

// Made-up values. Nothing here is, or resembles, a real credential.
const SECRETS = { "env:KEY_A": "made-up-value-aaaaaa", "env:KEY_B": "made-up-value-bbbbbb" };
const resolveKey = async (ref) => SECRETS[ref];
const ctx = { session: "s1", client: "test/1.0" };

function gateway(call, keys = ["env:KEY_A", "env:KEY_B"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "cs-gw-keys-"));
  const config = resolveGatewayConfig({
    ledger: path.join(dir, "ledger.jsonl"),
    state: path.join(dir, "state.json"),
    skills_dir: path.join(dir, "skills"),
    upstreams: { fake: { url: "https://mcp.example.com/mcp", keys } },
  });
  const connector = async (_upstream, keyValue) => ({
    listTools: async () => ({ tools: [] }),
    callTool: async ({ name, arguments: args }) => call(keyValue, name, args),
    close: async () => undefined,
  });
  return { dir, core: new GatewayCore(config, { connector, resolveKey }) };
}

function readLedger(dir) {
  return readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

/** Every file under `dir`, as one string, to search for a value that must not be there. */
function everythingWritten(dir) {
  const parts = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) parts.push(readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
  }
  return parts.join("\n");
}

function holdsAKey(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Object.values(SECRETS).some((secret) => text.includes(secret));
}

const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

test("a key value the provider echoes back is replaced before the result reaches the agent", async () => {
  const { dir, core } = gateway(async (keyValue, name) => {
    if (name === "echo_error") return fail(`HTTP 400: {"message":"bad request for credential ${keyValue}"}`);
    if (name === "echo_ok") {
      return {
        content: [{ type: "text", text: JSON.stringify({ next: `https://api.example.com/page?token=${keyValue}&page=2` }) }],
        structuredContent: { request: { token: keyValue, [`sent-${keyValue}`]: true }, results: [{ title: "kept as sent" }] },
      };
    }
    if (name === "echo_no_credit") return fail(`HTTP 402: no credit left for ${keyValue}`);
    throw new Error(`connect failed for https://mcp.example.com/mcp?token=${keyValue}`);
  });

  const error = await core.callTool("fake__echo_error", {}, ctx);
  assert.equal(error.isError, true);
  assert.equal(error.content[0].text, 'HTTP 400: {"message":"bad request for credential [redacted]"}');

  const success = await core.callTool("fake__echo_ok", {}, ctx);
  assert.equal(success.isError, undefined);
  assert.equal(success.content[0].text, JSON.stringify({ next: "https://api.example.com/page?token=[redacted]&page=2" }));
  assert.deepEqual(success.structuredContent, {
    request: { token: "[redacted]", "sent-[redacted]": true },
    results: [{ title: "kept as sent" }],
  });

  // Both keys are tried here, so the final message quotes the second key's error.
  const exhausted = await core.callTool("fake__echo_no_credit", {}, ctx);
  assert.match(exhausted.content[0].text, /all 2 configured keys failed/);
  assert.match(exhausted.content[0].text, /no credit left for \[redacted\]/);

  const thrown = await core.callTool("fake__throws", {}, ctx);
  assert.match(thrown.content[0].text, /token=\[redacted\]/);

  for (const result of [error, success, exhausted, thrown]) {
    assert.equal(holdsAKey(result), false, "no key value may reach the agent");
  }
  assert.equal(holdsAKey(everythingWritten(dir)), false, "no key value may reach the ledger, payload or state files");
});

test("a key written into the gateway config as a value is refused, without repeating it", () => {
  const literal = "made-up-literal-value-000000";
  const upstream = (keys) => ({ upstreams: { fake: { url: "https://mcp.example.com/mcp", keys } } });

  for (const keys of [[literal], ["env:KEY_A", literal], ["env:"], ["doppler: "], ["bws:OLD_NAME"]]) {
    assert.throws(
      () => resolveGatewayConfig(upstream(keys)),
      (error) => {
        assert.match(error.message, /\[gateway\] upstreams\.fake\.keys\[\d\] must be a key reference/);
        assert.match(error.message, /doppler:NAME or env:NAME/);
        assert.equal(error.message.includes(literal), false, "the refused value must not be repeated in the error");
        return true;
      }
    );
  }
  assert.match(
    (() => {
      try {
        resolveGatewayConfig(upstream(["env:KEY_A", literal]));
      } catch (error) {
        return error.message;
      }
      return "";
    })(),
    /keys\[1\]/
  );

  const accepted = resolveGatewayConfig(upstream(["env:KEY_A", "doppler:SOME_NAME"])).upstreams[0].keys;
  assert.deepEqual(accepted, ["env:KEY_A", "doppler:SOME_NAME"]);
});

test("the saved list of skipped keys names references, and each key keeps its own ledger label", async () => {
  const { dir, core } = gateway(async (keyValue) =>
    keyValue === SECRETS["env:KEY_A"] ? fail("HTTP 402: Payment Required") : { content: [{ type: "text", text: "{}" }] }
  );
  await core.callTool("fake__search", {}, ctx);

  const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.keys), ["fake|env:KEY_A"]);
  assert.equal(state.keys["fake|env:KEY_A"].reason, "quota");
  assert.deepEqual(readLedger(dir).map((entry) => entry.key), ["env:KEY_A", "env:KEY_B"]);
  assert.equal(holdsAKey(everythingWritten(dir)), false);
});

test("a rate-limited call goes back to the agent as the provider reported it, and its key is not skipped", async () => {
  let calls = 0;
  const limited = 'HTTP 429: {"error":"Too many requests","retry_after":20}';
  const { dir, core } = gateway(async () => {
    calls += 1;
    return fail(limited);
  });

  const result = await core.callTool("fake__search", { query: "x" }, ctx);
  assert.equal(calls, 1, "a rate limit must not be retried on the next key");
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, limited);

  const entries = readLedger(dir);
  assert.deepEqual(entries.map((entry) => [entry.key, entry.attempt, entry.error_class]), [["env:KEY_A", 1, "upstream"]]);
  assert.deepEqual(core.status().upstreams[0].keys.map((key) => key.state), ["active", "standby"]);
  assert.equal(existsSync(path.join(dir, "state.json")), false, "nothing is skipped, so no state is saved");
});

test("a legacy key pool advances inside one process, starts again in a new one, and can pick at random", async () => {
  // The values are pool positions, not credentials.
  const keys = ["first", "second"];

  const pool = new KeyPoolManager();
  pool.register("legacy", { keys });
  assert.deepEqual([await pool.getNextKey("legacy"), await pool.getNextKey("legacy"), await pool.getNextKey("legacy")], [
    "first",
    "second",
    "first",
  ]);

  // A one-shot command is a new process, which is a new pool: round-robin begins at the first key again.
  const nextProcess = new KeyPoolManager();
  nextProcess.register("legacy", { keys });
  assert.equal(await nextProcess.getNextKey("legacy"), "first");

  // `strategy = "random"` can use any key on the first call of a process.
  const random = new KeyPoolManager();
  random.register("legacy", { keys, strategy: "random" });
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try {
    assert.equal(await random.getNextKey("legacy"), "second");
  } finally {
    Math.random = originalRandom;
  }
});

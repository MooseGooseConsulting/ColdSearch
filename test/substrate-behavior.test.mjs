import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeToolCall } from "../dist/tools/substrate.js";
import { getToolProfile, listToolProfiles } from "../dist/registry/tool-profiles.js";

// Provider base hosts the substrate dispatches to. Tests rewrite these to a
// local mock so no real network call is made.
const PROVIDER_HOSTS = [
  "https://api.exa.ai",
  "https://api.tavily.com",
  "https://api.firecrawl.dev",
  "https://api.search.brave.com",
  "https://google.serper.dev",
  "https://api.jina.ai",
  "https://r.jina.ai",
  "https://api.brightdata.com",
];

/**
 * Start a mock HTTP server, redirect every provider host to it for the duration
 * of `fn`, then ALWAYS restore `global.fetch` and close the server — even if an
 * assertion throws. Replaces the per-test ad-hoc monkey-patching that had no
 * restore guarantee.
 */
async function withMockedProviders(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  const originalFetch = global.fetch;
  global.fetch = (input, init) => {
    let u = input.toString();
    for (const host of PROVIDER_HOSTS) u = u.split(host).join(base);
    return originalFetch(u, init);
  };

  try {
    return await fn(base);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

function tmpUsagePath(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coldsearch-${tag}-`));
  return path.join(dir, "usage.jsonl");
}

/**
 * The highest-value test: prove the substrate can construct a dispatchable
 * request for EVERY wired profile, not just the two hand-picked in the original
 * suite. A mock answers 200 for any host; we only assert the call reaches HTTP
 * and returns ok (i.e. no preflight/key/transport failure).
 */
test("substrate builds a dispatchable request for every wired profile", async () => {
  const wired = listToolProfiles({ status: "wired" });
  assert.ok(wired.length >= 10, `expected many wired profiles, got ${wired.length}`);

  for (const k of [
    "EXA_API_KEY",
    "TAVILY_API_KEY",
    "FIRECRAWL_API_KEY",
    "BRAVE_API_KEY",
    "SERPER_API_KEY",
    "JINA_API_KEY",
    "BRIGHTDATA_API_KEY",
  ]) {
    process.env[k] = `test-${k}`;
  }

  await withMockedProviders(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (base) => {
      const config = {
        capabilities: {},
        providers: {
          exa: { keyPool: { keys: ["env:EXA_API_KEY"] } },
          tavily: { keyPool: { keys: ["env:TAVILY_API_KEY"] } },
          firecrawl: { keyPool: { keys: ["env:FIRECRAWL_API_KEY"] } },
          brave: { keyPool: { keys: ["env:BRAVE_API_KEY"] } },
          serper: { keyPool: { keys: ["env:SERPER_API_KEY"] } },
          jina: { keyPool: { keys: ["env:JINA_API_KEY"] } },
          searxng: { keyPool: { keys: [] }, options: { baseUrl: base } },
          brightdata: {
            keyPool: { keys: ["env:BRIGHTDATA_API_KEY"] },
            options: {
              serpZone: "brd-customer_abc123-zone-serp",
              unlockerZone: "brd-customer_abc123-zone-unlocker",
            },
          },
        },
        logging: { usage: { path: tmpUsagePath("matrix") } },
        history: { path: tmpUsagePath("matrix-history") },
        cache: { enabled: false },
      };

      for (const profile of wired) {
        const params = {};
        for (const p of profile.requiredParams) {
          params[p] = p.toLowerCase().includes("url") ? "https://example.com" : "test";
        }
        const result = await executeToolCall(profile.provider, profile.tool, params, config);
        assert.equal(
          result.ok,
          true,
          `wired profile ${profile.provider}.${profile.tool} did not dispatch: ` +
            `${result.error?.code} — ${result.error?.message}`
        );
      }
    }
  );
});

test("brightdata profiles install via the substrate import alone (no providers.ts)", () => {
  // This file imports ../dist/tools/substrate.js (which side-effect imports the
  // brightdata profile registry) and never ../dist/providers.js — so this proves
  // the dispatch path sees Bright Data tools as catalogued on its own.
  assert.ok(getToolProfile("brightdata.serp"), "brightdata.serp must be catalogued");
  assert.ok(getToolProfile("brightdata.unlocker"), "brightdata.unlocker must be catalogued");
  assert.ok(getToolProfile("brightdata.scrape"), "brightdata.scrape must be catalogued");
  assert.ok(getToolProfile("brightdata.discover"), "brightdata.discover must be catalogued");
});

test("firecrawl.scrape with read-only actions is forwarded, not hard-excluded", async () => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  let reached = false;

  await withMockedProviders(
    (req, res) => {
      reached = true;
      assert.equal(req.url, "/v2/scrape");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    },
    async () => {
      const config = {
        capabilities: {},
        providers: { firecrawl: { keyPool: { keys: ["env:FIRECRAWL_API_KEY"] } } },
        logging: { usage: { path: tmpUsagePath("scrape") } },
        history: { path: tmpUsagePath("scrape-history") },
        cache: { enabled: false },
      };
      const result = await executeToolCall(
        "firecrawl",
        "scrape",
        { url: "https://example.com", actions: [{ type: "screenshot" }] },
        config
      );
      assert.notEqual(result.error?.code, "HARD_EXCLUDED");
      assert.equal(result.ok, true, result.error?.message);
    }
  );

  assert.ok(reached, "scrape-with-actions should have reached the provider");
});

test("firecrawl.agent stays hard-excluded via the registry exclusion list", async () => {
  const config = {
    capabilities: {},
    providers: { firecrawl: { keyPool: { keys: ["env:FIRECRAWL_API_KEY"] } } },
    history: { path: tmpUsagePath("excluded-history") },
  };
  const result = await executeToolCall("firecrawl", "agent", {}, config);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HARD_EXCLUDED");
  assert.equal(result.raw, null);
});

test("a tool whose name merely contains 'agent' is not blanket-excluded", async () => {
  // Guards against the removed nameLooksLikeAgent substring heuristic, which
  // would have wrongly blocked e.g. a future exa.agentsearch tool.
  process.env.EXA_API_KEY = "test-key";

  await withMockedProviders(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
    async () => {
      const config = {
        capabilities: {},
        providers: { exa: { keyPool: { keys: ["env:EXA_API_KEY"] } } },
        logging: { usage: { path: tmpUsagePath("agentname") } },
        history: { path: tmpUsagePath("agentname-history") },
        cache: { enabled: false },
      };
      const result = await executeToolCall("exa", "agentsearch", { q: "hi" }, config);
      assert.notEqual(result.error?.code, "HARD_EXCLUDED");
      assert.equal(result.ok, true, result.error?.message);
      assert.deepEqual(result.meta.warnings, ["Tool 'exa.agentsearch' is uncatalogued."]);
    }
  );
});

test("jina embeddings sends Authorization when a key is configured", async () => {
  process.env.JINA_API_KEY = "jina-secret";
  let authHeader = null;

  await withMockedProviders(
    (req, res) => {
      authHeader = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    },
    async () => {
      const config = {
        capabilities: {},
        providers: { jina: { keyPool: { keys: ["env:JINA_API_KEY"] } } },
        logging: { usage: { path: tmpUsagePath("jina-emb") } },
        history: { path: tmpUsagePath("jina-emb-history") },
        cache: { enabled: false },
      };
      const result = await executeToolCall(
        "jina",
        "embeddings",
        { model: "jina-embeddings-v3", input: ["hi"] },
        config
      );
      assert.equal(result.ok, true, result.error?.message);
      assert.equal(authHeader, "Bearer jina-secret");
    }
  );
});

test("jina reader works without any key configured (keyless)", async () => {
  let authorization;
  await withMockedProviders(
    (req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("page text");
    },
    async () => {
      const config = {
        capabilities: {},
        providers: { jina: { keyPool: { keys: [] } } },
        logging: { usage: { path: tmpUsagePath("jina-reader") } },
        history: { path: tmpUsagePath("jina-reader-history") },
        cache: { enabled: false },
      };
      const result = await executeToolCall("jina", "reader", { url: "https://example.com" }, config);
      assert.equal(result.ok, true, result.error?.message);
      assert.equal(authorization, undefined);
    }
  );
});

test("jina reader falls back to keyless when its optional key reference is unset", async () => {
  const envName = "COLDSEARCH_MISSING_OPTIONAL_JINA_KEY";
  const previousKey = process.env[envName];
  delete process.env[envName];
  let authorization;

  try {
    await withMockedProviders(
      (req, res) => {
        authorization = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("page text");
      },
      async () => {
        const config = {
          capabilities: {},
          providers: { jina: { keyPool: { keys: [`env:${envName}`] } } },
          logging: { usage: { path: tmpUsagePath("jina-reader-missing-optional-key") } },
          history: { path: tmpUsagePath("jina-reader-missing-optional-key-history") },
          cache: { enabled: false },
        };
        const result = await executeToolCall(
          "jina",
          "reader",
          { url: "https://example.com" },
          config
        );
        assert.equal(result.ok, true, result.error?.message);
        assert.match(result.meta.warnings.join(" "), /continuing keyless/);
        assert.equal(authorization, undefined);
      }
    );
  } finally {
    if (previousKey === undefined) delete process.env[envName];
    else process.env[envName] = previousKey;
  }
});

test("SearXNG ignores unused key references", async () => {
  const envName = "COLDSEARCH_MISSING_UNUSED_SEARXNG_KEY";
  const previousKey = process.env[envName];
  delete process.env[envName];
  let authorization;

  try {
    await withMockedProviders(
      (req, res) => {
        authorization = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      },
      async (base) => {
        const config = {
          capabilities: {},
          providers: {
            searxng: {
              keyPool: { keys: [`env:${envName}`] },
              options: { baseUrl: base },
            },
          },
          logging: { usage: { path: tmpUsagePath("searxng-unused-key") } },
          history: { path: tmpUsagePath("searxng-unused-key-history") },
          cache: { enabled: false },
        };
        const result = await executeToolCall("searxng", "search", { q: "test" }, config);
        assert.equal(result.ok, true, result.error?.message);
        assert.equal(authorization, undefined);
      }
    );
  } finally {
    if (previousKey === undefined) delete process.env[envName];
    else process.env[envName] = previousKey;
  }
});

test("jina reader forwards a configured key and profile-listed headers", async () => {
  const previousKey = process.env.JINA_API_KEY;
  process.env.JINA_API_KEY = "jina-reader-secret";
  let request;

  try {
    await withMockedProviders(
      (req, res) => {
        request = { url: req.url, headers: req.headers };
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("page text");
      },
      async () => {
        const config = {
          capabilities: {},
          providers: { jina: { keyPool: { keys: ["env:JINA_API_KEY"] } } },
          logging: { usage: { path: tmpUsagePath("jina-reader-auth") } },
          history: { path: tmpUsagePath("jina-reader-auth-history") },
          cache: { enabled: false },
        };
        const result = await executeToolCall(
          "jina",
          "reader",
          {
            url: "example.com/path",
            "X-Engine": "browser",
            "X-Return-Format": "text",
            "X-Unlisted-Option": "must-not-be-forwarded",
          },
          config
        );

        assert.equal(result.ok, true, result.error?.message);
        assert.equal(request.url, "/https://example.com/path");
        assert.equal(request.headers.authorization, "Bearer jina-reader-secret");
        assert.equal(request.headers["x-engine"], "browser");
        assert.equal(request.headers["x-return-format"], "text");
        assert.equal(request.headers["x-unlisted-option"], undefined);
      }
    );
  } finally {
    if (previousKey === undefined) delete process.env.JINA_API_KEY;
    else process.env.JINA_API_KEY = previousKey;
  }
});

test("Brave Answers explicitly disables default streaming unless requested", async () => {
  const previousKey = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "brave-test-key";
  const requests = [];

  try {
    await withMockedProviders(
      (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          requests.push({ method: req.method, url: req.url, body, accept: req.headers.accept });
          if (body.stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end("data: {\"choices\":[]}\n\n");
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [] }));
          }
        });
      },
      async () => {
        const config = {
          capabilities: {},
          providers: { brave: { keyPool: { keys: ["env:BRAVE_API_KEY"] } } },
          logging: { usage: { path: tmpUsagePath("brave-answers") } },
          history: { path: tmpUsagePath("brave-answers-history") },
          cache: { enabled: false },
        };
        const messages = [{ role: "user", content: "What is new?" }];
        for (const params of [{ messages }, { messages, stream: true }, { messages, stream: false }]) {
          const result = await executeToolCall("brave", "answers", params, config);
          assert.equal(result.ok, true, result.error?.message);
        }
      }
    );
  } finally {
    if (previousKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = previousKey;
  }

  assert.deepEqual(requests.map((request) => request.body.stream), [false, true, false]);
  assert.deepEqual(requests.map((request) => request.method), ["POST", "POST", "POST"]);
  assert.ok(requests.every((request) => request.url === "/res/v1/chat/completions"));
  assert.deepEqual(requests.map((request) => request.accept), [
    "application/json",
    "text/event-stream",
    "application/json",
  ]);
});

test("untrusted provider error bodies stay out of the error message and log", async () => {
  // A provider may echo a secret back in its error body. We prove the body
  // never reaches the returned error string or the usage log — it lives only
  // in `raw`. A deliberately non-secret marker stands in for that body content
  // so the test itself can't trip secret scanners.
  const BODY_MARKER = "PROVIDER_BODY_CONTENT_should_never_reach_message_or_log";
  process.env.EXA_API_KEY = "test-key";
  const usageLogPath = tmpUsagePath("leak");

  await withMockedProviders(
    (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: BODY_MARKER }));
    },
    async () => {
      const config = {
        capabilities: {},
        providers: { exa: { keyPool: { keys: ["env:EXA_API_KEY"] } } },
        logging: { usage: { path: usageLogPath } },
        history: { path: tmpUsagePath("leak-history") },
        cache: { enabled: false },
      };
      const result = await executeToolCall("exa", "search", { query: "hi" }, config);

      assert.equal(result.ok, false);
      assert.ok(
        !result.error.message.includes(BODY_MARKER),
        "error.message leaked the untrusted provider body"
      );
      const log = fs.readFileSync(usageLogPath, "utf8");
      assert.ok(!log.includes(BODY_MARKER), "usage log leaked the untrusted provider body");
      // Body IS preserved for the caller in `raw` (G6) — the correct trust
      // boundary. Anything secret a provider echoes stays only here.
      assert.ok(JSON.stringify(result.raw).includes(BODY_MARKER));
    }
  );
});

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI `tool call` exits 1 with the right error code on preflight/parse failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-cli-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      "[capabilities.search]",
      'providers = ["firecrawl"]',
      "[providers.firecrawl]",
      "[providers.firecrawl.keyPool]",
      'keys = ["env:FIRECRAWL_API_KEY"]',
      "[logging.usage]",
      `path = "${path.join(dir, "usage.jsonl").replaceAll("\\", "/")}"`,
      "[history]",
      `path = "${path.join(dir, "history.jsonl").replaceAll("\\", "/")}"`,
    ].join("\n"),
    "utf8"
  );

  const cases = [
    { args: ["unknownxyz.search", "--json-input", "{}"], code: "UNKNOWN_PROVIDER" },
    { args: ["firecrawl.agent", "--json-input", "{}"], code: "HARD_EXCLUDED" },
    { args: ["notavalidid", "--json-input", "{}"], code: "INVALID_TOOL_ID" },
    { args: ["exa.search.extra", "--json-input", "{}"], code: "INVALID_TOOL_ID" },
    { args: ["exa.", "--json-input", "{}"], code: "INVALID_TOOL_ID" },
    { args: [".search", "--json-input", "{}"], code: "INVALID_TOOL_ID" },
    { args: ["exa.search", "--json-input", "{bad json"], code: "INVALID_JSON" },
  ];

  try {
    for (const c of cases) {
      const r = spawnSync(
        process.execPath,
        [CLI_PATH, "tool", "call", ...c.args, "--json", "--config", configPath],
        { encoding: "utf8" }
      );
      assert.equal(r.status, 1, `${c.code}: expected exit 1, got ${r.status}; stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.error?.code, c.code, `expected ${c.code}; stdout=${r.stdout}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

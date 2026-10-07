import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLLMClient, resolveLlmConfig } from "../dist/agent/llm.js";
import { SearchAgent } from "../dist/agent/agent.js";
import { loadConfig } from "../dist/config.js";

// Real HTTP transport to a local contract server; no fetch mocking or paid calls.
async function withServer(run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "Paris is the capital of France." } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/v1`, requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function withEnv(name, value, run) {
  const previous = process.env[name];
  process.env[name] = value;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("Isoquant default sends GLM 5.3 Flash medium and uses Doppler-injected credentials", async () => {
  await withEnv("ISOQUANT_API_KEY", "local-contract-key", async () => {
    await withServer(async (baseUrl, requests) => {
      const client = createLLMClient(undefined, undefined, baseUrl);
      const out = await client.complete([{ role: "user", content: "Hello" }]);
      assert.equal(requests[0].url, "/v1/chat/completions");
      assert.equal(requests[0].auth, "Bearer local-contract-key");
      assert.equal(requests[0].body.model, "glm-5.3-flash");
      assert.equal(requests[0].body.reasoning_effort, "medium");
      assert.equal(out.usage.totalTokens, 7);
    });
  });
});

test("renamed Doppler secret flows from TOML through endpoint resolution", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-isoquant-"));
  try {
    await withEnv("MY_ISOQUANT_KEY", "renamed-key", async () => {
      await withServer(async (baseUrl, requests) => {
        const file = path.join(dir, "config.toml");
        fs.writeFileSync(file, `[capabilities]\n[providers]\n[agent.llm]\nprovider = "isoquant"\nbase_url = "${baseUrl}"\nkey_ref = "doppler:MY_ISOQUANT_KEY"\nreasoning_effort = "medium"\n`);
        const resolved = resolveLlmConfig({ reasoningEffort: "low" }, loadConfig(file).agent.llm);
        const client = createLLMClient(resolved.provider, resolved.model, resolved.baseUrl, resolved);
        await client.complete([{ role: "user", content: "Hi" }]);
        assert.equal(requests[0].auth, "Bearer renamed-key");
        assert.equal(requests[0].body.reasoning_effort, "low");
      });
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("OpenRouter free is the default model and uses its own reasoning schema", async () => {
  await withEnv("OPENROUTER_API_KEY", "router-key", async () => {
    await withServer(async (baseUrl, requests) => {
      const client = createLLMClient("openrouter", undefined, baseUrl);
      await client.complete([{ role: "user", content: "Hi" }]);
      assert.equal(requests[0].body.model, "openrouter/free");
      assert.ok(!("reasoning" in requests[0].body));
      await client.complete([{ role: "user", content: "Hi" }], { reasoningEffort: "medium" });
      assert.deepEqual(requests[1].body.reasoning, { effort: "medium" });
      assert.ok(!("reasoning_effort" in requests[1].body));
    });
  });
});

test("agent carries medium through research and forced final synthesis", async () => {
  await withEnv("ISOQUANT_API_KEY", "local-contract-key", async () => {
    await withServer(async (baseUrl, requests) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-agent-contract-"));
      const configPath = path.join(dir, "config.toml");
      fs.writeFileSync(configPath, "[capabilities]\n[providers]\n");
      let result;
      try {
        const agent = new SearchAgent({ llmBaseUrl: baseUrl, maxSteps: 1, configPath });
        result = await agent.research("What is the capital of France?");
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      assert.ok(result.answer.length > 0);
      assert.ok(requests.length >= 2);
      assert.ok(requests.every(req => req.body.reasoning_effort === "medium"));
    });
  });
});

test("agent key references reject raw credentials without exposing their value", () => {
  assert.throws(() => createLLMClient("isoquant", undefined, undefined, { keyRef: "do-not-print-this" }), err => {
    assert.match(err.message, /secret name/);
    assert.ok(!err.message.includes("do-not-print-this"));
    return true;
  });
});

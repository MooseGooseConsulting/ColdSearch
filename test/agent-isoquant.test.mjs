import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("close", status => resolve({ status: status ?? 0, stdout, stderr }));
  });
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

test("switching from default Isoquant to OpenRouter isolates TOML endpoint and key in real CLI HTTP call", async () => {
  const configuredRequests = [];
  const selectedRequests = [];
  const start = async (requests) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
  };
  const configured = await start(configuredRequests);
  const selected = await start(selectedRequests);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-provider-isolation-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, `[capabilities]\n[providers]\n[agent.llm]\nmodel = "isoquant-private-model"\nbase_url = "${configured.url}"\nreasoning_effort = "high"\nkey_ref = "doppler:ISOQUANT_API_KEY"\n`);
  try {
    const result = await runCli(["--agent", "--config", configPath, "--llm", "openrouter", "--llm-base-url", selected.url, "--max-steps", "1", "--json", "hello"], {
      ISOQUANT_API_KEY: "isoquant-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(configuredRequests.length, 0, "must not call the configured Isoquant URL after provider switch");
    assert.ok(selectedRequests.length >= 1);
    assert.ok(selectedRequests.every(request => request.auth === "Bearer openrouter-secret"));
    assert.ok(selectedRequests.every(request => request.body.model === "openrouter/free"));
    assert.ok(selectedRequests.every(request => !("reasoning" in request.body) && !("reasoning_effort" in request.body)));
    assert.ok(!JSON.stringify(selectedRequests[0]).includes("isoquant-secret"));

    const implicitCredentialCount = selectedRequests.length;
    const explicit = await runCli(["--agent", "--config", configPath, "--llm", "openrouter", "--llm-base-url", selected.url, "--llm-key-ref", "env:EXPLICIT_ROUTER_KEY", "--max-steps", "1", "--json", "hello"], {
      ISOQUANT_API_KEY: "isoquant-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      EXPLICIT_ROUTER_KEY: "explicit-router-secret",
    });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.ok(selectedRequests.slice(implicitCredentialCount).every(request => request.auth === "Bearer explicit-router-secret"));
  } finally {
    await Promise.all([configured.server, selected.server].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("switching from default Isoquant to OpenAI cannot send either key to Isoquant URL", async () => {
  const configuredRequests = [];
  const selectedRequests = [];
  const start = async (requests) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
  };
  const configured = await start(configuredRequests);
  const selected = await start(selectedRequests);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-provider-isolation-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, `[capabilities]\n[providers]\n[agent.llm]\nmodel = "isoquant-private-model"\nbase_url = "${configured.url}"\nkey_ref = "doppler:ISOQUANT_API_KEY"\n`);
  try {
    const result = await runCli(["--agent", "--config", configPath, "--llm", "openai", "--max-steps", "1", "--json", "hello"], {
      ISOQUANT_API_KEY: "isoquant-secret",
      OPENAI_API_KEY: "openai-secret",
      OPENAI_BASE_URL: selected.url,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(configuredRequests.length, 0, "must not call the configured Isoquant URL after provider switch");
    assert.ok(selectedRequests.length >= 1);
    assert.ok(selectedRequests.every(request => request.auth === "Bearer openai-secret"));
    assert.ok(selectedRequests.every(request => request.body.model === "gpt-4o"));
    assert.ok(!JSON.stringify(selectedRequests[0]).includes("isoquant-secret"));
  } finally {
    await Promise.all([configured.server, selected.server].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("provider switch drops all TOML fields but honors explicit CLI endpoint and key reference", async () => {
  const resolved = resolveLlmConfig(
    { provider: "openrouter", baseUrl: "http://cli.example/v1", keyRef: "env:CLI_ROUTER_KEY" },
    { model: "isoquant-model", baseUrl: "http://isoquant.example/v1", reasoningEffort: "high", keyRef: "doppler:ISOQUANT_API_KEY" }
  );
  assert.deepEqual(resolved, {
    provider: "openrouter",
    model: undefined,
    baseUrl: "http://cli.example/v1",
    reasoningEffort: undefined,
    keyRef: "env:CLI_ROUTER_KEY",
  });
});

test("OpenRouter forwards its documented reasoning levels unchanged", async () => {
  await withEnv("OPENROUTER_API_KEY", "router-key", async () => {
    await withServer(async (baseUrl, requests) => {
      const client = createLLMClient("openrouter", "openai/gpt-5", baseUrl);
      for (const effort of ["xhigh", "high", "medium", "low", "minimal", "none", "max"]) {
        await client.complete([{ role: "user", content: "Hi" }], { reasoningEffort: effort });
      }
      assert.deepEqual(requests.map((request) => request.body.reasoning), [
        { effort: "xhigh" }, { effort: "high" }, { effort: "medium" },
        { effort: "low" }, { effort: "minimal" }, { effort: "none" }, { effort: "max" },
      ]);
    });
  });
});

test("explicit xAI compatibility uses the documented Grok 4.3 model, not retired Grok 3", async () => {
  await withEnv("XAI_GROK_API_KEY", "xai-contract-key", async () => {
    await withServer(async (baseUrl, requests) => {
      const client = createLLMClient("xai", undefined, baseUrl);
      await client.complete([{ role: "user", content: "Hi" }]);
      assert.equal(requests[0].auth, "Bearer xai-contract-key");
      assert.equal(requests[0].body.model, "grok-4.3");
    });
  });
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

test("agent key references accept Doppler Permissive names and reject invalid env names", async () => {
  const secretName = "project/isoquant.api-key:prod-v2";
  await withEnv(secretName, "permissive-key", async () => {
    await withServer(async (baseUrl, requests) => {
      const client = createLLMClient("isoquant", undefined, baseUrl, {
        keyRef: `doppler:${secretName}`,
      });
      await client.complete([{ role: "user", content: "Hi" }]);
      assert.equal(requests[0].auth, "Bearer permissive-key");
    });
  });
  assert.throws(() => createLLMClient("isoquant", undefined, undefined, { keyRef: "env:bad-name" }), /secret name/);
  assert.throws(() => createLLMClient("isoquant", undefined, undefined, { keyRef: "doppler:DOPPLER_PROJECT" }), /secret name/);
});

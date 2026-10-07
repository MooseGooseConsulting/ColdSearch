import test from "node:test";
import assert from "node:assert/strict";
import { SearchAgent } from "../dist/agent/agent.js";
import { ResearchContext } from "../dist/agent/context.js";
function makeFakeLLM(responses) {
  let i = 0;
  return {
    complete: async () => {
      const content = responses[Math.min(i, responses.length - 1)];
      i++;
      return { content };
    },
  };
}

test("tool dispatch routes to backend search via the search tool", async () => {
  const calls = [];
  const backend = {
    search: async (query) => {
      calls.push({ query });
      return {
        results: [{ title: "T", url: "https://x.example", snippet: "s", score: 1, source: "brave" }],
        providersUsed: ["brave"],
        errors: {},
      };
    },
  };

  const agent = new SearchAgent({
    executionBackend: backend,
    llm: makeFakeLLM([
    JSON.stringify({ type: "tool", tool: "search", args: ["hello"] }),
    JSON.stringify({ type: "final", answer: "done" }),
    ]),
  });

  const out = await agent.research("goal", { maxSteps: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "hello");
  assert.ok(out.answer.startsWith("done"));
  assert.match(out.answer, /Sources:/);
  assert.equal(out.sources.length, 1);
});

test("SSRF guard blocks loopback, link-local, and metadata hostnames", async () => {
  const agent = new SearchAgent({
    executionBackend: { search: async () => ({ results: [], providersUsed: [], errors: {} }) },
    llm: makeFakeLLM([""]),
  });

  await assert.rejects(
    () => agent.validateFetchUrl("http://localhost:1234/"),
    /refusing to fetch internal hostname/i
  );
  await assert.rejects(
    () => agent.validateFetchUrl("http://127.0.0.1/"),
    /refusing to fetch non-public ip/i
  );
  await assert.rejects(
    () => agent.validateFetchUrl("http://[::ffff:7f00:1]/"),
    /refusing to fetch non-public ip/i
  );
  await assert.rejects(
    () => agent.validateFetchUrl("http://169.254.169.254/latest/meta-data/"),
    /refusing to fetch internal hostname/i
  );
});

test("ResearchContext deduplicates sources and enforces maxSources", () => {
  const ctx = new ResearchContext("g", 2);
  ctx.addSource({ title: "A", url: "https://x.example/a", snippet: "s", score: 1, source: "p" });
  ctx.addSource({ title: "A2", url: "https://x.example/a", snippet: "s", score: 0.5, source: "p2" });
  ctx.addSource({ title: "B", url: "https://x.example/b", snippet: "s", score: 1, source: "p" });
  ctx.addSource({ title: "C", url: "https://x.example/c", snippet: "s", score: 1, source: "p" });

  assert.equal(ctx.sources.length, 2);
  assert.deepEqual(ctx.sources.map((s) => s.url), ["https://x.example/a", "https://x.example/b"]);
});

test("maxSteps enforcement returns a final answer even if model keeps calling tools", async () => {
  const backend = {
    search: async () => ({ results: [], providersUsed: ["brave"], errors: {} }),
  };
  const agent = new SearchAgent({
    executionBackend: backend,
    llm: {
    complete: async (messages) => {
      const last = messages[messages.length - 1]?.content || "";
      if (/Maximum steps reached/i.test(last)) {
        return { content: JSON.stringify({ type: "final", answer: "fallback" }) };
      }
      return { content: JSON.stringify({ type: "tool", tool: "search", args: ["q"] }) };
    },
    },
  });

  const out = await agent.research("goal", { maxSteps: 1 });
  assert.equal(out.answer, "fallback");
});

test("generated agent result includes run_id", async () => {
  const agent = new SearchAgent({
    executionBackend: { search: async () => ({ results: [], providersUsed: ["brave"], errors: {} }) },
    llm: makeFakeLLM([JSON.stringify({ type: "final", answer: "done" })]),
  });

  const out = await agent.research("goal", { maxSteps: 2 });
  assert.match(out.run_id, /^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/);
});

test("explicit run ID is used in output", async () => {
  const agent = new SearchAgent({
    executionBackend: { search: async () => ({ results: [], providersUsed: ["brave"], errors: {} }) },
    llm: makeFakeLLM([JSON.stringify({ type: "final", answer: "done" })]),
  });

  const out = await agent.research("goal", { maxSteps: 2, runId: "run_explicit_abc123" });
  assert.equal(out.run_id, "run_explicit_abc123");

  // A run ID passed at construction is the fallback for research().
  const fromConstructor = new SearchAgent({
    executionBackend: { search: async () => ({ results: [], providersUsed: ["brave"], errors: {} }) },
    llm: makeFakeLLM([JSON.stringify({ type: "final", answer: "done" })]),
    runId: "run_ctor_abc123",
  });
  const out2 = await fromConstructor.research("goal", { maxSteps: 2 });
  assert.equal(out2.run_id, "run_ctor_abc123");
});

test("explicit run ID is trimmed to a canonical value", async () => {
  const calls = [];
  const agent = new SearchAgent({
    executionBackend: {
      search: async (query, options) => {
        calls.push({ query, options });
        return { results: [], providersUsed: ["brave"], errors: {} };
      },
    },
    llm: makeFakeLLM([
      JSON.stringify({ type: "tool", tool: "search", args: ["query"] }),
      JSON.stringify({ type: "final", answer: "done" }),
    ]),
  });

  // Surrounding whitespace is stripped so the stored ID matches the value
  // written to output, steps, and usage logs (a padded ID would silently
  // break correlation).
  const out = await agent.research("goal", { maxSteps: 2, runId: "  run_padded_abc  " });
  assert.equal(out.run_id, "run_padded_abc");
  for (const step of out.steps) {
    assert.equal(step.run_id, "run_padded_abc");
  }
  for (const call of calls) {
    assert.equal(call.options.runId, "run_padded_abc");
  }
});

test("empty explicit run ID fails", async () => {
  const agent = new SearchAgent({
    executionBackend: { search: async () => ({ results: [], providersUsed: ["brave"], errors: {} }) },
    llm: makeFakeLLM([JSON.stringify({ type: "final", answer: "done" })]),
  });

  await assert.rejects(
    () => agent.research("goal", { maxSteps: 2, runId: "   " }),
    /run ID/i
  );
  await assert.rejects(
    () => agent.research("goal", { maxSteps: 2, runId: "" }),
    /run ID/i
  );
});

test("every agent step includes the same run ID", async () => {
  const calls = [];
  const backend = {
    search: async (query, options) => {
      calls.push({ query, options });
      return {
        results: [{ title: "T", url: "https://x.example", snippet: "s", score: 1, source: "brave" }],
        providersUsed: ["brave"],
        errors: {},
      };
    },
  };

  const agent = new SearchAgent({
    executionBackend: backend,
    llm: makeFakeLLM([
      JSON.stringify({ type: "tool", tool: "search", args: ["first"] }),
      JSON.stringify({ type: "tool", tool: "search", args: ["second"] }),
      JSON.stringify({ type: "final", answer: "done" }),
    ]),
  });

  const out = await agent.research("goal", { maxSteps: 3, runId: "run_steps_abc" });
  assert.ok(out.steps.length >= 2, "tool steps were recorded");
  for (const step of out.steps) {
    assert.equal(step.run_id, "run_steps_abc");
  }
  // The run ID is threaded from the agent's search tool into the backend.
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.runId, "run_steps_abc");
  }
});


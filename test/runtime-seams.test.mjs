import test from "node:test";
import assert from "node:assert/strict";
import { FanoutEngine } from "../dist/engine/fanout.js";
import { SearXNGAdapter } from "../dist/adapters/searxng.js";
import { HTTPRequestError, classifyError } from "../dist/http.js";

test("fanout rejects providers that do not implement requested capability", async () => {
  const engine = new FanoutEngine({
    capabilities: {
      search: {
        providers: ["jina"],
        strategy: "random",
      },
    },
    providers: {
      jina: {
        keyPool: {
          keys: [],
        },
      },
    },
  });

  await assert.rejects(
    engine.search("fusion", {
      limit: 5,
    }),
    /does not implement capability 'search'/
  );
});

test("searxng requires an explicit base url before searching", async () => {
  const adapter = new SearXNGAdapter();
  await assert.rejects(
    adapter.search("fusion", ""),
    /requires providers\.searxng\.options\.baseUrl/
  );
});

test("searxng preserves configured base paths when building the search URL", async (t) => {
  const originalFetch = global.fetch;
  let requestedUrl = "";

  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (input) => {
    requestedUrl = input.toString();
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = new SearXNGAdapter();
  await adapter.search("fusion", "", {
    providerOptions: {
      baseUrl: "https://search.example.internal/searxng",
    },
  });

  const parsedUrl = new URL(requestedUrl);
  assert.equal(parsedUrl.origin, "https://search.example.internal");
  assert.equal(parsedUrl.pathname, "/searxng/search");
  assert.equal(parsedUrl.searchParams.get("q"), "fusion");
  assert.equal(parsedUrl.searchParams.get("format"), "json");
});

test("unsupported provider/capability pairing is classified as unsupported_capability", () => {
  const { category, message } = classifyError(
    new Error("Provider 'jina' does not implement capability 'search'")
  );
  assert.equal(category, "unsupported_capability");
  assert.equal(message, "Provider 'jina' does not implement capability 'search'");
});

test("unsupported provider-tool pairing is classified as unsupported_tool", () => {
  const { category, message } = classifyError(
    new Error("Unknown provider tool: 'exa.nonexistent'")
  );
  assert.equal(category, "unsupported_tool");
  assert.equal(message, "Unknown provider tool: 'exa.nonexistent'");
});

test("legacy-config refusal is classified as config", () => {
  const { category } = classifyError(
    new Error(
      "Legacy config found at ~/.config/coldsearch/config.toml; ColdSearch already reads it. " +
        "Remove it or pass --config to initialize a new config elsewhere."
    )
  );
  assert.equal(category, "config");
});

test("LLM provider errors classify as config", () => {
  const messages = [
    "Invalid LLM provider: foo. Supported: openai, groq, openrouter, cerebras, xai, isoquant (Anthropic API is not used).",
    'Unsupported LLM provider "foo". Supported: openai, groq, openrouter, cerebras, xai, isoquant.',
    "Unknown LLM provider 'foo'",
  ];
  for (const message of messages) {
    assert.equal(classifyError(new Error(message)).category, "config", message);
  }
});

test("invalid agent reasoning and key-ref settings classify as config", () => {
  for (const message of [
    "Invalid reasoning effort. Supported: none, minimal, low, medium, high, xhigh, max",
    "Invalid agent LLM reasoning effort",
    "Agent LLM key_ref must be an env: or doppler: secret name",
    "[agent.llm] reasoning_effort is not supported for the configured provider",
    "[agent.llm] key_ref must be an env: or doppler: secret name",
  ]) {
    assert.equal(classifyError(new Error(message)).category, "config", message);
  }
});

test("missing execution id classifies as config", () => {
  const { category, message } = classifyError(
    new Error("No execution found with id 'abc-123'.")
  );
  assert.equal(category, "config");
  assert.equal(message, "No execution found with id 'abc-123'.");
});

test("filesystem error codes classify as config", () => {
  for (const code of ["EPERM", "ENOTDIR", "EACCES", "ENOENT"]) {
    const err = new Error(
      `${code}: no such file or directory, open 'D:\\data\\usage.jsonl'`
    );
    err.code = code;
    assert.equal(classifyError(err).category, "config", code);
  }
});

test("HTTP 401/403 classify as credentials; server/transport errors as network", () => {
  for (const status of [401, 403]) {
    const { category, message } = classifyError(
      new HTTPRequestError(`Request failed with HTTP ${status}`, {
        url: "https://api.example/x",
        status,
      })
    );
    assert.equal(category, "credentials", `status ${status}`);
    assert.match(message, /HTTP 40/);
  }

  const serverError = classifyError(
    new HTTPRequestError("Request failed with HTTP 500", {
      url: "https://api.example/x",
      status: 500,
    })
  );
  assert.equal(serverError.category, "network");

  const noStatus = classifyError(
    new HTTPRequestError("Request failed", { url: "https://api.example/x" })
  );
  assert.equal(noStatus.category, "network");
});

test("HTTP status table: quota, rate_limit, validation, provider rows", () => {
  const cases = [
    [402, "quota"],
    [429, "rate_limit"],
    // Tavily plan/usage-limit statuses (provider-agnostic rule).
    [432, "quota"],
    [433, "quota"],
    [408, "network"],
    [500, "network"],
    [502, "network"],
    [503, "network"],
    [504, "network"],
    [400, "validation"],
    [422, "validation"],
    // Unnamed statuses are provider-side conditions, not transport failures.
    [418, "provider"],
    [404, "provider"],
  ];
  for (const [status, expected] of cases) {
    const { category } = classifyError(
      new HTTPRequestError(`Request failed with HTTP ${status}`, {
        url: "https://api.example/x",
        status,
      })
    );
    assert.equal(category, expected, `status ${status}`);
  }
});

test("SearXNG 403 is a config error and adds the JSON-format operator hint", () => {
  const { category, message } = classifyError(
    new HTTPRequestError("SearXNG search failed with HTTP 403", {
      url: "https://search.example/search",
      status: 403,
      label: "SearXNG search",
    })
  );
  assert.equal(category, "config");
  assert.match(message, /SearXNG search failed with HTTP 403/); // original kept
  assert.match(message, /formats: \[json\]/);
  assert.match(message, /settings\.yml/);

  // A non-SearXNG 403 gets no hint.
  const other = classifyError(
    new HTTPRequestError("Serper search failed with HTTP 403", {
      url: "https://google.serper.dev/search",
      status: 403,
      label: "Serper search",
    })
  );
  assert.equal(other.category, "credentials");
  assert.doesNotMatch(other.message, /settings\.yml/);
});

test("structured provider error bodies are not surfaced in the classified message", () => {
  // Live-probe shapes (2026-10-12), one per provider.
  const cases = [
    {
      name: "tavily detail.error",
      label: "Tavily search",
      status: 432,
      body: JSON.stringify({ detail: { error: "Plan limit exceeded" } }),
      category: "quota",
      fragment: "Plan limit exceeded",
    },
    {
      name: "exa error+tag",
      label: "Exa search",
      status: 402,
      body: JSON.stringify({ error: "Payment required", tag: "X402_PAYMENT_REQUIRED" }),
      category: "quota",
      fragment: "Payment required",
    },
    {
      name: "firecrawl error+code",
      label: "Firecrawl extract",
      status: 401,
      body: JSON.stringify({ error: "Invalid API key", code: "AUTH_INVALID" }),
      category: "credentials",
      fragment: "Invalid API key",
    },
    {
      name: "serper message+statusCode",
      label: "Serper search",
      status: 403,
      body: JSON.stringify({ message: "Forbidden", statusCode: 403 }),
      category: "credentials",
      fragment: "Forbidden",
    },
  ];

  for (const c of cases) {
    const original = `${c.label} failed with HTTP ${c.status}`;
    const { category, message } = classifyError(
      new HTTPRequestError(original, {
        url: "https://api.example/x",
        status: c.status,
        body: c.body,
        label: c.label,
      })
    );
    assert.equal(category, c.category, c.name);
    assert.match(message, new RegExp(`^${original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), c.name);
    assert.equal(message, original, `${c.name}: raw provider response was surfaced`);
    assert.ok(!message.includes(c.fragment), `${c.name}: ${message}`);
  }
});

test("classification never throws on unparseable or shapeless bodies", () => {
  for (const body of ["{ not json", JSON.stringify([1, 2]), JSON.stringify({ ok: true }), ""]) {
    const { category, message } = classifyError(
      new HTTPRequestError("Request failed with HTTP 500", {
        url: "https://api.example/x",
        status: 500,
        body,
      })
    );
    assert.equal(category, "network");
    assert.equal(message, "Request failed with HTTP 500");
  }
});

test("fetchWithPolicy request timeouts classify as network", () => {
  // Real message shapes produced by fetchWithPolicy when the internal timeout
  // fires: `<label> timed out after <N>ms` (a plain Error, not an AbortError).
  for (const message of [
    "SearXNG timed out after 10000ms",
    "Request timed out after 10000ms",
  ]) {
    const { category, message: returned } = classifyError(new Error(message));
    assert.equal(category, "network", message);
    assert.equal(returned, message);
  }
});

test("empty provider pool classifies as config", () => {
  // Exact runtime message from resolveCapabilityProviders when a capability
  // has no providers configured — a setup problem, not a provider failure.
  const { category, message } = classifyError(
    new Error("No providers configured for search")
  );
  assert.equal(category, "config");
  assert.equal(message, "No providers configured for search");
});

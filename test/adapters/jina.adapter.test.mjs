import test from "node:test";
import assert from "node:assert/strict";
import { JinaAdapter } from "../../dist/adapters/jina.js";
import { installFetchMock, textResponse } from "./_fetch-mock.mjs";
test("jina extract preserves the caller's https scheme", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      assert.equal(url, "https://r.jina.ai/https://x.example");
      return textResponse("Title: Hello\n\nBody");
    },
  });
  try {
    const adapter = new JinaAdapter();
    const result = await adapter.extract("https://x.example", "");
    assert.equal(result.source, "jina");
    assert.equal(result.title, "Hello");
    assert.equal(result.content, "Body");
  } finally {
    restore();
  }
});

test("jina extract preserves the caller's http scheme (no forced upgrade/downgrade)", async () => {
  const restore = installFetchMock({
    "*": async ({ url }) => {
      assert.match(url, /^https:\/\/r\.jina\.ai\/http:\/\/x\.example/);
      return textResponse("Body");
    },
  });
  try {
    const adapter = new JinaAdapter();
    const result = await adapter.extract("http://x.example", "");
    assert.equal(result.url, "http://x.example");
  } finally {
    restore();
  }
});

test("jina sends Authorization only when a key is configured", async () => {
  const seen = [];
  const restore = installFetchMock({
    "*": async ({ init }) => {
      seen.push(init.headers ?? {});
      return textResponse("Body");
    },
  });
  try {
    const adapter = new JinaAdapter();
    await adapter.extract("https://x.example", "secret-key");
    await adapter.extract("https://x.example", "");
  } finally {
    restore();
  }
  const [authed, keyless] = seen.map((h) => {
    const entries = Array.isArray(h) ? h : Object.entries(h);
    return Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), v]));
  });
  assert.equal(authed.authorization, "Bearer secret-key");
  assert.equal("authorization" in keyless, false);
});

test("jina passes through X-* providerOptions as headers, skipping undefined/null", async () => {
  let captured;
  const restore = installFetchMock({
    "*": async ({ init }) => {
      captured = init.headers ?? {};
      return textResponse("Body");
    },
  });
  try {
    const adapter = new JinaAdapter();
    await adapter.extract("https://x.example", "", {
      providerOptions: {
        "X-Return-Format": "markdown",
        "X-Timeout": 30,
        "X-Api-Key": "operator-secret",
        "X-No-Cache": undefined,
        "X-Null": null,
        ignored: "not-an-x-header",
      },
    });
  } finally {
    restore();
  }
  assert.equal(captured["X-Return-Format"], "markdown");
  assert.equal(captured["X-Timeout"], "30");
  assert.equal("X-Api-Key" in captured, false);
  assert.equal("X-No-Cache" in captured, false);
  assert.equal("X-Null" in captured, false);
  assert.equal("ignored" in captured, false);
});

test("jina returns error on empty content", async () => {
  const restore = installFetchMock({
    "*": async () => textResponse("   "),
  });
  try {
    const adapter = new JinaAdapter();
    await assert.rejects(() => adapter.extract("https://x.example", ""), /no content extracted/i);
  } finally {
    restore();
  }
});

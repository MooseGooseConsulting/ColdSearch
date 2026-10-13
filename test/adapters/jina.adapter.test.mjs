import test from "node:test";
import assert from "node:assert/strict";
import { JinaAdapter } from "../../dist/adapters/jina.js";
import { installFetchMock, textResponse } from "./_fetch-mock.mjs";
test("jina extract normalizes title prefix", async () => {
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


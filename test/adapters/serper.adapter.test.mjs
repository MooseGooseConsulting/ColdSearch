import test from "node:test";
import assert from "node:assert/strict";
import { SerperAdapter } from "../../dist/adapters/serper.js";
import { installFetchMock, jsonResponse } from "./_fetch-mock.mjs";

test("serper search clamps providerOptions num to 1..100 (default 10)", async () => {
  const bodies = [];
  const restore = installFetchMock({
    "POST https://google.serper.dev/search": async ({ init }) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ organic: [] });
    },
  });
  try {
    const adapter = new SerperAdapter();
    await adapter.search("q", "k");
    await adapter.search("q", "k", { providerOptions: { num: 250 } });
  } finally {
    restore();
  }

  assert.equal(bodies[0].num, 10);
  assert.equal(bodies[1].num, 100);
});

test("serper search sends location only when configured", async () => {
  const bodies = [];
  const restore = installFetchMock({
    "POST https://google.serper.dev/search": async ({ init }) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ organic: [] });
    },
  });
  try {
    const adapter = new SerperAdapter();
    await adapter.search("q", "k");
    await adapter.search("q", "k", { providerOptions: { location: "Austin, Texas" } });
  } finally {
    restore();
  }

  assert.equal("location" in bodies[0], false);
  assert.equal(bodies[1].location, "Austin, Texas");
});

import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  fetchWithPolicy,
  retryAfterMs,
  withJitter,
  MAX_RETRY_AFTER_MS,
} from "../dist/http.js";
import { installFetchMock, jsonResponse, rawResponse } from "./adapters/_fetch-mock.mjs";

test("retryAfterMs parses delta-seconds and caps at MAX_RETRY_AFTER_MS", () => {
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" })), 2000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "120" })), MAX_RETRY_AFTER_MS);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "999999" })), MAX_RETRY_AFTER_MS);
});

test("retryAfterMs parses HTTP-date form and rejects absent/invalid/past values", () => {
  const future = new Date(Date.now() + 2000).toUTCString();
  const ms = retryAfterMs(new Headers({ "retry-after": future }));
  assert.ok(ms >= 1000 && ms <= 3000, `expected ~2000ms, got ${ms}`);

  assert.equal(retryAfterMs(new Headers()), undefined);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "garbage" })), undefined);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "-5" })), undefined);
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(retryAfterMs(new Headers({ "retry-after": past })), undefined);
});

test("withJitter stays within ±20% of the base delay", () => {
  for (let i = 0; i < 500; i++) {
    const jittered = withJitter(1000);
    assert.ok(jittered >= 800 && jittered <= 1200, `out of bounds: ${jittered}`);
  }
  // Jitter actually varies (not a constant multiplier).
  const samples = new Set(Array.from({ length: 50 }, () => withJitter(10_000)));
  assert.ok(samples.size > 1, "jitter should produce varying delays");
});

test("fetchWithPolicy honors Retry-After on 429 instead of linear backoff", async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0.5; // jitter factor exactly 1.0 for a deterministic wait
  t.after(() => {
    Math.random = originalRandom;
  });

  let calls = 0;
  const restore = installFetchMock({
    "*": async () => {
      calls++;
      if (calls === 1) {
        return rawResponse("slow down", { status: 429, headers: { "retry-after": "1" } });
      }
      return jsonResponse({ ok: true });
    },
  });

  try {
    const start = performance.now();
    const res = await fetchWithPolicy("https://api.example/x", {}, { retries: 1 });
    const elapsed = performance.now() - start;

    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    // Retry-After: 1 (1000ms) must dominate the default 500ms linear backoff.
    assert.ok(elapsed >= 950, `expected ~1000ms wait, got ${elapsed}ms`);
    assert.ok(elapsed < 2000, `wait should not overshoot wildly, got ${elapsed}ms`);
  } finally {
    restore();
  }
});

test("fetchWithPolicy falls back to linear backoff when Retry-After is absent/invalid", async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0.5; // jitter factor exactly 1.0
  t.after(() => {
    Math.random = originalRandom;
  });

  let calls = 0;
  const restore = installFetchMock({
    "*": async () => {
      calls++;
      if (calls === 1) {
        return rawResponse("slow down", { status: 429, headers: { "retry-after": "garbage" } });
      }
      return jsonResponse({ ok: true });
    },
  });

  try {
    const start = performance.now();
    const res = await fetchWithPolicy(
      "https://api.example/x",
      {},
      { retries: 1, retryDelayMs: 150 }
    );
    const elapsed = performance.now() - start;

    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.ok(elapsed >= 120, `expected ~150ms linear backoff, got ${elapsed}ms`);
    assert.ok(elapsed < 1000, `invalid Retry-After must not be honored, got ${elapsed}ms`);
  } finally {
    restore();
  }
});

test("fetchWithPolicy honors Retry-After on 503 as well", async (t) => {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  t.after(() => {
    Math.random = originalRandom;
  });

  let calls = 0;
  const restore = installFetchMock({
    "*": async () => {
      calls++;
      if (calls === 1) {
        return rawResponse("unavailable", { status: 503, headers: { "retry-after": "1" } });
      }
      return jsonResponse({ ok: true });
    },
  });

  try {
    const start = performance.now();
    const res = await fetchWithPolicy("https://api.example/x", {}, { retries: 1 });
    const elapsed = performance.now() - start;

    assert.equal(res.status, 200);
    assert.equal(calls, 2);
    assert.ok(elapsed >= 950, `expected ~1000ms wait, got ${elapsed}ms`);
  } finally {
    restore();
  }
});

test("POST requests are still never retried (method gating unchanged)", async () => {
  let calls = 0;
  const restore = installFetchMock({
    "*": async () => {
      calls++;
      return rawResponse("slow down", { status: 429, headers: { "retry-after": "1" } });
    },
  });

  try {
    await assert.rejects(
      fetchWithPolicy(
        "https://api.example/x",
        { method: "POST", body: "{}" },
        { retries: 3 }
      ),
      (err) => err.status === 429
    );
    assert.equal(calls, 1, "POST must not be retried");
  } finally {
    restore();
  }
});

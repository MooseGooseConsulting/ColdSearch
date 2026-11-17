import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchWithPolicy, HTTPRequestError } from "../dist/http.js";
import {
  buildCaptureRecord,
  flushCaptures,
  redactText,
  setCaptureSecrets,
  clearCaptureSecrets,
  captureEnabled,
} from "../dist/testing/capture.js";
import { installFetchMock, jsonResponse, rawResponse, textResponse } from "./adapters/_fetch-mock.mjs";

/**
 * Capture integration tests (issue #79, PR-E): the COLDSEARCH_CAPTURE_DIR
 * recorder writes one JSONL line per exchange, redacts secrets everywhere,
 * and is a strict no-op when the env var is unset.
 */

const SECRET = "sk-capture-test-9f8e7d6c5b";
const SECRET2 = "tvly-capture-test-001122334455";

function readCaptureLines(dir) {
  const files = fs.readdirSync(dir).filter((name) => /^capture-\d{8}-\d{6}\.jsonl$/.test(name));
  assert.ok(files.length > 0, "expected at least one capture-*.jsonl file");
  const lines = [];
  for (const file of files.sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  }
  return { files, lines };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-capture-"));
}

test("capture is off by default (env unset → no-op)", () => {
  const previous = process.env.COLDSEARCH_CAPTURE_DIR;
  delete process.env.COLDSEARCH_CAPTURE_DIR;
  try {
    assert.equal(captureEnabled(), false);
    process.env.COLDSEARCH_CAPTURE_DIR = "/tmp/coldsearch-capture-probe";
    assert.equal(captureEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.COLDSEARCH_CAPTURE_DIR;
    else process.env.COLDSEARCH_CAPTURE_DIR = previous;
  }
});

test("redactText strips secrets from URL query and JSON body, plus credential keys", () => {
  const url = `https://api.example.com/search?api_key=${SECRET}&q=test`;
  const redactedUrl = redactText(url, [SECRET]);
  assert.equal(redactedUrl, "https://api.example.com/search?api_key=REDACTED&q=test");

  const body = JSON.stringify({ query: "x", token: SECRET2, note: "keep me" });
  const redactedBody = redactText(body, [SECRET2]);
  assert.ok(!redactedBody.includes(SECRET2));
  assert.ok(redactedBody.includes("keep me"));

  // Credential-key redaction works even when the secret was never threaded.
  const unthreaded = redactText("https://x.example/?access_token=abc123def", []);
  assert.equal(unthreaded, "https://x.example/?access_token=REDACTED");
});

test("buildCaptureRecord redacts sensitive headers and secret-bearing header values", () => {
  const record = buildCaptureRecord({
    label: "Unit capture",
    method: "post",
    url: "https://api.example.com/v1",
    requestHeaders: {
      Authorization: `Bearer ${SECRET}`,
      "X-API-Key": SECRET2,
      "X-Subscription-Token": "sub-token",
      "X-Custom": `prefix-${SECRET}-suffix`,
      "X-Provider-Token": "custom-header-secret",
      "X-Tavily-Key": "provider-key-secret",
      "Content-Type": "application/json",
    },
    requestBody: JSON.stringify({ api_key: SECRET }),
    status: 200,
    responseHeaders: new Headers({
      "content-type": "application/json",
      "retry-after": "2",
      "x-ratelimit-remaining": "42",
      "x-unrelated": "dropped",
    }),
    responseBodyText: JSON.stringify({ ok: true }),
    durationMs: 12.4,
    secrets: [SECRET, SECRET2],
  });

  assert.equal(record.method, "POST");
  assert.equal(record.requestHeaders.authorization, "REDACTED");
  assert.equal(record.requestHeaders["x-api-key"], "REDACTED");
  assert.equal(record.requestHeaders["x-subscription-token"], "REDACTED");
  assert.equal(record.requestHeaders["x-custom"], "REDACTED");
  assert.equal(record.requestHeaders["x-provider-token"], "REDACTED");
  assert.equal(record.requestHeaders["x-tavily-key"], "REDACTED");
  assert.equal(record.requestHeaders["content-type"], "application/json");
  assert.deepEqual(record.responseHeaders, {
    "content-type": "application/json",
    "retry-after": "2",
    "x-ratelimit-remaining": "42",
  });

  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(SECRET), "record must never contain a secret value");
  assert.ok(!serialized.includes(SECRET2));
});

test("buildCaptureRecord truncates response bodies at 64 KiB", () => {
  const big = "a".repeat(80 * 1024);
  const record = buildCaptureRecord({
    method: "GET",
    url: "https://api.example.com/big",
    responseBodyText: big,
    durationMs: 1,
  });
  assert.ok(Buffer.byteLength(record.responseBodyText, "utf8") < 80 * 1024);
  assert.match(record.responseBodyText, /\[truncated at 64 KiB\]$/);
});

test("buildCaptureRecord redacts known secrets before truncating response bodies", () => {
  const body = `${"a".repeat(64 * 1024 - 5)}${SECRET}tail`;
  const record = buildCaptureRecord({
    method: "GET",
    url: "https://api.example.com/big",
    responseBodyText: body,
    durationMs: 1,
    secrets: [SECRET],
  });
  assert.ok(!record.responseBodyText.includes(SECRET.slice(0, 5)));
  assert.match(record.responseBodyText, /\[truncated at 64 KiB\]$/);
});

test("bounded response capture drops a secret fragment split at the 64 KiB boundary", async (t) => {
  const previous = process.env.COLDSEARCH_CAPTURE_DIR;
  const dir = makeTempDir();
  process.env.COLDSEARCH_CAPTURE_DIR = dir;
  const body = `${"a".repeat(64 * 1024 - 4)}${SECRET}tail`;
  const restore = installFetchMock({ "*": async () => textResponse(body) });
  t.after(() => {
    restore();
    if (previous === undefined) delete process.env.COLDSEARCH_CAPTURE_DIR;
    else process.env.COLDSEARCH_CAPTURE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const response = await fetchWithPolicy(
    "https://capture.example/boundary",
    {},
    { retries: 0, secrets: [SECRET] }
  );
  assert.equal(await response.text(), body, "capture must not consume the caller response");
  await flushCaptures();

  const { lines } = readCaptureLines(dir);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].responseBodyText.includes(SECRET.slice(0, 4)));
  assert.ok(!JSON.stringify(lines[0]).includes(SECRET));
});

test("retryable HTTP responses capture their response body before retrying", async (t) => {
  const previous = process.env.COLDSEARCH_CAPTURE_DIR;
  const dir = makeTempDir();
  process.env.COLDSEARCH_CAPTURE_DIR = dir;
  let calls = 0;
  const restore = installFetchMock({
    "*": async () => {
      calls++;
      if (calls === 1) {
        return rawResponse(JSON.stringify({ message: "slow down", token: SECRET }), { status: 429 });
      }
      return jsonResponse({ ok: true });
    },
  });
  t.after(() => {
    restore();
    if (previous === undefined) delete process.env.COLDSEARCH_CAPTURE_DIR;
    else process.env.COLDSEARCH_CAPTURE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const response = await fetchWithPolicy(
    "https://capture.example/retry",
    {},
    { retries: 1, retryDelayMs: 0, secrets: [SECRET] }
  );
  assert.deepEqual(await response.json(), { ok: true });
  await flushCaptures();

  const { lines } = readCaptureLines(dir);
  assert.equal(calls, 2);
  assert.equal(lines.length, 2);
  const [transient, final] = lines;
  assert.equal(transient.status, 429);
  assert.match(transient.responseBodyText, /slow down/);
  assert.ok(!JSON.stringify(transient).includes(SECRET));
  assert.equal(final.status, 200);
  assert.ok(final.responseBodyText.includes("ok"));
});

test("end-to-end capture: success + 429 + timeout lines with redaction; unset env writes nothing", async (t) => {
  const dir = makeTempDir();
  process.env.COLDSEARCH_CAPTURE_DIR = dir;
  setCaptureSecrets([SECRET2]);
  t.after(() => {
    delete process.env.COLDSEARCH_CAPTURE_DIR;
    clearCaptureSecrets();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let calls = 0;
  const restore = installFetchMock({
    "*": async ({ url, init }) => {
      calls++;
      if (url.includes("/ok")) {
        return jsonResponse({ ok: true });
      }
      if (url.includes("/limited")) {
        return jsonResponse(
          { detail: { error: "slow down" } },
          { status: 429, headers: { "retry-after": "1", "x-ratelimit-remaining": "0" } }
        );
      }
      // /slow: never respond until the caller's abort signal fires.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    },
  });

  try {
    // 1. Success exchange, with secrets in headers, URL query, and body.
    const okResponse = await fetchWithPolicy(
      `https://capture.example/ok?api_key=${SECRET}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "x-api-key": SECRET2,
          "content-type": "application/json",
        },
        body: JSON.stringify({ q: "x", api_key: SECRET }),
      },
      { label: "Capture success", secrets: [SECRET] }
    );
    assert.equal(okResponse.status, 200);
    // The returned response body must still be readable (clone did not consume it).
    assert.deepEqual(await okResponse.json(), { ok: true });

    // 2. 429 error exchange (no retries: final status is captured).
    await assert.rejects(
      fetchWithPolicy(
        "https://capture.example/limited",
        { headers: { authorization: `Bearer ${SECRET}` } },
        { label: "Capture limited", retries: 0, secrets: [SECRET] }
      ),
      (error) => error instanceof HTTPRequestError && error.status === 429
    );

    // 3. Timeout exchange.
    await assert.rejects(
      fetchWithPolicy(
        "https://capture.example/slow",
        {},
        { label: "Capture slow", timeoutMs: 25, retries: 0 }
      ),
      /timed out after 25ms/
    );

    await flushCaptures();

    const { lines } = readCaptureLines(dir);
    assert.equal(lines.length, 3, `expected 3 capture lines, got ${JSON.stringify(lines)}`);
    assert.equal(calls, 3);

    const okLine = lines.find((line) => line.label === "Capture success");
    assert.equal(okLine.method, "POST");
    assert.equal(okLine.status, 200);
    assert.equal(okLine.requestHeaders.authorization, "REDACTED");
    assert.equal(okLine.requestHeaders["x-api-key"], "REDACTED");
    assert.equal(typeof okLine.durationMs, "number");
    assert.ok(okLine.responseBodyText.includes('"ok":true'));

    const limitedLine = lines.find((line) => line.label === "Capture limited");
    assert.equal(limitedLine.status, 429);
    assert.equal(limitedLine.responseHeaders["retry-after"], "1");
    assert.equal(limitedLine.responseHeaders["x-ratelimit-remaining"], "0");
    assert.ok(limitedLine.responseBodyText.includes("slow down"));

    const slowLine = lines.find((line) => line.label === "Capture slow");
    assert.equal(slowLine.status, undefined);
    assert.match(slowLine.error, /timed out after 25ms/);

    // Critical redaction guarantee: no secret value anywhere in the files.
    for (const file of fs.readdirSync(dir)) {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      assert.ok(!content.includes(SECRET), `${file} leaked the policy secret`);
      assert.ok(!content.includes(SECRET2), `${file} leaked the global capture secret`);
    }

    // 4. Unset the env var: capture becomes a no-op and writes nothing.
    delete process.env.COLDSEARCH_CAPTURE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });

    await fetchWithPolicy(
      "https://capture.example/ok",
      { headers: { authorization: `Bearer ${SECRET}` } },
      { label: "Capture off", secrets: [SECRET] }
    );
    await flushCaptures();
    assert.equal(fs.existsSync(dir), false, "no capture files may be written when the env var is unset");
  } finally {
    restore();
  }
});

test("capture never breaks the request when the capture dir is unwritable", async () => {
  const previous = process.env.COLDSEARCH_CAPTURE_DIR;
  // A path that cannot be created (a file blocks mkdir recursive).
  const blocker = makeTempDir();
  const blockerFile = path.join(blocker, "not-a-dir");
  fs.writeFileSync(blockerFile, "x");
  process.env.COLDSEARCH_CAPTURE_DIR = path.join(blockerFile, "nested");

  const restore = installFetchMock({ "*": async () => textResponse("fine") });
  try {
    const response = await fetchWithPolicy("https://capture.example/ok", {}, { label: "Broken dir" });
    assert.equal(await response.text(), "fine");
    await flushCaptures();
  } finally {
    restore();
    if (previous === undefined) delete process.env.COLDSEARCH_CAPTURE_DIR;
    else process.env.COLDSEARCH_CAPTURE_DIR = previous;
    fs.rmSync(blocker, { recursive: true, force: true });
  }
});

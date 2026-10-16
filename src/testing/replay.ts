import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CaptureRecord } from "./capture.js";

/**
 * Fixture format + replay helpers (issue #79, PR-E test proof layer 2).
 *
 * A fixture is a captured provider envelope — the same shape as a capture
 * line — pinned into `test/fixtures/provider-envelopes/` so tests can replay
 * REAL provider wire shapes through adapter normalization and error
 * classification without any network access. `fixtureVersion` allows the
 * format to evolve; version 1 is the capture-line shape verbatim.
 */

export const FIXTURE_VERSION = 1 as const;

export interface ProviderEnvelopeFixture extends CaptureRecord {
  fixtureVersion: typeof FIXTURE_VERSION;
  /** Provider slug the envelope was captured from (e.g. "firecrawl"). */
  provider: string;
  /** Free-text provenance note (capture date, truncation notes, …). */
  notes?: string;
}

export function isFixtureRecord(value: unknown): value is ProviderEnvelopeFixture {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.fixtureVersion === FIXTURE_VERSION &&
    typeof record.provider === "string" &&
    typeof record.method === "string" &&
    typeof record.url === "string"
  );
}

/**
 * Load fixture records from a single JSON file or from every `*.json` file in
 * a directory (sorted by name for deterministic replay order). Each file
 * holds one fixture object or an array of them.
 */
export async function loadFixtures(targetPath: string): Promise<ProviderEnvelopeFixture[]> {
  const info = await stat(targetPath);
  const files = info.isDirectory()
    ? (await readdir(targetPath))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => path.join(targetPath, name))
    : [targetPath];

  const fixtures: ProviderEnvelopeFixture[] = [];
  for (const file of files) {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      if (!isFixtureRecord(record)) {
        throw new Error(`Invalid provider envelope fixture in ${file}`);
      }
      fixtures.push(record);
    }
  }
  return fixtures;
}

/** Rebuild a Response exactly as captured (status, headers, body text). */
export function fixtureResponse(fixture: ProviderEnvelopeFixture): Response {
  if (fixture.status === undefined && fixture.error) {
    throw new Error(`Captured transport failure: ${fixture.error}`);
  }
  const status = fixture.status ?? 200;
  const body = [204, 205, 304].includes(status)
    ? null
    : fixture.responseBodyText ?? "";
  return new Response(body, {
    status,
    headers: fixture.responseHeaders ?? { "content-type": "application/json" },
  });
}

/**
 * Mock-fetch handler map (compatible with test/adapters/_fetch-mock.mjs
 * installFetchMock) that replays fixtures in order regardless of URL match.
 */
export function fixtureHandlers(
  fixtures: ProviderEnvelopeFixture[]
): Record<string, () => Promise<Response>> {
  return createFixtureSequence(fixtures).handlers;
}

function createFixtureSequence(fixtures: ProviderEnvelopeFixture[]): {
  handlers: Record<string, () => Promise<Response>>;
  remaining: () => number;
} {
  const queue = [...fixtures];
  return {
    handlers: {
      "*": async () => {
        const fixture = queue.shift();
        if (!fixture) {
          throw new Error("replayAdapterTest: fixture queue exhausted — more HTTP calls than fixtures");
        }
        return fixtureResponse(fixture);
      },
    },
    remaining: () => queue.length,
  };
}

/**
 * Replay an ordered sequence of captured exchanges through one adapter
 * invocation (for example, a crawl start followed by its poll request).
 * Every fixture must be consumed by exactly one fetch during that invocation.
 */
export async function replayAdapterInvocation<T>(
  adapterMethod: () => Promise<T>,
  fixtures: ProviderEnvelopeFixture[],
  installMock: (handlers: Record<string, () => Promise<Response>>) => () => void
): Promise<T> {
  const sequence = createFixtureSequence(fixtures);
  const restore = installMock(sequence.handlers);
  try {
    const result = await adapterMethod();
    const consumed = fixtures.length - sequence.remaining();
    if (sequence.remaining() > 0) {
      throw new Error(
        `replayAdapterInvocation: expected ${fixtures.length} HTTP exchanges, consumed ${consumed}`
      );
    }
    return result;
  } finally {
    restore();
  }
}

/**
 * Play captured envelopes through an adapter's normalization path and return
 * the normalized results, one per fixture.
 *
 * `adapterMethod` is invoked once per fixture (e.g.
 * `(fixture) => adapter.extract("https://example.com/x", "REDACTED")`).
 * `installMock` is the test fetch-mock installer (the
 * test/adapters/_fetch-mock.mjs installFetchMock signature) — passed in so
 * src/ never imports from test/.
 */
export async function replayAdapterTest<T>(
  adapterMethod: (fixture: ProviderEnvelopeFixture) => Promise<T>,
  fixtures: ProviderEnvelopeFixture[],
  installMock: (handlers: Record<string, () => Promise<Response>>) => () => void
): Promise<T[]> {
  const restore = installMock(fixtureHandlers(fixtures));
  try {
    const results: T[] = [];
    for (const fixture of fixtures) {
      results.push(await adapterMethod(fixture));
    }
    return results;
  } finally {
    restore();
  }
}

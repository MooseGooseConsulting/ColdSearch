import type { CapabilityName } from "../types.js";

/**
 * Minimal shape contract for the normalized results adapters hand to the
 * engine boundary:
 *   search  → array of items with string { title, url, snippet }
 *   extract → object with string { content } (title optional)
 *   crawl   → array of items with string { url }
 *
 * This deliberately validates only the fields downstream consumers
 * (reranking, history, CLI rendering) dereference unconditionally — it is a
 * fail-loud guard against malformed adapter normalization, not a full schema
 * validator.
 */
const REQUIRED_FIELDS: Record<CapabilityName, string[]> = {
  search: ["title", "url", "snippet"],
  extract: ["content"],
  crawl: ["url"],
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function describeItem(item: unknown): string {
  try {
    return JSON.stringify(item)?.slice(0, 200) ?? String(item);
  } catch {
    return String(item);
  }
}

/**
 * Assert that a normalized adapter result satisfies the minimal envelope
 * shape for its capability. Throws an Error whose message classifies as
 * "provider" (via classifyError's default) so a malformed adapter
 * normalization fails loudly at the engine boundary instead of propagating
 * garbage downstream. An empty array is a valid result, not a violation.
 */
export function assertNormalizedResult(
  capability: CapabilityName,
  provider: string,
  result: unknown
): void {
  const required = REQUIRED_FIELDS[capability];

  if (capability === "extract") {
    // extract normalizes to a single object, not an array.
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(
        `Provider '${provider}' returned a malformed ${capability} result: ` +
          `expected an object with { ${required.join(", ")} }, got ${describeItem(result)}`
      );
    }
    const record = result as Record<string, unknown>;
    for (const field of required) {
      if (!isString(record[field])) {
        throw new Error(
          `Provider '${provider}' returned a malformed ${capability} result: ` +
            `missing/invalid '${field}' in ${describeItem(result)}`
        );
      }
    }
    if (record.title !== undefined && typeof record.title !== "string") {
      throw new Error(
        `Provider '${provider}' returned a malformed ${capability} result: ` +
          `optional 'title' must be a string in ${describeItem(result)}`
      );
    }
    return;
  }

  if (!Array.isArray(result)) {
    throw new Error(
      `Provider '${provider}' returned a malformed ${capability} result: ` +
        `expected an array, got ${describeItem(result)}`
    );
  }

  for (const item of result) {
    if (!item || typeof item !== "object") {
      throw new Error(
        `Provider '${provider}' returned a malformed ${capability} result: ` +
          `expected item object with { ${required.join(", ")} }, got ${describeItem(item)}`
      );
    }
    const record = item as Record<string, unknown>;
    for (const field of required) {
      if (!isString(record[field])) {
        throw new Error(
          `Provider '${provider}' returned a malformed ${capability} result: ` +
            `missing/invalid '${field}' in item ${describeItem(item)}`
        );
      }
    }
    if (
      capability === "search" &&
      (typeof record.score !== "number" || !Number.isFinite(record.score))
    ) {
      throw new Error(
        `Provider '${provider}' returned a malformed ${capability} result: ` +
          `missing/invalid finite 'score' in item ${describeItem(item)}`
      );
    }
  }
}

import fs from "node:fs";
import { INTENT_DEFS, isSearchIntent } from "../dispatch/intents.js";
import { getToolProfile } from "../registry/tool-profiles.js";
import type { CapabilityName } from "../types.js";
import type { BatchInputRecord, BatchOutputRecord } from "./types.js";

const CAPABILITIES: CapabilityName[] = ["search", "extract", "crawl"];
const BATCH_INPUT_FIELDS = new Set([
  "id",
  "capability",
  "tool",
  "query",
  "url",
  "input",
  "limit",
  "format",
  "depth",
  "providers",
  "singleProvider",
  "noCache",
  "intent",
  "commonOptions",
]);
const COMMON_OPTION_FIELDS = new Set([
  "limit",
  "includeDomains",
  "excludeDomains",
  "timeRange",
  "includeContent",
]);

/** Aggregate batch input validation failure. */
export class BatchInputError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid batch input (${errors.length} error(s)):\n  - ${errors.join("\n  - ")}`);
    this.name = "BatchInputError";
    this.errors = errors;
  }
}

/**
 * Validate one raw input record against the batch input contract:
 *
 * - `id` is required and must be a non-empty string.
 * - Each record specifies exactly one of `capability` | `tool`.
 * - `capability` is `search` | `extract` | `crawl`; `search` requires `query`,
 *   `extract`/`crawl` require `url`.
 * - `tool` is a provider-tool name exposed by `coldsearch tool list` and
 *   requires an `input` object.
 * - Optional knobs are type-checked (`limit`, `format`, `depth`, `providers`,
 *   `singleProvider`, `noCache`, `intent`, `commonOptions`).
 */
export function validateBatchInput(raw: unknown): asserts raw is BatchInputRecord {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BatchInputError(["record must be a JSON object"]);
  }
  const record = raw as Record<string, unknown>;

  for (const field of Object.keys(record)) {
    if (!BATCH_INPUT_FIELDS.has(field)) {
      errors.push(`'${field}' is not a supported batch input field`);
    }
  }

  if (typeof record.id !== "string" || record.id.trim() === "") {
    errors.push("'id' is required and must be a non-empty string");
  }

  const hasCapability = record.capability !== undefined;
  const hasTool = record.tool !== undefined;
  if (hasCapability === hasTool) {
    errors.push("each record must specify exactly one of 'capability' or 'tool'");
  } else if (hasCapability) {
    if (!CAPABILITIES.includes(record.capability as CapabilityName)) {
      errors.push(`'capability' must be one of ${CAPABILITIES.join(", ")}`);
    }
    const capability = record.capability as CapabilityName;
    if (
      capability === "search" &&
      (typeof record.query !== "string" || record.query.trim() === "")
    ) {
      errors.push("'search' records require a non-empty 'query'");
    }
    if (
      capability !== "search" &&
      (typeof record.url !== "string" || record.url.trim() === "")
    ) {
      errors.push(`'${capability}' records require a non-empty 'url'`);
    }
  } else {
    if (typeof record.tool !== "string" || record.tool.trim() === "") {
      errors.push("'tool' must be a non-empty provider-tool id like 'exa.search'");
    } else if (getToolProfile(record.tool) === undefined) {
      errors.push(
        `'tool' must be exposed by 'coldsearch tool list'; unknown tool '${record.tool}'`
      );
    }
    if (
      record.input === undefined ||
      record.input === null ||
      typeof record.input !== "object" ||
      Array.isArray(record.input)
    ) {
      errors.push("'tool' records require an 'input' object");
    }
  }

  if (
    record.limit !== undefined &&
    (typeof record.limit !== "number" ||
      !Number.isFinite(record.limit) ||
      record.limit < 1)
  ) {
    errors.push("'limit' must be a positive number when present");
  }
  if (
    record.format !== undefined &&
    record.format !== "markdown" &&
    record.format !== "text"
  ) {
    errors.push("'format' must be 'markdown' or 'text' when present");
  }
  if (record.format !== undefined && (!hasCapability || record.capability !== "extract")) {
    errors.push("'format' is only valid for 'extract' capability records");
  }
  if (
    record.depth !== undefined &&
    (typeof record.depth !== "number" ||
      !Number.isInteger(record.depth) ||
      record.depth < 0)
  ) {
    errors.push("'depth' must be a non-negative integer when present");
  }
  if (record.depth !== undefined && (!hasCapability || record.capability !== "crawl")) {
    errors.push("'depth' is only valid for 'crawl' capability records");
  }
  if (
    record.providers !== undefined &&
    (!Array.isArray(record.providers) ||
      record.providers.some((p) => typeof p !== "string" || p.trim() === ""))
  ) {
    errors.push("'providers' must be an array of provider names when present");
  }
  if (record.singleProvider !== undefined && typeof record.singleProvider !== "boolean") {
    errors.push("'singleProvider' must be a boolean when present");
  }
  if (record.noCache !== undefined && typeof record.noCache !== "boolean") {
    errors.push("'noCache' must be a boolean when present");
  }

  if (record.intent !== undefined) {
    if (!hasCapability) {
      errors.push("'intent' is only valid for capability records");
    } else if (typeof record.intent !== "string" || !isSearchIntent(record.intent)) {
      errors.push("'intent' must be a supported capability intent");
    } else if (
      CAPABILITIES.includes(record.capability as CapabilityName) &&
      INTENT_DEFS[record.intent].category !== record.capability
    ) {
      errors.push(`'intent' '${record.intent}' does not match capability '${String(record.capability)}'`);
    }
  }

  if (record.commonOptions !== undefined) {
    if (!hasCapability) {
      errors.push("'commonOptions' is only valid for capability records");
    }
    if (
      record.commonOptions === null ||
      typeof record.commonOptions !== "object" ||
      Array.isArray(record.commonOptions)
    ) {
      errors.push("'commonOptions' must be an object when present");
    } else {
      const commonOptions = record.commonOptions as Record<string, unknown>;
      for (const field of Object.keys(commonOptions)) {
        if (!COMMON_OPTION_FIELDS.has(field)) {
          errors.push(`'commonOptions.${field}' is not a supported common option`);
        }
      }
      if (
        commonOptions.limit !== undefined &&
        (typeof commonOptions.limit !== "number" ||
          !Number.isFinite(commonOptions.limit) ||
          commonOptions.limit < 1)
      ) {
        errors.push("'commonOptions.limit' must be a positive number when present");
      }
      for (const field of ["includeDomains", "excludeDomains"] as const) {
        const value = commonOptions[field];
        if (
          value !== undefined &&
          (!Array.isArray(value) || value.some((domain) => typeof domain !== "string"))
        ) {
          errors.push(`'commonOptions.${field}' must be an array of strings when present`);
        }
      }
      if (commonOptions.timeRange !== undefined && typeof commonOptions.timeRange !== "string") {
        errors.push("'commonOptions.timeRange' must be a string when present");
      }
      if (
        commonOptions.includeContent !== undefined &&
        typeof commonOptions.includeContent !== "boolean"
      ) {
        errors.push("'commonOptions.includeContent' must be a boolean when present");
      }
    }
  }

  if (errors.length > 0) throw new BatchInputError(errors);
}

/**
 * Read and validate a batch input JSONL file. Every non-empty line is one JSON
 * object; a malformed or contract-violating record rejects the whole run with
 * the offending line numbers before anything executes.
 */
export async function readBatchInput(inputPath: string): Promise<BatchInputRecord[]> {
  let content: string;
  try {
    content = await fs.promises.readFile(inputPath, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read batch input file ${inputPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const records: BatchInputRecord[] = [];
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const prefix = `line ${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${prefix}: invalid JSON`);
      continue;
    }
    try {
      validateBatchInput(parsed);
    } catch (error) {
      const messages =
        error instanceof BatchInputError ? error.errors : [String((error as Error).message)];
      for (const message of messages) errors.push(`${prefix}: ${message}`);
      continue;
    }
    records.push(parsed);
  }

  if (errors.length > 0) throw new BatchInputError(errors);
  return records;
}

/**
 * Append one output record to the batch output JSONL. Append-only: each record
 * is one complete line, so the file stays resumable across interruptions.
 */
export async function appendBatchOutput(
  outputPath: string,
  record: BatchOutputRecord
): Promise<void> {
  await fs.promises.appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
}

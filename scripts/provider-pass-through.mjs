#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ALLOWED_STATUSES = [
  "pass",
  "fail",
  "blocked_missing_secret",
  "blocked_provider",
  "not_run",
  "waived_by_user",
];

const EVIDENCE_INVENTORY_SCHEMA_VERSION = 2;

export const REQUIRED_PROVIDER_PATHS = [
  { provider: "tavily", path: "search" },
  { provider: "tavily", path: "extract" },
  { provider: "tavily", path: "crawl" },
  { provider: "firecrawl", path: "search" },
  { provider: "firecrawl", path: "extract" },
  { provider: "firecrawl", path: "crawl" },
  { provider: "exa", path: "search" },
  { provider: "exa", path: "extract" },
  { provider: "exa", path: "crawl" },
  { provider: "brave", path: "search" },
  { provider: "serper", path: "search" },
  { provider: "jina", path: "extract" },
  { provider: "searxng", path: "search" },
];

/** All implemented normalized paths; some paid/provider-specific paths remain
 * visible in coverage while deliberately lacking a routine native fixture. */
export const SUPPORTED_PROVIDER_PATHS = [
  ...REQUIRED_PROVIDER_PATHS,
  { provider: "brightdata", path: "search" },
  { provider: "brightdata", path: "extract" },
];

/**
 * Complete catalogued provider-tool inventory. Only rows listed in
 * RUNNABLE_PROVIDER_TOOLS have a native fixture today; all other catalogued
 * rows remain visible as `not_run` instead of disappearing from coverage.
 * IDs use the registry keys from src/registry/tool-profiles.ts.
 */
export const REQUIRED_PROVIDER_TOOLS = [
  { provider: "exa", tool: "search" },
  { provider: "exa", tool: "contents" },
  { provider: "exa", tool: "findSimilar" },
  { provider: "exa", tool: "answer" },
  { provider: "tavily", tool: "search" },
  { provider: "tavily", tool: "extract" },
  { provider: "tavily", tool: "crawl" },
  { provider: "tavily", tool: "map" },
  { provider: "tavily", tool: "research" },
  { provider: "tavily", tool: "answer" },
  { provider: "firecrawl", tool: "search" },
  { provider: "firecrawl", tool: "scrape" },
  { provider: "firecrawl", tool: "crawl" },
  { provider: "firecrawl", tool: "map" },
  { provider: "firecrawl", tool: "extract" },
  { provider: "brave", tool: "webSearch" },
  { provider: "brave", tool: "llmContext" },
  { provider: "brave", tool: "answers" },
  { provider: "serper", tool: "search" },
  { provider: "jina", tool: "reader" },
  { provider: "jina", tool: "embeddings" },
  { provider: "jina", tool: "rerank" },
  { provider: "searxng", tool: "search" },
  { provider: "brightdata", tool: "serp" },
  { provider: "brightdata", tool: "unlocker" },
  { provider: "brightdata", tool: "datasetsList" },
  { provider: "brightdata", tool: "datasetMetadata" },
  { provider: "brightdata", tool: "scrape" },
  { provider: "brightdata", tool: "trigger" },
  { provider: "brightdata", tool: "progress" },
  { provider: "brightdata", tool: "snapshotMetadata" },
  { provider: "brightdata", tool: "cancel" },
  { provider: "brightdata", tool: "snapshot" },
  { provider: "brightdata", tool: "crawl" },
  { provider: "brightdata", tool: "discover" },
];

/** Rows with both a native provider call and ColdSearch input fixture. */
export const RUNNABLE_PROVIDER_TOOLS = [
  { provider: "tavily", tool: "map" },
  { provider: "brave", tool: "webSearch" },
  { provider: "exa", tool: "contents" },
  { provider: "firecrawl", tool: "map" },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const defaultOutDir = path.join(
  repoRoot,
  "plans",
  "evidence",
  "2026-06-23-provider-pass-through"
);

const SEARCH_QUERY = "openai";
const EXTRACT_URL = "https://example.com";
const TAVILY_EXTRACT_URL = "https://docs.tavily.com";
const CRAWL_URL = "https://docs.tavily.com";
const CRAWL_LIMIT = 3;

const KEY_ENV_BY_PROVIDER = {
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_API_KEY",
  serper: "SERPER_API_KEY",
  brightdata: "BRIGHTDATA_API_KEY",
};

const SECRET_ENV_NAMES = [
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "EXA_API_KEY",
  "BRAVE_API_KEY",
  "SERPER_API_KEY",
  "BRIGHTDATA_API_KEY",
  "SEARXNG_BASE_URL",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "ISOQUANT_API_KEY",
  "DOPPLER_TOKEN",
];

const SENSITIVE_FIELD_PATTERN =
  /(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|credential|password|secret|signature|bearer|cookie|^token$|^key$)/i;
const EVIDENCE_SCHEMA_VALUE_FIELDS = new Set([
  "id",
  "kind",
  "path",
  "provider",
  "safe_key_ref",
  "source",
  "status",
  "tool",
  "truncated",
  "type",
]);

class ProviderHttpError extends Error {
  constructor(message, status, bodySample) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.bodySample = bodySample;
  }
}

export function selectTargets({ provider, path: capabilityPath, tool } = {}) {
  if (tool) {
    const selected = REQUIRED_PROVIDER_TOOLS.filter((target) => {
      if (provider && target.provider !== provider) return false;
      return target.tool === tool;
    });
    if (selected.length === 0) {
      const providerPart = provider ? `provider=${provider}` : "provider=*";
      throw new Error(`No conformance target matches ${providerPart} tool=${tool}`);
    }
    return selected.map((target) => ({ ...target, kind: "tool" }));
  }

  const selected = SUPPORTED_PROVIDER_PATHS.filter((target) => {
    if (provider && target.provider !== provider) return false;
    if (capabilityPath && target.path !== capabilityPath) return false;
    return true;
  });

  // Provider-only and --all selections also cover the catalogued provider tools
  // of that provider. A scoped path selection stays path-only.
  if (!capabilityPath) {
    for (const toolTarget of REQUIRED_PROVIDER_TOOLS) {
      if (provider && toolTarget.provider !== provider) continue;
      selected.push({ ...toolTarget, kind: "tool" });
    }
  }

  if (selected.length === 0) {
    const providerPart = provider ? `provider=${provider}` : "provider=*";
    const pathPart = capabilityPath ? `path=${capabilityPath}` : "path=*";
    const hint = capabilityPath && REQUIRED_PROVIDER_TOOLS.some(
      (target) => target.tool === capabilityPath && (!provider || target.provider === provider)
    )
      ? `; a provider tool named '${capabilityPath}' exists — use --tool ${capabilityPath}`
      : "";
    throw new Error(`No Gate 0 target matches ${providerPart} ${pathPart}${hint}`);
  }

  return selected.map((target) => ({ ...target }));
}

function parseArgs(argv) {
  const options = {
    all: false,
    provider: undefined,
    path: undefined,
    tool: undefined,
    outDir: defaultOutDir,
    waivers: new Set(),
    list: false,
    help: false,
    overwriteBaseline: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--all":
        options.all = true;
        break;
      case "--provider":
        options.provider = requiredValue(argv, ++i, arg);
        break;
      case "--path":
        options.path = requiredValue(argv, ++i, arg);
        break;
      case "--tool":
        options.tool = requiredValue(argv, ++i, arg);
        break;
      case "--out-dir":
        options.outDir = path.resolve(repoRoot, requiredValue(argv, ++i, arg));
        break;
      case "--waive":
        options.waivers.add(requiredValue(argv, ++i, arg));
        break;
      case "--list":
        options.list = true;
        break;
      case "--overwrite-baseline":
        options.overwriteBaseline = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.all && !options.provider && !options.path && !options.tool && !options.list && !options.help) {
    options.all = true;
  }

  if (options.all && (options.provider || options.path || options.tool)) {
    throw new Error("--all cannot be combined with --provider, --path, or --tool");
  }

  if (options.path && options.tool) {
    throw new Error("--path and --tool cannot be combined");
  }

  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Gate 0 provider pass-through proof harness

Usage:
  node scripts/provider-pass-through.mjs --all --overwrite-baseline
  node scripts/provider-pass-through.mjs --provider firecrawl --path search --out-dir <dir>
  node scripts/provider-pass-through.mjs --provider jina --path extract --out-dir <dir>
  node scripts/provider-pass-through.mjs --provider tavily --tool map --out-dir <dir>

Options:
  --all                 Run runnable rows and disclose unsupported fixtures as not_run
  --provider NAME       Run one provider, or combine with --path/--tool
  --path NAME           Run one capability path: search, extract, crawl
  --tool NAME           Run one catalogued provider tool (e.g. tavily.map
                        via --tool map); runs through the 'tool call' CLI path
  --out-dir DIR         Evidence output directory (scoped/live runs must use a
                        non-baseline directory; the committed Gate 0 baseline
                        evidence directory is protected)
  --waive provider:path or provider.tool
                        Mark a row waived_by_user without running it
  --list                Print the supported provider/path and catalogued tool
                        matrix as JSON
  --overwrite-baseline  Allow writing to the committed Gate 0 baseline evidence
                        directory (requires --all; only for deliberately
                        regenerating the full baseline)
`);
}

function missingRequirement(target) {
  if (target.provider === "jina") return null;

  if (target.provider === "searxng") {
    return process.env.SEARXNG_BASE_URL ? null : "SEARXNG_BASE_URL";
  }

  const envName = KEY_ENV_BY_PROVIDER[target.provider];
  if (!envName) return null;
  return process.env[envName] ? null : envName;
}

function providerKey(target) {
  return process.env[KEY_ENV_BY_PROVIDER[target.provider]] || "";
}

function extractUrlForTarget(target) {
  return target.provider === "tavily" ? TAVILY_EXTRACT_URL : EXTRACT_URL;
}

const TOOL_INPUTS = {
  "tavily.map": () => ({ url: CRAWL_URL, limit: CRAWL_LIMIT }),
  "brave.webSearch": () => ({ q: SEARCH_QUERY, count: 10 }),
  "exa.contents": () => ({ urls: [EXTRACT_URL], text: true }),
  "firecrawl.map": () => ({ url: CRAWL_URL, limit: CRAWL_LIMIT }),
};

function inputForTarget(target) {
  if (target.tool) {
    const toolInput = TOOL_INPUTS[`${target.provider}.${target.tool}`];
    if (!toolInput) {
      throw new Error(
        `No tool input defined for ${target.provider}.${target.tool}; add a TOOL_INPUTS entry for it`
      );
    }
    return toolInput();
  }
  if (target.path === "search") {
    return { query: SEARCH_QUERY };
  }
  if (target.path === "extract") {
    const url = extractUrlForTarget(target);
    if (url !== EXTRACT_URL) {
      return {
        url,
        fallback_for: EXTRACT_URL,
        reason: "provider rejects the default extract URL",
      };
    }
    return { url };
  }
  return { url: CRAWL_URL, limit: CRAWL_LIMIT };
}

function hasRunnableFixture(target) {
  const inventory = target.tool ? RUNNABLE_PROVIDER_TOOLS : REQUIRED_PROVIDER_PATHS;
  return inventory.some((entry) => targetId(entry) === targetId(target));
}

function evidenceInput(target) {
  return hasRunnableFixture(target)
    ? inputForTarget(target)
    : { unavailable: "no native conformance fixture" };
}

function normalizedUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value);
    url.hash = "";
    const pathname = url.pathname.endsWith("/") && url.pathname !== "/"
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return `${url.protocol}//${url.hostname.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function normalizedTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function textLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function truncate(value, max = 240) {
  if (typeof value !== "string") return value;
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function secretValues() {
  return SECRET_ENV_NAMES.map((name) => process.env[name]).filter(
    // Generic redaction avoids replacing short words in arbitrary text.
    // Evidence and error boundaries opt in while preserving schema/status fields.
    (value) => typeof value === "string" && value.length >= 8
  );
}

function redactString(value, { includeShortSecrets = false } = {}) {
  if (typeof value !== "string") return value;
  let result = value;
  const secrets = includeShortSecrets
    ? SECRET_ENV_NAMES.map((name) => process.env[name]).filter((secret) => typeof secret === "string" && secret.length > 0)
    : secretValues();
  for (const secret of secrets) {
    result = result.split(secret).join("REDACTED");
  }
  return result
    .replace(/([?&](?:jwt|redir_token|access_token|auth_token|api_key|apikey|client_secret|credential|key|password|sessionid|signature|sig|token|x-amz-credential|x-amz-security-token|x-amz-signature)=)[^&#"'\s]+/gi, "$1REDACTED")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED")
    .replace(/(X-API-KEY["':\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED")
    .replace(/(X-Subscription-Token["':\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED");
}

export function redact(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_FIELD_PATTERN.test(key) ? "REDACTED" : redact(entry),
      ])
    );
  }
  return value;
}

function redactEvidenceValue(value, fieldName = "") {
  if (typeof value === "string") {
    return redactString(value, {
      includeShortSecrets: !EVIDENCE_SCHEMA_VALUE_FIELDS.has(fieldName),
    });
  }
  if (Array.isArray(value)) return value.map((item) => redactEvidenceValue(item, fieldName));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_FIELD_PATTERN.test(key) ? "REDACTED" : redactEvidenceValue(entry, key),
      ])
    );
  }
  return value;
}

/** Safe text boundary for CLI errors that may be copied into CI summaries. */
export function redactSensitiveText(value) {
  return redactString(String(value ?? ""), { includeShortSecrets: true });
}

const MAX_RAW_EVIDENCE_BYTES = 12_000;
const MAX_RAW_RESULT_SCHEMA_ITEMS = 50;
const STABLE_RAW_METADATA_FIELDS = {
  "tavily.map": [{ name: "base_url" }],
  "firecrawl.map": [
    { name: "success" },
    { name: "metadata", preserveObjectFields: true },
  ],
  "brave.webSearch": [{ name: "query", preserveObjectFields: true }],
  "exa.contents": [{ name: "statuses", preserveArrayItemFields: true }],
};
const TOOL_RAW_RESULT_ARRAYS = {
  "tavily.map": [{ name: "results", path: ["results"], itemTypes: ["string"] }],
  "brave.webSearch": [{ name: "results", path: ["web", "results"], itemTypes: ["object"] }],
  "exa.contents": [{ name: "results", path: ["results"], itemTypes: ["object"] }],
  "firecrawl.map": [
    { name: "links", path: ["links"], itemTypes: ["string", "object"] },
    { name: "data", path: ["data"], itemTypes: ["string", "object"] },
  ],
};
const RAW_RESULT_LOCATION = Symbol("rawResultLocation");

function rawSchemaShape(value, budget, depth = 0) {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return { type: "truncated" };
  }
  budget.remaining -= 1;

  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const items = value.slice(0, 3).map((entry) => rawSchemaShape(entry, budget, depth + 1));
    if (value.length > items.length) budget.truncated = true;
    return {
      type: "array",
      items,
      ...(value.length > items.length ? { items_truncated: true } : {}),
    };
  }
  if (typeof value !== "object") return { type: typeof value };
  if (depth >= 5) {
    budget.truncated = true;
    return { type: "object", fields_truncated: true };
  }

  const entries = Object.entries(value)
    .filter(([key]) => !SENSITIVE_FIELD_PATTERN.test(key) && /^[A-Za-z0-9_-]{1,64}$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right));
  const fields = {};
  let lastCapturedField = null;
  for (const [key, entry] of entries.slice(0, 40)) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    fields[key] = rawSchemaShape(entry, budget, depth + 1);
    lastCapturedField = key;
  }
  const fieldsTruncated = entries.length > Object.keys(fields).length;
  if (fieldsTruncated) budget.truncated = true;
  return {
    type: "object",
    fields,
    ...(fieldsTruncated
      ? { fields_truncated: true, fields_truncated_after: lastCapturedField }
      : {}),
  };
}

function boundedRawEvidence(raw, target) {
  // Persist shape only. Provider response values can contain credentials in
  // fields the harness does not know about, so redaction by field-name alone
  // is not a safe boundary for raw response samples.
  const budget = { remaining: 120, truncated: false };
  const shape = rawSchemaShape(raw, budget);
  const stable = {};
  const stableMetadata = STABLE_RAW_METADATA_FIELDS[targetId(target)] || [];
  for (const { name } of stableMetadata) {
    if (!raw || typeof raw !== "object" || !Object.hasOwn(raw, name) || SENSITIVE_FIELD_PATTERN.test(name)) {
      continue;
    }
    // A large result array can consume the general budget before stable
    // provider metadata is shaped, so each declared field gets its own budget.
    const stableBudget = { remaining: 80, truncated: false };
    stable[name] = rawSchemaShape(raw[name], stableBudget, 1);
  }
  const resultArrayItemTypes = {};
  const resultArraySchemas = {};
  for (const { name, path } of TOOL_RAW_RESULT_ARRAYS[targetId(target)] || []) {
    let value = raw;
    for (const part of path) value = value && typeof value === "object" ? value[part] : undefined;
    if (Array.isArray(value)) {
      resultArrayItemTypes[name] = [...new Set(value.map((item) =>
        item === null ? "null" : Array.isArray(item) ? "array" : typeof item
      ))].sort();
      resultArraySchemas[name] = boundedRawResultArraySchema(value);
      if (resultArraySchemas[name].truncated) budget.truncated = true;
    }
  }
  const sample = {
    schema: shape,
    stable,
    result_array_item_types: resultArrayItemTypes,
    result_array_schemas: resultArraySchemas,
    truncated: budget.truncated,
  };
  while (Buffer.byteLength(JSON.stringify(sample), "utf8") > MAX_RAW_EVIDENCE_BYTES) {
    sample.truncated = true;
    if (trimRawSchemaShape(sample.schema)) continue;
    const stableKey = Object.keys(sample.stable).at(-1);
    if (stableKey && trimRawSchemaShape(sample.stable[stableKey])) continue;
    if (stableKey) {
      delete sample.stable[stableKey];
      continue;
    }
    const resultArrayKey = Object.keys(sample.result_array_schemas).at(-1);
    if (resultArrayKey && trimRawSchemaShape(sample.result_array_schemas[resultArrayKey])) {
      sample.result_array_schemas[resultArrayKey].truncated = true;
      continue;
    }
    if (resultArrayKey) {
      delete sample.result_array_schemas[resultArrayKey];
      continue;
    }
    if (sample.schema.type !== "object" || !sample.schema.fields_truncated) {
      sample.schema = { type: "object", fields_truncated: true };
    } else {
      break;
    }
  }
  return sample;
}

function trimRawSchemaShape(shape) {
  if (!shape || typeof shape !== "object") return false;
  if (Array.isArray(shape.items) && shape.items.length > 1) {
    shape.items.pop();
    shape.items_truncated = true;
    return true;
  }
  if (shape.fields && typeof shape.fields === "object") {
    const keys = Object.keys(shape.fields).sort((left, right) => left.localeCompare(right));
    if (keys.length) {
      delete shape.fields[keys.at(-1)];
      shape.fields_truncated = true;
      shape.fields_truncated_after = keys.at(-2) ?? null;
      return true;
    }
    for (const key of keys) {
      if (trimRawSchemaShape(shape.fields[key])) return true;
    }
  }
  return false;
}

function boundedRawResultArraySchema(items) {
  const budget = { remaining: 80, truncated: false };
  const shapes = [];
  const shapesBySchema = new Map();
  let inspected = 0;

  for (const item of items) {
    if (inspected >= MAX_RAW_RESULT_SCHEMA_ITEMS) {
      budget.truncated = true;
      break;
    }
    const resultIndex = inspected;
    inspected += 1;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;

    const shape = rawSchemaShape(item, budget, 1);
    if (schemaShapeIsTruncated(shape)) budget.truncated = true;
    if (shape.type !== "object") continue;

    const key = JSON.stringify(shape);
    const existingShape = shapesBySchema.get(key);
    if (!existingShape) {
      shape.result_indexes = [resultIndex];
      shapesBySchema.set(key, shape);
      shapes.push(shape);
    } else {
      existingShape.result_indexes.push(resultIndex);
    }
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
  }

  return { type: "array", items: shapes, truncated: budget.truncated };
}

async function fetchText(url, init = {}, label = "request", timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError(
        `${label} returned HTTP ${response.status}`,
        response.status,
        truncate(redactSensitiveText(body), 500)
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    throw new Error(`${label} failed: ${redactSensitiveText(error.message || String(error))}`);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, init = {}, label = "request", timeoutMs = 60000) {
  const text = await fetchText(url, init, label, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${truncate(text, 500)}`);
  }
}

function jsonPost(body, headers = {}) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function searchItem(item, provider, index) {
  return {
    title: item.title || "",
    url: item.url || item.link || "",
    snippet: item.snippet || item.content || item.description || item.text || "",
    score: typeof item.score === "number"
      ? item.score
      : typeof item.relevance_score === "number"
        ? item.relevance_score
        : Math.max(0.1, 1 - index * 0.1),
    source: provider,
  };
}

function extractItem(item, provider, fallbackUrl) {
  return {
    title: item.title || item.metadata?.title || "",
    url: item.url || item.metadata?.sourceURL || fallbackUrl,
    content: item.content || item.rawContent || item.raw_content || item.markdown || item.text || "",
    source: provider,
  };
}

function crawlItem(item, fallbackUrl) {
  return {
    title: item.title || item.metadata?.title || "",
    url: item.url || item.metadata?.sourceURL || fallbackUrl || "",
    content: item.content || item.rawContent || item.raw_content || item.markdown || item.text || "",
  };
}

function sampleSearch(items) {
  return items.slice(0, 3).map((item) => ({
    title: truncate(item.title, 160),
    url: item.url,
    snippet: truncate(item.snippet, 240),
    score: item.score,
    source: item.source,
  }));
}

function sampleContent(items) {
  return items.slice(0, 3).map((item) => ({
    title: truncate(item.title, 160),
    url: item.url,
    content_length: textLength(item.content),
    content_preview: truncate(item.content, 240),
    source: item.source,
  }));
}

function sampleFromItems(capabilityPath, items) {
  return capabilityPath === "search" ? sampleSearch(items) : sampleContent(items);
}

function sampleToolItems(items) {
  return items.slice(0, 3).map((item) => ({
    title: truncate(item.title, 160),
    url: item.url,
    content_length: textLength(item.content),
    source: item.source,
  }));
}

function makeNativeResult(target, items, metadata = {}) {
  return {
    ok: true,
    result_count: items.length,
    sample: sampleFromItems(target.path, items),
    items,
    ...metadata,
  };
}

function makeNativeToolResult(target, items, metadata = {}) {
  const { raw, ...safeMetadata } = metadata;
  attachRawResultLocations(target, raw, items);
  return {
    ok: true,
    result_count: items.length,
    sample: sampleToolItems(items),
    items,
    raw_available: hasExpectedToolRawShape(target, raw),
    raw_sample: boundedRawEvidence(raw, target),
    ...safeMetadata,
  };
}

function makeColdSearchResult(target, output) {
  if (target.path === "search") {
    const items = Array.isArray(output.results) ? output.results : [];
    return {
      ok: true,
      result_count: items.length,
      sample: sampleSearch(items),
      items,
      providers_used: output.providers_used || [],
    };
  }

  if (target.path === "extract") {
    const result = output.result || {};
    const items = [extractItem(result, result.source || output.provider || target.provider, output.url)]
      .filter((item) => item.content || item.url);
    return {
      ok: true,
      result_count: items.length,
      sample: sampleContent(items),
      items,
      provider: output.provider,
    };
  }

  const items = Array.isArray(output.results) ? output.results : [];
  return {
    ok: true,
    result_count: items.length,
    sample: sampleContent(items),
    items,
    provider: output.provider,
  };
}

async function nativeTavily(target) {
  const apiKey = providerKey(target);
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (target.path === "search") {
    const data = await fetchJson(
      "https://api.tavily.com/search",
      jsonPost({ query: SEARCH_QUERY, search_depth: "basic", include_answer: false }, headers),
      "native Tavily search"
    );
    const items = (data.results || []).map((item, index) => searchItem(item, "tavily", index));
    return makeNativeResult(target, items, {
      native_shape: ["results[].title", "results[].url", "results[].content", "results[].score"],
    });
  }

  if (target.path === "extract") {
    const url = extractUrlForTarget(target);
    const data = await fetchJson(
      "https://api.tavily.com/extract",
      jsonPost({ urls: [url], include_images: false }, headers),
      "native Tavily extract"
    );
    const items = (data.results || []).slice(0, 1).map((item) => extractItem(item, "tavily", url));
    return makeNativeResult(target, items, {
      native_shape: ["results[].title", "results[].url", "results[].rawContent/raw_content"],
    });
  }

  const data = await fetchJson(
    "https://api.tavily.com/crawl",
    jsonPost({ url: CRAWL_URL, limit: CRAWL_LIMIT, extract_depth: "basic" }, headers),
    "native Tavily crawl",
    120000
  );
  const items = (data.results || []).map((item) => crawlItem(item, CRAWL_URL));
  return makeNativeResult(target, items, {
    native_shape: ["results[].title", "results[].url", "results[].rawContent/raw_content"],
  });
}

async function nativeFirecrawl(target) {
  const apiKey = providerKey(target);
  const headers = { Authorization: `Bearer ${apiKey}` };

  if (target.path === "search") {
    const data = await fetchJson(
      "https://api.firecrawl.dev/v2/search",
      jsonPost(
        { query: SEARCH_QUERY, limit: 10, scrapeOptions: { formats: ["markdown"] } },
        headers
      ),
      "native Firecrawl search"
    );
    if (data.success === false || data.error) {
      throw new Error(`native Firecrawl search error: ${data.error || "unknown error"}`);
    }
    const items = (data.data?.web || []).map((item, index) =>
      searchItem(
        {
          title: item.title || item.metadata?.title,
          url: item.url || item.metadata?.sourceURL,
          snippet: item.description || item.metadata?.description || item.markdown,
          score: item.score,
        },
        "firecrawl",
        index
      )
    );
    return makeNativeResult(target, items, {
      native_shape: ["data.web[].title", "data.web[].url", "data.web[].description", "data.web[].markdown"],
    });
  }

  if (target.path === "extract") {
    const url = extractUrlForTarget(target);
    const data = await fetchJson(
      "https://api.firecrawl.dev/v2/scrape",
      jsonPost({ url, formats: ["markdown"] }, headers),
      "native Firecrawl extract"
    );
    if (data.success === false || data.error) {
      throw new Error(`native Firecrawl extract error: ${data.error || "unknown error"}`);
    }
    const items = [extractItem(data.data || {}, "firecrawl", url)];
    return makeNativeResult(target, items, {
      native_shape: ["data.markdown", "data.metadata.title", "data.metadata.sourceURL"],
    });
  }

  const startData = await fetchJson(
    "https://api.firecrawl.dev/v2/crawl",
    jsonPost(
      { url: CRAWL_URL, limit: CRAWL_LIMIT, scrapeOptions: { formats: ["markdown"] } },
      headers
    ),
    "native Firecrawl crawl start"
  );
  if (!startData.success || !startData.id) {
    throw new Error(`native Firecrawl crawl start error: ${startData.error || "no job id"}`);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(2000);
    const statusData = await fetchJson(
      `https://api.firecrawl.dev/v2/crawl/${encodeURIComponent(startData.id)}`,
      { headers },
      "native Firecrawl crawl poll",
      5000
    );

    if (statusData.success === false || statusData.error) {
      throw new Error(`native Firecrawl crawl poll error: ${statusData.error || "unknown error"}`);
    }
    if (statusData.status === "completed" && Array.isArray(statusData.data)) {
      const items = statusData.data.map((item) => crawlItem(item, CRAWL_URL));
      return makeNativeResult(target, items, {
        native_shape: ["data[].markdown", "data[].metadata.title", "data[].metadata.sourceURL"],
      });
    }
    if (statusData.status === "failed") {
      throw new Error(`native Firecrawl crawl failed: ${statusData.error || "unknown error"}`);
    }
  }

  throw new Error("native Firecrawl crawl timed out");
}

async function nativeExa(target) {
  const apiKey = providerKey(target);
  const headers = { "x-api-key": apiKey };

  if (target.path === "search") {
    const data = await fetchJson(
      "https://api.exa.ai/search",
      jsonPost(
        { query: SEARCH_QUERY, numResults: 10, type: "auto", contents: { text: true } },
        headers
      ),
      "native Exa search"
    );
    const items = (data.results || []).map((item, index) => searchItem(item, "exa", index));
    return makeNativeResult(target, items, {
      native_shape: ["results[].title", "results[].url", "results[].text", "results[].score"],
    });
  }

  if (target.path === "extract") {
    const url = extractUrlForTarget(target);
    const data = await fetchJson(
      "https://api.exa.ai/contents",
      jsonPost({ urls: [url], text: true }, headers),
      "native Exa extract"
    );
    const items = (data.results || []).slice(0, 1).map((item) => extractItem(item, "exa", url));
    return makeNativeResult(target, items, {
      native_shape: ["results[].title", "results[].url", "results[].text"],
    });
  }

  const domain = new URL(CRAWL_URL).hostname;
  const searchData = await fetchJson(
    "https://api.exa.ai/search",
    jsonPost(
      { query: `site:${domain}`, numResults: CRAWL_LIMIT, type: "auto" },
      headers
    ),
    "native Exa crawl discover"
  );
  const candidateUrls = [
    CRAWL_URL,
    ...(searchData.results || []).map((result) => result.url).filter(Boolean),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index).slice(0, CRAWL_LIMIT);

  const contents = await fetchJson(
    "https://api.exa.ai/contents",
    jsonPost(
      {
        urls: candidateUrls,
        text: { maxCharacters: 12000 },
        livecrawl: "preferred",
        livecrawlTimeout: 10000,
      },
      headers
    ),
    "native Exa crawl contents"
  );
  const items = (contents.results || []).map((item) => crawlItem(item, CRAWL_URL));
  return makeNativeResult(target, items, {
    native_shape: ["search results discovery", "contents results[].title/url/text"],
    synthesized_crawl: true,
  });
}

async function nativeBrave(target) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", SEARCH_QUERY);
  url.searchParams.set("count", "10");
  url.searchParams.set("offset", "0");

  const data = await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": providerKey(target),
      },
    },
    "native Brave search"
  );
  const items = (data.web?.results || []).map((item, index) => searchItem(item, "brave", index));
  return makeNativeResult(target, items, {
    native_shape: ["web.results[].title", "web.results[].url", "web.results[].description"],
  });
}

async function nativeSerper(target) {
  const data = await fetchJson(
    "https://google.serper.dev/search",
    jsonPost(
      { q: SEARCH_QUERY, num: 10 },
      { "X-API-KEY": providerKey(target) }
    ),
    "native Serper search"
  );
  const items = (data.organic || []).map((item, index) =>
    searchItem(
      {
        title: item.title,
        url: item.link,
        snippet: item.snippet,
        score: item.position && item.position > 0 ? 1 / item.position : undefined,
      },
      "serper",
      index
    )
  );
  return makeNativeResult(target, items, {
    native_shape: ["organic[].title", "organic[].link", "organic[].snippet", "organic[].position"],
  });
}

async function nativeJina(target) {
  const url = extractUrlForTarget(target);
  const content = await fetchText(
    `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`,
    { headers: { Accept: "text/plain" } },
    "native Jina extract"
  );
  const lines = content.split("\n");
  const title = lines[0]?.startsWith("Title:")
    ? lines[0].replace("Title:", "").trim()
    : "";
  const body = title ? lines.slice(1).join("\n").trim() : content;
  const items = [{ title, url, content: body, source: "jina" }];
  return makeNativeResult(target, items, {
    native_shape: ["text/plain reader response"],
  });
}

async function nativeSearXNG(target) {
  const endpointBase = new URL(process.env.SEARXNG_BASE_URL);
  endpointBase.pathname = endpointBase.pathname.endsWith("/")
    ? endpointBase.pathname
    : `${endpointBase.pathname}/`;
  const url = new URL("search", endpointBase);
  url.searchParams.set("q", SEARCH_QUERY);
  url.searchParams.set("format", "json");

  const data = await fetchJson(url.toString(), {}, "native SearXNG search");
  const items = (data.results || []).map((item, index) => searchItem(item, "searxng", index));
  return makeNativeResult(target, items, {
    native_shape: ["results[].title", "results[].url", "results[].content", "results[].score"],
  });
}

async function nativeTavilyMap(target) {
  const data = await fetchJson(
    "https://api.tavily.com/map",
    jsonPost(
      { url: CRAWL_URL, limit: CRAWL_LIMIT },
      { Authorization: `Bearer ${providerKey(target)}` }
    ),
    "native Tavily map"
  );
  // Tavily Map returns discovered URLs under `results` (matches the substrate
  // map summary, which counts raw.results).
  const items = (data.results || []).map((url) => ({ title: "", url, content: "", source: "tavily" }));
  return makeNativeToolResult(target, items, {
    native_shape: ["results[]"],
    raw: data,
  });
}

async function nativeBraveWebSearch(target) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", SEARCH_QUERY);
  url.searchParams.set("count", "10");
  const data = await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": providerKey(target),
      },
    },
    "native Brave webSearch"
  );
  const items = (data.web?.results || []).map((item, index) => searchItem(item, "brave", index));
  return makeNativeToolResult(target, items, {
    native_shape: ["web.results[].title", "web.results[].url", "web.results[].description"],
    raw: data,
  });
}

async function nativeExaContents(target) {
  const data = await fetchJson(
    "https://api.exa.ai/contents",
    jsonPost({ urls: [EXTRACT_URL], text: true }, { "x-api-key": providerKey(target) }),
    "native Exa contents"
  );
  const items = (data.results || []).map((item) => extractItem(item, "exa", EXTRACT_URL));
  return makeNativeToolResult(target, items, {
    native_shape: ["results[].title", "results[].url", "results[].text"],
    raw: data,
  });
}

async function nativeFirecrawlMap(target) {
  const data = await fetchJson(
    "https://api.firecrawl.dev/v2/map",
    jsonPost({ url: CRAWL_URL, limit: CRAWL_LIMIT }, { Authorization: `Bearer ${providerKey(target)}` }),
    "native Firecrawl map"
  );
  if (data.success === false || data.error) {
    throw new Error(`native Firecrawl map error: ${data.error || "unknown error"}`);
  }
  const links = data.links || data.data || [];
  const items = firecrawlMapItems(links);
  return makeNativeToolResult(target, items, {
    native_shape: ["links[]"],
    raw: data,
  });
}

const nativeRunners = {
  tavily: nativeTavily,
  firecrawl: nativeFirecrawl,
  exa: nativeExa,
  brave: nativeBrave,
  serper: nativeSerper,
  jina: nativeJina,
  searxng: nativeSearXNG,
};

const nativeToolRunners = {
  "tavily.map": nativeTavilyMap,
  "brave.webSearch": nativeBraveWebSearch,
  "exa.contents": nativeExaContents,
  "firecrawl.map": nativeFirecrawlMap,
};

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll("\\", "/"));
}

function buildColdSearchConfig(target, usagePath) {
  const envName = KEY_ENV_BY_PROVIDER[target.provider];
  const keys = envName ? `["env:${envName}"]` : "[]";
  const providerOptions = target.provider === "searxng"
    ? `
[providers.searxng.options]
baseUrl = ${tomlString(process.env.SEARXNG_BASE_URL)}
`
    : "";

  return `
[capabilities.${target.path}]
providers = ["${target.provider}"]
strategy = "all"

[providers.${target.provider}]
${providerOptions}
[providers.${target.provider}.keyPool]
keys = ${keys}
strategy = "round-robin"

[cache]
enabled = false

[logging.usage]
path = ${tomlString(usagePath)}
`.trim();
}

function buildColdSearchToolConfig(target, usagePath) {
  const envName = KEY_ENV_BY_PROVIDER[target.provider];
  const keys = envName ? `["env:${envName}"]` : "[]";

  return `
[providers.${target.provider}]
[providers.${target.provider}.keyPool]
keys = ${keys}
strategy = "round-robin"

[cache]
enabled = false

[logging.usage]
path = ${tomlString(usagePath)}
`.trim();
}

function coldSearchArgs(target, configPath) {
  const args = [
    cliPath,
    target.path,
    "--config",
    configPath,
    "--providers",
    target.provider,
    "--single-provider",
    "--json",
  ];

  if (target.path === "search") {
    return [...args, "--no-cache", "--limit", "10", SEARCH_QUERY];
  }
  if (target.path === "extract") {
    return [...args, "--no-cache", extractUrlForTarget(target)];
  }
  return [...args, "--limit", String(CRAWL_LIMIT), CRAWL_URL];
}

function runColdSearch(target, outDir) {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`dist/cli.js not found at ${cliPath}; run npm run build first`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-gate0-"));
  try {
    const configPath = path.join(dir, "config.toml");
    const usagePath = path.join(outDir, "coldsearch-usage.jsonl");
    fs.writeFileSync(configPath, buildColdSearchConfig(target, usagePath), "utf8");

    const result = spawnSync(process.execPath, coldSearchArgs(target, configPath), {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      timeout: target.path === "crawl" ? 180000 : 90000,
    });

    if (result.status !== 0) {
      throw new Error(
        `ColdSearch exited ${result.status}: ${truncate(redactSensitiveText(result.stderr || result.stdout || "(no output)"), 1000)}`
      );
    }

    try {
      return makeColdSearchResult(target, JSON.parse(result.stdout));
    } catch {
      throw new Error(`ColdSearch output was not JSON: ${truncate(result.stdout, 500)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runColdSearchTool(target, outDir) {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`dist/cli.js not found at ${cliPath}; run npm run build first`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coldsearch-gate0-"));
  try {
    const configPath = path.join(dir, "config.toml");
    const usagePath = path.join(outDir, "coldsearch-usage.jsonl");
    fs.writeFileSync(configPath, buildColdSearchToolConfig(target, usagePath), "utf8");

    const args = [
      cliPath,
      "tool",
      "call",
      `${target.provider}.${target.tool}`,
      "--json-input",
      JSON.stringify(inputForTarget(target)),
      "--config",
      configPath,
      "--json",
      "--no-cache",
    ];

    const result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
      timeout: 120000,
    });

    if (result.status !== 0) {
      throw new Error(
        `ColdSearch tool call exited ${result.status}: ${truncate(redactSensitiveText(result.stderr || result.stdout || "(no output)"), 1000)}`
      );
    }

    try {
      return makeColdSearchToolResult(target, JSON.parse(result.stdout));
    } catch {
      throw new Error(`ColdSearch tool call output was not JSON: ${truncate(result.stdout, 500)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function toolRawItems(target, raw) {
  switch (`${target.provider}.${target.tool}`) {
    case "tavily.map":
      // Tavily Map puts discovered URLs under `results` (matches substrate).
      return (raw.results || []).map((url) => ({ title: "", url, content: "", source: "tavily" }));
    case "firecrawl.map":
      return firecrawlMapItems(raw.links || raw.data || []);
    case "brave.webSearch":
      return (raw.web?.results || []).map((item, index) => searchItem(item, "brave", index));
    case "exa.contents":
      return (raw.results || []).map((item) => extractItem(item, "exa", EXTRACT_URL));
    default:
      return [];
  }
}

function attachRawResultLocations(target, raw, items) {
  const attach = (item, arrayName, resultIndex) => {
    if (!item || typeof item !== "object") return;
    Object.defineProperty(item, RAW_RESULT_LOCATION, {
      value: { arrayName, resultIndex },
      configurable: true,
    });
  };

  switch (targetId(target)) {
    case "brave.webSearch":
      (raw?.web?.results || []).forEach((_, index) => attach(items[index], "results", index));
      break;
    case "exa.contents":
      (raw?.results || []).forEach((_, index) => attach(items[index], "results", index));
      break;
    case "firecrawl.map": {
      const arrayName = Array.isArray(raw?.links) ? "links" : Array.isArray(raw?.data) ? "data" : null;
      const rawItems = arrayName ? raw[arrayName] : [];
      let itemIndex = 0;
      rawItems.forEach((rawItem, resultIndex) => {
        if (firecrawlMapItems([rawItem]).length === 0) return;
        attach(items[itemIndex], arrayName, resultIndex);
        itemIndex += 1;
      });
      break;
    }
    default:
      break;
  }
}

function firecrawlMapItems(links) {
  if (!Array.isArray(links)) return [];
  return links.flatMap((link) => {
    const url = typeof link === "string" ? link : link?.url;
    if (typeof url !== "string" || !url.trim()) return [];
    return [{
      title: typeof link === "object" && typeof link.title === "string" ? link.title : "",
      url,
      content: typeof link === "object" && typeof link.description === "string"
        ? link.description
        : "",
      source: "firecrawl",
    }];
  });
}

function hasExpectedToolRawShape(target, raw) {
  if (!raw || typeof raw !== "object") return false;
  switch (targetId(target)) {
    case "tavily.map":
      return Array.isArray(raw.results);
    case "brave.webSearch":
      return Array.isArray(raw.web?.results);
    case "exa.contents":
      return Array.isArray(raw.results);
    case "firecrawl.map":
      return Array.isArray(raw.links) || Array.isArray(raw.data);
    default:
      return false;
  }
}

export function makeColdSearchToolResult(target, output) {
  const raw = output.raw && typeof output.raw === "object" ? output.raw : {};
  const items = toolRawItems(target, raw);
  attachRawResultLocations(target, raw, items);
  return {
    ok: output.ok === true,
    catalogued: output.catalogued === true,
    result_count: items.length,
    sample: sampleToolItems(items),
    items,
    provider: output.provider,
    tool: output.tool,
    meta: output.meta && typeof output.meta === "object" ? output.meta : null,
    // Keep provider response shape for comparison without persisting payload
    // values that could contain credentials in unrecognized fields.
    raw_available: hasExpectedToolRawShape(target, raw),
    raw_sample: boundedRawEvidence(raw, target),
  };
}

function compareTarget(target, nativeResult, coldResult) {
  const checks = [];
  const notes = [];
  const detailLoss = [];

  checks.push(check(nativeResult.result_count > 0, "native returned non-empty results"));
  checks.push(check(coldResult.result_count > 0, "ColdSearch returned non-empty results"));

  if (target.path === "search") {
    const first = coldResult.items[0] || {};
    for (const field of ["title", "url", "snippet", "score", "source"]) {
      checks.push(check(field in first, `ColdSearch search result has ${field}`));
    }
    checks.push(check(
      coldResult.items.every((item) => item.source === target.provider),
      "ColdSearch preserves provider source on search rows"
    ));
    checks.push(check(hasUrlOrTitleOverlap(nativeResult.items, coldResult.items), "native and ColdSearch overlap by URL or title"));
    detailLoss.push("ColdSearch search output keeps title, url, snippet, score, source; raw provider-only fields are not exposed in the normalized result.");
  } else if (target.path === "extract") {
    const nativeItem = nativeResult.items[0] || {};
    const coldItem = coldResult.items[0] || {};
    checks.push(check(textLength(nativeItem.content) > 0, "native extract content is non-empty"));
    checks.push(check(textLength(coldItem.content) > 0, "ColdSearch extract content is non-empty"));
    checks.push(check(normalizedUrl(nativeItem.url) === normalizedUrl(coldItem.url), "ColdSearch preserves extracted URL identity"));
    checks.push(check(coldItem.source === target.provider, "ColdSearch preserves provider source on extract result"));
    if (nativeItem.title) {
      checks.push(check(Boolean(coldItem.title), "ColdSearch preserves title when native provides one"));
    }
    detailLoss.push("ColdSearch extract output keeps content, url, title, source; raw provider metadata is not exposed in the normalized result.");
  } else {
    checks.push(check(coldResult.provider === target.provider, "ColdSearch crawl output names selected provider"));
    checks.push(check(
      nativeResult.items.some((item) => textLength(item.content) > 0),
      "native crawl includes at least one page with content"
    ));
    checks.push(check(
      coldResult.items.some((item) => textLength(item.content) > 0),
      "ColdSearch crawl includes at least one page with content"
    ));
    checks.push(check(hasUrlOverlap(nativeResult.items, coldResult.items), "native and ColdSearch crawl rows overlap by URL"));
    detailLoss.push("ColdSearch crawl output keeps url, title, content and top-level provider; raw provider crawl job metadata is not exposed.");
    if (target.provider === "exa") {
      notes.push("Exa crawl is synthesized by search discovery plus contents/livecrawl, not a native crawl endpoint.");
    }
  }

  const passed = checks.every((item) => item.pass);
  return { passed, checks, notes, detail_loss: detailLoss };
}

export function compareToolTarget(target, nativeResult, coldResult) {
  const checks = [];
  const notes = [];
  const detailLoss = [];
  const resultsVary = toolResultsVary(nativeResult.items, coldResult.items);
  const configuredKeyEnv = KEY_ENV_BY_PROVIDER[target.provider];
  const expectedSafeKeyRef = configuredKeyEnv ? `env:${configuredKeyEnv}` : null;

  checks.push(check(nativeResult.result_count > 0, "native returned non-empty results"));
  checks.push(check(coldResult.ok, "ColdSearch tool call succeeded"));
  checks.push(check(
    coldResult.provider === target.provider,
    "ColdSearch tool result names the selected provider"
  ));
  checks.push(check(
    coldResult.tool === target.tool,
    "ColdSearch tool result names the selected tool"
  ));
  checks.push(check(
    coldResult.meta &&
      Number.isFinite(coldResult.meta.duration_ms) &&
      coldResult.meta.safe_key_ref === expectedSafeKeyRef &&
      Array.isArray(coldResult.meta.warnings),
    "ColdSearch tool result includes its metadata envelope"
  ));
  checks.push(check(coldResult.result_count > 0, "ColdSearch tool call returned non-empty raw results"));
  checks.push(check(
    coldResult.items.every((item) => hasMinimumToolIdentity(target, item)),
    "ColdSearch tool results retain minimum provider item identities"
  ));
  checks.push(check(
    toolNativeFieldsPreserved(target, nativeResult.items, coldResult.items),
    "ColdSearch tool output retains populated native fields for overlapping results"
  ));
  checks.push(check(
    nativeResult.raw_available && coldResult.raw_available,
    "native and ColdSearch tool outputs include the expected provider raw response field"
  ));
  checks.push(check(
    compareToolRawSchema(target, nativeResult.raw_sample, coldResult.raw_sample),
    "ColdSearch tool output preserves stable provider raw metadata schema"
  ));
  checks.push(check(
    compareToolRawResultArrayTypes(target, nativeResult.raw_sample, coldResult.raw_sample),
    "native and ColdSearch tool result arrays retain expected item types"
  ));
  // Provider calls run independently. Compare raw result shapes by identity
  // so unmatched live rows are variance, while still checking matched rows.
  const rawArraySchemaComparison = compareToolRawResultArraySchemas(
    target,
    nativeResult.raw_sample,
    coldResult.raw_sample,
    nativeResult.items,
    coldResult.items
  );
  if (rawArraySchemaComparison === null) {
    notes.push("Provider result-array schema comparison was inconclusive because result identities varied or bounded schema evidence was truncated; the sampled shapes do not certify full field preservation.");
  } else {
    checks.push(check(
      rawArraySchemaComparison,
      "ColdSearch tool result arrays preserve sampled native object schemas"
    ));
  }
  checks.push(check(
    coldResult.catalogued,
    "ColdSearch tool call row remained catalogued in the registry"
  ));
  const fixedUrl = FIXED_TARGET_TOOL_URLS[targetId(target)];
  if (fixedUrl) {
    // Exa can return a canonical URL for the requested page. It does not
    // expose reliable redirect metadata, so compare both independent legs'
    // nonempty URL sets instead of requiring each to echo the input string.
    const nativeUrls = new Set((nativeResult.items || []).map((item) => normalizedUrl(item.url)).filter(Boolean));
    const coldUrls = new Set((coldResult.items || []).map((item) => normalizedUrl(item.url)).filter(Boolean));
    checks.push(check(
      nativeUrls.size > 0 &&
        nativeUrls.size === coldUrls.size &&
        [...nativeUrls].every((url) => coldUrls.has(url)),
      "native and ColdSearch results retain the same requested-page URL identity, including a shared canonical URL"
    ));
  }
  if (resultsVary) {
    if (hasUrlOrTitleOverlap(nativeResult.items, coldResult.items)) {
      notes.push("Native and ColdSearch results differed across sequential live calls; unmatched results and count differences are recorded as provider variance.");
    } else {
      notes.push("Native and ColdSearch results had no overlapping URLs or titles across sequential live calls; row-level field preservation could not be compared, and the result-set difference is recorded as provider variance.");
    }
  }
  detailLoss.push("Provider raw response evidence records bounded schema only; values are omitted to avoid persisting unknown credentials.");

  const passed = checks.every((item) => item.pass);
  return { passed, checks, notes, detail_loss: detailLoss };
}

function check(pass, label) {
  return { pass: Boolean(pass), label };
}

function hasMinimumToolIdentity(target, item) {
  switch (targetId(target)) {
    case "brave.webSearch":
      return Boolean(normalizedUrl(item?.url) || normalizedTitle(item?.title));
    case "exa.contents":
    case "firecrawl.map":
    case "tavily.map":
      return Boolean(normalizedUrl(item?.url));
    default:
      return true;
  }
}

function hasUrlOverlap(nativeItems, coldItems) {
  const nativeUrls = new Set(nativeItems.map((item) => normalizedUrl(item.url)).filter(Boolean));
  return coldItems.some((item) => nativeUrls.has(normalizedUrl(item.url)));
}

function compareToolRawSchema(target, nativeSample, coldSample) {
  const nativeFields = nativeSample?.schema?.fields;
  const coldFields = coldSample?.schema?.fields;
  if (!nativeFields || !coldFields) return false;

  // Common fields must have the same broad schema. Keys present on only one
  // side can reflect legitimate changes between separate provider requests.
  for (const key of Object.keys(nativeFields)) {
    if (Object.hasOwn(coldFields, key) && nativeFields[key]?.type !== coldFields[key]?.type) {
      return false;
    }
  }

  // These response envelopes are stable for the same request and carry useful
  // provider-specific metadata. Require their root field and type to survive
  // whenever the native response supplied them.
  const nativeStable = nativeSample?.stable || {};
  const coldStable = coldSample?.stable || {};
  for (const {
    name,
    preserveObjectFields = false,
    preserveArrayItemFields = false,
  } of STABLE_RAW_METADATA_FIELDS[targetId(target)] || []) {
    const nativeField = nativeStable[name];
    const coldField = coldStable[name];
    if (!nativeField) continue;
    if (!coldField || nativeField.type !== coldField.type) return false;
    if (preserveObjectFields && nativeField.type === "object") {
      if (!schemaShapeContains(nativeField, coldField)) return false;
    }
    if (preserveArrayItemFields && nativeField.type === "array") {
      const expectedItems = nativeField.items || [];
      const actualItems = coldField.items || [];
      if (expectedItems.length > 0 && actualItems.length === 0) return false;
      if (!expectedItems.every((expected) => actualItems.some((actual) => schemaShapeContains(expected, actual)))) {
        return false;
      }
    }
  }
  return true;
}

function compareToolRawResultArrayTypes(target, nativeSample, coldSample) {
  const nativeTypesByArray = nativeSample?.result_array_item_types || {};
  const coldTypesByArray = coldSample?.result_array_item_types || {};
  for (const { name, itemTypes } of TOOL_RAW_RESULT_ARRAYS[targetId(target)] || []) {
    const nativeTypes = nativeTypesByArray[name];
    const coldTypes = coldTypesByArray[name];
    if (nativeTypes && !coldTypes) return false;
    if ([nativeTypes, coldTypes].some((types) => types && types.some((type) => !itemTypes.includes(type)))) {
      return false;
    }
  }
  return true;
}

function compareToolRawResultArraySchemas(target, nativeSample, coldSample, nativeItems, coldItems) {
  const nativeTypesByArray = nativeSample?.result_array_item_types || {};
  let inconclusive = false;
  for (const { name } of TOOL_RAW_RESULT_ARRAYS[targetId(target)] || []) {
    if (!nativeTypesByArray[name]?.includes("object")) continue;

    const nativeArray = nativeSample?.result_array_schemas?.[name];
    const coldArray = coldSample?.result_array_schemas?.[name];
    if (!nativeArray || !coldArray) {
      inconclusive = true;
      continue;
    }
    const nativeObjects = nativeArray?.type === "array"
      ? (nativeArray.items || []).filter((item) => item.type === "object")
      : [];
    const coldObjects = coldArray?.type === "array"
      ? (coldArray.items || []).filter((item) => item.type === "object")
      : [];

    if (!nativeObjects.length) {
      inconclusive = true;
      continue;
    }

    const nativeShapesByIndex = indexResultArrayShapes(nativeObjects);
    const coldShapesByIndex = indexResultArrayShapes(coldObjects);
    const nativeItemsByIndex = indexToolItemsByRawResult(nativeItems, name);
    const coldItemsByIndex = indexToolItemsByRawResult(coldItems, name);

    if (!nativeItemsByIndex.size) {
      inconclusive = true;
      continue;
    }

    const consumedColdIndexes = new Set();
    for (const [nativeIndex, expected] of nativeShapesByIndex) {
      const nativeItem = nativeItemsByIndex.get(nativeIndex);
      if (!nativeItem) {
        inconclusive = true;
        continue;
      }

      const matchedColdEntries = [...coldItemsByIndex.entries()]
        .filter(([coldIndex, candidate]) =>
          !consumedColdIndexes.has(coldIndex) && findMatchingToolItem(nativeItem, [candidate])
        )
        .map(([coldIndex]) => {
          const actual = coldShapesByIndex.get(coldIndex);
          const comparison = actual
            ? compareCapturedSchemaShape(expected, actual)
            : coldArray.truncated ? null : false;
          const exactShape = actual && rawResultShapeSignature(expected) === rawResultShapeSignature(actual);
          const preference = comparison === true
            ? (exactShape ? 0 : 1)
            : comparison === null
              ? (exactShape ? 2 : 3)
              : (exactShape ? 4 : 5);
          return { coldIndex, comparison, preference };
        })
        .sort((left, right) => left.preference - right.preference || left.coldIndex - right.coldIndex);
      if (!matchedColdEntries.length) {
        // An unmatched provider result is live variance, not evidence that
        // ColdSearch dropped its provider-specific fields.
        inconclusive = true;
        continue;
      }

      const { coldIndex, comparison: shapeComparison } = matchedColdEntries[0];
      consumedColdIndexes.add(coldIndex);
      if (shapeComparison === false) return false;
      if (shapeComparison === null) inconclusive = true;
    }

    if (nativeArray.truncated || nativeObjects.some(schemaShapeIsTruncated)) {
      inconclusive = true;
    }
    if (coldArray.truncated || coldObjects.some(schemaShapeIsTruncated)) {
      inconclusive = true;
    }
  }
  return inconclusive ? null : true;
}

function indexResultArrayShapes(shapes) {
  const indexed = new Map();
  for (const shape of shapes || []) {
    for (const index of shape.result_indexes || []) indexed.set(index, shape);
  }
  return new Map([...indexed].sort(([left], [right]) => left - right));
}

function indexToolItemsByRawResult(items, arrayName) {
  const indexed = new Map();
  for (const [position, item] of (items || []).entries()) {
    const location = item?.[RAW_RESULT_LOCATION];
    if (location) {
      if (location.arrayName === arrayName) indexed.set(location.resultIndex, item);
      continue;
    }
    // Keep manually constructed comparison fixtures usable; production tool
    // results carry explicit raw-array locations from their provider payload.
    indexed.set(position, item);
  }
  return indexed;
}

function schemaShapeIsTruncated(shape) {
  if (!shape || shape.type === "truncated") return true;
  if (shape.fields_truncated || shape.items_truncated) return true;
  return Boolean(
    (shape.fields && Object.values(shape.fields).some(schemaShapeIsTruncated)) ||
    (shape.items && shape.items.some(schemaShapeIsTruncated))
  );
}

// Returns false only for a proven schema loss, null when captured evidence is
// incomplete, and true when every captured native shape is present in the
// captured ColdSearch shape. A truncated child does not make complete sibling
// fields inconclusive.
function compareCapturedSchemaShape(expected, actual) {
  if (!expected || !actual || expected.type === "truncated" || actual.type === "truncated") {
    return null;
  }
  if (expected.type !== actual.type) return false;

  let inconclusive = Boolean(
    expected.fields_truncated || expected.items_truncated ||
    actual.fields_truncated || actual.items_truncated
  );

  if (expected.type === "object") {
    const expectedFields = expected.fields || {};
    const actualFields = actual.fields || {};
    for (const [key, expectedField] of Object.entries(expectedFields)) {
      const actualField = actualFields[key];
      if (!actualField) {
        if (actual.fields_truncated) {
          const cutoff = actual.fields_truncated_after;
          if (typeof cutoff === "string" && key.localeCompare(cutoff) <= 0) return false;
          inconclusive = true;
          continue;
        }
        return false;
      }

      const comparison = compareCapturedSchemaShape(expectedField, actualField);
      if (comparison === false) return false;
      if (comparison === null) inconclusive = true;
    }
    return inconclusive ? null : true;
  }

  if (expected.type === "array") {
    const expectedItems = expected.items || [];
    const actualItems = actual.items || [];
    for (const expectedItem of expectedItems) {
      let matched = false;
      let possibleMatch = false;
      for (const actualItem of actualItems) {
        const comparison = compareCapturedSchemaShape(expectedItem, actualItem);
        if (comparison === true) {
          matched = true;
          break;
        }
        if (comparison === null) possibleMatch = true;
      }
      if (matched) continue;
      if (possibleMatch || actual.items_truncated) {
        inconclusive = true;
        continue;
      }
      return false;
    }
    return inconclusive ? null : true;
  }

  return inconclusive ? null : true;
}

function rawResultShapeSignature(shape) {
  const schema = { ...shape };
  delete schema.result_indexes;
  return JSON.stringify(schema);
}

function schemaShapeContains(expected, actual) {
  if (!expected || !actual || expected.type !== actual.type) return false;
  if (expected.type === "object") {
    const expectedFields = expected.fields || {};
    const actualFields = actual.fields || {};
    return Object.entries(expectedFields).every(([key, schema]) =>
      schemaShapeContains(schema, actualFields[key])
    );
  }
  if (expected.type === "array") {
    const expectedItems = expected.items || [];
    const actualItems = actual.items || [];
    return expectedItems.every((schema) => actualItems.some((actualItem) => schemaShapeContains(schema, actualItem)));
  }
  return true;
}

function toolResultsVary(nativeItems, coldItems) {
  if ((nativeItems || []).length !== (coldItems || []).length) return true;
  return (nativeItems || []).some((native) => !findMatchingToolItem(native, coldItems)) ||
    (coldItems || []).some((cold) => !findMatchingToolItem(cold, nativeItems));
}

function findMatchingToolItem(item, candidates) {
  const itemUrl = normalizedUrl(item?.url);
  const itemTitle = normalizedTitle(item?.title);
  return (candidates || []).find((candidate) => {
    const candidateUrl = normalizedUrl(candidate?.url);
    if (itemUrl && candidateUrl) return candidateUrl === itemUrl;
    return itemTitle && normalizedTitle(candidate?.title) === itemTitle;
  });
}

function toolNativeFieldsPreserved(target, nativeItems, coldItems) {
  const fields = targetId(target) === "brave.webSearch"
    ? ["title", "url", "snippet"]
    : targetId(target) === "exa.contents"
      ? ["title", "url", "content"]
      : targetId(target) === "firecrawl.map"
        ? ["title", "url", "content"]
        : ["url"];
  const overlapping = (nativeItems || [])
    .map((native) => ({ native, cold: findMatchingToolItem(native, coldItems) }))
    .filter(({ cold }) => cold);
  if (overlapping.length === 0) return true;
  return overlapping.every(({ native, cold }) => {
    return fields.every((field) =>
      !String(native[field] ?? "").trim() || Boolean(String(cold[field] ?? "").trim())
    );
  });
}

function hasUrlOrTitleOverlap(nativeItems, coldItems) {
  if (hasUrlOverlap(nativeItems, coldItems)) return true;
  const nativeTitles = new Set(nativeItems.map((item) => normalizedTitle(item.title)).filter(Boolean));
  return coldItems.some((item) => nativeTitles.has(normalizedTitle(item.title)));
}

function classifyNativeError(error) {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) {
      return {
        status: "blocked_missing_secret",
        reason: `provider rejected credential or endpoint authorization: ${error.message}`,
      };
    }
    return {
      status: "blocked_provider",
      reason: `${error.message}${error.bodySample ? `: ${error.bodySample}` : ""}`,
    };
  }

  return {
    status: "blocked_provider",
    reason: error.message || String(error),
  };
}

/** Stable row id: `provider:path` for path rows, `provider.tool` for tool rows. */
export function targetId(target) {
  return target.tool
    ? `${target.provider}.${target.tool}`
    : `${target.provider}:${target.path}`;
}

export function missingRequiredEvidenceRows(rows, summary) {
  const versionMatch = summary.match(/^Inventory schema version: (\d+)$/m);
  if (!versionMatch) {
    throw new Error("summary.md is missing an inventory schema version");
  }

  const version = Number(versionMatch[1]);
  let expectedTargets;
  if (version === 1) {
    expectedTargets = REQUIRED_PROVIDER_PATHS;
  } else if (version === 2) {
    expectedTargets = [...SUPPORTED_PROVIDER_PATHS, ...REQUIRED_PROVIDER_TOOLS];
  } else {
    throw new Error(`summary.md has unsupported inventory schema version ${version}`);
  }

  const seen = new Set(rows.map(targetId));
  return expectedTargets.map(targetId).filter((key) => !seen.has(key));
}

const FIXED_TARGET_TOOL_URLS = {
  "exa.contents": EXTRACT_URL,
};

/** A supported row that this run did not select: visible, disclosed, never a pass. */
export function notRunRow(target, reason = "not selected by this scoped run") {
  return {
    timestamp: new Date().toISOString(),
    provider: target.provider,
    ...(target.tool ? { tool: target.tool } : { path: target.path }),
    status: "not_run",
    input: evidenceInput(target),
    native: { skipped: true },
    coldsearch: { skipped: true },
    comparison: { passed: false, notes: [reason] },
  };
}

async function runTarget(target, options) {
  const timestamp = new Date().toISOString();
  const isTool = target.kind === "tool";
  const rowBase = {
    timestamp,
    provider: target.provider,
    ...(isTool ? { tool: target.tool } : { path: target.path }),
    input: evidenceInput(target),
  };
  const rowKey = targetId(target);

  if (options.waivers.has(rowKey)) {
    return {
      ...rowBase,
      status: "waived_by_user",
      native: { skipped: true },
      coldsearch: { skipped: true },
      comparison: { passed: false, notes: ["waived by explicit --waive flag"] },
    };
  }

  if (!hasRunnableFixture(target)) {
    return {
      ...rowBase,
      status: "not_run",
      native: { skipped: true },
      coldsearch: { skipped: true },
      comparison: {
        passed: false,
        notes: ["supported inventory row has no native conformance fixture"],
      },
    };
  }

  const missing = missingRequirement(target);
  if (missing) {
    return {
      ...rowBase,
      status: "blocked_missing_secret",
      missing_requirement: missing,
      native: { skipped: true },
      coldsearch: { skipped: true },
      comparison: { passed: false, notes: [`missing ${missing}`] },
    };
  }

  let nativeResult;
  try {
    if (isTool) {
      const runner = nativeToolRunners[targetId(target)];
      if (!runner) {
        throw new Error(
          `No native runner for tool ${targetId(target)}; add it to nativeToolRunners`
        );
      }
      nativeResult = await runner(target);
    } else {
      const runner = nativeRunners[target.provider];
      if (!runner) {
        throw new Error(
          `No native runner for provider ${target.provider}; add it to nativeRunners`
        );
      }
      nativeResult = await runner(target);
    }
  } catch (error) {
    const classified = classifyNativeError(error);
    return {
      ...rowBase,
      status: classified.status,
      native: { ok: false, error: redactSensitiveText(classified.reason) },
      coldsearch: { skipped: true },
      comparison: { passed: false, notes: ["native provider call did not complete"] },
    };
  }

  let coldResult;
  try {
    coldResult = isTool ? runColdSearchTool(target, options.outDir) : runColdSearch(target, options.outDir);
  } catch (error) {
    return {
      ...rowBase,
      status: "fail",
      native: publicResult(nativeResult),
      coldsearch: { ok: false, error: redactSensitiveText(error.message || String(error)) },
      comparison: { passed: false, notes: ["native call passed but ColdSearch call failed"] },
    };
  }

  const comparison = isTool
    ? compareToolTarget(target, nativeResult, coldResult)
    : compareTarget(target, nativeResult, coldResult);
  return {
    ...rowBase,
    status: comparison.passed ? "pass" : "fail",
    native: publicResult(nativeResult),
    coldsearch: publicResult(coldResult),
    comparison,
  };
}

function publicResult(result) {
  const { items, ...rest } = result;
  return redactEvidenceValue(rest);
}

function redactEvidenceRow(row) {
  const output = redactEvidenceValue(row);
  // These fields describe the evidence row's identity and outcome. Preserve
  // them as schema values even when a short credential happens to equal one.
  for (const key of ["provider", "path", "tool", "kind", "status"]) {
    if (Object.hasOwn(row, key)) output[key] = row[key];
  }
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve symlinks/junctions by realpath-ing the nearest existing ancestor and
// re-appending any non-existing trailing segments. path.resolve alone is purely
// lexical, so a symlink/junction in the out-dir path could otherwise dodge the
// baseline guard and redirect the evidence-clearing writes at the committed dir.
function canonicalize(p) {
  const resolved = path.resolve(p);
  let existing = resolved;
  const trailing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    // No existing ancestor at all (e.g. a non-existent Windows drive like
    // Z:\foo): realpathSync would throw, so fall back to the lexical path.
    if (parent === existing) return resolved;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...trailing);
}

function ensureEvidenceDir(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const samplesDir = path.join(outDir, "samples");
  fs.rmSync(samplesDir, { recursive: true, force: true });
  fs.mkdirSync(samplesDir, { recursive: true });
  for (const file of ["summary.md", "results.jsonl", "coldsearch-usage.jsonl"]) {
    fs.rmSync(path.join(outDir, file), { force: true });
  }
  return samplesDir;
}

export function writeEvidence(outDir, samplesDir, rows) {
  fs.writeFileSync(
    path.join(outDir, "results.jsonl"),
    rows.map((row) => `${JSON.stringify(redactEvidenceRow(row))}\n`).join(""),
    "utf8"
  );

  for (const row of rows) {
    if (row.status === "blocked_missing_secret" || row.status === "waived_by_user" || row.status === "not_run") continue;
    const samplePath = path.join(samplesDir, `${row.provider}-${row.path || row.tool}.json`);
    fs.writeFileSync(
      samplePath,
      `${JSON.stringify(redactEvidenceRow({
        provider: row.provider,
        ...(row.tool ? { tool: row.tool } : { path: row.path }),
        status: row.status,
        native: row.native,
        coldsearch: row.coldsearch,
        comparison: row.comparison,
      }), null, 2)}\n`,
      "utf8"
    );
  }

  fs.writeFileSync(path.join(outDir, "summary.md"), renderSummary(rows), "utf8");
}

export function renderSummary(rows) {
  const generatedAt = new Date().toISOString();
  const counts = Object.fromEntries(ALLOWED_STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;

  const table = rows.map((row) => {
    const notes = [
      ...(row.comparison?.notes || []),
      ...(row.comparison?.detail_loss || []),
      ...(row.comparison?.checks || []).filter((item) => !item.pass).map((item) => `failed: ${item.label}`),
      row.missing_requirement ? `missing: ${row.missing_requirement}` : null,
    ].filter(Boolean).map((item) => String(redact(item)).replace(/\|/g, "\\|")).join("; ");
    return `| ${targetId(row)} | ${row.status} | ${row.native?.result_count ?? "-"} | ${row.coldsearch?.result_count ?? "-"} | ${notes || "-"} |`;
  }).join("\n");

  return `# Gate 0 Provider Pass-Through Evidence

Generated: ${generatedAt}

Inventory schema version: ${EVIDENCE_INVENTORY_SCHEMA_VERSION}

## Commands

- Baseline command for this evidence: \`node scripts/provider-pass-through.mjs --all --overwrite-baseline\`
- Native provider calls use direct HTTP requests.
- ColdSearch calls use \`node dist/cli.js <path> --providers <provider> --single-provider --json\`.
- Provider-tool rows use \`node dist/cli.js tool call <provider.tool> --json-input <json> --json\`.
- Agent mode is not executed by this gate.

## Inputs

| Path | Input |
|---|---|
| search | \`${SEARCH_QUERY}\` |
| extract | default \`${EXTRACT_URL}\`; provider fallback recorded in the row input when needed |
| crawl | \`${CRAWL_URL}\`, limit \`${CRAWL_LIMIT}\` |
| provider-tool rows | per-tool input recorded in the row input |

## Status Counts

| Status | Count |
|---|---:|
${ALLOWED_STATUSES.map((status) => `| ${status} | ${counts[status] || 0} |`).join("\n")}

## Results

| Row | Status | Native Count | ColdSearch Count | Notes |
|---|---|---:|---:|---|
${table}

## Evidence Files

- \`results.jsonl\`: one machine-readable row per supported provider/path and catalogued provider-tool row.
- \`samples/\`: bounded native and ColdSearch samples; raw provider values are omitted.
- \`coldsearch-usage.jsonl\`: usage log emitted by the ColdSearch calls.

Missing credentials or endpoints are recorded as \`blocked_missing_secret\`, not skipped or passed.
Supported rows that this run did not select are recorded as \`not_run\` — they were not tested and must never be read as passes.
`;
}

export function verifyAllRows(rows) {
  const keys = new Set(rows.map(targetId));
  const required = [
    ...SUPPORTED_PROVIDER_PATHS.map((row) => `${row.provider}:${row.path}`),
    ...REQUIRED_PROVIDER_TOOLS.map((row) => `${row.provider}.${row.tool}`),
  ];
  const missing = required.filter((key) => !keys.has(key));
  if (missing.length > 0) {
    throw new Error(`Harness did not emit rows for: ${missing.join(", ")}`);
  }

  const badStatuses = rows.filter((row) => !ALLOWED_STATUSES.includes(row.status));
  if (badStatuses.length > 0) {
    throw new Error(`Harness emitted unsupported statuses: ${badStatuses.map((row) => row.status).join(", ")}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.list) {
    console.log(JSON.stringify({ paths: SUPPORTED_PROVIDER_PATHS, tools: REQUIRED_PROVIDER_TOOLS }, null, 2));
    return;
  }

  const targets = options.all
    ? selectTargets()
    : selectTargets({ provider: options.provider, path: options.path, tool: options.tool });

  const canonicalBaseline = canonicalize(defaultOutDir);
  const canonicalOutDir = canonicalize(options.outDir);
  const relToBaseline = path.relative(canonicalBaseline, canonicalOutDir);
  const isWithinBaseline =
    relToBaseline === "" ||
    (!relToBaseline.startsWith("..") && !path.isAbsolute(relToBaseline));
  if (isWithinBaseline && !(options.overwriteBaseline && options.all)) {
    throw new Error(
      `Refusing to write to ${path.relative(repoRoot, defaultOutDir).replaceAll("\\", "/")}: ` +
        "this is the committed Gate 0 baseline evidence directory and the harness clears its output directory before writing. " +
        "Scoped/live runs must pass --out-dir <dir> pointing outside the baseline. " +
        "Regenerating the baseline in place requires both --all and --overwrite-baseline, so a scoped selection can never replace the full baseline matrix."
    );
  }

  const samplesDir = ensureEvidenceDir(options.outDir);
  const rows = [];
  for (const target of targets) {
    process.stdout.write(`RUN   ${targetId(target)}\n`);
    const row = await runTarget(target, options);
    rows.push(row);
    process.stdout.write(`${row.status.toUpperCase().padEnd(23)} ${targetId(target)}\n`);
  }

  // Coverage disclosure: supported rows this run did not select must be visible
  // in the summary and JSONL as not_run — never silently omitted, never counted
  // as passes. --all selects the full matrix, so this only adds rows for scoped
  // selections.
  const selectedKeys = new Set(rows.map(targetId));
  for (const target of selectTargets()) {
    if (!selectedKeys.has(targetId(target))) {
      rows.push(notRunRow(target));
    }
  }

  verifyAllRows(rows);
  writeEvidence(options.outDir, samplesDir, rows);

  const failed = rows.filter((row) => row.status === "fail").length;
  const blocked = rows.filter((row) => row.status.startsWith("blocked_")).length;
  const notRun = rows.filter((row) => row.status === "not_run").length;
  console.log(`\nWrote evidence to ${path.relative(repoRoot, options.outDir).replaceAll("\\", "/")}`);
  console.log(`${rows.length} rows, ${failed} failed, ${blocked} blocked, ${notRun} not_run`);
  process.exitCode = failed > 0 ? 1 : 0;
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(redactSensitiveText(error.message || String(error)));
    process.exit(1);
  });
}

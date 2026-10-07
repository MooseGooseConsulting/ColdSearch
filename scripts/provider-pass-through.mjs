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
  "waived_by_user",
];

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
};

const SECRET_ENV_NAMES = [
  "TAVILY_API_KEY",
  "FIRECRAWL_API_KEY",
  "EXA_API_KEY",
  "BRAVE_API_KEY",
  "SERPER_API_KEY",
  "SEARXNG_BASE_URL",
];

class ProviderHttpError extends Error {
  constructor(message, status, bodySample) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.bodySample = bodySample;
  }
}

export function selectTargets({ provider, path: capabilityPath } = {}) {
  const selected = REQUIRED_PROVIDER_PATHS.filter((target) => {
    if (provider && target.provider !== provider) return false;
    if (capabilityPath && target.path !== capabilityPath) return false;
    return true;
  });

  if (selected.length === 0) {
    const providerPart = provider ? `provider=${provider}` : "provider=*";
    const pathPart = capabilityPath ? `path=${capabilityPath}` : "path=*";
    throw new Error(`No Gate 0 target matches ${providerPart} ${pathPart}`);
  }

  return selected.map((target) => ({ ...target }));
}

function parseArgs(argv) {
  const options = {
    all: false,
    provider: undefined,
    path: undefined,
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

  if (!options.all && !options.provider && !options.path && !options.list && !options.help) {
    options.all = true;
  }

  if (options.all && (options.provider || options.path)) {
    throw new Error("--all cannot be combined with --provider or --path");
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

Options:
  --all                 Run every required provider/path row
  --provider NAME       Run one provider, or combine with --path
  --path NAME           Run one capability path: search, extract, crawl
  --out-dir DIR         Evidence output directory (scoped/live runs must use a
                        non-baseline directory; the committed Gate 0 baseline
                        evidence directory is protected)
  --waive provider:path Mark a row waived_by_user without running it
  --list                Print the required provider/path matrix as JSON
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

function inputForTarget(target) {
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
    (value) => typeof value === "string" && value.length >= 8
  );
}

function redactString(value) {
  if (typeof value !== "string") return value;
  let result = value;
  for (const secret of secretValues()) {
    result = result.split(secret).join("REDACTED");
  }
  return result
    .replace(/([?&](?:jwt|redir_token|access_token|api_key|key|token)=)[^&#"'\s]+/gi, "$1REDACTED")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED")
    .replace(/(X-API-KEY["':\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED")
    .replace(/(X-Subscription-Token["':\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1REDACTED");
}

function redact(value) {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redact(entry)])
    );
  }
  return value;
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
        truncate(redactString(body), 500)
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ProviderHttpError) throw error;
    throw new Error(`${label} failed: ${redactString(error.message || String(error))}`);
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

function makeNativeResult(target, items, metadata = {}) {
  return {
    ok: true,
    result_count: items.length,
    sample: sampleFromItems(target.path, items),
    items,
    ...metadata,
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
    jsonPost({ url: CRAWL_URL, max_results: CRAWL_LIMIT, extract_depth: "basic" }, headers),
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
      { query: `site:${domain}`, numResults: CRAWL_LIMIT, type: "fast" },
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
        text: { max_characters: 12000 },
        livecrawl: "preferred",
        livecrawl_timeout: 10000,
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

const nativeRunners = {
  tavily: nativeTavily,
  firecrawl: nativeFirecrawl,
  exa: nativeExa,
  brave: nativeBrave,
  serper: nativeSerper,
  jina: nativeJina,
  searxng: nativeSearXNG,
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
        `ColdSearch exited ${result.status}: ${truncate(redactString(result.stderr || result.stdout || "(no output)"), 1000)}`
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

function check(pass, label) {
  return { pass: Boolean(pass), label };
}

function hasUrlOverlap(nativeItems, coldItems) {
  const nativeUrls = new Set(nativeItems.map((item) => normalizedUrl(item.url)).filter(Boolean));
  return coldItems.some((item) => nativeUrls.has(normalizedUrl(item.url)));
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

async function runTarget(target, options) {
  const timestamp = new Date().toISOString();
  const rowBase = {
    timestamp,
    provider: target.provider,
    path: target.path,
    input: inputForTarget(target),
  };
  const rowKey = `${target.provider}:${target.path}`;

  if (options.waivers.has(rowKey)) {
    return {
      ...rowBase,
      status: "waived_by_user",
      native: { skipped: true },
      coldsearch: { skipped: true },
      comparison: { passed: false, notes: ["waived by explicit --waive flag"] },
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
    nativeResult = await nativeRunners[target.provider](target);
  } catch (error) {
    const classified = classifyNativeError(error);
    return {
      ...rowBase,
      status: classified.status,
      native: { ok: false, error: redactString(classified.reason) },
      coldsearch: { skipped: true },
      comparison: { passed: false, notes: ["native provider call did not complete"] },
    };
  }

  let coldResult;
  try {
    coldResult = runColdSearch(target, options.outDir);
  } catch (error) {
    return {
      ...rowBase,
      status: "fail",
      native: publicResult(nativeResult),
      coldsearch: { ok: false, error: redactString(error.message || String(error)) },
      comparison: { passed: false, notes: ["native call passed but ColdSearch call failed"] },
    };
  }

  const comparison = compareTarget(target, nativeResult, coldResult);
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
  return redact(rest);
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

function writeEvidence(outDir, samplesDir, rows) {
  fs.writeFileSync(
    path.join(outDir, "results.jsonl"),
    rows.map((row) => `${JSON.stringify(redact(row))}\n`).join(""),
    "utf8"
  );

  for (const row of rows) {
    if (row.status === "blocked_missing_secret" || row.status === "waived_by_user") continue;
    const samplePath = path.join(samplesDir, `${row.provider}-${row.path}.json`);
    fs.writeFileSync(
      samplePath,
      `${JSON.stringify(redact({
        provider: row.provider,
        path: row.path,
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

function renderSummary(rows) {
  const generatedAt = new Date().toISOString();
  const counts = Object.fromEntries(ALLOWED_STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;

  const table = rows.map((row) => {
    const notes = [
      ...(row.comparison?.notes || []),
      ...(row.comparison?.detail_loss || []),
      ...(row.comparison?.checks || []).filter((item) => !item.pass).map((item) => `failed: ${item.label}`),
      row.missing_requirement ? `missing: ${row.missing_requirement}` : null,
    ].filter(Boolean).map((item) => String(item).replace(/\|/g, "\\|")).join("; ");
    return `| ${row.provider} | ${row.path} | ${row.status} | ${row.native?.result_count ?? "-"} | ${row.coldsearch?.result_count ?? "-"} | ${notes || "-"} |`;
  }).join("\n");

  return `# Gate 0 Provider Pass-Through Evidence

Generated: ${generatedAt}

## Commands

- Baseline command for this evidence: \`node scripts/provider-pass-through.mjs --all --overwrite-baseline\`
- Native provider calls use direct HTTP requests.
- ColdSearch calls use \`node dist/cli.js <path> --providers <provider> --single-provider --json\`.
- Agent mode is not executed by this gate.

## Inputs

| Path | Input |
|---|---|
| search | \`${SEARCH_QUERY}\` |
| extract | default \`${EXTRACT_URL}\`; provider fallback recorded in the row input when needed |
| crawl | \`${CRAWL_URL}\`, limit \`${CRAWL_LIMIT}\` |

## Status Counts

| Status | Count |
|---|---:|
${ALLOWED_STATUSES.map((status) => `| ${status} | ${counts[status] || 0} |`).join("\n")}

## Results

| Provider | Path | Status | Native Count | ColdSearch Count | Notes |
|---|---|---|---:|---:|---|
${table}

## Evidence Files

- \`results.jsonl\`: one machine-readable row per required provider/path.
- \`samples/\`: redacted native and ColdSearch samples for rows that ran.
- \`coldsearch-usage.jsonl\`: usage log emitted by the ColdSearch calls.

Missing credentials or endpoints are recorded as \`blocked_missing_secret\`, not skipped or passed.
`;
}

function verifyAllRows(rows) {
  const keys = new Set(rows.map((row) => `${row.provider}:${row.path}`));
  const missing = REQUIRED_PROVIDER_PATHS
    .map((row) => `${row.provider}:${row.path}`)
    .filter((key) => !keys.has(key));
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
    console.log(JSON.stringify(REQUIRED_PROVIDER_PATHS, null, 2));
    return;
  }

  const targets = options.all
    ? selectTargets()
    : selectTargets({ provider: options.provider, path: options.path });

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
    process.stdout.write(`RUN   ${target.provider}:${target.path}\n`);
    const row = await runTarget(target, options);
    rows.push(row);
    process.stdout.write(`${row.status.toUpperCase().padEnd(23)} ${target.provider}:${target.path}\n`);
  }

  if (options.all) {
    verifyAllRows(rows);
  }
  writeEvidence(options.outDir, samplesDir, rows);

  const failed = rows.filter((row) => row.status === "fail").length;
  const blocked = rows.filter((row) => row.status.startsWith("blocked_")).length;
  console.log(`\nWrote evidence to ${path.relative(repoRoot, options.outDir).replaceAll("\\", "/")}`);
  console.log(`${rows.length} rows, ${failed} failed, ${blocked} blocked`);
  process.exitCode = failed > 0 ? 1 : 0;
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(redactString(error.message || String(error)));
    process.exit(1);
  });
}

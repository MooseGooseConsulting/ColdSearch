#!/usr/bin/env node

import { APP_NAME, LEGACY_APP_NAME, formatVersionString } from "./app.js";
import { SearchAgent } from "./agent/agent.js";
import { resolveLlmConfig, LLM_PROVIDERS, REASONING_EFFORTS, type ReasoningEffort, type LLMEndpointConfig, type LLMProvider } from "./agent/llm.js";
import { LocalExecutionBackend } from "./execution/backend.js";
import {
  DEFAULT_CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  STARTER_CONFIG,
  loadConfig,
  resolveConfigPath,
} from "./config.js";
import { resolveCapabilityProviders } from "./providers.js";
import {
  getToolProfile,
  listToolProfiles,
  providerToolProfiles,
} from "./registry/tool-profiles.js";
import { executeToolCall } from "./tools/substrate.js";
import { runBatch } from "./batch/runner.js";
import { getKeyReference } from "./logging/usage.js";
import { HistoryStore } from "./history/store.js";
import { searchHistory } from "./history/search.js";
import { newExecutionId, type ExecutionRecord } from "./history/types.js";
import { redactSensitive } from "./history/redact.js";
import { CacheStore } from "./cache/cache.js";
import { classifyError } from "./http.js";
import {
  buildDoctorReport,
  buildStatus,
  type DoctorReport,
} from "./status.js";
import fs from "node:fs";
import path from "node:path";
import type { CapabilityCategory, CapabilityName, CLIOptions, Config } from "./types.js";

/**
 * Extended CLI options including mode-specific options.
 */
interface ExtendedCLIOptions extends CLIOptions {
  /** Run in agent mode */
  agent?: boolean;
  /** Print status information and exit */
  status?: boolean;
  /** Specific providers to use */
  providers?: string[];
  /** Reranker strategy */
  rerank?: "rrf" | "score" | "none";
  /** LLM provider for agent */
  llmProvider?: LLMProvider;
  /** LLM model for agent */
  model?: string;
  /** LLM base URL override */
  llmBaseUrl?: string;
  /** LLM credential reference override (env:NAME or doppler:NAME) */
  llmKeyRef?: string;
  reasoningEffort?: ReasoningEffort;
  /** Maximum agent steps */
  maxSteps?: number;
  /** Maximum sources for agent */
  maxSources?: number;
  /** Resolve plan without making network calls */
  dryRun?: boolean;
  /** Bypass the read-through result cache */
  noCache?: boolean;
  /** Per-invocation cache TTL override (e.g. "30m"); wins for this invocation only */
  freshness?: string;
  /** Whether --limit was passed explicitly (history commands default to 20 otherwise) */
  limitSet?: boolean;
  /** JSON input string/file for tool calling */
  jsonInput?: string;
  /** `coldsearch tool <sub>` discovery/execution surface */
  toolCommand?: {
    sub: "list" | "info" | "call";
    target?: string;
    provider?: string;
    category?: string;
  };
  /** `coldsearch history <sub>` execution-history surface */
  historyCommand?: {
    sub: "recent" | "search" | "show" | "clear";
    target?: string;
    all?: boolean;
    byProvider?: boolean;
  };
  /** `coldsearch cache <sub>` replay-cache maintenance surface */
  cacheCommand?: {
    sub: "stats" | "clear";
  };
  /** `coldsearch config <sub>` operator config surface */
  configCommand?: {
    sub: "init" | "doctor";
  };
}

/**
 * Parse command line arguments into CLIOptions.
 */
function parseArgs(args: string[]): ExtendedCLIOptions {
  const options: ExtendedCLIOptions = {
    command: "search",
    query: "",
    limit: 10,
    pretty: false,
    json: false,
    rerank: "rrf",
  };

  // Check if first arg is a command
  const commands = ["search", "extract", "crawl", "status"];
  let i = 0;

  if (args.length > 0 && args[0] === "tool") {
    // `tool list` / `tool info <provider.tool>` / `tool call <provider.tool>`
    const sub = args[1];
    if (sub !== "list" && sub !== "info" && sub !== "call") {
      throw new Error(
        `Unknown 'tool' subcommand: ${sub ?? "(none)"}. Use 'tool list', 'tool info <provider.tool>', or 'tool call <provider.tool>'.`
      );
    }
    options.toolCommand = { sub };
    i = 2;
    if (sub === "info" || sub === "call") {
      if (!args[2] || args[2].startsWith("-")) {
        throw new Error(`'tool ${sub}' requires a <provider.tool> argument, e.g. exa.search`);
      }
      options.toolCommand.target = args[2];
      i = 3;
    }
  } else if (args.length > 0 && args[0] === "history") {
    // `history recent` / `history search <query>` / `history show <id>` / `history clear --all`
    const sub = args[1];
    if (sub !== "recent" && sub !== "search" && sub !== "show" && sub !== "clear") {
      throw new Error(
        `Unknown 'history' subcommand: ${sub ?? "(none)"}. Use 'history recent', 'history search <query>', 'history show <execution-id>', or 'history clear --all'.`
      );
    }
    options.historyCommand = { sub };
    i = 2;
    // The positional query/id is captured by the flag loop below; it may
    // appear immediately after the subcommand or after flags (matching the
    // main search command's parsing), and its absence is validated at the end.
  } else if (args.length > 0 && args[0] === "cache") {
    // `cache stats` / `cache clear`
    const sub = args[1];
    if (sub !== "stats" && sub !== "clear") {
      throw new Error(
        `Unknown 'cache' subcommand: ${sub ?? "(none)"}. Use 'cache stats' or 'cache clear'.`
      );
    }
    options.cacheCommand = { sub };
    i = 2;
  } else if (args.length > 0 && args[0] === "batch") {
    // `batch --input <file.jsonl> --output <file.jsonl> [--concurrency N] [--retry-errors] [--dry-run]`
    options.batch = { input: undefined, output: undefined };
    i = 1;
  } else if (args.length > 0 && args[0] === "config") {
    // `config init` / `config doctor`
    const sub = args[1];
    if (sub !== "init" && sub !== "doctor") {
      throw new Error(
        `Unknown 'config' subcommand: ${sub ?? "(none)"}. Use 'config init' or 'config doctor'.`
      );
    }
    options.configCommand = { sub };
    i = 2;
  } else if (args.length > 0 && commands.includes(args[0])) {
    options.command = args[0] as "search" | "extract" | "crawl";
    if (args[0] === "status") {
      options.status = true;
    }
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "--limit":
      case "-l":
        i++;
        const limit = parseInt(args[i], 10);
        if (isNaN(limit) || limit < 1) {
          throw new Error(`Invalid limit: ${args[i]}`);
        }
        options.limit = limit;
        options.limitSet = true;
        break;

      case "--pretty":
      case "-p":
        options.pretty = true;
        break;

      case "--json":
      case "-j":
        options.json = true;
        break;

      case "--json-input":
        i++;
        options.jsonInput = args[i];
        break;

      case "--config":
      case "-c":
        i++;
        if (!args[i] || args[i].startsWith("-")) {
          throw new Error(
            `Missing value for --config: expected a config file path, got ${args[i] ?? "(none)"}`
          );
        }
        options.config = args[i];
        break;

      case "--agent":
      case "-a":
        options.agent = true;
        break;

      case "--providers":
        i++;
        options.providers = args[i].split(",").map((p) => p.trim());
        break;

      case "--provider":
        i++;
        if (options.toolCommand) options.toolCommand.provider = args[i];
        break;

      case "--category":
        i++;
        if (options.toolCommand) options.toolCommand.category = args[i];
        break;

      case "--single-provider":
        options.singleProvider = true;
        break;

      case "--dry-run":
        options.dryRun = true;
        break;

      case "--no-cache":
        options.noCache = true;
        break;

      case "--freshness":
        i++;
        if (!args[i] || !/^\d+(?:\.\d+)?\s*[smhd]?$/i.test(args[i])) {
          throw new Error(
            `Invalid freshness duration: ${args[i] ?? "(none)"}. Use a number with optional unit s|m|h|d, e.g. --freshness 30m.`
          );
        }
        options.freshness = args[i];
        break;

      case "--all":
        if (!options.historyCommand || options.historyCommand.sub !== "clear") {
          throw new Error("--all is only valid with 'history clear'");
        }
        options.historyCommand.all = true;
        break;

      case "--input":
        i++;
        if (!options.batch) {
          throw new Error("--input is only valid with 'batch'");
        }
        if (!args[i] || args[i].startsWith("-")) {
          throw new Error(`--input requires a JSONL file path`);
        }
        options.batch.input = args[i];
        break;

      case "--output":
        i++;
        if (!options.batch) {
          throw new Error("--output is only valid with 'batch'");
        }
        if (!args[i] || args[i].startsWith("-")) {
          throw new Error(`--output requires a JSONL file path`);
        }
        options.batch.output = args[i];
        break;

      case "--concurrency":
        i++;
        if (!options.batch) {
          throw new Error("--concurrency is only valid with 'batch'");
        }
        const concurrency = Number(args[i]);
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          throw new Error(
            `Invalid concurrency: ${args[i] ?? "(none)"}. Use a positive integer.`
          );
        }
        options.batch.concurrency = concurrency;
        break;

      case "--retry-errors":
        if (!options.batch) {
          throw new Error("--retry-errors is only valid with 'batch'");
        }
        options.batch.retryErrors = true;
        break;

      case "--by-provider":
        if (!options.historyCommand) {
          throw new Error("--by-provider is only valid with 'history show'");
        }
        options.historyCommand.byProvider = true;
        break;

      case "--rerank":
        i++;
        const strategy = args[i];
        if (!["rrf", "score", "none"].includes(strategy)) {
          throw new Error(`Invalid rerank strategy: ${strategy}`);
        }
        options.rerank = strategy as "rrf" | "score" | "none";
        break;

      case "--llm":
        i++;
        const llm = args[i];
        if (!(LLM_PROVIDERS as readonly string[]).includes(llm)) {
          throw new Error(
            `Invalid LLM provider: ${llm}. Supported: ${LLM_PROVIDERS.join(", ")} (Anthropic API is not used).`
          );
        }
        options.llmProvider = llm as LLMProvider;
        break;

      case "--model":
        i++;
        options.model = args[i];
        break;

      case "--reasoning-effort":
        i++;
        if (!(REASONING_EFFORTS as readonly string[]).includes(args[i])) {
          throw new Error(`Invalid reasoning effort. Supported: ${REASONING_EFFORTS.join(", ")}`);
        }
        options.reasoningEffort = args[i] as ReasoningEffort;
        break;

      case "--llm-base-url":
        i++;
        options.llmBaseUrl = args[i];
        break;

      case "--llm-key-ref":
        i++;
        if (!args[i] || args[i].startsWith("-")) {
          throw new Error("--llm-key-ref requires an env:NAME or doppler:NAME reference");
        }
        options.llmKeyRef = args[i];
        break;

      case "--max-steps":
        i++;
        options.maxSteps = parseInt(args[i], 10);
        break;

      case "--max-sources":
        i++;
        options.maxSources = parseInt(args[i], 10);
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;

      case "--version":
      case "-v":
        console.log(formatVersionString());
        process.exit(0);
        break;

      default:
        if (!arg.startsWith("-")) {
          if (
            options.historyCommand &&
            (options.historyCommand.sub === "search" ||
              options.historyCommand.sub === "show") &&
            options.historyCommand.target === undefined
          ) {
            // `history search <query>` / `history show <execution-id>` —
            // consume trailing non-flag args as the target, so the positional
            // may follow flags like the main search command's query.
            const targetParts: string[] = [];
            let j = i;
            while (j < args.length && !args[j].startsWith("-")) {
              targetParts.push(args[j]);
              j++;
            }
            options.historyCommand.target = targetParts.join(" ");
            i = j;
            continue;
          }
          const queryParts: string[] = [];
          let j = i;
          while (j < args.length && !args[j].startsWith("-")) {
            queryParts.push(args[j]);
            j++;
          }
          options.query = queryParts.join(" ");
          i = j;
          continue;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
    i++;
  }

  const hc = options.historyCommand;
  if (hc && (hc.sub === "search" || hc.sub === "show") && hc.target === undefined) {
    throw new Error(
      hc.sub === "search"
        ? `'history search' requires a <query> argument.`
        : `'history show' requires an <execution-id> argument.`
    );
  }

  if (options.batch) {
    if (!options.batch.input || !options.batch.output) {
      throw new Error("'batch' requires --input <file.jsonl> and --output <file.jsonl>");
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
${APP_NAME} - Unified search CLI

Usage: ${APP_NAME} [command] [options] "<query|url>"

Compatibility alias: ${LEGACY_APP_NAME}

Commands:
  search [options] "query"    Search the web (default)
  extract [options] "url"     Extract content from a URL
  crawl [options] "url"       Crawl a website
  tool list [options]         List provider-tool profiles (offline)
  tool info <provider.tool>   Show one provider-tool profile (offline)
  tool call <provider.tool>   Execute a provider tool (--json-input)
  history recent              List recent executions (newest first)
  history search "query"      Search prior executions locally (no provider calls)
  history show <id>           Show one execution (--by-provider for fanout partitions)
  history clear --all         Delete all execution history (keeps replay cache)
  cache stats                 Describe replay-cache storage
  cache clear                 Delete replay-cache entries (keeps history)
  config init                 Write a starter config (refuses to overwrite)
  config doctor               Diagnose config locally (no provider contact)
  batch --input FILE --output FILE
                              Run a resumable JSONL batch of search/extract/
                              crawl/provider-tool records
  status                      Show configured providers and usage summary

Options:
  Mode Selection:
    -a, --agent          Use search agent mode (multi-step research)
    --single-provider    Use one random provider instead of fanout
    --dry-run            Print execution plan without network calls
    
  Fanout Options (default mode):
    --providers LIST     Comma-separated providers (default: all configured)
    --rerank STRATEGY    Reranker: rrf|score|none (default: rrf)
    
  Agent Options (requires --agent):
    --llm PROVIDER       LLM: openai|groq|openrouter|cerebras|xai|isoquant (default: isoquant)
    --model MODEL        LLM model name
    --reasoning-effort N none|minimal|low|medium|high|xhigh|max (Isoquant default: medium)
    --llm-base-url URL   Override OpenAI-compatible API base URL
    --llm-key-ref REF    Override credential reference (env:NAME or doppler:NAME)
    --max-steps N        Maximum research steps (default: 5)
    --max-sources N      Maximum sources to collect (default: 5)
    
  General Options:
    -l, --limit N        Return at most N results (default: 10; history: 20)
    -p, --pretty         Pretty print JSON output
    -j, --json           Force JSON output
    -c, --config PATH    Use custom config file
    --no-cache           Bypass the read-through result cache
                         (search/extract/tool call)
    --freshness DURATION Per-invocation cache TTL override, e.g. 30m, 6h, 2d
                         (search/extract and replay-safe provider tools)
    -h, --help           Show this help
    -v, --version        Show version

  Batch Options (requires batch):
    --input FILE         Input JSONL of batch records (required)
    --output FILE        Output JSONL, appended in completion order (required)
    --concurrency N      Maximum concurrent items (default: 1)
    --retry-errors       Retry records that errored in a prior run
    --dry-run            Report the planned records without executing

Examples:
  # Search commands
  ${APP_NAME} "what is firecrawl"
  ${APP_NAME} search "machine learning"
  ${APP_NAME} --providers tavily,brave --rerank rrf "rust async"
  
  # Extract content from URL
  ${APP_NAME} extract "https://example.com/article"
  
  # Crawl a website
  ${APP_NAME} crawl "https://example.com"
  ${APP_NAME} crawl --limit 5 "https://docs.example.com"
  
  # Use single random provider
  ${APP_NAME} --single-provider "query"
  
  # Inspect the provider-tool registry (no network)
  ${APP_NAME} tool list --json
  ${APP_NAME} tool list --provider firecrawl --json
  ${APP_NAME} tool info firecrawl.scrape --json

  # Browse and inspect execution history (local-only)
  ${APP_NAME} history recent --limit 10
  ${APP_NAME} history search "strix halo inference"
  ${APP_NAME} history show exec-20260810T134615Z-a1b2c3d4 --by-provider
  ${APP_NAME} history clear --all

  # Replay-cache maintenance
  ${APP_NAME} cache stats
  ${APP_NAME} search --freshness 30m "fresh results only"
  ${APP_NAME} cache clear

  # Batch runs (resumable JSONL of search/extract/crawl/provider-tool records)
  ${APP_NAME} batch --input queries.jsonl --output results.jsonl --concurrency 4
  ${APP_NAME} batch --input queries.jsonl --output results.jsonl --concurrency 4 --retry-errors
  ${APP_NAME} batch --input queries.jsonl --output results.jsonl --dry-run --json
  
  # Agent mode
  ${APP_NAME} --agent "explain quantum computing"
  ${APP_NAME} --agent --max-steps 10 "latest fusion energy developments"
`);
}

/**
 * Label CLI JSON mode field from what actually ran (not just --single-provider flag).
 */
function describeCliOutputMode(
  config: Config,
  capability: CapabilityName,
  options: ExtendedCLIOptions,
  providersUsedCount: number
): "single-provider" | "fanout" {
  if (options.singleProvider) return "single-provider";
  const cap = config.capabilities[capability];
  if (cap?.strategy === "random") return "single-provider";
  return providersUsedCount > 1 ? "fanout" : "single-provider";
}

/**
 * Format output based on options.
 */
function formatOutput(data: unknown, options: ExtendedCLIOptions): string {
  const isTTY = process.stdout.isTTY;
  const shouldPrettyPrint = options.pretty || (!options.json && isTTY);

  if (shouldPrettyPrint) {
    return JSON.stringify(data, null, 2);
  }
  return JSON.stringify(data);
}

/**
 * Run Mode 1: Fanout + Rerank.
 */
async function runFanoutMode(options: ExtendedCLIOptions): Promise<void> {
  if (options.dryRun) {
    const plan = buildExecutionPlan("search", options);
    console.log(formatOutput(plan, options));
    return;
  }

  const config = loadConfig(options.config);
  const backend = new LocalExecutionBackend(options.config);

  const result = await backend.search(options.query, {
    limit: options.limit,
    providers: options.providers,
    rerankStrategy: options.rerank,
    singleProvider: options.singleProvider,
    noCache: options.noCache,
    freshness: options.freshness,
  });

  for (const warning of result.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }

  const output = {
    mode: describeCliOutputMode(
      config,
      "search",
      options,
      result.providersUsed.length
    ),
    command: "search",
    query: options.query,
    results: result.results,
    providers_used: result.providersUsed,
    total: result.results.length,
    errors: Object.keys(result.errors).length > 0 ? result.errors : undefined,
    history_warnings: result.warnings && result.warnings.length > 0 ? result.warnings : undefined,
  };

  console.log(formatOutput(output, options));
}

/**
 * Run extract mode.
 */
async function runExtractMode(options: ExtendedCLIOptions): Promise<void> {
  if (options.dryRun) {
    const plan = buildExecutionPlan("extract", options);
    console.log(formatOutput(plan, options));
    return;
  }

  const config = loadConfig(options.config);
  const backend = new LocalExecutionBackend(options.config);

  const result = await backend.extract(options.query, {
    limit: options.limit,
    providers: options.providers,
    singleProvider: options.singleProvider,
    noCache: options.noCache,
    freshness: options.freshness,
  });

  for (const warning of result.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }

  const output = {
    mode: describeCliOutputMode(config, "extract", options, 1),
    command: "extract",
    url: options.query,
    result: result.result,
    provider: result.provider,
    errors: result.errors ? result.errors : undefined,
    history_warnings: result.warnings && result.warnings.length > 0 ? result.warnings : undefined,
  };

  console.log(formatOutput(output, options));
}

/**
 * Run crawl mode.
 */
async function runCrawlMode(options: ExtendedCLIOptions): Promise<void> {
  // Exact crawl replay is disabled by design (broad site snapshots are
  // sensitive to site state, depth, and limit), so a --freshness override
  // would be silently ignored — make that visible instead of accepting it
  // without effect.
  if (options.freshness) {
    console.error(
      "Warning: --freshness ignored for crawl: exact crawl replay is disabled by design."
    );
  }

  if (options.dryRun) {
    const plan = buildExecutionPlan("crawl", options);
    console.log(formatOutput(plan, options));
    return;
  }

  const config = loadConfig(options.config);
  const backend = new LocalExecutionBackend(options.config);

  const result = await backend.crawl(options.query, {
    limit: options.limit,
    providers: options.providers,
    singleProvider: options.singleProvider,
  });

  for (const warning of result.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }

  const output = {
    mode: describeCliOutputMode(config, "crawl", options, 1),
    command: "crawl",
    url: options.query,
    results: result.results,
    provider: result.provider,
    total: result.results.length,
    errors: result.errors ? result.errors : undefined,
    history_warnings: result.warnings && result.warnings.length > 0 ? result.warnings : undefined,
  };

  console.log(formatOutput(output, options));
}

/**
 * Run Mode 2: Search Agent.
 */
async function runAgentMode(options: ExtendedCLIOptions): Promise<void> {
  // Agent LLM endpoint precedence: CLI flags (--llm/--model/--llm-base-url)
  // > TOML [agent.llm] > environment fallback and code defaults (applied
  // inside createLLMClient).
  const config = loadConfig(options.config);
  const llm = resolveLlmConfig(
    { provider: options.llmProvider, model: options.model, baseUrl: options.llmBaseUrl, keyRef: options.llmKeyRef, reasoningEffort: options.reasoningEffort },
    config.agent?.llm as
      | LLMEndpointConfig
      | undefined
  );

  const agent = new SearchAgent({
    configPath: options.config,
    llmProvider: llm.provider,
    model: llm.model,
    llmBaseUrl: llm.baseUrl,
    llmSettings: llm,
    maxSteps: options.maxSteps,
    maxSources: options.maxSources,
    noCache: options.noCache,
  });

  const result = await agent.research(options.query, {
    maxSteps: options.maxSteps,
    maxSources: options.maxSources,
  });

  const output = {
    mode: "agent",
    goal: options.query,
    answer: result.answer,
    sources: result.sources,
    steps: result.steps.length,
  };

  console.log(formatOutput(output, options));
}

function resolveProviderList(capability: "search" | "extract" | "crawl", options: ExtendedCLIOptions) {
  const config = loadConfig(options.config);
  const { providers: selected } = resolveCapabilityProviders(
    config,
    capability,
    { providers: options.providers, singleProvider: options.singleProvider }
  );
  return { config, providers: selected };
}

function buildExecutionPlan(capability: "search" | "extract" | "crawl", options: ExtendedCLIOptions) {
  const { config, providers } = resolveProviderList(capability, options);

  const plannedProviders = providers.map((provider) => {
    const pool = config.providers[provider]?.keyPool;
    const keyCount = pool?.keys?.length || 0;
    const keyStrategy = pool?.strategy || "round-robin";
    const keyPreview = getKeyReference(pool, provider);

    const warnings = [];
    if (keyCount > 0 && pool?.keys?.length) {
      const first = pool.keys[0];
      if (first.startsWith("env:")) {
        const varName = first.slice(4);
        if (!process.env[varName]) warnings.push(`missing env var ${varName}`);
      }
    }

    return {
      provider,
      capability,
      key_pool: { count: keyCount, strategy: keyStrategy, preview: keyPreview },
      warnings: warnings.length ? warnings : undefined,
    };
  });

  return {
    mode: "dry-run",
    capability,
    query_or_url: options.query,
    providers: plannedProviders,
    estimated_api_calls: plannedProviders.length,
  };
}

async function runStatus(options: ExtendedCLIOptions): Promise<void> {
  const config = loadConfig(options.config);
  const status = buildStatus(config, resolveConfigPath(options.config));
  console.log(formatOutput({ command: "status", ...status }, options));
}

/**
 * `coldsearch config init` — write a starter config at the target path,
 * refusing to overwrite any existing config (including a legacy-brand config
 * that ColdSearch already reads).
 */
function runConfigInit(options: ExtendedCLIOptions): void {
  const target = options.config ? path.resolve(options.config) : DEFAULT_CONFIG_PATH;

  if (!options.config && fs.existsSync(LEGACY_CONFIG_PATH)) {
    throw new Error(
      `Legacy config found at ${LEGACY_CONFIG_PATH}; ColdSearch already reads it. ` +
        `Remove it or pass --config to initialize a new config elsewhere.`
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    // Atomic exclusive create: a concurrent init racing this one fails with
    // EEXIST instead of both passing an exists() check and overwriting.
    fs.writeFileSync(target, STARTER_CONFIG, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Config file already exists: ${target}. Refusing to overwrite it.`
      );
    }
    throw error;
  }

  printData(
    { command: "config init", config_path: target },
    `Created config at ${target}`,
    options
  );
}

function formatDoctorHuman(report: DoctorReport): string {
  const lines = [
    `Config doctor: ${report.config_path}`,
    `  valid: ${report.valid ? "yes" : "no"}`,
  ];
  if (report.errors.length > 0) {
    lines.push(`  errors (${report.errors.length}):`);
    for (const issue of report.errors) {
      lines.push(`    - [${issue.category}] ${issue.message}`);
    }
  } else {
    lines.push("  errors: none");
  }
  if (report.warnings.length > 0) {
    lines.push(`  warnings (${report.warnings.length}):`);
    for (const issue of report.warnings) {
      lines.push(`    - [${issue.category}] ${issue.message}`);
    }
  } else {
    lines.push("  warnings: none");
  }
  return lines.join("\n");
}

/**
 * `coldsearch config doctor` — local diagnostics only. Never contacts provider
 * APIs, never consumes provider credits, never resolves `doppler:` references,
 * and the SearXNG base URL check is presence/format only (no liveness probe).
 * Secret values are never printed.
 */
function runConfigDoctor(options: ExtendedCLIOptions): void {
  const configPath = resolveConfigPath(options.config);

  let report: DoctorReport;
  try {
    const config = loadConfig(options.config);
    report = buildDoctorReport(config, configPath);
  } catch (error) {
    report = {
      config_path: configPath,
      valid: false,
      errors: [{ category: "config", message: (error as Error).message }],
      warnings: [],
    };
  }

  printData(
    {
      command: "config doctor",
      config_path: report.config_path,
      valid: report.valid,
      errors: report.errors,
      warnings: report.warnings,
    },
    formatDoctorHuman(report),
    options
  );

  if (!report.valid) {
    process.exitCode = 1;
  }
}

/**
 * `coldsearch tool list` — list provider-tool profiles (offline, read-only).
 */
function runToolList(options: ExtendedCLIOptions): void {
  const tc = options.toolCommand!;
  const profiles = listToolProfiles({
    provider: tc.provider,
    category: tc.category as CapabilityCategory | undefined,
  });

  const tools = profiles
    .map((p) => ({
      id: `${p.provider}.${p.tool}`,
      provider: p.provider,
      tool: p.tool,
      native_name: p.nativeName,
      categories: p.categories,
      status: p.status,
      execution: p.execution.mode,
      docs: p.docsUrl,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  console.log(
    formatOutput(
      {
        command: "tool list",
        filter: { provider: tc.provider ?? null, category: tc.category ?? null },
        tools,
        total: tools.length,
      },
      options
    )
  );
}

/**
 * `coldsearch tool info <provider.tool>` — full provider-tool profile (offline).
 */
function runToolInfo(options: ExtendedCLIOptions): void {
  const tc = options.toolCommand!;
  const profile = getToolProfile(tc.target!);
  if (!profile) {
    const available = Object.keys(providerToolProfiles).sort().join(", ");
    throw new Error(`Unknown provider tool: '${tc.target}'. Available: ${available}`);
  }

  const info = {
    command: "tool info",
    id: `${profile.provider}.${profile.tool}`,
    provider: profile.provider,
    tool: profile.tool,
    native_name: profile.nativeName,
    description: profile.description,
    categories: profile.categories,
    status: profile.status,
    adapter_method: profile.adapterMethod ?? null,
    docs: profile.docsUrl,
    schema_source: profile.schemaSource,
    schema_last_verified: profile.schemaLastVerified,
    required_params: profile.requiredParams,
    optional_params: profile.optionalParams,
    features: profile.features,
    execution: profile.execution,
    output: profile.output,
    common_views: profile.commonViews,
    cost_notes: profile.costNotes ?? null,
  };

  console.log(formatOutput(info, options));
}

/**
 * Standard utility to read all input from stdin.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
  });
}

/**
 * `coldsearch tool call <provider.tool> --json-input <file-or-stdin>` — execute a tool call.
 */
async function runToolCall(options: ExtendedCLIOptions): Promise<void> {
  const tc = options.toolCommand!;
  const target = tc.target!;
  const parts = target.split(".");
  // Exactly <provider>.<tool> with both segments non-empty: rejects extra dots
  // (`exa.search.extra`) and empty segments (`exa.`, `.search`).
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    const failureResult = {
      provider: parts[0] || "unknown",
      tool: "unknown",
      ok: false,
      catalogued: false,
      summary: null,
      raw: null,
      error: {
        code: "INVALID_TOOL_ID",
        message: `Invalid tool ID: '${target}'. Tool ID must follow the '<provider>.<tool>' format, e.g. exa.search`,
      },
      meta: { duration_ms: 0, safe_key_ref: null, warnings: [] },
    };
    console.log(formatOutput(failureResult, options));
    recordToolPreDispatchFailure(
      options,
      target,
      "INVALID_TOOL_ID",
      `Invalid tool ID: '${target}'. Tool ID must follow the '<provider>.<tool>' format, e.g. exa.search`
    );
    process.exit(1);
    return;
  }

  const [provider, tool] = parts;

  // Read params
  let jsonInputStr = "{}";
  if (options.jsonInput) {
    const trimmedInput = options.jsonInput.trim();
    if (options.jsonInput === "-") {
      jsonInputStr = await readStdin();
    } else if (trimmedInput.startsWith("{") || trimmedInput.startsWith("[")) {
      jsonInputStr = options.jsonInput;
    } else {
      const resolvedPath = path.resolve(options.jsonInput);
      if (fs.existsSync(resolvedPath)) {
        jsonInputStr = fs.readFileSync(resolvedPath, "utf8");
      } else {
        const failureResult = {
          provider,
          tool,
          ok: false,
          catalogued: getToolProfile(target) !== undefined,
          summary: null,
          raw: null,
          error: {
            code: "FILE_NOT_FOUND",
            message: `JSON input file not found: ${options.jsonInput}`,
          },
          meta: { duration_ms: 0, safe_key_ref: null, warnings: [] },
        };
        console.log(formatOutput(failureResult, options));
        recordToolPreDispatchFailure(
          options,
          target,
          "FILE_NOT_FOUND",
          `JSON input file not found: ${options.jsonInput}`
        );
        process.exit(1);
        return;
      }
    }
  }

  let params: Record<string, any> = {};
  if (jsonInputStr.trim()) {
    try {
      params = JSON.parse(jsonInputStr);
    } catch (err: any) {
      const failureResult = {
        provider,
        tool,
        ok: false,
        catalogued: getToolProfile(target) !== undefined,
        summary: null,
        raw: null,
        error: {
          code: "INVALID_JSON",
          message: `Failed to parse JSON input: ${err.message}`,
        },
        meta: { duration_ms: 0, safe_key_ref: null, warnings: [] },
      };
      console.log(formatOutput(failureResult, options));
      recordToolPreDispatchFailure(
        options,
        target,
        "INVALID_JSON",
        // Do not persist err.message: modern Node includes an excerpt of the
        // offending input in JSON.parse errors, which may carry secrets.
        `Failed to parse JSON input: ${err.name ?? "SyntaxError"}`
      );
      process.exit(1);
      return;
    }
  }

  const config = loadConfig(options.config);
  const result = await executeToolCall(provider, tool, params, config, {
    freshness: options.freshness,
    noCache: options.noCache,
  });

  // History/replay notices (failed history writes, ignored --freshness) are
  // observable on stderr as well as in the JSON metadata.
  for (const warning of result.meta.warnings) {
    if (warning.includes("not recorded in history") || warning.includes("--freshness ignored")) {
      console.error(`Warning: ${warning}`);
    }
  }

  console.log(formatOutput(result, options));

  if (!result.ok) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// history / cache commands
// ---------------------------------------------------------------------------

function createHistoryStore(options: ExtendedCLIOptions): HistoryStore {
  const config = loadConfig(options.config);
  return new HistoryStore({ path: config.history?.path });
}

/**
 * Record a pre-dispatch tool-call failure (malformed tool ID, missing input
 * file, unparseable JSON params) that never reached the substrate, so history
 * still holds one failed record per `tool call` invocation. Best-effort: on
 * failure only a non-secret warning is printed — the original error and exit
 * are never masked.
 */
function recordToolPreDispatchFailure(
  options: ExtendedCLIOptions,
  target: string,
  code: string,
  message: string
): void {
  try {
    // Redact once and reuse for both `input` and the errors map key so the two
    // stay consistent — a malformed target can itself carry credential data.
    const safeTarget = redactSensitive(target);
    const record: ExecutionRecord = {
      id: newExecutionId(),
      timestamp: new Date().toISOString(),
      command: "tool",
      input: safeTarget,
      routing: { providers_attempted: [] },
      source: "live",
      attempts: [],
      // Persisted error text is redacted like any other history field —
      // defense in depth, since callers must already avoid passing messages
      // that echo secret-bearing input.
      errors: { [safeTarget]: redactSensitive(message) },
      raw_available: false,
      duration_ms: 0,
      outcome: "failed",
    };
    createHistoryStore(options).append(record);
  } catch (error) {
    console.error(
      `Warning: pre-dispatch tool failure (${code}) was not recorded in history: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function createCacheStore(options: ExtendedCLIOptions): CacheStore {
  const config = loadConfig(options.config);
  return new CacheStore({
    enabled: config.cache?.enabled !== false,
    path: config.cache?.path,
  });
}

/** History listings default to 20 entries; --limit overrides. */
function historyLimit(options: ExtendedCLIOptions): number {
  return options.limitSet ? options.limit : 20;
}

function abbrev(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function summarizeExecution(record: ExecutionRecord) {
  return {
    id: record.id,
    timestamp: record.timestamp,
    command: record.command,
    input: abbrev(record.input, 80),
    providers: record.routing?.providers_attempted ?? record.attempts.map((a) => a.provider),
    source: record.source,
    outcome: record.outcome,
    result_count: record.result_count ?? null,
    duration_ms: record.duration_ms,
    origin_execution_id: record.origin_execution_id ?? undefined,
  };
}

/** JSON when --json/--pretty, human-readable text otherwise. */
function printData(data: unknown, human: string, options: ExtendedCLIOptions): void {
  if (options.json || options.pretty) {
    console.log(formatOutput(data, options));
  } else {
    console.log(human);
  }
}

function formatRecentRow(record: ExecutionRecord): string {
  const providers = (record.routing?.providers_attempted ?? []).join(",") || "-";
  const count = record.result_count !== undefined ? ` results=${record.result_count}` : "";
  return (
    `${record.timestamp}  ${record.id}  ${record.command.padEnd(7)} ` +
    `${record.source.padEnd(5)} ${record.outcome.padEnd(8)} providers=${providers}${count}  ` +
    `"${abbrev(record.input, 60)}"`
  );
}

/**
 * `coldsearch history recent` — what has ColdSearch actually done recently?
 */
function runHistoryRecent(options: ExtendedCLIOptions): void {
  const store = createHistoryStore(options);
  const records = store.recent(historyLimit(options));

  const data = {
    command: "history recent",
    executions: records.map(summarizeExecution),
    total: records.length,
  };
  const human =
    records.length === 0
      ? "No executions recorded yet."
      : records.map(formatRecentRow).join("\n");
  printData(data, human, options);
}

/**
 * `coldsearch history search <query>` — local-only retrieval over prior
 * executions. Zero provider calls; never suppresses a live search.
 */
function runHistorySearch(options: ExtendedCLIOptions): void {
  const hc = options.historyCommand!;
  const store = createHistoryStore(options);
  const matches = searchHistory(store.list(), hc.target!, historyLimit(options));

  const data = {
    command: "history search",
    query: hc.target,
    matches: matches.map((match) => ({
      execution: summarizeExecution(match.execution),
      matched_on: match.matched_on,
      matching_results: match.matching_results,
    })),
    total: matches.length,
  };

  const human =
    matches.length === 0
      ? `No prior executions match "${hc.target}".`
      : matches
          .map((match) => {
            const lines = [
              `${match.execution.timestamp}  ${match.execution.id}  ` +
                `[${match.matched_on.join(", ")}]  "${abbrev(match.execution.input, 60)}"`,
            ];
            for (const result of match.matching_results ?? []) {
              lines.push(
                `    - ${result.title ? `${result.title}  ` : ""}${result.url ?? ""}`.trimEnd()
              );
            }
            return lines.join("\n");
          })
          .join("\n");
  printData(data, human, options);
}

function formatShowHuman(record: ExecutionRecord): string {
  const lines: string[] = [];
  lines.push(`Execution ${record.id}`);
  lines.push(
    `  Request:   ${record.command} "${record.input}" at ${record.timestamp} ` +
      `(${record.source}, ${record.outcome}, ${record.duration_ms}ms)`
  );
  if (record.routing) {
    const routing = record.routing;
    lines.push(
      `  Routing:   strategy=${routing.strategy ?? "-"} ` +
        `requested=${routing.requested_providers?.join(",") ?? "-"} ` +
        `attempted=${routing.providers_attempted?.join(",") ?? "-"}` +
        (routing.reranker ? ` reranker=${routing.reranker}` : "")
    );
  }
  if (record.source === "cache") {
    lines.push(
      `  Cache:     exact replay of ${record.origin_execution_id ?? "unknown origin"} ` +
        `(created=${record.cache?.created_at ?? "unknown"}, age=${record.cache?.age_seconds ?? "?"}s, ` +
        `zero provider calls)`
    );
  }
  for (const attempt of record.attempts) {
    const status = attempt.success ? "ok" : `FAILED: ${attempt.error ?? "unknown error"}`;
    lines.push(
      `  Attempt:   ${attempt.provider}${attempt.tool ? `.${attempt.tool}` : ""} ${status}` +
        (attempt.duration_ms !== undefined ? ` (${attempt.duration_ms}ms)` : "") +
        (attempt.result_count !== undefined ? ` results=${attempt.result_count}` : "") +
        (attempt.key_ref ? ` key=${attempt.key_ref}` : "")
    );
  }
  if (record.result === undefined || record.result === null) {
    lines.push(`  Result:    (no result recorded)`);
  } else if (Array.isArray(record.result)) {
    const shown = record.result.slice(0, 10);
    for (const [index, item] of shown.entries()) {
      const row = item as Record<string, unknown> | null;
      const title = row && typeof row.title === "string" ? row.title : "";
      const url = row && typeof row.url === "string" ? row.url : "";
      lines.push(`  Result[${index}]: ${[title, url].filter(Boolean).join("  ")}`.trimEnd());
    }
    if (record.result.length > 10) {
      lines.push(`  ... +${record.result.length - 10} more results`);
    }
  } else {
    // Non-array result (extracted document, merged object, ...): bounded
    // pretty-print so the main reconstruction data stays readable inline.
    const pretty = JSON.stringify(record.result, null, 2);
    const bounded = pretty.length > 600 ? `${pretty.slice(0, 597)}...` : pretty;
    lines.push(`  Result:\n${bounded.split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
  if (record.errors) {
    for (const [provider, message] of Object.entries(record.errors)) {
      lines.push(`  Error:     ${provider}: ${message}`);
    }
  }
  lines.push(`  Raw detail: ${record.raw_available ? "preserved (use --json to view)" : "unavailable"}`);
  return lines.join("\n");
}

/**
 * `coldsearch history show <execution-id>` [--by-provider]
 */
function runHistoryShow(options: ExtendedCLIOptions): void {
  const hc = options.historyCommand!;
  const store = createHistoryStore(options);
  const record = store.get(hc.target!);
  if (!record) {
    throw new Error(`No execution found with id '${hc.target}'.`);
  }

  if (hc.byProvider) {
    const partitions = record.partitions ?? {};
    const urlsByProvider = new Map<string, Set<string>>();
    for (const [providerName, results] of Object.entries(partitions)) {
      urlsByProvider.set(providerName, new Set(results.map((r) => r.url)));
    }
    const urlCounts = new Map<string, number>();
    for (const urls of urlsByProvider.values()) {
      for (const url of urls) {
        urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
      }
    }

    const providers = Object.entries(partitions).map(([providerName, results]) => ({
      provider: providerName,
      attempt: record.attempts.find((a) => a.provider === providerName) ?? null,
      result_count: results.length,
      results,
    }));
    const uniquePerProvider: Record<string, number> = {};
    for (const [providerName, urls] of urlsByProvider) {
      uniquePerProvider[providerName] = [...urls].filter(
        (url) => (urlCounts.get(url) ?? 0) === 1
      ).length;
    }

    const data = {
      command: "history show --by-provider",
      id: record.id,
      providers,
      failed_attempts: record.attempts.filter((a) => !a.success),
      merged: record.result ?? null,
      url_overlap: {
        shared_urls: [...urlCounts.values()].filter((count) => count > 1).length,
        unique_urls_per_provider: uniquePerProvider,
      },
    };

    const lines: string[] = [`Execution ${record.id} — provider partitions (pre-merge)`];
    for (const provider of providers) {
      lines.push(`  ${provider.provider} (${provider.result_count} results):`);
      for (const result of provider.results) {
        lines.push(`    - ${result.title}  ${result.url}`);
      }
    }
    for (const attempt of data.failed_attempts) {
      lines.push(`  ${attempt.provider}: FAILED: ${attempt.error ?? "unknown error"}`);
    }
    lines.push(
      `  URL overlap: ${data.url_overlap.shared_urls} shared; ` +
        Object.entries(uniquePerProvider)
          .map(([p, n]) => `${p}=${n} unique`)
          .join(", ")
    );
    lines.push(`  Merged result: ${Array.isArray(record.result) ? record.result.length : 0} results (use --json to view)`);
    printData(data, lines.join("\n"), options);
    return;
  }

  printData(record, formatShowHuman(record), options);
}

/**
 * `coldsearch history clear --all` — explicit, operator-controlled deletion of
 * all history records. Replay-cache material is left untouched.
 */
function runHistoryClear(options: ExtendedCLIOptions): void {
  const hc = options.historyCommand!;
  if (!hc.all) {
    throw new Error("'history clear' deletes all local execution history and requires --all to confirm.");
  }
  const store = createHistoryStore(options);
  const removed = store.clear();
  printData(
    { command: "history clear", removed },
    `Removed ${removed} execution record(s) from history.`,
    options
  );
}

function runHistoryCommand(options: ExtendedCLIOptions): void {
  const sub = options.historyCommand!.sub;
  if (sub === "recent") runHistoryRecent(options);
  else if (sub === "search") runHistorySearch(options);
  else if (sub === "show") runHistoryShow(options);
  else runHistoryClear(options);
}

/**
 * `coldsearch cache stats` — describe replay-cache storage (not research
 * history counts).
 */
function runCacheStats(options: ExtendedCLIOptions): void {
  const store = createCacheStore(options);
  const stats = store.stats();

  const data = { command: "cache stats", ...stats };
  const lines = [
    `Replay cache at ${stats.path}`,
    `  Entries: ${stats.total_entries} (${stats.total_bytes} bytes, ${stats.expired_entries} expired)`,
  ];
  for (const [capability, perCap] of Object.entries(stats.capabilities)) {
    lines.push(`  ${capability}: ${perCap.entries} entries (${perCap.bytes} bytes)`);
  }
  if (stats.oldest_created_at) {
    lines.push(`  Oldest: ${stats.oldest_created_at}  Newest: ${stats.newest_created_at}`);
  }
  printData(data, lines.join("\n"), options);
}

/**
 * `coldsearch cache clear` — remove replay-cache material only. History
 * records are never touched.
 */
function runCacheClear(options: ExtendedCLIOptions): void {
  const store = createCacheStore(options);
  const result = store.clear();

  printData(
    {
      command: "cache clear",
      removed: result.removed,
      errors: result.errors.length > 0 ? result.errors : undefined,
    },
    `Removed ${result.removed} replay-cache entr${result.removed === 1 ? "y" : "ies"}.` +
      (result.errors.length > 0 ? ` (${result.errors.length} removal error(s))` : ""),
    options
  );
}

function runCacheCommand(options: ExtendedCLIOptions): void {
  if (options.cacheCommand!.sub === "stats") runCacheStats(options);
  else runCacheClear(options);
}

/**
 * `coldsearch batch` — resumable JSONL runner for search/extract/crawl and
 * provider-tool records. Each item executes through the same backend / tool
 * substrate as the standalone command (same routing, cache, and history
 * behavior); the output JSONL is batch's own append-only artifact.
 */
async function runBatchMode(options: ExtendedCLIOptions): Promise<void> {
  const batch = options.batch!;
  const summary = await runBatch({
    input: batch.input!,
    output: batch.output!,
    concurrency: batch.concurrency ?? 1,
    retryErrors: batch.retryErrors === true,
    configPath: options.config,
    dryRun: options.dryRun === true,
  });

  const human = summary.dry_run
    ? [
        `Dry run: ${summary.to_execute} to execute, ${summary.skipped} skipped, ${summary.conflicts} conflict(s)`,
        ...(summary.records ?? []).map(
          (r) =>
            `  ${r.action === "execute" ? "execute" : r.action === "conflict" ? "conflict" : `skip (${r.reason})`}  ${r.id}  ${r.capability ?? r.tool}`
        ),
      ].join("\n")
    : `Batch complete: ${summary.executed} executed (${summary.succeeded} succeeded, ${summary.failed} failed), ${summary.skipped} skipped, ${summary.conflicts} conflict(s); output: ${summary.output}`;
  printData({ command: "batch", ...summary }, human, options);

  // A batch that finished but had failing items or newly emitted duplicate-ID
  // conflicts still signals failure to scripts, without ever aborting sibling
  // items. Conflicts from prior runs are skipped on resume (resume-conflict)
  // and do not re-flag, so reruns stay deterministic.
  if (!summary.dry_run && ((summary.failed ?? 0) > 0 || summary.conflicts > 0)) {
    process.exitCode = 1;
  }
}

/**
 * Main CLI entry point.
 */
async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);

    if (args.length === 0) {
      printHelp();
      process.exit(1);
    }

    const options = parseArgs(args);

    if (options.toolCommand) {
      if (options.toolCommand.sub === "list") {
        runToolList(options);
      } else if (options.toolCommand.sub === "info") {
        runToolInfo(options);
      } else {
        await runToolCall(options);
      }
      return;
    }

    if (options.historyCommand) {
      runHistoryCommand(options);
      return;
    }

    if (options.cacheCommand) {
      runCacheCommand(options);
      return;
    }

    if (options.configCommand) {
      if (options.configCommand.sub === "init") {
        runConfigInit(options);
      } else {
        runConfigDoctor(options);
      }
      return;
    }

    if (options.batch) {
      await runBatchMode(options);
      return;
    }

    if (options.status) {
      await runStatus(options);
      return;
    }

    if (!options.query.trim()) {
      console.error("Error: Query/URL is required");
      printHelp();
      process.exit(1);
    }

    // Route to appropriate mode
    if (options.agent) {
      await runAgentMode(options);
    } else if (options.command === "extract") {
      await runExtractMode(options);
    } else if (options.command === "crawl") {
      await runCrawlMode(options);
    } else {
      await runFanoutMode(options);
    }
  } catch (error) {
    // Classify the error next to (never replacing) the original message so
    // operators and scripts get a machine-readable category on stderr.
    const { category, message } = classifyError(error);
    console.error(`Error (${category}): ${message}`);
    process.exit(1);
  }
}

main();

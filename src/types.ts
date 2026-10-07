/**
 * Normalized search result schema.
 * All adapters must normalize their provider-specific responses to this shape.
 */
export interface NormalizedResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
  source: string;
}

export interface ExtractResult {
  content: string;
  url: string;
  title?: string;
  source: string;
}

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
}

export type CapabilityName = "search" | "extract" | "crawl";

export interface AdapterCallOptions {
  providerOptions?: Record<string, unknown>;
}

export interface CrawlCallOptions extends AdapterCallOptions {
  limit?: number;
}

export interface SearchAdapter {
  name: string;
  capabilities: CapabilityName[];
  search(
    query: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<NormalizedResult[]>;
  extract?(
    url: string,
    apiKey: string,
    options?: AdapterCallOptions
  ): Promise<ExtractResult>;
  crawl?(
    url: string,
    apiKey: string,
    options?: CrawlCallOptions
  ): Promise<CrawlResult[]>;
}

export interface KeyPool {
  /** Explicit key references, e.g. doppler:TAVILY_API_KEY or env:TAVILY_API_KEY */
  keys?: string[];
  /** Override the provider default Doppler secret name when keys is empty */
  defaultSecretName?: string;
  strategy?: "round-robin" | "random";
}

export interface ProviderConfig {
  keyPool: KeyPool;
  options?: Record<string, unknown>;
}

export interface CapabilityConfig {
  providers: string[];
  strategy?: "all" | "random";
}

export interface Config {
  capabilities: Record<string, CapabilityConfig>;
  providers: Record<string, ProviderConfig>;
  logging?: {
    usage?: {
      path?: string;
    };
  };
  cache?: {
    enabled?: boolean;
    search_ttl?: string;
    extract_ttl?: string;
    /** TTL for explicitly replay-safe provider-tool results. */
    tool_ttl?: string;
    path?: string;
  };
  history?: {
    path?: string;
  };
  agent?: {
    /** OpenAI-compatible agent LLM endpoint config (CLI flags override these). */
    llm?: {
      provider?: string;
      model?: string;
      baseUrl?: string;
      reasoningEffort?: import("./agent/llm.js").ReasoningEffort;
      keyRef?: string;
    };
  };
}

/**
 * Machine-readable error categories for status/doctor output and user-facing
 * CLI errors. A category is added NEXT TO the original message — it never
 * replaces the underlying error text.
 */
export type ErrorCategory =
  | "config"
  | "credentials"
  | "network"
  | "provider"
  | "unsupported_capability"
  | "unsupported_tool";

export interface CLIOptions {
  command?: "search" | "extract" | "crawl";
  query: string;
  limit: number;
  pretty: boolean;
  json: boolean;
  config?: string;
  singleProvider?: boolean;
  /** Explicit agent run ID (agent mode only); generated when absent. */
  runId?: string;
  /** `coldsearch batch` resumable JSONL runner options. */
  batch?: {
    input?: string;
    output?: string;
    concurrency?: number;
    retryErrors?: boolean;
  };
}

/**
 * ColdSearch category views over heterogeneous provider tools.
 *
 * A category is a portable user/agent intent ("search this", "extract this
 * URL"). It is NOT a 1:1 provider feature. Several provider-native tools with
 * different parameter surfaces and semantics may back the same category, and a
 * single provider tool may back more than one category. `CapabilityName` (the
 * subset that is actually routed through adapters today) stays a strict subset
 * of `CapabilityCategory` for backward compatibility.
 */
export type CapabilityCategory =
  | "search"
  | "extract"
  | "crawl"
  | "map"
  | "research"
  | "answer";

/** Where a provider tool's parameter schema came from, and how trustworthy it is. */
export type SchemaSource = "official-docs" | "official-mcp" | "sdk" | "handwritten";

/** How a provider tool executes against the upstream API. */
export type ToolExecutionMode = "sync" | "async-job" | "streaming";

/** How faithfully a provider tool can back a given ColdSearch category view. */
export type SemanticFit = "direct" | "partial" | "derived" | "not-recommended";

/**
 * How a provider tool is exposed through ColdSearch today.
 * - `wired`     — implemented as an adapter-backed normalized category tool.
 * - `direct`    — implemented and callable through `tool call`, but deliberately
 *                 not a normalized category backer.
 * - `available` — upstream API exists and the profile is documented, but it is
 *                 not implemented yet.
 * - `deferred`  — intentionally not built (niche vertical or high-risk action).
 */
export type ToolWiringStatus = "wired" | "direct" | "available" | "deferred";

/** Shape of the envelope a tool's result is normalized/preserved into. */
export type ToolResultEnvelope =
  | "search"
  | "extract"
  | "crawl"
  | "map"
  | "research"
  | "answer"
  | "job"
  | "raw";

/**
 * How a specific provider tool maps onto one ColdSearch category view. This is
 * the durable record of safe, lossy, and unsupported option mappings. A mapping
 * is allowed to be partial — partial support is acceptable, but it must be
 * explicit. Do not add a tool to a category merely because the provider uses a
 * familiar name.
 */
export interface CommonViewMapping {
  category: CapabilityCategory;
  semanticFit: SemanticFit;
  /** ColdSearch common option -> provider-native parameter (or expression). */
  mapsCommonOptions: Record<string, string>;
  /** Common options this tool cannot honor at all. */
  unsupportedCommonOptions: string[];
  /** Mappings accepted but lossy/approximate, with the reason recorded. */
  lossyMappings?: { commonOption: string; reason: string }[];
  /** Provider-native options that have no common-view equivalent. */
  nativeOptionsWithoutCommonEquivalent?: string[];
  notes?: string;
}

/**
 * Durable metadata for a single provider-native tool exposed (or documented as
 * exposable) through ColdSearch. This is the missing design layer: it records
 * what `capabilities: [...]` cannot — the native parameter surface, the
 * common-view mappings, feature predicates for requirement-aware routing, and
 * execution/output semantics.
 */
export interface ProviderToolProfile {
  /** Registry provider key (e.g. "exa", "firecrawl"). */
  provider: string;
  /** ColdSearch-facing tool id, unique per provider (e.g. "search", "scrape"). */
  tool: string;
  /** Provider docs/API name (e.g. "POST /search", "POST /contents"). */
  nativeName: string;
  /** ColdSearch category views this tool can back. */
  categories: CapabilityCategory[];
  description: string;
  docsUrl: string;

  requiredParams: string[];
  optionalParams: string[];

  /** One entry per category this tool can back. */
  commonViews: CommonViewMapping[];

  /**
   * Feature predicates for requirement-aware routing. Routing must be able to
   * filter on these instead of relying only on broad category membership.
   */
  features: Record<string, boolean>;

  execution: {
    mode: ToolExecutionMode;
    supportsWait?: boolean;
    supportsPolling?: boolean;
    jobIdField?: string;
  };

  output: {
    /** ColdSearch must always preserve the raw provider payload. */
    rawPreserved: true;
    summarySupported: boolean;
    resultEnvelope: ToolResultEnvelope;
  };

  schemaSource: SchemaSource;
  /** YYYY-MM-DD the native schema was last verified against provider docs. */
  schemaLastVerified: string;

  status: ToolWiringStatus;
  /** For wired tools: the adapter method that backs this tool. */
  adapterMethod?: "search" | "extract" | "crawl" | "findSimilar";
  /** Optional free-form cost/latency guidance surfaced by `tool info`. */
  costNotes?: string;
}

/**
 * Requirements a caller can impose on a category so routing stays
 * requirement-aware instead of "any provider that claims the category".
 */
export interface CategoryRequirements {
  /** Feature predicate flags that an eligible tool must set to `true`. */
  requireFeatures?: string[];
}

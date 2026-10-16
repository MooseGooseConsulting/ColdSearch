import type {
  CapabilityCategory,
  CategoryRequirements,
  ProviderToolProfile,
} from "../types.js";

/**
 * Provider tool profile registry.
 *
 * This is the durable record the crude `capabilities: ["search","extract",
 * "crawl"]` tuple cannot hold: each provider-native tool's parameter surface,
 * how it maps onto ColdSearch category views, feature predicates for
 * requirement-aware routing, and execution/output semantics.
 *
 * Keys are `"<provider>.<tool>"`. `tool` is the ColdSearch-facing operation id
 * and is intentionally NOT always the provider's native name — for example
 * Firecrawl `scrape` backs ColdSearch `extract`, while Firecrawl's own
 * `extract` endpoint is a structured-LLM tool that is a different thing.
 *
 * `schemaLastVerified` reflects the date the native parameter list below was
 * reconciled against the provider docs linked in `docsUrl`.
 */

const VERIFIED = "2026-06-26";
/** Profiles re-verified against current provider docs on 2026-10-07. */
const REVERIFIED = "2026-10-07";

function deferredCandidateProfile(
  provider: string,
  tool: string,
  nativeName: string,
  category: CapabilityCategory,
  docsUrl: string
): ProviderToolProfile {
  return {
    provider,
    tool,
    nativeName: `Candidate ${nativeName} (unverified)`,
    categories: [category],
    description:
      "Unverified provider-tool candidate. The endpoint and parameter schema " +
      "must be confirmed from authoritative docs or an authenticated request " +
      "before implementation.",
    docsUrl,
    requiredParams: [],
    optionalParams: [],
    commonViews: [
      {
        category,
        semanticFit: "not-recommended",
        mapsCommonOptions: {},
        unsupportedCommonOptions: [],
        notes: "The route and native parameter schema are unverified; do not route as a supported tool.",
      },
    ],
    features: {},
    execution: { mode: "sync" },
    output: { rawPreserved: true, summarySupported: false, resultEnvelope: "raw" },
    schemaSource: "handwritten",
    schemaLastVerified: null,
    status: "deferred",
  };
}

function directPassThroughProfile(
  provider: string,
  tool: string,
  nativeName: string,
  docsUrl: string
): ProviderToolProfile {
  return {
    provider,
    tool,
    nativeName,
    categories: ["research"],
    description:
      "Direct provider-native JSON pass-through. ColdSearch preserves the " +
      "response without validating the request schema or normalizing the result.",
    docsUrl,
    requiredParams: [],
    optionalParams: [],
    commonViews: [
      {
        category: "research",
        semanticFit: "not-recommended",
        mapsCommonOptions: {},
        unsupportedCommonOptions: [],
        notes: "Provider-native request and response; no normalized research mapping.",
      },
    ],
    features: {},
    execution: { mode: "sync" },
    output: { rawPreserved: true, summarySupported: false, resultEnvelope: "raw" },
    schemaSource: "handwritten",
    schemaLastVerified: null,
    status: "direct",
  };
}

export const providerToolProfiles: Record<string, ProviderToolProfile> = {
  // ── Exa ────────────────────────────────────────────────────────────────
  "exa.search": {
    provider: "exa",
    tool: "search",
    nativeName: "POST /search",
    categories: ["search", "research"],
    description:
      "Unified web search behind one endpoint. The `type` knob spans " +
      "instant/fast/auto/deep-lite/deep/deep-reasoning, so the same tool covers " +
      "fast retrieval and research-grade reasoning. Content can be attached " +
      "directly via `contents`. Category enum current as of 2026-10: company, " +
      "people, publication (replaced research paper), news, personal site, " +
      "financial report; pdf/github/tweet deprecated. `livecrawl` is deprecated " +
      "upstream. On `/search`, freshness uses `contents.maxAgeHours` " +
      "(0=always fetch, -1=cache-only) and `contents.livecrawlTimeout`; " +
      "`/contents` uses top-level `maxAgeHours`.",
    docsUrl: "https://exa.ai/docs/reference/search",
    requiredParams: ["query"],
    optionalParams: [
      "type",
      "numResults",
      "includeDomains",
      "excludeDomains",
      "startPublishedDate",
      "endPublishedDate",
      "contents.maxAgeHours",
      "contents.livecrawlTimeout",
      "category",
      "contents",
      "additionalQueries",
      "outputSchema",
      "systemPrompt",
      "userLocation",
      "moderation",
      "objective",
      "userIdentifier",
      "compliance",
      "stream",
    ],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: {
          limit: "numResults",
          includeDomains: "includeDomains",
          excludeDomains: "excludeDomains",
          freshness: "startPublishedDate/endPublishedDate (startCrawlDate/endCrawlDate are ignored upstream)",
          includeContent: "contents.text/highlights",
        },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: [
          "type",
          "additionalQueries",
          "outputSchema",
          "systemPrompt",
          "category",
          "moderation",
          "objective",
          "compliance",
          "stream",
        ],
        notes:
          "`type` is not a portable knob: deep-lite/deep/deep-reasoning are not " +
          "equivalent to a normal SERP search and should not be flattened into one.",
      },
      {
        category: "research",
        semanticFit: "partial",
        mapsCommonOptions: { question: "query" },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["type", "additionalQueries", "outputSchema"],
        notes: "Research lives behind `type=deep`/`deep-reasoning` on the same endpoint.",
      },
    ],
    features: {
      rankedLinks: true,
      integratedContent: true,
      structuredOutput: true,
      deepResearch: true,
      domainFilters: true,
      dateFilters: true,
      highlights: true,
      vertical: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: "2026-10-11",
    status: "wired",
    adapterMethod: "search",
  },
  "exa.contents": {
    provider: "exa",
    tool: "contents",
    nativeName: "POST /contents",
    categories: ["extract", "crawl"],
    description:
      "Known-URL / known-id content retrieval with optional livecrawl, " +
      "highlights, summaries, and limited linked-subpage retrieval. ColdSearch " +
      "uses it for `extract` and synthesizes `crawl` from discovery + contents.",
    docsUrl: "https://exa.ai/docs/reference/contents-api-guide-for-coding-agents",
    requiredParams: ["urls"],
    optionalParams: [
      "ids",
      "text",
      "highlights",
      "summary",
      "maxAgeHours",
      "livecrawlTimeout",
      "snapshotAsOf",
      "subpages",
      "subpageTarget",
      "extras",
      "userIdentifier",
      "compliance",
    ],
    commonViews: [
      {
        category: "extract",
        semanticFit: "direct",
        mapsCommonOptions: { url: "urls", includeContent: "text/highlights/summary" },
        unsupportedCommonOptions: ["javascriptActions"],
        nativeOptionsWithoutCommonEquivalent: ["subpages", "subpageTarget", "maxAgeHours", "snapshotAsOf"],
        notes: "`maxAgeHours: 0` forces livecrawl; `-1` is cache-only.",
      },
      {
        category: "crawl",
        semanticFit: "derived",
        mapsCommonOptions: { limit: "subpages" },
        unsupportedCommonOptions: ["depth", "crawlEntireDomain"],
        notes:
          "`subpages` is limited linked-page retrieval, NOT a real crawler; " +
          "ColdSearch crawl is synthesized via discovery + contents.",
      },
    ],
    features: {
      knownUrl: true,
      integratedContent: true,
      highlights: true,
      cacheControl: true,
      structuredJson: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "extract" },
    schemaSource: "official-docs",
    schemaLastVerified: REVERIFIED,
    status: "wired",
    adapterMethod: "extract",
  },
  "exa.findSimilar": {
    provider: "exa",
    tool: "findSimilar",
    nativeName: "POST /findSimilar",
    categories: ["search"],
    description:
      "DEPRECATED upstream (OpenAPI-marked; absent from the current reference " +
      "sidebar) in favor of describing the source page in /search. Still " +
      "callable as of 2026-10. Semantic neighbors of a known URL (unique to Exa). " +
      "Reachable via the adapter method; not yet a CLI category command.",
    docsUrl: "https://exa.ai/docs/reference/find-similar-links",
    requiredParams: ["url"],
    optionalParams: ["numResults", "includeDomains", "excludeDomains", "contents"],
    commonViews: [
      {
        category: "search",
        semanticFit: "derived",
        mapsCommonOptions: { limit: "numResults" },
        unsupportedCommonOptions: ["query"],
        notes: "Input is a seed URL, not a query string.",
      },
    ],
    features: { rankedLinks: true, semanticNeighbors: true, domainFilters: true },
    execution: { mode: "sync" },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "findSimilar",
  },
  "exa.answer": {
    provider: "exa",
    tool: "answer",
    nativeName: "POST /answer",
    categories: ["answer"],
    description: "Answer generation over web search; distinct from raw search.",
    docsUrl: "https://exa.ai/docs/reference/answer",
    requiredParams: ["query"],
    optionalParams: ["stream", "text", "outputSchema"],
    commonViews: [
      {
        category: "answer",
        semanticFit: "direct",
        mapsCommonOptions: { question: "query" },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["outputSchema", "stream"],
      },
    ],
    features: { synthesizedAnswer: true, structuredOutput: true },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "answer" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "available",
  },

  // ── Tavily ─────────────────────────────────────────────────────────────
  "tavily.search": {
    provider: "tavily",
    tool: "search",
    nativeName: "POST /search",
    categories: ["search"],
    description:
      "Web search with optional answer synthesis and raw content. " +
      "`search_depth` (ultra-fast/fast/basic/advanced) is NOT equivalent to Exa " +
      "`type`; `advanced` returns multiple chunks per source.",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    requiredParams: ["query"],
    optionalParams: [
      "search_depth",
      "chunks_per_source",
      "max_results",
      "topic",
      "time_range",
      "start_date",
      "end_date",
      "include_answer",
      "include_raw_content",
      "include_images",
      "include_domains",
      "exclude_domains",
      "include_domains_mode",
      "country",
      "language",
      "auto_parameters",
      "exact_match",
      "safe_search",
    ],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: {
          limit: "max_results",
          includeDomains: "include_domains",
          excludeDomains: "exclude_domains",
          freshness: "time_range / start_date+end_date",
          // 1:1 scalar date filter (day|week|month|year) for the dispatch-layer
          // `timeRange` common option; the `freshness` expression above mixes in
          // start_date+end_date and is not forwarded verbatim.
          timeRange: "time_range",
          includeContent: "include_raw_content or advanced chunks",
        },
        commonOptionValueMappings: {
          timeRange: { day: "d", week: "w", month: "m", year: "y" },
        },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["topic", "search_depth", "auto_parameters"],
        notes: "`topic` (general/news/finance) is an eligibility constraint, not a portable param.",
      },
    ],
    features: {
      rankedLinks: true,
      integratedContent: true,
      synthesizedAnswer: true,
      domainFilters: true,
      dateFilters: true,
      vertical: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: "2026-10-11",
    status: "wired",
    adapterMethod: "search",
  },
  "tavily.extract": {
    provider: "tavily",
    tool: "extract",
    nativeName: "POST /extract",
    categories: ["extract"],
    description:
      "Known-URL extraction. `extract_depth` is basic|advanced; optional `query` " +
      "reranks/focuses chunks. Output format is markdown or text.",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/extract",
    requiredParams: ["urls"],
    optionalParams: [
      "query",
      "chunks_per_source",
      "extract_depth",
      "include_images",
      "include_favicon",
      "format",
      "timeout",
      "include_usage",
      "type",
    ],
    commonViews: [
      {
        category: "extract",
        semanticFit: "direct",
        mapsCommonOptions: { url: "urls", format: "format" },
        unsupportedCommonOptions: ["javascriptActions", "screenshots"],
        nativeOptionsWithoutCommonEquivalent: ["query", "extract_depth"],
      },
    ],
    features: { knownUrl: true, structuredJson: false, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "extract" },
    schemaSource: "official-docs",
    schemaLastVerified: REVERIFIED,
    status: "wired",
    adapterMethod: "extract",
  },
  "tavily.crawl": {
    provider: "tavily",
    tool: "crawl",
    nativeName: "POST /crawl",
    categories: ["crawl"],
    description:
      "Semantic/goal-directed site traversal. `instructions` can guide what " +
      "content to find; crawl returns extracted content, not only URLs.",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/crawl",
    requiredParams: ["url"],
    optionalParams: [
      "instructions",
      "max_depth",
      "max_breadth",
      "limit",
      "select_paths",
      "select_domains",
      "exclude_paths",
      "exclude_domains",
      "allow_external",
      "extract_depth",
      "format",
      "timeout",
      "chunks_per_source",
      "include_images",
      "include_favicon",
      "include_usage",
      "type",
    ],
    commonViews: [
      {
        category: "crawl",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url", limit: "limit", depth: "max_depth" },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["instructions", "max_breadth", "allow_external", "include_usage"],
      },
    ],
    features: { semanticTraversal: true, urlDiscovery: false, integratedContent: true },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "crawl" },
    schemaSource: "official-docs",
    schemaLastVerified: REVERIFIED,
    status: "wired",
    adapterMethod: "crawl",
  },
  "tavily.map": {
    provider: "tavily",
    tool: "map",
    nativeName: "POST /map",
    categories: ["map"],
    description:
      "URL discovery / site mapping. Same traversal controls as crawl but " +
      "returns URLs, not extracted page content.",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/map",
    requiredParams: ["url"],
    optionalParams: [
      "instructions",
      "max_depth",
      "max_breadth",
      "limit",
      "select_paths",
      "select_domains",
      "exclude_paths",
      "exclude_domains",
      "allow_external",
      "timeout",
    ],
    commonViews: [
      {
        category: "map",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url", limit: "limit", depth: "max_depth" },
        unsupportedCommonOptions: ["includeContent"],
        notes: "Returns URLs only; not page content. Do not route content requests here.",
      },
    ],
    features: { urlDiscovery: true, semanticTraversal: true, integratedContent: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "map" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "tavily.research": {
    provider: "tavily",
    tool: "research",
    nativeName: "POST /research",
    categories: ["research"],
    description:
      "Explicit research task/report surface. `model` is mini|pro|auto; supports " +
      "files and citation formats.",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/research",
    requiredParams: ["input"],
    optionalParams: [
      "model",
      "stream",
      "output_schema",
      "citation_format",
      "include_domains",
      "exclude_domains",
      "output_length",
      "files",
    ],
    commonViews: [
      {
        category: "research",
        semanticFit: "direct",
        mapsCommonOptions: {
          question: "input",
          includeDomains: "include_domains",
          excludeDomains: "exclude_domains",
        },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["model", "citation_format", "files"],
      },
    ],
    features: { deepResearch: true, synthesizedAnswer: true, structuredOutput: true, domainFilters: true },
    execution: { mode: "async-job", supportsPolling: true, supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "research" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "available",
  },
  "tavily.answer": {
    provider: "tavily",
    tool: "answer",
    nativeName: "POST /search (include_answer)",
    categories: ["answer"],
    description: "One-shot answer + citations derived from a search.",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
    requiredParams: ["query"],
    optionalParams: ["include_answer", "include_domains", "exclude_domains", "topic"],
    commonViews: [
      {
        category: "answer",
        semanticFit: "partial",
        mapsCommonOptions: { question: "query" },
        unsupportedCommonOptions: [],
        notes: "Answer is a flag on /search, not a separate endpoint.",
      },
    ],
    features: { synthesizedAnswer: true, domainFilters: true },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "answer" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "available",
  },

  // ── Firecrawl ──────────────────────────────────────────────────────────
  "firecrawl.search": {
    provider: "firecrawl",
    tool: "search",
    nativeName: "POST /search",
    categories: ["search"],
    description:
      "Web search with optional per-result scrape. `scrapeOptions` can fetch and " +
      "format each result; `sources`/`categories` select web/images/news and " +
      "GitHub/research/PDF.",
    docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/search",
    requiredParams: ["query"],
    optionalParams: [
      "limit",
      "sources",
      "categories",
      "includeDomains",
      "excludeDomains",
      "tbs",
      "location",
      "country",
      "timeout",
      "scrapeOptions",
    ],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: {
          limit: "limit",
          includeDomains: "includeDomains",
          excludeDomains: "excludeDomains",
          freshness: "tbs",
          includeContent: "scrapeOptions",
        },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["sources", "categories", "scrapeOptions"],
      },
    ],
    features: {
      rankedLinks: true,
      integratedContent: true,
      domainFilters: true,
      dateFilters: true,
      vertical: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "search",
  },
  "firecrawl.scrape": {
    provider: "firecrawl",
    tool: "scrape",
    nativeName: "POST /scrape",
    categories: ["extract"],
    description:
      "Known-URL page scrape with a heavy browser surface: markdown/HTML/raw/JSON, " +
      "screenshots, links, actions (click/scroll/type/screenshot/JS), proxy, PII " +
      "redaction, cache control. This — NOT Firecrawl `extract` — backs ColdSearch " +
      "`extract`.",
    docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/scrape",
    requiredParams: ["url"],
    optionalParams: [
      "formats",
      "onlyMainContent",
      "includeTags",
      "excludeTags",
      "maxAge",
      "headers",
      "waitFor",
      "mobile",
      "timeout",
      "parsers",
      "actions",
      "location",
      "blockAds",
      "proxy",
      "storeInCache",
      "removeBase64Images",
    ],
    commonViews: [
      {
        category: "extract",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url", format: "formats", includeContent: "formats" },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["actions", "proxy", "screenshot", "parsers"],
        notes: "Firecrawl's native `extract` endpoint is a different (structured-LLM) tool.",
      },
    ],
    features: {
      knownUrl: true,
      javascriptRendering: true,
      browserActions: true,
      screenshots: true,
      structuredJson: true,
      cacheControl: true,
      proxyControl: true,
      piiRedaction: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "extract" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "extract",
  },
  "firecrawl.crawl": {
    provider: "firecrawl",
    tool: "crawl",
    nativeName: "POST /crawl (async job, polled)",
    categories: ["crawl"],
    description:
      "Production crawl job with strong operational controls: sitemap/robots " +
      "behavior, concurrency, delay, webhook, regex matching, subdomain/external " +
      "policy, nested scrape options.",
    docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/crawl-post",
    requiredParams: ["url"],
    optionalParams: [
      "prompt",
      "excludePaths",
      "includePaths",
      "maxDiscoveryDepth",
      "sitemap",
      "ignoreQueryParameters",
      "limit",
      "crawlEntireDomain",
      "allowExternalLinks",
      "allowSubdomains",
      "delay",
      "maxConcurrency",
      "webhook",
      "scrapeOptions",
    ],
    commonViews: [
      {
        category: "crawl",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url", limit: "limit", depth: "maxDiscoveryDepth" },
        unsupportedCommonOptions: [],
        nativeOptionsWithoutCommonEquivalent: ["webhook", "maxConcurrency", "delay", "scrapeOptions"],
        notes:
          "The adapter honors a `formats` array from [providers.firecrawl.options] " +
          "as scrapeOptions.formats (text aliases markdown; values are validated against markdown|html|rawHtml|links|" +
          "screenshot|json; default [markdown]).",
      },
    ],
    features: { semanticTraversal: false, urlDiscovery: true, integratedContent: true, robotsControl: true },
    execution: { mode: "async-job", supportsPolling: true, supportsWait: true, jobIdField: "id" },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "crawl" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "crawl",
  },
  "firecrawl.map": {
    provider: "firecrawl",
    tool: "map",
    nativeName: "POST /map",
    categories: ["map"],
    description:
      "Fast URL discovery. `search` ranks discovered URLs by relevance; `limit` " +
      "can be much larger than typical crawl/map defaults.",
    docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/map",
    requiredParams: ["url"],
    optionalParams: [
      "search",
      "sitemap",
      "includeSubdomains",
      "ignoreQueryParameters",
      "ignoreCache",
      "limit",
      "timeout",
      "location",
    ],
    commonViews: [
      {
        category: "map",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url", limit: "limit" },
        unsupportedCommonOptions: ["includeContent"],
        notes: "Returns URLs only.",
      },
    ],
    features: { urlDiscovery: true, integratedContent: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "map" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "firecrawl.extract": {
    provider: "firecrawl",
    tool: "extract",
    nativeName: "POST /extract",
    categories: ["research"],
    description:
      "Structured LLM extraction from URLs/domains (schema + prompt). NAME COLLISION: " +
      "this is NOT known-URL page scraping. Known-URL retrieval is `firecrawl.scrape`. " +
      "Do not treat this as the ColdSearch `extract` backer.",
    docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/extract",
    requiredParams: ["urls"],
    optionalParams: [
      "prompt",
      "schema",
      "enableWebSearch",
      "ignoreSitemap",
      "includeSubdomains",
      "showSources",
      "scrapeOptions",
      "ignoreInvalidURLs",
    ],
    commonViews: [
      {
        category: "research",
        semanticFit: "partial",
        mapsCommonOptions: { question: "prompt" },
        unsupportedCommonOptions: ["url"],
        notes:
          "Structured extraction over URLs/domains; supports glob URLs and optional " +
          "web search. Maps to `research`, not `extract`.",
      },
    ],
    features: { structuredOutput: true, structuredJson: true, knownUrl: false },
    execution: { mode: "async-job", supportsPolling: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "research" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "available",
  },

  // ── Brave ──────────────────────────────────────────────────────────────
  "brave.webSearch": {
    provider: "brave",
    tool: "webSearch",
    nativeName: "GET /res/v1/web/search",
    categories: ["search"],
    description:
      "Classic SERP-style search API: strong search-operator semantics, " +
      "Goggles/reranking, freshness, snippets, news/video/web filters.",
    docsUrl: "https://api-dashboard.search.brave.com/api-reference/web/search/get",
    requiredParams: ["q"],
    optionalParams: [
      "country",
      "search_lang",
      "ui_lang",
      "count",
      "offset",
      "safesearch",
      "spellcheck",
      "freshness",
      "result_filter",
      "goggles",
      "extra_snippets",
      "summary",
    ],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: { limit: "count", freshness: "freshness" },
        unsupportedCommonOptions: ["includeDomains", "excludeDomains"],
        lossyMappings: [
          {
            commonOption: "includeDomains",
            reason: "No native domain filter; only query/operator workarounds.",
          },
        ],
        nativeOptionsWithoutCommonEquivalent: ["goggles", "result_filter", "extra_snippets"],
      },
    ],
    features: {
      rankedLinks: true,
      integratedContent: false,
      domainFilters: false,
      freshnessControl: true,
      vertical: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "search",
  },
  "brave.llmContext": {
    provider: "brave",
    tool: "llmContext",
    nativeName: "GET /res/v1/llm/context",
    categories: ["search", "research"],
    description:
      "NOT plain SERP search: search plus extracted, relevance-ranked context " +
      "chunks for LLM grounding. Query-based, not arbitrary known-URL extraction. " +
      "Moved from /res/v1/summarizer/llm_context (~2026-02 repackaging); ships " +
      "in the standard Brave Search plan, no longer a separate paid Data-for-AI tier.",
    docsUrl: "https://api-dashboard.search.brave.com/api-reference/",
    requiredParams: ["q"],
    optionalParams: [
      "country",
      "search_lang",
      "count",
      "maximum_number_of_urls",
      "maximum_number_of_tokens",
      "maximum_number_of_snippets",
      "context_threshold_mode",
      "goggles",
      "freshness",
      "enable_local",
    ],
    commonViews: [
      {
        category: "search",
        semanticFit: "partial",
        mapsCommonOptions: { limit: "count", freshness: "freshness" },
        unsupportedCommonOptions: ["includeDomains", "excludeDomains"],
        notes: "Returns context chunks, not a plain SERP result list.",
      },
    ],
    features: { rankedLinks: true, integratedContent: true, freshnessControl: true },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brave.answers": {
    provider: "brave",
    tool: "answers",
    nativeName: "POST /res/v1/chat/completions",
    categories: ["answer"],
    description:
      "OpenAI-compatible web-grounded Answers endpoint. This separate product " +
      "uses the Brave Answers plan and is not wired into normalized routing.",
    docsUrl: "https://api-dashboard.search.brave.com/api-reference/",
    requiredParams: ["messages"],
    optionalParams: ["model", "stream"],
    commonViews: [
      {
        category: "answer",
        semanticFit: "partial",
        mapsCommonOptions: { question: "messages[0].content" },
        unsupportedCommonOptions: ["url"],
        notes: "The endpoint accepts a single user message; response is provider-native.",
      },
    ],
    features: { synthesizedAnswer: true, webGrounding: true },
    execution: { mode: "streaming", supportsWait: true },
    output: { rawPreserved: true, summarySupported: false, resultEnvelope: "answer" },
    schemaSource: "official-docs",
    schemaLastVerified: "2026-10-11",
    status: "direct",
  },
  "brave.newsSearch": deferredCandidateProfile(
    "brave",
    "newsSearch",
    "GET /res/v1/news/search",
    "search",
    "https://api.search.brave.com/app/documentation/"
  ),
  "brave.imageSearch": deferredCandidateProfile(
    "brave",
    "imageSearch",
    "GET /res/v1/images/search",
    "search",
    "https://api.search.brave.com/app/documentation/"
  ),
  "brave.videoSearch": deferredCandidateProfile(
    "brave",
    "videoSearch",
    "GET /res/v1/videos/search",
    "search",
    "https://api.search.brave.com/app/documentation/"
  ),

  // ── Serper ─────────────────────────────────────────────────────────────
  "serper.search": {
    provider: "serper",
    tool: "search",
    nativeName: "POST /search",
    categories: ["search"],
    description: "Google web SERP. Search-only vendor surface in ColdSearch today.",
    // serper.dev/docs 404s; docs live on the homepage demo + login-gated playground.
    docsUrl: "https://serper.dev",
    requiredParams: ["q"],
    optionalParams: ["gl", "hl", "num", "page", "tbs", "location", "autocorrect"],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: { limit: "num", freshness: "tbs" },
        unsupportedCommonOptions: ["includeDomains", "excludeDomains"],
        lossyMappings: [
          { commonOption: "includeDomains", reason: "Only via `site:` query operators." },
        ],
        nativeOptionsWithoutCommonEquivalent: ["gl", "hl", "page"],
      },
    ],
    features: { rankedLinks: true, integratedContent: false, freshnessControl: true, vertical: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: "2026-10-11",
    status: "wired",
    adapterMethod: "search",
  },

  // These Serper surfaces were named in the audit but could not be validated
  // from unauthenticated probes: 403 does not prove a route exists. Keep them
  // visible as deferred candidates without inventing a parameter schema.
  "serper.images": deferredCandidateProfile("serper", "images", "POST /images", "search", "https://serper.dev/"),
  "serper.news": deferredCandidateProfile("serper", "news", "POST /news", "search", "https://serper.dev/"),
  "serper.videos": deferredCandidateProfile("serper", "videos", "POST /videos", "search", "https://serper.dev/"),
  "serper.shopping": deferredCandidateProfile("serper", "shopping", "POST /shopping", "search", "https://serper.dev/"),
  "serper.maps": deferredCandidateProfile("serper", "maps", "POST /maps", "search", "https://serper.dev/"),
  "serper.places": deferredCandidateProfile("serper", "places", "POST /places", "search", "https://serper.dev/"),
  "serper.scholar": deferredCandidateProfile("serper", "scholar", "POST /scholar", "search", "https://serper.dev/"),
  "serper.patents": deferredCandidateProfile("serper", "patents", "POST /patents", "search", "https://serper.dev/"),
  "serper.autocomplete": deferredCandidateProfile("serper", "autocomplete", "POST /autocomplete", "search", "https://serper.dev/"),
  "serper.reviews": deferredCandidateProfile("serper", "reviews", "POST /reviews", "search", "https://serper.dev/"),
  "serper.lens": deferredCandidateProfile("serper", "lens", "POST /lens", "search", "https://serper.dev/"),
  "serper.webpage": deferredCandidateProfile("serper", "webpage", "POST scrape.serper.dev/webpage", "extract", "https://serper.dev/"),
  "serper.shots": deferredCandidateProfile("serper", "shots", "POST scrape.serper.dev/shots", "extract", "https://serper.dev/"),
  "serper.locations": deferredCandidateProfile("serper", "locations", "GET api.serper.dev/locations", "search", "https://serper.dev/"),

  // ── Jina ───────────────────────────────────────────────────────────────
  "jina.reader": {
    provider: "jina",
    tool: "reader",
    nativeName: "GET r.jina.ai",
    categories: ["extract"],
    description:
      "Keyless Reader extraction of a single URL to clean text/markdown. " +
      "X-Respond-With now targets jina-ocr-v1 (~40x output tokens; ReaderLM-v2 " +
      "de-emphasized). Direct calls can set reader headers and select JSON or " +
      "event-stream responses; event streams are preserved as text, not yielded " +
      "incrementally. Local-file POST upload is not exposed by this JSON call.",
    docsUrl: "https://jina.ai/reader",
    requiredParams: ["url"],
    optionalParams: [
      "X-Engine",
      "X-Return-Format",
      "X-Timeout",
      "X-Token-Budget",
      "X-Respond-With",
      "X-Page",
      "X-Target-Selector",
      "X-Wait-For-Selector",
      "X-Remove-Selector",
      "X-Retain-Images",
      "X-Retain-Links",
      "X-With-Links-Summary",
      "X-With-Images-Summary",
      "X-Set-Cookie",
      "X-With-Generated-Alt",
      "X-No-Cache",
      "X-Cache-Tolerance",
      "X-Respond-Timing",
      "X-User-Agent",
      "X-Referer",
      "X-Keep-Img-Data-Url",
      "DNT",
      "X-No-Gfm",
      "X-Locale",
      "X-Robots-Txt",
      "X-With-Iframe",
      "X-With-Shadow-Dom",
      "X-Base",
      "Accept",
    ],
    commonViews: [
      {
        category: "extract",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url" },
        unsupportedCommonOptions: ["javascriptActions", "screenshots"],
        notes:
          "The adapter passes through configured [providers.jina.options] " +
          "keys starting with `X-` as request headers (values stringified; " +
          "undefined/null skipped), except proxy overrides, which are " +
          "excluded to prevent changing the network context used to fetch " +
          "the target URL. The caller's http/https scheme is preserved. " +
          "Keyless use is supported; a configured key is sent as " +
          "Authorization: Bearer.",
      },
    ],
    features: { knownUrl: true, keyless: true, javascriptRendering: true },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "extract" },
    schemaSource: "official-docs",
    schemaLastVerified: "2026-10-11",
    status: "wired",
    adapterMethod: "extract",
  },
  "jina.search": deferredCandidateProfile("jina", "search", "GET s.jina.ai", "search", "https://jina.ai/"),
  "jina.embeddings": directPassThroughProfile(
    "jina",
    "embeddings",
    "POST /v1/embeddings",
    "https://jina.ai/embeddings"
  ),
  "jina.rerank": directPassThroughProfile(
    "jina",
    "rerank",
    "POST /v1/rerank",
    "https://jina.ai/reranker"
  ),
  "jina.deepSearch": deferredCandidateProfile("jina", "deepSearch", "POST deepsearch.jina.ai/v1/chat/completions", "research", "https://jina.ai/deepsearch"),

  // ── SearXNG ────────────────────────────────────────────────────────────
  "searxng.search": {
    provider: "searxng",
    tool: "search",
    nativeName: "GET /search",
    categories: ["search"],
    description: "Self-hosted metasearch. Operator-configured `baseUrl`.",
    docsUrl: "https://docs.searxng.org",
    requiredParams: ["q"],
    optionalParams: ["categories", "engines", "language", "pageno", "time_range", "safesearch", "theme", "format"],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: { freshness: "time_range", timeRange: "time_range" },
        commonOptionValueMappings: {
          timeRange: { day: "day", month: "month", year: "year" },
        },
        unsupportedCommonOptions: ["includeDomains", "excludeDomains"],
        nativeOptionsWithoutCommonEquivalent: ["engines", "categories"],
        notes:
          "format=json must be enabled in the instance's settings.yml; a " +
          "disabled format returns 403. `engines` works in practice but is " +
          "absent from the official params table.",
      },
    ],
    features: { rankedLinks: true, integratedContent: false, selfHosted: true, keyless: true, vertical: true },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: "2026-10-11",
    status: "wired",
    adapterMethod: "search",
  },
};

/** Stable tool id form: `<provider>.<tool>`. */
export function toolId(profile: ProviderToolProfile): string {
  return `${profile.provider}.${profile.tool}`;
}

/** Look up a profile by its `<provider>.<tool>` id. */
export function getToolProfile(id: string): ProviderToolProfile | undefined {
  return providerToolProfiles[id];
}

/**
 * Tools ColdSearch refuses to dispatch through the generic substrate even when
 * the provider exposes them, because they run autonomous multi-step agents,
 * mutate remote state, or require stateful setup the substrate can't audit.
 *
 * This is the single source of truth for hard-exclusion. The substrate must
 * consult it instead of inferring exclusion from the tool name (a substring
 * match on "agent" wrongly blocks legitimate tools) or from request params
 * (the presence of a `scrape` actions array does not by itself mean mutation).
 */
export const HARD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set<string>([
  "firecrawl.agent",
]);

/**
 * Whether a `<provider>.<tool>` id is hard-excluded from substrate dispatch.
 * True if it is on the explicit exclusion list or its profile is `deferred`.
 */
export function isHardExcluded(id: string): boolean {
  if (HARD_EXCLUDED_TOOLS.has(id)) return true;
  return getToolProfile(id)?.status === "deferred";
}

export interface ToolProfileFilter {
  provider?: string;
  category?: CapabilityCategory;
  status?: ProviderToolProfile["status"];
}

/** List profiles, optionally filtered by provider, category, and/or status. */
export function listToolProfiles(filter: ToolProfileFilter = {}): ProviderToolProfile[] {
  return Object.values(providerToolProfiles).filter((profile) => {
    if (filter.provider && profile.provider !== filter.provider) return false;
    if (filter.status && profile.status !== filter.status) return false;
    if (filter.category && !profile.categories.includes(filter.category)) return false;
    return true;
  });
}

/** Does a profile satisfy a set of category requirements (feature predicates)? */
export function toolSatisfiesRequirements(
  profile: ProviderToolProfile,
  requirements: CategoryRequirements = {}
): boolean {
  for (const feature of requirements.requireFeatures ?? []) {
    if (profile.features[feature] !== true) return false;
  }
  return true;
}

/**
 * Requirement-aware tool resolution. Returns the wired provider tools that can
 * back `category` AND satisfy every requested feature predicate. Routing must
 * use this instead of `capabilities.includes(category)` so it cannot pick a
 * tool that does not actually support the requested feature.
 */
export function resolveEligibleTools(
  category: CapabilityCategory,
  requirements: CategoryRequirements = {}
): ProviderToolProfile[] {
  return listToolProfiles({ category, status: "wired" }).filter((profile) =>
    toolSatisfiesRequirements(profile, requirements)
  );
}

/**
 * The single wired tool a provider uses to back a category, if any. Encodes the
 * fact that e.g. Firecrawl backs `extract` with `scrape`, not its native
 * `extract` endpoint.
 */
export function wiredToolForProviderCategory(
  provider: string,
  category: CapabilityCategory
): ProviderToolProfile | undefined {
  return listToolProfiles({ provider, category, status: "wired" })[0];
}

import type { ProviderToolProfile } from "../types.js";
import { providerToolProfiles } from "./tool-profiles.js";

/** Re-inspected against current provider docs on 2026-10-11
 * (see docs/reviews/2026-10-11-provider-contract-audit.md). Doc-reinspection
 * date, not live verification. */
const VERIFIED = "2026-10-11";

const brightDataToolProfiles: Record<string, ProviderToolProfile> = {
  "brightdata.serp": {
    provider: "brightdata",
    tool: "serp",
    nativeName: "POST /request (SERP zone)",
    categories: ["search"],
    description:
      "Bright Data SERP API. A configured SERP zone retrieves structured search-engine results and backs normalized ColdSearch search.",
    docsUrl: "https://docs.brightdata.com/scraping-automation/serp-api/introduction",
    // requiredParams is a simple "all present" list; the real contract is
    // "at least one of query/url", enforced in the serp request mapper. `query`
    // is the canonical input (a search-engine URL is built from it); `url` is
    // an accepted alternative for direct engine URLs.
    requiredParams: ["query"],
    optionalParams: ["url", "zone", "searchEngine", "country", "format", "method"],
    commonViews: [
      {
        category: "search",
        semanticFit: "direct",
        mapsCommonOptions: { query: "search-engine URL", freshness: "provider-native URL parameters" },
        unsupportedCommonOptions: ["includeDomains", "excludeDomains"],
        nativeOptionsWithoutCommonEquivalent: ["zone", "searchEngine", "country"],
        notes:
          "Normalized search consumes organic results only. Shopping/local/other SERP blocks remain provider-native detail.",
      },
    ],
    features: {
      rankedLinks: true,
      integratedContent: false,
      structuredJson: true,
      vertical: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "search" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "search",
    costNotes: "Paid Bright Data product; keep out of default pools until quality/cost are intentionally evaluated.",
  },
  "brightdata.unlocker": {
    provider: "brightdata",
    tool: "unlocker",
    nativeName: "POST /request (Web Unlocker zone)",
    categories: ["extract"],
    description:
      "Bright Data Web Unlocker known-URL retrieval for blocked/dynamic public pages. Backs normalized extract without changing agent fetch semantics.",
    docsUrl: "https://docs.brightdata.com/scraping-automation/web-unlocker/introduction",
    requiredParams: ["url"],
    optionalParams: ["zone", "format", "method", "country", "data_format"],
    commonViews: [
      {
        category: "extract",
        semanticFit: "direct",
        mapsCommonOptions: { url: "url", format: "data_format" },
        unsupportedCommonOptions: ["javascriptActions", "screenshots"],
        nativeOptionsWithoutCommonEquivalent: ["zone", "country"],
      },
    ],
    features: {
      knownUrl: true,
      javascriptRendering: true,
      integratedContent: true,
      antiBotBypass: true,
      keyless: false,
    },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "extract" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "wired",
    adapterMethod: "extract",
    costNotes: "Paid Bright Data product; explicit/configured use initially, not default routing.",
  },

  // Implemented through the generic provider-tool substrate, but deliberately
  // not normalized category backers.
  "brightdata.datasetsList": {
    provider: "brightdata",
    tool: "datasetsList",
    nativeName: "GET /datasets/list",
    categories: [],
    description:
      "List Bright Data dataset/scraper IDs available to the authenticated account so agents do not hard-code site-specific scraper IDs.",
    docsUrl: "https://docs.brightdata.com/api-reference/marketplace-dataset-api/get-dataset-list",
    requiredParams: [],
    optionalParams: [],
    commonViews: [],
    features: { structuredJson: true, datasetDiscovery: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "raw" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.datasetMetadata": {
    provider: "brightdata",
    tool: "datasetMetadata",
    nativeName: "GET /datasets/{dataset_id}/metadata",
    categories: [],
    description: "Inspect a Bright Data scraper/dataset schema before invoking structured collection.",
    docsUrl: "https://docs.brightdata.com/api-reference/marketplace-dataset-api/get-dataset-metadata",
    requiredParams: ["dataset_id"],
    optionalParams: [],
    commonViews: [],
    features: { structuredJson: true, schemaDiscovery: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "raw" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.scrape": {
    provider: "brightdata",
    tool: "scrape",
    nativeName: "POST /datasets/v3/scrape",
    categories: [],
    description:
      "Synchronous invocation of a Bright Data site-specific Web Scraper API. Returns native structured records such as products, reviews, companies, repositories, and listings.",
    docsUrl: "https://docs.brightdata.com/api-reference/scrapers/synchronous-requests",
    requiredParams: ["dataset_id", "input"],
    optionalParams: ["inputs", "format", "type", "discover_by", "limit_per_input", "custom_output_fields"],
    commonViews: [],
    features: { structuredJson: true, siteSpecificSchema: true, realTimeCollection: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "raw" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
    costNotes: "Site/dataset-specific paid collection; never invoke as routine validation or generic extract.",
  },
  "brightdata.trigger": {
    provider: "brightdata",
    tool: "trigger",
    nativeName: "POST /datasets/v3/trigger",
    categories: [],
    description: "Start an asynchronous Bright Data scraper/discovery job and return its snapshot identifier.",
    docsUrl: "https://docs.brightdata.com/api-reference/rest-api/scraper/asynchronous-requests",
    requiredParams: ["dataset_id", "input"],
    optionalParams: ["inputs", "include_errors", "custom_output_fields", "type", "discover_by"],
    commonViews: [],
    features: { structuredJson: true, asyncJob: true, siteSpecificSchema: true, keyless: false },
    execution: { mode: "async-job", supportsPolling: true, jobIdField: "snapshot_id" },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "job" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.progress": {
    provider: "brightdata",
    tool: "progress",
    nativeName: "GET /datasets/v3/progress/{snapshot_id}",
    categories: [],
    description: "Poll an async Bright Data scraper snapshot until it is ready or failed.",
    docsUrl: "https://docs.brightdata.com/api-reference/web-scraper-api/management-apis/monitor-progress",
    requiredParams: ["snapshot_id"],
    optionalParams: [],
    commonViews: [],
    features: { asyncJobStatus: true, structuredJson: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "job" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.snapshotMetadata": {
    provider: "brightdata",
    tool: "snapshotMetadata",
    nativeName: "GET /datasets/snapshots/{id}",
    categories: [],
    description:
      "Inspect Bright Data snapshot metadata, including status, dataset size and actual cost when reported by the provider.",
    docsUrl: "https://docs.brightdata.com/api-reference/marketplace-dataset-api/get-snapshot-meta",
    requiredParams: ["snapshot_id"],
    optionalParams: [],
    commonViews: [],
    features: { asyncJobStatus: true, costMetadata: true, structuredJson: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "job" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.cancel": {
    provider: "brightdata",
    tool: "cancel",
    nativeName: "POST /datasets/v3/snapshot/{snapshot_id}/cancel",
    categories: [],
    description: "Cancel a running Bright Data scraper snapshot/job.",
    docsUrl: "https://docs.brightdata.com/api-reference/scrapers/management-apis/cancel-snapshot",
    requiredParams: ["snapshot_id"],
    optionalParams: [],
    commonViews: [],
    features: { asyncJobCancellation: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "job" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
    costNotes: "Use to stop unwanted/running paid collection jobs when cancellation is still accepted upstream.",
  },
  "brightdata.snapshot": {
    provider: "brightdata",
    tool: "snapshot",
    nativeName: "GET /datasets/v3/snapshot/{snapshot_id}",
    categories: [],
    description: "Download structured results for a completed Bright Data Web Scraper snapshot/job.",
    docsUrl: "https://docs.brightdata.com/api-reference/scrapers/delivery-apis/download-snapshot",
    requiredParams: ["snapshot_id"],
    optionalParams: ["format", "compress", "batch_size", "part"],
    commonViews: [],
    features: { structuredJson: true, asyncJobResult: true, keyless: false },
    execution: { mode: "sync", supportsWait: true },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "raw" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.crawl": {
    provider: "brightdata",
    tool: "crawl",
    nativeName: "POST /datasets/v3/trigger (Crawl API dataset)",
    categories: [],
    description:
      "Bright Data Crawl API job trigger. One-shot request mapping: the response's snapshot_id is returned in raw for follow-up via the trigger/progress/snapshot tool family. Direct provider-native surface; not a normalized ColdSearch crawl backer until output and spend semantics are characterized.",
    docsUrl: "https://docs.brightdata.com/api-reference/rest-api/scraper/crawl-api",
    requiredParams: ["dataset_id", "input"],
    optionalParams: ["inputs", "include_errors", "custom_output_fields"],
    commonViews: [],
    features: { crawlJob: true, structuredJson: true, keyless: false },
    execution: { mode: "sync" },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "job" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
  "brightdata.discover": {
    provider: "brightdata",
    tool: "discover",
    nativeName: "POST /discover",
    categories: [],
    description:
      "Bright Data Discover API direct tool. One-shot request mapping: the response's task_id is returned in raw for follow-up via other tools. Kept provider-native rather than silently substituted for ordinary web search.",
    docsUrl: "https://docs.brightdata.com/api-reference/discover/overview",
    requiredParams: ["query"],
    optionalParams: [],
    commonViews: [],
    features: { discovery: true, structuredJson: true, keyless: false },
    execution: { mode: "sync" },
    output: { rawPreserved: true, summarySupported: true, resultEnvelope: "job" },
    schemaSource: "official-docs",
    schemaLastVerified: VERIFIED,
    status: "direct",
  },
};

let installed = false;

/** Extend the shared profile registry without forcing structured tools into categories. */
export function installBrightDataToolProfiles(): void {
  if (installed) return;
  Object.assign(providerToolProfiles, brightDataToolProfiles);
  installed = true;
}

// Self-install: importing this module registers the profiles, so the substrate
// dispatch path (which imports this module for its side effect) sees Bright
// Data tools as catalogued even when src/providers.ts is not imported. The
// idempotent guard keeps the explicit install call in src/providers.ts a no-op.
installBrightDataToolProfiles();

export { brightDataToolProfiles };

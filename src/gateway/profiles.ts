import { KeyPoolManager } from "../engine/keypool.js";
import { matchesPattern, type GatewayConfig, type UpstreamAuth, type UpstreamKind } from "./config.js";
import type { Connector, KeyResolver } from "./core.js";
import { redact } from "./ledger.js";

/**
 * Why a preset hides a tool by default.
 *
 * - `credentials`: the response carries a key, password or signing secret.
 *   The only reason `curation = "none"` does not lift.
 * - `destructive`: deletes or clears something that cannot be brought back.
 * - `billing`: moves money (a top-up, auto-recharge, payment methods).
 * - `account`: manages or reports on the account, team, zones, keys,
 *   webhooks or policies, or lists every job of the team.
 * - `feedback`: sends text to the vendor (feedback, a support assistant).
 * - `deprecated`: deprecated, retired, or announced to stop working.
 * - `unusable`: cannot work through this gateway (a file upload, a second
 *   credential, a plan the key does not have, a browser no call can drive).
 * - `schedule`: a standing schedule that spends until someone cancels it,
 *   and the tools that only read or change one.
 * - `spend`: one call can spend a large amount and no pin can bound it.
 * - `duplicate`: a second form of an operation the same upstream offers.
 * - `housekeeping`: service plumbing with nothing in it for an agent.
 */
export type HideReason =
  | "credentials"
  | "destructive"
  | "billing"
  | "account"
  | "feedback"
  | "deprecated"
  | "unusable"
  | "schedule"
  | "spend"
  | "duplicate"
  | "housekeeping";

/** Tools a preset hides for one reason. `note` says what they are, for the operator. */
export interface HideRule {
  reason: HideReason;
  /** Tool-name patterns, matched like `include` and `exclude`. */
  patterns: string[];
  note: string;
}

/** A preset's pin table, in the shape of a config block's `pin`. */
export type PresetPins = Record<string, { default?: Record<string, unknown>; max?: Record<string, number> }>;

/**
 * Everything the gateway knows about one upstream by name: how to reach it,
 * and which of its tools an agent gets when the config block says nothing
 * about tool lists.
 */
export interface UpstreamProfile {
  kind: UpstreamKind;
  /** API base URL or MCP endpoint. Absent when it belongs to the deployment (`searxng`). */
  url?: string;
  /** OpenAPI documents: https URLs, or `package:<path>` for a file shipped with ColdSearch. */
  spec?: string | string[];
  auth: UpstreamAuth;
  authName: string;
  authPrefix: string;
  /** When set, only tools matching one of these are offered by default. */
  include?: string[];
  /** Why the preset is an allowlist, for the operator. */
  includeNote?: string;
  /** Tools hidden by default, grouped by reason. */
  hide?: HideRule[];
  /** Argument defaults and caps applied by default. */
  pin?: PresetPins;
}

const bearer = { auth: "header", authName: "Authorization", authPrefix: "Bearer " } as const;
const xApiKey = { auth: "header", authName: "x-api-key", authPrefix: "" } as const;

/**
 * Connection details and default tool lists for the upstreams the gateway
 * knows. Taken on 2026-11-27 from each vendor's published API documents and
 * documentation; the lists were matched against the tool names those
 * documents produce. Nothing here was run against a vendor with a key.
 *
 * Vendors that publish an OpenAPI document default to `openapi`, because
 * hosted MCP servers expose a small part of the API. `<name>mcp` presets
 * reach the hosted MCP servers. A config block may override any field, and an
 * unknown name works when the block supplies `url` (and `spec` for
 * `openapi`).
 *
 * Tool lists: a preset hides what is destructive, moves money, manages the
 * account, sends feedback, is deprecated, cannot work here, sets up a
 * standing schedule, or can spend without a bound; and it pins arguments
 * whose own default is expensive. A block's `include`, `exclude` or `pin`
 * replaces the preset's value for that one setting. `curation = "none"`
 * drops all three. Tools hidden for `credentials` stay hidden either way,
 * until the block sets `allow_credential_tools = true`.
 */
export const UPSTREAM_PRESETS: Record<string, UpstreamProfile> = {
  // --- Exa -----------------------------------------------------------------
  exa: {
    kind: "openapi",
    url: "https://api.exa.ai",
    spec: "https://exa.ai/docs/exa-spec.yaml",
    ...xApiKey,
    hide: [
      { reason: "credentials", patterns: ["createMonitor", "webhooks_create"], note: "the response carries a webhook signing secret" },
      { reason: "deprecated", patterns: ["findSimilar"], note: "deprecated endpoint; search covers it" },
      {
        reason: "schedule",
        patterns: ["*Monitor*", "*monitors*", "listRuns", "getRun"],
        note: "search and Websets monitors, which run and bill on a schedule, and their runs",
      },
      { reason: "destructive", patterns: ["delete*"], note: "deletes a run, batch, webset, item, enrichment, import or webhook" },
      {
        reason: "account",
        patterns: ["listAgentRuns", "get_v0_teams_me", "*webhooks*", "events_list", "get_v0_events_id"],
        note: "team-wide run listing, team info, webhook management and the team event log",
      },
      {
        reason: "unusable",
        patterns: ["*Batch*", "*imports*"],
        note: "batches are an Enterprise beta whose results land at a presigned URL; an import needs a file sent to a presigned URL",
      },
      { reason: "spend", patterns: ["*websets*"], note: "Websets bill per compute unit and per search with no per-call cap" },
    ],
    pin: {
      // `auto` is the API default and may spend $5; `ultra` $20. A fixed effort has no cap on contact enrichment.
      createAgentRun: { default: { effort: "low", "budget.maxCostDollars": 2 }, max: { "budget.maxCostDollars": 5 } },
    },
  },
  examcp: {
    kind: "mcp",
    // `tools=` adds the opt-in web_search_advanced_exa to the three default tools.
    url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run",
    ...xApiKey,
    hide: [
      {
        reason: "spend",
        patterns: ["agent_run"],
        note: "effort ultra may spend $20 a run and its budget argument is documented for auto and ultra only, so no default cap can be pinned; exa's createAgentRun is pinned",
      },
    ],
  },
  exaadmin: {
    kind: "openapi",
    url: "https://admin-api.exa.ai/team-management",
    spec: "https://exa.ai/docs/team-management-spec.yaml",
    ...xApiKey,
    include: ["get_team_credits"],
    includeNote: "the team's credit balance; every other operation manages API keys. Needs a service key, not an API key",
    hide: [
      {
        reason: "credentials",
        patterns: ["list_api_keys", "create_api_key", "get_api_key", "update_api_key", "rotate_api_key", "get_api_key_usage"],
        note: "the response carries API key ids or secrets",
      },
      { reason: "destructive", patterns: ["delete_api_key", "revoke_previous_api_key_secret"], note: "deletes a key or revokes its previous secret" },
    ],
  },

  // --- Firecrawl -----------------------------------------------------------
  firecrawl: {
    kind: "openapi",
    url: "https://api.firecrawl.dev/v2",
    // The additions come first so their JSON parse, interact and usage operations replace the published forms.
    spec: ["package:specs/firecrawl-additions.yaml", "https://docs.firecrawl.dev/api-reference/v2-openapi.json"],
    ...bearer,
    hide: [
      { reason: "schedule", patterns: ["*Monitor*"], note: "monitors, which re-scrape on a schedule and bill each check" },
      {
        reason: "deprecated",
        patterns: ["extractData", "getExtractStatus", "getTokenUsage", "getHistoricalTokenUsage"],
        note: "extract answers 410 from 2026-12-10, and the token counters count extract only",
      },
      {
        reason: "account",
        patterns: [
          "getCreditUsage",
          "getHistoricalCreditUsage",
          "getQueueStatus",
          "getActivity",
          "getConcurrency",
          "getActiveCrawls",
          "listAgents",
          "listBrowserSessions",
          "*ThreatProtection",
        ],
        note: "team usage, queue and activity reports, team-wide job listings, and the team's threat-protection policy",
      },
      { reason: "feedback", patterns: ["submit*Feedback", "askSupportAgent"], note: "feedback to the vendor and its support assistant" },
      { reason: "duplicate", patterns: ["developerSearchPost", "govSearchPost"], note: "POST twins of developerSearch and govSearch" },
    ],
    pin: {
      // The API default is 2,500 credits; a free team has 1,000 a month.
      startAgent: { default: { maxCredits: 200 }, max: { maxCredits: 500 } },
      // The API default is 10,000 pages at a credit each.
      crawlUrls: { default: { limit: 50 }, max: { limit: 1000 } },
    },
  },
  firecrawlmcp: {
    kind: "mcp",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    ...bearer,
    include: [
      "alexandria_library_search",
      "alexandria_library_read",
      "people_company_search",
      "people_company_enrich",
      "jobs_search",
      "firecrawl_recommended_providers",
      "firecrawl_provider_directory",
      "firecrawl_agent_activity",
    ],
    includeNote:
      "the tools only the hosted server has; the rest are narrower copies of firecrawl's REST operations, or monitor, feedback, usage and skill-writing tools",
    pin: {
      // Vendor defaults: 1,000 credits, no cap, and 200 credits.
      people_company_search: { default: { max_credits: 100 }, max: { max_credits: 200 } },
      people_company_enrich: { default: { max_credits: 100 }, max: { max_credits: 200 } },
      jobs_search: { default: { max_credits: 50 }, max: { max_credits: 200 } },
    },
  },

  // --- Parallel ------------------------------------------------------------
  parallel: {
    kind: "openapi",
    url: "https://api.parallel.ai",
    spec: ["https://docs.parallel.ai/public-openapi.json", "package:specs/parallel-suggest.yaml"],
    ...xApiKey,
    hide: [
      { reason: "schedule", patterns: ["*monitors*"], note: "monitors, which bill every run until cancelled" },
      { reason: "destructive", patterns: ["post_v1beta_memory_clear", "post_v1beta_memory_evict"], note: "clears or evicts saved results" },
      {
        reason: "spend",
        patterns: ["*tasks_groups*", "*findall_runs*", "post_v1beta_findall_ingest"],
        note: "a task group takes up to 1,000 runs in one call; a FindAll run with generator pro costs $10 plus $1 a match, and a pin cannot rule a value out",
      },
    ],
    pin: {
      // The API default is `advanced`, five times the price of `fast`.
      post_v1_search: { default: { mode: "fast" } },
      post_v1_images_search: { default: { mode: "fast" } },
      post_v1_places_search: { default: { mode: "fast" } },
      // The API default is `medium`, five times the price of `low`.
      post_v1_responses: { default: { "reasoning.effort": "low" } },
      // The API waits 600 s by default; the gateway gives a request 300 s.
      get_v1_tasks_runs_run_id_result: { default: { timeout: 240 }, max: { timeout: 280 } },
    },
  },
  parallelmcp: {
    kind: "mcp",
    // `tools=` adds the tools the server accepts but does not list by default.
    url: "https://mcp.parallel.ai/mcp?tools=default,send_feedback,flight_search,product_search,monitors",
    ...bearer,
    hide: [
      { reason: "feedback", patterns: ["send_feedback"], note: "sends a problem report to the vendor" },
      { reason: "schedule", patterns: ["web_monitor_*"], note: "monitors, which bill every run until cancelled" },
    ],
  },

  // --- Tavily --------------------------------------------------------------
  tavily: {
    kind: "openapi",
    url: "https://api.tavily.com",
    spec: "https://docs.tavily.com/documentation/api-reference/openapi.json",
    ...bearer,
    hide: [
      { reason: "feedback", patterns: ["post_feedback"], note: "feedback to the vendor" },
      {
        reason: "account",
        patterns: ["getUsage", "post_logs", "post_org_usage"],
        note: "usage and request logs; post_org_usage also needs the organization owner's personal key",
      },
    ],
    pin: {
      // `auto` may pick `pro`, 15 to 250 credits of a 1,000-credit month.
      createResearch: { default: { model: "mini" } },
      // Tavily reports what a call cost only when asked.
      search: { default: { include_usage: true } },
      extract: { default: { include_usage: true } },
      crawl: { default: { include_usage: true } },
      map: { default: { include_usage: true } },
      getResearch: { default: { include_usage: true } },
    },
  },
  tavilymcp: {
    kind: "mcp",
    url: "https://mcp.tavily.com/mcp/",
    ...bearer,
    pin: { tavily_research: { default: { model: "mini" } } },
  },
  tavilykeys: {
    kind: "openapi",
    url: "https://api-key-generator.tavily.com",
    spec: "https://docs.tavily.com/documentation/enterprise/openapi.json",
    ...bearer,
    include: ["get_key_info"],
    includeNote: "what the key in use is; the other two operations mint and deactivate keys. Enterprise plans only",
    hide: [
      { reason: "credentials", patterns: ["post_generate_keys"], note: "the response carries newly minted API keys" },
      { reason: "destructive", patterns: ["post_deactivate_keys"], note: "called with no body it deactivates the key the gateway sent" },
    ],
  },

  // --- Bright Data ---------------------------------------------------------
  brightdata: {
    kind: "openapi",
    url: "https://api.brightdata.com",
    // Order matters: a later document's repeat of a method and path is dropped.
    spec: [
      "https://docs.brightdata.com/api-reference/dca-api.json",
      "https://docs.brightdata.com/api-reference/unlocker-rest-api.json",
      "https://docs.brightdata.com/api-reference/async-api-reference.json",
      "https://docs.brightdata.com/api-reference/business-search/business-search-api.json",
      "https://docs.brightdata.com/api-reference/openapi.json",
      "https://docs.brightdata.com/api-reference/web-scraper-ide-rest-api.json",
      "https://docs.brightdata.com/api-reference/browser-api.json",
      "https://docs.brightdata.com/api-reference/web-archive-api.json",
      "https://docs.brightdata.com/api-reference/media-data-api/media-data-api.json",
      "https://docs.brightdata.com/api-reference/proxy-manager.json",
    ],
    ...bearer,
    include: [
      "unlockUrl",
      "getUnlockerAsyncResponse",
      "scrapeSync",
      "triggerScrape",
      "getScrapeProgress",
      "downloadScrapeSnapshot",
      "cancelScrape",
      "listScrapers",
      "listScrapeSnapshots",
      "getScrapeSnapshotLog",
      "searchCompany",
      "searchPeople",
      "listActiveZones",
      "getZone",
    ],
    includeNote:
      "search-engine and page unlock, the scraper catalogue and its jobs, business search, and the two zone reads unlockUrl needs. Left out: account, zone and billing management (50 operations), Scraper Studio (22), Web Archive (7), marketplace dataset purchases, and delivery to cloud storage",
    hide: [
      {
        reason: "credentials",
        patterns: ["listZonePasswords", "addZonePassword", "removeZonePassword"],
        note: "zone passwords, in the response or the arguments",
      },
    ],
  },
  brightdatamcp: {
    kind: "mcp",
    url: "https://mcp.brightdata.com/mcp",
    auth: "query",
    authName: "token",
    authPrefix: "",
    hide: [
      { reason: "feedback", patterns: ["ask_brightdata_assistant"], note: "the vendor's support assistant" },
      { reason: "housekeeping", patterns: ["refresh_scrapers", "session_stats"], note: "catalogue refresh and per-session call counts" },
      {
        reason: "unusable",
        patterns: ["scraping_browser_*"],
        note: "the remote browser belongs to the server-side connection, and the gateway keeps one per key, so agents would share one browser",
      },
    ],
  },

  // --- TinyFish ------------------------------------------------------------
  tinyfish: {
    kind: "mcp",
    url: "https://agent.tinyfish.ai/mcp",
    ...bearer,
    hide: [
      { reason: "billing", patterns: ["top_up_wallet"], note: "charges a card $10 to $500" },
      { reason: "destructive", patterns: ["delete_dataset", "cancel_monitor"], note: "permanent; cancel_monitor deletes the monitor" },
      { reason: "schedule", patterns: ["*monitor*"], note: "monitors, which spend on a schedule and post page content to a webhook" },
      {
        reason: "spend",
        patterns: ["*deep_research*", "*dataset*"],
        note: "a research run is $2 to $3 and a dataset $0.10 a row ($10 for one default call), against a new account's $8",
      },
      {
        reason: "account",
        patterns: ["*profile*", "*_usage", "get_wallet", "list_runs"],
        note: "saved browser logins, which need a person to sign in; usage and wallet reports; the team's run list",
      },
      { reason: "unusable", patterns: ["*browser_session*"], note: "returns a browser to drive over CDP, which no gateway call can do, and bills per minute until closed" },
      { reason: "housekeeping", patterns: ["guide_next_step"], note: "onboarding prompt" },
    ],
  },
  tinyfishapi: {
    kind: "openapi",
    url: "https://agent.tinyfish.ai",
    spec: [
      "https://agent.tinyfish.ai/v1/openapi/main",
      "https://agent.tinyfish.ai/v1/openapi/research",
      "https://agent.tinyfish.ai/v1/openapi/monitor",
      "https://agent.tinyfish.ai/v1/openapi/datasets",
    ],
    auth: "header",
    authName: "X-API-Key",
    authPrefix: "",
    include: ["run", "runBatch", "getRunById", "getStepHtml", "getBrowserContextProfile"],
    includeNote: "the REST operations the hosted MCP server (tinyfish) has no tool for and an agent can use",
  },
  tinyfishanswer: {
    kind: "openapi",
    url: "https://api.answer.tinyfish.ai",
    spec: "https://agent.tinyfish.ai/v1/openapi/answer",
    auth: "header",
    authName: "X-API-Key",
    authPrefix: "",
  },

  // --- Context.dev ---------------------------------------------------------
  context: {
    kind: "openapi",
    url: "https://api.context.dev/v1",
    spec: "https://docs.context.dev/openapi.json",
    ...bearer,
    hide: [
      { reason: "credentials", patterns: ["rotateMonitorWebhookSecret"], note: "replaces a webhook signing secret" },
      { reason: "destructive", patterns: ["deleteMonitor", "deleteBatch"], note: "permanent; deleteBatch also removes stored results" },
      {
        reason: "account",
        patterns: ["*AccessPolic*", "*WebhookDeliver*", "getUsage", "getUsageHistory", "listLogs", "getLog", "listProfiles"],
        note: "access policies for every key, webhook deliveries, and organization-wide usage, logs and browser profiles",
      },
      { reason: "feedback", patterns: ["submitFeedback"], note: "feedback to the vendor" },
      { reason: "unusable", patterns: ["post_parse", "post_utility_prefetch"], note: "parse takes raw file bytes; prefetch needs a paid plan and returns no data" },
      {
        reason: "schedule",
        patterns: ["*Monitor*", "listAccountRuns", "listChanges", "getChange"],
        note: "monitors, which spend on a schedule, and their runs and changes",
      },
      {
        reason: "spend",
        patterns: ["*Batch*", "post_people_enrich", "post_people_search"],
        note: "a batch reserves credits for up to 100,000 URLs at submission; people data costs 10 to 50 credits a page and 20 a match",
      },
    ],
    pin: {
      // The API default is `ultra` at 100 credits; `fast` is 10.
      post_web_answers: { default: { mode: "fast" } },
    },
  },
  contextmcp: {
    kind: "mcp",
    url: "https://mcp.context.dev/mcp",
    ...bearer,
    include: ["parse-document"],
    includeNote: "the one thing REST cannot do through this gateway: parse a local file. Everything else is on context",
  },

  // --- Jina ----------------------------------------------------------------
  jina: {
    kind: "openapi",
    url: "https://api.jina.ai",
    spec: "https://docs.jina.ai/openapi.json",
    ...bearer,
    hide: [
      {
        reason: "housekeeping",
        patterns: ["reader_*echo*", "reader_*ephemeral*", "get_well_known_*", "reader_get_bot"],
        note: "Reader's echo, ephemeral-file, signature-directory and bot-info routes",
      },
      {
        reason: "duplicate",
        patterns: ["reader_get_url", "reader_post_*", "search_post_*", "search_get_q"],
        note: "other forms of reader_get_root and search_get_search, with schemas of 17 to 61 KB each",
      },
      { reason: "destructive", patterns: ["delete_*"], note: "deletes an embeddings batch" },
    ],
  },
  jinamcp: { kind: "mcp", url: "https://mcp.jina.ai/v1", ...bearer },

  // --- Kagi ----------------------------------------------------------------
  kagi: { kind: "openapi", url: "https://kagi.com/api/v1", spec: "https://kagi.com/api/docs/_bundle/openapi.json", ...bearer },

  // --- Perplexity ----------------------------------------------------------
  perplexity: {
    kind: "openapi",
    url: "https://api.perplexity.ai",
    spec: "https://docs.perplexity.ai/openapi.json",
    ...bearer,
    include: ["post_search", "context", "post_v1_decisions", "listModels"],
    includeNote:
      "search, page context, decisions and the model list. Left out: the Agent and Orchestrator APIs, which sell third-party models per token (docs/NORTH_STAR.md rules that out for Anthropic models), the retired Sonar operations, monitors, and the skill, file and batch stores",
  },

  // --- Serper --------------------------------------------------------------
  serper: {
    kind: "openapi",
    url: "https://google.serper.dev",
    spec: "package:specs/serper.yaml",
    auth: "header",
    authName: "X-API-KEY",
    authPrefix: "",
    hide: [{ reason: "account", patterns: ["account"], note: "the key's credit balance and rate limit" }],
  },

  // --- Brave ---------------------------------------------------------------
  brave: {
    kind: "openapi",
    url: "https://api.search.brave.com",
    spec: "package:specs/brave.yaml",
    auth: "header",
    authName: "X-Subscription-Token",
    authPrefix: "",
    hide: [
      {
        reason: "unusable",
        patterns: ["answers", "suggest", "spellcheck"],
        note: "each belongs to another Brave plan with its own key; a Search-plan key cannot call them",
      },
      { reason: "duplicate", patterns: ["*Post"], note: "POST twins of the web, LLM context, news and video searches" },
    ],
  },
  braveanswers: {
    kind: "openapi",
    url: "https://api.search.brave.com",
    spec: "package:specs/brave.yaml",
    auth: "header",
    authName: "X-Subscription-Token",
    authPrefix: "",
    include: ["answers"],
    includeNote: "the one operation an Answers-plan key can call",
  },

  // --- SearXNG -------------------------------------------------------------
  searxng: {
    kind: "openapi",
    // No url: the address is the deployment's own.
    spec: "package:specs/searxng.yaml",
    auth: "none",
    authName: "Authorization",
    authPrefix: "",
    // A search without format=json answers with an HTML page.
    pin: { search: { default: { format: "json" } } },
  },
};

// --- what a config offers ----------------------------------------------------

/** One upstream's tools as a config offers them. */
export interface UpstreamToolReport {
  upstream: string;
  kind: UpstreamKind;
  /** Where the tool list came from: the API documents, or the MCP endpoint without its query string. */
  source: string[];
  /** `preset` when the preset's lists are in force, `none` when the block opted out or the name has no preset. */
  curation: "preset" | "none";
  /** How many tools the provider offers, or null when the list could not be read. */
  offered: number | null;
  /** Names an agent is offered, without the `<upstream>__` prefix. */
  exposed: string[];
  /** Tools the provider offers that an agent is not offered, each with the reason. */
  hidden: Array<{ tool: string; reason: string }>;
  /** Tool-name patterns with pinned arguments. */
  pinned: string[];
  /** Why the list could not be read. Key values are redacted. */
  error?: string;
}

/**
 * Read every upstream's tool list and say what the config exposes of it.
 * Nothing is called: an `openapi` upstream is listed from its documents
 * without resolving a key, and an `mcp` upstream by connecting with its first
 * key that resolves and asking for the list. An upstream that cannot be read
 * is reported with `error` and `offered: null`.
 */
export async function listUpstreamTools(
  config: GatewayConfig,
  options: { connector: Connector; resolveKey?: KeyResolver }
): Promise<UpstreamToolReport[]> {
  let resolveKey = options.resolveKey;
  if (!resolveKey) {
    const pool = new KeyPoolManager();
    resolveKey = (ref) => pool.resolveRef(ref);
  }
  const resolve = resolveKey;

  return Promise.all(
    config.upstreams.map(async (upstream): Promise<UpstreamToolReport> => {
      const report: UpstreamToolReport = {
        upstream: upstream.name,
        kind: upstream.kind,
        source: upstream.kind === "openapi" ? upstream.specs : [upstream.url.split("?")[0]],
        curation: upstream.curation,
        offered: null,
        exposed: [],
        hidden: [],
        pinned: upstream.pins.map((pin) => pin.pattern),
      };
      const secrets: string[] = [];
      const read = async (keyValue: string): Promise<string[]> => {
        const client = await options.connector(upstream, keyValue);
        try {
          return (await client.listTools()).tools.map((tool) => tool.name);
        } finally {
          await client.close().catch(() => undefined);
        }
      };

      let names: string[] | undefined;
      let lastError = "no keys configured";
      // A document is public: reading it needs no key. An MCP list needs one.
      const keyRefs = upstream.kind === "openapi" || upstream.auth === "none" ? [""] : upstream.keys;
      for (const keyRef of keyRefs) {
        try {
          const value = keyRef ? await resolve(keyRef) : "";
          if (value) secrets.push(value);
          names = await read(value);
          break;
        } catch (error) {
          lastError = redact((error as Error).message ?? String(error), secrets);
        }
      }
      if (!names) {
        report.error = lastError.slice(0, 300);
        return report;
      }

      report.offered = names.length;
      for (const tool of names) {
        const rule = upstream.hidden.find((entry) => entry.patterns.some((pattern) => matchesPattern(tool, pattern)));
        if (rule) {
          report.hidden.push({ tool, reason: rule.reason });
        } else if (upstream.include.length > 0 && !upstream.include.some((pattern) => matchesPattern(tool, pattern))) {
          report.hidden.push({ tool, reason: "not-included" });
        } else {
          report.exposed.push(tool);
        }
      }
      return report;
    })
  );
}

/** The reports as text for a terminal: one block per upstream. */
export function formatToolReports(reports: UpstreamToolReport[]): string {
  const blocks = reports.map((report) => {
    const head = `${report.upstream} (${report.kind}, ${report.source.length === 1 ? report.source[0] : `${report.source.length} documents`})`;
    if (report.offered === null) return `${head}\n  could not be read: ${report.error ?? "unknown error"}`;
    const reasons = new Map<string, number>();
    for (const { reason } of report.hidden) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const lines = [
      head,
      `  offered ${report.offered}, exposed ${report.exposed.length}, hidden ${report.hidden.length}${report.curation === "none" ? " (curation: none)" : ""}`,
      `  exposed: ${report.exposed.join(", ") || "(none)"}`,
    ];
    if (reasons.size > 0) {
      const ranked = [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      lines.push(`  hidden: ${ranked.map(([reason, count]) => `${reason} ${count}`).join(", ")}`);
    }
    if (report.pinned.length > 0) lines.push(`  pinned: ${report.pinned.join(", ")}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

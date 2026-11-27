# Commodity vs buy: what the gateway should do itself (2026-11-27)

- **Nature:** analysis and design proposal. Nothing built, tested or bought.
- **Inputs:** today's gateway tool inventory (298 tools, 10 upstreams), `docs/components/gateway.md`, the vendor snapshots in this folder, and pages read today (listed at the end).
- **Allowances assumed:** Firecrawl 3,000–4,500 credits a month across three teams, 1 credit a page (`idea-key-slot-rotator-dashboard.md` measures 3,500 plan credits, about 2,450 left this period). Tavily 1,000 a month per account. Bright Data 5,000 requests a month. TinyFish search and fetch $0.
- **Assumed, not measured:** the share of pages needing a render or a paid unlock. Build step 2 measures it.

## 0. Answer

1. Crawl, map, batch scrape, single-page fetch, screenshots, page monitors and "extract JSON with an LLM" are commodity. A 300-page crawl costs 300 Firecrawl credits bought, about 3 when we fetch and pay only for blocked pages.
2. Two things cannot be made at home: a web index and getting past bot protection. Keep buying both, the second per page.
3. Of 298 tools, 110 are admin, 113 duplicates and 15 unusable through the connector. Config alone leaves agents 60; native fetch, map and crawl leave 40.
4. In money, one $19 Firecrawl Hobby plan covers everything this saves. The reasons to build are no 402 wall mid-task, URL lists staying home, cache reuse and a shorter tool list. Past a few hundred lines of code, stop (section 4).

## 1. Capability map

Costs: `firecrawl.md`, `exa.md`, `parallel.md`, and today's Tavily, TinyFish and Bright Data pricing pages. "cr" is a vendor credit.

| Family | Vendor tools in the dump | Cost there | Ourselves, with | What we lose | Verdict |
|---|---|---|---|---|---|
| Web index search | `exa.search`, `firecrawl.searchAndScrape`, `parallel.post_v1_search`, `tavily.search`, `brightdata.search_engine`, `tinyfish.search`, four MCP wrappers | Exa $4–12/1k; Firecrawl 2 cr per 10 results; Parallel $1–5/1k; Tavily 1–2 cr; Bright Data $1.5/1k after the free pool; TinyFish $0 | SearXNG (`docker/searxng/`), as a floor only | One IP draws CAPTCHAs and 429s, Google first; no semantic ranking | **BUY**, free lanes first |
| Similar-page / semantic | `exa.search`, `exa.findSimilar` (deprecated), `firecrawl.researchRelatedPapers` | $7/1k; papers free | Nothing: needs an embedded web index | — | **BUY** |
| Fetch one URL to markdown | `exa.getContents`, `firecrawl.scrapeAndExtractFromUrl`, `parallel.post_v1_extract`, `tavily.extract`, `brightdata.web_fetch`, `tinyfish.fetch_content` | $1/1k; 1 cr; $1/1k; 1 cr per 5 URLs; free pool; $0 to 1,000 URLs/day | ADR 004's SSRF-safe GET (`src/agent/agent.ts`), `defuddle`, `pdftotext`, `src/cache/` | Tables and tabbed code on odd layouts | **OURSELVES FIRST, VENDOR FALLBACK** |
| Fetch needing JS | Same tools; Tavily `advanced` is 2 cr per 5 | As above | Playwright with the installed Chromium, or crawl4ai / Firecrawl Local | 300–500 MB a browser, 2–10 s a page; the cluster needs a browser pod | **OURSELVES FIRST, VENDOR FALLBACK** |
| Bot-protected pages | `brightdata.web_fetch`, `scrape_batch`; Firecrawl scrape `proxy`; `tinyfish.fetch_content` | 1 request or credit a page | Not from a residential IP: stealth patches mostly lose to Turnstile, DataDome, PerimeterX | Everything; failed tries also mark the home IP | **BUY**, per page, after detection |
| Site map | `firecrawl.mapUrls`, `tavily.map` | 1 cr a call; 1 cr per 10 URLs | `robots.txt`, `sitemap.xml`, `llms.txt`, one hop of links | Orphan pages only a vendor index knows | **DO OURSELVES** |
| Site crawl | `firecrawl.crawlUrls` and four helpers, `tavily.crawl` | 1 cr a page (5 with JSON); 3–5 cr per 10 pages | Breadth-first loop over the fetch ladder | Speed: one IP means 1–2 requests a second per host; robots duties become ours | **DO OURSELVES**, paid fallback per page |
| Batch scrape | `firecrawl.scrapeAndExtractFromUrls` and three helpers, `brightdata.scrape_batch`, `exa.createBatch` | Per page | `fetch` with a URL list | Nothing new | **DO OURSELVES** |
| LLM structured extraction | Firecrawl `json` format; `firecrawl.extractData` (410 from 2026-12-10); Exa `outputSchema` | +4 cr a page; $1/1k pages | Nothing new: the calling agent reads our markdown | Vendor parallelism | **DO OURSELVES** |
| Answer / research agents | `exa.answer`, Exa agent (7), Firecrawl agent (6), Parallel responses, decisions, Task (5), Task Group (6), FindAll (10), `tavily.createResearch`, TinyFish deep research (5), `brightdata.chatgpt_ai_insights` | $0.005; $0.012–1, `auto` to $5; 5 free runs a day, then hundreds of cr; $0.01–0.25; $0.001; $0.005–2.40 a run; 4–250 cr; $2–3 a run | The caller already is a research agent | Vendor parallelism, per-field citations | **BUY** fixed-price routes, **HIDE** the rest |
| Monitors | Exa (9, plus 7 Websets), Firecrawl (8, plus 8 MCP), Parallel (8), TinyFish (8) | $2/1k; 1 cr per page per check; $3–10/1k; $0.005 a check | A timer calling `fetch` with the last hash | Vendor webhooks | **DO OURSELVES** outside the gateway; **HIDE** |
| File / PDF parsing | `firecrawl.parseFile`, `firecrawlmcp.firecrawl_parse`; PDF URLs through scrape or extract | 1 cr per PDF page; Parallel $1/1k URLs | `pdftotext`, `tesseract`; a local file never needs the gateway | Scanned or table-heavy PDFs, Office formats | **OURSELVES FIRST**; upload tools **HIDE** |
| Screenshots | Firecrawl `screenshot` format, `brightdata.scraping_browser_screenshot` | 1 cr | Playwright, in the render tier | A blocked site shows its challenge | **DO OURSELVES** |
| Interactive browser | Firecrawl interact (4, plus 2 scrape-bound), Bright Data `scraping_browser_*` (14), TinyFish `create_browser_session`, `run_web_automation` | 2 cr a minute; $8/GB; $0.002 a minute; $0.016 a step | A local Playwright MCP beside the agent, not through the gateway | Protected or geo-fenced sites | **OURSELVES** for open sites; **BUY** one route |
| Pre-built scrapers, datasets | Bright Data scrapers (6), datasets (2); `alexandria_library_*`; Exa Websets (18); TinyFish datasets (8) | Per record; 1–40 cr per capability; $0.10 a row | No: per-site parsers plus proxy pools | — | **BUY**, two routes |
| People / company | `people_company_search`, `people_company_enrich`, `jobs_search`, `brightdata.business_search`, Parallel entity search | Default caps 1,000 cr, none, 200 cr; per record; $5/1k | No: licensed data | — | **BUY** bounded routes; **HIDE** uncapped |
| Vertical search | Parallel flights, hotels, shopping, places, images; `parallelmcp.search_vertical`; Firecrawl research (4), developer, gov | $1–5/1k; research and gov free | No: licensed feeds | — | **BUY** |
| Usage / account | Firecrawl usage, queue, activity; `tavily.getUsage`, `post_logs`, `post_org_usage`; `exa.get_v0_teams_me`; TinyFish wallet, usage | Free | — | — | **HIDE** (poller only) |
| Feedback / support | Firecrawl feedback, `askSupportAgent`; `tavily.post_feedback`; `brightdata.ask_brightdata_assistant` | Free | — | — | **HIDE** |
| Destructive / admin | Every `delete*`, `tinyfish.top_up_wallet`, profiles, `firecrawl.updateThreatProtection`, Exa webhooks, Parallel memory clear | — | — | — | **HIDE** |

## 2. Gateway-native tools

Names follow `coldsearch_status`. They act as one more provider, `local`: every tier attempt writes a ledger line, so the saving is measured, and cache hits are labelled and bounded by `max_age`.

### 2.1 `coldsearch_fetch`

| Argument | Meaning |
|---|---|
| `urls` | 1–50 URLs; this is also batch scrape |
| `format` | `markdown` (default), `text`, `html`, `links`, `screenshot` |
| `render` | `auto`, `never`, `always` |
| `vendor` | `auto`, `never`, `only`; `max_vendor` caps paid pages (default 5) |
| `max_age` | Oldest cached copy to accept (default `1h`; `0` is live) |
| `known_hash` | Return `unchanged: true` when the content hash matches |

Tiers per URL, in order:

0. **cache**
1. **plain** — the ADR 004 checks in a shared module, plus what the code lacks: redirects (each hop validated again; it refuses them all today), compression, a 5 MiB cap. HTML goes through `defuddle`, PDF through `pdftotext`.
2. **render** — Playwright Chromium, then the same extractor. Every request the page makes passes the SSRF check through `page.route`, or a rendered page can reach LAN addresses.
3. **vendor** — one page through the existing key order and failover, cheapest allowance first: TinyFish `fetch_content` ($0), Bright Data `web_fetch` (free pool, strongest unblocker), Firecrawl scrape (1 cr), Tavily `extract`, Parallel `post_v1_extract`. The detector runs on the vendor's answer too.

Each result carries `url, status, tier, content, content_hash, cost, blocked_reason`. The native tool calls upstream clients directly; a tool hidden by `exclude` is not callable on the agent-facing path.

### 2.2 When a page "needs fallback"

A starting set, to keep as test fixtures. Structural markers, not keywords, as in crawl4ai's detector.

| Class | Signals | Next tier |
|---|---|---|
| Empty shell | 2xx HTML with under 200 characters of extracted text from over 5 KB of HTML; an empty `#root`, `#__next` or `#app`; a `<noscript>` asking for JavaScript | render |
| JS proof of work | Anubis; `cf-mitigated: challenge` with no Turnstile widget | render once, then vendor |
| Blocked, by status | 401, 403, 406; 429 after one `Retry-After` wait; 503 with a challenge marker; 202 or 405 with `x-amzn-waf-action`; 999 | vendor |
| Blocked, by header | `x-vercel-mitigated: challenge`, `x-datadome`, `_px*` or `incap_ses_*` cookies, `x-kpsdk-*` | vendor |
| Blocked, by body | "Just a moment…" with `/cdn-cgi/challenge-platform/`; `challenges.cloudflare.com/turnstile`; `captcha-delivery.com`; `px-captcha`; Akamai "Access Denied"; `_Incapsula_Resource`; a CAPTCHA script on a near-empty page | vendor |
| Still empty after render | Under 200 characters | vendor |
| Never escalate | 404, 410 (Firecrawl bills a returned 403 or 404 document), 451, 5xx after one retry, a robots-disallowed path, a login or paywall | report |

### 2.3 `coldsearch_map`

Arguments: `url`, `limit` (500, max 5,000), `include_paths`, `exclude_paths`, `search`, `link_depth` (0–2, default 1).

No vendor call. Read `robots.txt` for Sitemap lines and rules, then `/sitemap.xml`, indexes, `.gz` files and `/llms.txt`. If that yields little, fetch the start page and up to 20 linked pages for same-site links. Return `urls[{url, lastmod, source}]`, `total`, `truncated`.

### 2.4 `coldsearch_crawl`, `coldsearch_crawl_status`

Arguments: `url`, `max_pages` (50, hard cap 1,000), `max_depth` (3), `include_paths`, `exclude_paths`, `render`, `vendor` with `max_vendor_pages` (the smaller of 10 and 5% of `max_pages`), `delay_ms` (1,000 per host, or the robots crawl delay if longer).

Seed the frontier from `map`, then go breadth-first through tiers 0–2. Blocked or still-empty pages go to the vendor tier, up to the cap. The crawl fills the cache and returns a manifest (`url, title, chars, hash, tier`), not megabytes; the agent reads pages with `coldsearch_fetch` as cache hits. A long crawl returns a `crawl_id`.

Politeness is operator config, not an agent argument: an honest user agent, robots obeyed, two connections per host, 2,000 pages per host per day. Three consecutive 403 or 429 answers, or over 30% hard blocks in the first 20 pages, stop the crawl with `site_protected`. A robots-disallowed path is never escalated.

### 2.5 `monitor` stays out of the gateway

A monitor needs a scheduler, durable state and somewhere to send results; the gateway is request and response, sometimes one process per agent. It supplies the primitives (`content_hash`, `known_hash`, the cached copy). The schedule is a Kubernetes CronJob or systemd timer calling `coldsearch_fetch`.

Vendor monitors are hidden because each is standing spend on one account. Ten pages checked hourly on Firecrawl is 7,200 credits a month, more than the whole pool.

### 2.6 Engines checked today

| Candidate | State on 2026-11-27 | Use |
|---|---|---|
| `defuddle` 0.19.13 (MIT) | `defuddle/node` takes a `linkedom` document, emits Markdown | Plain-tier extractor; Readability + `turndown` 7.2.5 is the alternative |
| Playwright 1.65.1 | On the workstations, with Chromium builds | Render tier, screenshots |
| crawl4ai 0.9.6 (Apache-2.0) | Python: deep crawl, sitemap seeding, block detection with a `fallback_fetch_function`, Docker server | Sidecar, to avoid owning render and crawl |
| Firecrawl Local (announced 2026-11-18) | One Rust binary serving the v2 API; scrape, crawl, map run locally; JS needs local Chrome; `FIRECRAWL_CLOUD=off` stops its own cloud fallback | Zero-code trial as an `openapi` upstream on localhost (untested) |
| Firecrawl self-host compose (AGPL-3.0) | Six services; no Fire-engine, so no anti-bot, screenshots or actions | Not worth it here |
| Jina Reader, keyless | `r.jina.ai` 20 requests a minute; `s.jina.ai` needs a key | Optional free render lane |
| SearXNG (AGPL-3.0) | Active; compose and settings already in the repo | Search floor only |

### 2.7 Saving on two examples

**A 300-page documentation site**, assuming 3% of pages need a render and 1% a paid unlock:

| Route | Cost | Share of the Firecrawl pool |
|---|---|---|
| Firecrawl `crawlUrls` | 300 cr | 7–10% (20–30% of one team) |
| The same with the `json` format | 1,500 cr | 33–50% |
| Tavily `crawl`, basic / advanced | 90 / 150 cr | 9% / 15% of one Tavily account |
| Ours | 3 cr for 3 unlocks; 0 if TinyFish or Bright Data take them | 0.1% |

About 297 credits saved a crawl, for 3–5 minutes of polite fetching. Bought, the pool lasts 10–15 such crawls.

**A 20-URL batch, 3 bot-protected:**

| Route | Cost |
|---|---|
| Firecrawl batch scrape | 20 cr, including any page returned as a 403 |
| Tavily `extract` | 4 cr basic, about 2 more to retry the protected three as advanced |
| Ours | 17 pages local; 3 Bright Data requests from the free pool, or 3 Firecrawl cr |

17 of 20 credits saved against Firecrawl, almost nothing against Tavily. The value is volume: the run recorded in `idea-agent-search-routing.md` made 310 fetches, 310 credits through Firecrawl or about 47 at this block rate. The pool serves 3,000–4,500 pages bought, or 20,000–90,000 when only the blocked 5–15% are.

## 3. Per-tool classification

- **EXPOSE** — agents should have it.
- **REPLACE** — hide once the native tool ships; still called inside the gateway as a vendor tier.
- **HIDE-ADMIN** — destructive, billing, account, feedback, standing schedules, team-wide listings, and tools whose default spend cap is a fifth of a month's allowance or more.
- **HIDE-DUPLICATE** — the capability is exposed through a better route.
- **HIDE-BROKEN** — cannot work through a JSON connector, or is orphaned or removed upstream.

| Upstream | Total | EXPOSE | REPLACE | ADMIN | DUPLICATE | BROKEN |
|---|---|---|---|---|---|---|
| `exa` | 64 | 2 | 1 | 32 | 24 | 5 |
| `examcp` | 3 | 0 | 0 | 0 | 3 | 0 |
| `firecrawl` | 57 | 10 | 12 | 24 | 7 | 4 |
| `firecrawlmcp` | 38 | 2 | 0 | 16 | 19 | 1 |
| `parallel` | 41 | 12 | 1 | 10 | 15 | 3 |
| `parallelmcp` | 7 | 2 | 0 | 0 | 5 | 0 |
| `tavily` | 10 | 1 | 3 | 4 | 2 | 0 |
| `tavilymcp` | 5 | 0 | 0 | 0 | 5 | 0 |
| `brightdata` | 30 | 7 | 2 | 3 | 18 | 0 |
| `tinyfish` | 43 | 4 | 1 | 21 | 15 | 2 |
| **All** | **298** | **40** | **20** | **110** | **113** | **15** |

**Agents keep 60 upstream tools today (config only) and 40 once fetch, map and crawl ship.** With the gateway's own tools (`coldsearch_status`, `coldsearch_read_skill`, four new) that is 46 in `all` mode.

Judgement calls, each reversible:

- **† Hidden for an unsafe default, not for lack of value:** Exa agent (`effort` defaults to `auto`, up to $5), Firecrawl agent (five free runs a day per team, then hundreds of credits), FindAll runs, Tavily and TinyFish research, `people_company_search` (default cap 1,000 cr), `people_company_enrich` (no cap), `jobs_search` (200 cr). Re-expose when the gateway can pin arguments (step 5).
- **Research agent route:** Parallel Task; its `processor` argument sets a fixed price per run. Parallel's credit is card-backed, so overage may bill.
- **Remote browser route:** Firecrawl interact (three tools, takes Playwright code). Bright Data's 14 step tools unblock better; swap if preferred.
- **List building:** Websets and TinyFish datasets are hidden as duplicates of a Task run with a list schema.
- **Keyless lanes:** `parallelmcp` with no key is a free search and fetch lane (unpublished per-IP limits); classified here as keyed.

Hidden tools stay reachable from an operator profile: a second config without lists, passed with `--config`.

### 3.1 Ready to paste: `include` (recommended)

An allowlist hides whatever a vendor publishes next, including a new delete or billing operation. Both forms below were checked against the inventory with the gateway's matching rule (`*` matches any run, anchored at both ends).

```toml
# Remove [gateway.upstreams.examcp] and [gateway.upstreams.tavilymcp]: every tool is a duplicate.

[gateway.upstreams.exa]
include = ["search", "answer"]
# until coldsearch_fetch ships, add: "getContents"

[gateway.upstreams.firecrawl]
include = ["searchAndScrape", "createBrowserSession", "executeBrowserCode", "deleteBrowserSession",
           "research*", "developerSearchPost", "govSearchPost"]
# until fetch ships, add: "scrapeAndExtractFromUrl*", "getScrapeStatus", "*BatchScrape*"
# until map and crawl ship, add: "crawlUrls", "getCrawlStatus", "cancelCrawl", "getCrawlErrors",
#                                "crawlParamsPreview", "mapUrls"

[gateway.upstreams.firecrawlmcp]
include = ["alexandria_library_*"]

[gateway.upstreams.parallel]
include = ["post_v1_*search", "post_v1_decisions", "post_v1_responses", "post_v1_tasks_runs",
           "get_v1_tasks_runs_run_id", "get_v1_tasks_runs_run_id_result",
           "post_v1beta_findall_entity_search"]
# until fetch ships, add: "post_v1_extract"

[gateway.upstreams.parallelmcp]
include = ["*_vertical*"]

[gateway.upstreams.tavily]
include = ["search"]
# until fetch ships, add: "extract"; until map and crawl ship, add: "crawl", "map"

[gateway.upstreams.brightdata]
include = ["search_engine", "search_scrapers", "get_scraper_*", "run_scraper", "business_search"]
# until fetch ships, add: "web_fetch", "scrape_batch"

[gateway.upstreams.tinyfish]
include = ["search", "run_web_automation", "get_run", "cancel_run"]
# until fetch ships, add: "fetch_content"
```

### 3.2 The same result as `exclude`

| Upstream | Apply now (admin, duplicate, broken) | Add when the native tool ships |
|---|---|---|
| `exa` | `"findSimilar", "*Monitor*", "*monitors*", "listRuns", "getRun", "*AgentRun*", "*Batch*", "get_v0_teams_me", "*websets*", "*imports*", "*webhooks*", "*events*"` | `"getContents"` |
| `examcp` | `"*"` | |
| `firecrawl` | `"*Monitor*", "*Agent*", "getActiveCrawls", "*Usage", "getQueueStatus", "getActivity", "listBrowserSessions", "submit*Feedback", "*ThreatProtection", "*interact*", "developerSearch", "govSearch", "parseFile", "getParseFormats", "extractData", "getExtractStatus"` | `"scrapeAndExtractFromUrl*", "getScrapeStatus", "*BatchScrape*", "crawl*", "*Crawl*", "mapUrls"` |
| `firecrawlmcp` | use `include` | |
| `parallel` | `"*tasks_groups*", "*_events", "get_v1_tasks_runs_run_id_input", "post_v1beta_findall_ingest", "*findall_runs*", "*monitors*", "*memory*"` | `"post_v1_extract"` |
| `parallelmcp` | use `include` | |
| `tavily` | `"*Research", "post_*", "getUsage"` | `"extract", "crawl", "map"` |
| `tavilymcp` | `"*"` | |
| `brightdata` | `"ask_*", "search_engine_batch", "refresh_scrapers", "session_stats", "*dataset*", "chatgpt_*", "scraping_browser_*"` | `"web_fetch", "scrape_batch"` |
| `tinyfish` | `"*monitor*", "*deep_research*", "*dataset*", "guide_next_step", "run_web_automation_async", "*browser_session*", "*profile*", "list_runs", "batch_*", "*_usage", "*wallet*"` | `"fetch_content"` |

### 3.3 Every tool

**exa**
- EXPOSE (2): `search`, `answer`
- REPLACE (1): `getContents`
- HIDE-ADMIN (32): `listMonitors`, `createMonitor`, `batchMonitors`, `getMonitor`, `updateMonitor`, `deleteMonitor`, `triggerMonitor`, `listRuns`, `getRun`, `listAgentRuns`, `deleteAgentRun`, `listAgentRunEvents`, `deleteBatch`, `get_v0_teams_me`, `delete_v0_websets_id`, `delete_v0_websets_webset_enrichments_id`, `delete_v0_websets_webset_items_id`, `monitors_list`, `monitors_create`, `get_v0_monitors_id`, `monitors_update`, `delete_v0_monitors_id`, `monitors_runs_list`, `get_v0_monitors_monitor_runs_id`, `webhooks_list`, `webhooks_create`, `get_v0_webhooks_id`, `webhooks_update`, `delete_v0_webhooks_id`, `webhooks_attempts_list`, `events_list`, `get_v0_events_id`
- HIDE-DUPLICATE (24): `findSimilar`, `createAgentRun`†, `getAgentRun`†, `cancelAgentRun`†, `stopAgentRun`†, `listBatches`, `createBatch`, `getBatch`, `cancelBatch`, `websets_list`, `websets_create`, `get_v0_websets_id`, `websets_update`, `websets_cancel`, `websets_searches_create`, `get_v0_websets_webset_searches_id`, `websets_searches_cancel`, `websets_enrichments_create`, `get_v0_websets_webset_enrichments_id`, `websets_enrichments_update`, `websets_enrichments_cancel`, `get_v0_websets_webset_items_id`, `websets_items_list`, `websets_preview`
- HIDE-BROKEN (5; the file goes to a presigned upload URL the connector cannot reach): `imports_list`, `imports_create`, `get_v0_imports_id`, `imports_update`, `delete_v0_imports_id`

**examcp**
- HIDE-DUPLICATE (3): `web_search_exa`, `web_fetch_exa`, `agent_run`

**firecrawl**
- EXPOSE (10): `searchAndScrape`, `createBrowserSession`, `executeBrowserCode`, `deleteBrowserSession`, `researchSearchPapers`, `researchGetPaper`, `researchRelatedPapers`, `researchLookupProtein`, `developerSearchPost`, `govSearchPost`
- REPLACE (12): `scrapeAndExtractFromUrl`, `getScrapeStatus`, `scrapeAndExtractFromUrls`, `getBatchScrapeStatus`, `cancelBatchScrape`, `getBatchScrapeErrors`, `crawlUrls`, `getCrawlStatus`, `cancelCrawl`, `getCrawlErrors`, `crawlParamsPreview`, `mapUrls`
- HIDE-ADMIN (24): `listMonitors`, `createMonitor`, `getMonitor`, `updateMonitor`, `deleteMonitor`, `runMonitor`, `listMonitorChecks`, `getMonitorCheck`, `listAgents`, `getAgentTrace`, `getAgentSnapshot`, `getActiveCrawls`, `getCreditUsage`, `getHistoricalCreditUsage`, `getTokenUsage`, `getHistoricalTokenUsage`, `getQueueStatus`, `getActivity`, `listBrowserSessions`, `submitSearchFeedback`, `submitEndpointFeedback`, `askSupportAgent`, `getThreatProtection`, `updateThreatProtection`
- HIDE-DUPLICATE (7): `startAgent`†, `getAgentStatus`†, `cancelAgent`†, `interactWithScrapeBrowserSession`, `delete_scrape_jobId_interact`, `developerSearch`, `govSearch` (the GET twins of the POST forms)
- HIDE-BROKEN (4): `parseFile` (multipart upload), `getParseFormats`, `extractData`, `getExtractStatus` (410 Gone from 2026-12-10)

**firecrawlmcp**
- EXPOSE (2): `alexandria_library_search`, `alexandria_library_read`
- HIDE-ADMIN (16): `firecrawl_monitor_create`, `firecrawl_monitor_list`, `firecrawl_monitor_get`, `firecrawl_monitor_update`, `firecrawl_monitor_delete`, `firecrawl_monitor_run`, `firecrawl_monitor_checks`, `firecrawl_monitor_check`, `firecrawl_save_skill`, `firecrawl_search_feedback`, `firecrawl_feedback`, `firecrawl_credit_usage`, `firecrawl_usage_dashboard`, `people_company_search`†, `people_company_enrich`†, `jobs_search`†
- HIDE-DUPLICATE (19): `firecrawl_scrape`, `firecrawl_map`, `firecrawl_search`, `firecrawl_crawl`, `firecrawl_check_crawl_status`, `firecrawl_agent`, `firecrawl_agent_status`, `firecrawl_agent_activity`, `firecrawl_interact`, `firecrawl_interact_stop`, `firecrawl_research_search_papers`, `firecrawl_research_inspect_paper`, `firecrawl_research_related_papers`, `firecrawl_research_read_paper`, `firecrawl_research_lookup_protein`, `firecrawl_developer_search`, `firecrawl_gov_search`, `firecrawl_recommended_providers`, `firecrawl_provider_directory`
- HIDE-BROKEN (1; needs a file path or upload reference): `firecrawl_parse`

**parallel**
- EXPOSE (12): `post_v1_search`, `post_v1_flights_search`, `post_v1_hotels_search`, `post_v1_images_search`, `post_v1_places_search`, `post_v1_shopping_search`, `post_v1_decisions`, `post_v1_responses`, `post_v1_tasks_runs`, `get_v1_tasks_runs_run_id`, `get_v1_tasks_runs_run_id_result`, `post_v1beta_findall_entity_search`
- REPLACE (1): `post_v1_extract`
- HIDE-ADMIN (10): `get_v1_monitors`, `post_v1_monitors`, `get_v1_monitors_stats`, `get_v1_monitors_monitor_id`, `post_v1_monitors_monitor_id_cancel`, `get_v1_monitors_monitor_id_events`, `post_v1_monitors_monitor_id_trigger`, `post_v1_monitors_monitor_id_update`, `post_v1beta_memory_clear`, `post_v1beta_memory_evict`
- HIDE-DUPLICATE (15): `post_v1_tasks_groups`, `get_v1_tasks_groups_taskgroup_id`, `get_v1_tasks_groups_taskgroup_id_runs`, `post_v1_tasks_groups_taskgroup_id_runs`, `get_v1_tasks_groups_taskgroup_id_runs_run_id`, `get_v1_tasks_runs_run_id_input`, `post_v1beta_findall_ingest`†, `post_v1beta_findall_runs`†, `get_v1beta_findall_runs_findall_id`†, `post_v1beta_findall_runs_findall_id_cancel`†, `post_v1beta_findall_runs_findall_id_enrich`†, `post_v1beta_findall_runs_findall_id_extend`†, `get_v1beta_findall_runs_findall_id_result`†, `get_v1beta_findall_runs_findall_id_schema`†, `post_v1beta_memory_retrieve`
- HIDE-BROKEN (3; server-sent event streams): `get_v1_tasks_groups_taskgroup_id_events`, `get_v1_tasks_runs_run_id_events`, `get_v1beta_findall_runs_findall_id_events`

**parallelmcp**
- EXPOSE (2): `find_verticals`, `search_vertical`
- HIDE-DUPLICATE (5): `web_search`, `web_fetch`, `web_research`, `web_decisions`, `image_search`

**tavily**
- EXPOSE (1): `search`
- REPLACE (3): `extract`, `crawl`, `map`
- HIDE-ADMIN (4): `post_feedback`, `getUsage`, `post_logs`, `post_org_usage`
- HIDE-DUPLICATE (2): `createResearch`†, `getResearch`†

**tavilymcp**
- HIDE-DUPLICATE (5): `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`, `tavily_research`

**brightdata**
- EXPOSE (7): `search_engine`, `search_scrapers`, `get_scraper_details`, `run_scraper`, `get_scraper_progress`, `get_scraper_results`, `business_search`
- REPLACE (2): `web_fetch`, `scrape_batch`
- HIDE-ADMIN (3): `ask_brightdata_assistant`, `refresh_scrapers`, `session_stats`
- HIDE-DUPLICATE (18): `search_engine_batch`, `list_dataset_fields`, `search_dataset`, `chatgpt_ai_insights`, `scraping_browser_navigate`, `scraping_browser_go_back`, `scraping_browser_go_forward`, `scraping_browser_snapshot`, `scraping_browser_click_ref`, `scraping_browser_type_ref`, `scraping_browser_screenshot`, `scraping_browser_network_requests`, `scraping_browser_wait_for_ref`, `scraping_browser_fill_form`, `scraping_browser_get_text`, `scraping_browser_get_html`, `scraping_browser_scroll`, `scraping_browser_scroll_to_ref`

**tinyfish**
- EXPOSE (4): `search`, `run_web_automation`, `get_run`, `cancel_run`
- REPLACE (1): `fetch_content`
- HIDE-ADMIN (21): `create_monitor`, `list_monitors`, `get_monitor`, `pause_monitor`, `resume_monitor`, `update_monitor`, `run_monitor`, `cancel_monitor`, `delete_dataset`, `guide_next_step`, `list_profiles`, `create_profile`, `start_profile_setup_session`, `save_profile_setup_session`, `cancel_profile_setup_session`, `list_runs`, `list_browser_sessions`, `get_search_usage`, `list_fetch_usage`, `get_wallet`, `top_up_wallet`
- HIDE-DUPLICATE (15): `run_deep_research`†, `run_deep_research_async`†, `get_deep_research`†, `cancel_deep_research`†, `list_deep_research`†, `create_dataset`, `plan_dataset`, `get_dataset`, `get_dataset_rows`, `list_datasets`, `populate_dataset`, `cancel_dataset_run`, `run_web_automation_async`, `create_browser_session`, `close_browser_session`
- HIDE-BROKEN (2; they poll `batch_create`, which is not offered): `batch_status`, `batch_cancel`

## 4. The counter-case: where doing it ourselves is the waste

| Where | Why buying or borrowing wins |
|---|---|
| The money | Firecrawl Hobby is $19 for 5,000 credits, more than the free pool this design protects. If the owner's hours count, anything beyond plain fetch, sitemap map and a breadth-first loop loses to paying |
| Single-page fetch | Free vendor lanes exist today: TinyFish fetch (1,000 URLs a day), Bright Data's 5,000 requests, Jina keyless. Our own fetch buys privacy, cache and no daily cap, not dollars |
| The render tier | Most upkeep per page saved: browser memory, zombie processes, pinned builds, a new SSRF surface. Build it only if the ledger asks for it |
| Bot protection | Not winnable from a home IP. Local retries mark the IP, and the household then meets CAPTCHAs in ordinary browsing. One local try, then pay |
| A crawler on a home IP | 300 pages at one a second is ordinary; 5,000 pages, or a host answering 429, gets the household banned from a site it uses. Above about 1,000 pages, or when the circuit breaker trips, buy: Tavily crawl is 0.3 credits a page |
| The detector | A missed challenge page is cached as content and quoted by an agent; a false alarm spends credits |
| Search | SearXNG from one IP: engine CAPTCHAs, tuning, worse results |

**Keep buying, without second thoughts:** (1) web index search, including Exa's semantic search and Firecrawl's free indexes; (2) per-page unlock of bot-protected pages, Bright Data first, Firecrawl second.

## 5. Build order

Each step is useful if the next never happens.

1. **Paste the lists (no code).** 298 tools become 60; `examcp` and `tavilymcp` go. Agents stop seeing deletes, wallets, monitors, uncapped enrichment and three copies of every search.
2. **`coldsearch_fetch` with cache, plain and vendor tiers.** Lift the ADR 004 checks into a shared module (before agent mode is removed, if `idea-coldsearch-transformation.md` goes ahead); add redirects, `defuddle`, the detector with fixtures and a ledger line per tier. Hide the fetch and batch tools. Two weeks of ledger give the real plain, empty and blocked shares.
3. **`coldsearch_map` and `coldsearch_crawl`.** Sitemaps, robots, the breadth-first loop, politeness, circuit breaker, manifest. Hide vendor crawl and map: 40 tools. Most of the credits are here.
4. **Render tier, only if step 2's numbers ask for it.** Playwright in-process with the `page.route` check, or crawl4ai or Firecrawl Local as a sidecar. Screenshots come with it.
5. **Argument pins and the allowance poller.** Forced or default arguments per tool (`mode = "fast"`, `maxCredits`, `max_credits`, `effort`) bring the † tools back, Firecrawl's free daily agent runs first. The poller reads the HIDE-ADMIN usage endpoints. A page monitor is then a CronJob over `coldsearch_fetch`.

## Sources read today

- Tavily credits: <https://docs.tavily.com/documentation/api-credits>
- TinyFish pricing: <https://www.tinyfish.ai/pricing>
- Bright Data MCP: <https://brightdata.com/pricing/mcp-server>
- Firecrawl Local and self-hosting: <https://docs.firecrawl.dev/quickstarts/firecrawl-local>, <https://docs.firecrawl.dev/contributing/self-host>
- crawl4ai: <https://docs.crawl4ai.com/advanced/anti-bot-and-fallback/>, <https://docs.crawl4ai.com/core/url-seeding/>
- Jina Reader limits: <https://jina.ai/reader/>
- Releases and licences: the GitHub API for crawl4ai, Firecrawl, SearXNG, defuddle, turndown and Playwright
- Not verified: Firecrawl Local through the `openapi` connector; whether TinyFish fetch passes bot protection; which Bright Data tools the free pool covers; the block fingerprints against live sites.

# Commodity vs buy: what the gateway should do itself (2026-11-27)

- **Nature:** analysis and design proposal. Nothing here is built or tested; no vendor call was made for it.
- **Inputs:** the gateway tool inventory taken today (298 tools on 10 upstreams), `docs/components/gateway.md`, the vendor snapshots in this folder, and pages read today (listed at the end).
- **Allowances assumed:** Firecrawl three teams, 3,000–4,500 credits a month in total at 1 credit a page (as briefed; `idea-key-slot-rotator-dashboard.md` measured two distinct teams, 2,500, earlier today — if that still holds, multiply every pool percentage by 1.2–1.8). Tavily 1,000 credits a month per account. Exa a dollar balance. Parallel $5 a month, card-backed. Bright Data 5,000 requests a month. TinyFish search and fetch at $0.
- **Assumptions, not measurements:** the share of pages that need rendering or a paid unlock. Step 2 of the build order measures them.

## 0. Answer

1. Crawl, map, batch scrape, single-page fetch, screenshots, page monitors and "extract JSON with an LLM" are commodity. Buying them is the waste: a 300-page crawl is 300 Firecrawl credits against roughly 3 when we fetch ourselves and pay only for blocked pages.
2. Two things cannot be made at home: a web index (search, semantic search, verticals) and getting past bot protection. Keep buying both, the second per page.
3. Of 298 tools, 110 are admin, 113 duplicates and 15 unusable through the connector. Config alone takes agents to 60 tools; three native tools take them to 40.
4. In money the whole Firecrawl saving is worth about one $19 Hobby plan. The reasons to build are not hitting a 402 wall mid-task, keeping URL lists at home, cache reuse and a smaller tool list. Past a few hundred lines of code, stop (section 4).

## 1. Capability map

Costs are from `firecrawl.md`, `exa.md`, `parallel.md` and today's Tavily, TinyFish and Bright Data pricing pages. "cr" is a vendor credit.

| Family | Vendor tools in the dump | Cost there | Ourselves, with | What we lose | Verdict |
|---|---|---|---|---|---|
| Web index search | `exa.search`, `firecrawl.searchAndScrape`, `parallel.post_v1_search`, `tavily.search`, `brightdata.search_engine`, `tinyfish.search`, four MCP wrappers | Exa $4–12/1k; Firecrawl 2 cr per 10 results; Parallel $1/1k (`fast`) or $5; Tavily 1 cr (2 advanced); Bright Data free pool then $1.5/1k; TinyFish $0 at 30/min | SearXNG (`docker/searxng/`) as a floor only | From one IP the engines answer with CAPTCHAs and 429s, Google first; no semantic ranking or excerpts | **BUY**, free lanes first |
| Similar-page / semantic | `exa.search`, `exa.findSimilar` (deprecated), `firecrawl.researchRelatedPapers` | $7/1k; papers free | Nothing: needs an embedded web index | — | **BUY** |
| Fetch one URL to markdown | `exa.getContents`, `firecrawl.scrapeAndExtractFromUrl`, `parallel.post_v1_extract`, `tavily.extract`, `brightdata.web_fetch`, `tinyfish.fetch_content` | $1/1k pages; 1 cr; $1/1k; 1 cr per 5 URLs; free pool; $0 up to 1,000 URLs/day | The SSRF-safe GET in `src/agent/agent.ts` (ADR 004) + `defuddle` on `linkedom`, `pdftotext`, `src/cache/` | Tables and tabbed code on odd layouts; no vendor copy when the origin is down | **OURSELVES FIRST, VENDOR FALLBACK** |
| Fetch needing JS | Same tools; Tavily `extract_depth=advanced` is 2 cr per 5 | As above | Playwright 1.65 with the installed Chromium; or crawl4ai / Firecrawl Local as a sidecar | 300–500 MB per browser, 2–10 s a page, version drift; in the cluster it needs a browser pod | **OURSELVES FIRST, VENDOR FALLBACK** |
| Bot-protected pages | `brightdata.web_fetch` / `scrape_batch`, Firecrawl scrape `proxy`, `tinyfish.fetch_content`, Tavily advanced | One request or credit a page | Not from a residential IP: stealth patches lose to Turnstile, DataDome, PerimeterX, Kasada | Everything, and failed tries cost the home IP its reputation | **BUY**, per page, after detection |
| Site map | `firecrawl.mapUrls`, `tavily.map` | 1 cr a call; 1 cr per 10 URLs (2 with instructions) | `robots.txt` Sitemap lines, `sitemap.xml` and indexes, `llms.txt`, one hop of links | Orphan pages only a vendor index knows; semantic ranking of URLs | **DO OURSELVES** |
| Site crawl | `firecrawl.crawlUrls` and four helpers, `tavily.crawl` | 1 cr a page (5 with JSON); 3 cr per 10 pages, 5 advanced | Breadth-first loop over the fetch ladder | Speed (1–2 requests a second per host); very large crawls | **DO OURSELVES**, paid fallback per page |
| Batch scrape | `firecrawl.scrapeAndExtractFromUrls` and three helpers, `brightdata.scrape_batch`, `exa.createBatch` | Per page, as fetch | `fetch` with a URL list | Nothing new | **DO OURSELVES** |
| LLM structured extraction | Firecrawl `json` format, `firecrawl.extractData` (returns 410 from 2026-12-10), Exa `summary` / `outputSchema` | +4 cr a page; $1/1k pages | Nothing new: the calling agent reads our markdown. Bulk jobs use the configured OpenAI-compatible endpoint | Vendor parallelism over hundreds of pages | **DO OURSELVES** |
| Answer / research agents | `exa.answer`, Exa agent (7), Firecrawl agent (6), Parallel responses, decisions, Task (5), Task Group (6), FindAll (10), `tavily.createResearch`, TinyFish deep research (5), `brightdata.chatgpt_ai_insights` | $0.005; $0.012–1, `auto` up to $5; 5 free runs a day then hundreds of cr; $0.01–0.25; $0.001; $0.005–2.40 a run; 4–250 cr; $2–3 a run | The caller already is a research agent | Vendor parallelism, per-field citations | **BUY** the fixed-price routes, **HIDE** the rest |
| Monitors | Exa (9, plus 7 for Websets), Firecrawl (8, plus 8 MCP), Parallel (8), TinyFish (8) | $2/1k; 1 cr per page per check; $3–10/1k; $0.005 a check | A timer that calls `fetch` with the last hash and diffs | Vendor webhooks, which need a public endpoint anyway | **DO OURSELVES** outside the gateway; **HIDE** |
| File / PDF parsing | `firecrawl.parseFile`, `firecrawlmcp.firecrawl_parse`; PDF URLs through scrape or extract | 1 cr per PDF page; Parallel $1/1k URLs flat | `pdftotext`, `tesseract`; a local file never needs the gateway | Scanned or table-heavy PDFs, Office formats | **OURSELVES FIRST**; the upload tools **HIDE** |
| Screenshots | Firecrawl `screenshot` format, `brightdata.scraping_browser_screenshot` | 1 cr; browser traffic | Playwright in the render tier | A blocked site shows its challenge | **DO OURSELVES** |
| Interactive browser | Firecrawl interact (4, plus 2 scrape-bound), Bright Data `scraping_browser_*` (14), TinyFish `create_browser_session`, `run_web_automation` | 2 cr a minute; $8/GB; $0.002 a minute; $0.016 a step | A local Playwright MCP beside the agent, not through the gateway | Protected or geo-fenced sites | **OURSELVES** for open sites; **BUY** one route |
| Pre-built scrapers, datasets | Bright Data scrapers (6) and datasets (2), Alexandria (`alexandria_library_*`), Exa Websets (18), TinyFish datasets (8) | Per record; 1–40 cr per capability; $0.10/ACU; $0.10 a row | No: per-site parsers plus proxy pools | — | **BUY**, two routes |
| People / company | `people_company_search`, `people_company_enrich`, `jobs_search`, `brightdata.business_search`, `search_dataset`, Parallel entity search | Default caps 1,000 cr, none, 200 cr; per record; $5/1k | No: licensed data | — | **BUY** bounded routes; **HIDE** uncapped |
| Vertical search | Parallel flights, hotels, shopping, places, images; `parallelmcp.find_verticals`, `search_vertical`; Firecrawl research (4), developer, gov | $1–5/1k; research and gov free; developer 2 cr per 10 | No: licensed feeds | — | **BUY** (cheap or free) |
| Usage / account | Firecrawl usage, queue, activity; `tavily.getUsage`, `post_logs`, `post_org_usage`; `exa.get_v0_teams_me`; TinyFish wallet and usage; `brightdata.session_stats` | Free | — | — | **HIDE** (poller and `coldsearch_status`) |
| Feedback / support | Firecrawl feedback and `askSupportAgent`, `tavily.post_feedback`, `brightdata.ask_brightdata_assistant`, `tinyfish.guide_next_step` | Free | — | — | **HIDE** |
| Destructive / admin | Every `delete*`, `tinyfish.top_up_wallet`, profiles, `firecrawl.updateThreatProtection`, Exa webhooks and events, Parallel memory clear and evict, `firecrawl_save_skill` | — | — | — | **HIDE** |

## 2. Gateway-native tools

Names follow the existing `coldsearch_status`. Each is one more "provider", `local`, on the same audited surface: every tier attempt writes a ledger line, so the saving is measured, and the cache is the reuse store of goal G3. Cache hits are labelled and bounded by `max_age`, never silent.

### 2.1 `coldsearch_fetch`

| Argument | Meaning |
|---|---|
| `urls` | 1–50 URLs. This is also batch scrape |
| `format` | `markdown` (default), `text`, `html`, `links`, `screenshot` |
| `render` | `auto` (default), `never`, `always` |
| `vendor` | `auto` (default), `never`, `only`; `max_vendor` caps paid pages per call (default 5) |
| `max_age` | Oldest cached copy to accept (default `1h`; `0` is live) |
| `max_chars`, `offset` | Paging through long pages |
| `known_hash` | Return `unchanged: true` when the content hash matches |

Tiers, in order, per URL:

0. **cache**
1. **plain** — the ADR 004 checks, lifted out of the agent class into a shared module, plus what the code lacks today: redirects (up to 5, each hop validated again; it refuses all redirects now), compression, a 5 MiB cap in place of 1 MiB, `Accept: text/markdown, text/html`, conditional GET. HTML goes through `defuddle`; PDF through `pdftotext`.
2. **render** — Playwright Chromium with images, fonts and media blocked, then the same extractor. Every request the page makes passes the same SSRF check through `page.route`; a rendered page can otherwise reach LAN addresses.
3. **vendor** — one page, through the existing key order and failover, cheapest allowance first: TinyFish `fetch_content` ($0), Bright Data `web_fetch` (free pool, strongest unblocker), Firecrawl scrape (1 cr), Tavily `extract` advanced, Parallel `post_v1_extract`. The detector below also runs on the vendor's answer, because vendors return challenge pages too.

Each result carries `url, final_url, status, tier, title, content, content_hash, fetched_at, cost, blocked_reason`. The native tool calls upstream clients directly: a tool hidden by `exclude` is not callable through the agent-facing path.

### 2.2 When a page "needs fallback"

A starting set, to be kept as test fixtures. Like crawl4ai's detector it prefers structural markers to keywords.

| Class | Signals | Next tier |
|---|---|---|
| Empty shell | 2xx HTML whose extracted text is under 200 characters while the HTML is over 5 KB; text under 2% of HTML; an empty `#root`, `#__next` or `#app`; a `<noscript>` asking for JavaScript | render |
| JS proof of work | Anubis ("Making sure you're not a bot"); a Cloudflare non-interactive challenge | render once, then vendor |
| Blocked, by status | 401, 403, 406; 429 after one `Retry-After` wait; 503 with a challenge marker; 202 or 405 with `x-amzn-waf-action`; 999 | vendor |
| Blocked, by header | `cf-mitigated: challenge`, `x-vercel-mitigated: challenge`, `x-datadome` or a `datadome` cookie, `_px*` or `incap_ses_*` cookies, `x-kpsdk-*`, `x-sucuri-block` | vendor |
| Blocked, by body | Title "Just a moment…" with `/cdn-cgi/challenge-platform/`; `challenges.cloudflare.com/turnstile`; `captcha-delivery.com`; `px-captcha` or "Press & Hold"; Akamai "Access Denied" with `errors.edgesuite.net`; `_Incapsula_Resource`; an hCaptcha or reCAPTCHA script on a page with under 200 characters of text | vendor |
| Still empty after render | Under 200 characters | vendor |
| Never escalate | 404 and 410 (Firecrawl bills a returned 403 or 404 document), 451, 5xx after one retry, a robots-disallowed path, a login or paywall (`needs_auth`) | report |

### 2.3 `coldsearch_map`

Arguments: `url`, `limit` (500, max 5,000), `include_paths`, `exclude_paths`, `search` (keyword filter on URL and title), `include_subdomains`, `link_depth` (0–2, default 1).

Behaviour, with no vendor call: read `robots.txt` for Sitemap lines and rules; read `/sitemap.xml`, sitemap indexes and `.gz` files (capped at 50 files) keeping `lastmod`; read `/llms.txt` if present; if that yields little, fetch the start page and up to 20 linked pages and harvest same-site links. Normalise and deduplicate. Return `urls[{url, lastmod, source}]`, `total`, `truncated`, and the robots crawl delay.

### 2.4 `coldsearch_crawl` and `coldsearch_crawl_status`

Arguments: `url`, `max_pages` (50, hard cap 1,000), `max_depth` (3), `include_paths`, `exclude_paths`, `render`, `vendor` with `max_vendor_pages` (default the smaller of 10 and 5% of `max_pages`), `delay_ms` (1,000 per host, or the robots crawl delay if longer), `max_age`.

Behaviour: seed the frontier from `map`, then breadth-first through tiers 0–2. Pages classed as blocked or still empty go to the vendor tier up to the cap. The crawl fills the cache and returns a manifest (`url, title, chars, hash, tier`), not megabytes; the agent reads pages with `coldsearch_fetch`, which are then cache hits. A crawl that outlives the call returns a `crawl_id`.

Politeness is operator config, not an agent argument: an honest user agent, robots obeyed for map and crawl, two connections per host, five requests a second overall, 2,000 pages per host per day. Circuit breaker: three consecutive 403 or 429 answers, or more than 30% hard blocks in the first 20 pages, stops the crawl with `site_protected` and an estimate of the vendor cost. A robots-disallowed path is skipped, never escalated.

### 2.5 `monitor` stays out of the gateway

A monitor needs a scheduler, durable state and somewhere to send the result; the gateway is request and response, sometimes one process per agent. The gateway supplies the primitives (`content_hash`, `known_hash`, conditional GET, the cached previous copy). The schedule is a Kubernetes CronJob or systemd timer that calls `coldsearch_fetch` and posts the diff. "New results for a query" is the same job with a search and a seen-URL set.

Vendor monitors are hidden because each is standing spend tied to one account that keeps billing after failover. Ten pages checked hourly on Firecrawl is 7,200 credits a month, more than the whole pool.

### 2.6 Engines checked today

| Candidate | State on 2026-11-27 | Use |
|---|---|---|
| `defuddle` 0.19.13 (MIT) | `defuddle/node` takes a `linkedom` or JSDOM document and emits Markdown | Plain-tier extractor |
| Readability + `turndown` 7.2.5 (MIT) | The older pair; Readability last pushed in August | Alternative |
| Playwright 1.65.1 | Installed on the workstations with Chromium builds | Render tier, screenshots |
| crawl4ai 0.9.6 (Apache-2.0, 2026-11-20) | Python. Deep crawl, sitemap and Common Crawl seeding, block detection with a `fallback_fetch_function`, Docker server; a hosted cloud now exists too | Sidecar, if we would rather not own render and crawl |
| Firecrawl Local (announced 2026-11-18) | One Rust binary serving the v2 API. Scrape, crawl, map and parse run locally; JS needs local Chrome; obeys robots when crawling; `FIRECRAWL_CLOUD=off` stops its own cloud fallback. No `json` or `summary` formats; jobs live in memory for an hour | Zero-code trial as an `openapi` upstream on localhost (untested) |
| Firecrawl self-host compose (`v2.11.162`, AGPL-3.0) | API, workers, Postgres, Redis, RabbitMQ, Playwright. No Fire-engine, so no anti-bot, screenshots or actions | Not worth it here |
| Jina Reader, keyless | `r.jina.ai` 20 requests a minute without a key; `s.jina.ai` needs one; self-hosting is a commercial licence | Optional free third-party render lane |
| SearXNG (AGPL-3.0) | Active; compose file and settings already in the repo | Search floor only |

### 2.7 Saving on two examples

**A 300-page documentation site.** Assumed: 3% of pages need rendering, 1% a paid unlock.

| Route | Cost | Share of the Firecrawl pool |
|---|---|---|
| Firecrawl `crawlUrls` | 300 cr | 7–10% (20–30% of one team) |
| The same with the `json` format | 1,500 cr | 33–50% |
| Tavily `crawl`, basic / advanced | 90 / 150 cr | 9% / 15% of one Tavily account |
| Ours | 0 for about 297 pages, 3 cr for 3 unlocks (0 if TinyFish or Bright Data take them) | 0.1% |

About 297 credits saved a crawl, at the price of 3–5 minutes of polite fetching. A pool that buys 10–15 such crawls a month covers all of them and keeps about 3,000–4,500 unlocks.

**A 20-URL batch, 3 bot-protected.**

| Route | Cost |
|---|---|
| Firecrawl batch scrape | 20 cr, including any page returned as a 403 |
| Tavily `extract` | 4 cr basic, about 2 more to retry the protected three as advanced |
| Ours | 17 pages local; 3 vendor pages: 3 Bright Data requests from the free pool, or 3 Firecrawl cr |

17 of 20 credits saved against Firecrawl; almost nothing against Tavily. The value is in volume: the research run recorded in `idea-agent-search-routing.md` made 310 fetches, which is 310 credits through Firecrawl or about 45 at this block rate. Pool-wide, 3,000–4,500 credits serve 3,000–4,500 pages when bought, and 20,000–90,000 when only the blocked 5–15% are.

## 3. Per-tool classification

Classes: **EXPOSE**; **REPLACE** (hide once the native tool ships; stays callable inside the gateway as a vendor tier); **HIDE-ADMIN** (destructive, billing, account, feedback, standing schedules, team-wide listings and traces, and tools whose default spend cap is a fifth of a month's allowance or more); **HIDE-DUPLICATE** (the capability is exposed through a better route); **HIDE-BROKEN** (cannot work through a JSON connector, or is orphaned or removed upstream).

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

**Agents are left with 60 upstream tools today (config only) and 40 once fetch, map and crawl ship**, plus the gateway's own (`coldsearch_status`, `coldsearch_read_skill` and the four new ones): 46 in `all` mode.

Judgement calls that can be flipped:

- **† Hidden for an unsafe default, not for lack of value.** Exa agent (`effort` defaults to `auto`, capped at $5), Firecrawl agent (five free runs a day per team, then hundreds of credits), FindAll runs, Tavily and TinyFish research, `people_company_search` (default cap 1,000 cr), `people_company_enrich` (no cap), `jobs_search` (200 cr). Re-expose each when the gateway can pin an argument (step 5).
- **Research agent route:** Parallel Task, because `processor` is required and fixes the price. Note that Parallel's free credit is card-backed, so overage may bill.
- **Remote browser route:** Firecrawl interact (three tools, takes Playwright code). Bright Data's 14 step tools are the stronger unblocker; swap by `include` if preferred.
- **List building:** Websets and TinyFish datasets are hidden as duplicates of a Task run with a list schema.
- **Keyless lanes:** a second `parallelmcp` upstream with no key is a free search and fetch lane (per-IP limits unpublished); classified here as keyed.

An operator profile is a second config file with no lists, started with `--config`; hidden tools stay reachable there for the allowance poller and for provider comparisons.

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
| The money | Firecrawl Hobby is $19 for 5,000 credits; Tavily pay-as-you-go is $0.008 a credit. The whole free pool this design protects is worth about $19 a month. If the owner's hours count at all, anything beyond plain fetch, sitemap map and a breadth-first loop loses to paying |
| Single-page fetch | Free vendor lanes exist today: TinyFish fetch ($0, 1,000 URLs a day), Bright Data's 5,000 requests, Jina keyless, keyless Parallel. Our own fetch buys privacy, cache and no daily cap, not dollars. Those prices can change without notice |
| The render tier | The most upkeep per page saved: browser memory, zombie processes, pinned browser builds, and a new SSRF surface. Build it only if the ledger shows empty shells are a material share of paid pages; otherwise let the free vendor lanes render |
| Bot protection | Not winnable from a home IP. Retrying locally spends time and marks the IP, and the household then meets CAPTCHAs in ordinary browsing. One local try, then pay |
| A crawler on a home IP | 300 pages at one a second is ordinary. 5,000 pages, or any host that answers 429, is how the household gets banned from a site it uses. Above about 1,000 pages or on the first circuit-breaker trip, buy: Tavily crawl is 0.3 credits a page, a third of Firecrawl's price |
| The detector | A missed challenge page is cached as content and quoted by an agent; a false alarm spends credits. It needs fixtures and upkeep as vendors change markup |
| Search | SearXNG from one IP is the standard self-hosting waste: engine CAPTCHAs, tuning, worse results |
| Scrapers and enrichment | Site-specific parsers for walled sites break monthly |

**Keep buying, without second thoughts:** (1) web index search, including Exa's semantic search and the free Firecrawl indexes; (2) per-page unlock of bot-protected pages, with Bright Data first and Firecrawl second. Pre-built scrapers for walled sites are a third when a task needs them.

## 5. Build order

Each step is useful if the next never happens.

1. **Paste the lists (no code).** 298 tools become 60; `examcp` and `tavilymcp` go. Agents stop seeing deletes, wallets, monitors, uncapped enrichment and three copies of every search. Add "TinyFish search and fetch are free" to the routing skill.
2. **`coldsearch_fetch` with cache, plain and vendor tiers.** Lift the ADR 004 checks into a shared module (before agent mode is removed, if `idea-coldsearch-transformation.md` goes ahead), add redirects and `defuddle`, the detector with fixtures, and a ledger line per tier. Hide the fetch and batch tools. Two weeks of ledger then give the real plain, empty and blocked shares.
3. **`coldsearch_map` and `coldsearch_crawl`.** Sitemaps, robots, `llms.txt`, the breadth-first loop, politeness and the circuit breaker, manifest plus cache. Hide vendor crawl and map: 40 tools. This is where most of the credits are.
4. **Render tier, only if step 2's numbers ask for it.** Playwright in-process with the `page.route` SSRF check, or crawl4ai or Firecrawl Local as a sidecar. Screenshots come with it.
5. **Argument pins and the allowance poller.** Per-tool forced or default arguments (`mode = "fast"`, `maxCredits`, `max_credits`, `effort`) so the † tools can return, with Firecrawl's five free agent runs a day per team first. The poller reads the HIDE-ADMIN usage endpoints. A page monitor is then a CronJob over `coldsearch_fetch`.

## Sources read today

- Tavily credits: <https://docs.tavily.com/documentation/api-credits>, <https://docs.tavily.com/documentation/api-reference/endpoint/search>
- TinyFish pricing: <https://www.tinyfish.ai/pricing>
- Bright Data MCP: <https://brightdata.com/pricing/mcp-server>, <https://docs.brightdata.com/mcp-server/overview>
- Firecrawl Local and self-hosting: <https://docs.firecrawl.dev/quickstarts/firecrawl-local>, <https://docs.firecrawl.dev/contributing/self-host>
- crawl4ai: <https://docs.crawl4ai.com/>, <https://docs.crawl4ai.com/advanced/anti-bot-and-fallback/>, <https://docs.crawl4ai.com/core/url-seeding/>
- Jina Reader limits: <https://jina.ai/reader/>
- Release and licence state from the GitHub API for `unclecode/crawl4ai`, `firecrawl/firecrawl`, `searxng/searxng`, `kepano/defuddle`, `mixmark-io/turndown`, `mozilla/readability`, `microsoft/playwright`
- SearXNG engine blocking from one address: <https://www.ssdnodes.com/learn/searxng-rate-limits-and-429-errors> (a hosting vendor's guide; anecdotal)
- Not verified: whether Firecrawl Local works through the `openapi` connector; whether TinyFish fetch passes bot protection; Bright Data's per-tool free-tier coverage; the block fingerprints against live sites.

# Provider Contract Audit — 2026-10-12

**Status:** dated evidence snapshot supporting [#79](https://github.com/MooseGooseConsulting/ColdSearch/issues/79). Like all `docs/reviews/` entries it does not override `docs/PROVIDERS.md`, `docs/NORTH_STAR.md`, `docs/architecture.md`, or code — it records what was verified, where, and when, so the issue's execution phases start from sourced ground truth rather than memory.

**Method:** bounded research agents against official provider documentation and official OpenAPI specs only, reconciled into one report. Every claim carries an as-of date of 2026-10-12. **Doc inspection is not live proof**: nothing here advances any `live-verified` claim; `schemaLastVerified` semantics (inspected-date vs live-evidence) are a Section-E reconciliation item in the issue.

**Scope:** all 8 registered providers, 32 tool profiles (20 core + 12 Bright Data) as enumerated at commit `ba0a128`. "Wired / not wired" statements below describe the registry at that commit; wiring status itself is internal and not externally verifiable — endpoint existence and shape are.

## Drift findings at a glance

| Provider | Finding | Registry/docs impact |
|---|---|---|
| Tavily | No `/answer` endpoint exists; answers are the `include_answer` param on `/search`. `PROVIDERS.md` lists "POST /answer ❌" — stale as stated. Registry profile `tavily.answer` is already correctly named. | Fix PROVIDERS.md only. |
| Exa | `/research` **retired 2026-05-01** (replaced by `/search` `type: deep-reasoning`). `/findSimilar` **deprecated** but still callable and still adapter-wired. `livecrawl` param **deprecated** → `maxAgeHours` + `livecrawlTimeout`. Category enum stale: `research paper` → `publication`; `pdf`/`github`/`tweet` deprecated. | Registry + PROVIDERS.md; plan `/findSimilar` migration. |
| Brave | Plans repackaged ~Feb 2026 (old Free/Data-for-AI tiers gone; LLM Context now ships in the standard Search plan). LLM Context path is `/res/v1/llm/context`; the registry and dispatcher now agree. New: OpenAI-compatible `POST /res/v1/chat/completions` (Answers product), catalogued as an available profile. | Registry path fix; Answers profile. |
| Firecrawl | All 8 claimed endpoints current on v2. New surface: `/interact`, `/parse`, `/monitor`, vertical indexes (`/search/research/papers`, `/search/developer`, `/search/gov`). `/extract` is now the legacy structured-extraction path; `/agent` (default model `spark-2`) is the successor. | New `available` profiles; mark `/extract` deprecation direction. |
| Serper | Search parameters, including `location`, are documented. Additional vertical, scraping, and locations routes were named in research notes but their existence and schemas were not verified; an unauthenticated 403 does not establish that a route exists. `serper.dev/docs` now 404s. | Add `location` to `serper.search`; keep other routes as deferred candidates pending authoritative or authenticated verification. |
| Jina | `r.jina.ai` Reader still supports keyless use (20 RPM without a key); `s.jina.ai` is key-gated. Reader has a broad header surface, but this JSON call only exposes documented headers and does not implement local-file upload or incremental event streaming. Embeddings v5, reranker v3.5, and DeepSearch were identified as surfaces, but their profiles remain deferred pending schema/dispatch reconciliation. **No standalone summarize endpoint exists.** Jina acquired by Elastic 2025-10 (ownership-risk note). | Refresh Reader params and behavior notes; catalog additional surfaces as deferred candidates. |
| SearXNG | 2026.10.11 docs confirm `/search` params; `format=json` must be enabled in `settings.yml` (unset → 403; most public instances disable it). `engines` works but is absent from the official params table. Registry missing `safesearch`. | Minor registry addition. |
| Bright Data | 12 profiles span 11 distinct provider operations; Crawl and trigger use the same path with different datasets. Sharpening: Crawl API **is** `POST /datasets/v3/trigger` with a crawl `dataset_id` (no separate REST namespace — old crawl-api doc URLs redirect); Discover = `POST /discover` → `task_id` → poll `GET /discover?task_id=`; Unlocker also has an async `/unblocker/req` + webhook variant; Browser API is CDP-only (no REST), retroactively justifying its exclusion. Marketplace has a full REST API (`/filter` BETA) — its exclusion is a scoping choice, not an absence. | Notes sharpening; no path errors found. |

## Per-provider records

### Tavily — `src/adapters/tavily.ts`

Verified against docs.tavily.com (OpenAPI YAML embedded per endpoint page), 2026-10-12.

- Endpoints: `POST /search`, `POST /extract`, `POST /crawl`, `POST /map` (all sync); `POST /research` (**async**: returns `request_id`, poll `GET /research/{request_id}`, 202 while pending; optional SSE via `stream:true`); `POST /feedback` (beta); `GET /usage`; `POST /logs` (paid plans only); enterprise key management.
- `/search` params: `query` (req); `search_depth` = basic(default, 1cr)/advanced(2cr)/fast/ultra-fast; `topic` = general/news/finance (confirmed); `max_results` default 10 (0–20); `time_range` d/w/m/y or `start_date`/`end_date`; `include_answer` (bool or basic/advanced — there is no `/answer` endpoint); `include_raw_content`; `include_domains`/`exclude_domains` (+ `include_domains_mode`); `country`; `language`; `safe_search`; `exact_match`; `auto_parameters`.
- `/extract` can return `failed_results[]` on HTTP 200 — partial-failure is part of the contract, not an error state.
- Error model: body `{"detail": {"error": "..."}}`; 422 validation uses `{"detail": [{type, loc, msg, input}]}`; 429 + `Retry-After`; **432** key/plan limit exceeded; **433** PAYGO limit exceeded.
- Sources: docs.tavily.com/documentation/api-reference/endpoint/search, /extract, /crawl, /research; /documentation/rate-limits; /documentation/api-credits.

### Firecrawl — `src/adapters/firecrawl.ts`

Verified against docs.firecrawl.dev including the official v2 OpenAPI spec (api-reference/v2-openapi.json), 2026-10-12.

- All 8 claimed endpoints current on v2 (`/search`, `/scrape`, `/crawl`, `/map`, `/extract`, `/agent`, `/batch/scrape`, scrape `actions[]`). `/crawl` async confirmed: POST returns `{success, id, url}`; poll `GET /crawl/{id}`; webhook events (`crawl.started/page/completed/failed`); DELETE cancels.
- New in ~12 months: `/interact` browser-sandbox sessions, `/parse`, `/monitor` (8 routes), vertical indexes `/search/research/papers`(+similar), `/search/developer`, `/search/gov`, support/debug endpoints.
- `/extract` (async, `GET /extract/{id}` poll) is legacy-but-live; `/agent` (async, default model **spark-2**, `trace`/`snapshots` sub-routes) is Firecrawl's successor for structured extraction. Deprecation direction should be recorded, not silently swapped.
- Error model: uniform `{"success": false, "error", "code"?, "details"?}`; 402 insufficient credits; 429 + `Retry-After`. **Some target-site failures return HTTP 200 with `success:false` + `code`** — the success flag must be checked, not status alone.
- Sources: docs.firecrawl.dev/api-reference/endpoint/*, /api-reference/errors, /billing, /rate-limits.

### Exa — `src/adapters/exa.ts`

Verified against exa.ai/docs (docs.exa.ai mirrors; changelog dated 2026-09-29), 2026-10-12.

- `/search` type enum **confirmed**: auto(default, ~1s), fast(~450ms), instant(~250ms), deep-lite(~4s), deep(4–15s), deep-reasoning(12–40s). `neural` remains valid as a legacy type. "Deep Max" was announced but is not in the public enum.
- `livecrawl` **deprecated** → `maxAgeHours` (0 = always fetch, −1 = cache-only) + `livecrawlTimeout`. `highlights`/`text`/`summary` nest under `contents{}` on `/search`.
- Category enum stale: `research paper` → **`publication`**; `pdf`, `github`, `tweet` deprecated. Current set ≈ company, people, publication, news, personal site, financial report.
- `/research` **removed 2026-05-01** (deprecation notice dated; replaced by `/search` `type: deep-reasoning`). `/findSimilar` **deprecated** (OpenAPI marks it; still callable). New surfaces: Agent API `/agent/runs` (async, polling free), Monitors (scheduled search → webhook), Batch API, Websets, Snapshot (paid-only).
- Error model: `{requestId, error, tag}` with machine tags (`INVALID_API_KEY`, `NO_MORE_CREDITS`, `RATE_LIMIT_EXCEEDED`, `FEATURE_DISABLED`, ...); `Retry-After` on 429; `/contents` reports per-URL failures in `statuses[]` on HTTP 200.
- Free tier is **$10 credits/month + $10 onboarding bonus**, not a 1,000-request tier.
- Sources: exa.ai/docs/reference/search, /search/quickstart, /admin/error-codes, /integrations/openai-sdk, exa.ai/pricing.

### Brave — `src/adapters/brave.ts`

Verified against api-dashboard.search.brave.com (official API reference), 2026-10-12.

- `GET/POST /res/v1/web/search` confirmed (q ≤600 chars, `count` 1–20 default 20, `offset`, `freshness` pd/pw/pm/py or date range, `safesearch`, `spellcheck`, `result_filter`, `goggles`, `extra_snippets`). Auth: `X-Subscription-Token`.
- LLM Context uses **`GET/POST /res/v1/llm/context`**. The registry profile and substrate dispatcher now use this path. Returns `{grounding:{generic[], poi{}, map[]}, sources}`.
- New: `POST /res/v1/chat/completions` (OpenAI-compatible; models `brave-pro` default / `brave`; exactly one user message; `stream` default true) — the "Answers" product.
- **Packaging changed ~Feb 2026:** old Free/Free AI/Base AI/Pro AI "Data for AI" plans retired. Current: Search ($5/1k requests, 50 rps, includes web+news+images+videos+LLM Context), Answers ($4/1k + token metering, 2 rps), Enterprise; Spellcheck/Autosuggest are separate prepaid add-ons. Every plan includes $5/month credits; credit card required; no standalone free tier.
- Rate-limit headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Policy` (includes monthly quota window), `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- Error model: status codes documented (200/400/402/403/404/422/429); exact error-body JSON shape **not verified** (docs list codes only).
- Sources: api-dashboard.search.brave.com/api-reference/web/search/get, /summarizer, /documentation/guides/rate-limiting, /documentation/guides/versioning.

### Serper — `src/adapters/serper.ts`

Reviewed against the Serper homepage and login-gated playground, 2026-10-12. Unauthenticated probes returned 403, which does not establish route existence or schema.

- `/search` supports a `location` parameter. Additional routes named in prior notes (`/images`, `/news`, `/videos`, `/shopping`, `/maps`, `/places`, `/scholar`, `/patents`, `/autocomplete`, `/reviews`, `/lens`, `scrape.serper.dev/webpage`, `/shots`, and `api.serper.dev/locations`) remain unverified candidates. Their 403 responses without credentials do not confirm route existence or request schemas; registry entries are deferred and carry no asserted parameters.
- `/search` params: `q` (req), `gl`, `hl`, `num` (≤100; top-100 costs 2 credits), `page`, `tbs`, `location`, `autocorrect`; auth `X-API-KEY`. Response: `searchParameters`, `organic[]` (+ optional `answerBox`, `knowledgeGraph`, `peopleAlsoAsk[]`, `relatedSearches[]`). Errors: JSON `{message, statusCode}`.
- Docs moved: `serper.dev/docs` now 404s; docs surface is the homepage demo + login-gated playground.
- Sources: serper.dev (homepage/pricing, 2026-10), serper.dev/playground. No authenticated route validation was available for the candidate endpoints.

### Jina — `src/adapters/jina.ts`

Verified against jina.ai official pages (reader/models/news), 2026-10-12.

- `r.jina.ai` Reader **still keyless**: 20 RPM without a key; 500 RPM with free key; premium 5,000 RPM. GET/POST; billed on output tokens; 10M free tokens per new key. **Keyless claim CONFIRMED.**
- The Reader profile exposes the documented header surface, including `Accept: application/json` / `text/event-stream`, `X-Engine`, `X-Return-Format`, `X-Timeout`, `X-Token-Budget`, `X-Respond-With` (now **`jina-ocr-v1`**, ~40× tokens; ReaderLM-v2 de-emphasized), selectors, and related options. Direct calls forward those headers. JSON responses are parsed as JSON; event-stream responses are returned as text rather than streamed incrementally. Local PDF/HTML POST upload is not exposed by this JSON request path.
- `s.jina.ai` search: key-gated. The Jina search, embeddings, rerank, and DeepSearch profiles are deferred because their request schemas and substrate dispatch are not reconciled here.
- Other documented surfaces include `POST api.jina.ai/v1/embeddings` (v5 nano/small + v5-omni; **v3 deprecated**), `POST api.jina.ai/v1/rerank` (v3.5 2026-07; **v2 deprecated**), and `POST deepsearch.jina.ai/v1/chat/completions` (OpenAI-compatible, model `jina-deepsearch-v1`; `g.jina.ai` grounding folded into DeepSearch). **No standalone summarize endpoint exists** — DeepSearch covers that use case.
- Corporate: Jina acquired by **Elastic** (2025-10); lineup rebranded "Search Foundation". Ownership-risk note for the adoption ledger.
- Not verified: docs.jina.ai unreachable from research network; paid $/token prices (login-gated).
- Sources: jina.ai/reader, jina.ai/models, official jina-ai GitHub (node-DeepResearch).

### SearXNG — `src/adapters/searxng.ts`

Verified against docs.searxng.org (footer version 2026.10.11+ad46ebd7d), 2026-10-12.

- `GET/POST /search`: `q` (req), `categories` (comma-separated), `language`, `pageno`, `time_range` (day|month|year), `format` (json|csv|rss), `safesearch` (0|1|2), `theme`. **`engines` works in practice but is not in the official params table.**
- `format=json` must be enabled under `search: formats:` in `settings.yml`; requesting a disabled format returns **403**. Most public instances disable JSON. No built-in API auth; protection via limiter.toml / reverse proxy.
- Response: `{query, number_of_results, results[] (title/url/content/engine(s)/score/category), answers, corrections, infoboxes, suggestions, unresponsive_engines}`.
- Sources: docs.searxng.org (Search API page, admin/settings), official container .env template (SEARXNG_* env mapping).

### Bright Data — `src/adapters/brightdata.ts` / `src/tools/brightdata.ts`

Verified against docs.brightdata.com (pages carry Sept–Oct 2026 freshness), 2026-10-12.

- The 12 registry profiles span 11 distinct provider operations. They include SERP `POST /request` (SERP zone; realtime sync; 7 engines incl. Google/Bing/DDG/Yandex/Baidu/Yahoo/Naver), Web Unlocker `POST /request` (Unlocker zone; sync — plus async `/unblocker/req` + `webhook_*` variant), `GET /datasets/list`, `GET /datasets/{id}/metadata`, `POST /datasets/v3/scrape` (sync; 1-min timeout → 202 + `snapshot_id` fallback), `POST /datasets/v3/trigger` (async → `snapshot_id`; Crawl uses the same path with a crawl dataset), `GET /datasets/v3/progress/{snapshot_id}`, `GET /datasets/snapshots/{id}` (marketplace metadata path), `POST /datasets/v3/snapshot/{snapshot_id}/cancel` (+ `/rerun`), snapshot download `GET /datasets/v3/snapshot/{snapshot_id}`, and `POST /discover`.
- Sharpening: **Crawl API is not a separate REST namespace** — it is `POST /datasets/v3/trigger` with a crawl `dataset_id` (old `scraping-automation/crawl-api/*` doc URLs redirect to the Scraper API overview). The registry's "trigger (Crawl API dataset)" mapping is exactly right.
- Discover: `POST /discover` → `task_id` → poll `GET /discover?task_id=` until `status:"done"`; modes standard|deep|fast|zeroRanking; errors 401/403/404/429. No dedicated docs.brightdata.com product page located — evidence via official brightdata/skills repo, official MCP `discover` tool, official SDKs.
- Browser API: CDP-only (`wss://brd.superproxy.io:9222` Puppeteer/Playwright; Selenium :9515); official docs state "no REST API connection method at this time" — exclusion retroactively justified.
- Marketplace Dataset API is a full REST surface (`/filter` BETA, parts, deliver) — its exclusion from initial scope is a product choice, not an absence.
- Sources: docs.brightdata.com (products/serp-api, web-unlocker, scrapers, scraping-browser; api-reference/rest-api/*), brightdata.com/products/crawl-api, github.com/brightdata/skills.

## Unknowns and not-verified items

- Brave: exact error-body JSON shape (docs list status codes only); full news/images param lists.
- Exa: whether `deep-max` exists as a public type (announcement only); single canonical category enum table (changelog confirms `publication` + deprecations).
- Bright Data: dedicated docs page for Discover API; SERP per-engine query-param pages.
- Jina: docs.jina.ai unreachable; paid prices login-gated.
- All "not wired" statements: internal wiring is not externally verifiable; only endpoint existence/shape was verified.
- Live behavior of every provider: **not exercised in this audit.** Nothing here is live proof.

## Related

- Issue #79 (P1: Reconcile native provider contracts, tool groupings, and executable conformance) — the main spec and follow-up set attachments are in the issue comments (`main-provider-alignment-issue.md`, `provider-alignment-follow-up-issues.md`).
- [#72](https://github.com/MooseGooseConsulting/ColdSearch/issues/72) — prior contract drift log (fixed in #71). This audit is the next entry's evidence.
- `docs/PROVIDERS.md` — remains the machine-checked matrix; the corrections above land through issue #79's execution, not through this document.

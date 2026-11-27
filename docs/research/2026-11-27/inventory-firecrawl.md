# Firecrawl: complete programmatic surface and gateway gaps (2026-11-27)

- **Date researched:** 2026-11-27 (live checks made between 09:30 and 10:30 UTC).
- **Purpose:** list every way to call Firecrawl programmatically, then compare it with what the ColdSearch MCP gateway exposes (`docs/components/gateway.md`) and say exactly what to change.
- **How it was counted:** every spec document was downloaded with `curl` and its operations enumerated by a script (method + path). A second script re-implemented the gateway's tool-building rules from `src/gateway/openapi.ts` and reproduced the gateway dump exactly (57 of 57 tool names and argument lists match), so the gateway columns below are computed, not read off prose.
- **What was not done:** no API key was used and no billable endpoint was called. Live checks were limited to: unauthenticated `GET`s that return `401`/`404`/`410`, the keyless `initialize`, `tools/list` and `resources/list` of the hosted MCP server, free Alexandria catalogue lookups through an already-connected OAuth connector, and public package registries and GitHub.
- **Labels:** *spec* = in a published OpenAPI document. *docs* = on docs.firecrawl.dev. *source* = in the vendor's public GitHub repositories or npm packages. *live* = observed on 2026-11-27. **UNCONFIRMED** = could not be verified without a key.

Primary sources (all fetched 2026-11-27):

- Docs index: https://docs.firecrawl.dev/llms.txt, https://docs.firecrawl.dev/_llms/en/v2.txt, https://docs.firecrawl.dev/llms-full.txt
- API source: https://github.com/firecrawl/firecrawl (`apps/api/src/routes/v2.ts`, `apps/api/src/controllers/v2/types.ts`, `apps/js-sdk/firecrawl/src/v2/`)
- MCP source: https://github.com/firecrawl/firecrawl-mcp-server (`src/`, `CHANGELOG.md`, `docs/search-profile.md`, `tests/contract-snapshots/`), npm `firecrawl-mcp` 3.42.0
- CLI source: https://github.com/firecrawl/cli (`src/index.ts`, `skills/`), npm `firecrawl-cli` 1.30.0

## 0. Headline numbers

| Item | Count | Source |
| - | - | - |
| Operations in the current v2 spec | 57 (45 paths; GET 30, POST 19, DELETE 6, PATCH 1, PUT 1) | script over the spec |
| Gateway `firecrawl` tools | 57, one per v2 operation | gateway dump |
| Gateway `firecrawlmcp` tools | 38 | gateway dump |
| v2 operations that have a hosted MCP tool | 30 | section 3.3 |
| v2 operations with no hosted MCP tool | 27 | section 3.3 |
| Hosted MCP tools that are not plain wrappers of a v2 operation | 10: 6 run a first-party `firecrawl/*` Alexandria capability through `POST /scrape`, 4 are hosted-only. A further 7 wrap an operation but add behaviour (section 3.2) | MCP source, gateway dump |
| Operations in the v1 spec / v0 spec | 23 / 5 | script |
| Webhook event payloads (no callable operations) | 13 | script |
| Partner API endpoints (no spec published) | 3 | docs |
| Documented or observable REST route groups missing from every spec | 12 (section 2) | docs, source, live |
| Alexandria catalogue | 3,561 capabilities, 623 providers, 35 categories | catalogue README, live |

## 1. Published spec documents

`https://docs.firecrawl.dev/llms.txt` links 26 spec URLs: 6 distinct English documents plus the same file names under `/es`, `/fr`, `/ja`, `/pt-BR` and `/zh` (20 links; not hashed individually, assumed copies: UNCONFIRMED).

| # | Document | URL | Base URL in `servers` | Auth | Paths / operations | Status |
| - | - | - | - | - | - | - |
| 1 | v2 (current) | https://docs.firecrawl.dev/api-reference/v2-openapi.json | `https://api.firecrawl.dev/v2` | `Authorization: Bearer <fc- key>` (`bearerAuth`, http bearer) | 45 / 57 | Current. OpenAPI 3.0.0. The gateway's `firecrawl` preset |
| 2 | v1 | https://docs.firecrawl.dev/api-reference/v1-openapi.json | `https://api.firecrawl.dev/v1` | same | 21 / 23 | Retiring: v1 scrape, crawl, batch scrape, search, map and account endpoints return `410` from 2026-12-10 15:00 UTC (https://docs.firecrawl.dev/migrate-to-v2) |
| 3 | v0 | https://docs.firecrawl.dev/v0/api-reference/v0-openapi.json | `https://api.firecrawl.dev/v0` | same | 5 / 5 | Legacy. Restricted keys get `403` on v0 (https://docs.firecrawl.dev/features/key-restrictions). `GET /v0/crawl/status/{id}` still answers `401` without a key (live), so the routes exist |
| 4 | Webhooks | https://docs.firecrawl.dev/api-reference/webhooks-openapi.json | none | none | 0 / 0, 13 `webhooks` entries | OpenAPI 3.1.0. Payload shapes Firecrawl POSTs to a caller's URL; nothing to call |
| 5 | v1, older copy | https://docs.firecrawl.dev/v1/api-reference/v1-openapi.json | `https://api.firecrawl.dev/v1` | same | 20 paths, 22 operations | Stale copy. Lacks `GET /team/queue-status` |
| 6 | v2, older copy | https://docs.firecrawl.dev/v1/api-reference/v2-openapi.json | `https://api.firecrawl.dev/v2` | same | 16 paths, 18 operations | Stale copy from the v2 launch. Do not use |
| 7 | v2, SDK copy | https://raw.githubusercontent.com/firecrawl/firecrawl/main/apps/elixir-sdk/openapi.json | `https://api.firecrawl.dev/v2` | same | 44 paths, 56 operations | Input to the generated Elixir SDK. Lacks `GET /search/research/proteins` |

Checked and absent (`404`, live): `https://docs.firecrawl.dev/api-reference/v0-openapi.json`, `https://api.firecrawl.dev/openapi.json`, `https://api.firecrawl.dev/v2/openapi.json`, `https://integrations.firecrawl.dev/openapi.json`, `https://integrations.firecrawl.dev/partner/v1/openapi.json`. The partner API, OAuth endpoints and the hosted MCP server have **no** OpenAPI document.

Facts about the v2 spec that matter to a generic OpenAPI gateway:

- No operation declares a `servers` override; all 57 are on `https://api.firecrawl.dev/v2`.
- No operation declares a header, cookie or non-JSON response. One operation takes `multipart/form-data` (`POST /parse`); every other request body is `application/json`.
- No operation carries `deprecated: true`, including `/extract`, so a gateway cannot detect the removal from the spec.
- Tags: Scraping 10, Monitoring 8, Crawling 6, Agent 6, Billing 4, Interact 4, Research 4, Extraction 2, Search 2, Developer 2, Government 2, Threat Protection 2, Mapping 1, Miscellaneous 1, Account 1, Support 1, Feedback 1.

### 1.1 v2 operations (57)

Gateway tool names are `firecrawl__<name>`. "Hosted MCP tool" is the tool on `https://mcp.firecrawl.dev/v2/mcp` that calls the same operation (from the MCP server source).

| # | Method | Path | operationId | Gateway tool (`firecrawl__…`) | Arguments as the gateway exposes them | Hosted MCP tool |
| - | - | - | - | - | - | - |
| 1 | GET | `/monitor` | `listMonitors` | `listMonitors` | 2 query | `firecrawl_monitor_list` |
| 2 | POST | `/monitor` | `createMonitor` | `createMonitor` | 8 body fields at top level | `firecrawl_monitor_create` |
| 3 | GET | `/monitor/{monitorId}` | `getMonitor` | `getMonitor` | 1 path | `firecrawl_monitor_get` |
| 4 | PATCH | `/monitor/{monitorId}` | `updateMonitor` | `updateMonitor` | 1 path, 9 body fields at top level | `firecrawl_monitor_update` |
| 5 | DELETE | `/monitor/{monitorId}` | `deleteMonitor` | `deleteMonitor` | 1 path | `firecrawl_monitor_delete` |
| 6 | POST | `/monitor/{monitorId}/run` | `runMonitor` | `runMonitor` | 1 path | `firecrawl_monitor_run` |
| 7 | GET | `/monitor/{monitorId}/checks` | `listMonitorChecks` | `listMonitorChecks` | 1 path, 3 query | `firecrawl_monitor_checks` |
| 8 | GET | `/monitor/{monitorId}/checks/{checkId}` | `getMonitorCheck` | `getMonitorCheck` | 2 path, 3 query | `firecrawl_monitor_check` |
| 9 | POST | `/scrape` | `scrapeAndExtractFromUrl` | `scrapeAndExtractFromUrl` | one `body` object (schema is `allOf`) | `firecrawl_scrape` (url); with an `alexandria` body: `alexandria_library_read`, `alexandria_library_search`, `people_company_*`, `jobs_search`, `firecrawl_save_skill` |
| 10 | POST | `/scrape/{jobId}/interact` | `interactWithScrapeBrowserSession` | `interactWithScrapeBrowserSession` | 1 path, 4 body fields at top level | `firecrawl_interact` |
| 11 | DELETE | `/scrape/{jobId}/interact` | `stopInteractiveScrapeBrowserSession` | `delete_scrape_jobId_interact` | 1 path | `firecrawl_interact_stop` |
| 12 | POST | `/parse` | `parseFile` | `parseFile` | **none: body is `multipart/form-data`** | `firecrawl_parse` (hosted: upload-url handoff, then JSON `uploadRef`) |
| 13 | GET | `/parse/formats` | `getParseFormats` | `getParseFormats` | none | none |
| 14 | POST | `/batch/scrape` | `scrapeAndExtractFromUrls` | `scrapeAndExtractFromUrls` | one `body` object (schema is `allOf`) | none |
| 15 | GET | `/batch/scrape/{id}` | `getBatchScrapeStatus` | `getBatchScrapeStatus` | 1 path | none |
| 16 | DELETE | `/batch/scrape/{id}` | `cancelBatchScrape` | `cancelBatchScrape` | 1 path | none |
| 17 | GET | `/batch/scrape/{id}/errors` | `getBatchScrapeErrors` | `getBatchScrapeErrors` | 1 path | none |
| 18 | GET | `/crawl/{id}` | `getCrawlStatus` | `getCrawlStatus` | 1 path | `firecrawl_check_crawl_status` (also polled by `firecrawl_crawl`) |
| 19 | DELETE | `/crawl/{id}` | `cancelCrawl` | `cancelCrawl` | 1 path | none |
| 20 | GET | `/crawl/{id}/errors` | `getCrawlErrors` | `getCrawlErrors` | 1 path | none |
| 21 | POST | `/crawl` | `crawlUrls` | `crawlUrls` | 19 body fields at top level | `firecrawl_crawl` |
| 22 | POST | `/crawl/params-preview` | `crawlParamsPreview` | `crawlParamsPreview` | 2 body fields at top level | none |
| 23 | POST | `/map` | `mapUrls` | `mapUrls` | 11 body fields at top level | `firecrawl_map` |
| 24 | POST | `/extract` | `extractData` | `extractData` | 10 body fields at top level | none |
| 25 | GET | `/extract/{id}` | `getExtractStatus` | `getExtractStatus` | 1 path | none |
| 26 | GET | `/agent` | `listAgents` | `listAgents` | 1 query | none |
| 27 | POST | `/agent` | `startAgent` | `startAgent` | 16 body fields at top level | `firecrawl_agent` |
| 28 | GET | `/agent/{jobId}` | `getAgentStatus` | `getAgentStatus` | 1 path | `firecrawl_agent_status` |
| 29 | DELETE | `/agent/{jobId}` | `cancelAgent` | `cancelAgent` | 1 path | none |
| 30 | GET | `/agent/{jobId}/trace` | `getAgentTrace` | `getAgentTrace` | 1 path, 1 query | none |
| 31 | GET | `/agent/{jobId}/snapshots/{snapshotId}` | `getAgentSnapshot` | `getAgentSnapshot` | 2 path | none |
| 32 | GET | `/crawl/active` | `getActiveCrawls` | `getActiveCrawls` | none | none |
| 33 | GET | `/team/credit-usage` | `getCreditUsage` | `getCreditUsage` | none | `firecrawl_credit_usage` (current) |
| 34 | GET | `/team/credit-usage/historical` | `getHistoricalCreditUsage` | `getHistoricalCreditUsage` | 1 query | `firecrawl_credit_usage` (historical) |
| 35 | GET | `/team/token-usage` | `getTokenUsage` | `getTokenUsage` | none | none |
| 36 | GET | `/team/token-usage/historical` | `getHistoricalTokenUsage` | `getHistoricalTokenUsage` | 1 query | none |
| 37 | GET | `/team/queue-status` | `getQueueStatus` | `getQueueStatus` | none | none |
| 38 | GET | `/team/activity` | `getActivity` | `getActivity` | 3 query | none |
| 39 | POST | `/search` | `searchAndScrape` | `searchAndScrape` | 18 body fields at top level | `firecrawl_search` |
| 40 | GET | `/interact` | `listBrowserSessions` | `listBrowserSessions` | 1 query | none |
| 41 | POST | `/interact` | `createBrowserSession` | `createBrowserSession` | 6 body fields at top level | none |
| 42 | POST | `/interact/{sessionId}/execute` | `executeBrowserCode` | `executeBrowserCode` | 1 path, 3 body fields at top level | none |
| 43 | DELETE | `/interact/{sessionId}` | `deleteBrowserSession` | `deleteBrowserSession` | 1 path | none |
| 44 | GET | `/scrape/{jobId}` | `getScrapeStatus` | `getScrapeStatus` | 1 path | none |
| 45 | POST | `/search/{jobId}/feedback` | `submitSearchFeedback` | `submitSearchFeedback` | 1 path, 7 body fields at top level | `firecrawl_search_feedback` |
| 46 | POST | `/support/ask` | `askSupportAgent` | `askSupportAgent` | 2 body fields at top level | none |
| 47 | GET | `/search/research/papers` | `researchSearchPapers` | `researchSearchPapers` | 7 query | `firecrawl_research_search_papers` |
| 48 | GET | `/search/research/papers/{id}` | `researchGetPaper` | `researchGetPaper` | 1 path, 2 query | `firecrawl_research_inspect_paper` (no `query`), `firecrawl_research_read_paper` (with `query`) |
| 49 | GET | `/search/research/papers/{id}/similar` | `researchRelatedPapers` | `researchRelatedPapers` | 1 path, 5 query | `firecrawl_research_related_papers` |
| 50 | GET | `/search/research/proteins` | `researchLookupProtein` | `researchLookupProtein` | 2 query | `firecrawl_research_lookup_protein` |
| 51 | GET | `/search/developer` | `developerSearch` | `developerSearch` | 14 query | `firecrawl_developer_search` |
| 52 | POST | `/search/developer` | `developerSearchPost` | `developerSearchPost` | 14 body fields at top level | (same index; the MCP tool calls the GET form) |
| 53 | GET | `/search/gov` | `govSearch` | `govSearch` | 8 query | `firecrawl_gov_search` |
| 54 | POST | `/search/gov` | `govSearchPost` | `govSearchPost` | 8 body fields at top level | (same index; the MCP tool calls the GET form) |
| 55 | POST | `/feedback` | `submitEndpointFeedback` | `submitEndpointFeedback` | one `body` object (schema is `allOf`) | `firecrawl_feedback` |
| 56 | GET | `/team/threat-protection` | `getThreatProtection` | `getThreatProtection` | none | none |
| 57 | PUT | `/team/threat-protection` | `updateThreatProtection` | `updateThreatProtection` | 7 body fields at top level | none |

### 1.2 v1 operations (23)

| # | Method | Path | operationId | Same method and path in v2 spec |
| - | - | - | - | - |
| 1 | POST | `/scrape` | `scrapeAndExtractFromUrl` | yes |
| 2 | POST | `/batch/scrape` | `scrapeAndExtractFromUrls` | yes |
| 3 | GET | `/batch/scrape/{id}` | `getBatchScrapeStatus` | yes |
| 4 | DELETE | `/batch/scrape/{id}` | `cancelBatchScrape` | yes |
| 5 | GET | `/batch/scrape/{id}/errors` | `getBatchScrapeErrors` | yes |
| 6 | GET | `/crawl/{id}` | `getCrawlStatus` | yes |
| 7 | DELETE | `/crawl/{id}` | `cancelCrawl` | yes |
| 8 | GET | `/crawl/{id}/errors` | `getCrawlErrors` | yes |
| 9 | POST | `/crawl` | `crawlUrls` | yes |
| 10 | POST | `/map` | `mapUrls` | yes |
| 11 | POST | `/extract` | `extractData` | yes |
| 12 | GET | `/extract/{id}` | `getExtractStatus` | yes |
| 13 | GET | `/crawl/active` | `getActiveCrawls` | yes |
| 14 | POST | `/deep-research` | `startDeepResearch` | **no** |
| 15 | GET | `/deep-research/{id}` | `getDeepResearchStatus` | **no** |
| 16 | GET | `/team/credit-usage` | `getCreditUsage` | yes |
| 17 | GET | `/team/credit-usage/historical` | `getHistoricalCreditUsage` | yes |
| 18 | GET | `/team/token-usage` | `getTokenUsage` | yes |
| 19 | GET | `/team/token-usage/historical` | `getHistoricalTokenUsage` | yes |
| 20 | GET | `/team/queue-status` | `getQueueStatus` | yes |
| 21 | POST | `/search` | `searchAndScrape` | yes |
| 22 | POST | `/llmstxt` | `generateLLMsTxt` | **no** |
| 23 | GET | `/llmstxt/{id}` | `getLLMsTxtStatus` | **no** |

The four v1-only operations (`/deep-research`, `/llmstxt`) have no v2 path: `GET /v2/deep-research/x` and `GET /v2/llmstxt/x` return `404`, while the v1 routes still answer `401` without a key (live). The migration page says calls to `/v1/extract`, `/v1/deep-research` and `/v1/llmstxt` "are not part of this migration". Whether deep-research and llmstxt keep working after 2026-12-10 is **UNCONFIRMED**. `/v1/extract` is confirmed to return `410` from that date (https://docs.firecrawl.dev/migrating-from-extract).

### 1.3 v0 operations (5)

| # | Method | Path | operationId | Same method and path in v2 spec |
| - | - | - | - | - |
| 1 | POST | `/scrape` | `scrapeAndExtractFromUrl` | yes |
| 2 | POST | `/crawl` | `crawlUrls` | yes |
| 3 | POST | `/search` | `searchGoogle` | yes |
| 4 | GET | `/crawl/status/{jobId}` | `getCrawlStatus` | **no** |
| 5 | DELETE | `/crawl/cancel/{jobId}` | `cancelCrawlJob` | **no** |

### 1.4 Webhook events (13)

`crawlStarted`, `crawlPage`, `crawlCompleted`, `batchScrapeStarted`, `batchScrapePage`, `batchScrapeCompleted`, `agentStarted`, `agentAction`, `agentCompleted`, `agentFailed`, `agentCancelled`, `monitorPage`, `monitorCheckCompleted`. Requested with a `webhook` object on `POST /crawl`, `POST /batch/scrape`, `POST /agent` and `POST /monitor`. Docs: https://docs.firecrawl.dev/webhooks/overview

## 2. REST routes that are in no spec

"Live 401" means an unauthenticated `GET` returned `401` on 2026-11-27 while an invented sibling path returned `404`, so the route is registered.

| # | Route | Host | Evidence | What it does |
| - | - | - | - | - |
| 1 | `GET /v2/agent/threads/{threadId}?includeData=true` | api.firecrawl.dev | docs (https://docs.firecrawl.dev/features/agent), SDK `getAgentThread`, live 401 | Read an agent thread and its runs. `GET /v2/agent/threads` (no id) also answers 401; its meaning is UNCONFIRMED |
| 2 | `POST /v2/parse/upload-url` | api.firecrawl.dev | docs (https://docs.firecrawl.dev/authentication, keyless list), API source, MCP source | JSON `{filename, contentType?, declaredSizeBytes?}` returns `{uploadUrl, uploadRef, method, headers, fields, expiresAt, maxSizeBytes}`. Works without a key |
| 3 | `POST /v2/parse` with a JSON body | api.firecrawl.dev | API source (`routes/v2.ts`), MCP source | `{uploadRef, ...parse options}` instead of multipart. The spec documents only the multipart form |
| 4 | `PUT /v2/parse/upload/{uploadId}?uploadRef=` | self-hosted | API source | Receives the file bytes when upload storage is local. On cloud the signed `uploadUrl` is on a storage host |
| 5 | `GET /v2/concurrency-check` | api.firecrawl.dev | docs (key restrictions page), API source, SDK, live 401 | `{concurrency, maxConcurrency}` |
| 6 | `GET /v2/crawl/ongoing` | api.firecrawl.dev | API source, live 401 | Alias of `GET /v2/crawl/active` |
| 7 | WebSocket `wss://api.firecrawl.dev/v2/crawl/{id}` | api.firecrawl.dev | API source (`crawl-status-ws`), SDK `watcher`, docs ("polling, WebSocket, or webhook") | Streams `catchup`, `document`, `done`, `error` messages; the API key is sent as the WebSocket subprotocol. The SDK also builds `wss://…/v2/batch/scrape/{id}` (server route UNCONFIRMED) |
| 8 | `/v2/browser`, `/v2/browser/{id}/execute`, `DELETE /v2/browser/{id}` | api.firecrawl.dev | JS SDK 4.56.0 (`methods/browser.ts`), live 401 | Earlier name of the `/v2/interact` session routes; still served |
| 9 | `GET /v2/team/siem` | api.firecrawl.dev | live 401; the key restrictions page lists "SIEM" among account endpoints | Shape UNCONFIRMED. Enterprise feature |
| 10 | `POST /v2/slack/events` | api.firecrawl.dev | live (`GET` returns `405 Use POST`) | Slack integration callback, not a client endpoint |
| 11 | `POST /partner/v1/accounts`, `POST /partner/v1/api-keys/validate`, `POST /partner/v1/api-keys/rotate` | integrations.firecrawl.dev | docs (https://docs.firecrawl.dev/firecrawl-for-platforms) | Platform key (`Authorization: Bearer <platform key>`, a different credential from an `fc-` key). Create an account for an email and return its API key; validate a key; rotate a key. Only works for keys the integration created |
| 12 | OAuth: `/.well-known/oauth-authorization-server`, `/api/oauth/register`, `/api/oauth/authorize`, `/api/oauth/token`, `/api/oauth/revoke`; agent registration `POST /agent/auth` | www.firecrawl.dev | docs (https://docs.firecrawl.dev/oauth, https://docs.firecrawl.dev/ai-onboarding/agent-auth), live (discovery document served) | Issue `fco_` access tokens and `fcr_` refresh tokens; register an agent and receive a key |

Also outside the specs:

- **Request headers.** `x-request-id` on `POST /v2/scrape` makes an Alexandria call replay-safe (same id and body returns the saved result without a new charge; docs https://docs.firecrawl.dev/features/alexandria). `x-idempotency-key` on `POST /v2/crawl` (API source `idempotencyMiddleware`; SDKs also send it for batch scrape).
- **Removed.** `GET /v2/search/research/github` returns `410` with code `ENDPOINT_REMOVED` (live); removed 2026-11-03.
- **Not found.** `/v2/x402/search` and `/v1/x402/search` return `404` (live) and the docs do not mention x402.
- **Session side channels.** `POST /v2/interact` returns `cdpUrl` (a `wss://` Chrome DevTools endpoint), `liveViewUrl` and `interactiveLiveViewUrl` (pages on a live-view host). They are used by connecting to them directly, not through the API host.
- **Hosted MCP service routes.** `GET https://mcp.firecrawl.dev/health` (`ok`), `/ready`, and OAuth resource metadata under `/.well-known/oauth-protected-resource/v2/mcp-oauth` and `/v2/mcp-search` (live).
- **Self-hosted only.** `/admin/ops/*` operator routes in the open-source API; not part of the cloud surface.

## 3. Hosted MCP server

### 3.1 Surfaces

| Surface | URL | Credential | Tools listed | Evidence |
| - | - | - | - | - |
| Full, keyless | `https://mcp.firecrawl.dev/v2/mcp` | none | 3: `firecrawl_scrape`, `firecrawl_search`, `firecrawl_parse` | live `tools/list`, server version 3.42.0 |
| Full, API key | `https://mcp.firecrawl.dev/v2/mcp` | `Authorization: Bearer <fc- key>` (docs). The source also accepts `x-firecrawl-api-key` and `x-api-key` | 38 in the gateway dump. The open-source contract snapshot for this surface lists 34; the other 4 are hosted-only UI helpers (3.2) | gateway dump; `tests/contract-snapshots/hosted-full.json` |
| Account | `https://mcp.firecrawl.dev/v2/mcp-oauth` | OAuth `fco_` bearer (browser sign-in); the 401 text also names the API key header | 34 | `hosted-account.json`; live 401 |
| Search-only | `https://mcp.firecrawl.dev/v2/mcp-search` | OAuth only. An API key is rejected (live 401: "OAuth access token required") | 13 as of 3.42.0 (`docs/search-profile.md` still says twelve) | `hosted-search-primary.json`, `src/service/profiles.ts` |

- Transport is Streamable HTTP, stateless; responses arrive as `text/event-stream` frames. SSE-only clients do not work.
- Capabilities advertised (live): `tools`, `resources`, `logging`, `completions`. `prompts/list` is not implemented. `resources/list` returns two MCP App pages: `ui://firecrawl/usage.html` and `ui://firecrawl/agent-status.html`.
- Most tools take an `objective` string (required on the schemas seen) and many take `conversationId`. Both are sent to the vendor; keep `objective` generic.
- A native chat-assistant connector session seen during this research listed 19 tools, including `firecrawl_find_tools`, and none of crawl, map, parse, interact, monitor or credit usage. The tool list therefore depends on the client's surface, not only on the account.
- Callable but not listed on the full surface: `firecrawl_find_tools`, and `firecrawl_scrape` with an `alexandria` argument (both "still answer", https://docs.firecrawl.dev/mcp-server/tools). `firecrawl_extract` answers with a `DEPRECATED_TOOL` error.

### 3.2 The 38 tools and what each calls

Class: **W** = plain wrapper of one v2 operation. **W+** = wrapper that adds behaviour the REST call does not have. **A** = runs through `POST /v2/scrape` with an `alexandria` body naming a first-party `firecrawl/*` capability. **H** = hosted-only, absent from the open-source package 3.42.0.

| # | MCP tool | Class | REST call behind it | Notes |
| - | - | - | - | - |
| 1 | `firecrawl_scrape` | W | `POST /v2/scrape` | Hosted schema omits `actions`, `headers`, `minAge`, `blockAds`, `onlyCleanContent`, `checkPromptInjection`, `threatProtection`. A named `profile` loads state but never saves |
| 2 | `firecrawl_map` | W | `POST /v2/map` | Omits `ignoreCache`, `location`, `timeout` |
| 3 | `firecrawl_search` | W+ | `POST /v2/search` | Adds the UltraSearch `answer` field (one provider record, billed on top) on authenticated hosted sessions only. Adds `filter`. Omits `country`, `safe`, `timeout`, `ignoreInvalidURLs` |
| 4 | `alexandria_library_search` | A | `POST /v2/scrape` with `alexandria: {provider:"firecrawl", capability:"library", options:{command}}` | Read-only shell (`ls`, `cat`, `grep`, `jq`, pipes) over the catalogue. Free. Also appends related skills via `firecrawl/find-skills` |
| 5 | `alexandria_library_read` | A | `POST /v2/scrape` with `alexandria: [ …1 to 10 calls… ]` and an `x-request-id` header | Executes capabilities. Retains results over about 20,000 tokens and serves slices through `nextTool` |
| 6 | `firecrawl_save_skill` | A | `POST /v2/scrape`, capability `firecrawl/create-skill` or `firecrawl/update-skill` | Free. Cannot delete |
| 7 | `firecrawl_search_feedback` | W | `POST /v2/search/{jobId}/feedback` | |
| 8 | `firecrawl_feedback` | W+ | `POST /v2/feedback` | Accepts `endpoint: "alexandria"` with `requestedWebsite`, `providerFeedback`, `capabilityFeedback`, `callRatings`; the spec's `endpoint` enum stops at `search`, `scrape`, `parse`, `map` |
| 9 | `firecrawl_crawl` | W+ | `POST /v2/crawl`, then polls `GET /v2/crawl/{id}` | Blocks until the crawl ends. Omits `webhook`, `ignoreRobotsTxt`, `robotsUserAgent`, `regexOnFullURL`; adds `deduplicateSimilarURLs` |
| 10 | `firecrawl_check_crawl_status` | W | `GET /v2/crawl/{id}` | |
| 11 | `firecrawl_agent` | W | `POST /v2/agent` | Omits `model`, `webhook`, `location`, `safe` |
| 12 | `firecrawl_agent_status` | W | `GET /v2/agent/{jobId}` | |
| 13 | `firecrawl_interact` | W+ | `POST /v2/scrape/{jobId}/interact` (after `POST /v2/scrape` when given a `url`) | Takes `prompt` or `code`. The spec lists only `code` |
| 14 | `firecrawl_interact_stop` | W | `DELETE /v2/scrape/{jobId}/interact` | |
| 15 | `firecrawl_parse` | W+ | `POST /v2/parse/upload-url`, a client-side upload, then `POST /v2/parse` with JSON `uploadRef` | Two-call handoff: the first call returns a `curl` upload command to run where the file is |
| 16 | `firecrawl_monitor_create` | W+ | `POST /v2/monitor` | Simple form (`page`, `pages`, `queries`, `scheduleText`, `email`, `webhookUrl`) or the raw API `body` |
| 17 | `firecrawl_monitor_list` | W | `GET /v2/monitor` | |
| 18 | `firecrawl_monitor_get` | W | `GET /v2/monitor/{monitorId}` | |
| 19 | `firecrawl_monitor_update` | W | `PATCH /v2/monitor/{monitorId}` | |
| 20 | `firecrawl_monitor_delete` | W | `DELETE /v2/monitor/{monitorId}` | |
| 21 | `firecrawl_monitor_run` | W | `POST /v2/monitor/{monitorId}/run` | |
| 22 | `firecrawl_monitor_checks` | W | `GET /v2/monitor/{monitorId}/checks` | |
| 23 | `firecrawl_monitor_check` | W | `GET /v2/monitor/{monitorId}/checks/{checkId}` | |
| 24 | `firecrawl_research_search_papers` | W | `GET /v2/search/research/papers` | Same parameters |
| 25 | `firecrawl_research_inspect_paper` | W | `GET /v2/search/research/papers/{id}` without `query` | |
| 26 | `firecrawl_research_related_papers` | W | `GET /v2/search/research/papers/{id}/similar` | `seed_ids[0]` is the path id, the rest become repeated `anchor` |
| 27 | `firecrawl_research_read_paper` | W | `GET /v2/search/research/papers/{id}?query=` | |
| 28 | `firecrawl_research_lookup_protein` | W | `GET /v2/search/research/proteins` | |
| 29 | `firecrawl_developer_search` | W | `GET /v2/search/developer` | Lists only `query`, `k`, `skills`. REST has 11 more filters (`types`, `repos`, `sources`, `passages`, `language`, `topic`, `license`, `min_stars`, `max_stars`, `archived`, `fork`) |
| 30 | `firecrawl_gov_search` | W | `GET /v2/search/gov` with `sources=gov` | |
| 31 | `people_company_search` | A | `POST /v2/scrape`, capability `firecrawl/search/auto` | Provider waterfall. `max_credits` defaults to 1000 |
| 32 | `people_company_enrich` | A | `POST /v2/scrape`, capability `firecrawl/enrich/auto` | Provider waterfall, up to 10 records. **No cap unless `max_credits` is set** |
| 33 | `jobs_search` | A | `POST /v2/scrape`, capability `firecrawl/jobs/auto` | `max_credits` defaults to 200 |
| 34 | `firecrawl_credit_usage` | W+ | `GET /v2/team/credit-usage` and `GET /v2/team/credit-usage/historical` | Sends `byEndpoint=true` and `bin=day\|month`, which the spec does not list. The source falls back to monthly totals when the API does not echo `bin`, so live support is UNCONFIRMED |
| 35 | `firecrawl_usage_dashboard` | H | MCP-only | Opens the `ui://firecrawl/usage.html` MCP App. No arguments. Returns nothing useful to a client that cannot render MCP Apps |
| 36 | `firecrawl_recommended_providers` | H | MCP-only (no documented REST route) | Providers recommended from the team's last 30 days of activity, with reasons. No arguments. Returns data |
| 37 | `firecrawl_provider_directory` | H | MCP-only as a tool; same data as `firecrawl/find-tools` with `level: "providers"` (equivalence UNCONFIRMED) | Lists every provider, or one category. Returns data |
| 38 | `firecrawl_agent_activity` | H | MCP-only as a tool; likely `GET /v2/agent/{jobId}/trace` (UNCONFIRMED) | Steps, searches, pages read and credits so far for one agent job |

Count by class: W 21, W+ 7, A 6, H 4. All six class A tools reduce to one REST operation the gateway already has (`POST /scrape`), with an option shape that is documented only in the MCP tool schemas.

### 3.3 v2 operations with no hosted MCP tool (27)

- `GET /parse/formats`
- `POST /batch/scrape`
- `GET /batch/scrape/{id}`
- `DELETE /batch/scrape/{id}`
- `GET /batch/scrape/{id}/errors`
- `DELETE /crawl/{id}`
- `GET /crawl/{id}/errors`
- `POST /crawl/params-preview`
- `POST /extract`
- `GET /extract/{id}`
- `GET /agent`
- `DELETE /agent/{jobId}`
- `GET /agent/{jobId}/trace`
- `GET /agent/{jobId}/snapshots/{snapshotId}`
- `GET /crawl/active`
- `GET /team/token-usage`
- `GET /team/token-usage/historical`
- `GET /team/queue-status`
- `GET /team/activity`
- `GET /interact`
- `POST /interact`
- `POST /interact/{sessionId}/execute`
- `DELETE /interact/{sessionId}`
- `GET /scrape/{jobId}`
- `POST /support/ask`
- `GET /team/threat-protection`
- `PUT /team/threat-protection`

In short: batch scrape, crawl cancel/errors/preview/active, standalone browser sessions, scrape status, parse formats, agent list/cancel/trace/snapshot, account activity/queue/token/threat-protection, Ask, and extract are REST-only.

### 3.4 The `firecrawl-mcp` package: modes and switches

npm `firecrawl-mcp`: latest 3.42.0 (published 2026-11-27), Node 22 or newer, binary `firecrawl-mcp`. The docs still pin 3.40.0 and say `jobs_search`, `firecrawl_save_skill` and `firecrawl_research_lookup_protein` are hosted-only; the 3.42.0 contract snapshot for stdio with an API key lists all three, so that sentence is out of date.

Tools listed per mode (from `tests/contract-snapshots/`):

| Mode | Tools | Difference from hosted API-key surface |
| - | - | - |
| Hosted, API key | 34 (+4 hosted-only) | reference |
| Hosted, keyless or invalid credential | 3 | scrape, search, parse only |
| stdio with `FIRECRAWL_API_KEY` | 34 | `firecrawl_scrape` gains browser `actions`; `firecrawl_crawl` gains `webhook`, `webhookHeaders`; `firecrawl_parse` takes `filePath` and has no `uploadRef` (the docs say direct file reading needs `FIRECRAWL_API_URL` pointing at a self-hosted API) |
| stdio, no key and no API URL | 28 listed | Only scrape and search work; the rest answer "API key is required". No feedback, skill, enrich or jobs tools |
| stdio or HTTP with `FIRECRAWL_API_URL` (self-hosted) | 31 | No `people_company_*`, no `jobs_search` |

Environment variables that change the tool surface or connection (source: `src/index.ts`, `src/service/profiles.ts`, README):

| Variable | Effect |
| - | - |
| `FIRECRAWL_API_KEY`, `FIRECRAWL_OAUTH_TOKEN` | Credential (OAuth token wins) |
| `FIRECRAWL_API_URL` | Use a self-hosted API or Firecrawl Local |
| `HTTP_STREAMABLE_SERVER=true`, `SSE_LOCAL=true` | Serve Streamable HTTP on `http://localhost:3000/mcp` instead of stdio (`PORT`, `HOST`) |
| `FIRECRAWL_MCP_ALLOWED_HOSTS` | Extra `Host`/`Origin` values accepted in local HTTP mode; `*` disables the check |
| `CLOUD_SERVICE=true` | Hosted behaviour: credential required, scrape read-only (no `actions`, profiles never saved), parse by upload only |
| `FASTMCP_ENDPOINT` | `/v2/mcp` (full), `/v2/mcp-oauth` (account) or `/v2/mcp-search` (search-only; also needs `FIRECRAWL_MCP_SEARCH_OAUTH_ONLY=true`) |
| `FIRECRAWL_MCP_SEARCH_ENABLED=false`, `FIRECRAWL_MCP_SEARCH_PORT`, `FIRECRAWL_MCP_SEARCH_ENDPOINT`, `FIRECRAWL_MCP_SEARCH_RESOURCE_URL` | The companion search-only instance (default port 3001) |
| `FIRECRAWL_NO_SEARCH_FEEDBACK=1` (alias `FIRECRAWL_DISABLE_SEARCH_FEEDBACK`) | Do not register `firecrawl_search_feedback` |
| `FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` (alias `FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK`) | Do not register `firecrawl_feedback` |
| `FIRECRAWL_MCP_LIBRARY_SKILLS=false` | Library served without skills; `firecrawl_save_skill` not registered |
| `FIRECRAWL_INTEGRATION` | Tag sent as `integration` on API requests |
| `FIRECRAWL_OAUTH_ISSUER`, `FIRECRAWL_OAUTH_INTROSPECT_SECRET`, `FIRECRAWL_OAUTH_INTROSPECT_CACHE_TTL_MS`, `FIRECRAWL_MCP_RESOURCE_URL`, `MCP_OAUTH_ACCEPT_LEGACY_V2_MCP_AUD` | OAuth plumbing for people running their own hosted instance |

No environment variable enables an extra tool beyond the 34. The only tools outside the package are the four hosted-only ones.

## 4. Alexandria

Alexandria is a catalogue of first-party and third-party data providers reached with the ordinary API key. A provider has capabilities; a capability has a contract (inputs, outputs, price) and is executed by name.

### 4.1 Size

Read from the catalogue's own `README.md` on 2026-11-27 (free lookup): **3,561 capabilities from 623 providers in 35 categories**, with 2,839 recorded example responses and 247 indexed skills. A file count over the catalogue gave the same 623 provider folders and 3,561 capability files. Vendor marketing figures are lower ("200+" providers, "3,300+" tools at various dates, https://www.firecrawl.dev/changelog).

Per category (a provider that belongs to several categories is counted in each, so the columns do not sum to the totals):

| Category | Providers | Capabilities | | Category | Providers | Capabilities |
| - | - | - | - | - | - | - |
| government | 237 | 1,243 | | education | 20 | 78 |
| companies | 135 | 870 | | jobs | 20 | 104 |
| shopping | 95 | 449 | | marketing | 16 | 239 |
| finance | 52 | 457 | | sports | 16 | 98 |
| people | 42 | 338 | | ai-models | 15 | 106 |
| health | 40 | 165 | | social | 15 | 218 |
| real-estate | 40 | 178 | | restaurants | 13 | 88 |
| life-sciences | 38 | 184 | | game-development | 10 | 27 |
| travel | 36 | 181 | | apps | 7 | 54 |
| entertainment | 31 | 146 | | healthcare | 5 | 31 |
| places | 29 | 153 | | agriculture | 3 | 20 |
| news | 26 | 138 | | energy | 3 | 16 |
| software | 21 | 128 | | automotive, digital-intelligence, political-science, research | 2 each | 11, 11, 10, 12 |
| | | | | community, developer, knowledge, music, podcasts, other | 1 each | 3, 1, 7, 10, 105, 2 |

First-party providers in the catalogue: `firecrawl-gov-index` (`search`), `firecrawl-research-index` (`search`, `inspect`, `read`, `related`, `proteins/lookup`), `firecrawl-developer-index` (`search`), `firecrawl-maps`, `firecrawl-trends`, and `firecrawl` (`coupon-waterfall`, `report-missing-data`).

First-party `firecrawl/*` capabilities that are **not listed** in the catalogue but are called by the vendor's own clients (MCP and CLI source):

| Capability | Used by | Purpose | Price |
| - | - | - | - |
| `firecrawl/find-tools` | SDK `findTools`, CLI `find-tools`, MCP `firecrawl_find_tools` | Browse categories, providers and tools; read contracts; `includeCosts` adds prices | free |
| `firecrawl/library` | MCP `alexandria_library_search` | One shell command over the catalogue filesystem | free |
| `firecrawl/find-skills` | CLI `find-skills`, MCP (related skills) | Keyword search over skills | free |
| `firecrawl/create-skill`, `firecrawl/update-skill` | CLI, MCP `firecrawl_save_skill` | Write a team skill | free |
| `firecrawl/search/auto` | MCP `people_company_search` | People or company search waterfall | per provider used |
| `firecrawl/enrich/auto` | MCP `people_company_enrich` | Enrichment waterfall | per provider that finds a field |
| `firecrawl/jobs/auto` | MCP `jobs_search` | Job postings | per provider read |
| `firecrawl/sql` | CLI `firecrawl sql` (hidden, "Experimental Alexandria syntax") | Preview by default; `--execute` runs paid calls | UNCONFIRMED |

### 4.2 Discovery and execution over REST

| Step | REST call | Cost |
| - | - | - |
| Find tools by meaning | `POST /v2/search` with `sources: ["alexandria"]` (tools only) or `["web","alexandria"]`; results in `data.tools`; `toolDetail`: `compact`, `summary`, `full` | Free for `["alexandria"]` alone; web results billed as search |
| Find tools for a website | `domainTools: true` on `POST /v2/search` or on a URL `POST /v2/scrape` | Matching is free; the search or scrape is billed |
| Browse the catalogue, read a contract and price | `POST /v2/scrape` with `alexandria: {provider:"firecrawl", capability:"find-tools", options:{query, urls, providers, categories, groups, capabilities, level, expand, limit, offset}}`. The CLI (`--include-costs`) and the MCP tool also send `includeCosts`, which the spec's `FindToolsOptions` does not list | Free |
| Execute | `POST /v2/scrape` with `alexandria: {provider, capability, options}` or an array of 1 to 10; **no `url`** and no other scrape option except `timeout`; results in `data.alexandria[]`, each with `data` or `error`; total in `data.creditsCost` | Each capability's listed price |
| Retry safely | Same body plus the same `x-request-id` header replays the saved result | No new charge |
| Feedback | `POST /v2/feedback` with `endpoint: "alexandria"`, within 20 minutes of the last Alexandria call | Free; refunds 1 credit, capped at 10 per website and 100 per team per UTC day |

Errors worth handling: `403 THIRD_PARTY_DATA_TERMS_REQUIRED` with `requiresAction.url` (an org admin must accept provider terms in the dashboard; an agent must not), `404 unknown_provider`, `409 duplicate_request` or `request_in_flight`, `503 request_unresolved`, `402 insufficient_credits`. One call in a batch can fail while the HTTP response is `200`.

Sources: https://docs.firecrawl.dev/features/alexandria, https://docs.firecrawl.dev/features/search, the v2 spec (`AlexandriaCall`, `FindToolsOptions`), `apps/js-sdk/firecrawl/src/v2/methods/tools.ts`.

### 4.3 Pricing shape

Each capability carries (observed with `includeCosts`, free lookup):

- `creditsCost`: the calling team's own price. Descriptions quote a list price that can be higher.
- `perRecord`: `true` means per returned record, `false` means per call. `recordsPerUnit` groups records (Developer Index: 2 credits per 10 records).
- `billing` (some providers): `unitLabel`, `maxCredits` and a rule, for example a price that scales with the vendor's charge at 10 credits per 0.01 USD of vendor cost with a ceiling of 100 credits per call.
- `zeroDataRetentionCreditsCost` where a zero-data-retention price differs.
- Charging rules written in each description: many charge only on a hit ("a miss costs nothing"), some charge per page including an empty page.

Observed range: 0 credits (Government Index, Research Index, most public-statistics lookups) up to the 100-credit ceiling per call. Documented fixed points: a profile-page URL scrape routed to an enrichment provider costs 5, 10, 30 or 40 credits depending on the provider (https://docs.firecrawl.dev/billing).

### 4.4 Can the gateway's `firecrawl` REST tools already reach all of it?

**Yes for transport, with four defects.** Everything in 4.1 and 4.2 is one of three operations the gateway already exposes: `firecrawl__searchAndScrape` (discovery), `firecrawl__scrapeAndExtractFromUrl` (find-tools, library, execution, the three waterfalls, skills) and `firecrawl__submitEndpointFeedback` (feedback). The MCP server itself does nothing else: it posts these bodies to `/v2/scrape` with an ordinary key. This is confirmed in source, not exercised live (no key was used).

Defects when going through the gateway as built:

1. The spec marks `url` as required on `POST /scrape`, while an Alexandria call must not send `url`. The gateway does not validate arguments, so a call that omits `url` goes through, but an agent that follows the schema will add one and get `400`.
2. `x-request-id` cannot be sent (the gateway forwards path, query and body parameters only), so a retried Alexandria call is charged again.
3. The ledger reads cost from `creditsUsed`; Alexandria answers with `data.creditsCost`, so these calls are logged with no cost.
4. The option shapes of `firecrawl/library`, `search/auto`, `enrich/auto`, `jobs/auto`, `create-skill` and `update-skill` are not in the spec; only `find-tools` is. An agent has to learn them from the MCP tool schemas.

Only on the hosted MCP server, not on REST: the UltraSearch `answer` field, `firecrawl_recommended_providers`, and the slicing of oversized results.

## 5. Reachable only through SDKs, the CLI, Firecrawl Local or skills

| Surface | Version seen | What it adds beyond the REST operations |
| - | - | - |
| SDKs: Python, Node, Go, Java, Ruby, Rust, .NET, PHP, Elixir | npm `firecrawl` 4.54.0 (repository at 4.56.0), PyPI `firecrawl` 4.57.0 | Nothing server-side. Client conveniences: wait-and-poll (`crawl`, `batchScrape`, `agent`), automatic pagination over `next`, `watcher` over WebSocket, multipart upload for `parse`, `findTools`, automatic `x-request-id`, `getAgentThread`, `concurrencyCheck`, a `v1` compatibility client |
| CLI `firecrawl-cli` | 1.30.0 (docs show an older number) | Commands: `scrape` (default), `crawl`, `batch-scrape`, `map`, `parse`, `monitor`, `search`, `find-tools`, `find-skills`, `read-skill`, `create-skill`, `update-skill`, `list`, `alexandria` (`list`, `terms show`, `feedback`), `developer`, `gov`, `research` (`search-papers`, `inspect-paper`, `related-papers`, `read-paper`, `lookup-protein`), `feedback`, `search-feedback`, `agent` (with `thread`), `interact` (with `stop`), `experimental`/`x` (`download`), and hidden `browser`, `create`, `sql`. Setup: `login`, `logout`, `config`, `view-config`, `init`, `setup`, `make`, `launch`, `env`, `status`, `credit-usage`, `doctor`, `update`, `version` |
| CLI-only behaviour | | `firecrawl x download` (map a site then scrape every page into local files), `firecrawl env` (write the key into a local `.env`), `firecrawl launch` (configure the MCP server for an agent and start it), `firecrawl init`/`setup` (install skills), `firecrawl sql`, browser login. None is a new server capability |
| Firecrawl Local | crate `firecrawl-local` 0.1.1 (2026-11-19) | One binary that serves `POST /v2/scrape`, `/v2/map`, `/v2/crawl` (+status, cancel), `/v2/batch/scrape` (+status, cancel) and `GET /health` on `http://localhost:3002` with no key and no credits. Other `/v2` routes are forwarded to the cloud unless `FIRECRAWL_CLOUD=off`. Formats limited to `markdown`, `html`, `rawHtml`, `links`. `firecrawl-local mcp` runs the MCP server against it. https://docs.firecrawl.dev/quickstarts/firecrawl-local |
| Agent skills | `firecrawl/cli` (13 skills), `firecrawl/skills` (37), `firecrawl/firecrawl-workflows` (19) | Instruction files for coding agents that drive the CLI. No new endpoints |
| Alexandria library skills | 247 indexed | Step-by-step workflows stored in the catalogue under `/library/skills`; read with `firecrawl/library`, written with `firecrawl/create-skill` |
| Dashboard only | | API key creation, revocation and per-key spend limits; provider terms acceptance; enrichment provider order; partner integration setup. No REST route |

## 6. Comparison with the gateway

Gateway facts used here (from `src/gateway/openapi.ts` and `src/gateway/config.ts`, read 2026-11-27):

- One tool per operation. Only `path` and `query` parameters and an `application/json` body are forwarded. Header parameters are ignored.
- A body whose schema is a plain object is flattened to top-level arguments, and any extra argument is passed through into the JSON body. A body built with `allOf` is taken as one `body` argument.
- Undeclared query parameters are dropped.
- An upstream may list several spec documents. A later document's operation with the same method, path and server is dropped. A `servers` URL on an operation or path overrides the upstream base URL; a document-level `servers` is not read.
- One auth header and one key pool per upstream. Fixed extra headers are allowed. `include` and `exclude` take tool-name patterns.

### 6.1 Not exposed, and how to add it

| # | Missing | How to add | Kind of change |
| - | - | - | - |
| 1 | Routes 1, 2, 3 and 5 of section 2 (`/agent/threads/{threadId}`, `/parse/upload-url`, JSON `/parse`, `/concurrency-check`) | Write a small local OpenAPI file and list it **first** in `spec` for the `firecrawl` upstream, before `https://docs.firecrawl.dev/api-reference/v2-openapi.json`. Same base URL `https://api.firecrawl.dev/v2`, same `Authorization: Bearer` key. Listing it first lets its JSON `POST /parse` replace the multipart one | config only (plus the file) |
| 2 | A schema-valid Alexandria executor | In the same local file add `POST /scrape` again as operation `alexandriaExecute` with body `{alexandria (required), timeout}` and an operation-level `servers: [{url: "https://api.firecrawl.dev/v2"}]`. The server override makes it a distinct operation for the gateway, so both tools exist | config only (plus the file) |
| 3 | MCP-only and MCP-better tools | Keep the `firecrawlmcp` upstream but set `include` to the list in 6.4 | config only |
| 4 | `x-request-id` and `x-idempotency-key` | The gateway has no way to send a per-call header. Needs code: forward `in: header` parameters as arguments (then declare them in the local file) | code |
| 5 | Cost of Alexandria calls in the ledger | Needs code: read `creditsCost` as well as `creditsUsed` (also covers `metadata.provider.creditsCost` on provider-routed scrapes) | code |
| 6 | v1-only deep research and llms.txt generation | Separate upstream (for example `firecrawlv1`): `kind = "openapi"`, `url = "https://api.firecrawl.dev/v1"`, `spec = "https://docs.firecrawl.dev/api-reference/v1-openapi.json"`, auth `Authorization: Bearer`, `include = ["startDeepResearch", "getDeepResearchStatus", "generateLLMsTxt", "getLLMsTxtStatus"]`. It cannot be a second document of the `firecrawl` upstream because the v1 file sets its base URL only at document level. Not recommended: the rest of v1 returns `410` from 2026-12-10 and the fate of these four is UNCONFIRMED | config only |
| 7 | Partner API (3 operations) | Separate upstream (for example `firecrawlpartner`): `kind = "openapi"`, `url = "https://integrations.firecrawl.dev"`, `spec` = a local file with the three `POST` operations of section 2 row 11, auth `Authorization: Bearer` with a **platform key** in its own key list. Not recommended for agents: responses contain newly minted API keys, which would be written to the gateway's payload files | config only (plus the file) |
| 8 | WebSocket crawl stream, browser `cdpUrl`, live-view URLs, webhooks | Not addable: not request/response HTTP on the API host. Poll `getCrawlStatus` and `getAgentTrace` instead | none |
| 9 | Search-only MCP surface `/v2/mcp-search` | Not addable with a key (OAuth only). Nothing unique on it | none |

Sketch of the local file for rows 1 and 2. Field names come from the API and MCP source and were not exercised against the live API. The tool-building part was checked: running the gateway's own `operationsFromSpec` over this sketch followed by the published v2 spec gives 61 tools (the 57, with `parseFile`, `interactWithScrapeBrowserSession` and `getHistoricalCreditUsage` replaced by the local versions, plus `createParseUploadUrl`, `getAgentThread`, `getConcurrency` and `alexandriaExecute`).

```yaml
openapi: 3.0.0
info: { title: Firecrawl additions, version: local }
paths:
  /parse/upload-url:
    post:
      operationId: createParseUploadUrl
      summary: Get a signed upload URL and uploadRef for a local file (then PUT the bytes to uploadUrl, then call parseUploadedFile)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [filename]
              properties:
                filename: { type: string }
                contentType: { type: string }
                declaredSizeBytes: { type: integer }
  /parse:
    post:
      operationId: parseUploadedFile
      summary: Parse a file already uploaded through createParseUploadUrl
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [uploadRef]
              properties:
                uploadRef: { type: string }
                formats: { type: array, items: {} }
                parsers: { type: array, items: {} }
                onlyMainContent: { type: boolean }
                redactPII: {}
                zeroDataRetention: { type: boolean }
                timeout: { type: integer }
  /agent/threads/{threadId}:
    get:
      operationId: getAgentThread
      parameters:
        - { name: threadId, in: path, required: true, schema: { type: string } }
        - { name: includeData, in: query, schema: { type: boolean } }
  /concurrency-check:
    get: { operationId: getConcurrency }
  /scrape/{jobId}/interact:
    post:
      operationId: interactWithScrapeBrowserSession
      summary: Run a prompt (7 credits per browser minute) or code (2 credits) in the browser session of a scrape
      parameters:
        - { name: jobId, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                prompt: { type: string }
                code: { type: string }
                language: { type: string, enum: [node, python, bash] }
                timeout: { type: integer }
                zeroDataRetention: { type: boolean }
  /team/credit-usage/historical:
    get:
      operationId: getHistoricalCreditUsage
      parameters:
        - { name: byApiKey, in: query, schema: { type: boolean } }
        - { name: byEndpoint, in: query, schema: { type: boolean } }
        - { name: bin, in: query, schema: { type: string, enum: [month, day] } }
  /scrape:
    post:
      operationId: alexandriaExecute
      summary: Run 1 to 10 Alexandria capabilities; billed at each capability's listed price; discovery capabilities are free
      servers: [{ url: "https://api.firecrawl.dev/v2" }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [alexandria]
              properties:
                alexandria: { description: "One {provider, capability, options} object, or an array of 1 to 10 of them. Do not send url." }
                timeout: { type: integer, description: Milliseconds, at most 120000 }
```

### 6.2 Exposed but will not work as built

| # | Gateway tool | Problem | Evidence | Fix |
| - | - | - | - | - |
| 1 | `firecrawl__parseFile` | `POST /parse` takes `multipart/form-data`. The tool has no arguments and the gateway sends no body, so the API answers `400` ("Missing file upload…") | spec; API source `parsePayloadMiddleware` | Add it to `exclude`. Use `firecrawlmcp__firecrawl_parse`, or the JSON pair in 6.1 row 1 |
| 2 | `firecrawl__extractData`, `firecrawl__getExtractStatus` | `/extract` returns `410 Gone` from Thursday 2026-12-10 15:00 UTC. The spec does not flag it | https://docs.firecrawl.dev/migrating-from-extract | `exclude` now. Replacement: scrape with a `json` format, batch scrape, or `startAgent` |
| 3 | `firecrawl__getTokenUsage`, `firecrawl__getHistoricalTokenUsage` | "Extract only" counters; meaningless once extract is gone | spec summaries | `exclude` |
| 4 | `firecrawl__interactWithScrapeBrowserSession` | Schema requires `code` and has no `prompt`. The prompt mode in the docs cannot be expressed by a schema-following agent | spec vs https://docs.firecrawl.dev/features/interact | Replace through the local file (6.1), or use `firecrawlmcp__firecrawl_interact` |
| 5 | `firecrawl__scrapeAndExtractFromUrl` in Alexandria mode | Schema requires `body.url`; Alexandria calls must omit it. No replay header. Cost not logged | spec `allOf[0].required`; section 4.4 | 6.1 rows 2, 4, 5, or use the MCP library tools |
| 6 | `firecrawl__developerSearch` and `firecrawl__developerSearchPost`; `firecrawl__govSearch` and `firecrawl__govSearchPost` | Two tools for the same search each. Both forms work (the `GET` form accepts repeated array parameters, which is what the gateway sends) | spec | `exclude` one of each pair. Keeping the `GET` forms keeps the read-only hint the gateway sets on `GET` tools |
| 7 | `firecrawl__getHistoricalCreditUsage` | Only `byApiKey`; `byEndpoint` and `bin` are dropped as undeclared query parameters | MCP source `src/usage.ts` | Replace through the local file, or use `firecrawlmcp__firecrawl_credit_usage` |
| 8 | `firecrawl__createBrowserSession`, `firecrawl__executeBrowserCode`, `firecrawl__listBrowserSessions`, `firecrawl__deleteBrowserSession` | These work, but the returned `cdpUrl` and live-view URLs are unusable through the gateway, and a session bills per browser minute until deleted or its `ttl` ends | docs https://docs.firecrawl.dev/features/browser | Keep; make sure agents call `deleteBrowserSession` |
| 9 | `firecrawl__updateThreatProtection` | Full-document `PUT` that resets unspecified fields; enterprise and team-admin only | spec description | `exclude` |
| 10 | `firecrawl__startAgent` | Works, but `maxCredits` defaults to 2,500 when omitted | https://docs.firecrawl.dev/features/agent | Keep; tell agents to set `maxCredits` |
| 11 | Any job started and polled across a key change (`crawlUrls`, `scrapeAndExtractFromUrls`, `startAgent`, `createMonitor`) | A job belongs to the team of the key that started it; after the gateway moves to another team's key the status call fails | gateway doc, "Limits" | Known limit. Keys of the same team share credits, so rotation within a team gains nothing |
| 12 | `webhook` arguments on crawl, batch scrape, agent, monitor | Accepted, but the gateway cannot receive the callbacks | webhooks spec | None needed |
| 13 | The same function offered twice, once per upstream | 30 v2 operations also exist as `firecrawlmcp__*` tools | section 3.3 | 6.4 include list |
| 14 | `firecrawlmcp__firecrawl_usage_dashboard` | Returns an MCP App page; nothing for a text client | live `resources/list` | Leave out of `include` |

Not a problem: no v2 operation streams, lives on another host, or returns a non-JSON body. The agent endpoints have no event stream ("There's no server-sent event stream and no websocket", https://docs.firecrawl.dev/features/agent).

### 6.3 Parameters missing compared with the docs and source

"Reachable anyway" means the gateway passes unknown arguments into a flattened JSON body, so the field can be sent although the agent is never told it exists.

| Operation | Missing from the spec (so from the gateway tool) | Where it is documented | Reachable anyway |
| - | - | - | - |
| `POST /scrape/{jobId}/interact` | `prompt`, `zeroDataRetention`; `code` wrongly required | docs (interact) | yes, but the schema misleads |
| `GET /team/credit-usage/historical` | `byEndpoint`, `bin` | MCP source and README | **no** (query) |
| `GET /agent/threads/{threadId}` | whole route, `includeData` | docs (agent) | **no** |
| `POST /parse` | JSON form with `uploadRef`; `POST /parse/upload-url` | API source, MCP source | **no** |
| `POST /scrape` | header `x-request-id`; body `origin`, `integration`; deprecated format `{type:"query", prompt, mode}`; undocumented `fastMode` | docs (Alexandria), API source | header no; body fields yes (inside `body`) |
| `POST /search` | `filter`, `lang`, `asyncScraping`, `origin`, `integration` | API source; `filter` is on the MCP tool | yes |
| `POST /crawl` | `deduplicateSimilarURLs`; header `x-idempotency-key` | API source; MCP tool | body yes, header no |
| `POST /batch/scrape` | `appendToId`; header `x-idempotency-key` | API source, SDK | body yes (inside `body`), header no |
| `POST /feedback` | `endpoint: "alexandria"` with `requestedWebsite`, `objective`, `rationale`, `providerFeedback`, `capabilityFeedback`, `callRatings` | docs (Alexandria), SDK, MCP tool | yes (inside `body`) |
| `POST /support/ask` | `context` | docs (https://docs.firecrawl.dev/features/ask) | yes |
| `GET /search/research/papers/{id}/similar` | `anchor` is repeatable but typed as one string | spec description | yes if the agent passes a list |
| `POST /scrape` with `alexandria` | option shapes of `firecrawl/library`, `search/auto`, `enrich/auto`, `jobs/auto`, `create-skill`, `update-skill`; `includeCosts` on `firecrawl/find-tools` | MCP tool schemas, CLI docs | yes, undocumented |

In the other direction, the REST tools carry parameters the hosted MCP tools lack: scrape `actions`, `headers`, `minAge`, `blockAds`, `onlyCleanContent`, `checkPromptInjection`; search `country`, `safe`, `timeout`; map `ignoreCache`, `location`; crawl `webhook`, `ignoreRobotsTxt`, `regexOnFullURL`; agent `model`, `webhook`, `location`, `safe`; developer search's 11 filters.

### 6.4 Recommended configuration

```toml
[gateway.upstreams.firecrawl]
keys = ["doppler:FIRECRAWL_API_KEY"]
# Local additions first so its JSON /parse, interact and usage operations win.
# Use an absolute path: the gateway does not expand "~" in spec locations.
spec = ["/absolute/path/to/firecrawl-additions.yaml", "https://docs.firecrawl.dev/api-reference/v2-openapi.json"]
exclude = [
  "parseFile",                      # multipart; only if the local file is absent
  "extractData", "getExtractStatus",            # 410 from 2026-12-10
  "getTokenUsage", "getHistoricalTokenUsage",   # extract-only counters
  "developerSearchPost", "govSearchPost",       # duplicates of the GET forms
  "updateThreatProtection",                     # destructive full-document PUT
]

[gateway.upstreams.firecrawlmcp]
keys = ["doppler:FIRECRAWL_API_KEY"]
include = [
  "alexandria_library_search", "alexandria_library_read",
  "people_company_search", "people_company_enrich", "jobs_search",
  "firecrawl_save_skill",
  "firecrawl_parse",
  "firecrawl_interact", "firecrawl_interact_stop",
  "firecrawl_credit_usage",
  "firecrawl_feedback",
  "firecrawl_recommended_providers", "firecrawl_provider_directory",
]
```

Optional additions to that `include`: `firecrawl_search` (only for the UltraSearch `answer`, which can add up to 20 credits to a search without being asked), `firecrawl_crawl` (a crawl that blocks until done), `firecrawl_agent_activity`. Everything else on the MCP side is a narrower copy of a REST tool. With the local file in place, `firecrawl_parse`, `firecrawl_interact*` and `firecrawl_credit_usage` become optional too.

## 7. Tool families: purpose and credit cost

Costs from https://docs.firecrawl.dev/billing and the feature pages unless noted. Free plan: 1,000 credits per month per team.

| Family | Gateway tools | For | Credits |
| - | - | - | - |
| Scrape | `scrapeAndExtractFromUrl`, `getScrapeStatus` | One URL to markdown, HTML, links, screenshot, JSON or an answer | 1 per page. +4 each for `json`, `question`/`query`, `highlights`, `audio`, `video`, `redactPII`, `checkPromptInjection`, `lockdown` cache hit. +1 per PDF page. +1 zero data retention. X/Twitter URLs 30. Profile URLs routed to an enrichment provider 5 to 40 |
| Batch scrape | `scrapeAndExtractFromUrls`, `getBatchScrapeStatus`, `cancelBatchScrape`, `getBatchScrapeErrors` | Many known URLs as one async job | Same per page as scrape |
| Crawl | `crawlUrls`, `getCrawlStatus`, `cancelCrawl`, `getCrawlErrors`, `getActiveCrawls`, `crawlParamsPreview` | Follow links from a start URL | 1 per page plus scrape surcharges. Preview cost not stated: UNCONFIRMED |
| Map | `mapUrls` | List a site's URLs without content | 1 per call |
| Search | `searchAndScrape`, `submitSearchFeedback` | Web, news and image search, optional scrape of results, Alexandria tool discovery | 2 per 10 results, rounded up, plus scrape costs for scraped results. Alexandria-only discovery free. First feedback on a search can refund 1 |
| Developer Index | `developerSearch` (and POST twin) | Issues, merged pull requests, READMEs, docs | 2 per 10 results. Works keyless |
| Government Index | `govSearch` (and POST twin) | US statutes, regulations, codes, court opinions | Free. 300 calls per minute; daily cap 1,000 (2,000 on Growth, none on Scale and Enterprise) |
| Research Index | `researchSearchPapers`, `researchGetPaper`, `researchRelatedPapers`, `researchLookupProtein` | Papers (PubMed, bioRxiv, medRxiv, arXiv), passages, citations, UniProt proteins | Free. 100 calls per minute; same daily caps |
| Parse | `parseFile`, `getParseFormats` | Uploaded PDF, Office, HTML files to markdown or JSON | PDF 1 per page (1 flat with `parsers: []`). Price of non-PDF documents is not stated on the parse page: UNCONFIRMED. 50 MB limit |
| Interact (scrape-bound) | `interactWithScrapeBrowserSession`, `delete_scrape_jobId_interact` | Click, type, run code on a page already scraped | 2 per browser minute with code, 7 with a prompt, +2 under zero data retention; one-minute minimum |
| Browser sessions | `createBrowserSession`, `executeBrowserCode`, `listBrowserSessions`, `deleteBrowserSession` | Standalone sandbox browser driven by code | Same per-minute rates |
| Monitor | `createMonitor`, `listMonitors`, `getMonitor`, `updateMonitor`, `deleteMonitor`, `runMonitor`, `listMonitorChecks`, `getMonitorCheck` | Scheduled change detection on pages, sites or searches | Per check: 1 per URL (scrape), 1 per page (crawl), 2 per 10 results (web). +1 per changed page judged |
| Agent | `startAgent`, `getAgentStatus`, `listAgents`, `cancelAgent`, `getAgentTrace`, `getAgentSnapshot` | Autonomous multi-source research returning structured data | Dynamic, usually a few hundred. 5 free runs per day. `maxCredits` default 2,500. Failed or capped runs are not billed |
| Extract (deprecated) | `extractData`, `getExtractStatus` | LLM extraction over URLs | Token-based, 1 credit per 15 tokens. Gone 2026-12-10 |
| Alexandria | `scrapeAndExtractFromUrl` with `alexandria`; MCP `alexandria_library_*` | Typed records from 623 providers | Discovery free. Execution at each capability's price, 0 to 100 per call or per record |
| People, companies, jobs | MCP `people_company_search`, `people_company_enrich`, `jobs_search` | B2B search, enrichment, contact details, job postings | Per provider used. Caps: search 1,000 default, enrich none unless set, jobs 200 default |
| Skills | MCP `firecrawl_save_skill` | Store team workflows in the library | Free |
| Account and usage | `getCreditUsage`, `getHistoricalCreditUsage`, `getQueueStatus`, `getActivity`, token usage pair | Remaining credits, monthly history (per key), queue, last 24 hours of jobs | Not stated; job status polling is documented as free: UNCONFIRMED for these |
| Threat protection | `getThreatProtection`, `updateThreatProtection` | Team URL-risk policy (enterprise) | Policy calls not stated. A scan costs 2 per URL |
| Feedback | `submitEndpointFeedback` | Rate a search, scrape, parse, map or Alexandria session | Free. Alexandria feedback refunds 1, capped at 10 per website and 100 per team per day |
| Ask | `askSupportAgent` | AI support agent that diagnoses a failed job | Not stated: UNCONFIRMED. Typically 15 to 30 seconds, 60 at most |
| Partner API | none | Create and rotate keys for a platform's users | No credit cost stated |

## 8. Corrections to the earlier note (`firecrawl.md`, same date)

| Earlier note | Finding |
| - | - |
| Only `/extract` is listed as going away on 2026-12-10 | The **whole v1 API** (scrape, crawl, batch scrape, search, map, account) also returns `410` from that moment |
| Two hosted MCP URLs | Three: `/v2/mcp`, `/v2/mcp-oauth`, `/v2/mcp-search` |
| Tool list taken from the docs page | The API-key surface lists 38 tools; four (`firecrawl_usage_dashboard`, `firecrawl_recommended_providers`, `firecrawl_provider_directory`, `firecrawl_agent_activity`) are on no docs page and in no public source |
| "REST equivalent for daily or per-endpoint splits is UNCONFIRMED" | The MCP server sends `byEndpoint` and `bin` to `/v2/team/credit-usage/historical`, with a fallback for when the API ignores them. Still UNCONFIRMED live |
| People, company and jobs tools "equivalent over REST is an Alexandria capability call" | Confirmed and named: `firecrawl/search/auto`, `firecrawl/enrich/auto`, `firecrawl/jobs/auto` |
| `jobs_search`, `firecrawl_save_skill`, `firecrawl_research_lookup_protein` hosted-only | True of 3.40.0; the 3.42.0 package lists them over stdio with a key |
| CLI version from the docs | npm latest is 1.30.0 |
| Licence UNCONFIRMED | GitHub reports AGPL-3.0 for `firecrawl/firecrawl` |
| Alexandria size from vendor claims | 623 providers and 3,561 capabilities in the catalogue itself |
| Parse: "other documents 1 credit flat" | The parse page's "1 credit flat" is the price of `parsers: []` (no parsing, PDF returned as base64). The price of non-PDF documents is not stated there |

## 9. Still UNCONFIRMED

- Live behaviour of every authenticated call described from source: `firecrawl/library`, `search/auto`, `enrich/auto`, `jobs/auto`, `create-skill`, JSON `/parse` with `uploadRef`, `byEndpoint` and `bin`, `GET /v2/agent/threads`.
- REST routes behind the four hosted-only MCP tools.
- Whether `/v1/deep-research` and `/v1/llmstxt` survive 2026-12-10.
- Credit cost of `/support/ask`, `/crawl/params-preview` and the account endpoints.
- Shape of `GET /v2/team/siem`.
- Whether the locale copies of the spec files are identical to the English ones.
- Whether a real MCP client refuses an Alexandria call through `firecrawl__scrapeAndExtractFromUrl` because the schema marks `url` required. The gateway itself does not validate.
- Keyless caps per IP (not published).

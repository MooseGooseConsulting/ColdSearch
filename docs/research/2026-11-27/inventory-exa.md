# Exa — complete programmatic surface and gateway gaps (2026-11-27)

- Researched 2026-11-27 from Exa's published OpenAPI documents, docs pages, public GitHub source and the hosted MCP servers' own tool listings. No API key was used and no paid operation was called.
- Operation counts come from a script that parsed each downloaded document and enumerated every method and path. They are not taken from prose.
- This replaces the product-surface part of `exa.md` in this folder where the two differ; section 8 lists the differences.

How each fact was checked, used in the "Checked by" columns below:

| Label | Meaning |
| - | - |
| spec | Parsed from the downloaded OpenAPI document on 2026-11-27 |
| docs | Stated on an Exa docs page (all 171 pages in `llms.txt` were downloaded and searched for hosts and paths) |
| source | Read in Exa's public GitHub source at the version named |
| live list | Returned by the server to an unauthenticated `initialize` + `tools/list` (no tool was called) |
| probe | Unauthenticated `GET` to a free read-only path, to see 401 (route exists) or 404 (it does not) |

## 1. Totals

| Surface | Count | Exposed by the gateway today |
| - | - | - |
| Operations in the main API document | 64 | 64 (upstream `exa`) |
| Operations in the Team Management document | 9 | 0 |
| Documented REST operations in no document | 6 (4 OpenAI-compatible, 1 deprecated, 1 payment) | 0 |
| REST operations reachable only through the SDKs (Agent Monitors, beta) | 9 | 0 |
| Retired operations that still have a published document (`/research/v1`) | 3 | 0 (correct) |
| Tool names the hosted MCP server recognises | 12 (4 current, 8 deprecated) | 3 (upstream `examcp`) |
| Tools on the hosted Websets MCP server | 23 | 0 |
| Tools on the docs MCP server | 3 | 0 |

## 2. Published OpenAPI documents

Source for the two listed documents: https://exa.ai/docs/admin/openapi-spec.md and https://exa.ai/docs/llms.txt. The four unlisted documents were found by requesting likely file names under `https://exa.ai/docs/`; about 50 other names returned 404.

| Document URL | Listed in docs | Title, version | Server (base URL) | Auth | Operations | Notes |
| - | - | - | - | - | - | - |
| https://exa.ai/docs/exa-spec.yaml (also `.json`) | Yes | Exa Public API, 2.0.0 | `https://api.exa.ai`; the 39 `/v0/*` operations each declare `https://api.exa.ai/websets` | `x-api-key: <key>` or `Authorization: Bearer <key>` | 64 on 42 paths | 1 deprecated, 5 beta, 4 with an SSE response variant. All request bodies are JSON |
| https://exa.ai/docs/team-management-spec.yaml | Yes | Team Management API, 1.0.0 | `https://admin-api.exa.ai/team-management` | `x-api-key: <service key>` | 9 on 6 paths | Different host and a different credential. Server is declared once for the document, not per operation |
| https://exa.ai/docs/websets-spec.yaml | No | Websets, 0 | `https://api.exa.ai/websets/` | `x-api-key` | 39 | Every operation is also in the main document. Adds nothing |
| https://exa.ai/docs/monitors-spec.yaml | No | Exa Monitors API, 1.0.0 | `https://api.exa.ai` | `x-api-key` | 9 | Same 9 operations as the main document |
| https://exa.ai/docs/agent-api-spec.yaml | No | Exa Agent, 0.1.0 | `https://api.exa.ai` | `x-api-key` | 6 | Stale: lacks `POST /agent/runs/{id}/stop`, which the main document has |
| https://exa.ai/docs/exa-research-spec.yaml | No | Exa Research API, 1.0.0 | `https://api.exa.ai` | `x-api-key` | 3 | Retired API. Docs say `/research/*` returns HTTP 410 (https://exa.ai/docs/reference/deprecations.md). Do not load |
| https://github.com/exa-labs/openapi-spec `exa-openapi-spec.yaml` | — | Exa Public API, 2.0.0 | `https://api.exa.ai` | same as main | 64 | Same method and path set as the docs copy; repository last pushed 2026-11-02, file is 10 KB smaller, so the docs copy is newer |
| https://github.com/exa-labs/openapi-spec `exa-websets-spec.yaml` | — | Websets, 0 | `https://api.exa.ai/websets/` | `x-api-key` | 38 | Lacks `GET /v0/teams/me` |

Use the two listed documents. Everything else is a subset, stale, or retired.

### 2.1 Main API document: 64 operations

Source: https://exa.ai/docs/exa-spec.yaml (checked by: spec). The gateway tool name was computed with the gateway's naming rule and matched all 64 names in the gateway dump. Rows 26 to 64 all declare the server `https://api.exa.ai/websets`.

| # | Method | Path | Gateway tool (`exa__…`) | Flags |
| - | - | - | - | - |
| 1 | POST | `/search` | `search` | SSE variant when `stream: true` |
| 2 | POST | `/contents` | `getContents` | |
| 3 | POST | `/answer` | `answer` | SSE variant when `stream: true` |
| 4 | POST | `/findSimilar` | `findSimilar` | Deprecated |
| 5 | GET | `/monitors` | `listMonitors` | |
| 6 | POST | `/monitors` | `createMonitor` | Response carries a webhook signing secret |
| 7 | POST | `/monitors/batch` | `batchMonitors` | Bulk delete, pause or unpause; `dry_run` defaults to true |
| 8 | GET | `/monitors/{id}` | `getMonitor` | |
| 9 | DELETE | `/monitors/{id}` | `deleteMonitor` | |
| 10 | PATCH | `/monitors/{id}` | `updateMonitor` | |
| 11 | POST | `/monitors/{id}/trigger` | `triggerMonitor` | |
| 12 | GET | `/monitors/{id}/runs` | `listRuns` | |
| 13 | GET | `/monitors/{id}/runs/{runId}` | `getRun` | |
| 14 | GET | `/agent/runs` | `listAgentRuns` | |
| 15 | POST | `/agent/runs` | `createAgentRun` | SSE only when `Accept: text/event-stream`; header parameters `Accept`, `Exa-Beta` |
| 16 | GET | `/agent/runs/{id}` | `getAgentRun` | |
| 17 | DELETE | `/agent/runs/{id}` | `deleteAgentRun` | |
| 18 | POST | `/agent/runs/{id}/cancel` | `cancelAgentRun` | |
| 19 | POST | `/agent/runs/{id}/stop` | `stopAgentRun` | |
| 20 | GET | `/agent/runs/{id}/events` | `listAgentRunEvents` | SSE only when `Accept: text/event-stream`; header parameters `Accept`, `Last-Event-ID` |
| 21 | GET | `/batches` | `listBatches` | Beta; required header `Exa-Beta: batches-2026-06-06` |
| 22 | POST | `/batches` | `createBatch` | Beta; same required header |
| 23 | GET | `/batches/{id}` | `getBatch` | Beta; same required header |
| 24 | DELETE | `/batches/{id}` | `deleteBatch` | Beta; same required header |
| 25 | POST | `/batches/{id}/cancel` | `cancelBatch` | Beta; same required header |
| 26 | GET | `/v0/teams/me` | `get_v0_teams_me` | |
| 27 | GET | `/v0/websets` | `websets_list` | |
| 28 | POST | `/v0/websets` | `websets_create` | |
| 29 | GET | `/v0/websets/{id}` | `get_v0_websets_id` | |
| 30 | POST | `/v0/websets/{id}` | `websets_update` | |
| 31 | DELETE | `/v0/websets/{id}` | `delete_v0_websets_id` | |
| 32 | POST | `/v0/websets/{id}/cancel` | `websets_cancel` | |
| 33 | POST | `/v0/websets/{webset}/searches` | `websets_searches_create` | |
| 34 | GET | `/v0/websets/{webset}/searches/{id}` | `get_v0_websets_webset_searches_id` | |
| 35 | POST | `/v0/websets/{webset}/searches/{id}/cancel` | `websets_searches_cancel` | |
| 36 | POST | `/v0/websets/{webset}/enrichments` | `websets_enrichments_create` | |
| 37 | GET | `/v0/websets/{webset}/enrichments/{id}` | `get_v0_websets_webset_enrichments_id` | |
| 38 | DELETE | `/v0/websets/{webset}/enrichments/{id}` | `delete_v0_websets_webset_enrichments_id` | |
| 39 | PATCH | `/v0/websets/{webset}/enrichments/{id}` | `websets_enrichments_update` | |
| 40 | POST | `/v0/websets/{webset}/enrichments/{id}/cancel` | `websets_enrichments_cancel` | |
| 41 | GET | `/v0/websets/{webset}/items/{id}` | `get_v0_websets_webset_items_id` | |
| 42 | DELETE | `/v0/websets/{webset}/items/{id}` | `delete_v0_websets_webset_items_id` | |
| 43 | GET | `/v0/websets/{webset}/items` | `websets_items_list` | |
| 44 | POST | `/v0/websets/preview` | `websets_preview` | Body is passed as one `body` argument |
| 45 | GET | `/v0/monitors` | `monitors_list` | Websets monitors, distinct from rows 5 to 13 |
| 46 | POST | `/v0/monitors` | `monitors_create` | |
| 47 | GET | `/v0/monitors/{id}` | `get_v0_monitors_id` | |
| 48 | DELETE | `/v0/monitors/{id}` | `delete_v0_monitors_id` | |
| 49 | PATCH | `/v0/monitors/{id}` | `monitors_update` | |
| 50 | GET | `/v0/monitors/{monitor}/runs` | `monitors_runs_list` | |
| 51 | GET | `/v0/monitors/{monitor}/runs/{id}` | `get_v0_monitors_monitor_runs_id` | |
| 52 | GET | `/v0/imports` | `imports_list` | |
| 53 | POST | `/v0/imports` | `imports_create` | Body is passed as one `body` argument; returns a presigned upload URL |
| 54 | GET | `/v0/imports/{id}` | `get_v0_imports_id` | |
| 55 | DELETE | `/v0/imports/{id}` | `delete_v0_imports_id` | |
| 56 | PATCH | `/v0/imports/{id}` | `imports_update` | |
| 57 | GET | `/v0/webhooks` | `webhooks_list` | |
| 58 | POST | `/v0/webhooks` | `webhooks_create` | Response carries the webhook signing secret |
| 59 | GET | `/v0/webhooks/{id}` | `get_v0_webhooks_id` | |
| 60 | DELETE | `/v0/webhooks/{id}` | `delete_v0_webhooks_id` | |
| 61 | PATCH | `/v0/webhooks/{id}` | `webhooks_update` | |
| 62 | GET | `/v0/webhooks/{id}/attempts` | `webhooks_attempts_list` | |
| 63 | GET | `/v0/events` | `events_list` | |
| 64 | GET | `/v0/events/{id}` | `get_v0_events_id` | |

By family: search 1, contents 1, answer 1, findSimilar 1, search monitors 9, agent runs 7, batches 5, Websets 39 (team 1, websets 6, searches 3, enrichments 5, items 3, preview 1, monitors 7, imports 5, webhooks 6, events 2).

### 2.2 Team Management document: 9 operations

Source: https://exa.ai/docs/team-management-spec.yaml and https://exa.ai/docs/admin/team-management.md (checked by: spec, docs; `GET /credits` without a key returned 401, so the host and path are live). Base URL `https://admin-api.exa.ai/team-management`. The credential is a service key created on the dashboard's "Service keys" tab after Exa support enables the feature for the team. An ordinary API key is not accepted.

| # | Method | Path | Tool name if loaded | Parameters | Response contains a key secret |
| - | - | - | - | - | - |
| 1 | GET | `/api-keys` | `list_api_keys` | `api_key_id` | Yes (field `id`, for every key) |
| 2 | POST | `/api-keys` | `create_api_key` | `name`, `rateLimit`, `budgetCents` | Yes (`id`, `secret`) |
| 3 | GET | `/api-keys/{id}` | `get_api_key` | `id` | Yes (`id`) |
| 4 | PUT | `/api-keys/{id}` | `update_api_key` | `id`, `name`, `rateLimit`, `budgetCents` | Yes (`id`) |
| 5 | DELETE | `/api-keys/{id}` | `delete_api_key` | `id` | No |
| 6 | POST | `/api-keys/{id}/rotate` | `rotate_api_key` | `id`, `gracePeriodSeconds`, `force` | Yes (`id`, `secret`) |
| 7 | POST | `/api-keys/{id}/revoke-previous` | `revoke_previous_api_key_secret` | `id` | No |
| 8 | GET | `/api-keys/{id}/usage` | `get_api_key_usage` | `id`, `start_date`, `end_date`, `group_by` | Yes (`api_key_id`) |
| 9 | GET | `/credits` | `get_team_credits` | none | No |

### 2.3 Retired: Research document, 3 operations

Source: https://exa.ai/docs/exa-research-spec.yaml (checked by: spec) and https://exa.ai/docs/reference/deprecations.md (docs). `GET /research/v1`, `POST /research/v1`, `GET /research/v1/{researchId}`. Docs state these return HTTP 410 since 2026-04-01; the SDKs reject the calls locally without sending them (source: exa-js 2.29.0 `src/research/client.ts`). Not called here, so the 410 itself is UNCONFIRMED.

## 3. Documented REST endpoints in no OpenAPI document

| Endpoint | Host | Auth | What it is | Checked by | Source |
| - | - | - | - | - | - |
| `POST /chat/completions` | `https://api.exa.ai` | API key | OpenAI Chat Completions shape, model `exa`; routes to `/answer`. `stream: true` gives SSE | docs | https://exa.ai/docs/integrations/openai-sdk.md |
| `POST /responses` | `https://api.exa.ai` | API key | OpenAI Responses shape, model `exa-agent`; routes to the Agent API. Modes: synchronous, `stream: true`, `background: true`. `reasoning.effort` selects effort; `high`, `xhigh`, `ultra` return 400 when synchronous. No `budget` field | docs | same |
| `GET /responses/{id}` | `https://api.exa.ai` | API key | Poll a background response | docs | same |
| `POST /responses/{id}/cancel` | `https://api.exa.ai` | API key | Cancel a run started through `/responses` | docs | same |
| `POST /context` | `https://api.exa.ai` | API key | Exa Code context endpoint. Deprecated; use `/search` with highlights | docs | https://exa.ai/docs/reference/deprecations.md |
| `POST /team-management/nevermined/purchase-key` | `https://admin-api.exa.ai` | Header `payment-signature: <x402 token>` | A 7 USD card-delegated purchase that returns or tops up an API key | docs | https://exa.ai/docs/integrations/payments/nevermined.md |

Other ways to reach existing endpoints, not new endpoints:

| Mechanism | Applies to | Detail | Checked by | Source |
| - | - | - | - | - |
| x402 keyless payment | `POST /search`, `POST /contents` only | A request with no key returns 402 with a `PAYMENT-REQUIRED` header; retry with `PAYMENT-SIGNATURE` (USDC on Arc, Base, World Chain or Solana). Capped at 10 results | docs | https://exa.ai/docs/integrations/payments/x402/quickstart.md |
| World AgentKit | same two endpoints | 100 free keyless requests per verified human per calendar month, per endpoint, via an `agentkit` header | docs | https://exa.ai/docs/integrations/payments/x402/agentkit.md |
| MPP (Tempo) | same two endpoints | 402 with a `WWW-Authenticate: Payment` challenge; receipt in `Payment-Receipt`. Capped at 10 results | docs | https://exa.ai/docs/integrations/payments/mpp/quickstart.md |
| EU region host | `POST /search` (types `auto` and `lite` only) and `POST /contents` | Base URL `https://api.eu.exa.ai`. Needs an EU team, created by Exa sales; an EU key works only on this host. Responses carry `x-exa-processing-region: eu`. The host appears in the announcement only, not in the docs or any document | vendor blog | https://exa.ai/blog/eu-data-residency |
| Beta opt-in header | Any request | `Exa-Beta: <token>[, <token>]`, a comma-separated list. Known tokens: `batches-2026-06-06`, `dynamic-highlights-2026-08-28`, `agent-monitors-2026-08-04` | spec, source | https://exa.ai/docs/exa-spec.yaml, exa-js 2.29.0 |
| Snapshot | `contents.snapshotAsOf` on `/search`, `snapshotAsOf` on `/contents` | A parameter, already in the main document. Not on the free plan (403 `SNAPSHOT_NOT_ON_PLAN`); Developer plan gets 100 requests at 10 QPS | docs | https://exa.ai/docs/search/snapshot.md |
| Connect data sources | `dataSources` on `POST /agent/runs` | A parameter, already in the main document. Up to five providers per run | docs | https://exa.ai/docs/agent/connect/overview.md |

## 4. Hosted MCP servers

### 4.1 `https://mcp.exa.ai/mcp` (main)

Sources: https://exa.ai/docs/get-started/exa-mcp.md (docs), https://github.com/exa-labs/exa-mcp-server at 3.5.1 (source), `https://mcp.exa.ai/.well-known/mcp-config` and `tools/list` (live list). The deployed server reports version 3.6.0, one release ahead of the public source, so source-only details may have changed.

Transport is streamable HTTP. The same server also answers at `https://mcp.exa.ai/` and, forcing OAuth, at `https://mcp.exa.ai/mcp/oauth`.

| Auth mode | How | Checked by |
| - | - | - |
| Keyless | No credentials. Search and fetch tools only, IP rate-limited, IPv4 direct connections only | docs, live list |
| API key | `x-api-key: <key>` (documented); also `Authorization: Bearer <key>` or `?exaApiKey=<key>` | docs, source |
| OAuth | `?login` or the `/mcp/oauth` path; authorization server `https://auth.exa.ai`, scope `mcp:tools`, PKCE S256 | docs, live metadata |

URL parameters:

| Parameter | Values | Effect | Checked by |
| - | - | - | - |
| `tools` | Comma-separated tool names or the alias `agent_tools` | Replaces the default tool set. Unknown names are ignored. Naming a key-only tool without a key returns 401 | docs, source, live list |
| `dynamicHighlights` | `true` or `false` | `web_search_exa` and `web_search_advanced_exa` request Dynamic Highlights (beta): one shared excerpt budget across all results | source (README), live list accepted the URL |
| `defaultSearchType` | `auto`, `lite`, `fast`, `instant` | Search type used by `web_search_exa`. Undocumented | source only; UNCONFIRMED on the deployed version |
| `agentCallWindowMs` | Positive integer | How long one `agent_run` call waits before returning `status: "running"` (default 45000). Undocumented | source only |
| `login` | empty, `1`, `true`, `yes` | Force the OAuth challenge | docs, source |
| `exaApiKey` | API key | Key in the URL; headers are preferred | source |
| `client` | Any string containing `plugin` | Marks a plugin client and forces OAuth | source |
| `debug` | `true` | Server-side debug logging | source |

Tool names the server recognises (all 12 are listed by `/.well-known/mcp-config`):

| Tool | Status | On by default | Needs a key | Parameters | Backed by | Checked by |
| - | - | - | - | - | - | - |
| `web_search_exa` | Current | Yes | No | `query`, `numResults`, `objective` | `POST /search`, type `auto`, highlights | live list |
| `web_fetch_exa` | Current | Yes | No | `urls`, `maxCharacters` (default 3000) | `POST /contents`, text | live list |
| `agent_run` | Current | Yes, once a key or OAuth is present | Yes | `query`, `runId`, `systemPrompt`, `outputSchema`, `input`, `dataSources`, `previousRunId`, `effort`, `budget` | Agent API; effort defaults to `low` (source) | gateway dump, source |
| `web_search_advanced_exa` | Current, opt-in | No | No | 28: `query`, `numResults`, `type` (`auto`, `lite`, `fast`, `instant`), `category`, `includeDomains`, `excludeDomains`, `startPublishedDate`, `endPublishedDate`, `startCrawlDate`, `endCrawlDate`, `includeText`, `excludeText`, `userLocation`, `moderation`, `additionalQueries`, `textMaxCharacters`, `contextMaxCharacters`, `enableSummary`, `summaryQuery`, `enableHighlights`, `highlightsMaxCharacters`, `highlightsNumSentences`, `highlightsPerUrl`, `highlightsQuery`, `maxAgeHours`, `livecrawlTimeout`, `subpages`, `subpageTarget` | `POST /search` | live list |
| `get_code_context_exa` | Deprecated, opt-in | No | No | `query`, `numResults` | `POST /search`, type `lite` | live list |
| `company_research_exa` | Deprecated, opt-in | No | No | `companyName`, `numResults` | `POST /search`, category `company` | live list |
| `people_search_exa` | Deprecated, opt-in | No | No | `query`, `numResults` | `POST /search`, category `people` | live list |
| `linkedin_search_exa` | Deprecated, opt-in | No | No | `query`, `numResults` | `POST /search`, category `people` | live list |
| `crawling_exa` | Deprecated alias of `web_fetch_exa`, opt-in | No | No | `urls`, `maxCharacters` | `POST /contents` | live list |
| `deep_search_exa` | Deprecated, opt-in | No | Yes | `objective`, `type`, `numResults`, `highlightMaxCharacters`, `outputSchema`, `systemPrompt`, `structuredOutput` | `POST /search`, type `deep` by default | source only |
| `deep_researcher_start` | Deprecated, opt-in | No | Yes | `instructions`, `model`, `outputSchema` | `POST /research/v1`, which is retired, so expect failure (UNCONFIRMED) | source only |
| `deep_researcher_check` | Deprecated, opt-in | No | Yes | `researchId` | `GET /research/v1/{id}`, retired | source only |

Selection aliases accepted in `tools`: `agent_tools`, and the legacy names `agent_create_run`, `agent_run_stream`, `agent_wait_for_run`, `agent_get_run_output`, `agent_cancel_run`, all of which mean `agent_run` (source).

`web_search_advanced_exa` cannot run deep search: its `type` has no `deep` value. Through MCP, deep search exists only as the deprecated `deep_search_exa`. The REST `search` operation covers every type.

The server also serves, besides tools (live list): prompt `web_search_help`; with a key, prompt `agent_research_help`; resources `exa://tools/list` and `skill://search/SKILL.md`; with a key, `exa://agent/skill` and `exa://agent/schema-templates` (source).

Keyless limits: the docs say only "a free rate limit". The source's defaults are 2 requests per second and 50 per day when not overridden by deployment settings; the February 2026 changelog said 3 per second and 150 per day. Current values UNCONFIRMED. Only `tools/call` is limited.

### 4.2 `https://websetsmcp.exa.ai/mcp` (Websets)

Sources: https://github.com/exa-labs/websets-mcp-server at 1.0.1 (source), `tools/list` (live list). Not mentioned anywhere in the Exa docs. Auth: `Authorization: Bearer <key>` or `?exaApiKey=<key>`; this server does not read `x-api-key`. `?tools=` selects tools. Calls go to `https://api.exa.ai/websets/v0`.

23 tools: `create_webset`, `list_websets`, `get_webset`, `update_webset`, `delete_webset`, `list_webset_items`, `get_item`, `create_search`, `get_search`, `cancel_search`, `create_enrichment`, `get_enrichment`, `cancel_enrichment`, `preview_webset`, `create_webhook`, `get_webhook`, `update_webhook`, `delete_webhook`, `list_webhooks`, `create_import`, `get_import`, `list_imports`, `list_events`.

It has no tools for Websets monitors, webset cancel, item delete, enrichment update or delete, import update or delete, webhook attempts, single event, or team info. All of those are in the REST document.

### 4.3 `https://exa.ai/docs/mcp` (documentation)

Checked by: live list. No auth. Three tools: `search_exa` (`query`), `query_docs_filesystem_exa` (`command`), `submit_feedback` (`path`, `feedback`). It searches Exa's documentation, not the web. `https://docs.exa.ai/mcp` redirects to it.

### 4.4 Not separate endpoints

The Claude, ChatGPT and Codex, Cursor, Grok Build, Antigravity and Gemini CLI plugins, the Zed extension and the Kiro power all point at `https://mcp.exa.ai/mcp` (the Claude plugin adds `?client=claude-code-plugin`). The AWS Marketplace AgentCore image is the same server as a container. Enterprise Managed Auth uses the same URL with an identity provider (https://exa.ai/docs/admin/mcp-enterprise-managed-auth.md).

## 5. SDK, CLI, plugin and skill surface

| Item | What it adds beyond the REST documents | Checked by | Source |
| - | - | - | - |
| Agent Monitors (beta) | Nine REST operations in no document and on no docs page: `POST /agent/monitors`, `GET /agent/monitors`, `GET /agent/monitors/{id}`, `DELETE /agent/monitors/{id}`, `POST /agent/monitors/{id}/entities`, `GET /agent/monitors/{id}/entities`, `GET /agent/monitors/{id}/changes`, `POST /agent/monitors/backtest`, `GET /agent/monitors/backtest/{id}`. Each needs `Exa-Beta: agent-monitors-2026-08-04`. A monitor keeps a table of entities by fields fresh on a cadence (minimum 6 hours). Create accepts an `Idempotency-Key` header. Price and plan access UNCONFIRMED | source | exa-js 2.29.0 `src/agent/monitors/`, exa-py 2.29.0 README "Agent Monitors (Beta)" |
| `exa-py` 2.29.0, `exa-js` 2.29.0 | Otherwise the same endpoints as the main document: `/search`, `/contents`, `/findSimilar`, `/answer`, `/agent/runs…`, `/monitors…`, `/websets/v0/…`. Client-side helpers only: `streamSearch`, `streamAnswer`, `searchAndContents`, polling waits, CSV upload for imports, tool definitions for OpenAI and Anthropic tool calling, `exa.wrap(openai)` in Python. A base-URL option (`baseURL` or `EXA_BASE_URL` in exa-js, `base_url` in exa-py) selects the EU host | source | https://github.com/exa-labs/exa-js, https://github.com/exa-labs/exa-py |
| Batch API in SDKs | Absent. Batches are REST only | source | same |
| CLI | None published by Exa. The only command-line items are `npx exa-mcp-server` (the MCP server over stdio) and Stripe's `stripe projects add exa/api`, which provisions a key. Negative result from the docs index and the organisation's 108 public repositories | docs, source | https://exa.ai/auth.md |
| Agent plugin skills | `search` and `exa-agent`, shipped with the MCP plugins. They instruct an agent how to use `web_search_exa`, `web_fetch_exa` and `agent_run`; no extra API | source | https://github.com/exa-labs/exa-mcp-server `skills/` |
| Build skills | Five, installed with `npx skills add exa-labs/agent-skills`: `build-with-exa`, `exa-search`, `exa-contents`, `company-research`, `lead-generation`. Instructions and reference text only | source | https://github.com/exa-labs/agent-skills |
| Other first-party integrations | Google Sheets add-on (`=EXA`, `=EXA_SEARCH`, `=EXA_ANSWER`, `=EXA_CONTENTS`, `=EXA_FINDSIMILAR`), Slack app, n8n node, Vercel AI SDK package, Convex component, Apify actor, Obsidian plugin. All call the endpoints above | docs, source | https://exa.ai/docs/llms.txt, https://github.com/exa-labs |

## 6. Gateway comparison

Gateway state compared: the tool dump taken 2026-11-27 (`exa`: 64 tools from the main document, base URL `https://api.exa.ai`, header `x-api-key`; `examcp`: 3 tools from `https://mcp.exa.ai/mcp`) and `src/gateway/openapi.ts` as of the same day. The gateway now accepts several documents per upstream, honours a server URL declared on an operation or path, and can send fixed extra headers, so each item below says whether it is a config-only change.

Two properties of the current code shape the advice:

- Only a server declared on an operation or path is honoured. A document-level `servers` entry is ignored and the upstream `url` is used. So a second document whose own base URL differs (Team Management, the standalone Websets document) must not be added to the `exa` upstream; its calls would go to `https://api.exa.ai`.
- One upstream has one key list. Anything needing a different credential needs its own upstream.

### 6.1 Not exposed, and how to add each

| # | Missing | How to add | Kind of change |
| - | - | - | - |
| A | Team Management, 9 operations (2.2) | New upstream, for example `exaadmin`: `kind = "openapi"`, `url = "https://admin-api.exa.ai/team-management"`, `spec = "https://exa.ai/docs/team-management-spec.yaml"`, `auth = "header"`, `auth_name = "x-api-key"`, `auth_prefix = ""`, `keys = [<service key reference>]`. Start with `include = ["get_team_credits"]`: six of the nine responses contain live key secrets, which would reach the agent and the saved payload files | Config only, plus a service key from Exa support |
| B | Opt-in MCP tool `web_search_advanced_exa` (4.1) | In the `examcp` block set `url = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run"`. Header stays `x-api-key` | Config only |
| C | MCP Dynamic Highlights | Append `&dynamicHighlights=true` to the `examcp` URL | Config only |
| D | Eight deprecated MCP tools (4.1) | Could be added to the same `tools=` list. Not recommended: each is a fixed-parameter wrapper over `/search` or `/contents`, and two call the retired Research API | None advised |
| E | Dynamic Highlights on REST `search` and `getContents` | In the `exa` block add `headers = { "Exa-Beta" = "dynamic-highlights-2026-08-28" }`. Whether the token is ignored on requests that do not set `highlights.dynamic` is UNCONFIRMED; run one plain search after adding it | Config only |
| F | Batch API header | Same header table: `"Exa-Beta" = "batches-2026-06-06, dynamic-highlights-2026-08-28"`. Useful only on an Enterprise team with batches enabled; otherwise hide the tools (6.2) | Config only |
| G | EU region | New upstream, for example `exaeu`: `kind = "openapi"`, `url = "https://api.eu.exa.ai"`, `spec = "https://exa.ai/docs/exa-spec.yaml"`, `auth_name = "x-api-key"`, `auth_prefix = ""`, `keys = [<EU team key reference>]`, `include = ["search", "getContents"]`. The include list matters: the Websets operations carry their own US server URL | Config only, plus an EU team |
| H | OpenAI-compatible endpoints, 4 operations (3) | No document exists. Would need a hand-written local document listed second in the `exa` block's `spec`, with no `servers` entries so the upstream URL applies. Not recommended: they duplicate `answer` and the agent run tools | Local document to write |
| I | Agent Monitors, 9 operations (5) | No document exists. Same approach as H, plus `agent-monitors-2026-08-04` in the `Exa-Beta` header. Request shapes are known only from SDK types | Local document to write; access UNCONFIRMED |
| J | Websets MCP, 23 tools (4.2) | New upstream: `kind = "mcp"`, `url = "https://websetsmcp.exa.ai/mcp"`, `auth = "header"`, `auth_name = "Authorization"`, `auth_prefix = "Bearer "`. Not needed: the `exa` upstream already has all 39 Websets REST operations, which is more than these 23 tools | Config only; not advised |
| K | Docs MCP, 3 tools (4.3) | New upstream: `kind = "mcp"`, `url = "https://exa.ai/docs/mcp"`, `auth = "none"`. Optional; exclude `submit_feedback` | Config only |
| L | `POST /context`, `/research/v1`, Nevermined purchase, x402, MPP | Do not add. Deprecated, retired, or a payment flow that needs a wallet signature the gateway cannot produce | None |

### 6.2 Exposed today but will not work as built

| Tools | Problem | Fix |
| - | - | - |
| `listBatches`, `createBatch`, `getBatch`, `deleteBatch`, `cancelBatch` | The document marks `Exa-Beta: batches-2026-06-06` as a required header and the gateway does not send header parameters, so calls are expected to be rejected (not tested). The API is also Enterprise-only, and results arrive as a JSONL file at a short-lived presigned URL the gateway cannot fetch | Hide with `exclude = ["*Batch*"]` (this pattern does not match `batchMonitors`), or add the header (6.1 F) on an enabled team |
| `search`, `getContents`, `findSimilar` with `highlights.dynamic: true` | The document says such requests are rejected without `Exa-Beta: dynamic-highlights-2026-08-28` | 6.1 E |
| `search` with `stream: true` and an `outputSchema`; `answer` with `stream: true` | The response is SSE. The gateway waits for the stream to end and returns the raw event text, not JSON; the cost reader may not find `costDollars` | Tell agents not to set `stream`. A tool cannot hide a single parameter today |
| All 39 `/v0/*` Websets tools | Their base URL is `https://api.exa.ai/websets`, not the upstream's `https://api.exa.ai`. They work only through the per-operation server support. Confirmed without a key: `GET https://api.exa.ai/websets/v0/teams/me` returns 401 and `GET https://api.exa.ai/v0/teams/me` returns 404 | Already handled in current code. `get_v0_teams_me` is a free call to confirm it after any change to that code |
| `imports_create` | Returns a presigned `uploadUrl`; the CSV must then be sent with `PUT` to that URL within an hour. Non-JSON body on another host, so the gateway cannot finish an import | Leave exposed for reading; upload outside the gateway |
| `createAgentRun`, `listAgentRunEvents` | Work in JSON mode. Streaming is requested with `Accept: text/event-stream`, which the gateway never sends, so streaming and `Last-Event-ID` replay are unavailable | None needed; poll with `getAgentRun` |
| `createAgentRun` then `getAgentRun`; `examcp__agent_run` then the same tool with `runId` | A run belongs to the team of the key that started it. After the gateway moves to another team's key the run cannot be polled or resumed (already listed under Limits in `docs/components/gateway.md`) | Keep keys of one team together, or finish polling before a rotation |
| `findSimilar` | Deprecated endpoint; responses carry a `Deprecation` header | Hide with `exclude = ["findSimilar"]` |
| `createMonitor`, `webhooks_create` | Not a failure: the response includes a webhook signing secret, which the gateway saves in the payload file and returns to the agent | Decide whether agents should create webhooks at all |

Nothing in the `exa` upstream needs a different credential. The only operations that do are Team Management (service key) and the EU host (EU team key), and neither is loaded. `examcp` has no failing tool: with a key it lists `web_search_exa`, `web_fetch_exa` and `agent_run`, matching the dump.

### 6.3 Parameters the gateway's tools lack

Compared by script: every path, query and top-level body parameter of all 64 operations against the dump.

| Tool | Missing | Effect |
| - | - | - |
| All 64 | None of the path, query or body parameters | The REST tools are complete. `search` has all 23 body fields, `getContents` all 16 |
| `createAgentRun` | Header parameters `Accept`, `Exa-Beta` | No streaming; no per-call beta opt-in |
| `listAgentRunEvents` | Header parameters `Accept`, `Last-Event-ID` | No SSE replay |
| The five batch tools | Header parameter `Exa-Beta` | Calls fail (6.2) |
| `imports_create` | `size`, `count`, `title`, `format`, `metadata`, `entity`, `csv` are not top-level arguments | They are accepted inside the single `body` argument, because the body schema is a `oneOf` |
| `websets_preview` | Body field `search` is not top-level | It collides with the query parameter `search`, so the body goes in `body` |
| `search` | `metadata` | The `lite` type description names `metadata` as accepted, but no schema or SDK defines it. UNCONFIRMED that the API takes it |
| `examcp__web_search_exa` | Everything except `query`, `numResults`, `objective` | By design. Filters, dates, type, summaries and freshness need `web_search_advanced_exa` (6.1 B) or the REST `search` tool |
| `examcp__web_fetch_exa` | Highlights, summary, subpages, freshness, snapshot | By design. Use REST `getContents` |

Deprecated or ignored parameters still shown on the REST tools, which the gateway cannot hide individually: `includeText`, `excludeText`, `startCrawlDate`, `endCrawlDate`, `context` on `search`; `livecrawl`, `crawledBeforeDate`, `context` on `getContents`; `contents.livecrawl`, `contents.context`, `contents.subpages`, `contents.subpageTarget`, `contents.highlights.numSentences`, `contents.highlights.highlightsPerUrl` inside `contents` (https://exa.ai/docs/reference/deprecations.md).

## 7. Tool families: purpose and price per call

Prices from https://exa.ai/docs/admin/pricing.md, https://exa.ai/docs/websets/pricing.md and https://exa.ai/docs/agent/connect/overview.md (vendor list prices, 2026-11-27). "Per call" converts the per-1,000 rates.

| Family | For | Price per call |
| - | - | - |
| Search (`POST /search`) | Ranked web results with text and highlights for up to 10 results; deep types add a synthesised, cited answer | `lite` $0.004; `auto` $0.007; `deep-lite` and `deep` $0.012; legacy `instant` $0.004, `fast` $0.007, `deep-reasoning` $0.015. Plus $0.001 per result above 10 and $0.001 per page summary |
| Contents (`POST /contents`) | Text, highlights or a summary for URLs already known; subpage crawl; freshness control | $0.001 per page per content type requested |
| Answer (`POST /answer`) | One LLM answer with citations | $0.005 |
| Find similar (`POST /findSimilar`) | Pages similar to a URL. Deprecated | Not on the current price list; UNCONFIRMED |
| Search monitors (`/monitors…`) | A scheduled search that posts only new results to a webhook | $0.002 per request, read here as per run, plus $0.001 per result above 10 and $0.001 per summary. Whether create, list and get are free is not stated |
| Agent runs (`/agent/runs…`) | Asynchronous multi-step research, list building and enrichment with structured output | Fixed effort: `minimal` $0.012, `low` $0.025, `medium` $0.10, `high` $0.50, `xhigh` $1.00. Metered `auto` (cap $5) and `ultra` (cap $20): $0.10 per compute unit, $0.005 per search, $0.02 per email, $0.07 per phone number. List, get, cancel, stop, delete and events carry no listed charge |
| Connect data sources (inside an agent run) | Partner databases for the agent | Added to the run: Fiber $0.02 per credit, Similarweb $0.30 per credit, Baselayer varies, Affiliate.com $0.015, Particle $0.015, Financial Datasets $0.01, Jinko $0.005 per call; Polymarket and Macrobond free |
| Batches (`/batches…`) | Many `/search` or `/agent/runs` requests run asynchronously, results as JSONL. Enterprise beta | Not on the price list; UNCONFIRMED |
| Websets (`/websets/v0/…`) | Verified, enriched lists of entities built from a query; imports, enrichments, monitors, webhooks | Usage-based, no fixed price per call: $0.10 per compute unit plus $0.005 per search performed; contact enrichment $0.02 per email, $0.07 per phone number |
| Team Management (`admin-api.exa.ai`) | Create, rotate and budget API keys; read per-key usage and the team's credit balance | No charge listed |
| OpenAI-compatible (`/chat/completions`, `/responses`) | The same answer and agent products behind OpenAI SDK shapes | As Answer and Agent runs respectively |
| Agent Monitors (`/agent/monitors…`, beta) | Keeps a table of entities and fields current on a schedule; backtests over a past window | Not published; UNCONFIRMED |
| Keyless payment (x402, MPP) | `/search` and `/contents` without an account | Same prices, at most 10 results; AgentKit gives 100 free requests per person per month |
| MCP `web_search_exa` | One search with highlights for an agent | With a key: $0.007 (an `auto` search). Keyless: free within the rate limit |
| MCP `web_fetch_exa` | Page text for given URLs | With a key: $0.001 per URL. Keyless: free within the rate limit |
| MCP `web_search_advanced_exa` | Search with filters, dates, summaries, freshness and subpages | As Search, by the `type` chosen, plus summaries |
| MCP `agent_run` | An agent run, waited on inside the tool call and resumable | As Agent runs; the tool's default effort is `low`, $0.025 (source, 3.5.1) |
| Websets MCP (23 tools) | Websets from an MCP client | As Websets |
| Docs MCP (3 tools) | Search Exa's own documentation | Free |

Cost reporting: `search`, `getContents` and `answer` responses carry `costDollars.total`; agent runs carry `usage` and `costDollars`. Team Management, monitors CRUD and most Websets calls report no cost in the response.

## 8. Differences from `exa.md` in this folder

| `exa.md` says | Found |
| - | - |
| The older specialised MCP tools no longer appear in the tool table | The docs table omits them, but the server still recognises and lists eight deprecated tools when named in `?tools=` |
| MCP has a four-tool surface | Twelve recognised names; four current |
| Agent skills are three: Build with Exa, Exa Search, Exa Contents | The repository has five; `company-research` and `lead-generation` were added |
| Websets paths are `/v0/…` on `https://api.exa.ai` | The base path is `/websets`; `/v0/…` at the root returns 404 |
| OpenAI-compatible endpoints are `/chat/completions` and `/responses` | Also `GET /responses/{id}` and `POST /responses/{id}/cancel` |
| EU availability, no host given | `https://api.eu.exa.ai`, Search (`auto`, `lite`) and Contents only |
| A separate `websets-mcp-server` repository exists | It is also hosted, at `https://websetsmcp.exa.ai/mcp`, with 23 tools and Bearer-only auth |
| Not mentioned | Docs MCP server at `https://exa.ai/docs/mcp`; Agent Monitors beta in the SDKs; four unlisted OpenAPI documents; MCP URL parameters `defaultSearchType` and `agentCallWindowMs`; the Nevermined endpoint path |

## 9. Unconfirmed

| Item | Why |
| - | - |
| `/research/v1` returns 410; `deep_researcher_*` MCP tools fail | Stated by docs; not called |
| `deep_search_exa`, `deep_researcher_start`, `deep_researcher_check` are listed when a key is present | Key-only tools; seen in source and in `/.well-known/mcp-config`, not in a keyed `tools/list` |
| `defaultSearchType`, `agentCallWindowMs`, and `agent_run`'s default effort on the deployed server | Read from source 3.5.1; the deployment is 3.6.0 |
| Keyless MCP rate limits | Docs give no number; source defaults and an old changelog entry disagree |
| An `Exa-Beta` token is harmless on requests that do not use the feature, and on teams without the feature | Not stated; not tested |
| Body `stream: true` is honoured when the client sends `Accept: application/json` | Not tested |
| `metadata` on `/search` | Named in one description, defined nowhere |
| Agent Monitors access, price and request schemas | SDK-only beta with no docs page |
| Prices for `findSimilar` and batches; whether monitor and Websets management calls are free | Absent from the price list |
| Whether a free-plan team can obtain a Team Management service key | Docs say access is enabled per team on request |

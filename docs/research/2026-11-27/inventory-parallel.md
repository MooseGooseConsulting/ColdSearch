# Parallel: complete programmatic surface and gateway gaps (2026-11-27)

- **Date:** 2026-11-27. Read-only research. No API key was used and no paid endpoint was called.
- **How things were counted:** each spec document was downloaded with curl and its method + path pairs were enumerated by script, not read off prose. Hosted MCP tool lists come from `initialize` + `tools/list` sent without credentials; no tool was ever called.
- **Evidence labels:** SPEC = counted from a downloaded document. LIVE = observed on a vendor server today without a key. DOCS = vendor documentation. DUMP = the gateway's own tool dump taken with a key (`parallel`, `parallelmcp`). UNCONFIRMED = could not be verified.
- **Relation to `parallel.md` in this folder:** that note covers billing, terms and benchmarks. This file covers the surface. Section 8 lists what that note missed or had wrong.

Primary sources: <https://docs.parallel.ai/llms.txt>, <https://docs.parallel.ai/llms-full.txt>, <https://docs.parallel.ai/public-openapi.json>, <https://api.parallel.ai/account/service/openapi.json>, <https://parallelmpp.dev/openapi.json>, <https://docs.parallel.ai/integrations/mcp/quickstart.md>, <https://github.com/parallel-web/parallel-agent-skills>, <https://github.com/parallel-web/parallel-web-tools>, <https://github.com/parallel-web/parallel-sdk-python>.

## 0. Numbers at a glance

| Thing | Count | Evidence |
| - | - | - |
| Operations in the public API spec | 41 (25 POST, 16 GET; 39 paths) | SPEC |
| Of those, exposed by the gateway `parallel` upstream | 41 of 41, every path, query and top-level body field present | SPEC vs DUMP, by script |
| Operations in the Account API spec | 10 (4 POST, 3 GET, 3 DELETE), none in the gateway | SPEC |
| Operations in the payments-gateway spec | 6, none in the gateway | SPEC |
| Documented REST routes in no spec | 2 current (Ingest), 2 legacy beta, 9 legacy alpha, 6 OAuth | DOCS |
| Operations that require an extra header today | 0. `parallel-beta` is declared as optional on 12 operations and the docs say it is no longer needed | SPEC + DOCS |
| Tools on the current hosted MCP server | 14 exist; 7 are listed by default without a key, 7 with a key | LIVE + DUMP |
| Tools only reachable through MCP | 3: `find_verticals`, `search_vertical`, `send_feedback` | LIVE vs SPEC |
| Streaming (SSE) operations the gateway lists as ordinary tools | 4 always-SSE, 1 SSE on request | SPEC |

## 1. Published spec documents

| # | Document | Title, version | Base URL | Auth | Operations | In gateway |
| - | - | - | - | - | - | - |
| 1 | <https://docs.parallel.ai/public-openapi.json> | "Parallel API" 0.1.2, OpenAPI 3.1.0, 466,497 bytes | `https://api.parallel.ai` | header `x-api-key: <key>` | 41 | yes, all |
| 1a | <https://docs.parallel.ai/docs-latest-openapi.json> | byte-identical to #1 today (same SHA-256, `17cac4cfe052...`) | same | same | 41 | n/a |
| 2 | <https://api.parallel.ai/account/service/openapi.json> | "FastAPI" 0.1.0 (the Account / Service API) | `https://api.parallel.ai/account` | `Authorization: Bearer <access token>`; the token comes from device-flow OAuth, an API key is rejected | 10 | no |
| 3 | <https://parallelmpp.dev/openapi.json> | "Parallel API Gateway" 1.0.0 | `https://parallelmpp.dev` (document has no `servers` entry) | HTTP `Payment` scheme: a 402 challenge paid per request (MPP or x402). No API key | 6 | no |

Probed and not a spec: `https://api.parallel.ai/openapi.json` (401), `https://docs.parallel.ai/openapi.json` (404), `https://eu.parallel.ai/openapi.json` (404), `https://mcp.parallel.ai/openapi.json` (401).

### 1.1 Public API: all 41 operations (SPEC)

By family: Search 6 (web, flights, hotels, images, places, shopping), Extract 1, Decisions 1, Tasks 11 (5 run + 6 group), FindAll 10 (9 run + Entity Search), Monitor 8, Memory 3, Responses 1. Gateway tool names are prefixed `parallel__`.

| # | Method | Path | Gateway tool | Family | In gateway | Notes |
| - | - | - | - | - | - | - |
| 1 | POST | `/v1/search` | `post_v1_search` | Search | yes |  |
| 2 | POST | `/v1/flights/search` | `post_v1_flights_search` | Search | yes |  |
| 3 | POST | `/v1/hotels/search` | `post_v1_hotels_search` | Search | yes |  |
| 4 | POST | `/v1/images/search` | `post_v1_images_search` | Search | yes |  |
| 5 | POST | `/v1/places/search` | `post_v1_places_search` | Search | yes |  |
| 6 | POST | `/v1/shopping/search` | `post_v1_shopping_search` | Search | yes |  |
| 7 | POST | `/v1/extract` | `post_v1_extract` | Extract | yes |  |
| 8 | POST | `/v1/decisions` | `post_v1_decisions` | Decisions | yes |  |
| 9 | POST | `/v1/tasks/groups` | `post_v1_tasks_groups` | Tasks | yes |  |
| 10 | GET | `/v1/tasks/groups/{taskgroup_id}` | `get_v1_tasks_groups_taskgroup_id` | Tasks | yes |  |
| 11 | GET | `/v1/tasks/groups/{taskgroup_id}/events` | `get_v1_tasks_groups_taskgroup_id_events` | Tasks | yes | **SSE only** |
| 12 | GET | `/v1/tasks/groups/{taskgroup_id}/runs` | `get_v1_tasks_groups_taskgroup_id_runs` | Tasks | yes | **SSE only** |
| 13 | POST | `/v1/tasks/groups/{taskgroup_id}/runs` | `post_v1_tasks_groups_taskgroup_id_runs` | Tasks | yes | optional `parallel-beta` |
| 14 | GET | `/v1/tasks/groups/{taskgroup_id}/runs/{run_id}` | `get_v1_tasks_groups_taskgroup_id_runs_run_id` | Tasks | yes |  |
| 15 | POST | `/v1/tasks/runs` | `post_v1_tasks_runs` | Tasks | yes | optional `parallel-beta` |
| 16 | GET | `/v1/tasks/runs/{run_id}` | `get_v1_tasks_runs_run_id` | Tasks | yes |  |
| 17 | GET | `/v1/tasks/runs/{run_id}/events` | `get_v1_tasks_runs_run_id_events` | Tasks | yes | **SSE only** |
| 18 | GET | `/v1/tasks/runs/{run_id}/input` | `get_v1_tasks_runs_run_id_input` | Tasks | yes |  |
| 19 | GET | `/v1/tasks/runs/{run_id}/result` | `get_v1_tasks_runs_run_id_result` | Tasks | yes | optional `parallel-beta`; blocks until done; `timeout` default 600 s |
| 20 | POST | `/v1beta/findall/entity-search` | `post_v1beta_findall_entity_search` | FindAll | yes |  |
| 21 | POST | `/v1beta/findall/ingest` | `post_v1beta_findall_ingest` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 22 | POST | `/v1beta/findall/runs` | `post_v1beta_findall_runs` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 23 | GET | `/v1beta/findall/runs/{findall_id}` | `get_v1beta_findall_runs_findall_id` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 24 | POST | `/v1beta/findall/runs/{findall_id}/cancel` | `post_v1beta_findall_runs_findall_id_cancel` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 25 | POST | `/v1beta/findall/runs/{findall_id}/enrich` | `post_v1beta_findall_runs_findall_id_enrich` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 26 | GET | `/v1beta/findall/runs/{findall_id}/events` | `get_v1beta_findall_runs_findall_id_events` | FindAll | yes | **SSE only**; optional `parallel-beta` (marked deprecated) |
| 27 | POST | `/v1beta/findall/runs/{findall_id}/extend` | `post_v1beta_findall_runs_findall_id_extend` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 28 | GET | `/v1beta/findall/runs/{findall_id}/result` | `get_v1beta_findall_runs_findall_id_result` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 29 | GET | `/v1beta/findall/runs/{findall_id}/schema` | `get_v1beta_findall_runs_findall_id_schema` | FindAll | yes | optional `parallel-beta` (marked deprecated) |
| 30 | GET | `/v1/monitors` | `get_v1_monitors` | Monitor | yes |  |
| 31 | POST | `/v1/monitors` | `post_v1_monitors` | Monitor | yes |  |
| 32 | GET | `/v1/monitors/stats` | `get_v1_monitors_stats` | Monitor | yes |  |
| 33 | GET | `/v1/monitors/{monitor_id}` | `get_v1_monitors_monitor_id` | Monitor | yes |  |
| 34 | POST | `/v1/monitors/{monitor_id}/cancel` | `post_v1_monitors_monitor_id_cancel` | Monitor | yes |  |
| 35 | GET | `/v1/monitors/{monitor_id}/events` | `get_v1_monitors_monitor_id_events` | Monitor | yes |  |
| 36 | POST | `/v1/monitors/{monitor_id}/trigger` | `post_v1_monitors_monitor_id_trigger` | Monitor | yes |  |
| 37 | POST | `/v1/monitors/{monitor_id}/update` | `post_v1_monitors_monitor_id_update` | Monitor | yes |  |
| 38 | POST | `/v1beta/memory/clear` | `post_v1beta_memory_clear` | Memory | yes |  |
| 39 | POST | `/v1beta/memory/evict` | `post_v1beta_memory_evict` | Memory | yes |  |
| 40 | POST | `/v1beta/memory/retrieve` | `post_v1beta_memory_retrieve` | Memory | yes |  |
| 41 | POST | `/v1/responses` | `post_v1_responses` | Responses | yes | SSE when `stream: true` |

Not in this spec although the task brief expected them: a Chat API. The old Chat API page (`/chat-api/chat-quickstart`) now serves the Responses quickstart, and no chat path appears in today's docs or spec. Its path and status are UNCONFIRMED; treat `POST /v1/responses` as its replacement.

### 1.2 Account API: all 10 operations (SPEC)

| Method | Path | Summary | Arguments | Name the gateway would give it |
| - | - | - | - | - |
| GET | `/service/v1/balance` | Get Balance |  | `get_service_v1_balance` |
| POST | `/service/v1/balance/add` | Add to Balance | body: `amount_cents`, `idempotency_key` | `post_service_v1_balance_add` |
| GET | `/service/v1/usage` | Get Usage | query: `start_date`, `end_date`, `interval` | `get_service_v1_usage` |
| GET | `/service/v1/apps` | List Apps |  | `get_service_v1_apps` |
| POST | `/service/v1/apps` | Create App | body: `app_name` | `post_service_v1_apps` |
| DELETE | `/service/v1/apps/{app_id}` | Delete App |  | `delete_service_v1_apps_app_id` |
| POST | `/service/v1/apps/{app_id}/keys` | Create Key | body: `api_key_name`, `is_service_scoped` | `post_service_v1_apps_app_id_keys` |
| DELETE | `/service/v1/apps/{app_id}/keys/{api_key_id}` | Delete Key |  | `delete_service_v1_apps_app_id_keys_api_key_id` |
| POST | `/service/v1/apps/{app_id}/oauth-credentials` | Create OAuth Credential | body: `client_id`, `audience`, `scopes`, `is_service_scoped` | `post_service_v1_apps_app_id_oauth_credentials` |
| DELETE | `/service/v1/apps/{app_id}/oauth-credentials/{credential_id}` | Revoke OAuth Credential |  | `delete_service_v1_apps_app_id_oauth_credentials_` |

- OAuth scopes (DOCS): `apps:read`, `apps:create`, `apps:delete`, `keys:read`, `keys:create`, `keys:delete`, `balance:read`, `balance:add`, `usage:read`. There is a `keys:read` scope but no list-keys operation in the spec.
- Tokens (DOCS): access token lives 10 minutes; the refresh token is replaced on every refresh and expires after 30 days unused. Source: <https://docs.parallel.ai/integrations/account-api.md>.
- `POST /service/v1/balance/add` charges the organization's default card, 1 to 10,000 cents per call, and needs an `idempotency_key`.
- `GET /service/v1/usage`: caller must be an organization admin; 10 requests per minute per organization; window up to 365 days; line items are broken out by product, processor, app and API key. Source: <https://docs.parallel.ai/integrations/usage-api.md>.
- `POST .../oauth-credentials` takes an `audience` that must be a product API origin; the enum lists `https://api.parallel.ai` and `https://api-aws.parallel.ai` plus two non-production-looking origins whose purpose is UNCONFIRMED.

### 1.3 Payments gateway: all 6 operations (SPEC)

| Method | Path | Summary | Price in the spec |
| - | - | - | - |
| POST | `/api/responses` | Get a web-grounded answer with citations | Responses - $0.01 low / $0.05 medium / $0.25 high; default medium |
| POST | `/api/search` | Search the web via Parallel Web Systems | Web search - $0.01 per request |
| POST | `/api/extract` | Extract content from URLs via Parallel Web Systems | URL extraction - $0.01 per URL |
| POST | `/api/task` | Run an async AI task via Parallel Web Systems | AI task - $0.10 (pro) / $0.30 (ultra) |
| GET | `/api/task/{runId}` | Poll task status (free) | free |
| GET | `/api/wallet/balance/{address}` | Check pathUSD balance (free) | free |

Pay-per-request with no account, through the Machine Payments Protocol (Stripe or Tempo stablecoins) or x402 (USDC on Base). Rate limit 60 requests per minute per IP with `Retry-After` on 429. Source: <https://docs.parallel.ai/integrations/agentic-payments.md>.

### 1.4 Other hosts that serve the same public paths (DOCS)

| Host | What it is | Limits |
| - | - | - |
| `https://eu.parallel.ai` | EU data residency | Only `POST /v1/search` (`mode` must be `basic`, answered from the EU index with no live fetch, up to 20 results) and `POST /v1/extract` (up to 20 URLs). Enterprise agreement only. Same `x-api-key`; a new key takes about an hour to activate. Source: <https://docs.parallel.ai/resources/eu-data-residency.md> |
| `https://api-aws.parallel.ai` | AWS Marketplace "Search API" listing | Search API only. Same paths and auth. Keys from that listing do not work on `api.parallel.ai`. Source: <https://docs.parallel.ai/integrations/aws-marketplace.md> |
| `https://platform.parallel.ai` | Dashboard and OAuth endpoints (section 2) | Not an API host for product calls |

## 2. Documented REST routes that are in no spec (DOCS)

| Route | Host | Status | Auth | Body | Source |
| - | - | - | - | - | - |
| `POST /v1beta/tasks/suggest` | api.parallel.ai | Current ("Ingest API"). Turns `user_intent` into a task spec; optional `previous_task` | `x-api-key` | JSON | <https://docs.parallel.ai/task-api/ingest-api.md> |
| `POST /v1beta/tasks/suggest-processor` | api.parallel.ai | Current. Takes `task_spec`, optional `choose_processors_from`; never returns `lite` | `x-api-key` | JSON | same |
| `POST /v1beta/search` | api.parallel.ai | Legacy, still served. Different body from v1 (top-level `max_results`, `source_policy`, `fetch_policy`) | `x-api-key` | JSON | <https://docs.parallel.ai/search/search-migration-guide.md> |
| `POST /v1beta/extract` | api.parallel.ai | Legacy; "Both the Beta and V1 APIs continue to be supported" | `x-api-key` | JSON | <https://docs.parallel.ai/extract/extract-migration-guide.md> |
| `/v1alpha/monitors` family, 9 routes: `POST` and `GET /v1alpha/monitors`, `GET /v1alpha/monitors/list`, `GET`, `POST` and `DELETE /v1alpha/monitors/{id}`, `GET .../{id}/events`, `GET .../{id}/event_groups/{event_group_id}`, `POST .../{id}/simulate_event` | api.parallel.ai | Legacy alpha; "remain reachable but receive no new features" | `x-api-key` | JSON | <https://docs.parallel.ai/monitor-api/monitor-migration-guide.md> |
| `POST /getServiceKeys/register` | platform.parallel.ai | Registers a device-flow client | none | JSON | <https://docs.parallel.ai/integrations/account-api.md> |
| `POST /getServiceKeys/device/code`, `POST /getServiceKeys/token`, `POST /getServiceKeys/token/revoke` | platform.parallel.ai | Device code, token (device and refresh grants), revoke | none | **form-urlencoded** | same |
| `GET /getKeys/authorize`, `POST /getKeys/token` | platform.parallel.ai | OAuth provider (PKCE, scope `key:read`) that hands a third-party app the user's API key | none | form or JSON (UNCONFIRMED) | <https://docs.parallel.ai/integrations/oauth-provider.md> |

Outbound only, not callable: webhooks for task runs (`task_run.status`), monitors (`monitor.event.detected`) and FindAll. They need a public URL of yours. Source: <https://docs.parallel.ai/resources/webhook-setup.md>.

### 2.1 Extra headers

**No operation needs an extra header today.** What exists:

| Header | Where | Values | Needed? |
| - | - | - | - |
| `parallel-beta` | Declared as an optional header parameter on 12 operations: `POST /v1/tasks/runs`, `GET /v1/tasks/runs/{run_id}/result`, `POST /v1/tasks/groups/{taskgroup_id}/runs`, and 9 FindAll run operations (on those 9 it is marked `deprecated`). Not declared on Entity Search | Enum in the spec: `mcp-server-2025-07-17`, `events-sse-2025-07-24`, `webhook-2025-08-12`, `findall-2025-09-15`, `search-extract-2025-10-10`, `field-basis-2025-11-25`. Comma-separated when several | No. FindAll: "Requests no longer need the `parallel-beta: "findall-2025-09-15"` header ... still accepted for backwards compatibility but no longer changes behavior" (<https://docs.parallel.ai/findall-api/findall-migration-guide.md>). Per-element basis: "omit the legacy `parallel-beta: field-basis-2025-11-25` header" since 2026-08-24 (<https://docs.parallel.ai/task-api/guides/access-research-basis.md>). Today's pages for task SSE, webhooks and MCP tool calling show only `x-api-key`. Whether the three older values still change anything is UNCONFIRMED |
| `Accept: text/event-stream` | Shown in the docs example for `GET /v1/tasks/runs/{run_id}/events` | fixed | Whether the stream endpoints answer a client that sends `Accept: application/json` is UNCONFIRMED |
| `x-parallel-mcp-config` | Hosted MCP server only | JSON, see section 3.3 | Optional; needs a key |
| `x-parallel-search-config` | Legacy Search MCP only | JSON in Search API request shape | Optional; needs a key |

The gateway does not turn header parameters into tool arguments, so `parallel-beta` can only be sent as a fixed upstream header. If one is ever wanted, the config line is `headers = { "parallel-beta" = "<value>" }`.

## 3. Hosted MCP servers

### 3.1 Every URL

| URL | Status | Auth | Default tool list without a key (LIVE) |
| - | - | - | - |
| `https://mcp.parallel.ai/mcp` | Current server ("Parallel MCP 2.0", 2026-11-05). A trailing slash returns 404 | none, or key in `Authorization: Bearer <key>` or `x-api-key: <key>` | 7: `web_search`, `web_fetch`, `web_decisions`, `find_verticals`, `search_vertical`, `image_search`, `send_feedback` |
| `https://mcp.parallel.ai/mcp?login` | Same server, forces sign-in | OAuth; 401 with `WWW-Authenticate` when no credential | none |
| `https://mcp.parallel.ai/mcp/claude` | Path used by the vendor's Claude plugin (its `plugin.json`). Not in the docs pages | same as `/mcp` | 8: the 7 above plus `web_research` (listed, but it needs sign-in to run) |
| `https://mcp.parallel.ai/mcp/chatgpt` | Undocumented path, found by probing | same | 14: every tool in section 3.2, each tagged with the auth it needs |
| `https://mcp-aws.parallel.ai/mcp` | For the AWS Marketplace Search listing | key required (401 without) | not listable without a key |
| `https://search.parallel.ai/mcp` | Legacy Search MCP, still running | none or Bearer key | 3: `web_search`, `web_fetch`, `send_feedback` |
| `https://search.parallel.ai/mcp-oauth` | Legacy, sign-in required (401) | OAuth | not listable |
| `https://task-mcp.parallel.ai/mcp` | Legacy Task MCP, still running | OAuth or Bearer key (401 without) | not listable. DOCS: 4 tools, `createDeepResearch`, `createTaskGroup`, `getStatus`, `getResultMarkdown` |
| `https://search-mcp.parallel.ai/mcp` | Answers 401 "Unauthorized" to POST and 405 to GET. Not in today's docs. Purpose UNCONFIRMED | unknown | not listable |
| `https://docs.parallel.ai/mcp` | Documentation search only; calls no product API | none | 3: `search_parallel`, `query_docs_filesystem_parallel`, `submit_feedback` |

Sources: <https://docs.parallel.ai/integrations/mcp/quickstart.md>, <https://docs.parallel.ai/integrations/mcp/search-mcp.md>, <https://docs.parallel.ai/integrations/mcp/task-mcp.md>, <https://github.com/parallel-web/parallel-agent-skills> (`.claude-plugin/plugin.json`, `.mcp.json`).

### 3.2 Every tool on the current server

"Sign-in" comes from the per-tool `securitySchemes` the `/mcp/chatgpt` path publishes. "With key" is the DUMP.

| Tool | REST operation behind it | Default list, no key | Default list, with key | Runs without sign-in | `?tools=` name |
| - | - | - | - | - | - |
| `web_search` | `POST /v1/search`; MCP default `mode` is `fast` | yes | yes | yes | advertised |
| `web_fetch` | `POST /v1/extract` | yes | yes | yes | advertised |
| `web_research` | `POST /v1/responses` | no | yes | **no** | advertised |
| `web_decisions` | `POST /v1/decisions` | yes | yes | yes | advertised |
| `image_search` | `POST /v1/images/search` | yes, `fast` only | yes | `fast` only | advertised |
| `find_verticals` | **MCP-only.** Lists specialised sources with id, input schema and price per call | yes | yes | yes | advertised |
| `search_vertical` | **MCP-only** for PubMed, ClinicalTrials.gov, ChEMBL, CMS coverage, NPI Registry, bioRxiv and medRxiv. Places also has `POST /v1/places/search` | yes | yes | yes | advertised |
| `send_feedback` | **MCP-only.** Sends a problem report to the vendor | yes | **not in the DUMP** | yes | advertised |
| `flight_search` | `POST /v1/flights/search` | no | no | no | accepted, not advertised |
| `product_search` | `POST /v1/shopping/search` | no | no | no | accepted, not advertised |
| `web_monitor_create` | `POST /v1/monitors` (`query`, `frequency`, `processor` only; no webhook, no snapshot type) | no | no | no | `monitors` (group) or own name |
| `web_monitor_list` | `GET /v1/monitors` | no | no | no | same |
| `web_monitor_events` | `GET /v1/monitors/{monitor_id}/events` | no | no | no | same |
| `web_monitor_cancel` | `POST /v1/monitors/{monitor_id}/cancel` | no | no | no | same |

Legacy Task MCP tools map to `POST /v1/tasks/runs`, `POST /v1/tasks/groups` plus `.../runs`, and the run or group status and result routes; `getResultMarkdown` adds a markdown rendering that REST does not return.

No MCP tool exists for: hotels, direct places search, FindAll, Entity Search, task runs and groups (on the current server), Memory, monitor update, trigger, retrieve and stats, or anything in the Account API.

Argument differences with and without a key (LIVE vs DUMP): without a key `web_search`, `web_fetch` and `image_search` also take `client_model` and `session_id`. With a key those two arguments are absent.

MCP tool arguments compared with the REST body (DUMP vs SPEC):

| MCP tool | Arguments | REST fields it does not expose |
| - | - | - |
| `web_search` | `objective`, `search_queries` | `mode`, `max_chars_total`, `advanced_settings`, `client_model`, `session_id` |
| `web_fetch` | `urls`, `objective`, `search_queries`, `full_content`, `allow_live_fetch` | `max_chars_total`, the rest of `advanced_settings` |
| `web_research` | `input`, `reasoning_effort`, `previous_response_id` | `instructions`, `text`, `tools`, `data_sources`, `metadata`, `stream` |
| `web_decisions` | `state`, `questions`, `advanced_settings` | `mode` |
| `image_search` | `objective`, `search_queries`, `mode` | `advanced_settings` (location, max results) |

Every one of those hidden fields can be set, or handed to the model, through `x-parallel-mcp-config` (next section).

### 3.3 What changes the tool list or the defaults

| Control | Effect | Evidence |
| - | - | - |
| No credential | Free. 7 default tools. Search pinned to `fast`. No usage reported | LIVE, DOCS |
| `Authorization: Bearer <key>` or `x-api-key: <key>` | Adds `web_research` and `advanced` image mode; billed at API rates; each result carries `_meta["parallel/usage"]` with `name`, `count`, `cost_usd` per SKU | DOCS, DUMP |
| `?login` | Forces OAuth sign-in | DOCS, LIVE |
| `?tools=a,b` | Replaces the default list. Names the server's own 400 message advertises: `default`, `web_search`, `web_fetch`, `web_research`, `web_decisions`, `find_verticals`, `search_vertical`, `image_search`, `send_feedback`. Also accepted (HTTP 200 on `initialize`) though not advertised: `flight_search`, `product_search`, `monitors`, `web_monitor_create`, `web_monitor_list`. Rejected with 400: `hotel_search`, `place_search`, `verticals`, `all`. Without a key `?tools=web_research` lists zero tools and `?tools=default,monitors` lists only the default 7 | LIVE |
| `x-parallel-mcp-config: <JSON>` | Per tool: `override` (a JSON Merge Patch applied last to the API request, so the model cannot change it) and `model_choice` (dotted field paths exposed to the model as arguments). Needs a key; without one the server returns 401. Example value: `{"web_search":{"override":{"mode":"basic"},"model_choice":["advanced_settings.source_policy.include_domains"]}}` | DOCS |
| Other URL query parameters | Ignored by the current server ("ignores URL query parameters other than `login` and `tools`") | DOCS |
| Legacy Search MCP only | Any Search API field as a dotted query parameter, e.g. `?mode=fast&advanced_settings.location=gb`, or the `x-parallel-search-config` header. Authenticated connections only | DOCS |
| MCP events extension | A signed-in client can subscribe to `monitor.event.detected` for one `monitor_id` | DOCS (skill file) |

Free-tier limit, observed: about 25 `initialize` and list requests from one address in two and a half minutes produced HTTP 429 with body `{"jsonrpc":"2.0","error":{"code":-32000,"message":"You've hit the free-tier rate limit for Parallel MCP. ..."},"id":null}` and no `Retry-After` header. A retry three and a half minutes later succeeded, and seven more requests inside a minute tripped it again. The limit applies to the handshake too, not only to tool calls. Two observations; the numeric limit is unpublished.

## 4. Reachable only through SDKs, the CLI, plugins or skills

| Surface | What it adds beyond REST | Source |
| - | - | - |
| SDKs: Python `parallel-web`, TypeScript `parallel-web` | Nothing at the REST level. The Python SDK binds 34 endpoints, all in the public spec. It lacks the 7 newest: decisions, images, places, shopping, flights, hotels, monitor stats. `PARALLEL_BASE_URL` switches host | <https://github.com/parallel-web/parallel-sdk-python> (`api.md`, `.stats.yml`) |
| CLI `parallel-cli` (PyPI `parallel-web-tools`, npm `parallel-web-cli`, Homebrew, standalone binary) | Commands: `login`, `auth`, `search`, `extract`, `research run/status/poll/processors`, `enrich suggest/plan/run/status/poll/deploy`, `findall run/status/poll/result/cancel/entity-search`, `monitor create/list/get/update/cancel/events/trigger`, `memory retrieve/evict/clear`, `balance get/add`, `skills install`, `update`, `config` | <https://docs.parallel.ai/integrations/cli.md>, <https://github.com/parallel-web/parallel-web-tools> |
| CLI-only behaviour | `login` runs the device-flow OAuth and stores an OAuth credential, not an API key. `balance get` and `balance add` are the practical way to reach the Account API. `enrich run` reads and writes CSV, JSON, DuckDB or BigQuery and fans out over Task Groups. `enrich deploy --system bigquery` installs remote functions. `enrich plan` builds a YAML job | same |
| Data integrations | DuckDB, BigQuery, Spark, Polars, Snowflake, Supabase, Google Sheets `PARALLEL_QUERY`: wrappers over the Task API | <https://docs.parallel.ai/data-integrations/overview.md> |
| Agent skills (16) | `parallel-search-setup`, `parallel-mcp-setup`, `parallel-web-search`, `parallel-web-extract`, `parallel-api`, `parallel-search-evaluation`, `parallel-deep-research`, `parallel-data-enrichment`, `parallel-findall`, `parallel-monitor`, `parallel-web-monitor`, `parallel-memory`, `migrate-to-parallel`, `parallel-cli-setup`, `status`, `result`. Most run `parallel-cli`. Catalogue at <https://skills.parallel.ai> with `index.json` | <https://github.com/parallel-web/parallel-agent-skills> |
| Plugins | Claude Code plugin (MCP at `/mcp/claude`), Codex and Antigravity plugins (legacy `search.parallel.ai/mcp`), Cursor, OpenCode, Pi, OpenClaw | same; <https://docs.parallel.ai/integrations/claude-code-marketplace.md> |
| Resale routes | OpenRouter (Search and Decisions), LiteLLM, Vercel, AWS and Google Cloud marketplaces | <https://docs.parallel.ai/llms.txt> |

## 5. Against the gateway

How the gateway builds tools matters here (read from `src/gateway/openapi.ts` and `config.ts` on 2026-11-27): it reads path and query parameters and a JSON body; it does not read header parameters; it uses a base URL from a path-level or operation-level `servers` entry but **not** from a document-level one; it always sends `Accept: application/json`, reads the whole response as text and gives up after 5 minutes; one auth header per upstream; fixed extra headers via `headers`.

### 5.1 Not exposed, and how to add each

| Missing | How to add |
| - | - |
| `POST /v1beta/tasks/suggest`, `POST /v1beta/tasks/suggest-processor` | Config plus one small file. Write a local OpenAPI file with these two POST operations (JSON bodies: `user_intent` required, `previous_task`; `task_spec` required, `choose_processors_from`) and list it second: `spec = ["https://docs.parallel.ai/public-openapi.json", "<path to the file>"]` on `[gateway.upstreams.parallel]`. Same base URL and `x-api-key`. Tools appear as `parallel__post_v1beta_tasks_suggest` and `parallel__post_v1beta_tasks_suggest_processor` |
| MCP-only and hidden MCP tools: `send_feedback`, `flight_search`, `product_search`, `web_monitor_create`, `web_monitor_list`, `web_monitor_events`, `web_monitor_cancel` | Config only. On `[gateway.upstreams.parallelmcp]` set `url = "https://mcp.parallel.ai/mcp?tools=default,send_feedback,flight_search,product_search,monitors"`. The names are accepted by the server; the resulting list with a key is UNCONFIRMED because no key was used. Flights, shopping and monitors are already reachable through the `parallel` REST tools, so this matters only for `send_feedback` or an MCP-only setup |
| Different MCP defaults (search mode, domain filters, extra model-visible fields) | Config only. On `parallelmcp` add `headers = { "x-parallel-mcp-config" = '{"web_search":{"override":{"mode":"fast"}}}' }` |
| Legacy Task MCP (`createDeepResearch`, `createTaskGroup`, `getStatus`, `getResultMarkdown`) | Config only. New upstream, for example `[gateway.upstreams.paralleltask]` with `url = "https://task-mcp.parallel.ai/mcp"`, default Bearer auth, same keys. Duplicates the REST task tools except for the markdown result |
| Free, keyless access | Config only. `[gateway.upstreams.parallelfree]` with `kind = "mcp"`, `url = "https://mcp.parallel.ai/mcp"`, `auth = "none"`. 7 tools, `fast` mode, unpublished rate limit, vendor describes it as for personal use |
| EU endpoint | Config only, and only with an enterprise agreement. `[gateway.upstreams.paralleleu]` with `kind = "openapi"`, `url = "https://eu.parallel.ai"`, `spec = "https://docs.parallel.ai/public-openapi.json"`, `auth_name = "x-api-key"`, `auth_prefix = ""`, `include = ["post_v1_search", "post_v1_extract"]`. Search must be called with `mode = "basic"` |
| AWS endpoint | Config only, and only with a key bought through the AWS Search listing. Same block with `url = "https://api-aws.parallel.ai"` and `include = ["post_v1_search"]` |
| Account API (balance, top-up, usage, apps, keys): 10 operations | **Needs code.** It cannot be a second spec on `parallel`: the document sets its base URL only at document level, which the gateway ignores, and it needs a different credential. As its own upstream the connection details are `url = "https://api.parallel.ai/account"`, `spec = "https://api.parallel.ai/account/service/openapi.json"`, `auth_name = "Authorization"`, `auth_prefix = "Bearer "`. The blocker is the credential: an access token that expires in 10 minutes, renewed by a form-encoded `POST https://platform.parallel.ai/getServiceKeys/token` with `grant_type=refresh_token`, where each refresh returns a new refresh token that must be saved. A static key reference cannot do that. If built, start with `include = ["get_service_v1_balance", "get_service_v1_usage", "get_service_v1_apps"]`; `post_service_v1_balance_add` spends money and the key and app tools create or delete credentials |
| OAuth endpoints on `platform.parallel.ai` | Not addable as built: three of them take form-urlencoded bodies and the gateway sends JSON only |
| Payments gateway (`parallelmpp.dev`) | Not addable: every paid call needs a signed payment credential, not a header key |
| Legacy `/v1beta/search`, `/v1beta/extract`, `/v1alpha/monitors*` | Not worth adding; the v1 operations replace them |

### 5.2 Exposed today but will not work as built

| Tool (`parallel__...`) | Why | Change |
| - | - | - |
| `get_v1_tasks_runs_run_id_events` | Response is an SSE stream with no `timeout` parameter. The gateway waits for the stream to end and aborts at 5 minutes, so a longer run returns nothing | Exclude it, or teach the gateway to read SSE with a deadline and return the events received |
| `get_v1_tasks_groups_taskgroup_id_events` | SSE; "remain open for up to an hour" while any run is active | Same; if kept, callers must pass `timeout` under 300 |
| `get_v1beta_findall_runs_findall_id_events` | SSE; with no `timeout` it stays open as long as the run is going | Same |
| `get_v1_tasks_groups_taskgroup_id_runs` | The only way to list a group's runs, and its 200 response is declared as `text/event-stream`, not JSON. The agent receives raw `event:` and `data:` lines. Whether the stream closes after the last run is UNCONFIRMED | Keep, but parse SSE into a JSON array |
| `post_v1_responses` with `stream: true` | Returns SSE text. `background: true` is rejected with 422 | Tell agents not to set `stream`; or drop the field from the tool schema |
| `get_v1_tasks_runs_run_id_result` | Blocks until the run completes; server default `timeout` is 600 s, the gateway aborts at 300 s. `pro` and higher processors take minutes to hours | Callers pass `timeout` of 280 or less and retry on HTTP 408, or poll `get_v1_tasks_runs_run_id` |
| Any tool with a `webhook` field (task runs, monitors, FindAll) | Works, but the callback goes to a public URL; the gateway receives nothing | None; document it |
| The 12 tools whose operation declares `parallel-beta` | Nothing breaks: the header is optional and no longer needed | None |
| `post_v1_search` cost surprise | REST default `mode` is `advanced` ($5 per 1,000). `parallelmcp__web_search` defaults to `fast` ($1 per 1,000). Same vendor, five times the price by default | Have agents pass `mode`, or pin it on the MCP side with `x-parallel-mcp-config` |
| Polling after key failover | A run created with one key cannot be read with a key from another organization (already listed as a gateway limit) | None |

Tools that spend money or cannot be undone and deserve an `exclude` decision: `post_v1_monitors` (bills every run until cancelled), `post_v1_monitors_monitor_id_cancel` (irreversible), `post_v1beta_memory_clear`, `post_v1beta_findall_runs` with `generator = "pro"` ($10 plus $1 per match), `post_v1_tasks_runs` with `ultra8x` ($2.40 per run).

Cost capture: REST responses for search, extract and the vertical searches carry `usage: [{name, count}]` (SKU counts, no dollars). MCP results with a key carry `_meta["parallel/usage"]` with `cost_usd`. The gateway ledger currently records neither for Parallel.

Out-of-credit signal: HTTP 402 "Insufficient credit in account", which the gateway already treats as an exhausted key. A 402 can occur with a positive balance because running tasks reserve credit. HTTP 429 is described as "Rate limited or quota exceeded", so a hard quota can also arrive as 429, which the gateway passes through without skipping the key.

### 5.3 Parameters missing compared with the docs

| Where | Gap |
| - | - |
| `parallel` (REST) | None in path, query or body: 41 of 41 operations carry every field of the spec (checked by script). Only the optional `parallel-beta` header parameter is dropped |
| Spec weaker than docs | `processor` on `post_v1_tasks_runs` is a free string; the valid values `lite`, `base`, `core`, `core2x`, `pro`, `ultra`, `ultra2x`, `ultra4x`, `ultra8x` and their `-fast` variants are only in the docs. Decisions `mode` is a free string (docs: `fast`). Monitor `frequency` is a free string (`1h` to `30d`) |
| Spec ahead of docs | Monitor `processor` accepts `core` in the spec and in the MCP tool; the pricing page lists only `lite` and `base` |
| `parallelmcp` | Hidden REST fields listed in section 3.2. With a key, `client_model` and `session_id` are not available as arguments |

## 6. Tool families: purpose and price

Prices: <https://docs.parallel.ai/getting-started/pricing.md>. Per 1,000 unless stated.

| Family | Operations | What it is for | Price (USD) |
| - | - | - | - |
| Search | `POST /v1/search`; MCP `web_search` | Ranked pages with LLM-ready excerpts | `turbo`, `fast` $1; `basic`, `advanced` $5; +$1 per 1,000 results beyond 10 per request |
| Extract | `POST /v1/extract`; MCP `web_fetch` | Content or excerpts of up to 20 known URLs | $1 per 1,000 URLs |
| Decisions | `POST /v1/decisions`; MCP `web_decisions` | Typed answers (probability, choice, score) from web evidence; up to 100 questions | $1 |
| Images | `POST /v1/images/search`; MCP `image_search` | Image URLs with source page | `fast` $1, `advanced` $5 |
| Places | `POST /v1/places/search`; MCP `search_vertical` | Local businesses and points of interest | `fast` $1, `advanced` $5 |
| Shopping | `POST /v1/shopping/search`; MCP `product_search` | Products with store prices | $5 |
| Flights | `POST /v1/flights/search`; MCP `flight_search` | Itineraries and fares | $5 |
| Hotels | `POST /v1/hotels/search` | Hotels and rentals for a stay | $5 |
| Task runs | 5 operations under `/v1/tasks/runs` | Asynchronous research or enrichment with per-field citations | `lite` $5, `base` $10, `core` $25, `core2x` $50, `pro` $100, `ultra` $300, `ultra2x` $600, `ultra4x` $1,200, `ultra8x` $2,400 per 1,000 successful runs; failed runs free |
| Task groups | 6 operations under `/v1/tasks/groups` | Batches, up to 1,000 runs per POST | Task price per run |
| Ingest | 2 routes, not in the spec | Suggest a task spec or a processor | Not listed. UNCONFIRMED |
| Responses | `POST /v1/responses`; MCP `web_research` | Synchronous cited answer in OpenAI Responses format | `low` $10, `medium` $50, `high` $250 per 1,000 successful requests |
| Monitor | 8 operations; MCP `web_monitor_*` | Scheduled watch for changes | `lite` $3, `base` $10 per 1,000 executions; `core` not listed, UNCONFIRMED |
| FindAll | 9 run operations | Build a verified list of entities | `preview` $0.10 per run; `base` $0.25 + $0.03 per match; `core` $2 + $0.15; `pro` $10 + $1; enrichments at Task rates |
| Entity Search | `POST /v1beta/findall/entity-search` | Fast people and company lookup | $5 per 1,000 requests including 100 results; +$0.05 per 1,000 extra results |
| Memory | 3 operations under `/v1beta/memory` | Retrieve, evict or clear saved results of past runs | Not listed; rolling out. UNCONFIRMED |
| Verticals | MCP `find_verticals`, `search_vertical` | PubMed, ClinicalTrials.gov, ChEMBL, CMS, NPI, preprints, places | `find_verticals` returns a price per call; no public table. UNCONFIRMED |
| Feedback | MCP `send_feedback` | Report a problem to the vendor | Not stated; presumed free. UNCONFIRMED |
| Account API | 10 operations | Balance, top-up, usage by key, apps, keys | Free to call; `balance/add` charges the card |
| Payments gateway | 6 operations on `parallelmpp.dev` | Pay per call with no account | Search $0.01, extract $0.01 per URL, task $0.10 (`pro`) or $0.30 (`ultra`), responses $0.01, $0.05 or $0.25 |
| Keyless MCP | `https://mcp.parallel.ai/mcp` with no key | Search, fetch, decisions, images, verticals | Free, rate limited |

Default rate limits (DOCS, <https://docs.parallel.ai/getting-started/rate-limits.md>): Search, Extract, Decisions, Images and Entity Search 600 per minute; Places and Monitor 300 per minute; Shopping, Flights and Hotels 120 per minute; Tasks 2,000 per minute; FindAll 300 per hour. That page says only POSTs that create resources count; the task lifecycle page says the Task limit is "per API key" and "applies across all POST and GET requests". The two pages disagree.

## 7. Unconfirmed

- The tool list a key gets with `?tools=default,send_feedback,flight_search,product_search,monitors`.
- Whether `send_feedback` is really absent from the default list with a key, or was filtered when the dump was taken.
- Whether the SSE endpoints answer `Accept: application/json`, and whether `GET /v1/tasks/groups/{taskgroup_id}/runs` closes its stream by itself.
- Whether the three oldest `parallel-beta` values still change behaviour.
- Prices for Monitor `core`, Memory, Ingest and each vertical.
- Path and status of the old Chat API.
- What `search-mcp.parallel.ai` and `/mcp/chatgpt` are for, and whether other client-specific paths exist (`/mcp/codex`, `/mcp/cursor`, `/mcp/openai` return 404).
- The numeric free-tier MCP rate limit.

## 8. Corrections to `parallel.md`

| That note says | Checked today |
| - | - |
| Keyless MCP tools are six | Seven by default (it missed `send_feedback`), and seven more exist behind `?tools=` or sign-in |
| Monitor processors are `lite` or `base` | The spec and the MCP tool also accept `core` |
| `search-mcp.parallel.ai` does not appear in the docs | True, but the host answers (401) |
| Keyless over-limit error shape unconfirmed | Observed: HTTP 429, JSON-RPC error `-32000`, no `Retry-After` |
| Product surface table | Add: Memory API (3 operations), Ingest API (2 routes, outside the spec), payments gateway with its own spec, client-specific MCP paths, AWS hosts |

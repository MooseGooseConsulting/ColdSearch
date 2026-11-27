# Tavily: complete programmatic surface, pricing and gateway gaps (2026-11-27)

- **Date:** 2026-11-27. Read-only research. No API key was used and no paid endpoint was called.
- **How things were counted:** each spec document was downloaded with curl and its method + path pairs were enumerated by script. The hosted MCP tool list comes from `initialize` + `tools/list` sent with the documented keyless header; no tool was called.
- **Evidence labels:** SPEC = counted from a downloaded document. LIVE = observed on a vendor server today without a key. DOCS = vendor documentation. SOURCE = the vendor's public SDK, CLI or MCP source code. DUMP = the gateway's own tool dump taken with a key (`tavily`, `tavilymcp`). UNCONFIRMED = could not be verified.

Primary sources: <https://docs.tavily.com/llms.txt>, <https://docs.tavily.com/llms-full.txt>, <https://docs.tavily.com/documentation/api-reference/openapi.json>, <https://docs.tavily.com/documentation/enterprise/openapi.json>, <https://docs.tavily.com/documentation/api-credits.md>, <https://docs.tavily.com/documentation/mcp.md>, <https://www.tavily.com/pricing>, <https://github.com/tavily-ai/tavily-python>, <https://github.com/tavily-ai/tavily-mcp>, <https://github.com/tavily-ai/skills>.

## 0. Numbers at a glance

| Thing | Count | Evidence |
| - | - | - |
| Operations in the main API spec | 10 (8 POST, 2 GET) | SPEC |
| Of those, exposed by the gateway `tavily` upstream | 10 of 10, every path, query and body field present | SPEC vs DUMP, by script |
| Operations in the Enterprise key spec (different host) | 3, none in the gateway | SPEC |
| Operations in the x402 spec (different host, paid per call in USDC) | 1, not in the gateway | SPEC |
| Tools on the hosted MCP server | 5, identical with a key and with the keyless header | LIVE + DUMP |
| Tools only reachable through MCP | 0 on the hosted server | LIVE vs SPEC |
| Operations that need an extra header | 0 required. Keyless access needs `X-Tavily-Access-Mode: keyless` instead of a key | DOCS |
| Request fields the SDK and CLI send that the spec omits | 3 on search: `days`, `fetch_timeout`, `cache_fallback` | SOURCE |
| Streaming (SSE) operations the gateway lists as ordinary tools | 1 on request (`createResearch` with `stream: true`) | SPEC |

## 1. Published spec documents

| # | Document | Title, version | Base URL | Auth | Operations | In gateway |
| - | - | - | - | - | - | - |
| 1 | <https://docs.tavily.com/documentation/api-reference/openapi.json> | "Tavily Search and Extract API" 1.0.0, OpenAPI 3.0.3, 159,717 bytes | `https://api.tavily.com` | `Authorization: Bearer tvly-...`. A second scheme, `ownerBearerAuth`, applies to `/org-usage` | 10 | yes, all |
| 2 | <https://docs.tavily.com/documentation/enterprise/openapi.json> | "Tavily Enterprise API Key Generator" 1.0.0 | `https://api-key-generator.tavily.com` | same Bearer key | 3 | no |
| 2a | <https://api-key-generator.tavily.com/openapi.json> | The live service's own generated document, "Tavily API Key Generator" 1.0.0 | same | declares `authorization` as an optional header parameter | 5: the 3 above plus `GET /` and `GET /health` | no |
| 3 | <https://x402.tavily.com/openapi.json> | "Tavily" 1.0.0 | `https://x402.tavily.com` | none; an x402 payment per request | 1 (`POST /search`) | no |

Probed and absent: `https://api.tavily.com/openapi.json` (404), `https://docs.tavily.com/openapi.json` (404). Document 2 is not linked from `llms.txt`; it was found from the "OpenAPI" block on the Enterprise pages.

### 1.1 Main API: all 10 operations (SPEC)

Gateway tool names are prefixed `tavily__`. "Fields" counts path, query and body fields.

| # | Method | Path | Gateway tool | Fields | In gateway | Credits | Notes |
| - | - | - | - | - | - | - | - |
| 1 | POST | `/search` | `search` | 26 | yes | 1 credit (`basic`, `fast`, `ultra-fast`); 2 credits (`advanced`, or `auto_parameters` choosing it) |  |
| 2 | POST | `/extract` | `extract` | 10 | yes | 1 credit per 5 successful URLs (`basic`); 2 per 5 (`advanced`); failed URLs free |  |
| 3 | POST | `/crawl` | `crawl` | 17 | yes | map cost + extract cost, e.g. 10 pages basic = 3 credits |  |
| 4 | POST | `/map` | `map` | 12 | yes | 1 credit per 10 pages; 2 per 10 with `instructions` |  |
| 5 | POST | `/research` | `createResearch` | 9 | yes | `mini` 4 to 110 credits per request; `pro` 15 to 250 | returns 201 with `request_id`; **SSE when `stream: true`** |
| 6 | GET | `/research/{request_id}` | `getResearch` | 2 | yes | none stated (polling) | 202 while pending, 200 when completed or failed |
| 7 | POST | `/feedback` | `post_feedback` | 11 | yes | free (stated) | beta |
| 8 | GET | `/usage` | `getUsage` | 0 | yes | none stated; 10 requests per 10 minutes | optional header parameter `X-Project-ID` |
| 9 | POST | `/logs` | `post_logs` | 6 | yes | none stated; paid plan or pay-as-you-go required, else 403 |  |
| 10 | POST | `/org-usage` | `post_org_usage` | 5 | yes | none stated; Enterprise only | **different credential**: the organization owner's personal key |

### 1.2 Enterprise key API: all 3 operations (SPEC)

| Method | Path | Summary | Body fields | Name the gateway would give it |
| - | - | - | - | - |
| POST | `/generate-keys` | Generate API Keys | `permission_level`, `name`, `scope`, `key_type`, `key_limit`, `ttl_hours`, `count` | `post_generate_keys` |
| POST | `/deactivate-keys` | Deactivate API Keys | `request_id` | `post_deactivate_keys` |
| GET | `/key-info` | Get Key Info | none | `get_key_info` |

- Enterprise plan only. Source: <https://docs.tavily.com/documentation/enterprise/generate-keys.md>.
- `POST /generate-keys`: `permission_level` (`admin` or `user`, required), `key_type` (`development` or `production`), `key_limit` (credits per key, 1 to 100,000, default 200), `ttl_hours` (1 to 8,760, default 10), `count` (1 to 200). Returns the keys, `expires_at` and a `request_id`. The calling key must be in the Default workspace or the call is refused with 403.
- `POST /deactivate-keys`: pass `request_id` to deactivate a whole batch, or send no body to deactivate the key in the `Authorization` header.
- `GET /key-info`: name, created, expires_at, key_type, status of the key in the `Authorization` header.

### 1.3 x402 endpoint (SPEC + DOCS)

`POST https://x402.tavily.com/search` runs Advanced Search for $0.01 per call, paid in USDC on Base. An unpaid request gets HTTP 402 with a `PAYMENT-REQUIRED` header; the client retries with `PAYMENT-SIGNATURE`; the result carries `PAYMENT-RESPONSE`. `search_depth` is always `advanced`. Machine-readable price: `GET https://x402.tavily.com/.well-known/pricing`. Source: <https://docs.tavily.com/documentation/machine-payments/x402.md>.

### 1.4 Other hosts

| Host | What it is | Evidence |
| - | - | - |
| `api.eu.tavily.com`, `mcp.eu.tavily.com` | EU endpoint. Enabled per key for selected evaluation customers; not generally available. Search, Extract, Crawl, Map and Remote MCP; Research is not supported | <https://www.tavily.com/eu> |
| `mcp.tavily.com` | Hosted MCP server and its OAuth server (`/authorize`, `/token`, `/register`, `/revoke`) | LIVE (`/.well-known/oauth-authorization-server`) |
| `app.tavily.com` | Dashboard: keys, workspaces, limits, billing. No documented API | DOCS |

## 2. Headers, and things the spec leaves out

### 2.1 Headers

No beta or version header exists. `POST /feedback` is labelled beta but takes no special header.

| Header | Value | Effect | Evidence |
| - | - | - | - |
| `Authorization` | `Bearer tvly-<key>` | Required unless keyless | DOCS |
| `X-Tavily-Access-Mode` | `keyless` | Free, rate-limited `/search` and `/extract` with no key. If a valid key is also sent, the key wins. On the MCP server it replaces sign-in | <https://docs.tavily.com/documentation/keyless.md> |
| `X-Project-ID` | your project id | Tags the request with a project; filterable in `/logs`, `/org-usage` and the dashboard. The spec declares it only on `GET /usage`; the docs say any request accepts it | <https://docs.tavily.com/documentation/api-headers.md> |
| `X-Session-Id` | opaque id | Groups related requests; `/feedback` can refer to it | same |
| `X-Human-Id` | opaque id | Identifies the end user; hashed by the vendor | same |
| `X-Client-Source`, `X-Client-Name`, `X-Tavily-Orgid` | set by the SDK | Attribution headers the Python SDK sends (`client_source`, `client_name`, `org_id` or `TAVILY_ORG_ID`). Not in the docs; server effect UNCONFIRMED | SOURCE (`tavily/tavily.py`) |
| `DEFAULT_PARAMETERS` | JSON object, e.g. `{"include_images":true,"search_depth":"advanced","max_results":10}` | Hosted MCP only: default arguments for requests | <https://docs.tavily.com/documentation/mcp.md> |
| `PAYMENT-SIGNATURE` | signed transfer | x402 host only | DOCS |

### 2.2 Request fields outside the spec

The official Python SDK and the CLI send three `/search` body fields that the OpenAPI document does not define: `days` (lookback in days for news), `fetch_timeout` (seconds allowed for live fetching) and `cache_fallback` (allow cached content when a live fetch fails). `fetch_timeout` is also named in the server's 434 error text. Sources: SOURCE (`tavily/tavily.py`), <https://docs.tavily.com/documentation/tavily-cli.md> (`--days`, `--fetch-timeout`, `--cache-fallback`).

### 2.3 Endpoints outside the main spec

| Route | Where documented | Note |
| - | - | - |
| The 3 key-management routes | Spec 2, different host | Section 1.2 |
| `POST https://x402.tavily.com/search` | Spec 3 | Section 1.3 |
| Keyless `/search` and `/extract` | Same routes, header instead of key | Crawl, map and research need a key |
| A bonus-credits endpoint | Only inside the keyless over-limit error, as a `next_actions` entry of type `bonus_credits` with an `endpoint` to POST answers to | SOURCE (`tavily-mcp` `src/index.ts`). Path UNCONFIRMED |

## 3. Hosted MCP server

### 3.1 URLs and auth

| URL | Status | Evidence |
| - | - | - |
| `https://mcp.tavily.com/mcp/` | Current. Server reports `tavily-mcp` 4.2.4. `https://mcp.tavily.com/mcp` without the slash also works | LIVE |
| `https://mcp.eu.tavily.com` | EU, evaluation customers only. Path UNCONFIRMED | <https://www.tavily.com/eu> |
| `https://docs.tavily.com/mcp` | Documentation search only: `search_tavily_docs`, `query_docs_filesystem_tavily_docs`, `submit_feedback` | LIVE |

No legacy hosted URL was found in the docs.

| Auth mode | How | Evidence |
| - | - | - |
| OAuth | Connect to the bare URL. With no credential the server answers 401 and points at its OAuth metadata. The session uses the account's `mcp_auth_default` key, which is created if missing | LIVE, DOCS |
| Key in URL | `https://mcp.tavily.com/mcp/?tavilyApiKey=<key>` | DOCS |
| Key in header | `Authorization: Bearer <key>` | DOCS |
| Keyless | Header `X-Tavily-Access-Mode: keyless`, no key | DOCS, LIVE |

### 3.2 Tools

The list is the same 5 tools with the same arguments in the DUMP (with a key) and LIVE with the keyless header.

| Tool | REST operation | Arguments (LIVE) | MCP-only? |
| - | - | - | - |
| `tavily_search` | `POST /search` | 17: `query`, `max_results`, `search_depth`, `topic`, `time_range`, `include_images`, `include_image_descriptions`, `include_raw_content`, `include_domains`, `exclude_domains`, `country`, `include_favicon`, `start_date`, `end_date`, `exact_match`, `include_published_date`, `filter_by_published_date` | no |
| `tavily_extract` | `POST /extract` | 7: `urls`, `extract_depth`, `include_images`, `format`, `include_favicon`, `query`, `include_usage` | no |
| `tavily_crawl` | `POST /crawl` | 13: `url`, `max_depth`, `max_breadth`, `limit`, `instructions`, `select_paths`, `select_domains`, `allow_external`, `extract_depth`, `format`, `include_favicon`, `include_usage`, `chunks_per_source` | no |
| `tavily_map` | `POST /map` | 9: `url`, `max_depth`, `max_breadth`, `limit`, `instructions`, `select_paths`, `select_domains`, `allow_external`, `include_usage` | no |
| `tavily_research` | `POST /research`, then polling of `GET /research/{request_id}` inside the server, so the report comes back in one call (SOURCE for the local server; the hosted one is presumed the same). Tool text says 20 requests per minute | 3: `input`, `model` (`mini`, `pro`, `auto`), `files` (up to 5 base64 `.txt`, `.md` or `.json`) | no |

- With and without a key: the tool list does not change. The docs say keyless supports only search and extract; the other three are listed but need a key to run. Some doc pages spell the keyless tools `tavily-search` and `tavily-extract`; the live names use underscores.
- No hosted MCP tool exists for usage, logs, organization usage, feedback or key management.
- The open-source local server (`npx -y tavily-mcp@latest`, version 0.2.23 in the repository) has a sixth tool, `tavily_feedback` (`POST /feedback`). Its environment variables: `TAVILY_API_KEY`, `DEFAULT_PARAMETERS`, `TAVILY_HUMAN_ID`. With no key it runs keyless. SOURCE.

MCP arguments compared with the REST body (DUMP vs SPEC, by script):

| MCP tool | REST operation | Fields exposed | REST fields the MCP tool lacks | MCP-only arguments |
| - | - | - | - | - |
| `tavily_search` | `POST /search` | 17 of 26 | `auto_parameters`, `chunks_per_source`, `filter_by_language`, `include_answer`, `include_domains_mode`, `include_usage`, `language`, `max_age_hours`, `safe_search` | none |
| `tavily_extract` | `POST /extract` | 7 of 10 | `chunks_per_source`, `include_published_date`, `timeout` | none |
| `tavily_crawl` | `POST /crawl` | 13 of 17 | `exclude_domains`, `exclude_paths`, `include_images`, `timeout` | none |
| `tavily_map` | `POST /map` | 9 of 12 | `exclude_domains`, `exclude_paths`, `timeout` | none |
| `tavily_research` | `POST /research` | 3 of 9 | `citation_format`, `exclude_domains`, `include_domains`, `output_length`, `output_schema`, `stream` | none |

### 3.3 What changes the tool list or the defaults

| Control | Effect | Evidence |
| - | - | - |
| `DEFAULT_PARAMETERS` header | Sets default arguments. It does **not** change the tool list or the schemas (the lists with and without it were byte-identical). The docs say "for all requests"; the local server's README says it applies to the search tool. Which hosted tools honour it is UNCONFIRMED | LIVE, DOCS |
| `?tavilyApiKey=<key>` | Authenticates | DOCS |
| `?humanId=<id>` or `X-Human-Id` header | Forwarded to the API as `X-Human-Id` | DOCS |
| `X-Session-Id` | Generated by the server per MCP session; not settable | DOCS |
| `?tools=...` | Ignored; the list stays at 5 | LIVE |
| Dashboard "Search defaults" | Excluded domains, included domains, country and safe search can be pinned per organization, workspace or key. Levels replace each other, they do not merge | <https://docs.tavily.com/documentation/platform/managing-organizations.md> |

## 4. Reachable only through SDKs, the CLI, plugins or skills

| Surface | What it adds beyond REST | Source |
| - | - | - |
| Python SDK `tavily-python` | Methods `search`, `extract`, `crawl`, `map`, `research`, `get_research`, `feedback`, sync and async. SDK-only helpers: `get_search_context` and `qna_search` (client-side wrappers over `/search`), and `TavilyHybridClient` (hybrid retrieval over your MongoDB collection plus web search, reranked with Cohere). No method for usage, logs or keys. Runs keyless when no key is set | <https://github.com/tavily-ai/tavily-python>, <https://docs.tavily.com/sdk/python/reference.md> |
| JavaScript SDK `@tavily/core` | `search`, `extract`, `crawl`, `map`, `research`, `getResearch`, `feedback`, plus raw API access | <https://github.com/tavily-ai/tavily-js>, <https://docs.tavily.com/sdk/javascript/reference.md> |
| CLI `tvly` (npm `@tavily/cli`) | `init`, `login`, `auth`, `logout`, `search` (up to 5 queries in parallel), `extract`, `crawl` (`--output-dir` writes one file per page), `map`, `research` with `status` and `poll` (`--stream`, `--output-schema`, `--no-wait`), `setup mcp`, `set-default` and `unset-default`, `update`, an interactive mode. No usage or key command | <https://docs.tavily.com/documentation/tavily-cli.md>, <https://github.com/tavily-ai/tavily-cli> |
| CLI-only behaviour | `set-default` turns off the coding agent's built-in web tools; `setup mcp` writes the hosted MCP config for Claude Code, Codex and Cursor; search and extract work with no credential; exit code 3 covers auth failure, the keyless cap and plan limits | same |
| Agent skills (6) | `tavily-search` (search, extract, map, crawl), `tavily-research`, `tavily-entity`, `tavily-list`, `tavily-monitor`, `tavily-sdk`. They run the CLI. Optional workflows live in `tavily-ai/official-workflows` | <https://github.com/tavily-ai/skills>, <https://docs.tavily.com/documentation/agent-skills.md> |
| Plugins | Claude Code plugin, Cursor, Codex, Grok Build, OpenCode, Antigravity, Gemini CLI extension; a Claude connector for claude.ai | <https://docs.tavily.com/documentation/integrations/claude.md> |
| Company records | Not a separate endpoint: company data appears inside `/search` and `/extract` results at the same price | <https://docs.tavily.com/documentation/best-practices/company-data.md> |

## 5. Pricing, plans, usage, keys, errors

### 5.1 Plans (DOCS, <https://docs.tavily.com/documentation/api-credits.md>, <https://www.tavily.com/pricing>)

| Plan | Credits per month | Price | Per credit | Requests per minute |
| - | - | - | - | - |
| Researcher (free) | 1,000 | $0, no card | - | 100 |
| Pay as you go | per use | - | $0.008 | 1,000 |
| Project | 4,000 | $30 | $0.0075 | 1,000 |
| Bootstrap | 15,000 | $100 | $0.0067 | 1,000 |
| Startup | 38,000 | $220 | $0.0058 | 1,000 |
| Growth | 100,000 | $500 | $0.005 | 1,500 |
| Enterprise | custom | custom | custom | custom |

- Credits reset on the first day of each month. Pay as you go can also be switched on for a plan, so usage past the plan's credits is charged per credit.
- The rate-limit page also names a "Scale" plan at 1,500 per minute that the price table does not list.
- Rate limits are per organization (per user for personal accounts) since November 2026; every key in the account shares one limit. Lower fixed limits on every plan: `/crawl` 100, `/map` 100, `/research` 20 per minute; `/usage` 10 per 10 minutes. Source: <https://docs.tavily.com/documentation/rate-limits.md>.
- Out of free credits: "requests will stop until your credits reset or you upgrade" (pricing page).
- Keyless: free, with a separate unpublished cap.

### 5.2 Credits per operation

See the Credits column in section 1.1. Worked examples from the docs: crawling 10 pages costs 1 (map) + 2 (basic extract) = 3 credits, or 1 + 4 = 5 with advanced extraction. At the pay-as-you-go rate a basic search is $0.008 and an advanced search $0.016; a `pro` research request is $0.12 to $2.00.

### 5.3 Usage endpoints

| Call | Returns | Limits |
| - | - | - |
| `GET /usage` | `key`: `usage`, `limit` (null if unlimited), and per-endpoint `search_usage`, `extract_usage`, `crawl_usage`, `map_usage`, `research_usage`. `account`: `current_plan`, `plan_usage`, `plan_limit`, `paygo_usage`, `paygo_limit` and the same per-endpoint split | No plan restriction stated. 10 requests per 10 minutes. `X-Project-ID` narrows it to a project |
| `POST /logs` | Per-request rows: `timestamp`, `endpoint`, `depth`, `response_time`, `credits`, masked `api_key`, `request_id`. Filters: `limit` (1 to 10,000, default 10), `start_date`, `end_date`, `endpoints`, `project_id`, `filter_by_api_key`. Never includes inputs or outputs | Paid plan or pay-as-you-go; free accounts get 403 |
| `POST /org-usage` | Credits, pay-as-you-go dollars and request counts for every key in an organization. Body: `organization_name` (required), `start_date`, `end_date`, `project_id`, `depth` | Enterprise only, and only with the owner's personal key |
| In-band | `include_usage: true` on search, extract, crawl and map adds `usage: {"credits": n}` to the response; `GET /research/{request_id}?include_usage=true` does the same | Default is off, which is why the gateway ledger shows no Tavily cost |

### 5.4 Keys, workspaces, projects

- Keys are created and deleted in the dashboard. Key types `development` (`tvly-dev-...`) and `production`. A key can carry its own credit limit (`key.limit` in `/usage`).
- An organization holds the plan and billing. Workspaces sit inside it, each with its own keys, members and optional credit limit; more than one workspace is an Enterprise feature. Every request is checked against the workspace limit and the plan limit. Workspaces, limits and key moves are dashboard-only.
- Programmatic key creation, deactivation and lookup exist only in the Enterprise key API (section 1.2). There is no list-keys call.
- Projects are just the `X-Project-ID` header; there is no project CRUD API.
- All keys of one account draw on the same plan credits and the same rate limit, so several keys from one account add no quota. Keys from separate accounts do.

### 5.5 Error codes

| Status | Meaning | Body | What a gateway should do |
| - | - | - | - |
| 400 | Bad request | `{"detail":{"error":"..."}}` | Return to caller |
| 401 | Missing or invalid key | `{"detail":{"error":"Unauthorized: missing or invalid API key."}}` | Treat key as bad |
| 403 | Not allowed: URL not supported (crawl, map); free plan on `/logs`; wrong key on `/org-usage`; key outside the Default workspace on `/generate-keys` | varies | Return to caller |
| 422 | Validation failed | `{"detail":[{"type":...,"loc":[...],"msg":...}]}` | Return to caller |
| 429 | Rate limit | `{"detail":{"error":"Your request has been blocked due to excessive requests. ..."}}`, may carry `Retry-After` | Back off; do not sideline the key |
| **432** | Key limit or plan limit exceeded | `{"detail":{"error":"This request exceeds your plan's set usage limit. ..."}}` | **Exhausted: skip the key** |
| **433** | Pay-as-you-go limit exceeded | `{"detail":{"error":"This request exceeds the pay-as-you-go limit. You can increase your limit on the Tavily dashboard."}}` | **Exhausted: skip the key** |
| 434 | Flex tier capacity exceeded. Only on non-paying plans when `max_age_hours` is set, under load | `{"detail":{"error":"Live content fetching is temporarily unavailable on your plan due to high demand. ..."}}` | Transient: retry, or drop `max_age_hours`. Do not skip the key |
| 500, 504 | Server error; `/logs` and `/org-usage` can time out with 504 | - | Retry |
| Keyless cap | Different envelope: `{"error":{"code":"...","message":"...","window":...,"retry_after_seconds":...,"next_actions":[...]}}` with next actions of type `signup`, `agentic_payment` or `bonus_credits`. HTTP status UNCONFIRMED | SOURCE | Switch to a key |
| Via hosted MCP | An exhausted plan comes back as a successful tool result whose text is a small JSON error with `"status": 432` | `docs/components/gateway.md` (earlier live run; not re-tested today) | Already handled |

Sources: SPEC responses, <https://docs.tavily.com/documentation/rate-limits.md>.

## 6. Against the gateway

How the gateway builds tools matters here (read from `src/gateway/openapi.ts`, `config.ts` and `core.ts` on 2026-11-27): it reads path and query parameters and a JSON body; it does not read header parameters; it takes a base URL from a path-level or operation-level `servers` entry but **not** from a document-level one; it reads the whole response as text and gives up after 5 minutes; one auth header per upstream; fixed extra headers via `headers`. Both `openapi` and `mcp` upstreams send those fixed headers.

### 6.1 Not exposed, and how to add each

| Missing | How to add |
| - | - |
| Enterprise key API: `POST /generate-keys`, `POST /deactivate-keys`, `GET /key-info` | Config only, as its **own upstream**. It cannot be a second spec on `tavily`, because that document names its host only at document level, which the gateway ignores, so calls would go to `api.tavily.com`. Block: `[gateway.upstreams.tavilykeys]` with `kind = "openapi"`, `url = "https://api-key-generator.tavily.com"`, `spec = "https://docs.tavily.com/documentation/enterprise/openapi.json"`, default Bearer auth, and the keys. Tools: `tavilykeys__post_generate_keys`, `tavilykeys__post_deactivate_keys`, `tavilykeys__get_key_info`. Enterprise plan only. Start with `include = ["get_key_info"]`: called with no body, `post_deactivate_keys` deactivates the very key the gateway sent |
| Keyless free access | Config only. `[gateway.upstreams.tavilyfree]` with `kind = "openapi"`, `url = "https://api.tavily.com"`, `spec = "https://docs.tavily.com/documentation/api-reference/openapi.json"`, `auth = "none"`, `headers = { "X-Tavily-Access-Mode" = "keyless" }`, `include = ["search", "extract"]`. Rate limited; over the cap the body is the keyless envelope in section 5.5 |
| Project tagging for everything the gateway sends | Config only. On `[gateway.upstreams.tavily]` add `headers = { "X-Project-ID" = "<project id>" }`. Side effect: `getUsage` is then scoped to that project |
| MCP defaults | Config only. On `[gateway.upstreams.tavilymcp]` add `headers = { "DEFAULT_PARAMETERS" = '{"search_depth":"advanced","max_results":10}' }` |
| Search fields `days`, `fetch_timeout`, `cache_fallback` | They are absent from the vendor's spec, so absent from the tool schema. To show them, point the upstream at a local copy of the spec with the three fields added. A second document cannot patch the first: the gateway keeps the first definition of a method and path |
| EU endpoint | Config only once the vendor enables a key: same as `tavily` with `url = "https://api.eu.tavily.com"`, excluding `createResearch` and `getResearch` |
| `tavily_feedback` MCP tool | Only in the local npm server. Not needed: `tavily__post_feedback` already covers it |
| x402 search | Not addable: each call needs a signed on-chain payment |
| OAuth sign-in to the MCP server | Not usable by the gateway, which sends a static key. Use the Bearer key |

### 6.2 Exposed today but will not work as built

| Tool (`tavily__...`) | Why | Change |
| - | - | - |
| `createResearch` with `stream: true` | Returns an SSE stream of `chat.completion.chunk` events. The gateway waits for the stream to end, up to 5 minutes, then returns raw event text | Tell agents to leave `stream` off and poll `getResearch`, or drop the field from the tool schema |
| `post_org_usage` | Needs the organization owner's **personal** key, not the organization key the gateway holds, and an Enterprise plan. Otherwise 403 | Exclude it, or give it its own upstream holding that key |
| `post_logs` | 403 on the free plan | Exclude on free accounts |
| `getUsage` | Works, but only 10 calls per 10 minutes, it reports on whichever key the gateway is currently using, and the `X-Project-ID` header parameter is not available as an argument | Fine as is; consider calling it from `coldsearch_status` rather than leaving it to agents |
| HTTP 433 | The gateway's out-of-credit pattern in `src/gateway/core.ts` matches 402 and 432 but not 433, and the 433 message ("exceeds the pay-as-you-go limit") matches none of its phrases. A key at its pay-as-you-go cap is retried forever instead of skipped | **Code change:** add `\b433\b` to `QUOTA_PATTERN` |
| HTTP 434 | Not a credit problem. Today it is passed through, which is right | Keep it out of the quota pattern |
| Key failover inside one account | 432 for a plan limit applies to every key of the account, so moving to another key of the same account fails the same way. Only a per-key limit or a key from another account helps | None; document it |
| `tavilymcp__tavily_research` | Synchronous and long. The gateway's 10-minute call limit can cut off a `pro` run | Prefer `tavily__createResearch` plus `getResearch` |
| Cost in the ledger | Responses carry credits only when `include_usage` is true, and `tavily_search` on MCP has no such argument | Have agents pass `include_usage: true`. Injecting a default body field would need a gateway code change |

### 6.3 Parameters missing compared with the docs

| Where | Gap |
| - | - |
| `tavily` (REST) | None in path, query or body: 10 of 10 operations carry every field of the spec (checked by script). Dropped: the `X-Project-ID` header parameter on `getUsage`. Not settable per call: `X-Project-ID`, `X-Session-Id`, `X-Human-Id`. Absent because the spec omits them: `days`, `fetch_timeout`, `cache_fallback` on `search` |
| `tavilymcp` | The table in section 3.2. Largest gaps: search lacks `include_answer`, `chunks_per_source`, `max_age_hours`, `language`, `include_domains_mode`, `auto_parameters`, `safe_search`, `include_usage`; its `topic` enum has no `finance`. Research lacks `output_schema`, `citation_format`, `include_domains`, `exclude_domains`, `output_length`. Crawl and map lack `exclude_paths`, `exclude_domains`, `timeout` |

## 7. Tool families: purpose and price

Credit value: $0.008 pay as you go, $0.0075 to $0.005 on plans, 1,000 free per month.

| Family | Operations | What it is for | Price |
| - | - | - | - |
| Search | `POST /search`; MCP `tavily_search` | Ranked web results with content chunks, optional answer, images and raw content | 1 credit (`basic`, `fast`, `ultra-fast`); 2 credits (`advanced`) |
| Extract | `POST /extract`; MCP `tavily_extract` | Clean content of up to 20 known URLs | 1 credit per 5 successful URLs; 2 per 5 advanced |
| Map | `POST /map`; MCP `tavily_map` | List the URLs of a site | 1 credit per 10 pages; 2 per 10 with instructions |
| Crawl | `POST /crawl`; MCP `tavily_crawl` | Traverse a site and extract each page | Map cost plus extract cost |
| Research | `POST /research`, `GET /research/{request_id}`; MCP `tavily_research` | Multi-step research returning a cited report or structured output | `mini` 4 to 110 credits; `pro` 15 to 250 credits per request |
| Feedback | `POST /feedback` | Tell the vendor how useful results were | Free |
| Usage | `GET /usage` | Credits used and limits for the key and the account | None stated |
| Logs | `POST /logs` | Per-request credit log | None stated; paid accounts only |
| Organization usage | `POST /org-usage` | Usage across all keys of an organization | None stated; Enterprise |
| Key management | 3 routes on `api-key-generator.tavily.com` | Mint, deactivate and inspect keys | None stated; Enterprise |
| Keyless | `/search`, `/extract` with the keyless header | Try without an account | Free, capped |
| x402 search | `POST https://x402.tavily.com/search` | Advanced search paid per call with no account | $0.01 per call |

## 8. Unconfirmed

- Which hosted MCP tools honour `DEFAULT_PARAMETERS`.
- What the hosted MCP server returns when crawl, map or research is called keyless.
- The HTTP status of the keyless over-limit response, and the numeric keyless cap.
- Whether `days`, `fetch_timeout` and `cache_fallback` are still honoured by the API (they are sent by the current SDK).
- The server-side effect of `X-Client-Source`, `X-Client-Name` and `X-Tavily-Orgid`.
- The MCP path on `mcp.eu.tavily.com`, and when the EU endpoint becomes generally available.
- Whether polling `GET /research/{request_id}` and calling `/usage`, `/logs` or `/org-usage` consume credits (the docs state no cost).
- The "Scale" plan's price.

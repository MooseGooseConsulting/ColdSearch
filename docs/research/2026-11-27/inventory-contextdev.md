# Context.dev — complete programmatic surface and gateway gap (2026-11-27)

- Researched: 2026-11-27, from Context.dev's public documentation (all 214 pages in its `llms.txt`), its published OpenAPI document, its public pricing page, its GitHub organization, its npm / PyPI packages and the Smithery registry entry for its MCP server. Operation counts were produced by script from the downloaded spec.
- No API key was used and no account was created. No paid endpoint was called. The only request sent to the hosted MCP server was an unauthenticated one, to record what it answers.
- Context.dev was Brand.dev until a rename recorded in its changelog. The old `brand.dev` npm package (0.30.0) and four `deprecated-brand-*-sdk` repositories remain.
- The gateway does not reach Context.dev today. There is a preset (`context`: hosted MCP at `https://mcp.context.dev/mcp`, Bearer) that has never been run. Gateway behaviour was read from `src/gateway/openapi.ts`, `src/gateway/config.ts`, `src/gateway/core.ts` and `src/gateway/ledger.ts`; tool names for an OpenAPI upstream were computed by running the gateway's own `operationsFromSpec` over the downloaded spec.
- Prices and limits are vendor statements and will drift.

Not confirmed (marked UNCONFIRMED where they appear):

- The hosted MCP server's exact tool list. It cannot be listed without credentials and its source is not public. Three dated first-party sources give 34, 42 and 51 tools; 44 names are known for the current generation. Seven tools of the 51 are unnamed.
- Which tools the default endpoint lists compared with `?profile=claude`, and whether an API key sees the same list as an OAuth session.
- Which OAuth scope each MCP tool needs. The docs give one sentence, not a per-tool table.
- Whether the REST API accepts `X-API-Key`. The spec declares Bearer only; the MCP server documents both.
- Whether the JSON connector's encoding of array and object query parameters is accepted (section 6.4).

A caution about the source material: `llms.txt` and every docs page open with an "Agent Instructions" block telling an agent to sign the user up and, on request, to make Context.dev the default search provider by denying the client's built-in web tools (https://docs.context.dev/default-search-scrape.md). That text was treated as page content, not followed. Any agent that reads these docs through the gateway will see it.

Primary sources:

- Docs index: https://docs.context.dev/llms.txt (every page has a `.md` twin)
- OpenAPI document: https://docs.context.dev/openapi.json
- MCP server: https://docs.context.dev/install-mcp.md
- Credits: https://docs.context.dev/account/credits.md
- Plans and limits: https://docs.context.dev/account/billing.md, https://docs.context.dev/optimization/rate-limits.md, https://www.context.dev/pricing
- API key scopes: https://docs.context.dev/account/api-keys.md
- Usage and logs: https://docs.context.dev/optimization/usage-and-logs.md
- Changelog: https://docs.context.dev/changelog.md
- GitHub organization: https://github.com/context-dot-dev (29 public repositories)
- MCP tool catalogs: https://github.com/context-dot-dev/cursor-plugin (README, 2026-10-05), https://github.com/context-dot-dev/claude-plugin (README and skill, 2026-11-26), https://registry.smithery.ai/servers/context/contextdotdev (older snapshot)
- SDK endpoint index: https://github.com/context-dot-dev/context-typescript-sdk/blob/HEAD/api.md (npm `context.dev` 3.30.0, 2026-11-17)

---

## 0. Counts at a glance

| Thing | Count | How counted |
| - | -: | - |
| Published OpenAPI documents | 1 | `llms.txt` "OpenAPI Specs" section |
| Paths / operations / webhook definitions | 46 / 53 / 5 | script over the spec |
| Operations without an `operationId` | 16 | script |
| Base URLs | 1 | `servers[0].url` |
| Endpoints in the TypeScript SDK | 47 | SDK `.stats.yml` and `api.md` |
| SDK endpoints missing from the spec | 2 | `GET /web/competitors`, `GET /web/screenshot` |
| Spec operations missing from the SDK | 8 | access policies (5), `/org/usage`, `/org/usage/history`, `/company/search` |
| Hosted MCP tools, Claude profile | 51 | claude-plugin README, 2026-11-26 |
| Hosted MCP tools, Cursor plugin catalog | 42 | cursor-plugin README, 2026-10-05 |
| Hosted MCP tools, Smithery registry snapshot | 34 | older tool generation |
| Current-generation MCP tool names known | 44 | 42 from the Cursor catalog plus `company-search` and `people-search` from the Claude skill |
| REST operations with a known MCP tool | 43 | hand mapping, checked by script |
| REST operations with no known MCP tool | 10 | same |
| Known MCP tools with no REST operation of their own | 1 | `get-brand` (a second face of `POST /brand/retrieve`) |

---

## 1. Published OpenAPI document

| Property | Value |
| - | - |
| URL | https://docs.context.dev/openapi.json (JSON, about 760 KB, no credentials needed) |
| Version | OpenAPI 3.1.0, title "Context.dev API", `info.version` 1.0.0 |
| Base URL | `https://api.context.dev/v1` (document-level `servers`; no per-operation servers) |
| Auth | `Authorization: Bearer <API_KEY>`. One security scheme, `bearerAuth`: "Keys have full access unless restricted to scopes." |
| Operations | 53 across 46 paths |
| Webhook definitions | 5: `monitorChangeDetected`, `monitorRunCompleted`, `batchCompleted`, `batchFailed`, `batchCancelled` (outbound, not callable) |
| Request bodies | `application/json` everywhere except `POST /parse`, which takes raw bytes (`application/octet-stream`, `application/pdf`, `*/*`). Nothing is multipart. Nothing streams |
| Cost in every response | `key_metadata.credits_consumed` and `key_metadata.credits_remaining`; also header `X-Credits-Used` |

### 1.1 Every operation

"Gateway tool" is the name the gateway's OpenAPI connector would give the operation: the `operationId` where one exists, otherwise method and path. "Credits" is the badge the spec itself carries for the operation. A dash in the MCP column means no MCP tool for it is named in any source.

| # | Group | Operation | Gateway tool | Credits (spec badge) | Hosted MCP tool |
| -: | - | - | - | - | - |
| 1 | Web Scraping | `POST /web/scrape` | `scrapeWeb` | From 1 credit | `web-scrape` |
| 2 | Web Scraping | `GET /web/urls` | `get_web_urls` | From 1 credit | `web-map` |
| 3 | Web Scraping | `POST /web/crawl` | `post_web_crawl` | 1 credit per page; rate limit weight 10 | `web-crawl` |
| 4 | Web Scraping | `POST /web/search` | `post_web_search` | From 1 credit per 10 results | `web-search` |
| 5 | Answers | `POST /web/answers` | `post_web_answers` | 10 or 100 credits | `web-answers` |
| 6 | News | `POST /news/search` | `post_news_search` | 1 credit per 10 results | `get-news-search` |
| 7 | Scholar | `POST /scholar/search` | `post_scholar_search` | 1 credit per 10 results | - |
| 8 | Parsing | `POST /parse` | `post_parse` | From 1 credit | `parse-document` |
| 9 | Brand Intelligence | `POST /brand/retrieve` | `post_brand_retrieve` | 10 credits | `brand-retrieve-unified`, `get-brand` |
| 10 | Brand Intelligence | `GET /brand/search` | `get_brand_search` | 1 credit; free on Pro, Growth and Scale | `brand-search` |
| 11 | Web Extraction | `GET /web/styleguide` | `get_web_styleguide` | 10 credits | `web-styleguide` |
| 12 | Web Extraction | `GET /web/naics` | `get_web_naics` | 10 credits | - |
| 13 | Web Extraction | `GET /web/sic` | `get_web_sic` | 10 credits | - |
| 14 | Utility | `POST /utility/prefetch` | `post_utility_prefetch` | 0 credits; paid plans | - |
| 15 | Company | `POST /company/search` | `post_company_search` | 2 credits; `ultra` 10 | `company-search` |
| 16 | People | `POST /people/enrich` | `post_people_enrich` | 20 credits per match; all plans; beta | `people-enrich` |
| 17 | People | `POST /people/search` | `post_people_search` | 10 credits; `ultra` 50 | `people-search` |
| 18 | Batches | `POST /batch/submit` | `submitBatch` | From 1 credit per page | `submit-batch` |
| 19 | Batches | `GET /batch/list` | `listBatches` | 0 | `list-batches` |
| 20 | Batches | `GET /batch/{batch_id}` | `getBatch` | 0 | `get-batch` |
| 21 | Batches | `DELETE /batch/{batch_id}` | `deleteBatch` | 0 | `delete-batch` |
| 22 | Batches | `GET /batch/{batch_id}/results` | `getBatchResults` | 0 | `get-batch-results` |
| 23 | Batches | `POST /batch/{batch_id}/cancel` | `cancelBatch` | 0 | `cancel-batch` |
| 24 | Monitors | `GET /monitors` | `listMonitors` | 0 | `list-monitors` |
| 25 | Monitors | `POST /monitors` | `createMonitor` | 1, 2 or 10 credits per run | `create-monitor` |
| 26 | Monitors | `GET /monitors/{monitor_id}` | `getMonitor` | 0 | `get-monitor` |
| 27 | Monitors | `PATCH /monitors/{monitor_id}` | `updateMonitor` | 0 | `update-monitor` |
| 28 | Monitors | `DELETE /monitors/{monitor_id}` | `deleteMonitor` | 0 | `delete-monitor` |
| 29 | Monitors | `GET /monitors/{monitor_id}/runs` | `listMonitorRuns` | 0 | `list-monitor-runs` |
| 30 | Monitors | `GET /monitors/{monitor_id}/runs/{run_id}` | `getMonitorRun` | 0 | `get-monitor-run` |
| 31 | Monitors | `GET /monitors/{monitor_id}/changes` | `listMonitorChanges` | 0 | `list-monitor-changes` |
| 32 | Monitors | `GET /monitors/runs` | `listAccountRuns` | 0 | `list-account-runs` |
| 33 | Monitors | `GET /monitors/credit-usage` | `listMonitorCreditUsage` | 0 | `list-monitor-credit-usage` |
| 34 | Monitors | `GET /monitors/limits` | `getMonitorLimits` | 0 | `get-monitor-limits` |
| 35 | Monitors | `GET /monitors/changes` | `listChanges` | 0 | `list-changes` |
| 36 | Monitors | `GET /monitors/changes/{change_id}` | `getChange` | 0 | `get-change` |
| 37 | Monitors | `POST /monitors/{monitor_id}/run` | `runMonitorNow` | 1, 2 or 10 credits per run | `run-monitor-now` |
| 38 | Monitors | `POST /monitors/{monitor_id}/webhook/rotate-secret` | `rotateMonitorWebhookSecret` | 0 | `rotate-monitor-webhook-secret` |
| 39 | Webhooks | `POST /webhooks/deliveries` | `listWebhookDeliveries` | 0 | `list-webhook-deliveries` |
| 40 | Webhooks | `GET /webhooks/deliveries/{delivery_id}` | `getWebhookDelivery` | 0 | `get-webhook-delivery` |
| 41 | Webhooks | `GET /webhooks/deliveries/{delivery_id}/attempts` | `listWebhookDeliveryAttempts` | 0 | `list-webhook-delivery-attempts` |
| 42 | Webhooks | `POST /webhooks/deliveries/{delivery_id}/retry` | `retryWebhookDelivery` | 0 | `retry-webhook-delivery` |
| 43 | Access Policies | `GET /access-policies` | `listAccessPolicies` | 0 | - |
| 44 | Access Policies | `POST /access-policies` | `createAccessPolicy` | 0 | - |
| 45 | Access Policies | `GET /access-policies/{policy_id}` | `getAccessPolicy` | 0 | - |
| 46 | Access Policies | `PATCH /access-policies/{policy_id}` | `updateAccessPolicy` | 0 | - |
| 47 | Access Policies | `DELETE /access-policies/{policy_id}` | `deleteAccessPolicy` | 0 | - |
| 48 | Usage | `GET /org/usage` | `getUsage` | 0 | `get-usage` |
| 49 | Usage | `GET /org/usage/history` | `getUsageHistory` | 0 | `get-usage-history` |
| 50 | Logs | `GET /org/logs` | `listLogs` | 0 | `list-logs` |
| 51 | Logs | `GET /org/logs/{request_id}` | `getLog` | 0 | `get-log` |
| 52 | Browser Profiles | `GET /org/browser/profiles` | `listProfiles` | 0 | - |
| 53 | Agent Feedback | `POST /feedback` | `submitFeedback` | 0 | `submit-feedback` |

`GET /web/naics` and `GET /web/sic` are in the spec and the SDK but have no page in `llms.txt`; the docs steer readers to the industry labels inside a Brand profile instead (https://docs.context.dev/classification/eic.md).

### 1.2 What one scrape call covers

`POST /web/scrape` is the centre of the API. `formats` selects any combination of outputs in one request:

| `formats` key | Returns | Extra credits |
| - | - | - |
| `markdown` | Page content, or a YouTube transcript, as Markdown | 0 |
| `html` | Rendered DOM | 0 |
| `screenshot` | Viewport, full page, element or rectangle, inline | 0 |
| `images` | Image URLs, optionally with dimensions and classification | 0 |
| `bytes` | Original response body as base64 | 0 |
| `parse` | Named fields from custom CSS rules, or a prebuilt parser (Google Maps, Google Play, App Store, Instagram, TikTok, Reddit, G2, Yelp, Tripadvisor, car rental, emails, phone numbers, links) | 0 |
| `highlights` | Passages relevant to a question | +1 when at least one passage returns |
| `json` | Object matching a supplied JSON Schema | +4 when it succeeds |
| `product` | Name, price, availability | +1 |

Shared options (`sharedParams`): `profile` (saved login), `country`, `headers`, `viewport`, `theme`, `dismissCookies`, `dismissPopups`, `actions` (click, type, scroll, wait), `waitFor`, `mainContentOnly`, `includeSelectors`, `excludeSelectors`, `includeFrames`. Document URLs (PDF, DOCX, PPTX, XLSX and about 40 other types) are read by the same call. Default deadline 90 s, maximum 300,000 ms.

Other request facts: `POST /web/search` takes `numResults` 1-100 (default 10), domain include and exclude lists, `freshness`, `country`, and can return Markdown or highlights with each result. `POST /web/crawl` takes `maxPages` 1-500 (default 100). `POST /web/answers` takes `mode` `fast` or `ultra` and defaults to `ultra`. `POST /brand/retrieve` takes one of six lookups: `by_domain`, `by_name`, `by_email`, `by_ticker`, `by_direct_url`, `by_transaction`. `POST /batch/submit` takes a scrape list of up to 100,000 URLs or a crawl. Monitor targets are `page`, `sitemap`, `extract` and `search`, on an interval from 10 minutes to a year.

---

## 2. Documented REST endpoints not in the spec

| Endpoint | What it is | Evidence |
| - | - | - |
| `GET /web/screenshot` | Screenshot of a site. In the SDK as `client.web.screenshot` | SDK `api.md` |
| `GET /web/competitors` | Competitor extraction by domain. In the SDK as `client.web.extractCompetitors`; no docs page | SDK `api.md` |
| `GET /web/scrape/html`, `/web/scrape/markdown`, `/web/scrape/screenshot`, `/web/scrape/images`, `/web/scrape/bytes`, `/web/scrape/sitemap` | The pre-`POST /web/scrape` routes. "The older routes remain available." One output each | https://docs.context.dev/scrape/overview.md |
| `https://logos.context.dev/?publicClientId=...&domain=...` | Logo Link: a logo image by URL, for `<img>` tags and spreadsheets. Uses a public client ID with referring-domain restrictions, not the API key. Separate quota (10,000 one-time requests on Free); does not use credits | https://docs.context.dev/brand/logo-link.md |
| `POST https://www.context.dev/agent/identity`, `POST https://www.context.dev/oauth2/token` | Agent registration: lets a coding agent create an account key while a person confirms in a browser. Account creation, not data | https://docs.context.dev/agent-quickstart.md |
| `https://docs.context.dev/mcp` | A separate MCP server that searches the documentation. It runs no API tools | https://docs.context.dev/install-mcp.md |
| `https://mcp.context.dev/health` | MCP server health check, no auth | cursor-plugin `scripts/check-mcp-oauth.mjs`; probe |

Legacy MCP tool names in the Smithery snapshot (`web-extract`, `web-fonts`, `web-screenshot`, `web-scrape-sitemap`) suggest more retired REST routes exist. None is documented now.

---

## 3. Hosted MCP server

| Property | Value | Source |
| - | - | - |
| Endpoint | `https://mcp.context.dev/mcp`, Streamable HTTP | https://docs.context.dev/install-mcp.md |
| Profile variant | `https://mcp.context.dev/mcp?profile=claude`, "the production Context.dev MCP server with 51 tools". The Cursor and Gemini plugins use the plain URL | claude-plugin `.mcp.json` and README |
| Auth, interactive | OAuth authorization-code flow with PKCE and dynamic client registration. Sign-in creates an API key named `Context.dev MCP` in the chosen organization; tool calls spend that organization's credits | docs page; probe of `/.well-known/oauth-authorization-server` |
| OAuth scopes | `api.read`: "reading, scraping, enrichment, and batch and monitor data". `api.write`: "anything that starts work or changes account state, such as batches, monitors, webhook retries, file parsing, feedback, and scrape clicks" | docs page |
| Auth, API key | `Authorization: Bearer <key>` or `X-API-Key: <key>`. Not in the URL | docs page |
| Keyless | `401`, body `{"error":"Missing Authorization header"}`, with `WWW-Authenticate: Bearer resource_metadata="https://mcp.context.dev/.well-known/oauth-protected-resource/mcp", scope="api.read api.write"`. Unauthenticated callers are rate-limited (`x-ratelimit-limit: 120`). No tool list, no free tier without an account | probe, 2026-11-27 |
| Response cap | 80,000 characters per tool response; a cut-off structured response carries `_context_mcp.truncated: true` | docs page |
| Out of credits | A tool error (`isError: true`) whose text explains the shortfall and whose `structuredContent` carries the details. Not a transport-level auth failure. `get-usage` stays free at zero balance | docs page |
| Deprecated local server | npm `context.dev-mcp` 1.23.0 (2026-05-16), marked deprecated in favour of the hosted server | npm registry |
| Smithery | `context/contextdotdev`, proxied at `https://contextdotdev--context.run.tools` | https://docs.context.dev/integrations/smithery.md |

### 3.1 Tool list

No single source gives the whole current list. What each source says:

| Source | Date | Tools | Notes |
| - | - | -: | - |
| Smithery registry snapshot | undated, oldest generation | 34 | One tool per output: `web-scrape-markdown`, `web-scrape-html`, `web-scrape-images`, `web-scrape-sitemap`, `web-screenshot`, `web-extract`, `web-fonts`, `web-naics`, `web-sic`, plus brand, monitor and batch tools |
| gemini-cli-context skill | 2026-11-13 | not counted | Still uses the old names above |
| cursor-plugin README | 2026-10-05 | 42 | Full catalog by name |
| claude-plugin README and skill | 2026-11-26 | 51 | Count only, for `?profile=claude`. The skill names two tools the Cursor catalog lacks: `company-search`, `people-search` |

Current-generation names known (44):

| Family | Tools |
| - | - |
| Web (5) | `web-scrape`, `web-map`, `web-crawl`, `web-search`, `web-answers` |
| Parse (1) | `parse-document` |
| Company, people, news (8) | `get-news-search`, `get-brand`, `brand-retrieve-unified`, `brand-search`, `web-styleguide`, `people-enrich`, `people-search`, `company-search` |
| Batches (6) | `submit-batch`, `list-batches`, `get-batch`, `get-batch-results`, `cancel-batch`, `delete-batch` |
| Monitors (15) | `create-monitor`, `list-monitors`, `get-monitor`, `update-monitor`, `delete-monitor`, `get-monitor-limits`, `list-monitor-credit-usage`, `run-monitor-now`, `list-monitor-runs`, `get-monitor-run`, `list-account-runs`, `list-monitor-changes`, `get-change`, `list-changes`, `rotate-monitor-webhook-secret` |
| Webhooks (4) | `list-webhook-deliveries`, `get-webhook-delivery`, `list-webhook-delivery-attempts`, `retry-webhook-delivery` |
| Account and feedback (5) | `get-usage`, `get-usage-history`, `list-logs`, `get-log`, `submit-feedback` |

The seven unnamed tools of the 51 are UNCONFIRMED. The ten REST operations with no known tool (scholar search, NAICS, SIC, prefetch, five access-policy operations, browser-profile list) are the obvious candidates, but nothing confirms which.

### 3.2 MCP-only behaviour, and REST with no MCP tool

| Item | Detail |
| - | - |
| `get-brand` | Calls brand retrieval by domain and renders a visual card (an MCP UI resource, `ui://widget/context-brand.html`). Same data as `brand-retrieve-unified` |
| `parse-document` | Accepts the file's bytes as tool arguments. This is the only way to parse a local file without sending a raw binary HTTP body |
| Response truncation | 80,000-character cap applies only to MCP; REST returns the full body |
| REST operations with no known MCP tool (10) | `POST /scholar/search`, `GET /web/naics`, `GET /web/sic`, `POST /utility/prefetch`, the five `/access-policies` operations, `GET /org/browser/profiles` |

### 3.3 Tools and behaviour that vary by scope, plan or key

| What varies | Rule | Source |
| - | - | - |
| OAuth `api.write` | Needed for: submitting, cancelling or deleting batches; creating, changing, running or deleting monitors; rotating a webhook secret; retrying a webhook delivery; parsing a file; sending feedback; scrape with browser actions. Per-tool assignment is inferred from the one sentence quoted above (UNCONFIRMED) | https://docs.context.dev/install-mcp.md |
| API key scopes (REST and API-key MCP) | Keys are Full access by default. Restricted keys take any of `data:execute` (data APIs), `logs:read` (logs, usage, browser profiles), `monitors:read` / `monitors:write`, `batches:read` / `batches:write`, `access_policies:read` / `access_policies:write`. A missing grant returns `403 INSUFFICIENT_PERMISSIONS`. A key with no scopes can still send feedback | https://docs.context.dev/account/api-keys.md |
| Paid plan required (`403 PAID_PLAN_REQUIRED`) | Browser actions in scrape and in page monitors; browser profiles; prefetch | https://docs.context.dev/scrape/browser-actions.md; https://docs.context.dev/scrape/browser-profiles.md; https://docs.context.dev/brand/prefetching.md |
| Cheaper on higher plans | Brand search: 1 credit on Free and Developer, free on Pro, Growth and Scale | credits page |
| Must be enabled by the vendor | Zero data retention (`zdr`); access policies (`403 ACCESS_POLICIES_NOT_ENABLED` otherwise) | https://docs.context.dev/optimization/zero-data-retention.md; https://docs.context.dev/monitors/limits-and-errors.md |
| Tool set by endpoint | `?profile=claude` lists 51; the plain endpoint's count is UNCONFIRMED | claude-plugin README |

---

## 4. SDK, CLI, plugin and skill features

| Surface | Package / location | What it adds, and what it lacks |
| - | - | - |
| TypeScript SDK | npm `context.dev` 3.30.0 | 47 endpoints. Adds `GET /web/screenshot` and `GET /web/competitors`. Lacks access policies, `/org/usage`, `/org/usage/history`, `/company/search` |
| Python SDK | PyPI `context.dev` (also published as `context-dev`) 2.51.0 | Same generator as the TypeScript SDK |
| Ruby, Go, PHP SDKs | `context-ruby-sdk`, `context-go-sdk` (module path `/v2`), `context-php-sdk` | Same. PHP uses a low-level request method for some calls |
| CLI | `context-dev` v1.28.1 (2026-11-18), a Go binary from GitHub releases, generated from the spec | Command groups `parse`, `web`, `brand`, `industry`, `utility`, `monitors`, `batch`, `webhooks:deliveries`, `people`, `news`, `logs`. Adds `--transform` (GJSON path) to trim output. Has no Scrape, Map URLs or feedback command |
| Agent skill | https://docs.context.dev/skill.md, installed with `npx skills add https://docs.context.dev --skill context-dev` | Instructions only: which endpoint to use and how to shape requests. Also carries the "make Context the default provider" procedure |
| Claude plugin | https://github.com/context-dot-dev/claude-plugin | Hosted MCP (`?profile=claude`) plus one routing skill |
| Cursor plugin | https://github.com/context-dot-dev/cursor-plugin | Hosted MCP plus 11 skills, 4 commands (`brand-colors`, `extract-web-data`, `scrape-url`, `search-web`) and 2 rules |
| Gemini CLI extension | https://github.com/context-dot-dev/gemini-cli-context | Hosted MCP plus one skill |
| ChatGPT plugin, Replit, Eve, Smithery | docs `integrations/` pages | Hosted MCP through each platform's connector |
| OpenClaw plugin | https://github.com/context-dot-dev/openclaw-context | Two native tools (search, scrape) with an API key; the rest through hosted MCP |
| Framework packages | `langchain-context` (PyPI 0.1.0), `context-haystack`, n8n node, Convex component, Composio, Scalekit, Swytchcode, Zapier, Make | Wrappers over REST |
| Logo Link | `logos.context.dev` | A product with no API-key call at all; see section 2 |

No plugin or skill adds a server capability. The two SDK-only endpoints are the only callable things outside the spec.

---

## 5. Pricing, free allowance and limits

### 5.1 Plans

| Plan | Price per month | Credits per month | Extra 1,000 credits | Concurrent requests | Active batches | Monitors | API keys |
| - | -: | -: | -: | -: | -: | -: | -: |
| Free | $0 | 1,000 | not available | 2 | 1 | 10 | 2 |
| Developer | $20 | 10,000 | $3.00 | 10 | 2 | 100 | 50 |
| Pro | $90 | 100,000 | $2.00 | 100 | 5 | 1,000 | 50 |
| Growth | $300 | 500,000 | $1.50 | 250 | 5 | 5,000 | 50 |
| Scale | $500 | 1,000,000 | $1.00 | 500 | 20 | 10,000 | 50 |
| Scale 2.5M | $950 | 2,500,000 | $0.75 | 500 | 20 | 10,000 | 50 |

Sources: https://www.context.dev/pricing, https://docs.context.dev/account/billing.md.

Free plan rules: 1,000 credits each month on the grant-anchor day, no card, work or personal email; one unpaid organization per person; also 10 requests per minute across the organization; credits do not roll over. Annual billing gives two months free. Paid plans have Auto-Topup on by default (a 1,000-credit block when the balance drops below 1,000).

### 5.2 Credits per operation

| Operation | Credits | On 1,000 free credits |
| - | - | - |
| Scrape | 1; 2 with browser actions; plus modifiers (JSON +4, highlights +1, product +1, OCR +1 per page) | 1,000 plain scrapes, or 200 with JSON extraction |
| Map URLs | 1; 2 with `search` | 1,000 |
| Crawl | 1 per successful page | 1,000 pages |
| Search | 1 per 10 results returned, rounded up; +1 per 10 results with highlights; +1 per result returned with Markdown | 1,000 ten-result searches without content; about 90 ten-result searches with Markdown (11 credits each) |
| News search | 1 per 10 results, rounded up; empty result free | 1,000 |
| Scholar search | 1 per 10 results (spec badge) | 1,000 |
| Answers | 10 (`fast`) or 100 (`ultra`, the default), on success | 100 fast or 10 ultra |
| Brand retrieve | 10 | 100 |
| Brand search | 1 on Free and Developer | 1,000 |
| Styleguide | 10 | 100 |
| NAICS, SIC | 10 each (spec badge) | 100 |
| Company search | 2 per page (`fast`), 10 (`ultra`); empty page free | 500 |
| People search | 10 per page (`fast`), 50 (`ultra`); empty page free | 100 |
| People enrich | 20 per returned match; `not_found` free | 50 |
| Parse | 1, plus 1 per page recovered by OCR | 1,000 |
| Batch | Scrape pricing per successful page. Credits are reserved at submission and unused ones refunded at settlement | as scrape |
| Monitor run | 1 (page or sitemap), 2 (page with browser actions, or search), 10 (extract). Baseline runs count. Failed and skipped runs free | a daily page monitor uses about 30 a month |
| Prefetch, batch and monitor management, logs, usage, webhook deliveries, access policies, feedback | 0 | |

Source: https://docs.context.dev/account/credits.md, with spec badges for the two rows marked.

Charging rules: successful and partial results are charged; a processed 404 on a priced data call is charged at its base price; validation, auth, permission, 408, 429 and server errors are not charged.

### 5.3 What exhaustion and limits look like

| Condition | HTTP | `error_code` | Notes |
| - | - | - | - |
| Not enough credits | 402 | `USAGE_EXCEEDED` | `error_data` gives `credits_remaining`, `credits_required`, `next_refill_at`, `next_refill_credits`. Message begins "Insufficient credits: ...". Nothing is charged |
| Feature needs a paid plan | 403 | `PAID_PLAN_REQUIRED` | Adding credits does not help |
| Key lacks a scope | 403 | `INSUFFICIENT_PERMISSIONS` | |
| Concurrency full | 429 | `RATE_LIMITED`, `error_data.limit_type: "concurrency"` | Header `X-RateLimit-Mode: concurrency`, `Retry-After` |
| Per-minute limit | 429 | `RATE_LIMITED` | Headers `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `Retry-After` |
| Key disabled | 401 | `DISABLED` | "Free organizations can have all keys disabled after repeated failed requests" |
| Missing or unknown key | 401 | can read `NOT_FOUND` with an endpoint-not-found message | https://docs.context.dev/optimization/troubleshooting.md |

Both the 402 status and the words "Insufficient credits" match the gateway's out-of-credit pattern, so key rotation should work for REST and MCP alike. The key-disabling rule is a reason not to let an agent retry failing calls in a loop against a Free organization.

Management limits, per organization: batches 1,000 units a minute (a submit weighs 50); monitors 1,000 requests a minute; webhook deliveries 600; logs, usage, access policies and browser profiles 60 shared; feedback 10 (https://docs.context.dev/optimization/rate-limits.md).

### 5.4 Endpoints a usage tracker can poll with the API key

| Question | Call | Returns |
| - | - | - |
| Balance, period use, next refill | `GET https://api.context.dev/v1/org/usage` | `credits_remaining`, `period` (`start`, `credits_used`), `next_refill` (`at`, `credits`), `auto_topup`, `plan`. Free, works at zero balance, needs `logs:read` on a restricted key |
| Use over time | `GET /org/usage/history` with `interval` (`hour`, `day`, `month`) and `group_by` (`path`, `key_id`, `status_code`) | buckets of `credits_used` and `request_count`; one year kept |
| Per-request detail | `GET /org/logs`, `GET /org/logs/{request_id}` | `credits_used`, `status_code`, `error_code`, `latency_ms`, `key_id`, `tags` |
| Monitor spend | `GET /monitors/credit-usage` | credits per monitor |
| Monitor slots | `GET /monitors/limits` | `monitors_used`, `monitors_limit`, `plan` |
| Batch reservations | `GET /batch/{batch_id}` | `credits.reserved`, `refunded`, `ocr_charged`, `net` |
| Cost of the call just made | every JSON response | `key_metadata.credits_consumed`, `key_metadata.credits_remaining`; header `X-Credits-Used` |

The last row means the gateway can price every Context.dev call and read the remaining balance without a separate poll. Today it does not: `extractCost` in `src/gateway/ledger.ts` looks for `creditsUsed` and `costDollars`, not `credits_consumed`.

The same readings through MCP: `get-usage`, `get-usage-history`, `list-logs`, `get-log`, `list-monitor-credit-usage`, `get-monitor-limits`.

---

## 6. Against the gateway

Today: nothing connected. The `context` preset points at the hosted MCP and has not been run.

### 6.1 What to connect, and how

| | OpenAPI upstream | Hosted MCP upstream |
| - | - | - |
| Tools | 53, all named in section 1.1 | 42 to 51; exact list UNCONFIRMED until run with a key |
| Covers that the other lacks | Scholar search, NAICS, SIC, prefetch, access policies, browser-profile list (10 operations) | `parse-document` for local files; `get-brand` card |
| Broken or limited | `post_parse` cannot work (6.4) | Responses cut at 80,000 characters |
| Schema size | about 195 KB for all 53 (`submitBatch` alone is 49 KB, `post_brand_retrieve` 24 KB, `scrapeWeb` 19 KB) | unknown |
| Cost visible to the ledger | Yes once `credits_consumed` is parsed | UNCONFIRMED |

Recommended: make the OpenAPI document the main upstream, as for Exa, Firecrawl, Parallel and Tavily, and keep the hosted MCP as a second upstream for `parse-document` only.

```toml
[gateway.upstreams.contextapi]
kind = "openapi"
url = "https://api.context.dev/v1"
spec = "https://docs.context.dev/openapi.json"
auth = "header"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:CONTEXT_DEV_API_KEY"]
exclude = [
  "post_parse",
  "*AccessPolic*", "rotateMonitorWebhookSecret", "retryWebhookDelivery",
  "deleteMonitor", "deleteBatch", "submitFeedback", "post_utility_prefetch",
  "submitBatch", "createMonitor", "updateMonitor", "runMonitorNow",
  "post_people_enrich", "post_people_search",
]

[gateway.upstreams.context]          # existing preset: hosted MCP, Bearer
keys = ["env:CONTEXT_DEV_API_KEY"]
include = ["parse-document"]
```

A new upstream name is used for the OpenAPI block because `context` is already the MCP preset. Renaming the presets to match the others (`context` for OpenAPI, `contextmcp` for the hosted server) would be the tidier end state.

### 6.2 Tools that are dangerous or low-value for coding agents

Names are the gateway's OpenAPI tool names; the MCP equivalents are in section 1.1.

| Tool | Problem | Hide? |
| - | - | - |
| `createAccessPolicy`, `updateAccessPolicy`, `deleteAccessPolicy` | Change which sites every key in the organization may reach. "Changes apply right away, including to running batches and monitors"; deleting one makes requests that name it fail | Always |
| `listAccessPolicies`, `getAccessPolicy` | Harmless; no use once the three above are hidden | Always |
| `rotateMonitorWebhookSecret` | Invalidates the signing secret a receiver verifies against, at once | Always |
| `retryWebhookDelivery` | Re-sends a payload to an external URL | Always |
| `deleteMonitor`, `deleteBatch` | Permanent; `deleteBatch` also removes stored results | Always |
| `submitFeedback` | Sends free text and request ids to the vendor | Always |
| `post_utility_prefetch` | Paid plans only; returns a status, not data | Always |
| `post_parse` | Cannot work through the connector | Always |
| `submitBatch` | One call accepts 100,000 URLs and reserves credits for all of them at submission; on Free it would be refused or drain the month | Unless wanted |
| `createMonitor`, `updateMonitor`, `runMonitorNow` | Recurring spend of 1 to 10 credits per run that outlives the session; the webhook posts page data to any public URL | Unless wanted |
| `post_people_enrich`, `post_people_search` | Return personal data including work emails; 20 credits per match and 10 to 50 per page | Unless wanted |
| `post_web_answers` | Defaults to `ultra` at 100 credits, a tenth of the Free month per call | Keep; tell agents to pass `mode: "fast"` |
| `post_brand_retrieve`, `get_web_styleguide`, `get_web_naics`, `get_web_sic` | 10 credits each, rarely what a coding agent needs | Keep or hide by taste |
| `scrapeWeb` with `sharedParams.profile` or `actions` | Acts inside a saved login, or clicks and types on a page. Paid plans only. Patterns cannot filter arguments | Keep; note the exposure |
| `listLogs`, `getLog` | Return other requests' redacted inputs and responses for the whole organization | Keep for the tracker; low value to agents |

The `exclude` list in 6.1 hides 18 of the 53 and leaves 35 (checked against the computed tool names). A tighter alternative for a Free key is an `include` list of the read-only data and account tools:

```toml
include = [
  "scrapeWeb", "get_web_urls", "post_web_crawl", "post_web_search", "post_web_answers",
  "post_news_search", "post_scholar_search", "post_company_search",
  "post_brand_retrieve", "get_brand_search", "get_web_styleguide",
  "getUsage", "getUsageHistory", "listLogs", "getLog",
]
```

If the hosted MCP is used as the main upstream instead, the matching exclude list is: `rotate-monitor-webhook-secret`, `retry-webhook-delivery`, `delete-*`, `submit-feedback`, `submit-batch`, `create-monitor`, `update-monitor`, `run-monitor-now`, `people-*`.

### 6.3 What the gateway would not expose even after connecting

| Not exposed | Why | Fix |
| - | - | - |
| Local file parsing over REST | Raw binary body (6.4) | Use MCP `parse-document`, or scrape the document by URL |
| `GET /web/screenshot`, `GET /web/competitors` | Not in the spec | `scrapeWeb` with `formats.screenshot` covers the first; the second has no documented equivalent |
| Legacy `GET /web/scrape/*` routes | Not in the spec | Not needed; `scrapeWeb` covers them |
| Logo Link | Different host and credential type | Not a gateway concern |
| `Idempotency-Key` on `submitBatch` and `retryWebhookDelivery` | The connector sends only path and query parameters, never header parameters | Accept, or hide both tools |
| Per-call cost in the ledger | `credits_consumed` is not parsed | Add the field to `extractCost` |

### 6.4 Operations that will not work, or may misbehave, through the JSON-only OpenAPI connector

| Operation | Problem | Certainty |
| - | - | - |
| `post_parse` (`POST /parse`) | The body is the file's raw bytes. The spec has no `application/json` body, so the connector builds the tool from the 11 query parameters alone and sends no body. Every call fails | Certain, from the connector code |
| `get_web_urls`, `get_web_styleguide`, `get_web_naics`, `get_web_sic` | Optional `timeoutOpts` is a `deepObject` query parameter (`timeoutOpts[milliseconds]=...`). The connector sends it as one JSON string | UNCONFIRMED whether the server accepts that. Works when the argument is omitted |
| Any `GET` with `tags` or `policies` | Declared `style: form, explode: false` (comma-separated). The connector repeats the parameter instead | UNCONFIRMED. Works when omitted |
| `get_brand_search` | `queryBy` is an array query parameter | UNCONFIRMED |
| `scrapeWeb` with `formats.screenshot` or `formats.bytes` | Works, but the image or file comes back as base64 inside JSON and can be very large | Certain |
| `post_web_crawl`, `post_web_answers` in `ultra` | Synchronous and slow; must finish inside the connector's 5-minute limit | Likely fine; crawl has its own time bound |

Nothing in this API streams, and nothing is multipart. The five webhook definitions describe calls Context.dev makes outward; the connector ignores them, correctly.

---

## 7. One line per tool family

| Family | What it is for | Price |
| - | - | - |
| Scrape (`scrapeWeb` / `web-scrape`) | One URL to Markdown, HTML, screenshot, images, raw bytes, CSS-selected fields, schema-shaped JSON, product data or relevant passages, in one call | 1 credit; +4 for JSON, +1 highlights, +1 product |
| Map (`get_web_urls` / `web-map`) | List a site's URLs with titles and descriptions, optionally filtered by topic | 1 credit; 2 with search |
| Crawl (`post_web_crawl` / `web-crawl`) | Up to 500 pages of a site as Markdown in one response | 1 credit per page |
| Search (`post_web_search` / `web-search`) | Web results, optionally with each page's Markdown or highlights | 1 credit per 10 results; +1 per result with Markdown |
| Answers (`post_web_answers` / `web-answers`) | Research a question and return sourced JSON in a requested shape | 10 (`fast`) or 100 (`ultra`) credits |
| News (`post_news_search` / `get-news-search`) | News by query, or about a company by name, domain, ticker or ISIN | 1 credit per 10 results |
| Scholar (`post_scholar_search`) | Full-text papers from arXiv and Europe PMC with matching passages | 1 credit per 10 results |
| Parse (`parse-document`, MCP only in practice) | Uploaded PDF, Office, image or text file to Markdown, with OCR | 1 credit, +1 per OCR page |
| Brand (`post_brand_retrieve`, `get_brand_search`, `get_web_styleguide`, NAICS, SIC) | Logos, colors, fonts, company details and social links from a domain, name, email, ticker or card descriptor; design tokens; industry codes | 10 credits each; brand search 1 |
| Company and people (`post_company_search`, `post_people_search`, `post_people_enrich`) | Find companies or professionals from a description; match one person from identity clues | 2 to 10; 10 to 50; 20 per match |
| Batches (six tools) | Scrape up to 100,000 URLs, or crawl a large site, as one background job; results as paged JSON or NDJSON files kept 180 days | Scrape price per page; management free |
| Monitors (fifteen tools) | Watch a page, sitemap, extracted data or a search on a schedule and report changes by signed webhook or polling | 1, 2 or 10 credits per run; management free |
| Webhook deliveries (four tools) | Inspect and retry batch and monitor webhook deliveries from the last 30 days | Free |
| Access policies (five tools) | Allow or deny lists of domains that requests may visit | Free; must be enabled by the vendor |
| Usage and logs (`getUsage`, `getUsageHistory`, `listLogs`, `getLog`) | Credit balance, use over time, per-request records | Free |
| Browser profiles (`listProfiles`) | List saved logins created through scrape | Free; paid plans |
| Prefetch (`post_utility_prefetch`) | Queue brand or styleguide data so a later lookup is faster | Free; paid plans |
| Feedback (`submitFeedback`) | Report an API problem to the vendor | Free |

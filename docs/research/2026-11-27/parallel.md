# Parallel — product surface, billing, and key metering (2026-11-27)

- **Date researched:** 2026-11-27.
- **Nature:** dated evidence snapshot taken from the vendor's own docs, pricing, terms, and blog (vendor claims are labelled as such), plus a few third-party benchmark pages (source type labelled). Nothing here was tested against a live account.
- **Not confirmed:** exact keyless-MCP rate limits; whether rate limits are per key or per organization; 429 response headers; whether overage past free credit auto-charges the card or returns 402; whether one person may hold several organizations; launch dates for Places / Shopping / Flights / Hotels / Entity Search / Snapshot / Memory; signup-credit conditions. Each is marked UNCONFIRMED where it appears.

Primary entry points: <https://docs.parallel.ai/llms.txt>, <https://docs.parallel.ai/llms-full.txt>, <https://docs.parallel.ai/resources/changelog.md>, <https://parallel.ai/pricing>, <https://docs.parallel.ai/getting-started/pricing.md>.

---

## 1. Product surface

Base URL `https://api.parallel.ai`. Product APIs authenticate with the `x-api-key` header; the migration guide states that a request using another auth header returns 401 (<https://docs.parallel.ai/search/migrate-to-parallel.md>). The MCP server additionally accepts `Authorization: Bearer` (<https://docs.parallel.ai/integrations/mcp/quickstart.md>).

SDKs: Python `parallel-web` (PyPI), TypeScript `parallel-web` (npm) (<https://docs.parallel.ai/llms.txt>).

### 1.1 API-by-API table

Prices and timings: <https://docs.parallel.ai/getting-started/pricing.md>. Rate limits: <https://docs.parallel.ai/getting-started/rate-limits.md>. Maturity: changelog and per-page notices as cited.

| API | Endpoint | Sync? | Price (USD) | Default rate limit | Maturity |
| - | - | - | - | - | - |
| Search | `POST /v1/search` | Sync, 200 ms–3 s | `turbo`/`fast` $1 per 1k requests; `basic`/`advanced` $5 per 1k; 10 results included, +$1 per 1k extra results | 600/min | GA. v1 endpoints GA 2026-04-22 (<https://parallel.ai/blog/parallel-search-api>); original GA 2025-11-06 (changelog) |
| Extract | `POST /v1/extract` | Sync, 1–20 s | $1 per 1k URLs | 600/min | GA on v1 as of 2026-04-22 (same blog); beta 2025-11-20 (changelog) |
| Decisions | `POST /v1/decisions` | Sync, 200 ms–1 s | $1 per 1k requests (`fast`), up to 100 questions per request | 600/min | Launched 2026-10-26 (changelog); MCP docs call `web_decisions` "an early release" |
| Images | `POST /v1/images/search` | Sync, 1–3 s | `fast` $1 per 1k; `advanced` $5 per 1k; up to 20 results | 600/min | Launched 2026-11-16 (changelog) |
| Places | `POST /v1/places/search` | Sync, 1–5 s | `fast` $1 per 1k; `advanced` $5 per 1k; up to 20 results | 300/min | Documented; launch date UNCONFIRMED (not in changelog) |
| Shopping | `POST /v1/shopping/search` | Sync, 3–4 s | $5 per 1k; up to 40 results | 120/min | Documented; launch date UNCONFIRMED |
| Flights | `POST /v1/flights/search` | Sync, 1–20 s | $5 per 1k; up to 20 results | 120/min | Documented; launch date UNCONFIRMED |
| Hotels | `POST /v1/hotels/search` | Sync, 2–4 s | $5 per 1k; up to 40 results | 120/min | Documented; launch date UNCONFIRMED |
| Task | `POST /v1/tasks/runs` (+ `GET .../{run_id}`, `.../result`, `.../events`) | Async, 10 s–2 hr | $5–$2,400 per 1k successful runs by processor (table below) | 2,000/min (run creations) | GA |
| Task Group | `POST /v1/tasks/groups`, `POST .../{id}/runs` (up to 1,000 runs per POST), `GET .../events` (SSE) | Async | Task pricing per run | Shares Task quota; each input counts | Documented under `/v1` (<https://docs.parallel.ai/task-api/group-api.md>) |
| Responses | `POST /v1/responses` | Sync, 5–60 s (streaming supported) | `low` $10, `medium` $50 (default), `high` $250 per 1k successful requests | Not listed on rate-limit page (UNCONFIRMED) | Launched 2026-07-21 (changelog) |
| Monitor | `POST /v1/monitors` etc. | Async / scheduled | `lite` $3, `base` $10 per 1k executions | 300/min | GA 2026-05-06 (changelog); alpha 2025-11-13 |
| FindAll | `POST /v1beta/findall/runs` etc. | Async, 10 s–2 hr | `preview` $0.10 + $0/match; `base` $0.25 + $0.03; `core` $2 + $0.15; `pro` $10 + $1; enrichments billed at Task rates | 300/hour | **Public beta**, 30 days notice before breaking changes (<https://docs.parallel.ai/findall-api/findall-quickstart.md>) |
| Entity Search | `POST /v1beta/findall/entity-search` | Sync, 1–3 s | $5 per 1k requests incl. 100 results; +$0.05 per 1k extra results | 600/min | **Public beta**, part of FindAll (<https://docs.parallel.ai/findall-api/entity-search.md>) |

Rate-limit notes (<https://docs.parallel.ai/getting-started/rate-limits.md>, <https://docs.parallel.ai/resources/warnings-and-errors.md>):
- Limits apply to POST requests that create resources; GET polling does not count.
- Enforced over a **rolling 60-second window**, not per clock minute.
- Plan differences (<https://parallel.ai/pricing>): Build = Search/Extract 600/min; Scale = 1,500/min (Scale limit excludes Turbo-mode Search); Decisions 600/min and Task 2,000/min on both; Enterprise custom; keyless "Launch" tier = "Variable limits, enough for personal use".
- Whether limits are counted per API key or per organization is UNCONFIRMED (not stated).

### 1.2 Search API

Sources: <https://docs.parallel.ai/search/search-quickstart.md>, <https://docs.parallel.ai/search/best-practices.md>, <https://docs.parallel.ai/search/modes.md>, <https://docs.parallel.ai/search/advanced-search-settings.md>.

Request fields:

| Field | Notes |
| - | - |
| `search_queries` (string[]) | **Required.** 1–5 keyword queries, 3–6 words each, max 200 chars each. Queries past the fifth are dropped with a warning. |
| `objective` (string) | Optional natural-language goal, max 5,000 chars. Sending only `objective` returns 422. |
| `mode` | `turbo` (~200 ms), `fast` (~700 ms), `basic` (~1 s), `advanced` (~3 s). **Defaults to `advanced`** when omitted. |
| `max_chars_total` (int) | Cap on total excerpt characters; default is dynamic. |
| `client_model` (string) | Name of the consuming model; used to tune output. |
| `session_id` (string) | Groups related Search and Extract calls for one task. |
| `advanced_settings.max_results` | Default 10, capped at 20. |
| `advanced_settings.source_policy` | `include_domains`, `exclude_domains`, `after_date` (YYYY-MM-DD). Path prefixes unsupported in `turbo`. Unknown keys return 422 since 2026-11-23 (changelog). |
| `advanced_settings.fetch_policy` | e.g. `{"max_age_seconds": 3600}` (minimum 600). Without it Search answers from the index only and does not fetch live. |
| `advanced_settings.location` | ISO 3166-1 alpha-2 code from a fixed list of ~37 countries. |

Mode notes: Turbo supports English and Japanese queries only; the EU endpoint `https://eu.parallel.ai` supports only `basic` and is available on enterprise agreements (<https://docs.parallel.ai/search/modes.md>, changelog 2026-10-19).

Minimal request:

```json
{
  "objective": "Find the airlines that currently fly nonstop between Seattle and Tokyo.",
  "search_queries": ["Seattle Tokyo nonstop flights", "Seattle Haneda Narita airlines"],
  "mode": "fast"
}
```

Response shape:

```json
{
  "search_id": "search_...",
  "results": [
    { "url": "...", "title": "...", "publish_date": "YYYY-MM-DD or null", "excerpts": ["markdown excerpt", "..."] }
  ],
  "warnings": null,
  "usage": [ { "name": "sku_search", "count": 1 } ],
  "session_id": "session_..."
}
```

Breaking shape differences from `/v1beta/search`: `max_results`, `source_policy`, `fetch_policy` moved under `advanced_settings`; top-level placement returns 422 (<https://docs.parallel.ai/search/search-migration-guide.md>). Beta mode names `one-shot` and `agentic` map to `basic` and `advanced` (<https://docs.parallel.ai/integrations/cli.md>).

Search returns compressed excerpts, not full page bodies; full text is Extract's job (<https://docs.parallel.ai/search/migrate-to-parallel.md>).

Snapshot (point-in-time search via `fetch_policy.as_of`) exists but requires contacting sales for access (<https://docs.parallel.ai/search/snapshot.md>).

### 1.3 Extract API

Sources: <https://docs.parallel.ai/extract/extract-quickstart.md>, <https://docs.parallel.ai/extract/advanced-extract-settings.md>.

Request fields:

| Field | Notes |
| - | - |
| `urls` (string[]) | **Required.** Up to 20 URLs per request (was 10 on v1beta). |
| `objective`, `search_queries` | Optional; focus the excerpts. |
| `max_chars_total` | Caps excerpt characters; does not affect `full_content`. |
| `advanced_settings.full_content` | `false` (default), `true`, or `{"max_chars_per_result": n}`. |
| `advanced_settings.excerpt_settings` | `{"max_chars_per_result": n}`. |
| `advanced_settings.fetch_policy` | `max_age_seconds` (min 600), `timeout_seconds`, `disable_cache_fallback`. Extract uses a dynamic policy by default and may fetch live. |

Handles JavaScript-heavy pages and PDFs. Sending v1beta top-level `excerpts`, `full_content`, or `fetch_policy` to `/v1/extract` returns 422.

Response shape:

```json
{
  "extract_id": "extract_...",
  "results": [
    { "url": "...", "title": "...", "publish_date": "YYYY-MM-DD", "excerpts": ["..."], "full_content": "markdown, only if enabled" }
  ],
  "errors": [],
  "warnings": null,
  "usage": [ { "name": "sku_extract_excerpts", "count": 1 } ],
  "session_id": "session_..."
}
```

There is **no crawl or site-map endpoint** in the docs index; the only "crawler" page is guidance for webmasters about the vendor's own bot (<https://docs.parallel.ai/llms.txt>, <https://docs.parallel.ai/resources/crawler.md>).

### 1.4 Task API (deep research, enrichment)

Sources: <https://docs.parallel.ai/task-api/guides/choose-a-processor.md>, <https://docs.parallel.ai/task-api/guides/execute-task-run.md>, <https://docs.parallel.ai/task-api/guides/access-research-basis.md>, <https://docs.parallel.ai/task-api/webhooks.md>.

| Processor | $ per 1k runs | Stated latency | Approx. max output fields |
| - | - | - | - |
| `lite` | 5 | 10 s–60 s | ~2 |
| `base` | 10 | 15 s–100 s | ~5 |
| `core` | 25 | 60 s–5 min | ~10 |
| `core2x` | 50 | 60 s–10 min | ~10 |
| `pro` | 100 | 2–10 min | ~20 |
| `ultra` | 300 | 5–25 min | ~20 |
| `ultra2x` | 600 | 5–50 min | ~25 |
| `ultra4x` | 1,200 | 5–90 min | ~25 |
| `ultra8x` | 2,400 | 5 min–2 hr | ~25 |

- Billed per run, not per output field; **failed runs are not billed** (<https://docs.parallel.ai/getting-started/pricing.md>).
- `-fast` variants of each tier trade freshness for 3–5x lower latency (changelog 2025-12-10; `pro-fast` is the CLI default for research, <https://docs.parallel.ai/integrations/cli.md>).
- Lifecycle: `queued → running → completed | failed`. Create returns a `run_id`; `GET /v1/tasks/runs/{run_id}/result` blocks until completion; 408 on synchronous timeout.
- Output modes: structured JSON schema, auto schema, or `text` for markdown deep-research reports (changelog 2025-08-04, 2025-09-11).
- **Basis:** every result carries per-field citations, reasoning, excerpts, and a calibrated confidence level; per-list-element basis went GA 2026-08-24 without a beta header (changelog).
- Delivery: webhooks (`task_run.status`, HMAC-signed, <https://docs.parallel.ai/resources/webhook-setup.md>) and SSE (`GET .../events`, <https://docs.parallel.ai/task-api/task-sse.md>).
- `interaction_id` chains context across runs (changelog 2026-03-19).
- MCP tool calling inside Tasks and Data Connectors (index partners, pay-per-use, bring-your-own-license) (changelog 2025-07-28, 2026-09-23).
- Limits: task spec + input over 25,000 chars is an error; schema nesting over 3 levels is rejected (<https://docs.parallel.ai/resources/warnings-and-errors.md>).

### 1.5 Responses API (replaces the role of the Chat API)

Source: <https://docs.parallel.ai/responses-api/responses-quickstart.md>.

- OpenAI Responses wire-compatible: point the OpenAI SDK at `base_url="https://api.parallel.ai/v1"`, `model="parallel"`, `reasoning.effort` = `low` | `medium` (default) | `high`.
- Synchronous cited answers; structured outputs; streaming events; `previous_response_id` for multi-turn; `web_search` tool domain filters map to source policy; remote `mcp` tools and `data_sources` supported (changelog 2026-09-18, 2026-09-23).
- The older Chat API (OpenAI ChatCompletions-compatible, beta) no longer has its own pages in the docs index; old Chat API changelog links now point to the Responses quickstart. Its formal deprecation status is UNCONFIRMED.

### 1.6 Monitor, FindAll, Entity Search

- **Monitor** (<https://docs.parallel.ai/monitor-api/monitor-quickstart.md>): define a query, set `frequency` (`1h`, `1d`, `1w`), choose `lite` or `base`; two types, `event_stream` (tracks a search query) and `snapshot` (tracks a Task Run output); webhooks; Basis on every event; structured outputs.
- **FindAll** (<https://docs.parallel.ai/findall-api/findall-quickstart.md>): natural-language entity discovery with per-candidate verification, enrichments, extend, cancel, refresh with exclude lists, SSE and webhooks. Still on `/v1beta` paths; the docs say not to substitute `/v1`.
- **Entity Search** (<https://docs.parallel.ai/findall-api/entity-search.md>): synchronous people/company search; `entity_type` = `people` | `companies`; `match_limit` 5–1,000 (default 100); no pagination.

### 1.7 What changed since roughly early 2026 (changelog dates)

Source for all rows: <https://docs.parallel.ai/resources/changelog.md>.

| Date | Change |
| - | - |
| 2026-02-09 | Agent Skills published |
| 2026-02-12 | Search `fast` mode introduced |
| 2026-03-10 | Parallel CLI |
| 2026-03-18 | Machine Payments Protocol support |
| 2026-03-19 | Task `interaction_id` |
| 2026-04-22 | Search and Extract upgrades; `basic`/`advanced` modes; v1 GA |
| 2026-04-23 | Search MCP free by default, no account or key |
| 2026-05-06 | Monitor API GA |
| 2026-07-13 | Search `turbo` mode ($1 per 1k, p50 200 ms) |
| 2026-07-15 | $5 free credits per month per eligible organization |
| 2026-07-21 | Responses API |
| 2026-08-21 | Search `fast` mode repriced/relaunched at $1 per 1k, ~700 ms |
| 2026-08-24 | Per-element Basis GA |
| 2026-09-18 / 09-23 | Responses API: domain filters, search trail, MCP tools, Data Connectors |
| 2026-10-19 | EU data residency for Search (`basic`) and Extract |
| 2026-10-26 | Decisions API |
| 2026-11-04 | Usage Data API (`GET /service/v1/usage`) |
| 2026-11-05 | Parallel MCP 2.0: single server replaces Search MCP and Task MCP |
| 2026-11-16 | Images API |
| 2026-11-23 | Unknown `source_policy` keys now return 422 |

---

## 2. Billing model

Sources: <https://parallel.ai/pricing>, <https://parallel.ai/blog/free-tier-parallel>, <https://docs.parallel.ai/resources/faqs.md>.

- Pay-as-you-go, priced per request / run / URL (not tokens). Prepaid credit balance with optional auto-reload; invoice (postpaid) orgs exist.
- **Plans:** Launch (free, keyless MCP only, no account); Build (pay-as-you-go, card); Scale ($1,000/month for $1,000 credits, or $10,000/year for $12,000 credits; monthly credits do not roll over); Enterprise (custom).
- **Free credit:** "$5 in free credits each month" for "every eligible Parallel organization with a credit card". "Any unused balance expires at the end of the month." It is therefore **monthly-renewing, per organization, and requires a card on file**.
- Exact eligibility language: "Each eligible organization can receive one $5 monthly credit. A payment card can be used to activate monthly credits for one organization only. Marketplace and postpaid organizations are not currently eligible." (<https://parallel.ai/blog/free-tier-parallel>)
- "$5 covers up to: 5,000 Search API requests, 5,000 Extract API requests, 1,000 Task API runs, 1,666 Monitor API executions" (same blog; these assume the cheapest mode/processor).
- Pricing page also advertises "up to $80 at signup" and "up to $250 in startup credits"; conditions for the signup credit are UNCONFIRMED.
- "Free credit is always spent before any paid balance" (<https://parallel.ai/pricing>).
- Overage: the blog says "If you use more than $5, additional usage is billed to your card at standard rates." The error docs describe 402 when prepaid credit is insufficient. Which behaviour applies without auto-reload is UNCONFIRMED. **Treat the free credit as not a hard cap.**
- **Spend limits are notify-only:** admins can set a monthly limit per organization or per app; "Limits are notify-only; they never block requests." (<https://docs.parallel.ai/resources/faqs.md>)
- Data use: under standard terms, inputs and outputs "not linked to any individual" may be used for model training; zero-data-retention plans and EU-endpoint Search traffic are excluded (<https://docs.parallel.ai/resources/faqs.md>).

---

## 3. Usage metering

**Per-response fields**
- Search / Extract / vertical search responses include `usage: [{ "name": "<sku>", "count": n }]` (SKU names seen: `sku_search`, `sku_extract_excerpts`). Counts only, no dollar cost (<https://docs.parallel.ai/search/search-quickstart.md>, <https://docs.parallel.ai/extract/extract-quickstart.md>).
- Decisions responses include `usage: { "input_tokens": n, "output_tokens": n }` (<https://docs.parallel.ai/decisions/decisions-quickstart.md>).
- MCP tool results, when authenticated, report cost in `_meta["parallel/usage"]` with `name`, `count`, `cost_usd` per SKU. Keyless calls report no usage (<https://docs.parallel.ai/integrations/mcp/quickstart.md>).

**Headers**
- No balance, quota, or rate-limit response headers are documented for the product API. UNCONFIRMED whether any exist in practice. (`Retry-After` is documented only for the separate MPP payment gateway, <https://docs.parallel.ai/integrations/agentic-payments.md>.)

**Account API (programmatic balance and usage)** — base `https://api.parallel.ai/account`, spec at <https://api.parallel.ai/account/service/openapi.json>, guide at <https://docs.parallel.ai/integrations/account-api.md>.

| Method and path | Purpose | Scope |
| - | - | - |
| `GET /service/v1/balance` | Org prepaid balance: `org_id`, `credit_balance_cents`, `pending_debit_balance_cents`, `will_invoice` | `balance:read` |
| `POST /service/v1/balance/add` | Charge the org's default payment method and add credit | `balance:add` |
| `GET /service/v1/usage?start_date&end_date&interval` | Billed line items per day/week/month, broken out by `product`, `processor`, `app_name`, `api_key_id`, `api_key_name`, with `quantity` and `total_cost_cents` | `usage:read` (caller must be org admin) |
| `GET /service/v1/apps`, `POST /service/v1/apps`, `DELETE /service/v1/apps/{app_id}` | List / create / delete apps | `apps:*` |
| `POST /service/v1/apps/{app_id}/keys` | Create API key (raw key returned once) | `keys:create` |
| `DELETE /service/v1/apps/{app_id}/keys/{api_key_id}` | Delete API key | `keys:delete` |
| `POST /service/v1/apps/{app_id}/oauth-credentials`, `DELETE .../{credential_id}` | Create / revoke a product-API refresh token | — |

Important properties:
- These endpoints **do not accept a normal API key**. They need a short-lived access token from the OAuth 2.0 Device Authorization Grant (register client → device code → user approves in browser → poll token). Access tokens expire after 10 minutes; refresh tokens rotate on every use and expire after 30 days idle (<https://docs.parallel.ai/integrations/account-api.md>).
- Balance is **per organization**, not per key. Per-key numbers come only from the usage endpoint.
- Usage endpoint: rate limit 10 requests/min per organization; costs are "usage before credits or commit drawdowns are applied"; completed days are stable and the current day updates as usage lands; window max 365 days (<https://docs.parallel.ai/integrations/usage-api.md>).
- The CLI wraps this: `parallel-cli login`, `parallel-cli balance get`, `parallel-cli balance add` (<https://docs.parallel.ai/integrations/account-api.md>).
- Dashboard: Platform > Usage shows real-time request counts and spend (<https://docs.parallel.ai/resources/faqs.md>).

---

## 4. Key management

- Keys live under **apps** inside an **organization**. A default key is generated at signup (<https://docs.parallel.ai/resources/faqs.md>).
- Create and delete via the Account API (above). **No list-keys endpoint appears in the published OpenAPI**, although a `keys:read` scope is defined; key IDs and names can be enumerated indirectly from usage line items. Whether a list endpoint exists is UNCONFIRMED.
- No rotate endpoint; rotation is create-new then delete-old.
- Key types: user keys are "revoked when its creator leaves the org"; `is_service_scoped: true` creates an org-owned service key (admins only) (<https://docs.parallel.ai/service-api/keys/create-key.md>).
- **Per-key limits:** none documented. Spend limits exist per organization and per app only, and are notify-only.
- Roles: Member and Admin (<https://docs.parallel.ai/resources/organization-roles-and-permissions.md>).
- Multiple organizations per person: not addressed in the docs (UNCONFIRMED). The free-credit rule ties one payment card to one organization's monthly credit.
- An OAuth provider lets third-party apps obtain a user's API key with consent (PKCE flow) (<https://docs.parallel.ai/integrations/oauth-provider.md>).

---

## 5. Error signalling

Source: <https://docs.parallel.ai/resources/warnings-and-errors.md>.

Body shape for all errors:

```json
{ "error": { "message": "Human-readable error description", "detail": { } } }
```

| Status | Meaning | Retry? |
| - | - | - |
| 401 | Invalid or missing credentials | No |
| **402** | "Insufficient credit in account" | No |
| 403 | Invalid processor in request | No |
| 404 | Run or resource not found | No |
| 408 | Synchronous request timed out | Yes |
| 422 | Validation failed; `detail` lists failing fields | No |
| **429** | "Rate limited or quota exceeded" | Yes, with backoff |
| 500 / 502 / 503 | Server side | Yes |

- 402 can fire with a positive balance because running tasks reserve credit ("in-flight balance"); available = total − reserved. Task Group submissions check balance for the whole batch up front.
- 429 uses a rolling 60-second window. No `Retry-After` or rate-limit headers are documented (UNCONFIRMED).
- Keyless MCP past the free limit: "extra calls are rate limited and nothing is billed" (<https://parallel.ai/mcp>). The exact error shape is UNCONFIRMED.
- MCP config errors: unknown tool name in `?tools=` returns HTTP 400; trailing slash on the URL returns 404; override header without credentials returns 401 (<https://docs.parallel.ai/integrations/mcp/quickstart.md>).

---

## 6. MCP, CLI, skills, plugins

### 6.1 Current server (MCP 2.0, since 2026-11-05)

Source: <https://docs.parallel.ai/integrations/mcp/quickstart.md>, <https://parallel.ai/mcp>.

- URL: `https://mcp.parallel.ai/mcp` (Streamable HTTP; no trailing slash).
- Auth modes:

| Mode | How | What you get |
| - | - | - |
| No key | Connect to the URL | `web_search`, `web_fetch`, `web_decisions`, `image_search` (`fast` only), `find_verticals`, `search_vertical`; free; lower rate limits; no usage reporting; search pinned to `fast` with server-managed settings |
| OAuth | `https://mcp.parallel.ai/mcp?login` | Adds `web_research`, `advanced` image mode, higher limits; billed at API rates |
| API key | `Authorization: Bearer <key>` or `x-api-key: <key>` | Same as OAuth; billed at API rates |

- Tools: `web_search` → Search API; `web_fetch` → Extract API (up to 20 URLs); `web_decisions` → Decisions API; `web_research` → Responses API; `image_search` → Images API.
- Config: `?tools=a,b` selects tools; `x-parallel-mcp-config` header (JSON, requires auth) sets `override` (model cannot change) and `model_choice` (fields exposed to the model).
- **Free-use terms:** pricing page describes the free MCP as "suitable for personal/hobbyist use" with "Variable limits, enough for personal use" (<https://parallel.ai/pricing>). The launch post says "generous rate limits for hobby use and personal agents. For production agents at scale, we recommend using the paid version" (<https://parallel.ai/blog/free-web-search-mcp>). No numeric limit is published (UNCONFIRMED). Use is "subject to the Parallel Customer Terms" per the server's own instructions.
- Keyless calls take an optional `session_id` that the legacy docs say is "used for free-tier rate limiting and log correlation" (<https://docs.parallel.ai/integrations/mcp/search-mcp.md>).

### 6.2 Legacy servers (still running)

- Search MCP: `https://search.parallel.ai/mcp` (anonymous or Bearer key) and `https://search.parallel.ai/mcp-oauth` (auth required; anonymous returns 401). Tools `web_search`, `web_fetch` (<https://docs.parallel.ai/integrations/mcp/search-mcp.md>). The hostname `search-mcp.parallel.ai` does not appear in the current docs.
- Task MCP: `https://task-mcp.parallel.ai/mcp`, authentication required (OAuth or Bearer key), four tools for async deep research and task groups (<https://docs.parallel.ai/integrations/mcp/task-mcp.md>).
- Docs MCP (documentation search only): `https://docs.parallel.ai/mcp`.

### 6.3 CLI, skills, plugins

- **CLI** `parallel-cli` (package `parallel-web-tools`; pipx, uv, Homebrew, npm `parallel-web-cli`, or standalone binary). Commands: `search`, `extract`, `research`, `enrich`, `findall` (incl. `entity-search`), `monitor`, `login`, `auth`, `balance`, `skills install`. JSON output with `--json`. Source repo <https://github.com/parallel-web/parallel-web-tools> (<https://docs.parallel.ai/integrations/cli.md>).
- **Agent Skills**: `parallel-web-search`, `parallel-web-extract`, `parallel-deep-research`, `parallel-data-enrichment`, plus `parallel-api` (API chooser). Install with `parallel-cli skills install` or `npx skills add parallel-web/parallel-agent-skills`. Catalog at <https://skills.parallel.ai> (<https://docs.parallel.ai/integrations/agent-skills.md>).
- **Plugins**: Claude Code marketplace plugin (bundles the hosted MCP; CLI-backed skills need a funded account), Cursor marketplace, OpenCode plugin, Pi extension, OpenClaw skills (<https://docs.parallel.ai/integrations/claude-code-marketplace.md>).
- Other routes to the same API: LiteLLM, OpenRouter, Vercel AI Gateway, LangChain, AWS and Google Cloud marketplaces, and an MPP/x402 pay-per-request gateway (<https://docs.parallel.ai/llms.txt>).

---

## 7. Terms: multiple accounts and limit circumvention

**Acceptable Use Policy** — <https://parallel.ai/acceptable-use-policy>, effective 2026-08-11. It "applies to anyone who uses or interacts with any of [the vendor's] products and services" and "forms part of the agreement that governs your use". Under "Misuse Our Technology", users may not:

> "intentionally bypass model restrictions (e.g., jailbreaking, prompt injection) without authorization or circumvent rate limits or other use limitations, including by orchestrating usage among multiple accounts;"

> "circumvent bans using different accounts or sharing access with previously banned entities;"

> "take any action that imposes, or may impose (as determined by us, in our sole discretion), an unreasonable or disproportionately large load on our infrastructure"

Enforcement clause: "If we detect or reasonably suspect a violation of this AUP by you or through your account, we may throttle, suspend, or terminate your access to our products and services."

**Customer Terms** — <https://parallel.ai/customer-terms>, effective 2026-11-10. "Documentation" is defined to include the "acceptable use policy". Section 2(c) use restrictions do not mention multiple accounts directly; relevant items include a ban on "timesharing or service bureau purposes", on reselling or redistributing outputs, and on using outputs to build "databases, data brokerage, data selling/reselling businesses" or to train models.

**Free-credit rule** — <https://parallel.ai/blog/free-tier-parallel>: "Each eligible organization can receive one $5 monthly credit. A payment card can be used to activate monthly credits for one organization only."

**Reading:** rotating one person's usage across several free-credit organizations or accounts to get past the per-organization credit or the rate limits is **prohibited** by the AUP's "orchestrating usage among multiple accounts" language, and is also mechanically blocked by the one-card-one-organization rule. Holding several keys inside one organization is permitted and normal, but gives no extra quota because balance and credit are per organization. The terms do not explicitly say whether a person may belong to more than one organization for legitimate reasons (UNCONFIRMED).

---

## 8. Positioning and comparisons

### 8.1 Vendor claims (source type: vendor docs and vendor blog)

- Mode mapping the vendor publishes for migrations: Exa `instant` → `turbo`; Exa `lite`/`auto` → `fast`; Exa `deep` → `advanced`; Tavily `ultra-fast`/`fast`/`basic`/`advanced` → `turbo`/`fast`/`basic`/`advanced`; Brave LLM Context → `fast`; SERP APIs → `turbo` or `basic` (<https://docs.parallel.ai/search/migrate-to-parallel.md>).
- Turbo launch benchmark (vendor-run, 2026-07-10 to 07-12, GPT-5.4 agent, "best observed scores selected for each provider"), BrowseComp accuracy / p50 latency: Parallel Turbo 51% / 216 ms; Brave 38.3% / 430 ms; Exa Instant 33.7% / 361 ms; SerpAPI 23.3% / 999 ms; Tavily Ultra Fast 19.3% / 357 ms (<https://parallel.ai/blog/parallel-search-turbo>).
- Vendor states it "ranked #1 on every dimension" in the August 2026 Artificial Analysis Search Index and that Advanced is "43% lower cost per task than the next closest provider" (<https://parallel.ai/blog/artificial-analysis-best-search-api>).
- Task API: vendor claims state-of-the-art on DeepSearchQA, BrowseComp, SealQA (changelog 2025-11-03, 2026-04-07).
- No head-to-head claim against Firecrawl's crawl/scrape product was found; Extract is compared on FinanceBench recall in a vendor harness (<https://parallel.ai/blog/parallel-search-api>).
- The vendor publishes an eval guide warning that sending the raw question as both `objective` and the only `search_queries` entry skews results (<https://docs.parallel.ai/search/evaluating-search.md>).

### 8.2 Independent or third-party comparisons

- **Artificial Analysis Search Index** (source type: third-party benchmarking firm; fixed agent on GPT-5.6 Luna; DeepSearchQA, BrowseComp, AA-Omniscience; data dated 2026-11-19) — <https://artificialanalysis.ai/agents/search-api>. Index score, search cost per 1k tasks, time per task:
  - Parallel Search (advanced) 83, $23.00, 23.2 s
  - Parallel Search (fast) 82, $4.63, 14.5 s
  - Exa Search (auto) 80, $53.17, 35.3 s
  - Exa Search (lite) 79, $31.20, 18.1 s
  - Brave Search (LLM context) 75, $61.96, 20.8 s
  - Firecrawl Search 73, $30.48, 59.7 s
  - Model-only baseline 33
  - Two other providers tie or come within one point of the top (83 and 82). Tavily is not in the rows retrieved.
- **AIMultiple agentic search benchmark** (source type: independent analyst site; 24 configurations, 120 questions; updated 2026-11-10) — <https://aimultiple.com/agentic-search>. Answer accuracy with 95% CI: Parallel Advanced 87.0% (78.3–94.2); Exa Fast 82.6% (73.9–91.3); Parallel Fast 79.7%; Parallel Basic 79.4%; Exa Instant 79.1%; Brave 77.9%; Firecrawl 73.5%; Tavily Advanced 70.6%; Tavily Ultra Fast 56.5%. Confidence intervals overlap heavily across the top group. API p50 latency: Parallel Turbo 0.38 s, Fast 0.78 s, Basic 1.72 s, Advanced 2.62 s; Exa Fast 0.47 s; Brave ~0.95 s; Firecrawl 1.36 s; Tavily Basic 2.12 s. The page notes the nDCG ordering reversed (Exa Fast above Parallel Advanced) on a small common-query subset.
- **Openbenchmarks** (source type: third-party benchmark site; seen via search excerpt only, not opened) — <https://openbenchmarks.com/web-search/best-ai-search-engines-for-agents>: Parallel `basic` led a 45-question multi-search F1 test at 46.5%, Exa `deep` 45.4%. On its factual-lookup test, Brave edged Parallel (94.0% vs 93.3%), and Parallel `fast` scored 86.0% (<https://openbenchmarks.com/web-search/brave-vs-parallel>).
- An earlier AIMultiple run (reported by several secondary write-ups, December 2025 data) ranked Brave, Firecrawl, Exa and Parallel's then-"Pro" mode as statistically tied, with that Parallel mode far slower (13.6 s). This predates the 2026 mode redesign (source type: secondary summaries, <https://www.datasumi.com/blog/best-web-search-apis-ai-agents-rag-2026>).

Takeaway across sources: Parallel's `advanced` and `fast` modes sit in the top cluster on recent independent tests and are cheap per request, but margins inside the top cluster are within noise on the smaller studies, and results vary by task type (factual lookup, freshness, coding docs).

---

## 9. What a multi-provider wrapper should take from Parallel

- **Add it as a `search` and `extract` provider; there is nothing to map `crawl` to.** Parallel has no crawl or map endpoint, so Firecrawl/Tavily-style crawl stays with other providers.
- **Request shape is different from single-query providers.** `search_queries` (array, required) plus optional `objective`. An adapter that copies the user's question into both fields is the vendor's named top pitfall. Pass the query as one or more short keyword queries and put the full question in `objective`.
- **Always set `mode` explicitly.** The default is `advanced` at $5 per 1k; `fast` and `turbo` are $1 per 1k.
- **Use `/v1/*`, not `/v1beta/*`**, and put `max_results`, `source_policy`, `fetch_policy`, `full_content` under `advanced_settings`. Top-level placement is a 422.
- **Results are excerpts, not snippets plus raw content.** Normalize `results[].excerpts[]` (markdown) into the wrapper's content field; call Extract with `advanced_settings.full_content` when full text is needed.
- **Meter locally from the response `usage` array** (SKU counts) times the price table. Reconcile daily against `GET /service/v1/usage`, which is broken out per API key. Read remaining credit from `GET /service/v1/balance`.
- **Account API needs device-flow OAuth, not the API key.** Budget for a one-time interactive login and refresh-token storage (tokens rotate on every refresh), or shell out to `parallel-cli balance get`.
- **Do not rely on spend limits or the free credit as a hard cap.** Limits are notify-only and a card is required; enforce a local budget.
- **Error mapping:** 402 = out of credit (do not retry; fail over to another provider), 429 = rolling-window rate limit (back off; no documented `Retry-After`), 422 = adapter bug.
- **Key rotation buys nothing for quota.** Balance, free credit, and (probably) rate limits are per organization; multi-account rotation to stretch free limits is prohibited by the AUP.
- **Keyless MCP is a legitimate zero-cost fallback for personal use**, but it is pinned to `fast` mode, has unpublished variable limits, reports no usage, and is positioned for hobby use rather than as an API substitute.
- **Beyond search/extract**, the Responses API (OpenAI-compatible, sync cited answers) and Task API (async deep research with per-field citations and confidence) cover "answer" and "research" verbs if the wrapper ever grows them. FindAll and Entity Search are still beta.

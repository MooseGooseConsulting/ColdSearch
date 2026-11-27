# Firecrawl — product surface, billing, and key metering (2026-11-27)

- **Date researched:** 2026-11-27.
- **Nature of this file:** a dated evidence snapshot taken from Firecrawl's own documentation, OpenAPI spec, pricing page, changelog and Terms of Service. Performance, coverage and benchmark figures are **vendor claims** and are labelled as such; nothing here was independently benchmarked.
- **Not confirmed:** whether usage endpoints cost credits or have their own rate limit; exact keyless per-IP caps; whether a self-serve user can create extra teams that each get a free allotment; launch dates of individual MCP tools; the open-source licence text. These are marked **UNCONFIRMED** inline.

Sources were fetched directly (plain HTTP) on the date above:

- Docs index: https://docs.firecrawl.dev/llms.txt, https://docs.firecrawl.dev/_llms/en/v2.txt, https://docs.firecrawl.dev/llms-full.txt (exists, about 2.1 MB)
- OpenAPI: https://docs.firecrawl.dev/api-reference/v2-openapi.json
- Changelog: https://www.firecrawl.dev/changelog
- Pricing: https://www.firecrawl.dev/pricing (states "Effective September 4, 2026")
- Terms: https://www.firecrawl.dev/terms-of-service (states "Date of last revision: October 7, 2026")

One live keyless request (`POST /v2/scrape` on a public test page, no credential) was made to observe response headers and usage fields; see section 3.

---

## 1. Product surface

### 1.1 API version and base URL

- Current API is **v2**, base `https://api.firecrawl.dev/v2`, bearer auth (`Authorization: Bearer fc-...`). Source: OpenAPI `info.version: v2`, https://docs.firecrawl.dev/api-reference/v2-introduction
- v1 and v0 specs are still published. Source: https://docs.firecrawl.dev/llms.txt
- The pinned self-host compose file referenced in docs is release tag `v2.11.162`. Source: https://docs.firecrawl.dev/contributing/self-host

### 1.2 Endpoint families (from the v2 OpenAPI spec)

| Family | Paths | Notes |
| - | - | - |
| Scrape | `POST /scrape`, `GET /scrape/{jobId}` | Also runs Alexandria provider capabilities when the body carries `alexandria` instead of `url` ("Universal Scrape") |
| Interact after scrape | `POST /scrape/{jobId}/interact`, `DELETE /scrape/{jobId}/interact` | Prompt or Playwright code against the scrape's browser session |
| Interact / Browser Sandbox | `POST /interact`, `GET /interact`, `POST /interact/{sessionId}/execute`, `DELETE /interact/{sessionId}` | Standalone sessions |
| Batch scrape | `POST /batch/scrape`, `GET`/`DELETE /batch/scrape/{id}`, `GET /batch/scrape/{id}/errors` | |
| Crawl | `POST /crawl`, `GET`/`DELETE /crawl/{id}`, `GET /crawl/{id}/errors`, `POST /crawl/params-preview`, `GET /crawl/active` | |
| Map | `POST /map` | |
| Search | `POST /search`, `POST /search/{jobId}/feedback` | `sources`: web, news, images, alexandria. `categories`: research, pdf, developer, gov |
| Developer Index | `GET`/`POST /search/developer` | |
| Government Index | `GET`/`POST /search/gov` | |
| Research Index | `GET /search/research/papers`, `GET /search/research/papers/{id}`, `GET /search/research/papers/{id}/similar`, `GET /search/research/proteins` | |
| Parse | `POST /parse`, `GET /parse/formats` | Document upload (PDF, Word, Excel, PowerPoint, HTML) |
| Monitor | `POST`/`GET /monitor`, `GET`/`PATCH`/`DELETE /monitor/{monitorId}`, `POST /monitor/{monitorId}/run`, `GET /monitor/{monitorId}/checks`, `GET /monitor/{monitorId}/checks/{checkId}` | Page, website, and web-scale (search-based) monitors |
| Agent | `POST`/`GET /agent`, `GET`/`DELETE /agent/{jobId}`, `GET /agent/{jobId}/trace`, `GET /agent/{jobId}/snapshots/{snapshotId}` | Docs also reference `GET /v2/agent/threads/{threadId}` |
| Extract (deprecated) | `POST /extract`, `GET /extract/{id}` | Removal date below |
| Account | `GET /team/credit-usage`, `GET /team/credit-usage/historical`, `GET /team/token-usage`, `GET /team/token-usage/historical`, `GET /team/queue-status`, `GET /team/activity`, `GET`/`PUT /team/threat-protection` | |
| Support / feedback | `POST /support/ask`, `POST /feedback` | "Ask" is an AI support agent that diagnoses failed jobs |

Source: https://docs.firecrawl.dev/api-reference/v2-openapi.json and https://docs.firecrawl.dev/_llms/en/v2.txt

Separate hosts:

- Platforms (partner) API: `https://integrations.firecrawl.dev/partner/v1/...` — https://docs.firecrawl.dev/firecrawl-for-platforms
- Hosted MCP: `https://mcp.firecrawl.dev/v2/mcp` and `/v2/mcp-oauth` — https://docs.firecrawl.dev/mcp-server
- OAuth and agent registration live on `https://www.firecrawl.dev` — https://docs.firecrawl.dev/oauth, https://www.firecrawl.dev/auth.md

### 1.3 Timeline of what is new (changelog dates)

Source for every row: https://www.firecrawl.dev/changelog

| Date | Change |
| - | - |
| 2026-01-27 | Firecrawl Skill and CLI |
| 2026-02-03 | v2.8.0 |
| 2026-02-17 | Browser Sandbox |
| 2026-03-25 | `/interact` |
| 2026-04-10 | v2.9.0 (interact, question and audio formats, PDF parsing modes, Java and Elixir SDKs) |
| 2026-04-16 | `web-agent` open framework |
| 2026-04-28 | `/parse` |
| 2026-04-30 | Lockdown Mode (cache-only scrape) |
| 2026-05-06 / 05-08 | Question format / Highlights format |
| 2026-05-15 | v2.10 (parse, lockdown, question and highlights formats, four new SDKs) |
| 2026-05-26 | `/monitor` |
| 2026-06-16 | Research Index (arXiv) |
| 2026-06-24 | v2.11.0: Research Index, keyless endpoint access, `redactPII`, `deterministicJson` format, video discovery |
| 2026-07-01 | Web-scale `/monitor` |
| 2026-07-22 | New `/search` relevance model; highlights on by default (vendor claim: 94.7% on SimpleQA) |
| 2026-08-13 | Life sciences added to the Research Index (vendor claim: 41M+ papers) |
| 2026-08-20 | Developer Index (vendor claim: 70M+ primary sources) |
| 2026-09-22 | Alexandria announced |
| 2026-09-24 / 09-29 | Alexandria in the Claude connector / in the ChatGPT and Codex plugin |
| 2026-10-01 | People and company enrichment in Alexandria (three named third-party providers) |
| 2026-10-08 | Universal Scrape (`/scrape` runs Alexandria capabilities) |
| 2026-10-22 | Government and Legal Index (vendor claim: 30 million US government pages) |
| 2026-11-02 | "Headless Clay" enrichment flows |
| 2026-11-10 | Job search tools |
| 2026-11-12 | "Firecrawl MCP v3" (vendor claims: 3000+ tools, 60x higher rate limits, 4x more usage) |
| 2026-11-17 | UltraSearch (provider record added to search results) |
| 2026-11-18 | Firecrawl Local (Rust single binary) |

Removals and deprecations:

- `/extract` (v1 and v2) is deprecated and "will be removed on Thursday, December 10, 2026, 15:00 UTC"; after that the routes return `410 Gone`. Replace with `/v2/scrape` plus a JSON format (single page), `/v2/batch/scrape` (several pages, one result each), or `/v2/agent` (wildcards, web search, combined answer). Source: https://docs.firecrawl.dev/features/extract, https://docs.firecrawl.dev/migrating-from-extract
- The MCP `firecrawl_extract` tool is gone from the current tool surface; `firecrawl-mcp` below 3.23.7 still calls `/extract`. Source: https://docs.firecrawl.dev/mcp-server/tools, https://docs.firecrawl.dev/migrating-from-extract
- Search category `github` was removed; requests that include it return `400`. Use `developer`. Source: https://docs.firecrawl.dev/features/search
- `GET /search/research/github` and legacy `GET /research/github` were removed on 2026-11-03 and return `410 Gone`. Source: https://docs.firecrawl.dev/features/developer
- Agent Spark 1 model names are deprecated and route to `spark-2`. Source: https://docs.firecrawl.dev/features/agent
- `/team/activity` still enumerates `llmstxt` and `deep_research` as endpoint filters, but neither has a v2 path in the spec. Source: OpenAPI

### 1.4 The named features, explained

**Alexandria** — a catalogue of third-party and first-party structured-data providers reachable through the normal API key. Flow: discover a tool (free), read its contract (inputs, outputs, price), then execute it.

- Discover: `POST /v2/search` with `sources: ["alexandria"]` (tools only) or `["web","alexandria"]`; results arrive in `data.tools`. `domainTools: true` matches tools to a website.
- Execute: `POST /v2/scrape` with `alexandria: {provider, capability, options}` and no `url`; results in `data.alexandria[]`, each with `data` or `error`. An `x-request-id` header makes an Alexandria call replay-safe (same id plus same body replays the saved result without a new charge).
- SDK: `findTools` / `find_tools`. CLI: `firecrawl find-tools`, `firecrawl scrape <provider>/<capability> --options '{...}'`.
- Billing: discovery free; execution at the tool's listed credit price. Some providers require an org admin to accept terms first (`403 THIRD_PARTY_DATA_TERMS_REQUIRED` with `requiresAction.url`).
- Launched 2026-09-22. Vendor claims at various dates: "100+", "200+" providers, "3,000+" / "3,300+" tools.
- Source: https://docs.firecrawl.dev/features/alexandria, https://www.firecrawl.dev/changelog

**Developer search** (`/search/developer`, MCP `firecrawl_developer_search`, CLI `firecrawl developer`) — index of GitHub issues, merged pull requests, READMEs and curated documentation sites; returns matched markdown `passages` with stable ids (`issue:owner/repo#123`, `doc:`, `pull_request:`, `readme:`). Filters: `k`, `passages`, `types`, `repos`, `sources`, `skills: "only"`, `language`, `topic`, `license`, `min_stars`, `max_stars`, `archived`, `fork`. Billing: 2 credits per 10 results, rounded up. Usable without a key. Launched 2026-08-20. Source: https://docs.firecrawl.dev/features/developer

**Gov search** (`/search/gov`, MCP `firecrawl_gov_search`, CLI `firecrawl gov`) — US federal, state and local statutes, regulations, codes, court opinions and other government publications. Filters: `jurisdiction`, `court`, `courtType`, `cites`, `domain`. Billing: free, uses no credits; 300 calls/minute on every plan plus a daily cap by plan. Launched 2026-10-22. Source: https://docs.firecrawl.dev/features/gov, https://docs.firecrawl.dev/rate-limits

**Research paper search** (`/search/research/papers...`, MCP `firecrawl_research_search_papers`, `_inspect_paper`, `_read_paper`, `_related_papers`, `_lookup_protein`) — paper index over PubMed, bioRxiv, medRxiv and arXiv: search, inspect, read full-text passages, follow citations, plus a UniProt-based protein lookup. Billing: free; 100 calls/minute plus a daily cap by plan. Launched 2026-06-16 (arXiv), life sciences 2026-08-13. Source: https://docs.firecrawl.dev/features/research, https://docs.firecrawl.dev/rate-limits

**Search `categories`** — a `/search` parameter: `research` (restricts ordinary web results to research-affiliated sites; this is not the paper index), `pdf`, `developer` (Developer Index, cannot be combined with other categories), `gov` (Government Index, cannot be combined, adds no search credits). Results carry a `category` field in the `web` group. Source: https://docs.firecrawl.dev/features/search

**People/company search and enrich** (MCP `people_company_search`, `people_company_enrich`) — provider "waterfalls" over Alexandria B2B data providers. Search takes `entity` (`person` or `company`) plus filters such as titles, seniority, company domains, locations, industries, headcount; `limit` 1 to 100; `max_credits` defaults to 1000; rows never carry emails or phones. Enrich takes up to 10 records per call and optional `contact_fields` (`work_email`, `personal_email`, `mobile`); a provider that finds a field is charged its listed price, a miss is free; **without `max_credits` an enrich call is uncapped**. Requires an authenticated session. These are documented as MCP tools; the equivalent over REST is an Alexandria capability call. Enrichment in Alexandria launched 2026-10-01; the date the two MCP tools appeared is UNCONFIRMED. Source: https://docs.firecrawl.dev/mcp-server/tools

Related: a plain URL scrape of a LinkedIn person or company page is routed to the enrichment providers the org configured, and costs the provider price (documented examples: 5, 10, 30 or 40 credits) instead of 1 credit. Source: https://docs.firecrawl.dev/billing (Provider-routed URLs)

**Jobs search** (MCP `jobs_search`) — give at least one of `query`, `company`, `url`, `urls`; returns rows with `title`, `company`, `location`, `remote`, `posted_at`, `url`, `source`, `status` (`open`, `unverified`, `closed`, `not_found`, `error`), `checked_at`. Each provider read is charged its listed price; `max_credits` defaults to 200. Hosted server only; not in local `firecrawl-mcp` 3.40.0. Job tools were announced 2026-11-10. Source: https://docs.firecrawl.dev/mcp-server/tools

**Saved "skills"** (MCP `firecrawl_save_skill`) — step-by-step instruction documents that an agent follows, which name Alexandria capabilities as `@provider/capability`. They live in the Alexandria library under `/library/skills` (`/library/skills/firecrawl/<id>` for vendor skills, `/library/skills/team/<slug>` for the team's own). The tool creates, copies (`from`), or edits (with `id` plus `baseVersion` optimistic locking) a team skill; it cannot delete. Free; needs an authenticated session; hosted server only. Launch date UNCONFIRMED. Source: https://docs.firecrawl.dev/mcp-server/tools

Distinct from that: the **agent skills Firecrawl ships for coding agents** (see section 6).

**`firecrawl_agent`** (MCP; REST `POST /v2/agent`) — an asynchronous autonomous research job: prompt (URLs optional), optional schema, searches, navigates and reads pages, returns structured data. Poll `GET /v2/agent/{jobId}` (MCP `firecrawl_agent_status`). Runs on model `spark-2` with optional `effort`. `maxCredits` caps a run; a capped run ends as `status: "failed"` with `stopReason: "credit_limit_reached"`, `creditsUsed: 0` (failed runs are not billed), possibly a `partial`. Can call Alexandria providers when the request sends `exchange: {"enabled": true}` (optionally pinning up to five `toolkits`). Billing: dynamic; "5 free daily runs"; "most agent runs consume a few hundred credits". Source: https://docs.firecrawl.dev/features/agent, https://docs.firecrawl.dev/api-reference/errors

**UltraSearch** — on hosted, authenticated MCP connections, `firecrawl_search` may add an `answer` field with one Alexandria provider record when the query clearly names one person, one company, one company's open jobs, one paper, or one to three US-listed stocks. It is automatic (no parameter) and is billed on top of the search: person or company up to 20 credits (typically 5 and 2), jobs up to 10 (typically 2 per posting), paper 0, stock headlines 2. `answer.credits` reports the split. Turn it off by passing a `sources` list without `web` or `alexandria`. Does not run keyless, under zero data retention, or on a local server. Launched 2026-11-17. Source: https://docs.firecrawl.dev/mcp-server/tools

---

## 2. Billing model

### 2.1 Credits per operation

Source: https://docs.firecrawl.dev/billing and https://www.firecrawl.dev/pricing

| Operation | Cost |
| - | - |
| Scrape | 1 credit / page |
| Crawl | 1 credit / page |
| Batch scrape | per page, same as scrape; billed asynchronously as pages complete |
| Map | 1 credit / call |
| Search | 2 credits / 10 results, rounded up; scrape costs added per scraped result |
| Developer search | 2 credits / 10 results, rounded up |
| Government Index | free |
| Research Index | free |
| Parse | PDF 1 credit / page; other documents 1 credit flat (https://docs.firecrawl.dev/features/parse) |
| Interact / Browser | 2 credits / browser minute (code only), 7 with a `prompt`; +2 under ZDR; one-minute minimum |
| Monitor | 1 credit / page / check; +1 per changed page judged; deterministic-extraction engine flat 7 / page / check (pricing page) |
| Agent | dynamic; 5 free runs per day |
| Extract (deprecated) | token based, 1 credit = 15 tokens |
| Alexandria execution | each tool's listed price; discovery free |
| X / Twitter URLs | 30 credits (1 base + 29 for the model query) |

Scrape option surcharges (stack on the base, and apply to crawl and search too):

| Option | Surcharge |
| - | - |
| JSON format (LLM extraction) | +4 / page |
| `question` or `query` format | +4 / page |
| `highlights` format | +4 / page |
| `audio` / `video` format | +4 / page each |
| `redactPII` | +4 / page |
| `checkPromptInjection` | +4 / page (5 billed if the scrape fails after the check ran) |
| `lockdown` cache hit | +4 / page (cache miss: 1 credit, no document) |
| PDF parsing | +1 / PDF page |
| Zero data retention | +1 / page |
| Enhanced proxy | +0 |
| Threat protection scan | 2 credits per scanned URL |

Charging rule: a returned document is charged even when the target answered 403 or 404 (check `metadata.statusCode`); no document means 0 credits, with the listed exceptions. Polling job status does not consume credits. Source: https://docs.firecrawl.dev/billing (When credits are charged)

### 2.2 Plans

Source: https://www.firecrawl.dev/pricing (effective 2026-09-04), https://docs.firecrawl.dev/billing, https://docs.firecrawl.dev/rate-limits

| Plan | Price (monthly / annual per month) | Credits per month | Concurrent browsers | Max queued jobs | scrape, map, search req/min | crawl, agent req/min | interact req/min |
| - | - | - | - | - | - | - | - |
| Free | $0 | 1,000 | 2 | 50,000 | 10 | 2 | 2 |
| Hobby | $19 / $16 | 5,000 | 5 | 50,000 | 100 | 20 | 20 |
| Standard | $99 / $83 | 100,000 | 25 | 50,000 | 500 | 100 | 100 |
| Growth | $399 / $333 | 500,000 | 50 | 100,000 | 5,000 | 1,000 | 1,000 |
| Scale | $749 / $599 | 1,000,000 | 100 | 200,000+ | 10,000 | 2,000 | 1,500 |
| Enterprise | custom | custom | custom | custom | custom | custom | custom |

Other limits: `/crawl/status` and `/agent/status` 500 req/min on Free (5,000 Hobby); `/interact/{id}/execute` 10 req/min on Free. Extract shares the agent limit. Batch scrape: the rate-limits page says it shares the crawl limit, the billing page says it shares the scrape limit (docs disagree). Government and Research index daily caps: 1,000 calls per index per day on Free, Hobby and Standard; 2,000 on Growth; unlimited on Scale and Enterprise.

### 2.3 Free plan

- "1,000 credits per month. The allotment resets at the start of each monthly cycle. Unused free credits do not roll over." No card needed. Source: https://docs.firecrawl.dev/billing
- Monthly-renewing, not one-time (as of the pricing page effective 2026-09-04). An earlier one-time free allotment is a recollection, not something verified today: UNCONFIRMED.
- Scope: "Credits are scoped to the Firecrawl team/org, not to an individual API key." Source: https://www.firecrawl.dev/auth.md. Rate limits "are applied per team, so all API keys on the same team share the same rate limit counters." Source: https://docs.firecrawl.dev/rate-limits
- Includes every core endpoint. Excludes pay-as-you-go, rollover, a DPA and Slack support.
- At zero balance: `402` until the monthly reset.

### 2.4 Rollover, overage, spend caps

- Plan credits do not roll over, except annual Scale (one month) and annual Enterprise (two months). The pricing FAQ words it more loosely ("Credits roll over on Scale and Enterprise").
- Pay-as-you-go (paid plans only): automatic 5 USD increments; 1,000 credits on Hobby, 2,000 Standard, 2,500 Growth, 5,000 Scale; optional monthly limit; `0` disables it.
- With pay-as-you-go on, an overage allowance lets bursts continue while a top-up settles (1,500 credits Hobby up to 600,000 Scale).
- **Per-API-key spend limits**: a credit cap per day, week or month, set on the dashboard API keys page by the key owner or a team admin. A crawl can be refused with `402` by a per-key spend limit.
- Source for all: https://docs.firecrawl.dev/billing

---

## 3. Usage metering API

All four endpoints take the team's ordinary API key as a bearer token and return the team's figures. Whether calling them consumes credits is not stated anywhere in the docs, and no rate limit is published for them: **UNCONFIRMED** (the billing table lists no cost for them, and the docs say polling job status is free).

### 3.1 `GET /v2/team/credit-usage`

Source: https://docs.firecrawl.dev/api-reference/endpoint/credit-usage

```json
{
  "success": true,
  "data": {
    "remainingCredits": 1000,
    "planCredits": 500000,
    "billingPeriodStart": "2025-01-01T00:00:00Z",
    "billingPeriodEnd": "2025-01-31T23:59:59Z"
  }
}
```

- `planCredits` excludes coupon credits and pay-as-you-go credits. Period fields are nullable.
- Errors: `404` `{"success": false, "error": "Could not find credit usage information"}`; `500`.

### 3.2 `GET /v2/team/credit-usage/historical?byApiKey=true|false`

Source: https://docs.firecrawl.dev/api-reference/endpoint/credit-usage-historical

```json
{
  "success": true,
  "periods": [
    {
      "startDate": "2025-01-01T00:00:00Z",
      "endDate": "2025-01-31T23:59:59Z",
      "apiKey": null,
      "totalCredits": 1000
    }
  ]
}
```

- Month-by-month. With `byApiKey=true`, `apiKey` holds the **name** of the key (not the secret), giving one row per key per period. This is the only documented per-key usage breakdown over REST.
- The MCP tool `firecrawl_credit_usage` is described as returning "what credits were spent on by month or day, optionally split by endpoint or API key", which is finer than the published REST parameters (only `byApiKey`). A REST equivalent for daily or per-endpoint splits is UNCONFIRMED.

### 3.3 `GET /v2/team/token-usage` and `/historical`

Present in the OpenAPI spec, labelled "Extract only", and absent from the docs navigation. Same shapes with `remainingTokens`, `planTokens`, and `totalTokens`. Given that Extract now bills in credits and is removed on 2026-12-10, treat these as legacy. Source: OpenAPI

### 3.4 Other account endpoints

- `GET /v2/team/queue-status` → `{success, jobsInQueue, activeJobsInQueue, waitingJobsInQueue, maxConcurrency, mostRecentSuccess}`. Source: https://docs.firecrawl.dev/api-reference/endpoint/queue-status
- `GET /v2/team/activity?endpoint=&limit=&cursor=` → last 24 hours of jobs: `{success, data: [{id, endpoint, api_version, created_at, target}], cursor, has_more}`. No credit figure per row. Source: https://docs.firecrawl.dev/api-reference/endpoint/activity
- CLI: `firecrawl credit-usage [--json --pretty]` and `firecrawl --status` (prints concurrency and remaining credits). Source: https://docs.firecrawl.dev/sdks/cli

### 3.5 Per-response usage fields

- Scrape: `data.metadata.creditsUsed` — **observed** in a live keyless response (value `1`, alongside `cacheState`, `cachedAt`, `proxyUsed`, `concurrencyLimited`, `scrapeId`). It is not described in the OpenAPI schema.
- Search: top-level `creditsUsed` and `id`. Source: OpenAPI
- Crawl status and batch scrape status: top-level `creditsUsed`. Source: OpenAPI
- Agent status and trace: `creditsUsed`. Source: OpenAPI
- Monitor check: `estimatedCredits`, `actualCredits`, per-page `creditsUsed`. Source: https://docs.firecrawl.dev/features/monitoring
- Provider-routed scrape: `metadata.provider.creditsCost` and `metadata.provider.steps`. Source: https://docs.firecrawl.dev/billing
- UltraSearch: `answer.credits` (`search`, `provider`, `max_credits`, ...). Source: https://docs.firecrawl.dev/mcp-server/tools
- Extract status: `tokensUsed`. Source: OpenAPI

### 3.6 Headers

- The live 200 response carried no rate-limit or remaining-credit headers (only `content-type`, `etag`, `x-response-time`, CORS). Observed, single request.
- `429` responses include `Retry-After` (seconds) "when available". Source: https://docs.firecrawl.dev/api-reference/errors
- There is no documented `X-RateLimit-*` family; the string does not appear in the OpenAPI spec.

---

## 4. Key management

- **No public REST or CLI operation creates, lists, or revokes ordinary team API keys.** The v2 OpenAPI has no key-management path. Creation, viewing, renaming, spend limits and revocation are on the dashboard API keys page. "Your account must always have at least one active API key, so to revoke a key you will need to create a new one first." Source: https://docs.firecrawl.dev/dashboard, https://docs.firecrawl.dev/billing
- Keys are **per team**. "A key has full access to the team that owns it." Keys "do not have permissions or an expiry date" (per-key format and endpoint restrictions exist but are an enterprise feature). Deleted keys are hard-deleted. Source: https://docs.firecrawl.dev/authentication, https://docs.firecrawl.dev/firecrawl-for-platforms, https://docs.firecrawl.dev/features/key-restrictions
- Programmatic routes that do exist, each for a specific situation:
  - **Platforms (partner) API**, base `https://integrations.firecrawl.dev`, authenticated with a platform key created in the dashboard (self-serve, no approval): `POST /partner/v1/accounts` `{email}` → `{apiKey, alreadyExisted}`; `POST /partner/v1/api-keys/validate` `{apiKey}` → `{teamName, email}`; `POST /partner/v1/api-keys/rotate` `{apiKey}` → `{apiKey}` (deletes the old key, mints a new one for the same team). Works only for keys the integration created. It is intended for platforms provisioning accounts for their users, who must be prompted to accept the Terms. Unverified integrations are volume-limited and their accounts "carry no free credits"; verification needs a card, and "a card can verify only one organization". Source: https://docs.firecrawl.dev/firecrawl-for-platforms
  - **OAuth for apps**: `fco_` access token plus rotating `fcr_` refresh token; each connection gets its own hidden key; RFC 7009 revocation at `https://www.firecrawl.dev/api/oauth/revoke`. Source: https://docs.firecrawl.dev/oauth
  - **MCP OAuth**: a dedicated key per connection, revocable under Connected apps; tokens work only on the MCP server. Source: https://docs.firecrawl.dev/authentication
  - **Agent registration** (`POST https://www.firecrawl.dev/agent/auth` with a WorkOS ID-JAG assertion) returns an API key; limited to 60 registrations per hour per IP. "If the assertion maps to an existing Firecrawl user, this flow mints another API key for that user's existing team and does not grant separate credits." Source: https://www.firecrawl.dev/auth.md
  - **CLI browser login** (`firecrawl login`, `firecrawl init --browser`) obtains and stores a key after a human approves in the browser. Source: https://docs.firecrawl.dev/sdks/cli
- **Teams**: a user can belong to more than one team (the dashboard has a team selector; integrations such as an automation-platform connector or a payments-CLI integration create a separate linked team). Source: https://docs.firecrawl.dev/integrations/n8n, https://docs.firecrawl.dev/integrations/stripe-projects
- "Multi-team organizations — An organization can run more than one team, and our team sets that up for you" is listed as Not available on Free, Hobby and Standard and "Contact support" on Growth, Scale and Enterprise. Pooled credits across teams is an enterprise feature. Source: https://www.firecrawl.dev/pricing, https://docs.firecrawl.dev/enterprise
- Whether a self-serve user can create additional teams from the dashboard, and whether each such team receives its own 1,000-credit free allotment: **UNCONFIRMED**. Documented data points: a new account gets the Free allowance; an extra key on an existing team gets no separate credits; partner offers apply "once per user per partner".

Practical consequence for metering: rotation across keys of the **same team** gains nothing, because credits and rate-limit counters are per team. Per-key attribution is available through key names in the historical endpoint and through per-key spend limits.

---

## 5. Error signalling

Common shape: `{"success": false, "error": "<message>", "code": "<optional>", "details": <optional>, "jobId": "<optional>"}`. Source: https://docs.firecrawl.dev/api-reference/errors

| Situation | Status | Body |
| - | - | - |
| Credits exhausted | `402` | `error: "Payment Required: Insufficient credits"`; the scrape schema example is `{"success": false, "error": "Payment required to access this resource.", "code": "insufficient_credits", "chargeId": "...", "jobId": "..."}`. Listed as not retryable |
| Per-key spend limit reached | `402` | stated for crawl pre-flight (https://docs.firecrawl.dev/billing); exact body UNCONFIRMED |
| Gateway-funded account out of credits | `402` | `code: "platform_managed_credits"` |
| Per-minute rate limit | `429` | `error: "Rate limit exceeded"` / "Request rate limit exceeded. Please wait and try again later."; no `code`; `Retry-After` header when available |
| Concurrency or queue cap | `429` | `error: "Concurrency limit reached"` |
| Index daily cap | `429` | `code: "INDEX_DAILY_LIMIT"` (or `index_daily_limit` from Alexandria) with `limit`, `used`, `resetsAt`, `upgradeUrl`; `Retry-After` until 00:00 UTC |
| Index per-minute cap via Alexandria | `429` | `code: "index_rate_limit"`, `retryAfterSeconds` |
| Keyless cap | `429` (also `403`) | per-IP daily request cap and daily credit cap; refusals carry a `signup_url` and a `WWW-Authenticate` header pointing at OAuth metadata. Source: https://docs.firecrawl.dev/rate-limits, https://www.firecrawl.dev/auth.md, https://www.firecrawl.dev/agent-onboarding/SKILL.md |
| Missing or revoked key | `401` | `Unauthorized: Invalid token`; empty bearer gives `Unauthorized: Token missing` |
| Key lacks permission | `403` | `Forbidden` |
| Agent `maxCredits` reached | no HTTP error | job `status: "failed"`, `stopReason: "credit_limit_reached"` |
| Monitor out of credits | no HTTP error | check status `skipped_no_credits` |

A wrapper can therefore distinguish "out of credits" (`402`, do not retry on this key) from "slow down" (`429`, honour `Retry-After`). The docs' own retry set is 408, 429, 500, 502, 503, 504.

---

## 6. MCP, CLI and agent skills

### 6.1 Hosted MCP

Source: https://docs.firecrawl.dev/mcp-server, https://docs.firecrawl.dev/mcp-server/keyless, https://docs.firecrawl.dev/mcp-server/oauth, https://docs.firecrawl.dev/authentication

| Mode | URL | Credential | Tools |
| - | - | - | - |
| Keyless | `https://mcp.firecrawl.dev/v2/mcp` | none | `firecrawl_search`, `firecrawl_scrape`, `firecrawl_parse` only |
| API key | `https://mcp.firecrawl.dev/v2/mcp` | `Authorization: Bearer fc-...` header | full surface, subject to plan and team policy |
| OAuth | `https://mcp.firecrawl.dev/v2/mcp-oauth` | browser sign-in; a hidden per-connection key | full surface |

- Transport: Streamable HTTP. The current docs show header auth only; a key-in-URL form is not documented on the current pages (UNCONFIRMED whether an older URL-embedded-key form still works).
- Keyless limits: free, per IP per day, with both a request cap and a credit cap; the numbers are not published ("The limits vary with demand"). Keyless REST also covers Interact and, on cloud, the research, developer and government search endpoints. Source: https://docs.firecrawl.dev/rate-limits
- Native connectors exist for the major chat assistants and use the OAuth flow.

### 6.2 Tool list (hosted, authenticated)

Source: https://docs.firecrawl.dev/mcp-server/tools

- Core: `firecrawl_scrape`, `firecrawl_search`, `firecrawl_map`, `firecrawl_parse`, `firecrawl_crawl`, `firecrawl_check_crawl_status`
- Agent: `firecrawl_agent`, `firecrawl_agent_status`
- Browser: `firecrawl_interact`, `firecrawl_interact_stop`
- Indexes: `firecrawl_developer_search`, `firecrawl_gov_search`, `firecrawl_research_search_papers`, `firecrawl_research_inspect_paper`, `firecrawl_research_read_paper`, `firecrawl_research_related_papers`, `firecrawl_research_lookup_protein`
- Alexandria: `alexandria_library_search` (read-only shell over the catalogue filesystem), `alexandria_library_read` (run 1 to 10 capabilities per call), `people_company_search`, `people_company_enrich`, `jobs_search`, `firecrawl_save_skill`
- Monitoring: the `firecrawl_monitor_*` family (create, list, update, run, inspect, delete)
- Account: `firecrawl_credit_usage`
- Feedback: `firecrawl_search_feedback`, `firecrawl_feedback` (eligible feedback refunds 1 credit, capped per day)
- Legacy, still answered but no longer listed: `firecrawl_find_tools`, and `firecrawl_scrape` with an `alexandria` body
- Removed: `firecrawl_extract`

### 6.3 Local MCP server

- npm `firecrawl-mcp` (docs pin `3.40.0`), Node 22+, stdio by default or `HTTP_STREAMABLE_SERVER=true` (serves `http://localhost:3000/mcp`). Env: `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL` (self-hosted). `jobs_search`, `firecrawl_save_skill` and `firecrawl_research_lookup_protein` are hosted-only at 3.40.0. Source: https://docs.firecrawl.dev/mcp-server/local, https://docs.firecrawl.dev/mcp-server/tools
- Naming note: the changelog has an entry "Introducing Firecrawl MCP v3" dated 2026-11-12 and an older v2.2.0 entry (2025-09-12) that also mentions "MCP Version 3"; the npm package was already on major version 3.

### 6.4 CLI

Source: https://docs.firecrawl.dev/sdks/cli

- npm `firecrawl-cli` (docs show v1.16.2). Install for agents: `npx -y firecrawl-cli@latest init --all --browser`.
- Auth: `firecrawl login` (browser or `--api-key`), `FIRECRAWL_API_KEY`, `--api-key/-k` per command, `firecrawl logout`. Custom API URL for self-hosted or Firecrawl Local. Some commands fall back to the keyless tier when no key is configured.
- Commands: `scrape`, `search`, `find-tools`, `alexandria feedback`, `developer`, `gov`, `research ...`, `map`, `interact`, `crawl`, `monitor`, `agent`, `parse`, `credit-usage`, `--status`.
- There is no key-management command.

### 6.5 Agent skills

- CLI skills in the `firecrawl/cli` repository `skills/` directory (listed via the GitHub API today): `firecrawl`, `firecrawl-agent`, `firecrawl-alexandria`, `firecrawl-crawl`, `firecrawl-developer-index`, `firecrawl-download`, `firecrawl-interact`, `firecrawl-map`, `firecrawl-monitor`, `firecrawl-parse`, `firecrawl-research-index`, `firecrawl-scrape`, `firecrawl-search`. Source: https://github.com/firecrawl/cli/tree/main/skills
- Build skills (integrating Firecrawl into application code): https://github.com/firecrawl/skills
- Workflow skills (research briefs, audits, lead lists and similar): https://github.com/firecrawl/firecrawl-workflows
- Onboarding documents aimed at agents: https://www.firecrawl.dev/agent-onboarding/SKILL.md and https://www.firecrawl.dev/auth.md
- Single-skill install example: `npx -y firecrawl-cli@latest setup developer-index`. Source: https://docs.firecrawl.dev/features/developer

---

## 7. Terms of Service on multiple accounts and limit circumvention

Document: https://www.firecrawl.dev/terms-of-service, "Date of last revision: October 7, 2026".

**Finding: the Terms do not address this explicitly.** A search of the full text found no clause about creating multiple accounts, holding multiple free-tier keys, or circumventing usage or rate limits. The words "multiple", "circumvent", "rate limit" and "free plan" do not appear in the agreement body.

Clauses that could be applied to such behaviour, quoted exactly:

- 3: "You agree not to provide any other person with access to this Service or portions of it using your username, password, or other security information."
- 5.b: "You represent and warrant that all information you submit when Employing the Services is complete, accurate, and truthful."
- 5.d.11 (prohibited): "Behave in any way that negatively impacts the customer experience of other users of our Services."
- 8.b: "we reserve an unrestricted right to refuse, terminate, block, or cancel your application to, account with, or access to the Services at any time, with or without cause."
- 8.b.2 and 8.b.3 (listed reasons for termination): "You hinder or interfering with us in providing our Services;" and "You make misrepresentations or otherwise deceive Firecrawl; and,"
- 5.d.1 (prohibited): "Use the Services for any commercial purposes except as expressly authorized by Firecrawl;"

Signals outside the Terms:

- "Rate limits are measured in requests per minute and are primarily in place to prevent abuse." Source: https://docs.firecrawl.dev/rate-limits
- Free credits are tied to the account and team; a second key for an existing user "does not grant separate credits". Source: https://www.firecrawl.dev/auth.md
- Partner promotional credits apply "once per user per partner". Source: https://docs.firecrawl.dev/partner-credits
- Signup can be refused for an address (`signup_not_permitted`, `partner_provisioning_email_rejected`), which indicates sign-up screening exists. Source: https://www.firecrawl.dev/auth.md, https://docs.firecrawl.dev/firecrawl-for-platforms

Assessment: rotating across several free-tier accounts held by one person is **not expressly prohibited and not expressly permitted** by the published Terms; it is unaddressed. The vendor keeps an unrestricted right to terminate with or without cause, and the design of the free tier (per-team credits, once-per-user offers) shows the intent is one allotment per user. Not reviewed: the privacy policy, the Third-Party Data Terms (https://www.firecrawl.dev/terms/third-party-data), partner agreements, and any terms shown only during sign-up.

Sanctioned ways to get more free or cheap usage that the docs do describe: the keyless tier (per IP), the free Government and Research indexes, 5 free agent runs per day, feedback refunds (1 credit each, capped at 100 per team per day), credit coupons, and the Hobby plan.

---

## 8. Self-hosting

Source: https://docs.firecrawl.dev/contributing/self-host, https://docs.firecrawl.dev/contributing/open-source-or-cloud, https://docs.firecrawl.dev/quickstarts/firecrawl-local

Still viable for the core in late 2026, in two forms.

**Docker Compose stack** (API, workers, PostgreSQL, Redis, RabbitMQ, Playwright service; default port 3002):

| Capability | Self-hosted default stack |
| - | - |
| Scrape, crawl, map, search routes | Included (search through a self-configured backend; SearXNG support dates from v1.5.0) |
| LLM-backed extraction and formats | Bring an OpenAI-compatible provider or Ollama |
| Fire-engine and advanced anti-bot | Not included |
| Screenshots and page actions | Not available in the default stack (both need Fire-engine) |
| Agent, Browser, Interact, feedback, product/menu/audio/video formats | Cloud only |
| Alexandria, Developer/Government/Research indexes, UltraSearch, hosted MCP, dashboard, credits and metering | Cloud only |
| Auth, TLS, persistence, monitoring | Operator's responsibility; the baseline is unauthenticated (`USE_DB_AUTHENTICATION=false`) and must not be exposed publicly |

The vendor does not publish a verified minimum host size.

**Firecrawl Local** (announced 2026-11-18): one Rust binary (`cargo install firecrawl-local`), no database or queue, serves the v2 API on localhost and can launch the MCP server. Scrape, crawl, map and document parsing run on the machine. Search, pages that block the machine, and Alexandria go to Firecrawl Cloud unless disabled with `FIRECRAWL_CLOUD=off` (values `auto`, `search`, `off`); cloud calls carry a random install id. Limits: no `json` or `summary` formats, browser `actions` ignored, screenshots need a local Chrome, jobs held in memory, no v0 or v1 routes. Vendor claims: 37x faster than self-hosted, 230x less memory (11 MB idle), "100% open source under the same license".

Licence: the repository has historically been AGPL-3.0; the licence text was not re-read today: UNCONFIRMED.

---

## 9. What a mid-2026 wrapper is probably missing

1. **`/extract` goes away on 2026-12-10 15:00 UTC** (`410 Gone`). Any extract path must move to scrape JSON format, batch scrape, or agent.
2. **Alexandria**: tool discovery through `/search` `sources: ["alexandria"]` and execution through `/scrape` with an `alexandria` body, including variable per-tool prices and the terms-acceptance error.
3. **Specialised indexes**: `/search/developer` (paid), `/search/gov` (free), `/search/research/papers...` (free), plus the `developer` and `gov` search categories; the `github` category now returns `400`.
4. **Free and keyless capacity**: Government and Research indexes cost no credits; scrape, search, parse and interact work with no key at all under per-IP caps.
5. **Variable-cost scrapes**: profile URLs routed to enrichment providers (5 to 40 credits), X URLs (30 credits), and the +4 surcharges for question, highlights, audio, video, PII redaction and prompt-injection checks. A flat "1 credit per scrape" assumption is wrong.
6. **Per-response `creditsUsed`** on scrape metadata, search, crawl, batch and agent responses, which allows local metering without polling.
7. **Metering endpoints**: `/team/credit-usage`, `/team/credit-usage/historical?byApiKey=true`, `/team/queue-status`, `/team/activity`; and per-key spend limits set in the dashboard.
8. **402 versus 429 handling**, the `Retry-After` header, and the distinct `INDEX_DAILY_LIMIT` code.
9. **`/parse`, `/monitor`, standalone `/interact` sessions, agent traces, snapshots, threads and `maxCredits` partial results.**
10. **Search changes**: highlights on by default, `answer` (UltraSearch) on MCP searches, search feedback refunds.
11. **Firecrawl Local** as a zero-credit local backend that speaks the same v2 API.
12. **Key rotation reality**: credits and rate limits are per team, so same-team key rotation adds no capacity; there is no general key-management API.

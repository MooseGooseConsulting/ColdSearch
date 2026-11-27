# Exa — product surface, billing, and key metering (2026-11-27)

- Researched: 2026-11-27, by reading Exa's public documentation, OpenAPI specs, pricing page, terms PDF and GitHub READMEs. No Exa endpoint was called with a key; nothing here is an observed API response.
- This is a dated evidence snapshot from vendor docs. Prices, limits, latency and quality figures are vendor claims and are labelled as such; they will drift.
- Not confirmed: current keyless-MCP limits (only a Feb 2026 changelog figure exists), whether a free (Starter) team can get the Team Management API enabled, what "billing period" means for a prepaid team's key budget, the exact 429 response body, and whether any Exa-published CLI exists (none was found). Items are marked UNCONFIRMED inline.

Primary sources used throughout:

- Docs index: https://exa.ai/docs/llms.txt (https://docs.exa.ai/llms.txt serves the same file)
- Public API spec: https://exa.ai/docs/exa-spec.yaml
- Team Management spec: https://exa.ai/docs/team-management-spec.yaml
- Changelog: https://exa.ai/docs/changelog.md
- Pricing: https://exa.ai/docs/admin/pricing.md and https://exa.ai/pricing
- Billing and rate limits: https://exa.ai/docs/admin/billing.md
- Error codes: https://exa.ai/docs/admin/error-codes.md
- Deprecations: https://exa.ai/docs/reference/deprecations.md
- Agent auth guide: https://exa.ai/auth.md
- Terms of Service (PDF): https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf (https://exa.ai/terms redirects here)

Every docs page has a markdown twin at the same path with `.md` appended, which is the cheapest way to re-check any fact below.

---

## 1. Product surface

Base URL `https://api.exa.ai`. Auth: `x-api-key: <key>` or `Authorization: Bearer <key>` (https://exa.ai/auth.md).

### 1.1 Endpoint families

Paths are from https://exa.ai/docs/exa-spec.yaml unless noted.

| Family | Paths | Status / notes | Source |
| - | - | - | - |
| Search | `POST /search` | Core. Contents for results are returned inline. Supports `outputSchema`, `systemPrompt`, `stream`, `additionalQueries` (deep types only). Responses now carry `warnings` and `notices` arrays. | https://exa.ai/docs/search/quickstart.md |
| Contents | `POST /contents` | Text, highlights, summary per URL; `subpages` / `subpageTarget` crawl; `maxAgeHours` freshness; `snapshotAsOf`. Per-URL failures arrive in `statuses` on a 200. | https://exa.ai/docs/contents/quickstart.md |
| Answer | `POST /answer` | LLM answer with citations. | https://exa.ai/docs/reference/answer.md |
| Agent | `POST /agent/runs`, `GET /agent/runs`, `GET/DELETE /agent/runs/{id}`, `POST /agent/runs/{id}/cancel`, `POST /agent/runs/{id}/stop`, `GET /agent/runs/{id}/events` | New June 16, 2026. Async research / list-building / enrichment. See 1.4. | https://exa.ai/docs/agent/quickstart.md |
| Monitors | `/monitors`, `/monitors/batch`, `/monitors/{id}`, `/monitors/{id}/trigger`, `/monitors/{id}/runs`, `/monitors/{id}/runs/{runId}` | New March 30, 2026; "v2" Oct 29, 2026. Scheduled search (min interval 1 hour) delivered to a webhook, deduplicated against earlier runs. | https://exa.ai/docs/monitors/quickstart.md |
| Batch | `/batches`, `/batches/{id}`, `/batches/{id}/cancel` | Beta, Enterprise only, needs header `Exa-Beta: batches-2026-06-06`. Items may target `/search` or `/agent/runs`; results as JSONL. | https://exa.ai/docs/batch/quickstart.md |
| Websets | `/v0/websets…`, `/v0/imports`, `/v0/monitors`, `/v0/webhooks`, `/v0/events`, `/v0/teams/me` | Verified, enriched datasets. Now usage-priced from the shared credit balance. | https://exa.ai/docs/websets/quickstart.md |
| OpenAI-compatible | `/chat/completions`, `/responses` | Drop-in for the OpenAI SDK; `/responses` fronts Exa Agent. | https://exa.ai/docs/integrations/openai-sdk.md, https://exa.ai/docs/admin/billing.md |
| Team Management | `https://admin-api.exa.ai/team-management/…` | Separate host and separate (service) key. See section 3. | https://exa.ai/docs/team-management-spec.yaml |
| Keyless payment | `/search` and `/contents` via x402 (USDC) or MPP (Tempo) | No API key; pay per request. | https://exa.ai/docs/integrations/payments/x402/quickstart.md |

Deprecated or removed (https://exa.ai/docs/reference/deprecations.md):

| Item | Status |
| - | - |
| `/research/*` | Removed; returns HTTP 410 (retired April 1, 2026). Use Deep Search or Agent. |
| `POST /findSimilar` | Deprecated; "Search has no direct URL-similarity equivalent". |
| `POST /context` (Exa Code) | Deprecated; use `/search` with `contents.highlights`. |
| `contents.subpages` / `contents.subpageTarget` on `/search` | Deprecated; pass result URLs to `/contents` with `subpages`. |
| `contents.livecrawl` | Deprecated; use `maxAgeHours` (`0` always fetch, `-1` cache only). |
| `contents.context` | Deprecated. |
| `includeText` / `excludeText` | Deprecated. |
| `crawledBeforeDate` | Deprecated; renamed `snapshotAsOf`. |
| `highlights.numSentences` | Deprecated; use `highlights.maxCharacters`. |
| `highlights.highlightsPerUrl`, `useAutoprompt`, `startCrawlDate` / `endCrawlDate` | Ignored. |
| `resolvedSearchType` | Deprecated; "can be an empty string. Do not branch on it." |
| `results[].highlightScores` | Removed May 1, 2026. |
| `results[].score` with `type: "auto"` | Not returned. |
| `category: "tweet"` | Removed; HTTP 400. `pdf` and `github` categories "being deprecated" (changelog July 23, 2026). `research paper` replaced by `publication`. |

### 1.2 Search `type` values

From the `type` schema in https://exa.ai/docs/exa-spec.yaml and https://exa.ai/docs/search/quickstart.md. The enum is marked open (`x-exa-enum-open: true`). Latencies are vendor claims.

| `type` | Status | Vendor-stated latency | Notes |
| - | - | - | - |
| `auto` | Recommended, default | ~1 s | Accepts the full parameter set. |
| `lite` | Recommended, new Oct 19, 2026 | ~200 ms | Cache only, never fetches live. Small parameter set; any unsupported parameter returns `400 INVALID_REQUEST_BODY` naming it. No `outputSchema`, `systemPrompt`, `stream`, `additionalQueries`, `contents.summary`. |
| `deep-lite` | Recommended | ~4 s | Lightweight synthesis. |
| `deep` | Recommended | 4–15 s | Multi-step search with synthesis; `outputSchema` gives `output.content` and `output.grounding`. |
| `instant` | Legacy (launched Feb 5, 2026) | sub-150 ms at launch | Use `lite`. Still accepts every parameter. |
| `fast` | Legacy | — | Use `lite` ("runs the same search as `fast`") or `auto`. |
| `deep-reasoning` | Legacy (launched March 4, 2026) | 12–40 s | Use `deep` or Agent. |
| `neural`, `keyword` | Not in the current `type` enum | — | `costDollars.search` still has `neural` and `keyword` sub-fields, and the changelog's July 2025 entry still mentions `type="neural"`. Whether the API still accepts `neural` is UNCONFIRMED. |

`lite` accepted parameters (spec text): `query` (single string), `objective`, `userIdentifier`, `metadata`, `category`, `numResults`, `contents.highlights`, `contents.text`, `contents.snapshotAsOf`, `userLocation`, `includeDomains`, `excludeDomains`, `startPublishedDate`, `endPublishedDate`, `moderation`, `compliance`.

### 1.3 Other additions since early 2026

All dates from https://exa.ai/docs/changelog.md.

| Date | Change |
| - | - |
| Nov 13, 2026 | Exa Search available in the EU (data residency; Enterprise per pricing page). |
| Oct 29, 2026 | Monitors v2: price cut to $2 / 1k requests from $15; structured output with `output.grounding`. |
| Oct 29, 2026 | Podcasts index (vendor claim: 3.2M episodes with transcripts), no extra cost. |
| Oct 19, 2026 | `lite` type; recommended types become `lite` / `auto` / `deep`; `warnings` and `notices` in search responses; SDKs 2.26.0 log warnings. |
| Oct 5, 2026 | Places index (vendor claim: 211M places), no extra cost. |
| Sep 24, 2026 | Agent Ultra (`effort: "ultra"`), `budget.maxDurationSeconds`, `POST /agent/runs/{id}/stop`. |
| Sep 17, 2026 | Exa Snapshot (research preview): `contents.snapshotAsOf` on `/search`, `snapshotAsOf` on `/contents`. Not on the free plan. |
| Aug 28, 2026 | Dynamic Highlights (research preview): `dynamic: true` plus header `Exa-Beta: dynamic-highlights-2026-08-28`. |
| Jul 23, 2026 | `publication` category replaces `research paper`; `pdf`, `github`, `tweet` categories deprecated. |
| Jul 1, 2026 | Exa Agent and Exa Connect exposed in MCP as `agent_run`. |
| Jun 24, 2026 | Exa Connect (partner data sources for Agent). |
| Jun 16, 2026 | Exa Agent API. |
| Apr 28, 2026 | Exa on Google Cloud (Gemini grounding, private preview). |
| Apr 1, 2026 | `/research` retired; `resolvedSearchType`, `highlightScores` removed; crawl-date params ignored. |
| Mar 30, 2026 | Monitors introduced. |
| Mar 4, 2026 | Deep revamp: `deep-reasoning`, structured outputs with field-level grounding, 20% lower `deep` price. |
| Mar 3, 2026 | Pricing simplification: contents for the first 10 results included in the search price. |
| Feb 5, 2026 | `instant` type. |
| Feb 2, 2026 | `maxCharacters` for highlights, `maxAgeHours`, keyless MCP free tier (3 QPS, 150 calls/day). |

### 1.4 Exa Agent

Sources: https://exa.ai/docs/agent/quickstart.md, https://exa.ai/docs/agent/agent-ultra.md, https://exa.ai/docs/agent/connect/overview.md, https://exa.ai/docs/exa-spec.yaml.

- What it is: "an async, usage-based web research agent API for high-compute tasks like list building, enrichment, and deep research." Launched June 16, 2026.
- Create: `POST https://api.exa.ai/agent/runs`. Returns the run object immediately; poll `GET /agent/runs/{id}` until `status` is `completed`, `failed` or `cancelled`, or send `Accept: text/event-stream` to stream. Events: `agent_run.created`, `.started`, `.completed`, `.failed`, `.cancelled`. Stored events replay from `GET /agent/runs/{id}/events` (with `Last-Event-ID`).
- Request fields: `query`, `effort`, `systemPrompt`, `outputSchema`, `input.data` (rows to enrich), `input.exclusion` (results to skip), `dataSources` (up to five Connect providers), `previousRunId`, `budget.maxCostDollars` ($1–$100), `budget.maxDurationSeconds` (ultra; 5 minutes to 3 hours), `metadata`, `userIdentifier`.
- `effort` values: `minimal`, `low`, `medium`, `high`, `xhigh`, `auto` (default), `ultra`.
- Output: `output.text`, `output.structured` (schema-validated JSON), `output.grounding` (citations per field), `usage`, `costDollars`.
- Continuation has two distinct meanings:
  - `previousRunId` (API and MCP): starts a new run that inherits context from a finished run.
  - `runId` (MCP only): the `agent_run` tool returns `status: "running"` with an `id` if research outlasts one MCP call; calling `agent_run` again with that id as `runId` resumes waiting on the same run (https://exa.ai/docs/get-started/exa-mcp.md).
- "Coverage validation" is not an API feature. The phrase comes from the description of Exa's `exa-agent` skill, which instructs the calling agent to check segment coverage and avoid claiming exhaustiveness (https://github.com/exa-labs/exa-mcp-server/blob/main/skills/exa-agent/SKILL.md). Schema adherence "validates shape, not facts" (https://exa.ai/docs/agent/best-practices.md).
- Exa Connect: partner databases attached with `dataSources: [{"provider": "<id>"}]`. Provider ids named in the skill: `fiber`, `financial_datasets`, `similarweb`, `baselayer`, `affiliate`, `particle`, `jinko`. The docs additionally list Polymarket and Macrobond (`macrobond`), plus request-only "additional partners". The pricing page lists "Third-party data sources in Exa Agent" under the Developer (paid) plan, so Connect on the free plan is UNCONFIRMED.
- Limits: 50 active runs per team on Starter, Developer and Growth; each run start counts as two requests against QPS; polling GETs are not counted (https://exa.ai/docs/admin/billing.md).
- Zero Data Retention teams: no `previousRunId`, no `runId` resumption, only `fiber`, `baselayer`, `macrobond`, `jinko` providers.

---

## 2. Billing model

### 2.1 Per-operation prices

Source: https://exa.ai/docs/admin/pricing.md. Base price includes up to 10 results with text and highlights.

| Operation | Base price | Each result above 10 | AI page summaries |
| - | - | - | - |
| `/search` `lite` | $4 / 1k requests | $1 / 1k results | not available |
| `/search` `instant` (legacy) | $4 / 1k requests | $1 / 1k results | $1 / 1k pages |
| `/search` `auto`, `fast` | $7 / 1k requests | $1 / 1k results | $1 / 1k pages |
| `/search` `deep-lite`, `deep` | $12 / 1k requests | same as search | same as search |
| `/search` `deep-reasoning` (legacy) | $15 / 1k requests | same as search | same as search |
| `/answer` | $5 / 1k requests | — | — |
| `/monitors` | $2 / 1k requests | $1 / 1k results | $1 / 1k pages |
| `/contents` | $1 / 1k pages, per content type (`text`, `highlights`, `summary` each count) | — | $1 / 1k pages |

Agent (same source):

| Effort | Price |
| - | - |
| `minimal` | $0.012 / request |
| `low` | $0.025 / request |
| `medium` | $0.10 / request |
| `high` | $0.50 / request |
| `xhigh` | $1.00 / request |
| `auto` | Metered, default cap $5 per run |
| `ultra` | Metered, default cap $20 per run |

Metered components: $0.10 per Agent Compute Unit, $0.005 per search tool call, $0.02 per email found, $0.07 per phone number found. When a metered run exceeds `budget.maxCostDollars` it is billed the budget (spec, `AgentUsage` description).

Exa Connect, added on top of the run price (https://exa.ai/docs/agent/connect/overview.md):

| Provider | Price |
| - | - |
| Fiber.ai | $0.02 / credit (search = 2 credits + 1 per result; contact reveal 2–5 credits) |
| Similarweb | $0.30 / credit (1–15 credits per call) |
| Baselayer | Varies: $0.10 to $4.00 per operation |
| Polymarket | Free |
| Macrobond | Free |
| Affiliate.com | $0.015 / call |
| Particle | $0.015 / call |
| Financial Datasets | $0.01 / call |
| Jinko | $0.005 / call |

Websets: $0.10 / ACU plus $5 / 1k searches, drawn from the same team credit balance (https://exa.ai/docs/websets/pricing.md).

x402 keyless: same base prices, computed up front, results capped at 10 (https://exa.ai/docs/integrations/payments/x402/quickstart.md). World AgentKit gives each verified human 100 free keyless requests per calendar month (https://exa.ai/docs/integrations/payments/x402/agentkit.md).

### 2.2 Plans, free tier, rate limits

Source: https://exa.ai/docs/admin/billing.md and https://exa.ai/pricing.

| Plan | Billing | General QPS | Agent |
| - | - | - | - |
| Starter (free) | $10 credits per month plus a one-time $10 onboarding bonus; no payment method | 10 | 50 active runs |
| Developer | Prepaid credits, no subscription or minimum | 25 (50 for 90 days after buying $1,000 of credits in a 30-day window) | 50 active runs |
| Growth | "$1k /mo, billed annually", paid up front as prepaid credits | 50 | 50 active runs |
| Enterprise | Custom, optional postpaid | Custom | Custom |

Per-endpoint limits:

| Endpoint | Starter | Developer | Growth |
| - | - | - | - |
| `/search`, `/answer`, `/chat/completions` | 10 QPS | 25 QPS | 50 QPS |
| `/search` with a deep type | 5 QPS | 12 QPS | 25 QPS |
| `/contents` | 100 QPS | 100 QPS | 100 QPS |
| `/agent/runs`, `/responses` | 5 QPS | 12 QPS | 25 QPS |
| `/websets/*` | 20 QPS | 20 QPS | 20 QPS |

Free-tier rules, quoted from the billing page:

- "Every new team starts on the Starter plan with $10 in credits, available in full the day you sign up regardless of the date. Your free balance then resets to $10 on the first day of every calendar month."
- "The grant does not accumulate: unused free credits from one month do not carry into the next, so this grant never holds more than $10 at a time."
- "Only a user's first team receives the monthly grant."
- "A user's first team also earns a one-time $10 bonus when that user completes onboarding in the dashboard. The bonus does not expire."
- "Free credits spend on API calls at the standard rates and are never paid out or refunded."

So the allotment is monthly-renewing, capped at $10, and tied to a user's first team. A user can create any number of teams (https://exa.ai/docs/admin/team-management.md) but additional teams get no free grant.

Other plan facts: the free plan excludes Exa Snapshot; Snapshot on Developer is limited to 10 QPS and 100 requests before a sales conversation (https://exa.ai/docs/search/snapshot.md). Free and Developer plans allow up to 100 results per search (pricing page). Rate limits "apply to your team as a whole, across all of its API keys."

---

## 3. Usage metering

### 3.1 Per-response cost fields

Search, contents and answer responses carry `costDollars` (schema `CostDollarsOutput`, https://exa.ai/docs/exa-spec.yaml):

```json
{
  "costDollars": {
    "total": 0.007,
    "search": { "neural": 0.007, "keyword": 0.0 },
    "summary": 0.0,
    "contents": { "text": 0.0, "highlights": 0.0, "summary": 0.0 }
  }
}
```

- Only `total` is dependable: "Estimated total dollar cost for the completed request. This response value is not an invoice record." and "Some search types report their cost only in `total`." Which fields appear "depends on the endpoint."
- The documented example for `type: "auto"` is `{"total": 0.007, "search": {"neural": 0.007}}` (https://exa.ai/docs/search/quickstart.md).

Agent runs carry `usage` and `costDollars` (schemas `AgentUsage`, `AgentCostDollars`):

```json
{
  "usage": {
    "agentComputeUnits": 3.2,
    "searches": 41,
    "emails": 0,
    "phoneNumbers": 0,
    "dataSources": { "fiber": 2 }
  },
  "costDollars": {
    "total": 0.565,
    "agentCompute": 0.32,
    "search": 0.205,
    "emails": 0,
    "phoneNumbers": 0,
    "dataSources": { "fiber": 0.04 }
  }
}
```

(Numbers above are illustrative, not from the docs. Field names and required set are from the spec; `dataSources` appears only for providers with non-zero usage.)

There is no balance or quota field in ordinary API responses and no documented rate-limit headers other than `Retry-After` on 429.

### 3.2 Team Management API

Source: https://exa.ai/docs/team-management-spec.yaml and the pages under https://exa.ai/docs/reference/team-management/.

- Base URL: `https://admin-api.exa.ai/team-management`
- Auth: header `x-api-key: <service key>`. The service key is a separate "service account API key … created from the **Service keys** tab on the API keys page once the feature is enabled for your team." (https://exa.ai/docs/admin/team-management.md)
- Availability: "The Team Management API is enabled per team." Access is requested from Exa support. Whether a free team is granted access is UNCONFIRMED.
- Scope: one team per service key. There is no endpoint to create teams or accounts.
- Error bodies here are `{"error": "<message>"}` only, unlike the main API's `{requestId, error, tag}`.

| Method and path | Purpose |
| - | - |
| `POST /api-keys` | Create a key. Body: `name?`, `rateLimit?` (requests per second), `budgetCents?` (integer or null). |
| `GET /api-keys` | List keys. Optional `?api_key_id=<publicId>` returns one. |
| `GET /api-keys/{id}` | Get one key. |
| `PUT /api-keys/{id}` | Update `name`, `rateLimit`, `budgetCents`. |
| `DELETE /api-keys/{id}` | Delete. Returns `{"success": true}`. |
| `POST /api-keys/{id}/rotate` | New secret; old one valid for a grace period. |
| `POST /api-keys/{id}/revoke-previous` | End the grace period now. |
| `GET /api-keys/{id}/usage` | Cost for a key over a period. |
| `GET /credits` | Team's remaining credit balance. |

`{id}` is the key's `publicId` (for example `key_a1B2c3D4e5F6g7H8i9J0`); the current secret is also accepted for backward compatibility. Important quirk: in list/get/update responses the field named `id` **is the key's secret** ("Despite the field name it is not an identifier; use `publicId`"). Treat every response from this API as secret-bearing.

Create:

```bash
curl -X POST 'https://admin-api.exa.ai/team-management/api-keys' \
  -H 'x-api-key: YOUR-SERVICE-KEY' \
  -H 'Content-Type: application/json' \
  -d '{"name": "Production API Key", "rateLimit": 10, "budgetCents": 5000}'
```

```json
{
  "apiKey": {
    "id": "<same value as secret, deprecated>",
    "publicId": "key_a1B2c3D4e5F6g7H8i9J0",
    "secret": "<the API key>",
    "name": "Production API Key",
    "rateLimit": 10,
    "budgetCents": 5000,
    "isOverBudget": false,
    "teamId": "<uuid>",
    "userId": "<uuid>",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

400 examples from the spec: `"Rate limit cannot exceed team's limit of 500 QPS"`, `"Unexpected parameters: invalidParam. Allowed: name, rateLimit, budgetCents."`

List (`GET /api-keys`):

```json
{
  "apiKeys": [
    {
      "id": "<secret>",
      "publicId": "key_…",
      "name": "…",
      "rateLimit": null,
      "budgetCents": null,
      "isOverBudget": false,
      "previousSecretExpiresAt": null
    }
  ]
}
```

Rotate (`POST /api-keys/{id}/rotate`), body `{"gracePeriodSeconds": 86400, "force": false}`. `gracePeriodSeconds` is required, 0 to 7,776,000 (90 days); 0 revokes the old secret immediately. Response example from the spec:

```json
{
  "apiKey": {
    "id": "00000000-0000-4000-8000-000000000000",
    "publicId": "key_a1B2c3D4e5F6g7H8i9J0",
    "secret": "00000000-0000-4000-8000-000000000000",
    "name": "Production API Key",
    "rateLimit": 1000,
    "budgetCents": null,
    "isOverBudget": false,
    "teamId": "cmdz0ppkp0001x7ec2yh4ph46",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "previousSecretExpiresAt": "2026-10-06T12:00:00.000Z"
  }
}
```

The key keeps its `publicId`, name, rate limit, budget and usage history. A key has at most one previous secret; rotating again during the grace period returns 409 with `code: "previous_secret_active"` (or `"rotation_conflict"`) unless `force: true`. Keys "managed by an integration" return 403 and cannot be rotated.

Revoke previous (`POST /api-keys/{id}/revoke-previous`):

```json
{ "apiKey": { "publicId": "key_…", "previousSecretExpiresAt": null }, "revoked": true }
```

Usage (`GET /api-keys/{id}/usage?start_date=…&end_date=…`). `start_date` defaults to 30 days ago and must be within the last 180 days; `end_date` defaults to now. `group_by` (`hour`/`day`/`month`) is accepted but the spec says it "Has no effect on the response." Response example from the spec:

```json
{
  "id": "key_abc123def456",
  "api_key_id": "<the key's secret, kept for backward compatibility>",
  "api_key_name": "Production API Key",
  "team_id": "<uuid>",
  "period": { "start": "2025-01-01T00:00:00Z", "end": "2025-01-31T23:59:59Z" },
  "total_cost_usd": 45.67,
  "cost_breakdown": [
    { "price_id": "price_neural_search", "price_name": "Neural Search", "quantity": 1000, "amount_usd": 30.00 },
    { "price_id": "price_content_retrieval", "price_name": "Content Retrieval", "quantity": 500, "amount_usd": 15.67 }
  ],
  "metadata": { "generated_at": "2025-02-01T10:30:00Z" }
}
```

Credits (`GET /credits`). "Returns the team's remaining prepaid credit balance in USD and the credits that expire. The balance can lag recent usage by up to 5 minutes."

```json
{
  "credits_usd": 412.37,
  "expiring_credits": [ { "amount_usd": 20.00, "expires_at": "2026-12-01T00:00:00Z" } ],
  "metadata": { "generated_at": "2026-11-04T19:00:00Z" }
}
```

`credits_usd` is "Remaining prepaid credits in USD, including granted credits … Requests are refused once it reaches 0 unless overage is enabled for the team." The monthly free grant presumably appears under `expiring_credits` with a first-of-month expiry (the spec's own example shows a $20 lot expiring on the first of the month), but that mapping is UNCONFIRMED. This endpoint can return 429 with `Retry-After`.

### 3.3 Metering without the Team Management API

If the service key is unavailable, the only programmatic signals are: sum `costDollars.total` locally per key (an estimate, per the spec), and treat `402` as the exhaustion signal. The dashboard shows balance and usage but has no documented public API beyond the above.

---

## 4. Key management

- Create, list, get, update, delete and rotate are all available through the Team Management API (section 3.2), with zero-downtime rotation via `gracePeriodSeconds`.
- Per-key rate limit: `rateLimit` in requests per second. It can only be lower than the team limit, and the key's traffic "still counts toward the team limit" (https://exa.ai/docs/admin/billing.md).
- Per-key budget: `budgetCents`, "Spending budget for the API key in the team's current billing period, in cents. It resets when the next billing period starts." Exceeding it returns `402 API_KEY_BUDGET_EXCEEDED`; `isOverBudget` reports state. What "billing period" means for a prepaid or free team is UNCONFIRMED (likely the calendar month).
- A team-level budget also exists (`402 TEAM_BUDGET_EXCEEDED`); the dashboard offers auto-recharge with an optional monthly maximum.
- Keys can also be provisioned through the Stripe Projects CLI (`stripe projects add exa/api`) (https://exa.ai/auth.md) or by a $7 Nevermined purchase that provisions or tops up a key (https://exa.ai/docs/integrations/payments/nevermined.md).
- Multiple teams per account are allowed, each with its own balance and keys, but "Only a user's first team receives the monthly grant." Enterprise customers can group teams under an organization with SSO.
- A key that worked and now returns 401 "has been revoked or rotated" (https://exa.ai/auth.md).

---

## 5. Error signalling

Source: https://exa.ai/docs/admin/error-codes.md.

Body shape for the main API:

```json
{
  "requestId": "67207943fab9832d162b5317f4cca830",
  "error": "Invalid request body | Validation error: Invalid value for type",
  "tag": "INVALID_REQUEST_BODY"
}
```

"Branch on the HTTP status code first and treat unrecognized tags as additional detail rather than parse failures."

| Condition | Status | `tag` | Rotation guidance |
| - | - | - | - |
| Team out of credits | 402 | `NO_MORE_CREDITS` | Every key on that team is dead until top-up or the first-of-month reset. |
| Key over its budget | 402 | `API_KEY_BUDGET_EXCEEDED` | Only that key; other keys on the team still work. |
| Team over its budget | 402 | `TEAM_BUDGET_EXCEEDED` | Whole team. |
| No API key sent | 402 | `X402_PAYMENT_REQUIRED` | A missing key looks like a payment error, not a 401. |
| Bad, revoked or rotated key | 401 | `INVALID_API_KEY` | Do not retry with the same key. |
| Rate or concurrency limit | 429 | `RATE_LIMIT_EXCEEDED`; Agent concurrency uses error code `CONCURRENCY_LIMIT_REACHED` | "wait for `Retry-After` seconds when present, otherwise use exponential backoff." Limits are per team, so rotating to another key on the same team does not help. |
| Exa overloaded | 503 | `SERVICE_OVERLOADED` | Not billed; retry with backoff, independent of your rate. |
| Plan lacks feature | 403 | `FEATURE_DISABLED` | For example Snapshot on the free plan. |
| Policy block | 403 | `PROHIBITED_CONTENT`, `CONTENT_FILTER_ERROR` | Do not retry. |
| Team access revoked | 403 | `TEAM_BLOCKED` | Permanent for the team. |
| Timeout | 504 | — | Retry or reduce scope. |

The docs show the body example only for a 400; that 402 and 429 use the identical three-field shape is implied by "Error responses return a `requestId`, a human-readable `error` message, and a machine-readable `tag`" but no 402/429 body was observed (UNCONFIRMED in practice).

`/contents` per-URL failures come back on a 200 in `statuses[]` as `{"id", "status": "error", "error": {"tag": "CRAWL_NOT_FOUND", "httpStatusCode": 404}}`. Tags: `CRAWL_NOT_FOUND`, `CRAWL_HTTP_{status}`, `CRAWL_TIMEOUT`, `CRAWL_LIVECRAWL_TIMEOUT`, `SOURCE_NOT_AVAILABLE`, `UNSUPPORTED_URL`, `CRAWL_UNKNOWN_ERROR`. Also `400 SUBPAGES_LIMIT_EXCEEDED`: at most 100 subpages per `/contents` request.

---

## 6. MCP, plugins, skills, CLI

Sources: https://exa.ai/docs/get-started/exa-mcp.md, https://exa.ai/auth.md, https://github.com/exa-labs/exa-mcp-server (README).

- Hosted URL: `https://mcp.exa.ai/mcp` (streamable HTTP). Local alternative: `npx -y exa-mcp-server` with `EXA_API_KEY`.
- Auth modes:

| Mode | How | Tools |
| - | - | - |
| Keyless | Connect with no credentials | `web_search_exa`, `web_fetch_exa` at a free rate limit; no `agent_run` |
| OAuth | `https://mcp.exa.ai/mcp?login` (README also lists `https://mcp.exa.ai/mcp/oauth`). Authorization server `https://auth.exa.ai`, PKCE S256, scope `mcp:tools`, dynamic client registration | Defaults including `agent_run`, billed to the signed-in team |
| API key | `x-api-key` header (docs). The README also accepts `Authorization: Bearer …` and a `?exaApiKey=…` query parameter | Defaults including `agent_run`, billed to the key's team |

- Keyless limits: the current docs say only "a free rate limit". The Feb 2, 2026 changelog entry gives "3 QPS and 150 calls/day". Whether those numbers still hold is UNCONFIRMED. Keyless "requires an IPv4 connection made directly"; IPv6 or proxied paths get 403. Keyless overuse returns 429.
- Tools:

| Tool | Availability |
| - | - |
| `web_search_exa` | Default |
| `web_fetch_exa` | Default |
| `agent_run` | Default once authenticated; unavailable keyless |
| `web_search_advanced_exa` | Opt-in; filters, dates, summaries, freshness, subpage crawling |

- Selection: `?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run`. "An explicit `tools` list replaces the defaults."
- Other URL flag: `?dynamicHighlights=true` (beta).
- The older specialised MCP tools (code context, company research, deep researcher, crawling, LinkedIn/people search) do not appear in the current tool table.
- Claude Code plugin: `claude plugin install exa@claude-plugins-official`. It bundles the hosted MCP server plus two skills, `search` and `exa-agent` (published from the `claude-plugin` branch of the MCP server repository).
- Agent skills for building against the API: `npx skills add exa-labs/agent-skills` — "Build with Exa", "Exa Search", "Exa Contents" (https://exa.ai/docs/get-started/agent-skills/overview.md).
- Other official plugins/connectors: ChatGPT/Codex plugin, Claude connector directory entry, Cursor plugin, Grok Build plugin, Antigravity/Gemini CLI plugin, Zed extension, Kiro power, n8n node, Google Sheets add-on, a separate `websets-mcp-server` (repository list at https://github.com/exa-labs).
- Official CLI: none found in the docs index or among the organisation's public repositories. The only CLI route in the docs is Stripe's `stripe projects` for key provisioning. Absence is a negative result from a listing, so treat as UNCONFIRMED.
- SDKs: `exa-py` and `exa-js` (2.26.0 added warning logging), both read `EXA_API_KEY`.

---

## 7. Terms of service on multiple accounts and usage limits

Document: https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf (PDF metadata creation date March 4, 2025; the text carries no visible "last updated" line).

The terms contain no clause that mentions multiple accounts, multiple free-tier keys, or free credits. The clauses that bear on the question, quoted exactly:

- Section 1.1: "Your use of our APIs must comply with the technical documentation, usage guidelines, call volume limits, and other documentation maintained at https://dashboard.exa.ai/overview or such other location we may designate from time to time. We reserve the right to audit your use of our APIs to ensure that your use is in compliance with these Terms and our documentation. We may terminate your right to use the API at any time."
- Section 2.1: "You agree to provide us with accurate, complete and updated information for your Account and your Authorized Users' Accounts."
- Section 4.2(g): you may not "access or use the Services in any manner that could disable, overburden, damage, disrupt or impair the Services or interfere with any other party's access to or use of the Services".
- Section 4.2(i): you may not "circumvent, remove, alter, deactivate, degrade or thwart any technological measure or content protections of the Services".
- Section 10.3: "the Company may suspend, disable, or delete your Account and/or the Services (or any part of the foregoing) with or without notice, for any or no reason. If the Company deletes your Account for any suspected breach of these Terms by you, you are prohibited from re-registering for the Services under a different name."

The billing documentation, which section 1.1 incorporates by reference as "usage guidelines", adds: "Only a user's first team receives the monthly grant." (https://exa.ai/docs/admin/billing.md)

Reading:

- Rotating several keys inside one team: permitted and supported, but pointless for quota because credits and rate limits are per team.
- Creating several teams under one account: permitted, but only the first gets free credits.
- One person registering several accounts to collect several free grants: not addressed in explicit words. It runs against the stated one-grant-per-user design, arguably falls under 1.1 (compliance with documented limits) and 4.2(i) (circumventing a technological measure), and Exa may terminate for any or no reason under 10.3. This is an interpretation, not legal advice, and no Exa statement confirming either reading was found.

---

## 8. What a mid-2026 wrapper is probably missing

1. `type: "lite"` at $4 / 1k, and awareness that `fast`, `instant` and `deep-reasoning` are now legacy. `lite` rejects unsupported parameters with a 400 instead of ignoring them.
2. `deep-lite` and `deep` with `outputSchema`, `output.content` and `output.grounding`.
3. `/search` no longer supports `contents.subpages` / `subpageTarget` (deprecated); a crawl must go through `/contents` with `subpages` (maximum 100 per request).
4. `maxAgeHours` and `livecrawlTimeout` in place of `livecrawl`; `highlights.maxCharacters` in place of `numSentences` / `highlightsPerUrl`.
5. `warnings` and `notices` arrays on search responses; `resolvedSearchType` may be empty; `highlightScores` is gone.
6. Categories: `publication` replaces `research paper`; `tweet` returns 400; `pdf` and `github` deprecated.
7. Exa Agent (`/agent/runs`) with fixed-price efforts from $0.012, plus Connect data sources, stop/cancel, events and `previousRunId`.
8. `/answer`, Monitors (now $2 / 1k), Snapshot (`snapshotAsOf`), Dynamic Highlights (beta header), Batch (Enterprise beta).
9. `/findSimilar`, `/context` and `/research` are deprecated or removed (`/research` returns 410).
10. Team Management API: `GET /credits` for the balance, per-key `usage`, `budgetCents`, `rateLimit`, and grace-period rotation — gated on Exa enabling it and on a separate service key.
11. Error handling keyed on `tag`: distinguish `NO_MORE_CREDITS` (team-wide) from `API_KEY_BUDGET_EXCEEDED` (key only) and `RATE_LIMIT_EXCEEDED` (team-wide, honour `Retry-After`); a missing key yields 402, not 401.
12. The free tier is now $10 per month renewing (previously a one-time grant), 10 QPS, first team only.
13. Hosted MCP now has OAuth, a four-tool surface and `agent_run`; the older specialised tools are not listed.

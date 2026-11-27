# TinyFish — complete programmatic surface and gateway gap (2026-11-27)

- Researched: 2026-11-27, from TinyFish's public documentation (all 135 pages in its `llms.txt`), its eight published OpenAPI documents, its public pricing page, its GitHub organization and its npm / PyPI packages. Operation counts were produced by script from the downloaded specs, not by reading.
- No API key was used. No paid endpoint was called. The only requests sent to TinyFish hosts were unauthenticated ones, to record what an unauthenticated caller gets back.
- The "current gateway" column comes from the gateway tool dump taken the same day (`gateway-tools.json`, upstream `tinyfish`, 43 tools). Gateway behaviour was read from `src/gateway/openapi.ts`, `src/gateway/config.ts` and `src/gateway/core.ts`, and tool names for a possible OpenAPI upstream were computed by running the gateway's own `operationsFromSpec` over the downloaded specs.
- Prices and limits are vendor statements and will drift.

Not confirmed (marked UNCONFIRMED where they appear):

- The price of TinyAnswer. It is on no pricing table.
- The per-request price of Search and Fetch beyond the free daily allowance. Docs say such requests "need a positive wallet balance"; no unit price is published, and the pricing page says neither product ever draws from the wallet.
- Which tools the ChatGPT-specific MCP endpoint (`/mcp/chatgpt`) lists, beyond "it omits `top_up_wallet`".
- How the hosted MCP server words an exhausted free allowance or an empty wallet in a tool result (the REST wording is documented; the MCP wording is not).
- Whether the REST profile setup call returns a human sign-in viewer URL. The spec lists `cdp_url` and `base_url` only; the MCP tool returns `viewer_url`.
- Whether `agent.tinyfish.ai/v1/search` and `/v1/fetch` accept requests exactly as the dedicated hosts do. First-party SDK and CLI source use them, but an unauthenticated probe cannot tell: every path on that host, existing or not, answers 401 before routing.

Primary sources:

- Docs index: https://docs.tinyfish.ai/llms.txt (every page has a `.md` twin; a single-file dump is at https://docs.tinyfish.ai/llms-full.txt)
- OpenAPI documents: https://agent.tinyfish.ai/v1/openapi/{main,research,monitor,datasets,search,fetch,browser,answer}
- MCP guide: https://docs.tinyfish.ai/mcp-integration/index.md
- MCP tool reference (dated 2026-09-28): https://github.com/tinyfish-io/tinyfish-mcp-server/blob/main/docs/tools.md
- Pricing: https://www.tinyfish.ai/pricing
- Wallet and agent payments: https://docs.tinyfish.ai/wallet.md, https://docs.tinyfish.ai/agent-payments.md
- Error codes: https://docs.tinyfish.ai/error-codes.md
- Organizations and key types: https://docs.tinyfish.ai/key-concepts/organizations.md
- CLI: https://docs.tinyfish.ai/cli/commands.md, npm `@tiny-fish/cli` 0.59.0 (2026-11-06)
- SDKs: npm `@tiny-fish/sdk` 0.11.0 (2026-10-28), PyPI `tinyfish` 0.11.0
- GitHub organization: https://github.com/tinyfish-io (10 public repositories)

---

## 0. Counts at a glance

| Thing | Count | How counted |
| - | -: | - |
| Published OpenAPI documents | 8 | `llms.txt` "OpenAPI Specs" section; the spec endpoint itself answers an unknown name with "Valid options: answer, fetch, search, browser, research, monitor, datasets" (plus `main`) |
| Operations across the 8 documents | 57 | script over `paths` |
| Distinct base URLs | 5 | each document's `servers[0].url` |
| API reference pages in `llms.txt` | 57 | one per operation, no extras |
| Hosted MCP tools, live with an API key | 43 | gateway dump, 2026-11-27 |
| Hosted MCP tools listed on the docs page | 36 | https://docs.tinyfish.ai/mcp-integration/index.md |
| Hosted MCP tools in the GitHub tool reference | 28 | `docs/tools.md`, last changed 2026-09-28 |
| REST operations that have an MCP tool | 40 | hand mapping, checked by script against the dump |
| REST operations with no MCP tool | 17 | same |
| MCP tools with no REST operation | 1 | `guide_next_step` |

The three MCP lists disagree because the server moved faster than its documentation. The live list is the one that counts. Tools live but absent from the docs page: `run_deep_research`, `guide_next_step`, `list_profiles`, `create_profile`, `start_profile_setup_session`, `save_profile_setup_session`, `cancel_profile_setup_session`. Tools live but absent from the GitHub reference: all research and dataset tools, `update_monitor`, `top_up_wallet`.

---

## 1. Published OpenAPI documents

All are OpenAPI 3.0.0, JSON, fetched without credentials. All declare one security scheme: API key in header `X-API-Key`, no prefix. None declares a `servers` entry on a path or operation; each has one document-level server.

| Document | URL | Title | Base URL (`servers[0]`) | Operations |
| - | - | - | - | -: |
| main | https://agent.tinyfish.ai/v1/openapi/main | TinyFish Web Agent Automation API | `https://agent.tinyfish.ai` | 28 |
| research | https://agent.tinyfish.ai/v1/openapi/research | TinyFish Research API | `https://agent.tinyfish.ai` | 6 |
| monitor | https://agent.tinyfish.ai/v1/openapi/monitor | TinyFish Monitor API | `https://agent.tinyfish.ai` | 6 |
| datasets | https://agent.tinyfish.ai/v1/openapi/datasets | TinyFish Datasets API | `https://agent.tinyfish.ai` | 9 |
| search | https://agent.tinyfish.ai/v1/openapi/search | TinyFish Search API | `https://api.search.tinyfish.ai` | 2 |
| fetch | https://agent.tinyfish.ai/v1/openapi/fetch | TinyFish Fetch API | `https://api.fetch.tinyfish.ai` | 2 |
| browser | https://agent.tinyfish.ai/v1/openapi/browser | TinyFish Browser API | `https://api.browser.tinyfish.ai` | 3 |
| answer | https://agent.tinyfish.ai/v1/openapi/answer | TinyAnswer API | `https://api.answer.tinyfish.ai` | 1 |
| Total | | | 5 hosts | 57 |

`main` breaks down as: automation 4, runs 7, browser context profiles 10, vault 5, wallet 2.

### 1.1 Every operation, with its hosted MCP tool

"Response" is the 2xx content type in the spec. A dash in the MCP column means no hosted MCP tool reaches that operation.

| # | Document | Operation | `operationId` | Hosted MCP tool | Response |
| -: | - | - | - | - | - |
| 1 | main | `POST agent.tinyfish.ai/v1/automation/run-sse` | `runSse` | `run_web_automation` | SSE |
| 2 | main | `POST agent.tinyfish.ai/v1/automation/run` | `run` | - (same job as `run_web_automation`, which streams) | JSON |
| 3 | main | `POST agent.tinyfish.ai/v1/automation/run-async` | `runAsync` | `run_web_automation_async` | JSON |
| 4 | main | `POST agent.tinyfish.ai/v1/automation/run-batch` | `runBatch` | - | JSON |
| 5 | main | `GET agent.tinyfish.ai/v1/runs` | `listRuns` | `list_runs` | JSON |
| 6 | main | `POST agent.tinyfish.ai/v1/runs/batch` | `batchGetRuns` | `batch_status` (8 ids; REST takes 100) | JSON |
| 7 | main | `POST agent.tinyfish.ai/v1/runs/batch/cancel` | `batchCancelRuns` | `batch_cancel` (8 ids; REST takes 100) | JSON |
| 8 | main | `GET agent.tinyfish.ai/v1/runs/{id}` | `getRunById` | `get_run` | JSON |
| 9 | main | `POST agent.tinyfish.ai/v1/runs/{id}/cancel` | `cancelRunById` | `cancel_run` | JSON |
| 10 | main | `GET agent.tinyfish.ai/v1/runs/{id}/steps/{stepId}/screenshot` | `getStepScreenshot` | - | binary (JPEG) |
| 11 | main | `GET agent.tinyfish.ai/v1/runs/{id}/steps/{stepId}/html` | `getStepHtml` | - | HTML text |
| 12 | main | `GET agent.tinyfish.ai/v1/profiles` | `listBrowserContextProfiles` | `list_profiles` | JSON |
| 13 | main | `POST agent.tinyfish.ai/v1/profiles` | `createBrowserContextProfile` | `create_profile` | JSON |
| 14 | main | `GET agent.tinyfish.ai/v1/profiles/{profileId}` | `getBrowserContextProfile` | - | JSON |
| 15 | main | `PATCH agent.tinyfish.ai/v1/profiles/{profileId}` | `updateBrowserContextProfile` | - | JSON |
| 16 | main | `DELETE agent.tinyfish.ai/v1/profiles/{profileId}` | `deleteBrowserContextProfile` | - | JSON |
| 17 | main | `POST agent.tinyfish.ai/v1/profiles/{profileId}/setup-session` | `createBrowserContextProfileSetupSession` | `start_profile_setup_session` | JSON |
| 18 | main | `POST agent.tinyfish.ai/v1/profiles/{profileId}/setup-session/cancel` | `cancelBrowserContextProfileSetupSession` | `cancel_profile_setup_session` | JSON |
| 19 | main | `POST agent.tinyfish.ai/v1/profiles/{profileId}/save` | `saveBrowserContextProfileSetupSession` | `save_profile_setup_session` | JSON |
| 20 | main | `POST agent.tinyfish.ai/v1/profiles/{profileId}/upload` | `uploadBrowserContextProfileState` | - | JSON |
| 21 | main | `DELETE agent.tinyfish.ai/v1/profiles/{profileId}/domains/{domain}` | `deleteBrowserContextProfileDomain` | - | JSON |
| 22 | main | `GET agent.tinyfish.ai/v1/vault/connections` | `listVaultConnections` | - | JSON |
| 23 | main | `POST agent.tinyfish.ai/v1/vault/connections` | `connectVault` | - | JSON |
| 24 | main | `DELETE agent.tinyfish.ai/v1/vault/connections/{connectionId}` | `disconnectVault` | - | JSON |
| 25 | main | `GET agent.tinyfish.ai/v1/vault/items` | `listVaultItems` | - | JSON |
| 26 | main | `POST agent.tinyfish.ai/v1/vault/items/sync` | `syncVaultItems` | - | JSON |
| 27 | main | `GET agent.tinyfish.ai/v1/wallet` | `getWallet` | `get_wallet` | JSON |
| 28 | main | `POST agent.tinyfish.ai/v1/wallet/top-up` | `topUpWallet` | `top_up_wallet` | JSON |
| 29 | research | `POST agent.tinyfish.ai/v1/automation/run-research` | `runResearch` | `run_deep_research` | SSE |
| 30 | research | `POST agent.tinyfish.ai/v1/automation/run-research-async` | `startResearchAsync` | `run_deep_research_async` | JSON |
| 31 | research | `GET agent.tinyfish.ai/v1/research-run/{research_run_id}/events` | `streamResearchEvents` | - | SSE |
| 32 | research | `GET agent.tinyfish.ai/v1/research-run` | `listResearchRuns` | `list_deep_research` | JSON |
| 33 | research | `GET agent.tinyfish.ai/v1/research-run/{research_run_id}` | `getResearchRun` | `get_deep_research` | JSON |
| 34 | research | `POST agent.tinyfish.ai/v1/research-run/{research_run_id}/cancel` | `cancelResearchRun` | `cancel_deep_research` | JSON |
| 35 | monitor | `GET agent.tinyfish.ai/v1/monitors` | `listMonitors` | `list_monitors` | JSON |
| 36 | monitor | `POST agent.tinyfish.ai/v1/monitors` | `createMonitor` | `create_monitor` | JSON |
| 37 | monitor | `GET agent.tinyfish.ai/v1/monitors/{id}` | `getMonitor` | `get_monitor` | JSON |
| 38 | monitor | `PATCH agent.tinyfish.ai/v1/monitors/{id}` | `updateMonitor` | `update_monitor`, `pause_monitor`, `resume_monitor` | JSON |
| 39 | monitor | `DELETE agent.tinyfish.ai/v1/monitors/{id}` | `deleteMonitor` | `cancel_monitor` | JSON |
| 40 | monitor | `POST agent.tinyfish.ai/v1/monitors/{id}/runs` | `runMonitor` | `run_monitor` | JSON |
| 41 | datasets | `GET agent.tinyfish.ai/v1/datasets` | `listDatasets` | `list_datasets` | JSON |
| 42 | datasets | `POST agent.tinyfish.ai/v1/datasets` | `createDataset` | `create_dataset` | JSON |
| 43 | datasets | `POST agent.tinyfish.ai/v1/datasets/plan` | `planDataset` | `plan_dataset` | JSON |
| 44 | datasets | `GET agent.tinyfish.ai/v1/datasets/{id}` | `getDataset` | `get_dataset` | JSON |
| 45 | datasets | `DELETE agent.tinyfish.ai/v1/datasets/{id}` | `deleteDataset` | `delete_dataset` | JSON |
| 46 | datasets | `GET agent.tinyfish.ai/v1/datasets/{id}/rows` | `getDatasetRows` | `get_dataset_rows` | JSON |
| 47 | datasets | `POST agent.tinyfish.ai/v1/datasets/{id}/populate` | `populateDataset` | `populate_dataset` | JSON |
| 48 | datasets | `POST agent.tinyfish.ai/v1/datasets/{id}/runs/{runId}/cancel` | `cancelDatasetRun` | `cancel_dataset_run` | JSON |
| 49 | datasets | `GET agent.tinyfish.ai/v1/datasets/{id}/runs/{runId}/events` | `streamDatasetRunEvents` | - | SSE |
| 50 | search | `GET api.search.tinyfish.ai/` | `search` | `search` | JSON |
| 51 | search | `GET api.search.tinyfish.ai/usage` | `listSearchUsage` | `get_search_usage` | JSON |
| 52 | fetch | `POST api.fetch.tinyfish.ai/` | `fetchUrls` | `fetch_content` | JSON |
| 53 | fetch | `GET api.fetch.tinyfish.ai/usage` | `listFetchUsage` | `list_fetch_usage` | JSON |
| 54 | browser | `POST api.browser.tinyfish.ai/` | `createBrowserSession` | `create_browser_session` | JSON |
| 55 | browser | `GET api.browser.tinyfish.ai/usage` | `listBrowserUsage` | `list_browser_sessions` | JSON |
| 56 | browser | `DELETE api.browser.tinyfish.ai/{sessionId}` | `deleteBrowserSession` | `close_browser_session` | empty (204) |
| 57 | answer | `POST api.answer.tinyfish.ai/` | `answer` | - | JSON |

Request bodies are `application/json` everywhere a body exists. There is no multipart operation in any document.

### 1.2 Request fields worth knowing

| Operation | Fields (required marked *) | Source |
| - | - | - |
| `run`, `runAsync`, `runSse` | `url`*, `goal`*, `browser_profile` (`lite` / `stealth`), `proxy_config`, `output_schema`, `agent_config` (`mode`, `max_steps`, `max_duration_seconds`), `capture_config`, `webhook_url`, `use_vault`, `use_profile`, `profile_id`, `credential_item_ids`, `api_integration` | main spec |
| `runBatch` | `runs`* (up to 100), `profile_id`, `output_schema`. Creation is all-or-nothing; no idempotency key | main spec |
| `search` | `query`*, `purpose`, `location`, `language`, `include_domains`, `exclude_domains`, `domain_type` (`web` / `news` / `research_paper`), `after_date`, `before_date`, `recency_minutes`, `pub_year_min`, `pub_year_max`, `page` (0-10), `include_thumbnail`, `fetch` | search spec |
| `fetchUrls` | `urls`* (up to 10), `purpose`, `format` (`markdown` / `html` / `json`), `links`, `image_links`, `iframe_links`, `page_metadata`, `ttl`, `per_url_timeout_ms`, `if_none_match`, `if_modified_since`, `include_etag_and_last_modified`, `include_selectors`, `exclude_selectors` | fetch spec |
| `createBrowserSession` | `url`, `timeout_seconds` (5-86400), `proxy_config` | browser spec |
| `runResearch`, `startResearchAsync` | `query`*, `mode` (`deep` / `max`), `stream`, `output_language`, `domain_filter`, `prior_run_id`, `session_id` | research spec |
| `createMonitor` | `type`* (`fetch` / `search`), `config`*, `schedule_cron`*, `name`, `webhook_url`, `purpose` | monitor spec |
| `createDataset` | `prompt` or `spec`, `target_rows` (1-250, default 100), `populate` | datasets spec |
| `answer` | `question`* | answer spec |

The hosted MCP tools carry the same fields with these differences: `run_web_automation` adds `feature_flags` and `session_id`; `run_deep_research*` lacks `output_language`; `create_dataset` lacks `populate`; `get_run` lacks the REST `screenshots` and `html` query options; `get_dataset` adds `wait`.

---

## 2. Documented REST endpoints not in any spec

| Endpoint | What it is | Evidence |
| - | - | - |
| `POST https://agent.tinyfish.ai/v1/browser`, `GET .../v1/browser/usage`, `DELETE .../v1/browser/{id}` | Same as the three `api.browser.tinyfish.ai` operations, on the main host. "Both hosts are supported and behave identically." | https://docs.tinyfish.ai/tinybrowser/reference.md; `@tiny-fish/cli` 0.59.0 `dist/lib/client.js` |
| `GET https://agent.tinyfish.ai/v1/search/usage`, `GET .../v1/fetch/usage` | Usage lists on the main host | https://docs.tinyfish.ai/key-concepts/organizations.md; CLI source |
| `https://agent.tinyfish.ai/v1/search`, `.../v1/fetch` | Search and Fetch on the main host. The SDK uses these paths only when a custom base URL is set, and notes that the dedicated hosts "are the entry points that run through the API gateway". UNCONFIRMED as equivalent | `@tiny-fish/sdk` 0.11.0 `dist/_utils/client.js`; https://docs.tinyfish.ai/error-codes.md |
| `GET {base_url}/pages` | Per-session endpoint on the browser session's own host (returned as `base_url`). Lists pages with a DevTools inspector URL. Sample code calls it with no API key | https://docs.tinyfish.ai/tinybrowser/reference.md |
| `wss` `cdp_url` | Chrome DevTools Protocol socket for a browser or profile setup session. Not HTTP | same |
| `streaming_url` (`https://stream.agent.tinyfish.ai/session/...`) | Embeddable live view of a running agent | https://docs.tinyfish.ai/live-preview.md |
| Webhook deliveries to `webhook_url` | Outbound: agent run finished; monitor run finished (with diff and a judgement against `purpose`) | https://docs.tinyfish.ai/webhooks.md; https://docs.tinyfish.ai/tinymonitor/api-reference.md |
| `GET https://agent.tinyfish.ai/v1/openapi/{name}` | The spec documents themselves | `llms.txt` |

Nothing was found that offers a capability missing from the specs. In particular the CLI's `agent batch list / get / cancel <batch_id>` are not hidden REST endpoints: the batch id is a local record the CLI keeps, and the commands call `runBatch`, `batchGetRuns` and `batchCancelRuns`.

No operation exists in any spec for: creating or revoking API keys, auto-reload settings, organization members, the spend cap, or beta enrolment. The docs send all of these to the dashboard.

---

## 3. Hosted MCP server

| Property | Value | Source |
| - | - | - |
| Endpoint | `https://agent.tinyfish.ai/mcp`, Streamable HTTP, `POST` only (no `GET` event channel, no `DELETE`) | https://docs.tinyfish.ai/mcp-integration/index.md; `@tiny-fish/mcp` README |
| ChatGPT endpoint | `https://agent.tinyfish.ai/mcp/chatgpt`, a separate endpoint for ChatGPT custom connectors. Omits `top_up_wallet`; rest of its tool list UNCONFIRMED | same; https://docs.tinyfish.ai/agent-payments.md |
| Auth, interactive | OAuth 2.1. Protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`; scopes `openid profile email offline_access` only. There is no read/write scope split | probe, 2026-11-27 |
| Auth, API key | `Authorization: Bearer <key>` (documented for one client) or `X-API-Key: <key>` (what TinyFish's own local proxy sends). The gateway uses the first and was verified live | docs page; `@tiny-fish/mcp` README; `docs/components/gateway.md` |
| Keyless | `401`, body `{"jsonrpc":"2.0","error":{"code":-31001,"message":"Unauthorized: Valid OAuth Bearer token required"},"id":-1}`. No tool list, no free tier without an account | probe, 2026-11-27 |
| Local proxy | npm `@tiny-fish/mcp` 0.1.0: a reverse proxy on `127.0.0.1:3711` that adds the API key. Defines no tools of its own | https://github.com/tinyfish-io/tinyfish-mcp-server |
| Registry entry | `ai.tinyfish.agent/web-agent` 1.0.1 | https://registry.modelcontextprotocol.io |

### 3.1 Live tool list (43) by family

| Family | Tools | REST operations behind them |
| - | - | - |
| Search and fetch (2) | `search`, `fetch_content` | 50, 52 |
| Agent runs (7) | `run_web_automation`, `run_web_automation_async`, `get_run`, `list_runs`, `cancel_run`, `batch_status`, `batch_cancel` | 1, 3, 8, 5, 9, 6, 7 |
| Deep research (5) | `run_deep_research`, `run_deep_research_async`, `get_deep_research`, `list_deep_research`, `cancel_deep_research` | 29, 30, 33, 32, 34 |
| Monitors (8) | `create_monitor`, `list_monitors`, `get_monitor`, `update_monitor`, `pause_monitor`, `resume_monitor`, `run_monitor`, `cancel_monitor` | 36, 35, 37, 38, 38, 38, 40, 39 |
| Datasets (8) | `create_dataset`, `plan_dataset`, `get_dataset`, `get_dataset_rows`, `list_datasets`, `populate_dataset`, `cancel_dataset_run`, `delete_dataset` | 42, 43, 44, 46, 41, 47, 48, 45 |
| Browser sessions (3) | `create_browser_session`, `list_browser_sessions`, `close_browser_session` | 54, 55, 56 |
| Browser context profiles (5) | `list_profiles`, `create_profile`, `start_profile_setup_session`, `save_profile_setup_session`, `cancel_profile_setup_session` | 12, 13, 17, 19, 18 |
| Usage and wallet (4) | `get_search_usage`, `list_fetch_usage`, `get_wallet`, `top_up_wallet` | 51, 53, 27, 28 |
| Onboarding (1) | `guide_next_step` | MCP-only |

### 3.2 What the MCP tools do that REST does not

| Behaviour | Detail |
| - | - |
| `guide_next_step` | Returns the next onboarding step from the account's real usage. No REST equivalent |
| Long-poll | `get_deep_research` and `get_dataset` wait up to about 25 seconds before answering, so an agent polls less. REST answers at once |
| `get_dataset` | Also returns the first 50 rows |
| `pause_monitor`, `resume_monitor` | Shorthand for `PATCH /v1/monitors/{id}` with `status` |
| `start_profile_setup_session` | Returns a `viewer_url` for a person to sign in by hand. The REST response lists `cdp_url` and `base_url` (UNCONFIRMED whether it also returns a viewer URL) |
| `run_web_automation` | Streams progress as MCP notifications while it waits |
| Descriptions | Each tool carries when-to-use guidance ("Only use when the user explicitly asks...") that the REST descriptions lack |

### 3.3 Tools and behaviour that vary by account, plan or key

| What varies | Rule | Source |
| - | - | - |
| `top_up_wallet` | Listed only for accounts in the agent-payments rollout on wallet billing. Otherwise absent, and calling it returns `Unknown tool: top_up_wallet`. Never on the ChatGPT endpoint | https://docs.tinyfish.ai/mcp-integration/index.md |
| `get_wallet` / `GET /v1/wallet` | `404 FEATURE_NOT_AVAILABLE` on legacy credit or subscription accounts. This is the documented way to tell the two billing modes apart | https://docs.tinyfish.ai/error-codes.md |
| Team ("workflow") keys | May use Agent, Browser, Search and Fetch only. Vault and profiles "stay with each person"; TinyAnswer refuses team keys | https://docs.tinyfish.ai/key-concepts/organizations.md; answer spec |
| `owner` parameter | `list_runs`, `get_search_usage`, `list_fetch_usage` take `owner=me` or `owner=team`. A workflow key always reads the team's records and refuses `owner=me` | organizations page |
| Beta-gated fields | `agent_config.mode: "strict"`, `agent_config.max_steps`, Fetch `highlights`. Sending them without beta enrolment returns `403 FORBIDDEN` | https://docs.tinyfish.ai/tinyagent/api/agent/index.md; https://docs.tinyfish.ai/tinyfetch/reference.md |
| Account-enabled products | TinyAnswer "must be enabled for your account". TinyBrowser returns `404 NOT_FOUND` when not enabled | answer spec; https://docs.tinyfish.ai/tinybrowser/reference.md |
| Organization choice | A person in more than one organization picks one at OAuth consent; an API key works only for the place it was created in | organizations page |

---

## 4. SDK, CLI, plugin and skill features

None of these adds a server capability. Everything below runs on the 57 operations in section 1.

| Surface | Package / location | What it adds on top of the API |
| - | - | - |
| TypeScript SDK | npm `@tiny-fish/sdk` 0.11.0 | Typed clients (`agent`, `runs`, `research`, `monitors`, `datasets`, `search`, `fetch`, `browser`, `profiles`, `vault`, `wallet`), SSE parsing into typed events, retries with backoff (2 by default), 10-minute default timeout, `agent.queue()` |
| Python SDK | PyPI `tinyfish` 0.11.0 | Same shape. Daily-allowance errors raise at once instead of retrying |
| CLI | npm `@tiny-fish/cli` 0.59.0, binary `tinyfish`, Node 24+ | Commands for every product (`search`, `fetch`, `agent run`, `agent batch`, `browser session`, `profile`, `vault`, `research run`, `monitor`, `dataset`, `wallet status`, `auth`) |
| CLI-only: local batches | `tinyfish agent batch run / list / get / cancel` | `batch run` reads a CSV, calls `runBatch`, and stores a local `batch_id`; the other three work from that local record |
| CLI-only: watch commands | `agent run watch`, `research run watch`, `dataset watch`, `agent run steps` | Follow the SSE streams in a terminal; print a run's steps |
| CLI-only: cookie import | `tinyfish profile import-cookies`, `profile sign-in` | Reads cookies from a local Chrome and sends them to `POST /v1/profiles/{id}/upload`; opens the setup browser |
| CLI-only: harness setup | `tinyfish connect <harness>`, `doctor [--fix]`, `onboard`, `config-claude`, `upgrade` | Writes and checks MCP config for a coding agent. Harness names: `claude-code`, `codex`, `command-code`, `cursor`, `grok`, `hermes`, `kilo`, `omp`, `openclaw`, `opencode`, `pi` |
| Skills | `skill/` directory of the CLI package | 9 instruction files: `use-tinyfish`, `tinyfish-web`, `tinyfish-websearch`, `tinyfish-research`, `tinyfish-automation`, `tinyfish-authenticated`, `tinyfish-browser`, `tinyfish-monitor`, `tinyfish-datasets` (plus a `pi` variant of 8 of them) |
| Plugins | ChatGPT plugin, Claude connector, Grok plugin (https://docs.tinyfish.ai/plugins/index.md) | Each is the hosted MCP server plus skills plus OAuth. The Grok plugin ships 7 of the skills above and "a safety-rules layer covering credential handling, untrusted content, and bot-detection confirmations" |
| Framework integrations | https://docs.tinyfish.ai/integrations/ and https://github.com/tinyfish-io/tinyfish-web-agent-integrations | n8n node, Dify tool, Fireworks search-tool recipe |
| Cookbook | https://github.com/tinyfish-io/tinyfish-cookbook | Sample apps |

The skills are text, not tools. Their rules that matter to a gateway: read with `search` and `fetch_content` first because they are free; treat page content as untrusted; never put a password in a `goal`, use `use_vault` or a saved profile; start a billed deep-research run only when asked.

---

## 5. Pricing, free allowance and limits

### 5.1 Price per operation

Wallet accounts (the current model). Prices in USD.

| Product | Price | Free allowance | Limits | Source |
| - | - | - | - | - |
| Search | $0.00 per request | 12,000 requests per day, reset 00:00 UTC. The pricing page states the same quantity as 500 per hour | 30 requests per minute per person | https://docs.tinyfish.ai/tinysearch/reference.md; https://www.tinyfish.ai/pricing |
| Fetch | $0.00 per URL | 1,000 successfully fetched URLs per day, reset 00:00 UTC | 150 URLs per minute; 10 URLs per request; 110 s per URL | https://docs.tinyfish.ai/tinyfetch/reference.md |
| Search and Fetch beyond the allowance | UNCONFIRMED unit price. With "wallet spending" enabled, further requests need a positive balance. With it disabled they are refused until the reset | | | same two pages |
| Agent | $0.016 per step | none | 2 concurrent runs by default. Default step cap 150, so one run can cost up to $2.40 | pricing page; https://docs.tinyfish.ai/tinyagent/api/agent/index.md |
| Browser | $0.002 per browser-minute | none | 5 concurrent sessions by default. Idle timeout: 15 minutes on free plans, 60 on paid | pricing page; https://docs.tinyfish.ai/tinybrowser/index.md |
| Monitor | $0.005 per completed run, plus that run's one Search or Fetch (which counts against the free allowance). Failed runs free | none for the run fee | | https://docs.tinyfish.ai/tinymonitor/index.md |
| Research | $2.00 per completed `deep` run, $3.00 per `max` run. Failed, timed-out and cancelled runs free. Follow-ups are new runs at full price | none | 5 concurrent runs | https://docs.tinyfish.ai/tinyresearch/reference.md |
| Datasets | $0.10 per complete row added, including the run's Search and Fetch. Planning, incomplete, skipped and failed rows free | none | 250 rows per populate, 10 columns, 3 concurrent runs. A default 100-row create costs up to $10, a full one $25 | https://docs.tinyfish.ai/tinyset/reference.md; https://docs.tinyfish.ai/faq.md |
| TinyAnswer | UNCONFIRMED | UNCONFIRMED | Must be enabled per account; personal keys only | answer spec |
| Wallet read, usage lists | free | | Usage lists: 60 per minute, shared with invalid requests. No limit is stated for the wallet read | https://docs.tinyfish.ai/error-codes.md |

Account-level facts:

- New accounts start with $8 of wallet funds, no card required (https://docs.tinyfish.ai/quick-start.md).
- Minimum top-up $10. Agent-paid top-up accepts $10.00 to $500.00 per call.
- No subscription. Legacy credit accounts bill 1 credit per agent step and 1 credit per 4 browser-minutes.
- A run already admitted is never stopped for lack of funds; the balance can go negative.

One conflict between sources: the pricing page says Search and Fetch "keep working at a $0 balance" and never draw from the wallet. The API references say that beyond the daily allowance, an account with wallet spending enabled is charged and needs a positive balance. Both agree that inside the allowance the two are free.

### 5.2 What exhaustion looks like

| Condition | HTTP | Code | Retry? |
| - | - | - | - |
| Wallet too low to start an agent run, browser session, research run, monitor or dataset | 402 | `INSUFFICIENT_CREDITS` (`details.reason: "wallet_out_of_funds"`) | No, until funds are added |
| Same, legacy account | 403 | `FORBIDDEN` | No |
| Run rejected at the billing check after the run record exists | 200, run status `CANCELLED` | `error.category: "BILLING_FAILURE"` | No |
| Search or Fetch daily allowance used, wallet spending enabled, balance zero or below | 402 | `INSUFFICIENT_CREDITS` | After top-up or 00:00 UTC |
| Search or Fetch daily allowance used, wallet spending disabled | 429 | `RATE_LIMIT_EXCEEDED` with `details.reason: "free_allowance_exhausted"`, `window_seconds: 86400`, no `Retry-After` | At 00:00 UTC only |
| Other metered product's free allowance used, wallet spending disabled | 402 | `FREE_ALLOWANCE_EXHAUSTED` | At 00:00 UTC |
| Per-minute limit | 429 | `RATE_LIMIT_EXCEEDED` with `details.limit`, `unit`, `window_seconds`; `Retry-After` set | Yes, after the delay |
| Too many pending agent runs | 429 | `RATE_LIMIT_EXCEEDED`, no `details`, no `Retry-After` | When a run finishes |
| Too many research runs | 429 | `RATE_LIMIT_EXCEEDED` with `details.active_count`; `Retry-After: 30` | When a run finishes |

Source: https://docs.tinyfish.ai/error-codes.md.

The fifth row matters for key rotation: a key that has used its free Search or Fetch allowance answers 429, not 402. The gateway treats every 429 as a short rate limit and does not move to the next key (`QUOTA_PATTERN` in `src/gateway/core.ts` matches `402` and `insufficient_credits` but not `free_allowance_exhausted`).

### 5.3 Endpoints a usage tracker can poll with the API key

| Question | Call | Returns |
| - | - | - |
| Wallet balance and this account's own rates | `GET https://agent.tinyfish.ai/v1/wallet` | `available_balance` (string, may be negative), `currency`, `as_of`, `auto_reload`, `pending_top_up`, `rates.meters[]` (`label`, `unit_amount`, `per`), `agent_top_up_url`. `404 FEATURE_NOT_AVAILABLE` on legacy accounts |
| Search requests today | `GET https://api.search.tinyfish.ai/usage?start_after=<00:00Z today>&limit=1` | `total`; compare with 12,000 |
| Fetch URLs today | `GET https://api.fetch.tinyfish.ai/usage?start_after=<00:00Z today>&status=completed&limit=1` | `total` (one record per URL); compare with 1,000 |
| Browser minutes | `GET https://api.browser.tinyfish.ai/usage?start_after=...` | sessions with `duration_ms`, `status` |
| Agent steps | `GET https://agent.tinyfish.ai/v1/runs?created_after=...` then `GET /v1/runs/{id}` | `num_of_steps` per run; multiply by the step rate |
| Research and dataset spend | `GET /v1/research-run`, `GET /v1/datasets` | run status and `row_count`; price by the table above |
| Per-minute headroom | response headers on every Search and Fetch call | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` |

No endpoint reports the remaining daily free allowance directly; it has to be derived from the usage lists. No response carries a cost field, so the gateway ledger records TinyFish calls without a price. `rates.meters[]` is the only place the over-allowance Search and Fetch prices could appear for a given account.

The same four readings are available through the current MCP upstream as `get_wallet`, `get_search_usage`, `list_fetch_usage` and `list_browser_sessions`.

---

## 6. Against the gateway

Today: one `mcp` upstream, `https://agent.tinyfish.ai/mcp`, `Authorization: Bearer <key>`, 43 tools.

### 6.1 What the gateway does not expose, and how to add it

The 17 REST operations with no MCP tool, sorted by whether they are worth adding:

| Operation | Worth adding? | Why |
| - | - | - |
| `answer` (57) | Yes, if the account has TinyAnswer | One-call cited answer. Different host, personal key only, price unknown |
| `runBatch` (4) | Yes | Up to 100 runs in one call. `batch_status` tells agents to use it "after batch_create", but no such MCP tool exists |
| `run` (2) | Optional | Plain JSON result without the MCP progress stream. Cannot be cancelled |
| `getStepHtml` (11) | Optional | Page HTML at a step, for debugging a run. Needs `capture_config.html` on the run |
| `getBrowserContextProfile` (14) | Optional | Read-only; shows which domains a profile holds |
| `listVaultConnections`, `listVaultItems` (22, 25) | No | Read-only credential metadata; no use to a coding agent |
| `getStepScreenshot` (10) | No | Binary; see 6.3 |
| `streamResearchEvents`, `streamDatasetRunEvents` (31, 49) | No | SSE; see 6.3 |
| `updateBrowserContextProfile`, `deleteBrowserContextProfile`, `uploadBrowserContextProfileState`, `deleteBrowserContextProfileDomain` (15, 16, 20, 21) | No | Change or destroy saved logins; upload injects cookies |
| `connectVault`, `disconnectVault`, `syncVaultItems` (23, 24, 26) | No | `connectVault` takes a password-manager token or master password as arguments, which the ledger would then record |

Also not exposed: three REST request options the MCP tools lack (`output_language` on research, `populate` on datasets, `screenshots` / `html` on run lookup) and the 100-id batch calls (MCP caps at 8).

To add the useful ones, keep the MCP upstream and put an OpenAPI upstream beside it. This is configuration only:

```toml
[gateway.upstreams.tinyfishapi]
kind = "openapi"
url = "https://agent.tinyfish.ai"
spec = [
  "https://agent.tinyfish.ai/v1/openapi/main",
  "https://agent.tinyfish.ai/v1/openapi/research",
  "https://agent.tinyfish.ai/v1/openapi/monitor",
  "https://agent.tinyfish.ai/v1/openapi/datasets",
]
auth = "header"
auth_name = "X-API-Key"
auth_prefix = ""
keys = ["env:TINYFISH_API_KEY"]
include = ["run", "runBatch", "getRunById", "getStepHtml", "getBrowserContextProfile"]

[gateway.upstreams.tinyfishanswer]
kind = "openapi"
url = "https://api.answer.tinyfish.ai"
spec = "https://agent.tinyfish.ai/v1/openapi/answer"
auth = "header"
auth_name = "X-API-Key"
auth_prefix = ""
keys = ["env:TINYFISH_API_KEY"]
```

`auth_prefix = ""` is required: an upstream without a preset defaults to `Bearer `, and TinyFish REST wants the bare key in `X-API-Key`.

### 6.2 Would moving TinyFish from MCP to OpenAPI gain or lose tools?

| | Hosted MCP (today) | OpenAPI upstreams |
| - | - | - |
| Tools | 43 | 57 |
| Gained | | 17 operations, of which 5 are useful (table above), 4 cannot work through the connector, and 8 should be hidden |
| Lost | | `guide_next_step`; the `pause_monitor` and `resume_monitor` shorthands; the 25-second long-poll on research and datasets; progress streaming; the `viewer_url` sign-in flow; the when-to-use wording in tool descriptions |
| Upstream blocks needed | 1 | 5 (one per host) |

So a wholesale move gains little and costs convenience. Recommended: keep MCP as the main upstream and add the two blocks above.

Why five blocks and not one. The gateway takes an operation's base URL from a `servers` entry on the operation or its path, and otherwise from the upstream's `url` (`serverOf` in `src/gateway/openapi.ts`). TinyFish puts `servers` only at document level, with five different hosts. Listing all eight documents under one upstream, in the order `llms.txt` gives them, was tested with the gateway's own code: 53 tools are kept and 4 are dropped as duplicates (`createBrowserSession`, `fetchUrls`, `listFetchUsage`, `listSearchUsage`, because `POST /` and `GET /usage` repeat across documents; a different order drops a different four), and every Search, Fetch, Browser and Answer call would go to `agent.tinyfish.ai/` instead of its own host. A small gateway change would remove the need for separate blocks: when an operation has no `servers`, fall back to its own document's `servers[0].url` before the upstream `url`, and include that URL in the duplicate key.

If the OpenAPI route is ever used for the other three hosts, each needs its own block with `url` set to the host (`https://api.search.tinyfish.ai`, `https://api.fetch.tinyfish.ai`, `https://api.browser.tinyfish.ai`) and the matching single spec. Four `operationId`s are longer than the gateway's 32-character limit and get path-based names instead: `post_v1_profiles_profileId_setup_session`, `post_v1_profiles_profileId_setup_session_cancel`, `post_v1_profiles_profileId_save`, `delete_v1_profiles_profileId_domains_domain`.

### 6.3 Current tools that are dangerous or low-value for coding agents

The example in `docs/components/gateway.md` (`["top_up_wallet", "delete_*", "*_profile*"]`) hides 7 of the 43. It misses `cancel_monitor`, which despite its name deletes the Monitor and its schedule.

| Tool | Problem | Hide? |
| - | - | - |
| `top_up_wallet` | Charges a card $10 to $500 through the Machine Payments Protocol | Always |
| `delete_dataset` | Permanent | Always |
| `cancel_monitor` | Deletes the Monitor (REST `DELETE /v1/monitors/{id}`) | Always |
| `create_profile`, `start_profile_setup_session`, `save_profile_setup_session`, `cancel_profile_setup_session` | Need a person to sign in to a live browser; store login cookies for later runs | Always |
| `list_profiles` | Harmless, pointless once the four above are hidden | Always |
| `guide_next_step` | Onboarding prompt, tells the agent to ask the user questions | Always |
| `create_dataset`, `populate_dataset` | $0.10 per row; one default call can spend $10, more than a new account's whole $8 | Unless wanted |
| `run_deep_research`, `run_deep_research_async` | $2 or $3 per completed run | Unless wanted |
| `create_monitor`, `update_monitor`, `resume_monitor`, `run_monitor` | Recurring spend that outlives the session; `webhook_url` posts page content to any HTTPS address | Unless wanted |
| `create_browser_session` | $0.002 per minute until closed or idle for 15 to 60 minutes; useful only to an agent that then drives CDP itself | Judgement call |
| `run_web_automation`, `run_web_automation_async` | $0.016 per step, up to $2.40 per run at the default cap. The arguments `use_vault`, `use_profile`, `credential_item_ids` let a run act with stored logins, and `webhook_url` sends results off-box. Patterns cannot filter arguments | Keep; note the exposure |
| `get_search_usage`, `list_fetch_usage`, `list_browser_sessions`, `list_runs` | Their own descriptions say "only when the user asks". Low value to an agent, useful to a usage tracker | Keep |

Suggested list. The first line is the must-hide set (9 tools); the second adds the cost exposures (8 more), leaving 26 tools.

```toml
[gateway.upstreams.tinyfish]
exclude = [
  "top_up_wallet", "delete_*", "cancel_monitor", "*_profile*", "guide_next_step",
  "create_dataset", "populate_dataset", "run_deep_research*",
  "create_monitor", "update_monitor", "resume_monitor", "run_monitor",
]
```

Left visible: `search`, `fetch_content`, `run_web_automation`, `run_web_automation_async`, `get_run`, `list_runs`, `cancel_run`, `batch_status`, `batch_cancel`, `create_browser_session`, `list_browser_sessions`, `close_browser_session`, `list_monitors`, `get_monitor`, `pause_monitor`, `get_deep_research`, `list_deep_research`, `cancel_deep_research`, `plan_dataset`, `get_dataset`, `get_dataset_rows`, `list_datasets`, `cancel_dataset_run`, `get_search_usage`, `list_fetch_usage`, `get_wallet`.

For any OpenAPI upstream, prefer `include` (as in 6.1). If `exclude` is used instead, the equivalent set is: `topUpWallet`, `delete*`, `delete_v1_*`, `*Vault*`, `uploadBrowserContextProfileState`, `updateBrowserContextProfile`, `createBrowserContextProfile`, `post_v1_profiles_*`, plus the streaming and binary operations below.

### 6.4 Operations that will not work through the JSON-only OpenAPI connector

The connector sends `Accept: application/json`, a JSON body or none, only path and query parameters, and reads the whole response as text with a 5-minute limit (`REQUEST_TIMEOUT_MS`).

| Operation | Why it fails or misbehaves | Use instead |
| - | - | - |
| `runSse` (1) | SSE. The connector waits for the stream to end and returns the raw event text; fails past 5 minutes | `run`, or `runAsync` then `getRunById` |
| `runResearch` (29) | Always SSE, "including when stream is false"; research takes several minutes | `startResearchAsync` then `getResearchRun` |
| `streamResearchEvents` (31) | SSE; also takes a `Last-Event-ID` request header, which the connector cannot send | `getResearchRun` |
| `streamDatasetRunEvents` (49) | SSE until the run ends (5 to 20 minutes) | `getDataset`, `getDatasetRows` |
| `getStepScreenshot` (10) | JPEG bytes read as text are corrupted | `getRunById` with `screenshots=base64` (large) |
| `topUpWallet` (28) | The payment challenge arrives in a `WWW-Authenticate` response header and the payment goes in a `Payment-Authorization` request header; the connector exposes neither. Its first answer is a 402, which the gateway would read as "key out of credit" and skip the key for the cooldown period | Dashboard |
| `run` (2) | Works, but a slow run can pass the 5-minute limit, and a sync run cannot be cancelled | `runAsync` for anything long |

Works despite a non-JSON response: `getStepHtml` (text) and `deleteBrowserSession` (empty 204). No operation is multipart.

Through the MCP upstream none of this applies: `run_web_automation` and `run_deep_research` wait inside one tool call, bounded by the gateway's 10-minute call limit.

---

## 7. One line per tool family

| Family | What it is for | Price |
| - | - | - |
| Search (`search`) | Ranked web, news or research-paper results with snippets | Free up to 12,000 a day |
| Fetch (`fetch_content`) | Clean markdown, HTML or JSON for up to 10 URLs, with JavaScript rendering | Free up to 1,000 URLs a day |
| Agent (`run_web_automation*`, run lookup, cancel, batch status) | Give a URL and a plain-language goal; an agent clicks, types and extracts in a real browser | $0.016 per step |
| Browser (`create_browser_session`, list, close) | A remote stealth Chrome to drive yourself over CDP | $0.002 per minute |
| Deep research (`run_deep_research*`, get, list, cancel) | A cited multi-source report, several minutes per run | $2 (`deep`) or $3 (`max`) per completed run |
| Monitors (`create_monitor` and seven more) | Re-check a page or a search topic on a cron schedule and post changes to a webhook | $0.005 per completed run plus its Search or Fetch |
| Datasets (`create_dataset` and seven more) | Build a table of many entities with the same columns, filled from the web | $0.10 per complete row |
| Browser context profiles (five tools) | Save a signed-in browser state for later agent runs | Free to store; setup session is browser time |
| Vault (REST only) | Connect 1Password or Bitwarden so runs can log in without the agent seeing passwords | Free |
| TinyAnswer (REST only) | One question in, one cited answer out | UNCONFIRMED |
| Wallet (`get_wallet`, `top_up_wallet`) | Read the balance and rates; add funds by agent payment | Free to read |
| Usage (`get_search_usage`, `list_fetch_usage`, `list_browser_sessions`, `list_runs`) | Per-request history for audit and metering | Free |
| Onboarding (`guide_next_step`) | Suggests a next step to a new user | Free |

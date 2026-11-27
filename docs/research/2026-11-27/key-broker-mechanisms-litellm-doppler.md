# Key-broker mechanisms: LiteLLM proxy and Doppler (2026-11-27)

- Researched 2026-11-27 from public LiteLLM and Doppler documentation, plus the public LiteLLM source on GitHub where the docs are silent.
- This is a dated evidence snapshot of vendor docs, not a design. Vendor behaviour and plan gating change; re-check before relying on a line.
- Not confirmed from a primary source: anything marked UNCONFIRMED below. The main gaps are failure handling for load-balanced search tools, whether same-named search tools are told apart in spend logs, Doppler plan gating for write-capable service tokens and for webhooks, and every "would a sidecar work" inference. Nothing here was tested against a running system.

The question behind this note: can one place hold several API keys per web-search provider (Firecrawl, Exa, Parallel, Tavily), track how much allowance each has left, choose a key per request or swap the active key, and show it on a dashboard, for many kinds of client.

Two candidate mechanisms: (A) a LiteLLM proxy as the broker, (B) Doppler as the swap point.

---

## Part A. LiteLLM proxy as the search key broker

### A1. Unified Search API

- LiteLLM has a search endpoint family: `POST /v1/search/{search_tool_name}` (recommended, tool name in the URL), `POST /v1/search` with `"search_tool_name"` in the body, plus `/search` and `/search/{search_tool_name}`. Source: https://docs.litellm.ai/docs/search/index.md
- Shape is Perplexity's: "LiteLLM follows the Perplexity API request/response for the Search API." Source: https://docs.litellm.ai/docs/search/index.md
  - Request: `query` (string or array, required), `max_results` (1-20, default 10), `search_domain_filter` (max 20 domains), `max_tokens_per_page` (default 1024), `country`; `search_tool_name` on the proxy, `search_provider` in the SDK.
  - Response: `"object": "search"` and a `results` array of `title`, `url`, `snippet`, `date`, with optional `raw_content`, `score`, `favicon`, and a `provider_metadata` object for provider-specific fields.
- Config schema (https://docs.litellm.ai/docs/search/index.md):

  ```yaml
  search_tools:
    - search_tool_name: <name clients call>
      litellm_params:
        search_provider: <provider>
        api_key: os.environ/<VAR>
        input_cost_per_query: <optional number>
  ```

- Providers listed today (`search_provider` values): `perplexity`, `tavily`, `parallel_ai`, `exa_ai`, `brave`, `google_pse`, `dataforseo`, `firecrawl`, `searxng`, `linkup`, `duckduckgo`, `searchapi`, `serper`, `you_com`, `apiserpent`, `agentcore`, `nimble`, `bing_grounding`, `deepseek`, `webiq`. So all nine asked about (exa, firecrawl, parallel, tavily, brave, serper, searxng, linkup, perplexity) are supported. Source: https://docs.litellm.ai/docs/search/index.md (the page is inconsistent on `webiq`: in the header table, absent from the "Supported Providers" table).
- Scope is search only. The search page documents no extract, scrape, crawl or contents endpoint. Source: https://docs.litellm.ai/docs/search/index.md
  - Firecrawl: search, with page content scraped for the results when `scrapeOptions` is passed; crawl and extract are not mentioned. Source: https://docs.litellm.ai/docs/search/firecrawl.md
  - Exa: search, with `contents` (`text`, `highlights`) as a search parameter; findSimilar and answer are not mentioned. Source: https://docs.litellm.ai/docs/search/exa_ai.md
  - `/v1/extraction` exists but is LLM structured extraction from supplied text and images (one provider listed), not URL fetching. Source: https://docs.litellm.ai/docs/extraction.md
  - Consequence: Firecrawl scrape/crawl/extract, Exa contents/answer, Tavily extract/crawl/map and Parallel's non-search APIs would have to go through pass-through endpoints (A3) or the MCP gateway (A4).
- Coding agents' native web search can be redirected to a search tool: the `websearch_interception` callback intercepts the agent's `web_search` tool for the providers in `enabled_providers` and runs it through a named `search_tools` entry (`websearch_interception_params.search_tool_name`, else the first entry). Source: https://docs.litellm.ai/docs/tutorials/claude_code_websearch.md

### A2. Several keys under one name, budgets, spend

- Same-name entries are load balanced: "Give multiple search tools the same `search_tool_name` to load balance across them." "Each request picks one of the matching tools at random." Source: https://docs.litellm.ai/docs/search/index.md
- The router strategies do not apply: "`router_settings.routing_strategy` does not apply to search tools", so `least-busy`, latency-based and similar have no effect. Source: https://docs.litellm.ai/docs/search/index.md
- The docs say nothing about retries, cooldown on 402/429, per-entry rpm, or a budget per entry. Source: https://docs.litellm.ai/docs/search/index.md
  - From the public source of a recent tagged release (`litellm/router_utils/search_api_router.py`, https://github.com/BerriAI/litellm): the selection is `random.choice(matching_tools)` with the comment "we use simple random choice since they don't have TPM/RPM constraints", and the call runs inside the router's general retry/fallback wrapper. The file has since moved on `main`.
  - UNCONFIRMED: that a retry re-draws at random (so a failed key may be drawn again), that an exhausted key is never cooled down, and the exact `router_settings.fallbacks` syntax between search tool names. The docs only mention "router fallbacks between search tools" in the access-control section.
  - Net: equal-weight random spread across keys is documented; "prefer the key with the most allowance left" and "skip a key that returned 402/429" are not features.
- No budget per search tool or per upstream key is documented. Virtual-key and team budgets are the documented budget objects, and they limit the caller, not the upstream key. UNCONFIRMED whether `max_budget` on a `search_tools` entry does anything.
- Cost and spend:
  - The feature table marks cost tracking and logging as supported; cost is returned in `x-litellm-response-cost` and written to spend logs. Source: https://docs.litellm.ai/docs/search/index.md
  - Price comes from LiteLLM's cost map per provider, or from `input_cost_per_query` on the entry: "LiteLLM uses it instead of the cost map price for that tool"; a list of queries is billed once per query; `0` means free, not unset. Source: https://docs.litellm.ai/docs/search/index.md
  - In source the formula is queries x a per-query price, with tiers by `max_results` for some providers and a provider-specific calculator for Parallel (`litellm/search/cost_calculator.py`, https://github.com/BerriAI/litellm).
  - This is a list-price estimate. LiteLLM does not read a provider's remaining free credits; nothing in the docs describes that. Exa is the partial exception: its reported charge comes back in `provider_metadata.costDollars` for reconciliation. Source: https://docs.litellm.ai/docs/search/exa_ai.md
  - UI: Logs, filtered by Team ID and by "Public model / search tool" (the `search_tool_name`), then the Cost column. Source: https://docs.litellm.ai/docs/proxy/ui_search_tools.md
  - UNCONFIRMED: whether two entries sharing one `search_tool_name` are distinguishable in spend logs. Giving each key its own name (`exa-a`, `exa-b`) makes them distinguishable by construction, at the cost of losing the built-in random spread.
- Access control: `object_permission.search_tools` on a key or team; `general_settings.search_tool_deny_by_default: true` makes a missing or empty grant mean "nothing"; denials are 403 before any provider call; the master key and dashboard sessions are exempt. Source: https://docs.litellm.ai/docs/search/index.md

### A3. Pass-through endpoints

- A custom route can forward to a vendor API with the upstream credential injected, so clients hold only a LiteLLM key. Source: https://docs.litellm.ai/docs/proxy/pass_through.md

  ```yaml
  general_settings:
    pass_through_endpoints:
      - path: "/firecrawl"
        target: "https://api.firecrawl.dev"
        include_subpath: true          # forward sub-paths too (default false)
        headers:
          Authorization: "Bearer os.environ/FIRECRAWL_API_KEY"
        # auth: true                   # require a LiteLLM key on this route
        # methods: [...]               # optional; all methods if omitted
  ```

  (The path and target above are adapted to this use case; the documented example is `/v1/rerank` to Cohere with `Authorization: "bearer os.environ/COHERE_API_KEY"`.)
- Single credential per route. No pool, rotation or load balancing of upstream keys is documented; the only multi-target pattern is the same path split by HTTP method. Source: https://docs.litellm.ai/docs/proxy/pass_through.md
- Usage logging: values are booked "against the calling key, team, and user" and "show up in the spend logs and on the usage dashboards". Cost is a flat `cost_per_request` on the endpoint (default `0.0`), overridden by an upstream `x-litellm-response-cost` header; `x-litellm-total-tokens` and `x-litellm-upstream-model` are also read. Source: https://docs.litellm.ai/docs/proxy/pass_through_cost_tracking.md
  - A vendor API will not send `x-litellm-response-cost`, so cost would be the flat per-request figure only.
- Endpoints can be created in the Admin UI and are "immediately available"; no creation API is documented. Source: https://docs.litellm.ai/docs/proxy/pass_through.md

### A4. MCP gateway

- LiteLLM fronts remote HTTP/SSE MCP servers and injects the upstream credential. Source: https://docs.litellm.ai/docs/mcp.md

  ```yaml
  mcp_servers:
    exa:
      url: "https://<vendor MCP URL>"
      transport: "http"
      auth_type: "api_key"         # X-API-Key: <auth_value>
      auth_value: os.environ/EXA_API_KEY
  ```

  - Header by `auth_type`: `api_key` sends `X-API-Key`; `bearer_token` sends `Authorization: Bearer`; `basic` sends `Authorization: Basic`; `authorization` sends the value verbatim; `token` sends `Authorization: token`; `oauth2` sends a resolved bearer token. `static_headers` are sent on every request; `upstream_token_header` moves the token to another header. Source: https://docs.litellm.ai/docs/mcp.md
  - A vendor that takes its key in the URL can have it in `url`. UNCONFIRMED whether `os.environ/` is expanded inside a URL string; if not, the key would sit in config.
- Access control is per key, team, organization, access group, end user, agent and internal user, most restrictive wins; `require_key_mcp_access_defined: true` makes an empty grant mean no servers; per-tool grants via `object_permission.mcp_tool_permissions`; server-wide `allowed_tools` / `disallowed_tools`; `mcp_rpm_limit` per key or team and a server-level `rpm`. Source: https://docs.litellm.ai/docs/mcp_control.md
- Per-tool cost: fixed prices under `mcp_info.mcp_server_cost_info` (`default_cost_per_query`, `tool_name_to_cost_per_query`), or a `CustomLogger.async_post_mcp_tool_call_hook` that sets `response_obj.hidden_params.response_cost`. Source: https://docs.litellm.ai/docs/mcp_cost.md
  - The cost page says costs go to "LiteLLM's logging system" without naming the UI view. UNCONFIRMED where they surface in the dashboard.
- One credential per server. No credential pool, rotation or failover between MCP servers is documented. Sources: https://docs.litellm.ai/docs/mcp.md , https://docs.litellm.ai/docs/mcp_config_reference.md
  - Clients may supply their own upstream credential with `x-mcp-{server_alias}-{header_name}` (the broadcast `x-mcp-auth` is deprecated), which is the opposite of a broker. Source: https://docs.litellm.ai/docs/mcp.md
  - Workaround by inference: register two servers (`exa-a`, `exa-b`) and grant keys one or the other. Clients would see different server names. UNCONFIRMED.
- Servers can be added and edited at runtime in the UI and through `GET/POST/PUT /v1/mcp/server` when DB storage is on (`store_model_in_db: true`, optionally `supported_db_objects: ["mcp"]`). Source: https://docs.litellm.ai/docs/mcp.md
- An upstream that requires interactive OAuth is a different case from an API key; LiteLLM documents OAuth flows separately. Source: https://docs.litellm.ai/docs/mcp_oauth.md (listed in https://docs.litellm.ai/llms.txt, not read in detail).

### A5. Enterprise versus open source

- The enterprise page lists the MCP gateway under the open-source gateway tier and marks no MCP feature enterprise-only; it does not mention search tools, pass-through auth or credentials at all. Source: https://docs.litellm.ai/docs/enterprise.md
- Enterprise-only per that page, relevant here: audit logs with retention, tag-based budgets, automated virtual-key rotation, secret-manager integrations, model-specific budgets per key, spend-report API, SSO beyond 5 users, per-team logging, soft-budget email alerts. Source: https://docs.litellm.ai/docs/enterprise.md
- Pass-through: the docs label `auth` as "Enable LiteLLM authentication (Enterprise)" and mark `allowed_passthrough_routes` / `denied_passthrough_routes` as enterprise. Source: https://docs.litellm.ai/docs/proxy/pass_through.md
  - Conflict: current public source carries the comment "Authentication on a pass-through endpoint used to be enterprise-only ... The safe option must always be free" (`litellm/proxy/pass_through_endpoints/pass_through_endpoints.py`, https://github.com/BerriAI/litellm). Treat `auth: true` without a license as UNCONFIRMED until tested on the version in use. Without `auth`, a pass-through route forwards unauthenticated requests with the real key attached.
- Search tools, search access control, search cost tracking, credential routing and model management carry no enterprise label on their pages. Sources: https://docs.litellm.ai/docs/search/index.md , https://docs.litellm.ai/docs/proxy/credential_routing.md , https://docs.litellm.ai/docs/proxy/model_management.md

### A6. Runtime hook points for a sidecar

- Search tools in the database. The Admin UI adds and edits search tools, including "Cost per Query (USD)". Source: https://docs.litellm.ai/docs/proxy/ui_search_tools.md . The docs do not list the API, but public source defines `GET /search_tools/list`, `POST /search_tools`, `PUT /search_tools/{search_tool_id}`, `DELETE /search_tools/{search_tool_id}`, `GET /search_tools/{search_tool_id}` and `POST /search_tools/test_connection`, and each write refreshes the serving worker's router (`litellm/proxy/search_endpoints/search_tool_management.py`, https://github.com/BerriAI/litellm).
  - So a sidecar could swap a tool's `api_key` or delete an exhausted entry with no restart. UNCONFIRMED: propagation time to other workers or replicas, and behaviour when a DB tool and a config-file tool share a name. Loading DB search tools is subject to `general_settings.supported_db_objects` when that list is set (same source).
- MCP servers: `PUT /v1/mcp/server` updates a DB-stored server at runtime. Source: https://docs.litellm.ai/docs/mcp.md . UNCONFIRMED whether servers defined in the config file can be edited this way.
- Pre-call hook: `async_pre_call_hook(user_api_key_dict, cache, data, call_type)` can modify `data` or reject. The docs list only LLM call types. Source: https://docs.litellm.ai/docs/proxy/call_hooks.md . Public source passes search requests through the same hook with call type `asearch` (`litellm/proxy/common_request_processing.py`, https://github.com/BerriAI/litellm), so an in-process callback could rewrite the tool name to the entry it wants (for example a generic `exa` to `exa-b`). UNCONFIRMED; the access check runs on the requested name before the hook.
- Custom routing strategy: not available for search ("`routing_strategy` does not apply to search tools"). Source: https://docs.litellm.ai/docs/search/index.md
- Reusable credentials (`litellm_credential_name`, `/credentials`) and credential routing are documented for models only; usage per credential appears under Usage, Tag with the `Credential:` prefix. Neither page mentions search tools, MCP servers or pass-through. Sources: https://docs.litellm.ai/docs/proxy/credential_usage_tracking.md , https://docs.litellm.ai/docs/proxy/credential_routing.md
- Model endpoints (`/model/new`, `PATCH /model/{model_id}/update`, `/model/delete`) apply "to new requests without a restart", but they manage models, not search tools. Source: https://docs.litellm.ai/docs/proxy/model_management.md
- Pass-through: UI-created endpoints are live immediately; no update API is documented. Source: https://docs.litellm.ai/docs/proxy/pass_through.md

### Part A summary

- Documented and free: one endpoint shape over all four providers' search, virtual-key access control, per-query list-price spend in the UI, random spread across same-named keys, MCP fronting with injected keys, single-key pass-through for the non-search APIs.
- Not provided: allowance-aware selection, cooldown of an exhausted key, per-upstream-key budgets, knowledge of a provider's remaining free credits, key pools for pass-through or MCP. A broker needs its own allowance meter and must push its decision in through the runtime hooks above.

---

## Part B. Doppler as the swap point

### B1. Updating a secret

- API: `POST https://api.doppler.com/v3/configs/config/secrets` with JSON `project`, `config` and either `secrets` (name to value map) or `change_requests` (not both). Source: https://docs.doppler.com/reference/secrets-update.md
- CLI: `doppler secrets set KEY="value"` (several pairs allowed), interactive `doppler secrets set KEY`, or stdin `cat file | doppler secrets set KEY`; `--silent` stops the value being echoed. Source: https://docs.doppler.com/docs/setting-secrets.md
- Tokens. Bearer token in the Authorization header. Personal and CLI tokens have "read/write access to all resources on your account"; service tokens are scoped to one config with read or read/write access; service account tokens cover a granular set of resources. Source: https://docs.doppler.com/reference/api
  - A service token is read-only by default and write access can be granted when it is generated in the dashboard. Source: https://docs.doppler.com/docs/service-tokens.md
  - Service accounts: "available with our Team and Enterprise plans". Source: https://docs.doppler.com/docs/service-accounts.md
  - Developer plan: service tokens are included (limit 50). Sources: https://www.doppler.com/pricing , https://docs.doppler.com/docs/platform-limits
  - UNCONFIRMED: whether the write option on service tokens is available on the Developer plan. No page gates it, and no page says it is ungated.
- Rate limits per access token, per minute (also an IP-level limit). Sources: https://docs.doppler.com/docs/platform-limits , https://docs.doppler.com/reference/api

  | Plan | API reads | Secret reads | Writes |
  |---|---|---|---|
  | Developer | 240 | 120 | 60 |
  | Team | 480 | 240 | 120 |
  | Enterprise | 480 | 480 | 240 |

  - "This applies to direct requests to the API along with requests made by the CLI and Kubernetes Operator." Over the limit the API returns 429 with `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` and `retry-after`.
- Other limits: 50 KiB per secret value, 500 KiB per config, 1,200 secrets per config; Developer has 10 projects, 5 webhooks, 5 config syncs. Source: https://docs.doppler.com/docs/platform-limits

### B2. References instead of copies

- Syntax: `${SECRET}` in the same config, `${config.SECRET}` across configs, `${project.config.SECRET}` across projects. "Secret references are resolved at read-time." Source: https://docs.doppler.com/docs/secrets.md
- So the canonical name can hold `${pool.prd.EXA_KEY_B}` and a rotator re-points it by writing a new reference string; no key material is copied. Consumers read the computed value. Source: https://docs.doppler.com/docs/secrets.md
- Gating: "For workplaces on paid plans you can reference secrets across configs and projects." Same-config references are not gated, so on a free workplace the pool and the canonical name would have to live in one config. UNCONFIRMED whether a Developer workplace with paid seats counts as "paid". Source: https://docs.doppler.com/docs/secrets.md
- Change propagation: when a referenced secret changes, webhooks, syncs and Kubernetes restarts fire for the referencing secrets too, but "these actions occur as separate background jobs and as such are not performed atomically across all projects." Source: https://docs.doppler.com/docs/secrets.md
- A renamed or deleted target leaves the literal reference string in place, which a consumer would then send as its API key. Source: https://docs.doppler.com/docs/secrets.md

### B3. How consumers learn of a change

| Consumer | Mechanism | Realistic delay |
|---|---|---|
| `doppler run -- cmd` | Injects environment variables into the process it starts. Source: https://docs.doppler.com/docs/accessing-secrets | Never, until the process is restarted. The docs do not say this in so many words; it follows from the watch feature existing and from how environment variables work. |
| `doppler run --watch -- cmd` | Long-lived connection; on change the CLI fetches, sends SIGTERM, waits up to 10 s, SIGKILL, re-runs the command. Team and Enterprise plans only. Source: https://docs.doppler.com/docs/automatic-restart.md | Seconds, by killing the process. All watchers restart together, which "can result in downtime when used in production". No latency figure is published. |
| Webhook | POST on `config.secrets.update` with `project`, `config` and a `diff` of changed secret names (no values listed); optional HMAC in `X-Doppler-Signature`; up to 5 attempts, exactly-once not guaranteed. Source: https://docs.doppler.com/docs/webhooks.md | Not published. The receiver still has to fetch and restart or reload something. Limit 5 webhooks on Developer (https://docs.doppler.com/docs/platform-limits); UNCONFIRMED whether any plan lacks webhooks. |
| Doppler Kubernetes Operator | Polls: "by default, it checks for changes every 60 seconds" (`resyncSeconds`); can optionally reload deployments that reference the managed secret. Sources: https://docs.doppler.com/docs/doppler-k8s-operator-syncing-secrets , https://docs.doppler.com/docs/kubernetes-operator | About 60 s to the Kubernetes Secret, plus a rollout for env-var consumers. |
| External Secrets Operator | Polls at `spec.refreshInterval` (examples use 1h; 0 means create once); a sync can be forced with `kubectl annotate es <name> force-sync=$(date +%s) --overwrite`. Source: https://external-secrets.io/latest/api/externalsecret/ . Service tokens recommended. Source: https://docs.doppler.com/docs/external-secrets-provider.md | Up to one refresh interval, plus a pod restart for env-var consumers (the ESO page does not restart pods; that needs a separate reloader). |
| `doppler secrets get NAME --plain` per call | Fresh read each time. Source: https://docs.doppler.com/docs/accessing-secrets | Immediate, at one secret-read per call against the 120/min Developer limit. |
| CLI fallback file | `doppler run` writes "an encrypted snapshot of the current secrets"; it "can be used indefinitely" and "is not designed with expiry in mind". Source: https://docs.doppler.com/docs/automatic-fallbacks.md | Can serve the old key when the API is unreachable or `--fallback-only` is set. |

### B4. Native rotation

- Rotated secrets: Doppler keeps two instances (active and inactive) at the provider and switches them halfway through each rotation interval, which is measured in days. A service is rotatable only if it supports two live credentials and creating/deleting them by API. "This feature is available with our Team and Enterprise plans." Source: https://docs.doppler.com/docs/secrets-rotation.md
- It rotates credentials on a calendar for security. It is not a selector driven by remaining quota, and the docs describe no way to plug in a custom script or webhook as the rotation method (webhooks appear only as post-rotation triggers). Source: https://docs.doppler.com/docs/secrets-rotation.md
- UNCONFIRMED: the current list of rotation integrations; the page gives only generic examples (database users, API keys, IAM users). None of the four search vendors is named.
- Dynamic secrets: short-lived leases (default TTL 30 minutes), AWS IAM as the example; "This feature is exclusive to our Enterprise Plan." Source: https://docs.doppler.com/docs/dynamic-secrets.md

### B5. Audit trail

- Activity logs record "every action your team makes", and a config change links to a config log. Source: https://docs.doppler.com/docs/workplace-logs.md
- Config logs are a `git log`-style history ("every action within a config such as adding a secret, is recorded and viewable") with rollback for secret adds, updates and deletes. "Every version of a secret is retained for the lifetime of that secret." Source: https://docs.doppler.com/docs/versioning.md
- So each swap of the canonical secret is a timestamped config-log entry, and old values stay in version history. Retention of activity logs: 3 days on Developer, 90 on Team, 1095 on Enterprise. Source: https://docs.doppler.com/docs/platform-limits
- UNCONFIRMED: whether config-log entries are subject to the same retention as activity logs, whether the entry names the token that made the change, and whether secret reads are logged on any plan.
- Every past key value staying in history is a property to weigh: it is useful for audit and it is more places the key lives.

### B6. Failure modes of a secrets manager used as a hot-swap load balancer

- Stale environment. Anything started with `doppler run` keeps the key it was born with. Long-running agents, MCP servers and services keep sending the exhausted key until restarted. The only documented automatic fix is `--watch`, which is plan-gated and works by killing the process. Source: https://docs.doppler.com/docs/automatic-restart.md
- One active key, not a balancer. A single canonical value means all clients drain the same key at once and all move together. There is no per-request choice and no spreading.
- No meter. Doppler stores values. Nothing in its docs measures provider allowance, so the rotator needs its own usage source and the dashboard lives elsewhere.
- Swap during a request. A request in flight completes or fails on the old key. Clients that read at different moments are split across old and new for as long as the slowest consumer takes to refresh: seconds for per-call reads, about 60 s for the operator, the refresh interval for ESO, forever for plain `doppler run`. With cross-project references the fan-out is explicitly not atomic. Source: https://docs.doppler.com/docs/secrets.md
- Read rate limits. A CLI that calls Doppler on every invocation spends one secret read each time; parallel agents sharing one token can pass 120 reads a minute on Developer and get 429. Rate limits are per token, so separate tokens per client raise the ceiling (50 service tokens on Developer). Source: https://docs.doppler.com/docs/platform-limits
- Fallback snapshots. The CLI's offline snapshot never expires by design and can hand back the previous key. Source: https://docs.doppler.com/docs/automatic-fallbacks.md
- Clients that never read Doppler. A hosted MCP connector authorised by OAuth in the vendor's or the agent host's UI holds its own grant; no secret swap reaches it. A hosted MCP URL with the key pasted into a client's config file is the same unless that file is rendered from Doppler and the client restarted.
- Dangling reference. Re-pointing to a name that does not exist injects the literal `${...}` string as the key. Source: https://docs.doppler.com/docs/secrets.md
- Writes are cheap but shared: 60 a minute on Developer, per token. Source: https://docs.doppler.com/docs/platform-limits

### Part B summary

- Doppler is a sound place to store the pool and a workable slow switch (minutes, not requests) for consumers that re-read on start or per call.
- It is not a per-request selector, has no allowance metering, and on a free plan lacks `--watch`, rotated secrets, service accounts and (probably) cross-project references.

---

## Which mechanism fits which client type

| Client type | LiteLLM proxy | Doppler swap | Fit |
|---|---|---|---|
| Short-lived CLI invoked by agents | Calls `/v1/search/<tool>` with a virtual key; key choice happens server-side per request | Works if the CLI reads the secret at each start; watch the 120 reads/min limit | Either. Proxy gives metering and per-request choice; Doppler alone gives a slow global switch |
| stdio MCP server started with `doppler run` | Point the client at the proxy's MCP gateway instead, or have the server call the proxy | Key frozen at start; changes need a restart (`--watch` on Team and up) | Proxy. Doppler only with a restart path |
| Hosted remote MCP authenticated by OAuth | Only if the proxy itself can hold the upstream OAuth grant; one grant per server, no pool | No effect; the grant is not a Doppler secret | Neither brokers it. Treat as a separate, unmetered lane |
| Hosted remote MCP with API key in URL or header | Proxy fronts it and injects the key; one key per server entry, swap via `PUT /v1/mcp/server` or two entries | Only if client config is rendered from Doppler and the client restarted | Proxy |
| SDK calls inside long-running services | Search via `/v1/search`; other vendor APIs via a single-key pass-through route | Stale until restart | Proxy for search; pass-through for the rest, one key per route |
| Vendor APIs beyond search (scrape, crawl, extract, contents) | Pass-through or MCP only; single credential; flat per-request cost | Same staleness rules as above | Proxy pass-through, with rotation done by the sidecar rewriting the route or by one route per key |

In every row the allowance meter and the "which key next" decision are missing from both products and would be the sidecar's job.

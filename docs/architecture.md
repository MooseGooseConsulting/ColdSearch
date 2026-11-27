---
title: Architecture
date: 2026-11-27
author: Patrick MacLyman
status: living
doc_type: architecture
---

# Architecture

## Architecture Thesis

ColdSearch is one MCP gateway in front of the search providers. Agents connect to it in place of each provider. It lists each provider's tools as the provider defines them, holds the keys, moves a call to the next key when one is out of credit, records every attempt with its full request and response, and serves the curated skills that tell agents which tool suits which job (`docs/ADRs/006-mcp-gateway.md`, `docs/components/gateway.md`).

The code built before the gateway is a one-shot CLI that normalizes `search`, `extract` and `crawl` across provider adapters, with fanout, an agent mode, a batch runner, a cache and execution history. It still ships and still works. It is marked **Current (legacy)** below: new work does not build on it, and each part is a candidate for removal. Nothing has been removed. `docs/reviews/2026-11-27-legacy-surface-inventory.md` lists each part, whether the gateway depends on it, and a recommendation.

## Status Legend

- **Current** — implemented or directly reflected in the repo.
- **Current (legacy)** — implemented and still shipped, but part of the pre-gateway surface and a candidate for removal. Not removed.
- **Planned** — decided direction, not fully implemented.
- **Candidate** — plausible option, not decided.
- **Deferred** — intentionally not being built now.

## System Shape

### Gateway

| Area | Status | Approach |
|------|--------|----------|
| MCP gateway entrypoint | Current | `coldsearch mcp`: stdio for one agent, streamable HTTP at `/mcp` for many; one core behind both |
| Tools from provider API documents | Current | `openapi` upstreams: one tool per operation of the provider's published OpenAPI document. Presets: `exa`, `firecrawl`, `parallel`, `tavily` |
| Tools from hosted MCP servers | Current | `mcp` upstreams passed through unchanged, for providers with no API document. Presets: `brightdata`, `tinyfish`, `context` (preset from documentation, not yet run) and the `<name>mcp` variants |
| Tool naming, modes and filters | Current | Names are `<upstream>__<tool>`; `all` lists every tool, `lazy` lists five gateway tools and reaches the rest by find, describe and call; per-upstream `include` and `exclude` patterns |
| Ordered key lists with failover | Current | Each upstream's `keys` list is the drain order. A key that is out of credit or rejected is skipped for a cooldown and the same call is retried on the next key. Skipped keys are saved in a state file |
| Call ledger | Current | One JSONL line per attempt (key reference, duration, error class, cost when the provider reports it) and one payload file with the full request and response |
| Curated skills | Current | `skills/<name>/SKILL.md` served as a tool, an MCP prompt and an MCP resource. One skill today, `search-routing`, a draft not yet tested on real agent runs |
| HTTP access control | Current | Binds to loopback by default; any other bind address requires a bearer token |
| Hosting as a remote MCP server | Planned | No deployment manifest and no OAuth for the HTTP endpoint yet, so a hosted assistant that needs OAuth cannot connect |
| Gateway-native fetch, map and crawl | Planned | Commodity work done by the gateway itself, with a provider as the fallback for pages it cannot get (`docs/ADRs/006-mcp-gateway.md`) |
| Remaining allowance per account | Planned | The gateway records what a call cost when the provider says so. It does not yet ask providers what each account has left |
| Configured-key rotator | Planned | Keep the one configured key per provider in the secret store on an account that still has allowance |
| Allowance dashboard | Planned | A visual view of use and remaining allowance per key |
| Searchable memory over recorded calls | Planned | A lookup over the ledger and payload files (North Star G3). Today they are files on the gateway host |
| Payload retention | Planned | Nothing prunes payload files yet |

### Shared

| Area | Status | Approach |
|------|--------|----------|
| CLI entrypoint | Current | `coldsearch` (+ `usearch` alias). `coldsearch mcp` starts the gateway; every other command belongs to the legacy surface |
| Key and secret resolution | Current | `doppler:` refs and Doppler-injected environment variables preferred; `env:` refs supported. Used by gateway key lists and by legacy key pools |
| Config file | Current | `~/.config/coldsearch/config.toml`. `[gateway]` configures the gateway; `[capabilities]` and `[providers]` configure the legacy commands and are not needed by a gateway-only config |

### Pre-gateway CLI

| Area | Status | Approach |
|------|--------|----------|
| Normalized capabilities | Current (legacy) | `search`, `extract`, `crawl` as category views over provider tools; adapters + fanout/RRF |
| Provider-tool profile registry | Current (legacy) | `ProviderToolProfile` per native tool; `tool list`/`tool info`; feature-predicate routing. The gateway does not read it |
| Provider-tool call execution | Current (legacy) | Networked `tool call <provider>.<tool>` over the profile registry |
| Config-driven routing | Current (legacy) | Provider pools per capability; keyless providers supported; per-process key pools |
| Basic cache store | Current (legacy) | Read-through file cache for search/extract |
| Search history / research memory | Current (legacy) | Durable execution records for the legacy commands; recent/search/show exploration. Gateway calls are not in it |
| Usage and audit logging | Current (legacy) | JSONL usage log for the legacy commands. The gateway writes its own ledger |
| Agent mode | Current (legacy) | ReAct loop; OpenAI-compatible LLM dispatch |
| Batch enrichment | Current (legacy) | `coldsearch batch`: resumable JSONL in/out over the legacy commands and `tool call` |
| Execution backend seam | Current (legacy) | `LocalExecutionBackend` owns in-process execution of the legacy commands |
| Service / API entrypoints for normalized capabilities | Deferred | The gateway is the service entrypoint (`docs/ADRs/006-mcp-gateway.md`); thin wrappers over the normalized commands are not being built |
| Remote / hybrid worker implementation | Deferred | Async jobs behind CLI; centralized secrets; see `plans/2026-06-22-epic-5-remote-agentic-execution.md` |

## Major Components

### Gateway

| Component | Status | Responsibility | Detail |
|-----------|--------|----------------|--------|
| Gateway entry (`src/gateway/run.ts`) | Current | `coldsearch mcp` flags, stdio and HTTP transports, token check | `docs/components/gateway.md` |
| Gateway server (`src/gateway/server.ts`) | Current | MCP handlers for tools, prompts and resources; the gateway's own tools; lazy mode | `docs/components/gateway.md` |
| Gateway core (`src/gateway/core.ts`) | Current | Upstream connections, tool lists, key order, failover, status | `docs/ADRs/006-mcp-gateway.md` |
| API-document upstream (`src/gateway/openapi.ts`) | Current | Builds tools from an OpenAPI document and calls the provider's API | `docs/components/gateway.md` |
| Gateway config (`src/gateway/config.ts`) | Current | Upstream presets, validation of `[gateway]`, include and exclude matching | `docs/components/gateway.md` |
| Ledger (`src/gateway/ledger.ts`) | Current | Ledger lines, payload files, redaction, cost extraction, per-key summaries | `docs/components/gateway.md` |
| Skills (`src/gateway/skills.ts`, `skills/`) | Current | Loads and serves curated skills | `docs/components/gateway.md` |

### Shared

| Component | Status | Responsibility | Detail |
|-----------|--------|----------------|--------|
| Interface (`src/cli.ts`) | Current | Dispatches `mcp` to the gateway; parses and runs the legacy commands | — |
| Secret resolution (`src/engine/keypool.ts`) | Current | Resolves `doppler:` and `env:` references with a short cache. The gateway uses `resolveRef`; the pool rotation in the same file serves the legacy commands only | `docs/KEY_MANAGEMENT.md` |
| Config loader (`src/config.ts`) | Current | Finds and parses the TOML config | `docs/CONFIGURATION.md` |
| Key reference formatting (`src/logging/usage.ts`) | Current | `safeKeyRef`: the form of a key reference that is safe to log. The usage logger in the same file is legacy | — |

### Pre-gateway CLI

| Component | Status | Responsibility | Detail |
|-----------|--------|----------------|--------|
| Execution backend | Current (legacy) | Local seam for search, extract, crawl, agent | `docs/components/execution-backends.md` |
| Fanout engine | Current (legacy) | Provider pools, fanout, RRF merge | `docs/ADRs/002-rrf-reranking.md` |
| Routing and request core | Current (legacy) | Validation, keys, retries, timeouts, errors | `docs/components/routing-and-requests.md` |
| Provider adapters | Current (legacy) | One module per vendor; shared schema | `docs/PROVIDERS.md` |
| Provider registry | Current (legacy) | Capability matrix in code | `src/providers.ts` |
| Provider-tool profile registry | Current (legacy) | Native tool params, common-view mappings, feature predicates | `docs/ADRs/005-provider-tool-profiles.md`, `src/registry/tool-profiles.ts` |
| Cache store | Current (legacy) | Read-through JSON cache | `src/cache/` |
| Execution history and observability | Current (legacy) | Durable, searchable execution history plus provider-partition inspection | `docs/components/cache-and-observability.md` |
| Agent | Current (legacy) | ReAct + SSRF-safe fetch | `docs/ADRs/003-react-agent.md`, `docs/ADRs/004-ssrf-protection.md` |
| Batch runner | Current (legacy) | Resumable JSONL runs over the legacy commands and `tool call` | `src/batch/` |

## Architectural Invariants

Gateway:

- **Provider tools pass through.** A tool's arguments are the provider's own parameters and its result is the provider's own response. The gateway names the tool (`<upstream>__<tool>`) and does not rename arguments or reshape results (`docs/NORTH_STAR.md` G4).
- **One core for every client.** Stdio and HTTP serve the same core. Key choice, failover, filters and the ledger must not depend on the transport or on which agent connected.
- **Every attempt is recorded.** Each forwarded attempt writes one ledger line, and its full request and response unless the operator turned payloads off. A ledger that cannot be written is reported on stderr and never fails the call it describes (`docs/NORTH_STAR.md` Audit First pillar).
- **Keys stay inside the gateway.** Agents never receive a key. The ledger and payload files hold the key reference, never the value, and resolved key values are redacted from arguments, errors and payloads before they reach disk.
- **Failover is per key, and only for a key's own fault.** An out-of-credit or rejected key is skipped and the call retried on the next key. A rate limit or any other upstream error is returned to the agent as the provider reported it.
- **No silent replay.** The gateway does not answer a provider call from stored results. Reuse of prior results is an explicit lookup (`docs/NORTH_STAR.md` G3).
- **A hidden tool is not callable.** `include` and `exclude` apply to calling as well as listing.
- **No open bind without a token.** HTTP mode refuses any non-loopback bind address unless a bearer token is set.

Whole repository:

- **Config over code.** Upstreams, key order, filters, routing, pools, cache policy, and endpoints live in TOML, not hardcoded switches.
- **Doppler for secret injection.** Operator secrets should enter the process through Doppler-managed environment injection where possible; ColdSearch code reads normal environment variables, explicit `env:` refs, `doppler:` refs, or keyless provider config and must not log secret values.
- **Comparison is observational.** Provider-effectiveness exploration uses accumulated executions and is not a release gate. Live native-vs-ColdSearch checks are integration conformance scoped to provider-facing changes, never routine benchmarks.

Pre-gateway CLI only (these hold for the legacy commands while they ship):

- **Fanout isolates provider errors.** Under `strategy = "all"`, `search` queries every provider in the pool and one provider's failure does not fail the request (`docs/ADRs/001-fanout-architecture.md`).
- **History and cache are distinct.** History records what the legacy commands did and remains inspectable independently of cache expiry or clearing. Exact response replay is a supporting cache policy and remains freshness-controlled; related history never becomes an automatic cache hit.
- **Provider coverage is documented.** Registry and `docs/PROVIDERS.md` Dual Matrix stay in sync (`npm run test:docs`).

## ADR Index

| ADR | Status | Summary |
|-----|--------|---------|
| `docs/ADRs/001-fanout-architecture.md` | accepted; narrowed by 006 | Fanout with per-provider error isolation. Applies only to the legacy `search` command; a gateway call names one provider tool |
| `docs/ADRs/002-rrf-reranking.md` | accepted; narrowed by 006 | RRF for cross-provider merge. Applies only to legacy fanout; the gateway returns one provider's result unmerged |
| `docs/ADRs/003-react-agent.md` | accepted; narrowed by 006 | ReAct loop for agent mode. Applies only to the legacy `--agent` flag; the gateway serves agents and does not run one |
| `docs/ADRs/004-ssrf-protection.md` | accepted | SSRF checks on agent fetch. The gateway-native fetch planned in 006 must apply the same checks |
| `docs/ADRs/005-provider-tool-profiles.md` | accepted; narrowed by 006 | Provider-tool profiles + feature-predicate routing. Applies only to the legacy commands and `tool call`; the gateway's tools come from provider API documents |
| `docs/ADRs/006-mcp-gateway.md` | proposed | The MCP gateway is the surface: tools from provider API documents, ordered key lists with failover, full ledger, served skills, gateway-native commodity work |

"Narrowed" means the decision still describes code that ships, but no longer describes how the primary surface works. ADR 006 gives the reasoning for each and says what would turn "narrowed" into "superseded".

## Open Architecture Questions

- Resolved: the first entrypoint after the CLI is the MCP gateway (`docs/ADRs/006-mcp-gateway.md`).
- Resolved: Doppler is the documented bootstrap path (`docs/KEY_MANAGEMENT.md`); BWS runtime support was removed and `bws:` refs now error (`docs/BWS_INTEGRATION.md` is the migration stub).
- Which parts of the pre-gateway CLI are removed, and when? `docs/reviews/2026-11-27-legacy-surface-inventory.md` is the input.
- Brave, Serper, Jina and SearXNG are reachable only through the legacy adapters. Does each get a gateway upstream, or leave scope?
- How does a hosted assistant authenticate to the HTTP endpoint? It has a single bearer token today.
- Where do the ledger and payload files live once the gateway is hosted, and how long are payloads kept?
- How do the gateway's ordered key lists and the configured-key rotator share one view of which account has allowance left?
- A long-running provider job started with one key cannot be polled after the gateway moves to another key. Pin the job to its key, or leave it to the agent?

## Links

- `docs/NORTH_STAR.md` — intent, goals, pillars
- `docs/components/gateway.md` — gateway configuration and behavior
- `docs/ADRs/006-mcp-gateway.md` — the gateway decision
- `docs/reviews/2026-11-27-legacy-surface-inventory.md` — pre-gateway modules and what to do with each
- `docs/PROVIDERS.md` — provider and tool matrix for the legacy commands
- `docs/CONFIGURATION.md` — config reference
- `docs/contributing/adding-a-provider.md` — adapter + provider-tool profile contract (legacy commands)
- `docs/components/` — subsystem detail
- `plans/` — active implementation plans (informational; not authority)

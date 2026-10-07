---
title: Architecture
date: 2026-06-22
author: Patrick MacLyman
status: living
doc_type: architecture
---

# Architecture

## Architecture Thesis

ColdSearch is one runtime that reaches multiple provider tools through a config-driven surface.

Normalized capabilities (`search`, `extract`, `crawl`) are **category views** over heterogeneous provider-native tools, not apples-to-apples provider features. Each provider-native tool carries a profile (native params, common-view mappings, feature predicates) in the provider-tool profile registry, so routing can be requirement-aware and name collisions stay explicit (`docs/ADRs/005-provider-tool-profiles.md`). Useful vendor tools beyond the three capabilities are exposed through this controlled surface, not separate per-vendor CLIs or MCPs.

## Status Legend

- **Current** — implemented or directly reflected in the repo.
- **Planned** — decided direction, not fully implemented.
- **Candidate** — plausible option, not decided.
- **Deferred** — intentionally not being built now.

## System Shape

| Area | Status | Approach |
|------|--------|----------|
| CLI entrypoint | Current | `coldsearch` (+ `usearch` alias); search, extract, crawl, agent, status |
| Normalized capabilities | Current | `search`, `extract`, `crawl` as category views over provider tools; adapters + fanout/RRF |
| Provider-tool profile registry | Current | `ProviderToolProfile` per native tool; `tool list`/`tool info`; feature-predicate routing |
| Provider-tool call execution | Current | Networked `tool call <provider>.<tool>` over the profile registry |
| Config-driven routing | Current | `~/.config/coldsearch/config.toml`; provider pools per capability |
| Key and secret resolution | Current | Env refs, Doppler CLI refs/defaults, and keyless providers supported; per-process pools; BWS refs rejected with migration guidance |
| Basic cache store | Current | Read-through file cache for search/extract |
| Search history / research memory | Current | Durable execution records; recent/search/show exploration; stored fanout inspection and related prior work |
| Usage and audit logging | Current | JSONL usage log; richer flow logs and trace correlation Planned |
| Agent mode | Current | ReAct loop; OpenAI-compatible LLM dispatch |
| Service / API / MCP entrypoints | Planned | Same core, thin wrappers |
| Execution backend seam | Current | `LocalExecutionBackend` owns in-process execution and is the seam for future backends |
| Remote / hybrid worker implementation | Deferred | Async jobs behind CLI; centralized secrets; see `plans/2026-06-22-epic-5-remote-agentic-execution.md` |
| Batch enrichment | Planned | JSONL batch in/out with dedup and cache |

## Major Components

| Component | Status | Responsibility | Detail |
|-----------|--------|----------------|--------|
| Interface (`src/cli.ts`) | Current | Commands, JSON and human output | — |
| Execution backend | Current | Local seam for search, extract, crawl, agent | `docs/components/execution-backends.md` |
| Fanout engine | Current | Provider pools, fanout, RRF merge | `docs/ADRs/002-rrf-reranking.md` |
| Routing and request core | Current | Validation, keys, retries, timeouts, errors | `docs/components/routing-and-requests.md` |
| Provider adapters | Current | One module per vendor; shared schema | `docs/PROVIDERS.md` |
| Provider registry | Current | Capability matrix in code | `src/providers.ts` |
| Provider-tool profile registry | Current | Native tool params, common-view mappings, feature predicates | `docs/ADRs/005-provider-tool-profiles.md`, `src/registry/tool-profiles.ts` |
| Cache store | Current | Read-through JSON cache | `src/cache/` |
| Execution history and observability | Current | Durable, searchable execution history plus provider-partition inspection | `docs/components/cache-and-observability.md` |
| Agent | Current | ReAct + SSRF-safe fetch | `docs/ADRs/003-react-agent.md`, `docs/ADRs/004-ssrf-protection.md` |

## Architectural Invariants

- **Config over code.** Routing, pools, keys, cache policy, and endpoints live in TOML, not hardcoded switches.
- **Doppler for secret injection.** Operator secrets should enter the process through Doppler-managed environment injection where possible; ColdSearch code reads normal environment variables, explicit `env:` refs, `doppler:` refs, or keyless provider config and must not log secret values.
- **Interface-agnostic core.** Routing, keys, retries, and normalization must not depend on whether the caller is CLI, API, or MCP (Planned entrypoints).
- **Comparable execution.** Fanout and per-provider error isolation enable cross-provider comparison (`docs/ADRs/001-fanout-architecture.md`).
- **Logging is a product surface.** Networked work, routing, cache lookup/retrieval, key selection by safe reference, retries, errors, timings, run IDs, and agent/tool flow should produce rich durable logs (`docs/NORTH_STAR.md` Audit First pillar).
- **History and cache are distinct.** History records what ColdSearch did and remains inspectable independently of cache expiry or clearing. Exact response replay is a supporting cache policy and remains freshness-controlled; related history never becomes an automatic cache hit (`docs/NORTH_STAR.md` G3).
- **Evaluation is observational.** Provider-effectiveness exploration uses accumulated executions and is not a release gate. Live native-vs-ColdSearch checks are integration conformance scoped to provider-facing changes, never routine benchmarks.
- **No lossy normalization.** Shared schemas are convenience; provider detail stays available when needed (`docs/NORTH_STAR.md` G4).
- **Provider coverage is documented.** Registry and `docs/PROVIDERS.md` Dual Matrix stay in sync (`npm run test:docs`).

## ADR Index

| ADR | Status | Summary |
|-----|--------|---------|
| `docs/ADRs/001-fanout-architecture.md` | accepted | Fanout with per-provider error isolation |
| `docs/ADRs/002-rrf-reranking.md` | accepted | RRF for cross-provider merge |
| `docs/ADRs/003-react-agent.md` | accepted | ReAct loop for agent mode |
| `docs/ADRs/004-ssrf-protection.md` | accepted | SSRF checks on agent fetch |
| `docs/ADRs/005-provider-tool-profiles.md` | accepted | Provider-tool profiles + feature-predicate routing |

## Open Architecture Questions

- Resolved: provider tools are modeled as profiles backing ColdSearch category views, discoverable via `coldsearch tool <list|info>`, with networked `tool call` execution implemented (`docs/ADRs/005-provider-tool-profiles.md`). The next active product work is searchable result memory/cache operations, followed by batch execution, operator UX, and agent trace correlation.
- Which entrypoint ships first after CLI: HTTP API, MCP server, or both?
- What cache freshness defaults balance hits vs stale results in agent loops?
- Resolved: Doppler is the documented default in `docs/CONFIGURATION.md` and `docs/KEY_MANAGEMENT.md`. BWS runtime support has been removed; `bws:` references fail with migration guidance. Shared injected-environment support across provider and LLM key resolution remains a follow-up.

## Links

- `docs/NORTH_STAR.md` — intent, goals, pillars
- `docs/PROVIDERS.md` — provider and tool matrix
- `docs/CONFIGURATION.md` — config reference
- `docs/contributing/adding-a-provider.md` — adapter + provider-tool profile contract
- `docs/components/` — subsystem detail
- `plans/` — active implementation plans (informational; not authority)

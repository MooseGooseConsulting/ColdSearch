---
title: Project Review and Bright Data Assessment
date: 2026-07-16
author: Patrick MacLyman
status: snapshot
doc_type: project-review
---

# Project Review and Bright Data Assessment

> **Snapshot: 2026-07-16.** Account balances, promotions, GitHub state, and validation results below are dated observations. They do not override `docs/NORTH_STAR.md`, `docs/architecture.md`, the code, or current GitHub state.

## What ColdSearch Is Trying To Do

ColdSearch is one audited, local-first surface for provider-backed web search, page extraction, crawling, and useful provider-native tools. A caller should be able to use portable category commands when the provider does not matter, deliberately invoke a native provider tool when it does, compare results across providers, spread work across configured keys and free quotas, preserve raw provider detail, and inspect what happened afterward.

The intended product shape is:

- **One runtime, two access lanes.** `search`, `extract`, and `crawl` are normalized category views; `tool list`, `tool info`, and `tool call` preserve provider-native reachability.
- **Controlled and observable routing.** Configuration controls eligible providers, selection, keys, and endpoints. Default work must not become opaque model-directed routing.
- **Comparable execution.** Provider overlap is useful because ColdSearch should reveal which provider or tool works best for a job.
- **Searchable recent-result memory.** Prior work should become inspectable and retrievable before more provider quota is spent. Silent stale replay is not the goal.
- **Raw detail plus auditability.** Normalized outputs are conveniences, not permission to discard provider detail. Networked work must leave safe, useful traces.
- **Fail-visible operation.** Errors should distinguish configuration, credentials, reachability, quota, unsupported capabilities, and provider failures.

ColdSearch is not a pile of disconnected wrappers, a lossy lowest-common-denominator API, or a reason to pay per token for Anthropic. The North Star remains the authority for these boundaries.

## Current Project State

| Area | State on 2026-07-16 | Evidence and interpretation |
|------|---------------------|-----------------------------|
| Normalized `search` / `extract` / `crawl` | **Current** | Provider pools, requirement-aware selection, fanout/RRF, and per-provider isolation are implemented. |
| Provider-tool discovery and execution | **Current** | `tool list`, `tool info`, and networked `tool call <provider>.<tool>` landed in PR #44, with follow-ups in #45. |
| Config and secret resolution | **Current, uneven UX** | TOML, environment, Doppler references, optional BWS references, keyless providers, and OpenAI-compatible base URLs exist. A guided `config init` / `config doctor` surface does not. |
| Basic result cache | **Current, Phase A1** | Search/extract read-through cache exists. Writes are not atomic, permissions are not hardened, and management/search commands do not exist. |
| Usage logging | **Current, partial correlation** | JSONL logging and optional `runId` storage exist. Agent mode does not yet generate and thread a run ID and step number through its calls. |
| Searchable recent-result memory | **Planned** | This is the next major product lane and overlaps the remaining work in issue #31. |
| Batch workflows | **Planned** | JSONL batch execution, resumability, concurrency, and cache reuse are designed but not implemented. |
| Remote/hybrid execution | **Deferred** | The execution-backend seam exists; no remote worker stack has been selected. |
| Bright Data | **Candidate only** | No adapter, registry entry, credentials path, default-pool entry, or live ColdSearch verification exists. |

## Bright Data Account Snapshot

The Bright Data dashboard and billing ledger were reviewed read-only. No proxy session, search request, scrape, crawl, browser action, MCP request, or provider API call was made during this review.

| Account fact | Observed value |
|--------------|----------------|
| Account mode | Pay as you go |
| Total balance | **$307** |
| Paid balance | **$150** |
| Promotional balance | **$157** |
| Promotional composition | $150 first-deposit matching bonus, plus separate $5 and $2 promotions |
| Consumed balance shown | **$0** |
| Active products shown | None |
| MCP free requests | **5,000 / 5,000 remaining** |
| MCP renewal shown | **2026-08-01** |

Bright Data's [MCP FAQ](https://docs.brightdata.com/ai/mcp-server/faqs) says its free MCP tier includes 5,000 monthly requests for search and public-page scraping through Web Unlocker; after exhaustion, free-tier requests fail and a paid Web Unlocker zone is required. Bright Data's [billing documentation](https://docs.brightdata.com/general/account/billing-and-pricing/billing) says a first-deposit matching promotion is valid for 90 days and requires at least $5 of monthly usage to remain valid.

The ledger showed the $150 matching credit added on 2026-07-15. If the standard 90-day rule applies without an account-specific exception, that suggests an expiry around 2026-10-13. That date is an inference, not a confirmed account deadline. The expiry rules for the separate $5 and $2 promotions were not established in this review.

### What “do not burn through it” means

The balance is meaningful, but it is not a reason to put Bright Data into a default provider pool. The free MCP allowance should be treated separately from paid and promotional dollars, and promotional deadlines should be confirmed before they influence implementation priority.

No recurring workload should be enabled until ColdSearch can answer all of these questions from its own logs:

1. Which product, tool, and zone handled the request?
2. Was the request free-tier, promotional-credit, or paid usage?
3. How many requests and estimated dollars did the run consume?
4. What result quality or provider-specific capability justified that spend?
5. Can the same result be reused safely from recent-result memory?

## Where Bright Data Fits

Bright Data covers several different product shapes. They should not be flattened into one generic provider label.

| Bright Data surface | ColdSearch fit | Initial policy |
|---------------------|----------------|----------------|
| SERP/search products | `search` category backer | Candidate for explicit single-provider benchmarks before pool eligibility. |
| Web Unlocker / public-page retrieval | `extract` category backer | Candidate for URLs that defeat ordinary HTTP extraction; start explicit-only. |
| Crawling products | `crawl` category backer | Candidate only after output, polling, cancellation, and spend behavior are characterized. |
| Structured scrapers and datasets | Provider-native tools | Preserve their schemas and raw output; do not force them into normalized search results. |
| Browser and proxy products | High-cost provider-native tools | Explicit opt-in only, with narrower authorization and hard run caps. Never default routing. |

Before any Bright Data implementation can be promoted beyond **candidate**, it needs:

- an adapter and provider-tool profile with explicit supported and excluded surfaces;
- Doppler/environment-based secret injection with no secret values in logs;
- per-run request caps and a configurable dollar ceiling;
- usage records that identify Bright Data product/zone, result count, latency, success, and cost when available;
- provider-native versus ColdSearch parity evidence for every added path;
- offline tests with no paid network calls;
- manual live verification on an explicit provider selection;
- no paid or promotional-credit consumption in routine CI;
- disabled-by-default pool membership until quality and cost evidence justify promotion.

The separate Bright Data guidance previously created for retailer and pricing acquisition is adjacent evidence, not ColdSearch authority. Its residual/fallback acquisition pattern is useful, but retail-market workflows must not be transplanted into ColdSearch's default routing policy.

## GitHub Issue Review

| Issue | Live assessment | Recommended tracker action |
|-------|-----------------|----------------------------|
| [#40 — Saved searches, templates, and categorical invocation](https://github.com/Coldaine/ColdSearch/issues/40) | **Partially stale.** Categorical commands and `tool call` are implemented, and the example config selects random routing. An omitted strategy still falls back to `all`; saved routines/pipelines and durable `-F` / `--set` updates also remain. | Rewrite or split the remaining deliverables; do not close as fully complete. |
| [#31 — Cache Phase A2](https://github.com/Coldaine/ColdSearch/issues/31) | **Open and valid; highest product-aligned next step.** Cache writes still target the final file directly, permissions use defaults, and clear/stats/search/recent operations are absent. | Keep open and align it with PR2/searchable recent-result memory. |
| [#14 — Agent run IDs](https://github.com/Coldaine/ColdSearch/issues/14) | **Open and valid.** `UsageLogEntry` can store an optional `runId`, but `SearchAgent` does not generate or propagate run IDs or step numbers. | Keep open; implement after or alongside the observability portion of cache work. |
| [#8 — GitHub search playbook](https://github.com/Coldaine/ColdSearch/issues/8) | **Intentional long-term work, wrong ownership surface.** Its own body identifies it as org-wide agent ergonomics rather than ColdSearch runtime. | Move to a shared tooling/configuration tracker and close or cross-link this copy. |
| [#6 — Config/bootstrap and routing UX](https://github.com/Coldaine/ColdSearch/issues/6) | **Mostly implemented or superseded.** Bootstrap documentation, a random-routing example config, Exa crawl, SearXNG configuration, OpenAI-compatible base URL support, SSRF-safe fetch, mode/status fixes, and PR #4 cleanup are present. Guided config commands and broader error classification remain separate planned work. | Close as superseded after recording the remaining UX work in its active plan or a narrower issue. |

## Pull Request Review

| Pull request | State on 2026-07-16 | Assessment |
|--------------|---------------------|------------|
| [#43 — generic call substrate plan](https://github.com/Coldaine/ColdSearch/pull/43) | **Open, non-draft, blocked; checks green** | The only changed file is the old PR1 plan. Its implementation was superseded by merged PRs #44 and #45. Do not merge it as-is; close it as superseded after preserving any still-useful planning detail. |
| [#44 — provider tool surface](https://github.com/Coldaine/ColdSearch/pull/44) | **Merged 2026-06-26** | Implemented the provider-tool registry and generic substrate. |
| [#45 — PR #44 follow-ups](https://github.com/Coldaine/ColdSearch/pull/45) | **Merged 2026-06-26** | Landed the quick-win corrections found during review. |
| [#46 — North Star and architecture](https://github.com/Coldaine/ColdSearch/pull/46) | **Merged 2026-06-30** | Established the current intent and architecture authority chain. |

One unresolved review thread on #43 discussed the promisified `execFile` result shape. That thread is attached to outdated branch history and should not be treated as current architecture authority; current code and passing tests are the evidence surface.

## Memory Review

Historical project memory remains useful for intent continuity, especially the two-lane model of normalized category views plus raw provider tools, the requirement for live provider parity evidence, and the North Star's authority. It is not a source of current implementation state.

The live reconciliation rule is:

1. `docs/NORTH_STAR.md` defines intent and boundaries.
2. `docs/architecture.md` defines durable technical shape and invariants.
3. Code, tests, and current GitHub state define what is implemented, open, merged, or blocked.
4. Plans are informational and can lag implementation.
5. Historical memory supplies context only; renamed files, deleted documents, old branch claims, and old checklist state must be reverified before use.

This review found exactly that kind of drift: the June master plan still described provider-tool work as missing even though PRs #44 and #45 had already landed it. The plan is therefore being status-stamped rather than treated as live truth.

## Validation Evidence

The following checks passed from a clean branch based on `origin/main` on 2026-07-16:

- `npm install`
- `npm test` (includes TypeScript build and the full offline test suite)
- `npm run build`
- `npm run test:docs`
- `git diff --check`

`npm install` reported one high-severity dependency advisory. This documentation task did not run `npm audit fix` or modify dependency declarations because that would be a separate code/dependency scope.

These checks prove offline code and documentation consistency. They do not constitute a Bright Data live test, and they consumed no Bright Data quota or credit.

## Ordered Next Actions

1. Close PR #43 as superseded after confirming no unique planning detail needs migration.
2. Start the searchable recent-result memory and cache-hardening lane represented by PR2 and issue #31.
3. Add agent run IDs and step correlation from issue #14 as part of the observability path.
4. Implement the batch runner after cache/searchable-memory behavior is stable.
5. Finish guided configuration/status UX and split or close stale issues #6 and #40.
6. Treat Bright Data as a bounded provider experiment only after the cost-observability gates above exist; begin with a tiny explicit-provider comparison, not default routing.
7. Keep remote/hybrid execution deferred until the local audit, memory, and batch surfaces are trustworthy.

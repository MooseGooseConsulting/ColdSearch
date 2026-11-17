---
title: North Star
date: 2026-06-22
author: Patrick MacLyman
status: living
---

# North Star

## Why This Exists

Search providers expose overlapping tools and provider-specific interfaces. The problem is not only that callers can choose the wrong vendor. The larger opportunity is to make those tools comparable, reusable, cacheable, and observable from one place.

ColdSearch exists so a user or agent can ask for web/search/extract/crawl-style work once, then let the runtime use multiple provider tools, compare their effectiveness, spread requests across available keys and free quotas, and preserve what happened for later inspection. Provider-specific power should remain reachable without forcing every caller back into separate MCPs, CLIs, dashboards, and hand-written scripts.

## In / Out

**In:** A query, URL, provider-tool request, or batch of requests.

**Out:** Provider results, normalized common views where useful, raw provider detail where needed, searchable recent cache items, rich logs, and enough provenance to understand how the answer was produced.

## What This Is Not

- **Not a pile of disconnected provider wrappers.** Provider tools should be reachable, but through one audited ColdSearch surface with shared config, logging, key handling, and cache behavior.
- **Not blind model-directed routing.** The model or caller may request a provider tool when that is intentional, but default routing should be controlled, observable, and comparable.
- **Not obligated to expose every niche vertical.** Broadly useful provider tools should be available. Narrow surfaces such as specialized academic/legal verticals can stay deferred until there is a real workflow.
- **Not lossy normalization.** Common views are convenience layers. ColdSearch must preserve raw provider details needed for evaluation, debugging, advanced use, or provider-specific workflows.
- **Not paying per token for Anthropic.** When ColdSearch needs LLM synthesis, it calls a configured OpenAI-compatible endpoint; which model sits behind it is configuration. Claude is allowed only when it bills to the Claude subscription or its included monthly API credit, never pay-per-token, including Claude through OpenRouter, Kilo, Bedrock or Vertex.

## Goals

These goals are aspirations, not necessarily a reflection of the current codebase.

**G1: Unified Access To Provider Tools.** One ColdSearch surface should reach the useful tools from Tavily, Brave, Exa, Serper, Jina, Firecrawl, SearXNG, and future providers.

**G2: Compare Provider Effectiveness.** ColdSearch should make it practical to run comparable work across providers, inspect the results, and learn which tools work best for which jobs.

**G3: Search And Reuse Prior Work.** ColdSearch should build a searchable local memory of recent search/extract/tool results so later calls can surface relevant prior items before paying providers again. Reuse should prefer retrieval over blind replay; exact response replay is only acceptable when it is painless, explicit, and freshness policy allows it.

**G4: Preserve Useful Provider Detail.** Common outputs should be easy to consume, but raw provider details should remain accessible when they matter.

## Pillars

**Comparable Execution.** The runtime should make it easy to compare provider/tool performance instead of hiding every execution choice behind an opaque answer.

**Searchable Cache, Not Blind Replay.** Cached work should become a searchable recent-results corpus that can be inspected and reused. Avoid building a heavy bespoke cache layer unless a package or simple local store makes it painless; prefer surfacing relevant prior items over silently replaying old responses.

**Audit First.** Important calls should leave inspectable traces. Logging is not an afterthought or a debug-only aid; it is part of how ColdSearch earns trust, compares providers, tracks free-quota/key usage, and explains agent behavior after the fact.

**Fail Visible.** When something breaks, the error should make it obvious whether the issue is config, credentials, provider reachability, quota/rate limits, unsupported capability, or provider-specific behavior.

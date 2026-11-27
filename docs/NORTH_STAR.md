---
title: North Star
date: 2026-11-27
author: Patrick MacLyman
status: living
---

# North Star

## Why This Exists

Search providers expose overlapping tools and provider-specific interfaces. The problem is not only that callers can choose the wrong vendor. The larger opportunity is to make those tools comparable, reusable, cacheable, and observable from one place.

ColdSearch exists so a user or agent can connect once, to one gateway, and reach the tools of every search provider behind it. The gateway holds the keys, spreads requests across available keys and free quotas, logs every call so provider effectiveness can be compared, carries curated skills so work gets routed to where it should be, and preserves what happened for later inspection. Provider-specific power should remain reachable without forcing every caller back into separate MCPs, CLIs, dashboards, and hand-written scripts.

## In / Out

**In:** A provider-tool request, a URL, or a batch of requests, sent by any agent or script connected to the gateway.

**Out:** Provider results as the provider returned them, common views where useful, searchable recent results, a full log of each request and response, what each key has used and has left, and enough provenance to understand how the answer was produced.

## What This Is Not

- **Not a pile of disconnected provider wrappers.** Provider tools should be reachable, but through one audited ColdSearch surface with shared config, logging, key handling, and cache behavior.
- **Not blind model-directed routing.** Provider tools are passed through under their own names, so the model or caller picks the tool. That choice should still be controlled, observable, and comparable: curated skills served by the gateway say which tool suits which job, the operator decides which tools are offered, the gateway decides which key pays, and every call is recorded.
- **Not obligated to hand-build every niche vertical.** Tools come from the providers' own APIs, so what a provider publishes is reachable without ColdSearch work. Narrow surfaces such as specialized academic/legal verticals get no custom code, skill rule, or gateway-native tool until there is a real workflow, and the operator may hide tools agents should not have.
- **Not lossy normalization.** Common views are convenience layers. ColdSearch must preserve raw provider details needed for evaluation, debugging, advanced use, or provider-specific workflows.
- **Not paying per token for Anthropic.** When ColdSearch needs LLM synthesis, it calls a configured OpenAI-compatible endpoint; which model sits behind it is configuration. Claude is allowed only when it bills to the Claude subscription or its included monthly API credit, never pay-per-token, including Claude through OpenRouter, Kilo, Bedrock or Vertex.

## Goals

These goals are aspirations, not necessarily a reflection of the current codebase.

**G1: Unified Access To Provider Tools.** One ColdSearch gateway should reach the useful tools from Exa, Firecrawl, Parallel, Tavily, Bright Data, TinyFish, context.dev, Brave, Serper, Jina, SearXNG, and future providers, under each provider's own names, arguments, and results. Tools come from the providers' APIs, because their hosted MCP servers expose too little. The gateway is hosted as a remote MCP server, so an agent on any machine, or a hosted assistant connecting over the web, reaches the same tools through the same keys and the same log.

**G2: Compare Provider Effectiveness.** ColdSearch should make it practical to compare the work providers do, inspect the results, and learn which tools work best for which jobs. The comparison comes from the record of real calls: what each tool was asked, what it returned, how long it took, and what it cost.

**G3: Search And Reuse Prior Work.** ColdSearch should build a searchable memory of recent requests and results from the record the gateway keeps, shared by every agent that connects, so an agent can surface relevant prior items before paying providers again. The lookup is a tool the agent calls, and the curated skills tell it when; the gateway does not silently answer a provider call from memory. Reuse should prefer retrieval over blind replay; exact response replay is only acceptable when it is painless, explicit, and freshness policy allows it.

**G4: Preserve Useful Provider Detail.** Common outputs should be easy to consume, but raw provider details should remain accessible when they matter.

**G5: Spread Work Across Keys And Allowances.** ColdSearch should spread requests across available keys and free quotas instead of draining one account. It should know which key each call used and what each account has left, move to another key when one runs out, keep the one configured key per provider in the secret store on an account that still has allowance, and show all of it on a dashboard.

**G6: Do Commodity Work In The Gateway.** Commodity work such as fetching a page, mapping a site, and crawling it should be done by the gateway itself, not bought. Providers are paid for what the gateway cannot do itself, such as a web index or a page it cannot reach.

## Pillars

**Comparable Execution.** The runtime should make it easy to compare provider/tool performance instead of hiding every execution choice behind an opaque answer. Every call names its provider tool and is recorded, so comparison comes from what was actually run, not from sending each request to several providers.

**Searchable Cache, Not Blind Replay.** Cached work should become a searchable recent-results corpus that can be inspected and reused. Avoid building a heavy bespoke cache layer unless a package or simple local store makes it painless; prefer surfacing relevant prior items over silently replaying old responses.

**Audit First.** Every call through the gateway should leave an inspectable trace, with the full request and response where possible. Logging is not an afterthought or a debug-only aid; it is part of how ColdSearch earns trust, compares providers, tracks free-quota/key usage, and explains agent behavior after the fact.

**Fail Visible.** When something breaks, the error should make it obvious whether the issue is config, credentials, provider reachability, quota/rate limits, unsupported capability, or provider-specific behavior.

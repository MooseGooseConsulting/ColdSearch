# Idea: getting agents to split search spend across the right tools (2026-11-27)

- **Nature:** design proposal, nothing built or tested. Prices come from the vendor snapshots in this folder (`firecrawl.md`, `exa.md`, `parallel.md`). There is no Tavily snapshot; Tavily figures are the owner's stated allowance plus recollection and are marked UNVERIFIED.
- **Scope:** which *tool* an agent spends on. Where the answer lives and what time window applies stay with the existing search-taste skill; this runs after it. Lanes considered: harness built-ins, vendor-native MCPs and CLIs, and ColdSearch (section 1a).
- **Baseline to beat:** one recorded research run made 116 searches (85 Exa = 73%, 31 Tavily = 27%, nothing else) plus 310 raw fetches.

Two facts drive most of the design:

1. The current default is the most expensive lane. Exa `auto` is $0.007 per search; Parallel `fast` is $0.001 and sits in the same top cluster on the two independent benchmarks cited in `parallel.md`. Firecrawl search is 2 credits per 10 results; Tavily basic is 1 credit (UNVERIFIED).
2. Several lanes cost nothing and are unused: harness WebSearch/WebFetch, Firecrawl's government and research-paper indexes, the keyless Parallel and Firecrawl MCPs, and `gh` for GitHub.

## 1. Task to tool routing

| Work | First choice | Fallback | Why | Do not use |
|---|---|---|---|---|
| Quick fact or link | Harness WebSearch | Parallel `web_search`, `fast` | Free; $0.001 if the built-in misses | Exa `deep`, any agent endpoint |
| Docs / API reference | Fetch the official docs URL or `llms.txt` with WebFetch; a docs MCP if installed | Firecrawl `developer_search` (2 cr/10) | The URL is usually known, so no search is needed | Exa for a known docs site |
| Code / GitHub issues | `gh search issues`, `gh search code` | Firecrawl `developer_search`; Exa `auto` only to find a described failure semantically | `gh` is free and live; the Developer Index returns passages with repo filters | Exa `github` category (deprecated); Firecrawl `github` category (400) |
| Known URL | WebFetch | Parallel `web_fetch` (20 URLs per call, $0.001 each, free keyless) | Free; batching cuts call count | Any search tool; Exa fetch when freshness matters |
| JS-heavy or blocked page | Firecrawl `scrape` (1 cr) | Parallel `web_fetch`; Firecrawl `interact` (2 cr/min) if clicks are needed | Real browser and proxies | Retrying WebFetch; X URLs via Firecrawl (30 cr); profile URLs (5 to 40 cr) |
| Live price / status | Firecrawl `scrape` with `maxAge: 0` | Parallel `web_fetch` (live by default) | Only lanes with a freshness control | Exa fetch; search snippets; `json` format (+4 cr) unless needed |
| Site crawl / map | Firecrawl `map` (1 cr per call), then scrape the pages chosen | Tavily map/crawl | Map plus a few scrapes beats a crawl | Parallel (no crawl); Exa (not a crawler); a crawl without `limit` |
| Multi-source deep research | The agent's own loop: Parallel `fast` (up to 5 queries per call) plus fetches | Tavily when a strict date filter is needed; Exa `auto` for semantic finds | Cheapest per query, and spreads load | One provider for more than half the searches |
| List-building / enrichment | Exa `agent_run`, fixed `effort` `low` or `medium` ($0.025 / $0.10) with a schema | Firecrawl `agent` with `maxCredits`; Parallel Task `core` ($0.025) | Fixed price per run | Hand-looping 100 searches; Exa `auto` or `ultra` effort uncapped |
| Academic papers | Firecrawl research index (free: arXiv, PubMed, bioRxiv, medRxiv; full text, citations) | Exa `publication` category | Free and purpose-built | Paid web search first; Firecrawl `categories: ["research"]` (a site filter, not the paper index) |
| Legal / regulatory (US) | Firecrawl `gov_search` (free) | Parallel `fast` with `include_domains` for non-US | Free primary law | Treating "no hits" as "no law"; it is US only |
| People / company | Exa `web_search` for a named entity | Firecrawl `people_company_search`, always with `max_credits` | Exa is strong on entities at $0.007 | `people_company_enrich` without `max_credits` (uncapped); `contact_fields` unless contact data was asked for |
| Monitor a page | Scheduled free fetch plus local diff | Firecrawl monitor (1 cr/page/check); Exa Monitors ($2 per 1k) for "new results for a query" | Polling one page needs no vendor | A loop of paid searches |

When the zero-cost lanes are good enough: built-ins for facts, links and static pages where no date filter or exact quote is required (WebSearch has no date control; WebFetch returns a model summary, not the page). The free indexes are the first choice for their domain, not a fallback. Keyless MCPs suit light use only: limits are unpublished and per IP.

## 1a. ColdSearch as a lane

ColdSearch is designed as one audited surface that reaches provider-native tools (`coldsearch tool call <provider>.<tool>`), spreads requests across keys and free allowances, and logs usage. If it worked as designed it would be the better route for these rows, because the allowance decision moves from agent judgment into code:

- **Generic metered search** (the fallback for quick facts, and the deep-research loop). Provider and key choice by remaining allowance replaces steps 1, 5 and 7 of the draft skill.
- **Known-URL and blocked-page fetches.** A fallback chain plus the searchable history lets a second agent reuse a page instead of paying again; the 310 fetches in the baseline run are the case for it.
- **Crawl and map**, and **capped expensive calls**: the surface can refuse an agent run or enrichment that carries no cap, and record its cost.

It adds nothing for built-ins, `gh`, keyless lanes (no key to choose) or hosted-only features, and the free indexes need only cost-free pass-through.

Per `coldsearch-code-audit.md`, guidance should not send agents there until it offers:

1. **An MCP entrypoint** and a working install. Today it is a CLI only, with no zero-config path.
2. **Native tool coverage** for the rows above: the Firecrawl indexes, `map`, live-fetch freshness, and agent calls with caps. 15 of 54 catalogued profiles are wired.
3. **Allowance-aware choice.** Today the provider pick is uniform random, every process uses the first key, and nothing remembers an exhausted key or reads a usage endpoint.
4. **Cost capture.** `costDollars` and `creditsUsed` are dropped today.
5. **Failure handling**: one bad provider fails about 1/N of calls, and POSTs get no retries.

Until then the skill names native tools. When the five hold, the skill keeps its task table and swaps the lane: steps 1, 5 and 7 become "call ColdSearch", and the status record and log of sections 3 and 5 become its own output rather than hook work.

## 2. Spending order

Cheapest adequate lane first:

1. **No search:** URL in hand, `gh`, local docs.
2. **Free index** for its domain: gov, papers.
3. **Harness built-ins.**
4. **Keyless MCP:** Parallel `fast`, Firecrawl search/scrape.
5. **Cheap metered:** Parallel `fast` ($0.001), Tavily basic (1 cr), Firecrawl search (2 cr), Exa `lite` ($0.004).
6. **Dear metered:** Exa `auto` ($0.007), Parallel `advanced` ($0.005), Exa `deep` ($0.012).
7. **Agent endpoints.**

Tie-breaks: an allowance that resets monthly is spent before one that only depletes; among resetting ones, pick the highest share remaining for the days left. The owner describes the Exa balances as depleting, so Exa is reserved for what only it does (semantic "describe the page" search, entities). `exa.md` records a renewing $10 monthly grant on a user's first team; the status file should carry a `resets` field so this is data, not prose.

Expensive calls (Exa Agent, Firecrawl agent, Parallel Task or `web_research`, Tavily research) are worth it only when all three hold: the user asked for deep research, a list, or enrichment; a manual loop would pass about 30 searches; and it is the one such call for the task, made by the lead agent and never by a fan-out worker. Always set the cap:

| Call | Cap to set |
|---|---|
| Exa `agent_run` | An explicit `effort` (`minimal` to `xhigh`, $0.012 to $1.00). `auto` and `ultra` are metered: set `budget.maxCostDollars` (minimum $1; defaults are $5 and $20) |
| Firecrawl `agent` | `maxCredits` (start at 200). A capped run fails unbilled |
| Parallel Task | `processor` is the cap: `core` $0.025, `pro` $0.10, `ultra` $0.30. The CLI default is `pro-fast` |
| Parallel `web_research` | `reasoning.effort`: `low` $0.01, default `medium` $0.05, `high` $0.25 |
| Tavily research | Cheapest model; credit cost UNVERIFIED and may take a large share of a 1,000-credit month |
| Parallel `web_search` | `mode: "fast"`; the API default is `advanced` at 5x |
| Firecrawl enrich / jobs | `max_credits` |

## 3. How agents learn allowance state

The rotator publishes one small status record with no key material: per provider `state` (`ok`, `low`, `out`), `remaining`, `resets`, `updated_at`. Two homes: a file at `~/.local/state/search-allowance/status.json` on each machine, or one non-secret Doppler value, which every machine can already read.

Ranked by how reliably an agent sees it:

1. **PreToolUse deny, with the alternative named in the reason.** Arrives at the moment of spend and cannot be skipped. Needs harness hooks.
2. **Session-start or prompt-submit hook that injects one line** ("Exa low, Parallel ok"). Seen without the agent acting; same harness limit.
3. **Status file plus a one-line read as step 1 of the skill.** Works wherever there is a shell; depends on the skill being followed.
4. **MCP tool.** The agent must think to call it, and it adds another schema.
5. **Statusline.** The human sees it; the model does not.

Rotator inputs: Firecrawl `GET /team/credit-usage` with the ordinary key; Parallel `balance get` (device-flow login); Exa `GET /credits` needs a service key enabled on request, otherwise sum `costDollars.total` and treat 402 as `out`. Parallel's $5 credit is not a hard cap (overage bills the card), so the rotator should mark it `out` before the credit ends.

## 4. Delivery across harnesses

| Artifact | Claude Code | Codex | OpenCode | Kilo, oh-my-pi, others |
|---|---|---|---|---|
| Skill (`SKILL.md`) | Yes | Yes | Yes | Verify per harness |
| Tool-call hooks | Yes (PreToolUse, PostToolUse, SessionStart) | Verify | Yes, as a plugin | Verify |
| Search subagent | Yes | Partial | Yes | Varies |
| User-level instruction file | Yes | Yes | Yes | Yes |

Smallest set recommended:

1. **One routing skill**, synced with the owner's other skills (draft in section 6).
2. **One status record** from the rotator.
3. **One hook script** where hooks exist: inject the status line at session start, deny a provider that is `out` while naming the next lane, and append the log line of section 5. Match tool names by suffix (section 7).
4. **MCP hygiene**, which may matter more than any text: "first to hand" is partly configuration. Every harness should have the Parallel and Firecrawl servers configured, with `?tools=` trimming to what is used.

A search subagent with a restricted tool list is a strong control, but research runs spawn general workers anyway and hooks already cover subagents; defer it. For harnesses with neither skills nor hooks, a one-line pointer in the *user-level* instruction file is the only lever. The owner's rule is that workflow guidance does not go in repository `AGENTS.md` files, so nothing here belongs in one.

## 5. Measuring whether routing works

Log one JSONL line per search or fetch tool call from the PostToolUse hook:

`ts, machine, harness, session, tool, provider, purpose, cost, unit, ok`

- `purpose` is derived from the tool, not asked of the agent: `search`, `fetch`, `crawl`, `index-gov`, `index-papers`, `index-dev`, `agent`, `enrich`.
- `cost` comes from what vendors already return: Firecrawl `creditsUsed` (search top level, scrape `metadata.creditsUsed`, agent status); Exa `costDollars.total` (whether the MCP result surfaces it is UNVERIFIED); Parallel `_meta["parallel/usage"].cost_usd` on authenticated MCP calls (keyless reports nothing); Tavily usage field UNVERIFIED. Built-ins log cost 0.
- Reconcile weekly against vendor per-key usage (Firecrawl historical `byApiKey`, Parallel usage by key name).

Weekly view, one table: rows are providers, columns are calls by purpose, cost, share of all searches, and percent of allowance used against percent of period elapsed. Three headline numbers: the largest single-provider share of searches (baseline 73%, target under 50%), the share of calls on zero-cost lanes, and the number of expensive calls without a cap (target 0).

## 6. Routing skill — DRAFT, untested

```markdown
---
name: search-spend
description: Use before any web search, page fetch, crawl, or vendor research-agent call (Exa, Firecrawl, Parallel, Tavily, WebSearch, WebFetch). Picks the cheapest adequate tool and spreads usage across allowances. Run after search-taste has set where to look and the time window.
---

# Search spend (DRAFT, untested)

## Steps

1. Read `~/.local/state/search-allowance/status.json`. Skip any provider marked `out`;
   use a provider marked `low` only for what no other tool does.
   Why: allowances are separate; one drains while the rest sit unused.
2. If you hold the URL, fetch it; do not search for it. WebFetch first; a batch of
   URLs goes to Parallel `web_fetch` (up to 20 per call).
   Why: fetches are free or $0.001; a search to rediscover a URL is waste.
3. If the question is US law or regulation, academic papers, or GitHub issues/code,
   use the free lane first: Firecrawl gov search, Firecrawl paper search, `gh search`.
   Why: they cost nothing and are built for that source.
4. For a plain fact or link, use the harness WebSearch.
   Why: it is included in the subscription. It has no date control and WebFetch
   returns a summary, so leave it when you need a date filter or exact text.
5. For other searches, go down this list and stop at the first that fits:
   Parallel `web_search` with `mode: "fast"`; Tavily basic; Firecrawl search;
   Exa `lite`; Exa `auto`.
   Why: this is price order, about $0.001 to $0.007 per search.
6. Take Exa out of order only for a semantic "describe the page" query or a named
   person or company. Why: that is what it does better, and its balance does not refill.
7. In a multi-search task, no provider gets more than half the searches. Count as you go.
   Why: one recorded run put 73% on a single provider.
8. JS-heavy, blocked, or live-price pages: Firecrawl `scrape` (`maxAge: 0` for live).
   Why: it is the lane with a browser and a freshness control.

## Expensive calls

Run a vendor research agent only if the user asked for deep research, a list, or
enrichment, AND a manual loop would pass about 30 searches, AND you are the lead
agent. One per task. Always set the cap:

- Exa `agent_run`: `effort` of `low` or `medium`; never `auto` or `ultra` without
  `budget.maxCostDollars`.
- Firecrawl `agent`: `maxCredits: 200`.
- Parallel Task: `processor: "core"` or `"pro"`. Parallel `web_research`: effort `low`.
- Firecrawl `people_company_enrich`, `jobs_search`: `max_credits`.

Why: these cost 10 to 1,000 times a search, and several are uncapped by default.

## Never

- Parallel `web_search` without `mode`. Why: the default is 5x the price.
- Firecrawl scrape of X or social-profile URLs. Why: 30 and 5 to 40 credits, not 1.
- Firecrawl search with scrape formats, or `limit` above 10. Why: adds credits per result.
- A crawl without `limit`; prefer `map`, then scrape chosen pages.
- Retrying a tool that returned 402. Why: 402 means the allowance is empty; move on.
  On 429, wait and retry.

## Report

End the task with one line: searches per provider, fetches per tool, expensive
calls and their caps.

## Reference

Tool names differ by install: match on the vendor and verb (`web_search_exa`,
`firecrawl_search`, Parallel `web_search`, `tavily_search`), not the full prefix.
Search-taste decides the venue and window. If its window needs a strict date
filter, prefer a tool whose filter it records as holding.
```

## 7. Risks

- **Agents ignore guidance.** A skill is advice. The deny hook and the MCP configuration are the controls that hold; the weekly view shows whether the advice works.
- **Competing instructions.** Each vendor's server instructions and bundled skills say to use that vendor first, and one vendor plugin skill triggers on "research this". Remove those bundled skills or make the routing skill trigger first.
- **Tool-name differences.** The same tool appears under hosted-connector, plugin and local-server prefixes, so hooks must match by suffix. Surfaces differ too: some Firecrawl tools are hosted-only and keyless servers expose fewer tools.
- **OAuth connectors draw on a different account.** A hosted connector bills the signed-in team, not the Doppler slot; the rotator cannot swap it and the status record can misstate it. Use API-key servers fed from Doppler and disable duplicate OAuth connectors, or track the connector account as its own row.
- **Stale status.** Hooks should ignore a record older than a set age rather than block on it.
- **Silent surcharges.** Authenticated Firecrawl search can attach a provider record to a query naming one person or company (up to 20 credits).
- **Deny loops.** A block that names no alternative makes an agent retry or give up.
- **Shared keyless caps.** Per-IP limits are shared by all agents behind one address.

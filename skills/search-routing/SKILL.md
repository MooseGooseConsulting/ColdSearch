---
name: search-routing
description: Use before any web search, page fetch, crawl, or vendor research-agent call through this gateway. Picks the cheapest tool that fits the job and spreads usage across provider allowances.
---

# Search routing (DRAFT, untested)

Status: first draft, 2026-11-27. The prices and tool names come from vendor
documentation read that day; no rule here has been measured against real agent
runs yet. When a rule misfires, say so in a "Rule feedback" line at the end of
your answer.

Tool names below are gateway names: `<upstream>__<tool>`. In lazy mode, call
them through `coldsearch_call_tool`. Every name here is one the gateway
exposes by default. An upstream appears only when the operator configured it,
so skip a tool that is not in your list and take the next.

## Steps

1. Call `coldsearch_status`. Do not use an upstream whose keys are all
   `skipped`.
   Why: a skipped key is out of credit; the call will fail and waste a turn.
2. If you already hold the URL, fetch it; do not search for it. One URL:
   your harness's own fetch tool. Several: `tinyfish__fetch_content`, then
   `parallel__post_v1_extract`.
   Why: a fetch costs a tenth of a search or nothing; TinyFish's is free up to
   1,000 URLs a day.
3. US law or regulation, academic papers, GitHub issues or code: use the free
   lane first — `firecrawl__govSearch`,
   `firecrawl__researchSearchPapers`, `gh search`. Google Scholar or patents:
   `serper__scholar`, `serper__patents`.
   Why: the Firecrawl indexes cost no credits and are built for that source;
   Serper is the only route to Scholar and Patents.
4. A plain fact or link: your harness's built-in web search, when it has one.
   Why: it is already paid for. Leave it when you need a date filter or the
   page's exact text.
5. Any other search: take the first of these that fits —
   `searxng__search`; `tinyfish__search`; `parallel__post_v1_search`;
   `serper__search`; `brave__webSearch`; `tavily__search`;
   `firecrawl__searchAndScrape`; `exa__search` with `type: "auto"`.
   Why: that is price order, from free to roughly $0.007 per search. The
   gateway sends Parallel's `mode: "fast"` for you; name another mode only
   when fast results were not good enough.
6. Take Exa out of order only for a "find pages like this description" query
   or a named person or company.
   Why: that is where it is strongest, and its balance does not refill.
7. In a task with many searches, no upstream gets more than half of them.
   Count as you go.
   Why: one recorded research run put 73% of its searches on one provider
   while the others sat unused.
8. A page that needs a browser, blocks plain fetches, or must be live (a
   price, a status): `firecrawl__scrapeAndExtractFromUrl`, with `maxAge: 0`
   for live. If Firecrawl is blocked too: `brightdata__unlockUrl`, which
   needs a `zone` (list them with `brightdata__listActiveZones`).
   Why: Firecrawl has a browser and a freshness control; Bright Data gets
   past bot protection, at one request a page.

## Expensive calls

Run a vendor research agent only when all three hold: the user asked for deep
research, a list, or enrichment; doing it by hand would take about 30 or more
searches; you are the lead agent, not a subagent. One per task. The gateway
fills in a cap when you leave it out, and lowers one above its limit:

- `exa__createAgentRun`: `effort` is `low` and `budget.maxCostDollars` is 2
  unless you say otherwise; the budget cannot go above 5. Use `medium` only
  when `low` fell short.
- `firecrawl__startAgent`: `maxCredits` is 200 unless you say otherwise, and
  cannot go above 500.
- `parallel__post_v1_tasks_runs`: no cap exists, so always pass `processor`
  of `lite`, `base` or `core`.
- `tavily__createResearch`: `model` is `mini` unless you say otherwise.
- `context__post_web_answers`: `mode` is `fast` unless you say otherwise.
- `brightdata__triggerScrape`: `limit_per_input` is 10 and
  `limit_multiple_results` is 100 unless you say otherwise; they cannot go
  above 100 and 1,000. Name `limit_multiple_results` when you send more
  inputs than that.

Why: these cost 10 to 1,000 times a search. A line starting `Gateway note:`
in a result says a cap was applied.

## Never

- `parallel__post_v1_search` with `mode: "advanced"` or `"basic"` as a first
  try. Why: they cost five times the fast one.
- `firecrawl__scrapeAndExtractFromUrl` on X or social-profile URLs. Why: 5 to 40
  credits each, not 1.
- `firecrawl__searchAndScrape` with scrape formats or a limit above 10. Why:
  each adds credits per result.
- A crawl of more pages than you will read. `firecrawl__crawlUrls` stops at
  50 pages unless you pass `limit`. Prefer a map, then scrape the pages you
  chose.
- `brightdata__listScrapers` without `dataset_id` or `domain`. Why: the full
  catalogue is several megabytes, and the gateway refuses the call.
- Retrying a call that failed for lack of credit. Why: the gateway has already
  tried the other keys; move to another upstream. On a rate-limit error, wait
  and retry.

## Report

End the task with one line: searches per upstream, fetches per tool, and any
expensive calls with their caps.

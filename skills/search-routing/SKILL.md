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
them through `coldsearch_call_tool`.

## Steps

1. Call `coldsearch_status`. Do not use an upstream whose keys are all
   `skipped`.
   Why: a skipped key is out of credit; the call will fail and waste a turn.
2. If you already hold the URL, fetch it; do not search for it. One URL:
   your harness's own fetch tool. Several: `parallel__post_v1_extract`.
   Why: a fetch costs a tenth of a search or nothing.
3. US law or regulation, academic papers, GitHub issues or code: use the free
   lane first — `firecrawl__govSearch`,
   `firecrawl__researchSearchPapers`, `gh search`.
   Why: these cost no credits and are built for that source.
4. A plain fact or link: your harness's built-in web search, when it has one.
   Why: it is already paid for. Leave it when you need a date filter or the
   page's exact text.
5. Any other search: take the first of these that fits —
   `parallel__post_v1_search` with `mode: "fast"`; `tavily__search`;
   `firecrawl__searchAndScrape`; `exa__search` with `type: "auto"`.
   Why: that is price order, roughly $0.001 to $0.007 per search.
6. Take Exa out of order only for a "find pages like this description" query
   or a named person or company.
   Why: that is where it is strongest, and its balance does not refill.
7. In a task with many searches, no upstream gets more than half of them.
   Count as you go.
   Why: one recorded research run put 73% of its searches on one provider
   while the others sat unused.
8. A page that needs a browser, blocks plain fetches, or must be live (a
   price, a status): `firecrawl__scrapeAndExtractFromUrl`, with `maxAge: 0`
   for live.
   Why: it has a browser and a freshness control.

## Expensive calls

Run a vendor research agent only when all three hold: the user asked for deep
research, a list, or enrichment; doing it by hand would take about 30 or more
searches; you are the lead agent, not a subagent. One per task. Always set the
cap:

- `exa__createAgentRun`: `effort` of `low` or `medium`. Never `auto` or `ultra`
  without `budget.maxCostDollars`.
- `firecrawl__startAgent`: `maxCredits: 200`.
- `parallel__post_v1_tasks_runs`: `processor` of `lite`, `base` or `core`.

Why: these cost 10 to 1,000 times a search, and several have no cap by default.

## Never

- `parallel__post_v1_search` without `mode`. Why: the default mode costs five
  times the fast one.
- `firecrawl__scrapeAndExtractFromUrl` on X or social-profile URLs. Why: 5 to 40
  credits each, not 1.
- `firecrawl__searchAndScrape` with scrape formats or a limit above 10. Why:
  each adds credits per result.
- A crawl without a page limit. Prefer a map, then scrape the pages you chose.
- Retrying a call that failed for lack of credit. Why: the gateway has already
  tried the other keys; move to another upstream. On a rate-limit error, wait
  and retry.

## Report

End the task with one line: searches per upstream, fetches per tool, and any
expensive calls with their caps.

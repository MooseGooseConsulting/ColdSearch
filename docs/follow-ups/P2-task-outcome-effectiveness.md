# P2 — Task-outcome diagnostics and effectiveness measurement (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.

## Problem

`CapabilityCategory` (6: search/extract/crawl/map/research/answer) plus each
tool's `semanticFit`/`CommonViewMapping` declares what each provider tool
*can* back; no nine-intent taxonomy or pre-call intent classifier exists
in-tree (Codex on #87). Nothing measures task outcomes per category. The
first report can provide coverage diagnostics; those signals alone cannot
establish whether one provider gave better results.

## Proposal

1. Define per-intent coverage diagnostics computable from data we already have:
   - web-link search: result count and rank distribution, labeled as coverage
     diagnostics rather than effectiveness scores.
   - content-backed retrieval: content present/empty, provider-reported length
     or truncation metadata when available, and highlights presence. There is
     no portable requested-character count across these tools, so do not report
     a returned/requested character ratio without a shared request limit.
   - known-url extraction: content non-empty, title presence.
   - crawl: pages returned vs limit, dedup ratio.
2. Record coverage diagnostics in the execution record (additive, redacted).
3. Add a comparable task outcome judgment before making effectiveness
   comparisons across providers. Keep that judgment separate from coverage
   metrics in `coldsearch report` so adapter-specific score formulas and result
   volume are not presented as task success.

## Non-goals

- No automatic routing changes based on outcomes (that's gated autonomous
  adoption — separate follow-up).

## Done when

- [ ] Prerequisite: define the intent taxonomy (or scope diagnostics to the
      existing 6 `CapabilityCategory` values) — per-intent diagnostics are
      blocked until intents exist as a classifier, not just a draft concept.
- [ ] Coverage diagnostics defined per intent/category and recorded.
- [ ] Any effectiveness report uses a comparable task outcome judgment;
      coverage metrics are labeled separately.
- [ ] Docs explain what the report can and cannot support before changing
      strategy.

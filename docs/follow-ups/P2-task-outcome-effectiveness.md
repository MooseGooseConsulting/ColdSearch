# P2 — Task-outcome diagnostics and effectiveness measurement (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.

## Problem

The 9-intent taxonomy (PR-D) classifies what each provider tool *can* back,
but nothing measures task outcomes per intent. `semanticFit` is a static
declaration. The first report can provide coverage diagnostics; those signals
alone cannot establish whether one provider gave better results.

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

- [ ] Coverage diagnostics defined per intent and recorded.
- [ ] Any effectiveness report uses a comparable task outcome judgment;
      coverage metrics are labeled separately.
- [ ] Docs explain what the report can and cannot support before changing
      strategy.

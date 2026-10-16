# P2 — Gated autonomous tool adoption (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.

## Problem

The registry catalogs tools as `wired` / `direct` / `available` / `deferred`,
and PR-D adds intent-level pre-call rejection. What does not exist is a
*gate*: a process by which a newly verified provider tool graduates from
`available` to `wired`/`direct` without a human writing the adapter by hand.

## Proposal

A graduation gate, all steps required:

1. **Evidence**: native schema re-inspected against official docs (dated, like
   the 2026-10-12 audit); advance `schemaLastVerified` when that documentation
   reconciliation is completed. This records doc inspection only. Keep bounded
   live-call evidence in the separate verification ledger; a doc check alone
   must never be presented as live verification.
2. **Hermetic proof**: request-shape tests + replay tests from captured
   envelopes (PR-E harness) for the new tool.
3. **Live proof**: bounded live calls with explicit request/time/spend
   ceilings; results recorded in the live-verification ledger; failure rows
   labeled `blocked: <reason>`, never faked.
4. **Human review**: PR merging the wiring + ledger entry.

Autonomous assistance (agents drafting the adapter, generating tests, running
the probes) is fine inside the gate; the gate itself is the control.

## Done when

- [ ] Gate documented in `docs/tool-graduation.md`.
- [ ] Live-verification ledger format defined (reuse 2026-10-12 format).
- [ ] One tool walked through the gate end-to-end as a pilot.

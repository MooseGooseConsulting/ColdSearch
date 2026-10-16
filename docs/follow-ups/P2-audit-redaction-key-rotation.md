# P2 — Audit, redaction, key rotation, and history hygiene (draft)

**Status:** draft — file as part of issue #79 follow-up set.
**Grounded in:** PR-E capture harness redaction guarantees; PR-D per-leg
provenance; 2026-10-12 audit of usage-log redaction paths.

## Current state (verified 2026-10-12)

- History/attempt records carry `key_ref`, never key values; resolved secrets
  are collected in-memory and used only for redaction (`secretsUsed` is
  non-enumerable on `AllProvidersFailedError` — deliberate).
- Capture redacts selected headers, URLs, bodies, and errors. The #86 follow-up
  passes resolved provider API keys through `RequestPolicy.secrets` from
  production adapters and the provider-tool substrate.

## Gaps

1. **Key rotation**: nothing revokes or rotates key refs in existing history.
   An operator who leaks a key can remove it from config, but history still
   references the ref. Cache entries use request/config identity rather than
   credential identity, so they may remain replayable until their TTL expires
   or the cache is cleared.
2. **History audit trail**: no tamper-evidence (hash chain or similar) on
   execution records; `raw` payloads are preserved but not integrity-checked.
3. **Capture file hygiene**: captured envelopes sit on disk unencrypted;
   document + warn when capture dir is inside the state directory.
4. **Redaction audit command**: no way to verify "no secrets in history/cache/
   captures" without hand-inspection.

## Proposal

- Keep `coldsearch config doctor` offline and non-resolving. A future local
  `coldsearch audit secrets` command can scan with secret values already
  available in the process, report unresolved `doppler:` references as
  **not scanned**, and never print values. Any Doppler resolution would need a
  separate, explicit networked mode with a clear warning and consent.
- Optional history hash chaining (opt-in config flag) for tamper evidence.
- Key-rotation note in docs: after rotation, run `coldsearch cache clear`,
  since `--no-cache` bypasses both lookup and write-back for that invocation
  and does not replace existing entries. Cache entries are not keyed by key
  identity.

## Done when

- [ ] Offline audit reports unresolved secret references without claiming a
      complete scan; any networked resolution is separately explicit.
- [ ] Capture-dir location warning implemented.
- [ ] Rotation runbook added to docs.

# P1 — Replay provenance and routing compatibility (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.
**Grounded in:** 4-agent read-only audit (2026-10-12), PR-C cache-key changes (#84), PR-D provenance changes.

## Problem

Cache keys include the configured pool, strategy, each provider's effective
endpoint, provider-option, and provider-environment identity (PR-C), and
attempts carry tool/nativeName/executionMode (PR-D). Two gaps remain:

1. **Pre-PR-C entries** were written under route-blind keys. After upgrade,
   they simply never hit (keys differ) — silently cold cache, no migration
   story.
2. **Replay provenance** is partial: `origin_execution_id` links a cache hit
   to its originating execution, but the record does not state which provider
   pool/strategy, each provider's effective endpoint, provider-option, and
   environment-derived routing identity the entry was created under, so a
   replay cannot be audited against the current config without re-deriving the
   key.

## Proposal

- Add `cacheIdentity: {pool, strategy, endpoints: {provider: {origin, digest}},
  providerOptionsDigest, providerEnvironmentDigest}` to the cache entry
  envelope. The provider-keyed `endpoints` map records each pooled provider's
  effective endpoint: use its configured URL when selected, otherwise include
  only an environment fallback that the adapter actually consumed. Do not
  include unused environment variables. Include result-affecting provider
  options and other environment-derived routing inputs (such as Bright Data's
  SERP and Unlocker zone fallbacks) in canonical digests after removing
  credential values; never persist raw provider options or environment values.
  Each `origin` contains only a sanitized scheme, host, and port; each `digest`
  is a one-way hash of that provider's canonical effective endpoint identity.
  Never persist URL userinfo, paths, or query parameters, which may contain
  secrets.
- `coldsearch cache inspect <key>` renders the identity + origin execution.
- Document the pre-PR-C cold-cache behavior in the upgrade notes: old entries
  do not match the new keys and remain on disk until `coldsearch cache clear`.
  TTL prevents stale hits; it does not remove the files.

## Done when

- [ ] Cache entry envelope stores sanitized cache identity, including the
      effective endpoint for every pooled provider, result-affecting provider
      options, and environment-derived routing inputs, on write.
- [ ] `cache inspect` renders identity + origin execution id.
- [ ] Upgrade note explains that pre-2026-10 entries are invisible to the new
      keys and require `coldsearch cache clear` for cleanup.

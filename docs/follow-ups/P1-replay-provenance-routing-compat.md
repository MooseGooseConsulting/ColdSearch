# P1 — Replay provenance and routing compatibility (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.
**Grounded in:** 4-agent read-only audit (2026-10-12), PR-C cache-key changes (#84), PR-D provenance changes.

## Problem

Cache keys include the configured pool, strategy, each pooled provider's
endpoint-key material, provider-option, and provider-environment identity
(PR-C), and attempts carry tool/nativeName/executionMode (PR-D). For fixed-host
providers, endpoint-key material is the full `BUILTIN_ENDPOINTS[provider]`
map, including entries unrelated to the current capability; SearXNG instead
uses its selected configured base URL or environment fallback. Two gaps remain:

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

- Add `cacheIdentity: {pool, strategy, endpoints: {provider: {materialDigest,
  entries}}, providerOptionsDigest, providerEnvironmentDigest}` to the cache
  entry envelope. For each pooled provider, `endpoints` must represent the
  exact map returned by `endpointKeyMaterial(config, provider)`, because that
  map is what `capabilityCacheIdentity()` currently adds to the cache key.
  Fixed-host providers therefore record every named entry in their full
  `BUILTIN_ENDPOINTS[provider]` map, even entries unrelated to the current
  capability; SearXNG records its selected configured `baseUrl` or consumed
  `SEARXNG_BASE_URL` fallback. Omit providers with no endpoint material and do
  not include unused environment variables. `materialDigest` is a one-way hash
  of the complete map; `entries` has one item per map entry, keyed by its
  endpoint name, with an `origin` and a one-way `digest` for that entry. This
  lets inspection identify which endpoint-map entry changed without storing
  raw URLs. Each `origin` contains only a sanitized scheme, host, and port;
  never persist URL userinfo, paths, or query parameters, which may contain
  secrets. Include result-affecting provider options and other
  environment-derived routing inputs (such as Bright Data's SERP and Unlocker
  zone fallbacks) in canonical digests after removing credential values; never
  persist raw provider options or environment values.
- `coldsearch cache inspect <key>` renders the identity + origin execution.
- Document the pre-PR-C cold-cache behavior in the upgrade notes: old entries
  do not match the new keys and remain on disk until `coldsearch cache clear`.
  TTL prevents stale hits; it does not remove the files.

## Done when

- [ ] Cache entry envelope stores sanitized cache identity, including the
      exact endpoint-key material map for every pooled provider, result-
      affecting provider options, and environment-derived routing inputs, on
      write.
- [ ] `cache inspect` renders identity + origin execution id.
- [ ] Upgrade note explains that pre-2026-10 entries are invisible to the new
      keys and require `coldsearch cache clear` for cleanup.

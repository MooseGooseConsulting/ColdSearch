# P1 — Replay provenance and routing compatibility (draft for GitHub issue)

**Status:** draft — file as part of issue #79 follow-up set.
**Grounded in:** 4-agent read-only audit (2026-10-12), PR-C cache-key changes (#84), PR-D provenance changes.

## Problem

Cache keys include the configured pool, strategy, each pooled provider's
endpoint-key material, provider-option, and provider-environment identity
(PR-C), plus per-call material outside `capabilityCacheIdentity()`: search
keys add limit, limitSet, rerankStrategy, `searchProviderLimitIdentity()`,
and `searchFilterIdentity()`; extract keys add format, `extractProviderFormatIdentity()`,
provider headers, and Bright Data country (Codex on #87). Attempts carry
provider, tool, and timing (PR-D); they do not carry nativeName or
executionMode — adding those fields is part of this proposal, not a current
baseline (Codex on #87). Direct tool calls (substrate) build identity from
tool ID, sanitized parameters, and endpoint material with no pool/strategy;
a tool-specific identity variant (provider/tool, parameter digest, endpoint
material) is required alongside the capability variant (Codex on #87).
Substrate's tool-path material excludes fixed hosts (options/env only, `{}`
by default) while dispatch URLs are hardcoded — so the full-map rule below
applies to `toolIdentity.endpointMaterial` too: for fixed-host providers it
MUST be the effective dispatch host / `BUILTIN_ENDPOINTS[provider]` entries
for that tool (Codex on #87). For
fixed-host providers, endpoint-key material is the full
`BUILTIN_ENDPOINTS[provider]` map, including entries unrelated to the
current capability; SearXNG instead uses its selected configured base URL
or environment fallback. Two gaps remain:

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
  entries}}, providerOptionsDigest, providerEnvironmentDigest,
  fullKeyDigest}` to the cache entry envelope, plus a parallel
  `toolIdentity: {provider, tool, paramDigest, endpointMaterial}` variant
  for direct tool calls.   `fullKeyDigest = sha256(capability + '\n' + queryOrUrl + '\n' +
  stableStringify(normalizedOptions))` — the exact 3-tuple `cacheKey()`
  hashes (`src/cache/key.ts`), not the options object alone (Codex on #87:
  same options with different queries/URLs must not collide). It supports
  identity comparison only: a digest match proves same-key, a mismatch
  proves different-key, but neither explains which normalized field differs.
  Field-level explanations require persisting the sanitized per-call
  dimensions (limit, limitSet, rerankStrategy, filter identity, format,
  headers, country) alongside the digest — `cache inspect` renders those
  dimensions, and falls back to identity comparison when only the digest is
  present (CodeRabbit on #87).
  For each pooled provider, `endpoints` must represent the
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
      affecting provider options, environment-derived routing inputs, and a
      `fullKeyDigest` of the complete normalized key object, on write; direct
      tool calls store the `toolIdentity` variant.
- [ ] Attempts gain nativeName/executionMode provenance fields (prerequisite
      for the replay baseline; not present in current `ProviderAttempt`).
- [ ] `cache inspect` renders identity + origin execution id.
- [ ] Upgrade note explains that pre-2026-10 entries are invisible to the new
      keys and require `coldsearch cache clear` for cleanup.

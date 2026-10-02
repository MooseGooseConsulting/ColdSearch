# ADR 001: Fanout Architecture with Per-Provider Error Isolation

**Date:** 2026-04-12
**Status:** Accepted

## Context

Multiple search providers (Tavily, Brave, Serper, Exa, SearXNG) offer overlapping capabilities with different API shapes, rate limits, and failure modes. ColdSearch needed a strategy for querying them that maximizes result diversity while remaining resilient to individual provider failures.

## Decision

**Fanout all configured providers in parallel, with per-provider error isolation.**

When configured with `strategy = "all"`, the runtime dispatches the query to every provider in the capability pool concurrently. Each provider's result set is collected independently. Providers that fail (timeout, auth error, rate limit) are captured as errors in a `errors: { provider: message }` map rather than crashing the entire request.

Failed providers are not retried in the same fanout cycle. The caller receives both successful results and error metadata, so partial success is visible.

## Alternatives Considered

### Round-robin (single provider per query)
Rejected. Loses result diversity. One provider's ranking bias dominates every query. No way to compare or cross-validate results across providers.

### Fallback chain (try A, if fail try B)
Rejected. Adds latency on failure. The first provider becomes a SPOF for every query. The caller never knows if results are the best available or just from the first provider that worked.

### Weighted random (pick one per query with bias)
Rejected. Still single-provider per query. Weighting adds config complexity without solving the core problem: diverse, cross-validated results.

## Consequences

**Positive:**
- Result diversity from multiple ranking algorithms
- Graceful degradation when providers are down
- Cross-provider result comparison possible
- RRF reranking produces higher-quality merged rankings than any single provider

**Negative:**
- Higher API credit consumption (N providers per query)
- Slightly higher latency (bound by slowest provider)
- No quota-aware selection yet (future work)

## Implementation

**2026-10-02 amendment — account-quota recovery:** Random/single-provider
capability requests keep their one-provider success path. An account-exhaustion
rejection enables bounded sequential recovery within the remaining eligible
pool, with errors/attempts retained. This targeted exception prevents an empty
provider balance from randomly failing work when another configured provider
can serve it. It does not change `all` search fanout, remove providers, or add a
preflight quota-aware selector. See `docs/CONFIGURATION.md` for scope/detection.

- `src/engine/fanout.ts` — parallel dispatch with `Promise.allSettled`
- `src/execution/backend.ts` — `LocalExecutionBackend.search()` orchestrates fanout
- Errors captured per-provider in a `Record<string, string>` map
- Results merged and passed to the reranker

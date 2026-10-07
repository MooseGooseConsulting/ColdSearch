---
title: ColdSearch simplification proposal
date: 2026-10-07
status: proposed
---

# Simplification without feature loss

The immediate recommendation is to remove unused dependencies, then consolidate
credential resolution and split the CLI by responsibility. Provider request
construction and local JSONL reading are the next useful boundaries. Keep the
search, raw-tool, history, replay, batch, and agent contracts intact.

This review inspected `main` at `56f793b` plus the provider-switch work in
[PR #74](https://github.com/MooseGooseConsulting/ColdSearch/pull/74). The cleanup
below can be reviewed independently, but the credential/CLI implementation work
must start from the merged #74 so Isoquant medium reasoning, OpenRouter free
testing, configurable secret names, and TOML/CLI precedence are preserved.
[Issue #75](https://github.com/MooseGooseConsulting/ColdSearch/issues/75) owns the
remaining invocation, MCP, and shared Doppler behavior work. This document is a
proposal, not a claim that the later refactors are implemented.

## Implemented narrow cleanup

`src/resolvers/bws.ts` has no callers and is not exported by `src/index.ts`.
`KeyPoolManager.resolveKeyRef()` already rejects `bws:` and `config doctor`
reports the removed reference form. Remove that unreachable resolver and
`@bitwarden/sdk-napi`; retain the rejection and BWS migration document.

`@tavily/core` has no imports in the repository. `TavilyAdapter` uses shared
`fetchJson`, and raw Tavily tools use the HTTP substrate. Remove the unused SDK
without changing either execution path. The resulting lockfile contains four
package entries instead of 41: two unused direct dependencies and 35 packages
reachable only through them are gone. No supported command or provider is
removed, and the Node engine requirement remains unchanged.

Architecture and request-lifecycle documentation also incorrectly advertised
optional BWS support; correct those statements to match the existing runtime.
Historical dated reviews remain historical rather than being rewritten.

## Ordered implementation candidates

| Priority | Evidence in actual code | Concrete change | Behavior to preserve |
|----------|-------------------------|-----------------|----------------------|
| 1 | `src/engine/keypool.ts` owns Doppler CLI lookups/TTL/coalescing; #74 adds injected-env-first handling separately in `src/agent/llm.ts`. | Extract one credential resolver, used by provider pools and the LLM. Keep key selection/rotation in `KeyPoolManager`. For `doppler:NAME`, read injected `NAME` first, then use the existing no-shell CLI fallback. | Configured secret names, `env:` behavior, default-secret fallback, per-process TTL, concurrent lookup coalescing, rotation, BWS migration failures, and value redaction. Doctor/status must remain local and never resolve a secret. |
| 2 | `src/cli.ts` combines a manual argument switch, command handlers, rendering, config loading, and agent construction in roughly 1,580 lines. Provider/reasoning options are also consumed by config and status code. | Split parsing/types, formatting, and handlers into `src/cli/` modules. Keep a small executable entrypoint. Reuse the exported LLM provider/reasoning definitions instead of parallel literal lists. | `coldsearch` and `usearch`, implicit search, multiword positionals, flags before/after targets, existing JSON/human output, exit behavior, dry runs, offline discovery, and #74 options. |
| 3 | `src/tools/substrate.ts` dispatches endpoints/auth with a provider switch; adapters separately build overlapping HTTP requests. Bright Data already has `buildBrightDataToolRequest`. | Introduce typed provider request builders using that existing pattern; have the substrate and applicable adapters share endpoint/auth/transport construction. Keep category normalization above the native request layer. | Raw input forwarding, uncatalogued-tool warnings, hard exclusions, per-tool keyless behavior, provider-specific timeout/polling, full raw detail, and native-vs-category semantics. |
| 4 | `src/cache/key.ts` has `stableStringify`; `src/batch/resume.ts` independently has `stableSerialize`. Their undefined-value behavior differs. | Create one deterministic-JSON boundary; evaluate a small serializer package with byte-for-byte comparisons before adopting it. | Existing cache hashes, array order, nested sorted keys, omission of undefined options, and duplicate-id conflict behavior. Do not silently invalidate the cache or change batch equivalence. |
| 5 | `readBatchInput` and `loadResumeIndex` read and split entire files; `HistoryStore.list()` does the same synchronously, and `recent`/`get` call it. | Share line iteration using Node streams/readline for the already-async batch readers first. Move history scanning separately behind a storage interface if local data size warrants it. | Reject all invalid batch input before provider calls; retain line numbers, tolerate corrupt/partial resume/history records, distinguish missing from unreadable files, and preserve current history match tiers and recency order. |
| 6 | `CacheStore`, `HistoryStore`, and `UsageLogger` each duplicate home-path expansion and directory setup; backend and tool substrate repeat TTL freshness and provenance mechanics. | Extract path/freshness helpers and a small audit recorder only where behavior is identical. | Cache is best-effort; history failures remain visible; usage logging remains best-effort. Cache clearing must never delete history, and history retrieval must never silently become replay. |

The provider-builder extraction should begin with one simple provider, then
expand only when it removes real duplication. Do not force Exa's derived crawl,
Firecrawl's asynchronous job polling, or Bright Data's native structured records
through a single generic search adapter.

## Library assessment

**Commander is a useful CLI candidate, but the first PR should split the current
modules.** Its command definitions, option validation, generated help, custom
output, and exit override could replace much of `parseArgs`/`printHelp`. However,
the current official README requires Node 22.12.0 while ColdSearch declares
Node >=18 and CI runs Node 20. Adding the newest Commander without a separate
runtime-support decision would drop supported users. A compatible version must
also be checked for maintenance status. A parser trial must retain implicit
search, multiword queries, `--no-cache` semantics, and machine-readable failures;
Commander does not supply ColdSearch's policy rules by itself.

**`fast-json-stable-stringify` is a plausible small replacement for two recursive
serializers.** Upstream sorts keys and supports nested arrays/objects; its code
also honors `toJSON`, handles nonfinite numbers, omits undefined object values,
and rejects circular objects. Those details are not identical to every possible
input accepted by the current functions. Constrain and test the actual JSON
domain and existing hashes first. Avoid a large schema compiler for this task.

**Use Node's built-in file streams/readline for JSONL before adding a database.**
That replaces whole-file splitting without inventing a line parser or changing
on-disk formats. It reduces the raw-text buffering; retaining the batch plan or
all history records still consumes memory, so do not describe the first change
as constant-memory execution. Input stream failures need explicit propagation
and streams must close on early exits. SQLite becomes a candidate if measured
history size makes repeated scanning costly, with a migration/export contract;
it is not necessary merely to move code into smaller files.

**Keep the focused orchestration and shared HTTP boundary.** RRF, provider
selection, secret redaction, replay allowlists, audit provenance, and the bounded
ReAct loop encode ColdSearch behavior. A generic agent framework or provider SDK
does not remove those responsibilities. ADR 003 already rejects an agent
framework and ADR 004 preserves DNS validation/pinning for untrusted fetches.
Extract security code into a focused module if that improves readability, but
retain DNS-rebinding resistance and body/type limits. Do not swap HTTP clients
unless a specific adapter problem justifies it: retrying a non-idempotent
provider request or changing timeout/error semantics is a behavior change.

Official references checked on 2026-10-07:

- [Commander README and runtime support](https://github.com/tj/commander.js/blob/master/Readme.md#support)
- [Deterministic serializer README](https://github.com/epoberezkin/fast-json-stable-stringify)
- [Serializer implementation](https://github.com/epoberezkin/fast-json-stable-stringify/blob/master/index.js)
- [Node file-by-file line iteration](https://nodejs.org/download/release/v22.17.0/docs/api/readline.html#example-read-file-stream-line-by-line)

These sources verify package/API behavior; the recommendation is based on the
repository's observed duplication and contracts, not a performance claim.

## Acceptance and validation

For this cleanup, use a clean install from the reduced lockfile, TypeScript
checking, the existing complete offline suite, and documentation validation.
The import scan must show no active SDK/resolver consumers. No new test that
merely asserts a dependency name is absent is needed.

For later implementation PRs, add regression coverage only at the changed
boundary: credential precedence/coalescing with value-safe failures, CLI output
and exit contracts, request-builder wire contracts, deterministic cache bytes,
and filesystem behavior with corrupt/partial records. Use real local HTTP and
temporary-file cases when practical. Preserve the existing adapter/security
tests rather than replacing them with mocks of the new helper.

Run the required `typecheck`, full offline tests, and docs checks. A transport
refactor also warrants scoped live conformance for the affected provider when
credentials are available; do not add paid comparisons or full provider
benchmarks to routine CI. Review findings remain advisory as documented.

Implement priorities 1 and 2 after #74, each as a focused PR. The proposal
does not change default models, add merge gates, ship an MCP endpoint, or alter
provider capability coverage; #75 tracks the missing entrypoint separately.

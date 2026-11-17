# Search History, Cache, And Observability

## Current

- Durable execution history exists: every `search` / `extract` / `crawl` /
  `tool call` invocation is recorded as one top-level JSONL execution record
  (`~/.config/coldsearch/history.jsonl`, configurable via `[history].path`).
  Records cover live executions, exact-cache replays (with origin linkage),
  partial successes, and failures — including stored pre-merge fanout
  partitions and per-provider attempts.
- History exploration exists: `coldsearch history recent`, `history search`,
  `history show [--by-provider]`, and `history clear --all`. Retrieval is
  local-only and never suppresses a live provider call.
- The exact-replay cache is separate from history: `cache stats` / `cache
  clear`, config `[cache]` TTLs plus the per-invocation `--freshness
  <duration>` override, atomic writes, and restrictive permissions. Cache
  entries carry provenance (creation time, origin execution ID where known).
- Provider-tool exact replay exists only for tools on the explicit
  replay-safe allowlist (`src/tools/replay.ts`); all other provider tools are
  history-only and always execute live. Crawl replay remains disabled.
- History records and tool-cache payloads are scrubbed before persistence:
  resolved credential values, signed-URL tokens, and credential fields are
  redacted; unscrubbable raw detail is recorded as unavailable. Failed
  history writes surface as observable warnings.
- Usage logging exists as JSONL.
- Agent and provider paths have some structured errors and timings.

## Target: Research Memory

Search history/research memory is the user-facing concept. The exact-response cache is a separate implementation mechanism with freshness and replay policy; it must not define the exploration surface.

**Core invariant:** history records what ColdSearch did; cache determines whether a prior exact result may be replayed. History retrieval may inform a new search, but an approximate history match never suppresses a live provider call automatically.

### Execution records

Create one top-level history execution for each `search`, `extract`, `crawl`, or provider-tool invocation. A multi-provider fanout is one execution with provider attempts/results beneath it, not several unrelated history items.

A useful execution record should preserve information ColdSearch actually has, including:

- stable execution ID and timestamp
- command/capability and original query or URL
- relevant ColdSearch request options and provider-specific parameters where available
- routing strategy, requested provider scope, and providers actually attempted
- source: live execution or exact-cache replay
- originating execution ID when an exact cached result is replayed
- provider attempts with provider/tool, success/error, timing, and safe key reference where available
- normalized provider results where available
- raw provider detail only where the existing execution path already preserves it
- final normalized/merged result
- result URLs or artifact references
- overall errors and duration
- optional run/agent correlation fields when later trace work supplies them; PR 2 must not implement PR 5 run-ID behavior

A cache hit is still a new history execution because ColdSearch was invoked again. Record that zero provider calls occurred and link the execution to the execution that produced the cached result.

History must survive cache expiry and `cache clear`. Expiring or clearing replay material must not erase the record that an execution occurred.

### History exploration

The initial history surface is:

- `coldsearch history recent` — list recent top-level executions newest first. Show enough metadata to recognize the work: execution ID, time, command, abbreviated input, providers, live/cache source, outcome, and result count. Use a bounded default and support `--limit` and `--json`.
- `coldsearch history search <query>` — local-only retrieval over prior executions. Search the original request most strongly, then result titles and URLs/domains, then snippets/content and provider/tool metadata. Return matching executions with the fields/results that caused the match. Do not search arbitrary raw provider JSON by default and do not call providers. Use a bounded default and support `--limit` and `--json`.
- `coldsearch history show <execution-id>` — reconstruct one execution: request, routing, cache provenance, provider attempts, final normalized output, and errors. If raw provider detail was not preserved on that execution path, say it is unavailable rather than reconstructing it.
- `coldsearch history show <execution-id> --by-provider` — for stored fanout work, show each provider's pre-merge results/errors and the final merged/reranked output. Simple URL overlap/unique counts may be computed from stored data; do not rank providers or make new calls.
- `coldsearch history clear --all` — explicitly delete all local history records without touching replay-cache entries. Require `--all` so the destructive operation is deliberate and report how many records were removed.

`history compare` is a useful follow-on once these records exist, but it is not required to deliver the initial history implementation.

When fanout already occurs for real work, preserve the provider result partitions before reranking so they remain inspectable later. Do not call extra providers solely to create comparison data.

History is durable but operator-deletable. Do not invent an automatic history TTL or pruning policy until real storage/use patterns justify one; selective pruning can be added later if needed.

### Cache remains separate

Keep exact replay and cache maintenance as cache concerns:

- exact-key replay obeys freshness policy
- `cache stats` describes replay-cache storage
- `cache clear` clears replay-cache material only, not history
- atomic writes and restrictive permissions apply where supported
- the cache owns only real `.json` files inside real capability directories
  under its configured root (a root that is itself a symlink is followed as
  configured). Linked capability directories and linked or non-regular entries
  are never read, written, counted, or deleted by lookups, `cache stats`, or
  `cache clear`; maintenance lists them under `skipped` instead of claiming
  they were handled, so a link cannot make `cache clear` reach history or other
  data outside the cache. The guard is `lstat` check-then-use, not protection
  against a concurrent adversarial path swap
- an entry whose timing metadata is not a finite in-range `created_at` and a
  finite non-negative `ttl_seconds` is corrupt: lookups treat it as a miss
  (never a replay), `cache stats` counts it in `corrupt_entries` without
  formatting a date, and `cache clear` removes it. A zero TTL, an expired entry,
  and a per-invocation `--freshness` override keep their existing meaning
- crawl executions belong in history, while exact crawl replay remains disabled until a deliberate cache policy is chosen
- provider-tool exact replay is allowed only when the tool has an explicit replay-safe request key/policy; otherwise provider-tool executions are history-only

History results can be explicitly inspected and reused by a caller or agent, but PR 2 should not add automatic fuzzy reuse or silently turn related-history matches into cache hits.

Provider-effectiveness analysis should operate on accumulated records and must not initiate paid provider calls as part of normal validation.

Build this by extending execution detail already available from normalized paths, usage logging, and the generic provider-tool substrate. Do not create a second observability system, require annotations/scoring, mandate embeddings/vector infrastructure, or refactor every adapter solely to capture raw HTTP payloads.

## Observability

Observability should be rich enough to reconstruct observable application behavior:

- execution ID and optional run ID when one exists
- provider/tool selected
- routing strategy and candidate/attempted providers
- key reference used, never the key value
- exact-cache lookup/hit/miss and origin execution for replay
- history query and selected history records when history is explicitly queried
- request timings and retry attempts
- normalized and provider-specific errors
- observable agent tool calls/actions, not private model reasoning
- output artifact paths

## Non-Secret Rule

Logs, cache metadata, and history records must not persist secret values. Key usage is recorded by safe reference only.

Provider-supplied content — including error bodies that may echo a credential — is scrubbed of resolved credential values before it is persisted; content that cannot be scrubbed safely is recorded as unavailable. Caller-supplied inputs and persisted results are treated the same way: signed URLs and credential fields in original requests, options, and normalized/final result fields (including adapter URL fallbacks) are recursively redacted before persistence, never stored verbatim.

A failed history write is surfaced as an observable, non-secret warning; history records are never silently dropped the way a cache miss is tolerated.

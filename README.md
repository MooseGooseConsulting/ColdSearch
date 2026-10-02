# ColdSearch

`coldsearch` is a unified search CLI for web search, extraction, and crawling across overlapping provider APIs. The CLI stays simple; the routing, provider selection, and key management live in config and shared runtime code.

`usearch` remains available as a compatibility alias for now.

## Quick Start

```bash
npm install
npm run build

# Primary command
coldsearch --help

# Compatibility alias
usearch --help
```

Configuration lives at `~/.config/coldsearch/config.toml`. The runtime also falls back to `~/.config/usearch/config.toml` if the new path does not exist yet.

**First run:** copy `config.example.toml` to that path, set provider keys via `doppler:`/`env:` refs (or plain env vars), and fix `providers.searxng.options.baseUrl` if you use SearXNG. Optional: `doppler run -- coldsearch search "query"` to inject secrets without putting keys in the file.

## What ColdSearch Is

- A CLI-first interface over multiple search providers
- A normalized runtime that hides provider-specific quirks behind shared schemas
- A config-driven routing layer that lets humans decide provider pools and rotation
- A local-first tool today, with explicit architectural seams for a future hybrid remote execution backend

## What ColdSearch Is Becoming

ColdSearch is not aiming at MCP as the long-term interface. The long-term direction is still CLI-first, but with optional remote execution:

1. The CLI remains the operator-facing interface.
2. Some work, especially agentic or long-running jobs, can later be submitted to a remote backend.
3. That backend can centralize secrets, job state, retries, and async orchestration.

The current implementation remains local-first, but the runtime is now being organized so the CLI and a future remote executor can share the same provider registry, routing logic, and normalization layer.

## Current Capabilities

| Capability | Implemented Providers | Selection |
|------------|-------------------|-----------|
| `search` | SearXNG, Tavily, Exa, Brave, Serper | Manual random pool |
| `extract` | Tavily, Exa, Jina, Firecrawl | Manual random pool |
| `crawl` | Tavily, Firecrawl, Exa | Manual random pool |

Random routing normally uses one provider. If its account credits/quota are
exhausted, search/extract/crawl try the remaining eligible pool in order until
one succeeds. Recovery retains failed attempts in usage logs and execution
history; it does not remove providers or change config. An explicit single
provider has no alternative to recover through. See
[quota recovery](docs/CONFIGURATION.md#quota-recovery).

## Provider Overlap

The core architectural truth is provider overlap, not just three coarse commands.

- Tavily, Exa, Brave, Serper, and SearXNG overlap heavily on search.
- Tavily, Exa, Jina, and Firecrawl overlap on content extraction.
- Tavily and Firecrawl overlap on site discovery and crawl-like workflows.
- Several providers expose richer surfaces than ColdSearch currently implements.

The authoritative comparison lives in:

- `docs/PROVIDERS.md` — capability + tool matrix and per-provider coverage

## SearXNG

SearXNG is treated as a self-hosted or operator-managed provider.

- ColdSearch supports SearXNG via an explicit `baseUrl` provider option or `SEARXNG_BASE_URL`.
- The product code does not assume `localhost`.
- Optional self-hosting assets may exist in the repo, but they are infrastructure aids for another machine, not the default local workflow for this laptop.

Example config:

```toml
[providers.searxng]
[providers.searxng.keyPool]
keys = []

[providers.searxng.options]
baseUrl = "https://search.example.internal"
```

## Batch runs

`coldsearch batch` is a resumable JSONL runner for `search`, `extract`, `crawl`,
and provider-tool records. Each item executes through the same backend/tool
substrate as the standalone command — same routing, cache, and execution
history — so batch adds no second history model. The output JSONL is batch's
own append-only artifact.

```bash
coldsearch batch --input queries.jsonl --output results.jsonl --concurrency 4
coldsearch batch --input queries.jsonl --output results.jsonl --concurrency 4 --retry-errors
coldsearch batch --input queries.jsonl --output results.jsonl --dry-run --json
```

Input: one JSON object per line. Exactly one of `capability` | `tool` per
record; `id` is the stable resume key.

```jsonl
{"id":"node-lts","capability":"search","query":"current node lts version","limit":5}
{"id":"example-extract","capability":"extract","url":"https://example.com"}
{"id":"example-crawl","capability":"crawl","url":"https://example.com","limit":10}
{"id":"tavily-answer","tool":"tavily.answer","input":{"query":"current node lts version"}}
```

Optional knobs mirror the CLI flags: `limit`, `providers`, `singleProvider`,
`noCache`.

Resume is keyed on `id` only: if you change an item's input, give it a new
`id` or it will be skipped as already-succeeded. Batch items are configured
per-record; the global `--limit`, `--providers`, `--no-cache`, and
`--freshness` flags do not apply to `batch`.

Output: one JSON object per processed record, appended in completion order.
Successful records have `status:"success"` and `error:null`; failed records
have `status:"error"` and `result:null`. Reruns resume by `id`: existing
successes are skipped, existing errors are retried only with `--retry-errors`,
and duplicate/conflict records (repeated `id` with different input) are emitted
as visible error records that are never retried.

## Development

```bash
npm install
npm run build
npm test
```

## Documentation

- `docs/NORTH_STAR.md` - Product direction and goals (authority)
- `docs/architecture.md` - Technical shape, status labels, invariants
- `docs/PROVIDERS.md` - Capability + tool matrix and per-provider coverage (single source of truth)
- `docs/CONFIGURATION.md` - Configuration reference and precedence
- `docs/reviews/2026-07-16-project-review-and-bright-data.md` - Dated project, GitHub, memory, and Bright Data review
- `plans/2026-06-22-remaining-implementation-master-plan.md` - Active implementation sequence (informational)
- `docs/contributing/testing.md` - What to test (and what not to duplicate)

Dated reviews are evidence snapshots. They do not override the North Star,
architecture, provider matrix, code, or current GitHub state.

## Roadmap

- Build searchable recent-result memory and harden cache persistence/operations
- Add batch execution after cache and memory behavior are stable
- Add agent run IDs and step-level trace correlation
- Finish guided configuration/status UX and normalized error classification
- Keep remote/hybrid execution deferred until the local audit and workflow surfaces are trustworthy

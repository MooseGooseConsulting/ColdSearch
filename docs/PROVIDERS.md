# ColdSearch Providers — Capability & Tool Matrix

**Single source of truth** for which providers ColdSearch supports, which of each
vendor's tools are actually wired, and what has been verified against live APIs.
This file replaces the former per-provider pages under `docs/providers/` and the
standalone `docs/CAPABILITY_MATRIX.md`.

**Maintenance rule:** update this file whenever a provider's adapter, registry
entry, or capability coverage changes. The `## Dual Matrix` table below is
machine-checked against the registry (`src/providers.ts`) and the adapters by
`test/capability-matrix-drift.test.mjs` — run `npm run test:docs`.

## Normalized capabilities

ColdSearch normalizes every provider to three capabilities. Provider names never
appear in the agent-facing interface — callers ask for a capability, not a vendor.

| Capability | Meaning |
|------------|---------|
| `search` | general web search routed through a configured provider pool |
| `extract` | retrieve page content from a single URL |
| `crawl` | gather multi-page site content |

## Category views over provider tools

These capabilities are **category views**, not apples-to-apples provider
features. A category is a portable caller intent that several heterogeneous
provider-native tools can back — with different parameter surfaces, semantics,
and cost models (see `docs/ADRs/005-provider-tool-profiles.md`).

```
ColdSearch category
  → eligible provider tools
    → provider-native parameter schema
      → feature predicates + safe common-view mappings
```

Native tool **names are not authoritative**. Watch these collisions:

| Looks like | Actually is | ColdSearch backer |
|------------|-------------|-------------------|
| Firecrawl `extract` | structured-LLM extraction (a `research`-style tool) | `extract` is backed by Firecrawl **`scrape`** |
| Firecrawl `scrape` | known-URL page retrieval | ColdSearch `extract` |
| Bright Data Web Scraper APIs | site-specific structured records such as products/reviews/companies | provider-native tools; **not** generic `extract` |
| Bright Data Web Unlocker | known-URL page retrieval / anti-bot access | ColdSearch `extract` |
| Brave Web Search | SERP-style search | ColdSearch `search` |
| Brave LLM Context | search **plus** extracted context chunks for LLM grounding | not the plain `search` backer |
| Exa `/search` | one endpoint spanning `instant` … `deep-reasoning` | `search` (and `research` at deep modes) |
| Tavily `crawl` vs `map` | crawl returns content; map returns URLs | distinct categories |

The durable record for every provider-native tool — native params, common-view
mappings (`direct`/`partial`/`derived`), feature predicates, sync/async
behavior, and wired/available status — lives in the provider-tool profile
registry. Core profiles remain in `src/registry/tool-profiles.ts`; provider-
specific extensions such as Bright Data may live in a focused registry module
that installs into the same runtime profile object. Inspect it live, no network:

```bash
coldsearch tool list --json
coldsearch tool list --provider brightdata --json
coldsearch tool info brightdata.scrape --json
```

Parameter-level detail is intentionally kept in the registry (and surfaced by
`tool info`) rather than mirrored in prose here, because vendor parameters go
stale fast.

## Dual Matrix

Vendor columns = what the provider's API offers at the capability level.
ColdSearch columns = what the adapter actually implements today.
`✅` supported · `⚠️` partial/constrained · `❌` not supported.

| Provider | Vendor `search` | Vendor `extract` | Vendor `crawl` | ColdSearch `search` | ColdSearch `extract` | ColdSearch `crawl` | Notes |
|----------|:---------------:|:----------------:|:--------------:|:-------------------:|:--------------------:|:------------------:|-------|
| Tavily | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Broadest all-rounder |
| Firecrawl | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Vendor surface is richer than the adapter |
| Exa | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | Crawl synthesized via discovery + `contents` |
| Brave | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | Search-only vendor |
| Bright Data | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | SERP + Web Unlocker implemented; Crawl remains provider-native/candidate |
| Serper | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | Google SERP; search-only vendor |
| Jina | ⚠️ | ✅ | ⚠️ | ❌ | ✅ | ❌ | Reader extraction only today |
| SearXNG | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | Self-hosted; operator-configured `baseUrl` |

## Live verification status

The legacy provider set was last broadly verified **2026-05-28** against real
provider APIs via `scripts/smoke.mjs` and ad-hoc probes. `✅⚡` = live-verified
end-to-end · `✅` = implemented but not yet live-checked · `—` = not applicable.

| Provider | search | extract | crawl |
|----------|:------:|:-------:|:-----:|
| Tavily | ✅⚡ | ✅⚡ | ✅⚡ |
| Firecrawl | ✅⚡ | ✅⚡ | ✅⚡ |
| Exa | ✅⚡ | ✅⚡ | ✅⚡ |
| Brave | ✅⚡ | — | — |
| Bright Data | ✅ (not live-verified) | ✅ (not live-verified) | — |
| Jina | — | ✅⚡ | — |
| Serper | ✅ (no key in test env) | — | — |
| SearXNG | ✅ (needs an endpoint) | — | — |

Bright Data is intentionally **not** considered live-verified merely because its
adapter and direct-tool mappers exist. Its first live proof must be an explicit,
scoped run with intentionally supplied account configuration; it must not enter
paid routine CI.

## Bright Data adoption status

**Status: implemented surface, explicit-only adoption.** Bright Data now has a
ColdSearch adapter/registry entry for SERP `search` and Web Unlocker `extract`,
plus provider-native mappings for its structured Web Scraper API lifecycle. It
is deliberately absent from the example/default capability pools until measured
quality, cost, and usage observability justify broader routing.

| Bright Data surface | ColdSearch fit | Current policy |
|---------------------|----------------|----------------|
| SERP API | `search` category backer | Implemented; explicit/configured use, not default pool |
| Web Unlocker | `extract` category backer | Implemented; explicit/configured use, not default pool |
| Dataset/scraper discovery + metadata | Provider-native tools | Catalogued; lets agents discover account-available scraper IDs/schemas |
| Web Scraper synchronous scrape | Provider-native tool | Structured records; never flattened into generic `extract` |
| Web Scraper async trigger + snapshot results | Provider-native tools | Explicit lifecycle for discovery/batch/longer collection |
| Crawl API | Provider-native candidate | Do not claim normalized `crawl` until polling/output/spend mapping is proven |
| Discover API | Provider-native candidate | Keep distinct from ordinary `search` |
| Browser/proxy and marketplace purchase workflows | High-cost/stateful surfaces | Not part of the initial implementation |

The dated account/adoption assessment remains in
`docs/reviews/2026-07-16-project-review-and-bright-data.md`. Its guardrails still
apply: secret-safe configuration, request/spend limits before recurring paid use,
product/zone/cost observability, scoped parity evidence, offline tests, no paid
live CI, and no default-pool promotion without evidence.

## Vendor tool surface

What each vendor's API offers, and what ColdSearch wires. `✅` wired normalized
backer · `🧰` catalogued/direct provider-native surface · `❌` available upstream
but not adopted. Vendor pricing and rate limits live in each vendor's own docs —
they go stale fast and are intentionally not mirrored here.

### Bright Data — `src/adapters/brightdata.ts` / `src/tools/brightdata.ts` · [docs](https://docs.brightdata.com)
- SERP `POST /request` with configured SERP zone → **search** ✅
- Web Unlocker `POST /request` with configured Unlocker zone → **extract** ✅
- `GET /datasets/list` → `brightdata.datasetsList` 🧰
- `GET /datasets/{dataset_id}/metadata` → `brightdata.datasetMetadata` 🧰
- `POST /datasets/v3/scrape` → `brightdata.scrape` 🧰
- `POST /datasets/v3/trigger` → `brightdata.trigger` 🧰
- `GET /datasets/v3/progress/{snapshot_id}` → `brightdata.progress` 🧰
- `GET /datasets/snapshots/{id}` → `brightdata.snapshotMetadata` 🧰
- `POST /datasets/v3/snapshot/{snapshot_id}/cancel` → `brightdata.cancel` 🧰
- snapshot download → `brightdata.snapshot` 🧰
- Crawl API job triggering → `brightdata.crawl` 🧰 candidate; not normalized crawl
- Discover API → `brightdata.discover` 🧰 candidate; not ordinary normalized search
- Browser API / proxy products / marketplace purchase workflows ❌ initial scope

### Tavily — `src/adapters/tavily.ts` · [docs](https://docs.tavily.com)
- `POST /search` → **search** ✅ (a `topic:"news"` variant exists but is not separately exposed)
- `POST /extract` → **extract** ✅
- `POST /crawl` → **crawl** ✅
- `POST /map` (URL discovery) ❌
- `POST /answer` (one-shot answer + citations) ❌
- `POST /research` (multi-search report) ❌

### Firecrawl — `src/adapters/firecrawl.ts` · [docs](https://docs.firecrawl.dev)
- `POST /search` → **search** ✅
- `POST /scrape` → **extract** ✅
- `POST /crawl` (async job, polled) → **crawl** ✅
- `POST /map` (URL discovery) ❌
- `POST /extract` (schema / LLM structured extraction) ❌
- `/scrape` actions (interact: click/scroll/type) ❌
- `POST /agent` (autonomous browser agent) ❌
- `POST /batch/scrape` (bulk) ❌

### Exa — `src/adapters/exa.ts` · [docs](https://docs.exa.ai)
- `POST /search` → **search** ✅
  - **Config-driven options** (set in `config.toml` under `[providers.exa.options]`):
    - `highlights` — token-efficient excerpts (~10x reduction for agents)
    - `category` — specialized indexes: `company`, `people`, `research paper`, `news`, `personal site`, `financial report`
    - `searchType` — `auto`, `keyword`, `neural`, `fast`, `instant`, `deep-lite`, `deep`
    - `maxAgeHours` — `0` = always livecrawl, `-1` = never livecrawl
    - `includeDomains` / `excludeDomains` — domain filters
    - `numResults` — result count (default: 10)
    - `useAutoprompt` — query enhancement (default: true)
    - `maxCharacters` — text length cap (default: 15000)
- `POST /contents` (with livecrawl) → **extract** ✅ and backs synthesized **crawl** ✅
- `POST /findSimilar` (semantic neighbors — unique to Exa) ✅ (available via adapter method, not CLI)
- `POST /answer` ❌
- `POST /research` (async) ❌
- `POST /chat/completions` (web-grounded chat) ❌

### Brave — `src/adapters/brave.ts` · [docs](https://api.search.brave.com/app/documentation/)
- `GET /res/v1/web/search` → **search** ✅
- `/res/v1/news/search`, `/res/v1/images/search`, `/res/v1/videos/search` ❌
- `/suggest` (autocomplete), `/spellcheck` ❌
- Data-for-AI LLM context (paid) ❌

### Serper — `src/adapters/serper.ts` · [docs](https://serper.dev/docs)
- `POST /search` (Google web) → **search** ✅
- `/images`, `/news`, `/videos`, `/shopping`, `/maps`, `/places`, `/scholar`, `/patents`, `/autocomplete`, `/reviews` ❌ — **10 Google verticals unused**

### Jina — `src/adapters/jina.ts` · [docs](https://jina.ai)
- `r.jina.ai` Reader → **extract** ✅ (keyless)
- `s.jina.ai` search ❌
- deep-search, `/v1/embeddings`, `/v1/rerank`, summarize ❌

### SearXNG — `src/adapters/searxng.ts` · [docs](https://docs.searxng.org)
- `/search` (general) → **search** ✅ (operator-configured `baseUrl`, optional `SEARXNG_BASE_URL`)
- category variants (news / images / …) ❌

## Unexposed surface worth considering

These are design choices, not bugs — the adapters expose the common denominator and
skip vendor specialties. Highest-leverage gaps:

- **Serper** — 10 Google verticals (news, scholar, images, shopping, maps, patents…); only plain web is wired.
- **Jina** — `embeddings` + `rerank` could back ColdSearch's own reranking step; plus a free `search`.
- **Tavily `answer`/`research`** and **Exa `answer`/`research`** — one-call research that overlaps the hand-rolled ReAct agent (`docs/ADRs/003-react-agent.md`).
- **Firecrawl** `map`, schema `extract`, and `batch` — directly useful for the planned batch mode (`plans/2026-06-22-pr3-batch-runner.md`).
- **Bright Data** Crawl/Discover/Browser/Marketplace expansion should be driven by concrete workflows and spend controls, not by surface-area completion.

## Adding a provider

See `docs/contributing/adding-a-provider.md`. In short: implement the
`SearchAdapter`, register it in `src/providers.ts`, add a `ProviderToolProfile`
per tool, add a row to the **Dual Matrix** above, and add tests. `npm run test:docs`
enforces that the Dual Matrix stays in sync with the registry and adapter method
surfaces.

## Agent synthesis LLMs

These endpoints power `--agent`; they are separate from the search provider matrix.
The default is Isoquant `glm-5.3-flash`, `reasoning_effort = "medium"`, with
`doppler:ISOQUANT_API_KEY` (rename the reference to match the actual secret).
OpenRouter defaults to `openrouter/free` and powers the routine live LLM canary.
OpenAI, Groq, Cerebras and explicit xAI overrides remain available. Explicit
`--llm xai` currently defaults to `grok-4.3`; it is never selected by the agent
or canary defaults.
See `docs/CONFIGURATION.md` for secret injection and migration details.

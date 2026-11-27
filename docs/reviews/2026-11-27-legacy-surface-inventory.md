# ColdSearch — Pre-Gateway Surface Inventory (2026-11-27)

**Status:** dated evidence snapshot at commit `de0ecb4` (branch
`feat/mcp-gateway`). Like all `docs/reviews/` entries it does not override
`docs/NORTH_STAR.md`, `docs/architecture.md` or code.

**Purpose:** input for a later change that removes pre-gateway code. This
document recommends. It removes nothing, and no code was changed to write it.

The pre-gateway surface is everything under `src/` that existed before
`src/gateway/`: the `search`, `extract`, `crawl`, `--agent`, `batch`,
`tool`, `history`, `cache`, `status` and `config` commands and the modules
behind them. `docs/ADRs/006-mcp-gateway.md` makes the gateway the surface new
work builds on.

## How this was measured

- **Lines:** `wc -l` on every `.ts` file under `src/`, summed per directory.
  Comments and blank lines are included.
- **"Gateway uses it":** the relative imports of the compiled
  `dist/gateway/*.js`, followed until no new file appears. Compiled output was
  used because TypeScript drops type-only imports there, so what is left is
  what the gateway loads when it runs. Result: four files outside
  `src/gateway/`.
- **Importers and tests:** relative imports in `src/**/*.ts`, and the
  `dist/...` paths each file under `test/` imports.
- **Not measured:** runtime behavior, test coverage, and whether anything
  outside this repository imports the package.

## Totals

| | Files | Lines |
|---|---|---|
| All of `src/` | 59 | 18,318 |
| `src/gateway/` | 7 | 1,611 |
| Pre-gateway files the gateway loads at run time (`app.ts`, `config.ts`, `engine/keypool.ts`, `logging/usage.ts`) | 4 | 574 |
| Pre-gateway files the gateway does not load | 48 | 16,133 |

The gateway and what it loads are 2,185 lines, 12% of `src/`. `test/` holds
15,087 lines in 48 test files; one file, `test/gateway.test.mjs` (486 lines),
covers the gateway.

## Inventory

"Uses" means the gateway loads the module at run time.

| Group | Files | Lines | What it does | Gateway uses it today | Recommendation |
|---|---|---|---|---|---|
| `src/adapters/` | 9 | 1,771 | One adapter per provider (Brave, Bright Data, Exa, Firecrawl, Jina, SearXNG, Serper, Tavily) that calls the provider's API and returns the normalized `search`, `extract` or `crawl` shape | No | Remove |
| `src/engine/fanout.ts`, `reranker.ts` | 2 | 1,306 | `FanoutEngine` picks providers for a capability, calls one or all of them, recovers from an out-of-credit provider by trying another provider, and writes usage lines. The reranker merges result lists (RRF, score, or none) | No | Remove |
| `src/engine/keypool.ts` | 1 | 292 | `KeyPoolManager`: resolves `doppler:` and `env:` references with a short cache, and rotates keys within a per-process pool | **Yes**: `core.ts` calls `KeyPoolManager.resolveRef` for every key reference. It does not use the pool rotation | Fold into the gateway |
| `src/dispatch/` | 2 | 634 | `intents.ts` maps a search intent to required provider features and the tools that satisfy them. `translate.ts` turns common options into each provider's native options | No | Remove |
| `src/agent/` (research loop) | 5 | 1,065 | ReAct research loop (`agent.ts`), OpenAI-compatible LLM client and presets (`llm.ts`), tool payload parsing, source tracking | No. `src/types.ts` has a type-only import of `agent/llm.ts` | Remove |
| `src/agent/agent.ts` (SSRF-safe fetch) | part of the above | about 240 of 498 | The checks of ADR 004: protocol and hostname rules, blocked address ranges, DNS validation, connection pinned to the validated address, size and content-type limits | No | Fold into the gateway |
| `src/batch/` | 4 | 1,412 | `coldsearch batch`: reads JSONL records, runs each through the execution backend or `tool call`, writes JSONL results, resumes by record id | No | Remove |
| `src/cache/` | 2 | 575 | `CacheStore`: file cache with TTL, atomic writes and 0600 permissions, used for exact replay of search, extract and replay-safe tool calls. `key.ts` builds stable cache keys and parses durations | No | Remove |
| `src/history/redact.ts` | 1 | 195 | Redacts resolved key values, credential-named fields, signed-URL query tokens and URL userinfo from anything about to be persisted | No. The ledger has its own `redact`, which replaces known key values only | Fold into the gateway |
| `src/history/` (store, search, types) | 3 | 436 | One JSONL record per legacy command execution, with provider attempts; substring search with match reasons; `history recent`, `search`, `show`, `clear` | No | Remove |
| `src/tools/` | 6 | 1,477 | `substrate.ts` executes `tool call <provider>.<tool>` from a registry profile, with cache, history and usage logging. `brightdata.ts` builds Bright Data scraper and dataset requests. `dispatch-paths.ts` builds Serper, Brave and Jina URLs. `replay.ts` lists tools safe to replay from cache | No | Remove |
| `src/registry/` | 2 | 1,488 | 54 hand-written provider-tool profiles (15 back a normalized command, 16 are callable only through `tool call`, 23 are not implemented), lookups, and the feature filter used for routing | No | Remove |
| `src/contracts/` | 3 | 337 | Endpoint identity for cache keys, shape checks on normalized results, async job status types | No | Remove |
| `src/testing/` | 2 | 879 | `capture.ts` records each HTTP exchange made through `fetchWithPolicy` when `COLDSEARCH_CAPTURE_DIR` is set, with redaction. `replay.ts` plays captured envelopes back through adapters in tests | No. The gateway's upstream calls do not go through `fetchWithPolicy`, so capture does not see them | Remove |
| `src/execution/` | 1 | 849 | `LocalExecutionBackend`: runs search, extract and crawl end to end (intent, cache lookup, fanout, history, cache write) | No | Remove |
| `src/logging/usage.ts` | 1 | 78 | `safeKeyRef` (the loggable form of a key reference) and `UsageLogger` (appends to `usage.jsonl`) | **Yes**: `core.ts` calls `safeKeyRef`. It does not use `UsageLogger` | Fold into the gateway |
| `src/http.ts` | 1 | 585 | `fetchWithPolicy` (timeouts, retries, capture hook) and `classifyError`, which sorts failures into nine categories | No. `openapi.ts` calls `fetch` directly, and the ledger has four error classes | Remove |
| `src/providers.ts` | 1 | 225 | Provider registry and capability matrix; picks the providers for a capability request | No | Remove |
| `src/status.ts` | 1 | 580 | `coldsearch status` and `config doctor`: summaries of the usage log, cache, key pools, profiles and LLM presets | No. The gateway reports through its `coldsearch_status` tool | Remove |
| `src/cli.ts` | 1 | 1,971 | Flag parser, help text and every command. Dispatches `mcp` to the gateway before parsing anything else | It is the gateway's entry point; the gateway imports nothing from it | Keep, and shrink |
| `src/config.ts` | 1 | 189 | Finds and parses the TOML config; `config init` template | **Yes**: `run.ts` calls `loadConfig` | Keep |
| `src/types.ts` | 1 | 324 | Shared types for the legacy commands, and the `Config` type | Type-only | Keep, and shrink |
| `src/app.ts` | 1 | 15 | Name, version, user agent, config directory name | **Yes** | Keep |
| `src/index.ts` | 1 | 24 | Package exports, legacy and gateway | Tests import the gateway through it | Keep, and shrink |

## Reasons, and what would break

| Group | Reason for the recommendation | What breaks when it goes |
|---|---|---|
| `src/adapters/` | The gateway reaches Exa, Firecrawl, Tavily and Bright Data through upstreams that carry each provider's full surface; the adapters reach a normalized subset | `search`, `extract`, `crawl`, `--agent` and batch capability records. **ColdSearch's only route to Brave, Serper, Jina and SearXNG**, none of which has a gateway upstream: decide their fate first. 11 test files under `test/adapters/` (1,539 lines) and `test/fixtures/provider-envelopes/`. `docs/PROVIDERS.md`. The daily canary (`scripts/smoke.mjs`) |
| `fanout.ts`, `reranker.ts` | A gateway call names one provider tool, so there is nothing to fan out or merge (ADR 006 on ADRs 001 and 002) | `search` under both strategies, `extract`, `crawl`; cross-provider quota recovery. `fanout-engine`, `quota-failover`, `reranker`, `runtime-seams` and `dispatch-provenance` tests (1,510 lines). `docs/contributing/testing.md` names `FanoutEngine` routing as a test to keep |
| `keypool.ts` | The gateway needs the reference resolution and its cache. The rotation (`register`, `getNextKey*`) restarts at the first key in every process and is replaced by the gateway's ordered lists | Removing the file outright stops the gateway resolving any key. Folding means moving the resolution next to the gateway and deleting the rotation once `fanout.ts`, `tools/substrate.ts`, `batch/runner.ts` and `agent/llm.ts` no longer call it |
| `src/dispatch/` | Intents and option translation exist to choose and drive a normalized provider. In the gateway the agent names the tool and sends the provider's own arguments | `--intent`, batch intent records. `providers.ts`, `fanout.ts`, `backend.ts` and `batch/` import it, so it goes with them. `dispatch-intents`, `dispatch-translate` and `cli-intent` tests (509 lines) |
| `src/agent/` (research loop) | The gateway serves agents and does not run one; providers' research endpoints are reachable as tools | `--agent` and its LLM flags. `status.ts` imports `agent/llm.ts` and `agent/key-ref.ts`; `types.ts` imports a type from `agent/llm.ts`. Five agent test files (581 lines). ADR 003 would describe no code |
| `agent.ts` (SSRF-safe fetch) | ADR 006 requires these checks of the gateway-native fetch, and this is the only implementation. It sits in private methods of `SearchAgent`, so it has to be moved before agent mode is removed | If it is deleted with agent mode, the gateway-native fetch starts without SSRF protection and the SSRF tests in `test/agent-mode.test.mjs` go with it |
| `src/batch/` | It drives the execution backend, intents and `tool call`, all of which are recommended for removal. A batch client of the gateway would share none of this code | `coldsearch batch` and its README section. `batch` and `cli-batch` tests (1,597 lines). The proposed North Star still lists "a batch of requests" as an input, so removing this leaves that unserved until something replaces it |
| `src/cache/` | It replays stored answers to provider calls. The gateway does not answer a provider call from stored results (`docs/architecture.md`, "No silent replay") | `cache stats`, `cache clear`, `--freshness`, `--no-cache`; `backend.ts`, `tools/substrate.ts` and `status.ts` import it. `cache`, `cache-boundary`, `cache-cli` and `result-cache` tests (1,234 lines). `CacheStore` is the only keyed file cache with TTLs in the repository; a gateway-native fetch that wants a page cache would otherwise write a new one |
| `history/redact.ts` | It covers cases the ledger's `redact` does not: credential-named fields, signed-URL tokens and URL userinfo. Payload files hold full requests and responses, where those cases occur | Nothing in the gateway. `testing/capture.ts`, `backend.ts`, `tools/substrate.ts`, `batch/runner.ts` and `cli.ts` import it, so it must stay until they go or move with the fold |
| `src/history/` (rest) | It records executions of the legacy commands only. Gateway calls go to the ledger | `history recent`, `search`, `show`, `clear`. `history` and `history-cli` tests (1,965 lines). `docs/components/cache-and-observability.md`. Existing `history.jsonl` files stay on disk and become unreadable through ColdSearch |
| `src/tools/` | `tool call` reaches provider tools from hand-written profiles; the gateway reaches the same providers' tools from their API documents | `tool call` and batch tool records. `adapters/brightdata.ts` imports `tools/brightdata.ts`. The provider-tool rows of `scripts/provider-pass-through.mjs` and `scripts/smoke.mjs`, which run `tool call`. `provider-tools`, `substrate-behavior`, `brightdata` and `lifecycle` tests (2,139 lines). `tool call` is also the route to Serper's, Brave's and Jina's extra endpoints |
| `src/registry/` | The gateway's catalogue comes from the provider at run time and it does not read the registry (ADR 006 on ADR 005) | `tool list`, `tool info`, `tool call`; `providers.ts`, `dispatch/`, `fanout.ts`, `batch/jsonl.ts`, `status.ts`. **`npm run test:docs` and the `ci` job**: `test/capability-matrix-drift.test.mjs` checks the registry against `docs/PROVIDERS.md`. `provider-tool-profiles` test (180 lines). `docs/contributing/adding-a-provider.md` |
| `src/contracts/` | Each contract guards a legacy seam: cache identity, normalized result shape, adapter job status | `fanout.ts`, `backend.ts`, `tools/substrate.ts`. `contracts` test (256 lines) and parts of `lifecycle` and `replay-fixtures.contract` |
| `src/testing/` | Capture hooks into `fetchWithPolicy`, which the gateway does not use; replay feeds adapters. The gateway's payload files record the same exchanges for its own calls | `http.ts` imports `capture.ts` and `cli.ts` calls `flushCaptures`. `capture` test (348 lines), `replay-fixtures.contract` test, and the capture-and-replay section of `docs/contributing/testing.md`. Its header-name and URL redaction rules are worth reading when `history/redact.ts` is folded |
| `src/execution/` | It is the orchestration of the normalized commands | Every normalized command, `--agent` and batch. `result-cache` test and most of `history` and `quota-failover`. `docs/components/execution-backends.md` |
| `logging/usage.ts` | The gateway needs `safeKeyRef` only. `UsageLogger` writes the legacy usage log, which the ledger replaces for gateway calls | Removing the file outright breaks the gateway and `keypool.ts`. `UsageLogger` is used by `fanout.ts`, `tools/substrate.ts` and `status.ts` |
| `src/http.ts` | Its callers are the adapters, `tool call`, the agent LLM client and the CLI's error printing | Everything that calls a provider outside the gateway. `http-retry` and `http-errors.contract` tests. Its nine error categories go with it; the ledger's four classes (`quota`, `auth`, `upstream`, `gateway`) do not tell config, network and rate-limit failures apart, which the Fail Visible pillar asks for |
| `src/providers.ts` | It is the registry of the adapters | Every normalized command; `npm run test:docs` (see `src/registry/`) |
| `src/status.ts` | It summarizes logs and pools the gateway does not write or use | `coldsearch status`, `config doctor`. `status` test (434 lines). After removal there is no command-line view of gateway use: `coldsearch_status` is reachable only by an MCP client |
| `src/cli.ts` | The entry point stays; most of its 1,971 lines parse and run the legacy commands | Shrinking it removes the commands above. `cli-integration`, `cli-batch`, `cli-intent`, `cache-cli` and `history-cli` tests run it as a child process |
| `src/config.ts`, `src/types.ts`, `src/app.ts`, `src/index.ts` | The gateway loads or is exported through them | Shrinking `index.ts` removes exports from the package's `main`. Whether anything outside this repository imports them was not checked |

## Things outside `src/` a removal change must also touch

- `scripts/validate-docs.mjs` requires nine files under `plans/`, the
  provider pass-through evidence under `plans/evidence/`, and one exact row in
  `docs/architecture.md`. It imports `scripts/provider-pass-through.mjs`.
- `scripts/provider-pass-through.mjs` (2,296 lines) and `scripts/smoke.mjs`
  (363 lines) run the legacy commands through `dist/cli.js`.
  `.github/workflows/canary.yml` runs the smoke script daily. Three test files
  (1,548 lines) test these scripts.
- `package.json`: `test:docs` runs the capability-matrix test, and the `test`
  script includes `test/adapters/*.test.mjs`.
- Documents that describe only the legacy surface: `docs/PROVIDERS.md`,
  `docs/CONFIGURATION.md`, most of `docs/KEY_MANAGEMENT.md`, three of the four
  files in `docs/components/`, `docs/contributing/adding-a-provider.md`, most
  of `docs/contributing/testing.md`, the README outside its gateway section,
  and the `[capabilities]` and `[providers]` sections of the three example
  config files.
- `README.md` still says ColdSearch "is not aiming at MCP as the long-term
  interface". That sentence contradicts ADR 006 today, before any removal.

## A workable order

This order follows the import graph, so each step removes modules together
with everything that imports them. It has not been tried.

1. Decide the fate of Brave, Serper, Jina and SearXNG, and whether batch is
   still wanted. Both change what is safe to delete.
2. Fold: move secret resolution, `safeKeyRef`, the SSRF checks and
   `history/redact.ts` into gateway modules. The gateway then depends on
   nothing under `engine/`, `logging/`, `agent/` or `history/`.
3. Remove agent mode and batch. Nothing else imports them except `cli.ts`,
   `status.ts`, `index.ts` and one type in `types.ts`.
4. Remove the normalized commands together: `execution/`,
   `engine/fanout.ts`, `reranker.ts`, `dispatch/`, `adapters/` and
   `providers.ts`. They import each other and cannot go one at a time.
   `test:docs`, the docs validator and the canary depend on them and change
   in the same step.
5. Remove `tool call` and the registry: `tools/`, `registry/`, then what only
   they still used: `cache/`, the rest of `history/`, `contracts/`, `http.ts`
   and `testing/`.
6. Shrink `cli.ts`, `status.ts`, `types.ts`, `index.ts` and the documents
   listed above.

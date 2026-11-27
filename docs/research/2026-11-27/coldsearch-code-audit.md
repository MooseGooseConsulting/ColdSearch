# ColdSearch — code audit against its own goals (2026-11-27)

Date researched: 2026-11-27, at commit `959385c` on `main`.
This is a dated evidence snapshot from a read-only review of `src/`, `test/`, CI and docs, plus a short set of live runs. It does not override `docs/NORTH_STAR.md` or `docs/architecture.md`.
Not covered: latency of the `doppler:` key path, and whether Firecrawl's per-result markdown scrape inflates credit use.

## Q1: Is it deployable right now?

**Verdict: no, not as an unattended tool for several agents on several hosts.** It works when one operator has hand-written the config. On a fresh host it fails often, and the `doppler:` key path has had no live key-backed testing in CI.

### Install and invoke

- The only entry point is the npm `bin` (`coldsearch`/`usearch` → `dist/cli.js`, `package.json:7-10`).
- There is no `prepare` script and `dist/` is gitignored, so `npm i -g <git-url>` installs a package with no CLI. The only working path is clone, `npm ci`, `npm run build`, then `npm link`.
- No container for the CLI (`docker/` holds only SearXNG). No MCP server, HTTP server or daemon exists in `src/`; `docs/architecture.md` lists them as "Planned".
- `engines` says `node >=22.23.5`, which npm does not enforce, while CI tests only Node 26 (`.github/workflows/ci.yml:24`).
- The host needs the `doppler` CLI on PATH, authenticated, plus a config at `~/.config/coldsearch/config.toml` (legacy `~/.config/usearch/`, `src/config.ts:28-44`). No environment variable can point at a config file.

### Host with no config

- Every command throws "Config file not found … Create one" (`src/config.ts:66-73`). The error is visible.
- `config init` writes empty pools (`src/config.ts:165-175`), so the next search fails with "No providers configured for search" (`src/providers.ts:171`).
- No zero-config path exists.

### Path of `coldsearch search "q"`

1. `main` (`src/cli.ts:1878`) → `runFanoutMode` (`src/cli.ts:726`) → `LocalExecutionBackend` (`src/execution/backend.ts:271`). This loads the config again and builds a `FanoutEngine` with a new `KeyPoolManager` (`src/engine/fanout.ts:217`).
2. Intent resolution (`backend.ts:491`), then an exact-key cache lookup (`backend.ts:515`). A hit returns with zero subprocess spawns.
3. `resolveCapabilityProviders` picks one provider at random (`src/providers.ts:212-224`).
4. `searchProvider` (`fanout.ts:1070`) resolves one key, calls the adapter, checks the result shape, and writes a usage line.
5. RRF merge (`fanout.ts:443`), a history append (`backend.ts:549`), then a cache write.

### Where it breaks on a fresh machine

- **Doppler.** The call is `doppler secrets get NAME --plain` with no `--project`/`--config`/`cwd` (`src/engine/keypool.ts:199-206`). Resolution therefore depends on Doppler's directory scope or `DOPPLER_*` environment in whatever repository the caller happens to be in. stderr is discarded and replaced with a fixed "Ensure Doppler is authenticated" message (`keypool.ts:213`), so an auth failure cannot be told apart from a missing secret or the wrong project.
- **Example config placeholder.** `config.example.toml` puts SearXNG in the search pool with `baseUrl = "https://search.example.internal"`. See defect 1.
- **POST requests get zero retries and a 10-second timeout.** No adapter sets `allowNonIdempotentRetries` (`src/http.ts:24,188-190`). That covers Tavily, Exa, Serper, Firecrawl and Bright Data. Firecrawl search also scrapes markdown for every result (`src/adapters/firecrawl.ts:173-178`) inside that 10 seconds.

### Overhead per call

- `resolveAllSecrets()` is called only from batch (`src/batch/runner.ts:348`). Search, extract and crawl redact using the secrets they actually used.
- Subprocess spawns by mode (with `doppler:` refs):
  - **random (default):** 1 spawn, or 0 if the pick is keyless (SearXNG, Jina), plus 1 for each quota-fallback provider tried.
  - **`strategy = "all"`:** 1 spawn per keyed provider, in parallel.
  - **`tool call`:** a new `KeyPoolManager` every time (`src/tools/substrate.ts:291`), so 1 spawn per call even inside batch.
  - **batch:** a separate pool (`runner.ts:336-352`) re-walks every configured ref after each append, including providers that are in no pool.
- For a one-shot CLI process the in-memory secret cache does nothing beyond merging concurrent lookups of the same name. It pays off only in agent mode.

### What each adapter calls

| Provider | Request |
|---|---|
| Tavily | POST `api.tavily.com/search`, `/extract`, `/crawl` (Bearer; `search_depth`, `max_results` ≤ 20, `include_raw_content`, `time_range`; crawl `limit`/`max_depth`, 120 s) |
| Exa | POST `api.exa.ai/search` (`type`, `numResults`, `contents.text`/`highlights`, `maxAgeHours`), `/contents`, `/findSimilar` (`x-api-key`). "crawl" is search + contents with `includeDomains`, not a crawler (`src/adapters/exa.ts:300-365`) |
| Firecrawl | `api.firecrawl.dev/v2`: `/search`, `/scrape`, `/crawl` plus GET `/crawl/{id}` (30 polls × 2 s) |
| Brave | GET `/res/v1/web/search` (`count` ≤ 20, `safesearch`) |
| Serper | POST `google.serper.dev/search` (`num`, `location`) |
| Jina | GET `r.jina.ai/<url>` with `X-Return-Format`; no key |
| SearXNG | GET `<baseUrl>/search?format=json` |
| Bright Data | POST `api.brightdata.com/request` (zones) |

Against the vendor snapshots in this folder: Exa has deprecated `/findSimilar`, and Firecrawl removes `/extract` on 2026-12-10 (catalogued here as `firecrawl.extract`, status "available").

### Agent mode (`--agent`, `src/agent/*`)

- A ReAct loop that parses JSON out of message text; it does not use native tool calls (`src/agent/agent.ts:226-311`).
- Tools are search (via the backend), raw HTTP fetch, and refine.
- The default LLM is Isoquant `glm-5.3-flash`, key `doppler:ISOQUANT_API_KEY` (`src/agent/llm.ts:119-123,254`). It is not usable without that key or a `--llm` override.
- Fetch pins the resolved IP against SSRF but bypasses extract providers, cache, history and usage logging (`agent.ts:329-420`).

### Stubbed, dead, or claimed but missing

- `runId` is a type field only (`src/logging/usage.ts:12`) and is never set.
- 19 of 54 tool profiles are "deferred/unverified".
- The `structured-extraction` intent always rejects (`src/dispatch/intents.ts:82-89`). The `answer`, `research` and `url-discovery-map` intents have no capability command.
- `docs/architecture.md` says batch is "Planned"; it is implemented.
- `docs/follow-ups/` holds unfiled drafts.

### CI

- `ci.yml` runs typecheck, docs-drift and `npm test` on Node 26, with mocked fetch.
- The canary has no keyed secrets. Its last run shows 1 pass (keyless Jina), 9 skipped and 41 rows "not covered", and it is designed to stay green with zero secrets. It feeds keys through `env:` refs (`scripts/smoke.mjs:97`), so the `doppler:` path is never exercised.

### Live runs on 2026-11-27

- `npm ci`, `npm run build` and `npm test` all succeed on Node 26.12.
- With a hand-written config and keys injected by `doppler run` as `env:` refs, `search` returned results from Exa, Tavily, Brave and Serper (1.1–2.3 s per call including process start) and `extract` returned content from Firecrawl.
- With a three-key round-robin pool for Tavily and for Exa, every call used the first key (see defect 2).
- Running `npm test` wrote 123 synthetic rows to the real `~/.config/coldsearch/usage.jsonl` and one record to `history.jsonl`. `coldsearch status` then reported a seven-day summary built from those rows (for example a 27% Firecrawl success rate that reflects test fixtures, not real calls).

## Q2: Does it do the designed job?

**Verdict: G1 partly, G3 weakly; G2, G4 and the key/quota goals are mostly unmet.** "Spread requests across available keys and free quotas" is defeated by default behaviour.

### Key pool

- Rotation is random or round-robin over a static list (`src/engine/keypool.ts:95-105`). Round-robin is the default.
- `register()` resets the index to 0 (`keypool.ts:74-77`) and every process builds a new pool, so every CLI invocation uses `keys[0]`.
- Nothing tracks remaining quota, per-key spend, or exhausted keys across runs, and no adapter calls a usage or account endpoint.
- Quota recovery:
  - fires only on HTTP 402/432/433; a 429 is classified "rate_limit" (`src/http.ts:59-73, 400-431`);
  - moves to the next *provider*, never the next key (`fanout.ts:356-367`; one key per attempt at `fanout.ts:1079`);
  - keeps no state between runs.

### Routing

- A uniform random pick over the configured pool (`src/providers.ts:215`). Nothing weighs quality, cost or task type.
- Intents (`src/dispatch/intents.ts:55-108`) only narrow the pool with feature filters: `content-backed-retrieval` requires `integratedContent`, `url-similarity` forces Exa.

### Fanout and RRF

- Reachable only with `strategy = "all"` in the config. The example config uses random everywhere.
- Under random, even `--providers a,b,c` picks one (`providers.ts:212`), and there is no per-call fanout flag.

### G2 (compare providers)

- Under `all`, history keeps per-provider partitions (`backend.ts:565`) and `history show --by-provider` displays them.
- There is no compare command and no effectiveness metric. RRF assigns `source` from whichever raw score is highest, but those scores are on different scales.

### G3 (searchable memory)

- One unbounded `~/.config/coldsearch/history.jsonl` per host, holding full extract and crawl content, read in full for every query (`src/history/store.ts:101-128`).
- `history search` is a manual substring scan. Nothing consults history before paying a provider; only the exact cache key does.
- Nothing is shared across machines.

### G4 (provider detail)

- `NormalizedResult` has 5 fields (`src/types.ts:5-11`), and `raw_available: false` is hard-coded (`backend.ts:534,568`).
- Raw output survives only on `tool call`.

### Usage log as a dashboard source

- Format is JSONL `{timestamp, provider, capability, key ref, success, response_time_ms, error, quota_exhausted}` (`src/logging/usage.ts:6-26`). Writes are best-effort and failures are swallowed (`usage.ts:74`).
- Cache hits are not logged.
- Cost appears only on the Bright Data tool path (`src/tools/substrate.ts:195-210`). Exa's `costDollars` is typed (`src/adapters/exa.ts:57`) and dropped; Firecrawl's `creditsUsed` is not captured.
- `status` reports only calls and successes per provider for the last 7 days (`src/status.ts:76-130`).
- That supports call counts per provider, key ref and day on one host. It does not support credits remaining or a cross-host view.

### Provider-tool surface

- 54 catalogued profiles: 15 wired, 16 direct, 4 available, 19 deferred.
- `tool call` forwards any non-hard-excluded path, even uncatalogued ones such as `https://api.exa.ai/${tool}` (`substrate.ts:376-378`). It returns raw output and writes history and usage.

### Size

- `src/`: 16,679 lines across 52 files.
- `test/`: 14,714 lines of `.mjs`.
- Process, docs and plans files: about 112, roughly 2.2 per source file.

## Top defects

1. **A single bad provider fails about 1/N of all calls.** Under random routing, any non-quota error ends the loop (`fanout.ts:364-366`; extract at `:574`): DNS, 401, Doppler failure, timeout, 5xx. POST requests get no retries on top of that. Scenario: copy the example config; SearXNG's placeholder host is picked 1 time in 5, and that search exits 1 even though four healthy providers were available.
2. **Round-robin always uses the first key.** The index resets every process (`keypool.ts:74-77`; `fanout.ts:217`). Scenario: a three-key pool with the default strategy burns key 1 to zero while keys 2 and 3 are never touched by CLI calls. Confirmed live.
3. **No per-key failover or exhaustion memory.** Scenario: key 1 returns a quota error and the call jumps to another provider; key 2 of the same provider is never tried. With `strategy = "random"`, a dead key keeps being picked.
4. **Doppler lookup depends on the caller's directory and hides the real error.** No project or config is pinned (`keypool.ts:199-215`).
5. **Lossy, unbounded, per-host persistence.** Capability calls drop raw output (`backend.ts:534,568`). `history.jsonl` and `usage.jsonl` never rotate and are read in full by `history` commands.
6. **The test suite writes to the operator's real usage log and history.** Confirmed live; see "Live runs".

## Worth keeping

- Redaction discipline: secrets are non-enumerable on errors (`fanout.ts:180-190`), history is written 0600, and TOML errors are sanitized (`config.ts:52-55`).
- Agent fetch pins the resolved IP against SSRF (`agent.ts:344-420`).
- Atomic tmp + rename cache writes, with a clear separation between cache and history.
- Error categories (credentials, quota, rate_limit, config) are printed next to the original message (`http.ts:400-585`).
- Each attempt records provider, tool, native endpoint, key ref and duration.
- The adapters are small, readable and contract-tested against fixtures.

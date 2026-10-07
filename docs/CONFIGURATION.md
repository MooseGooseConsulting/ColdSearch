# Configuration Reference

ColdSearch is configured via a TOML file at `~/.config/coldsearch/config.toml`.

You can override the path with `--config`.

## Overview

The config has three major parts:

- **Capability routing**: maps `search` / `extract` / `crawl` to provider pools
- **Provider configuration**: secrets and provider-specific options
- **Operational logging**: optional usage logging output path

Plus three operator-facing commands:

- `coldsearch config init` — write a starter config (refuses to overwrite)
- `coldsearch config doctor` — local diagnostics over the config file
- `coldsearch status` — configured providers, paths, and provider-tool coverage

## Config commands

### `coldsearch config init`

Writes a starter config and refuses to overwrite an existing one:

```bash
coldsearch config init                 # ~/.config/coldsearch/config.toml
coldsearch config init --config ./config.toml
```

The starter is a valid, doctor-clean baseline with empty provider pools;
fill in providers, key references, and options from this document.

### `coldsearch config doctor`

Local-only diagnostics over the effective config file. It checks TOML
parseability, required sections, provider names, capability compatibility,
key references, and the SearXNG base URL. It **never** contacts provider
APIs, **never** consumes provider credits, **never** resolves `doppler:`
references (syntax/presence only), and the SearXNG base URL check is
presence/format only — not a liveness probe. Secret values are never printed.

```bash
coldsearch config doctor               # human-readable
coldsearch config doctor --json        # machine-readable
```

JSON output:

```json
{
  "command": "config doctor",
  "config_path": "/home/you/.config/coldsearch/config.toml",
  "valid": true,
  "errors": [],
  "warnings": [
    { "category": "credentials", "message": "Provider 'brave' references unset environment variable BRAVE_API_KEY" }
  ]
}
```

`errors` are structural problems (exit code 1); `warnings` are operational
gaps such as unset `env:` variables or unpopulated pools (exit code 0 for a
structurally valid config). Categories follow the error classification:

- `config` — TOML / schema / structure
- `credentials` — key references and env-var presence
- `network` — transport problems (never triggered by doctor)
- `provider` — provider-level configuration (e.g. SearXNG base URL)
- `unsupported_capability` — a capability no configured provider can back
- `unsupported_tool` — provider-tool surface gaps (reported by status)

## Status output

`coldsearch status [--json]` reports local operator state without any
provider calls. JSON fields:

- `config_path` — effective config file path
- `capabilities` — per-capability provider pools and strategy
- `key_pools` — key count and strategy per configured provider
- `cache` — `enabled` flag and on-disk replay-cache path
- `usage_log` — usage JSONL path (see Operational logging)
- `recent_usage_summary_7d` — last-7-days per-provider call/success summary
- `missing_env_vars` — `env:` key references whose variable is not set, including `[agent.llm].key_ref`
- `provider_capabilities` — adapter-backed capability surface per registered
  provider, with a `configured` flag
- `tool_coverage` — provider-tool registry state: counts of tool profiles by
  wiring status (`wired` / `direct` / `available` / `deferred`), per-provider
  breakdown, and the full profile listing

`tool_coverage` is registry state only — it is **not** live provider health
and no provider is contacted. Key references are reported as counts, never
resolved or printed.

## Capability routing

```toml
[capabilities.search]
providers = ["searxng", "tavily", "exa", "brave", "serper"]
strategy = "random"

[capabilities.extract]
providers = ["tavily", "exa", "jina", "firecrawl"]
strategy = "random"

[capabilities.crawl]
providers = ["tavily", "firecrawl", "exa"]
strategy = "random"
```

- `providers`: ordered list of providers eligible for the capability
- `strategy`:
  - `random`: pick exactly one provider per request
  - `all`: fan out to all configured providers

## Provider configuration

Each provider appears under `[providers.<name>]`.

### Key pool shape

```toml
[providers.tavily.keyPool]
strategy = "random"
```

That minimal shape works when ColdSearch knows the provider’s default secret name.

When `keyPool.keys` is omitted or empty, ColdSearch resolves secrets in this order:

1. `defaultSecretName`, if set
2. provider default secret name, if known

Override a single secret name like this:

```toml
[providers.brave.keyPool]
defaultSecretName = "BRAVE_SEARCH_API_KEY"
```

Use explicit keys only when you need multiple secrets and rotation:

```toml
[providers.tavily.keyPool]
keys = ["doppler:TAVILY_API_KEY_1", "doppler:TAVILY_API_KEY_2"]
strategy = "random"
```

Supported explicit key reference formats:

- `doppler:SECRET_NAME`
- `env:VAR_NAME`
- raw literal (discouraged)

## Provider default secret names

Verified from official docs:

- Tavily → `TAVILY_API_KEY`
- Exa → `EXA_API_KEY`
- Firecrawl → `FIRECRAWL_API_KEY`

Practical defaults used by ColdSearch:

- Brave → `BRAVE_API_KEY`
- Serper → `SERPER_API_KEY`

## SearXNG options

```toml
[providers.searxng.options]
baseUrl = "https://search.example.internal"
```

Environment fallback: `SEARXNG_BASE_URL`.

## Doppler authentication

ColdSearch uses the Doppler CLI for secret retrieval.

### Development

```bash
doppler login
doppler run -- coldsearch search "query"
```

### CI / production

```bash
doppler run --token="$DOPPLER_TOKEN" -- coldsearch search "query"
```

## Operational logging

ColdSearch logs a JSONL entry after every adapter invocation.

Default path: `~/.config/coldsearch/usage.jsonl`

```toml
[logging.usage]
path = "~/.config/coldsearch/usage.jsonl"
```

Each entry contains:

- `timestamp`
- `provider`
- `capability`
- `key` (safe identifier)
- `success`
- `response_time_ms`
- `error`, when present

## Result cache

Read-through exact-replay cache for `search` / `extract` and for provider
tools with an explicit replay-safe policy. On by default; a hit serves the
stored response without calling any provider.

```toml
[cache]
enabled = true
search_ttl = "6h"
extract_ttl = "24h"
tool_ttl = "6h"
# path = "~/.config/coldsearch/cache"
```

- `enabled`: set to `false` to disable the cache entirely
- `search_ttl` / `extract_ttl` / `tool_ttl`: freshness windows (`s`/`m`/`h`/`d`
  suffix or bare seconds). `tool_ttl` applies to explicitly replay-safe
  provider tools only.
- `path`: storage directory (default `~/.config/coldsearch/cache`)

Per-invocation overrides:

- `--no-cache` bypasses the cache for that call
- `--freshness <duration>` overrides the TTL for that invocation only; it
  neither persists nor changes the configured defaults. Applies to `search`,
  `extract`, and replay-safe provider tools.

Maintenance:

- `coldsearch cache stats` describes replay-cache storage
- `coldsearch cache clear` deletes replay-cache entries (history is kept)

Crawl results are never replay-cached; crawls are recorded in history only.

## Execution history

Every `search` / `extract` / `crawl` / `tool call` invocation is recorded as
one top-level execution record in a local JSONL history — including cache
replays, partial successes, and failures.

Default path: `~/.config/coldsearch/history.jsonl`

```toml
[history]
path = "~/.config/coldsearch/history.jsonl"
```

History is independent of the replay cache: cache expiry and `cache clear`
never erase it, and `history clear` never touches the cache.

Commands:

- `coldsearch history recent [--limit N] [--json]` — newest executions first
- `coldsearch history search <query> [--limit N] [--json]` — local-only search
  over prior executions (requests, result titles/URLs, content, provider
  metadata); makes zero provider calls
- `coldsearch history show <execution-id> [--json]` — full record of one
  execution; `--by-provider` shows stored fanout partitions and the merged
  result
- `coldsearch history clear --all [--json]` — explicitly delete all history
  (requires `--all`; replay cache is untouched)

Records are scrubbed before persistence: resolved credential values, signed-URL
tokens, and credential fields are redacted from inputs, options, results, and
provider-supplied raw detail.

## Batch execution

`coldsearch batch` runs `search` / `extract` / `crawl` / provider-tool records
from a JSONL input file, writing one JSONL output line per processed record.

```bash
coldsearch batch --input queries.jsonl --output results.jsonl --concurrency 4
coldsearch batch --input queries.jsonl --output results.jsonl --concurrency 4 --retry-errors
coldsearch batch --input queries.jsonl --output results.jsonl --dry-run --json
```

Flags:

- `--input FILE` — input JSONL of batch records (required)
- `--output FILE` — output JSONL, appended in completion order (required)
- `--concurrency N` — maximum concurrent items (default: `1`)
- `--retry-errors` — retry records that errored in a prior run
- `--dry-run` — report the planned records without executing or writing
- `--json` — print the run summary as JSON on stdout

Behavior:

- Every item executes through the same backend / tool substrate as the
  standalone command, so routing, cache, and execution-history behavior are
  identical; batch does not create a second history model.
- The output file is append-only. Reruns resume by stable `id`: existing
  success records are skipped, existing error records are retried only with
  `--retry-errors`.
- Resume is keyed on `id` only: if you change an item's input, give it a new
  `id` or it will be skipped as already-succeeded.
- Batch items are configured per-record; the global `--limit`, `--providers`,
  `--no-cache`, and `--freshness` flags do not apply to `batch`.
- Duplicate `id`s resolve to the first occurrence: identical later records are
  skipped; later records with different input emit a visible
  `DUPLICATE_ID_CONFLICT` error record that is never retried.
- A failing item never aborts unrelated items; the run completes and exits
  non-zero when any executed item failed.

## Agent LLM

Agent mode (`--agent`) uses an OpenAI-compatible chat completions endpoint.
The endpoint can be configured in three layers, in precedence order:

1. CLI flags: `--llm` / `--model` / `--llm-base-url` / `--llm-key-ref` / `--reasoning-effort`
2. TOML `[agent.llm]`
3. Environment fallback and code defaults

Provider selection keeps endpoint settings isolated. When `--llm` selects a
provider different from `[agent.llm].provider`, that TOML provider's model,
base URL, key reference, and reasoning effort are discarded. An omitted TOML
provider is treated as the default Isoquant provider. Explicit CLI values still
apply to the selected provider; for example, `--llm openrouter --llm-base-url
http://localhost:9000/v1 --llm-key-ref env:OPENROUTER_API_KEY` uses that endpoint
and credential while ignoring Isoquant-specific TOML settings. When the
provider matches, unset CLI fields continue to inherit field by field from
TOML.

```toml
[agent.llm]
provider = "isoquant"
model = "glm-5.3-flash"
base_url = "https://api.isoquant.ai/v1"
reasoning_effort = "medium"
key_ref = "doppler:ISOQUANT_API_KEY"
```

Environment fallbacks: `OPENAI_API_KEY` (and provider-specific keys such as
`GROQ_API_KEY`). `OPENAI_BASE_URL` overrides the base URL for
`provider = "openai"`; a TOML/CLI `base_url` can override an alias provider's
base URL when needed for a compatible gateway.

This is separate from provider key resolution in `config.toml`. Use
`--llm-key-ref env:NAME` or `--llm-key-ref doppler:NAME` when an invocation
needs to supply an explicit credential reference.


### Isoquant production and free-router testing

Agent mode now defaults to Isoquant `glm-5.3-flash` with `medium` reasoning.
The client sends `reasoning_effort: "medium"` to Isoquant on every completion,
including synthesis; `--reasoning-effort` overrides the TOML setting. Isoquant's
accessible API sample confirms the endpoint/model but does not document effort
semantics. The paid conformance check verifies an actual request completes;
confirm effective medium behavior from the provider rather than equating HTTP
success with proof the setting was honored.

ColdSearch accepts `none`, `low`, `medium`, `high`, and `max` for Isoquant. OpenRouter's
current [`reasoning.effort` documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
lists `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, and `none`. ColdSearch
passes these values through unchanged; model-specific support can still vary.

`key_ref` accepts `env:NAME` with a shell-compatible variable name, or
`doppler:NAME`. Doppler references accept its documented [Permissive secret
names](https://docs.doppler.com/docs/secrets#permissive-naming):
characters (`A-Z`, `a-z`, digits, `_`, `/`, `:`, `.`, and `-`; up to 200
characters), subject to Doppler's reserved-name restrictions. This permits
references such as `doppler:project/isoquant.api-key` without allowing a
literal credential. `ISOQUANT_API_KEY` is the
proposed standard name, not a discovered secret in the operator's Doppler.
Set `key_ref` to the actual name once located. Doppler references first use the
matching injected environment variable, otherwise the existing Doppler CLI
resolver. No secret values belong in TOML.

For routine live tests use a separate test config with:

```toml
[agent.llm]
provider = "openrouter"
model = "openrouter/free"
key_ref = "env:OPENROUTER_API_KEY"
```

OpenRouter uses `reasoning: { effort: ... }` when effort is explicitly set;
free-router tests leave effort unset because available free models differ.
The search/extract/crawl pools remain independent of the synthesis LLM.

Two full, ready-to-copy configurations preserve the standard search/extract/
crawl pools and differ only in their active agent endpoint:

- [`config.isoquant.example.toml`](../config.isoquant.example.toml) selects Isoquant
  GLM 5.3 Flash at medium reasoning and references `doppler:ISOQUANT_API_KEY`.
  That is a proposed secret name; replace it if the existing Doppler secret uses
  another name.
- [`config.openrouter-free.example.toml`](../config.openrouter-free.example.toml)
  selects `openrouter/free` and reads `OPENROUTER_API_KEY` from the environment.

Copy exactly one preset to the normal config path. The Isoquant preset can use a
Doppler login or a Doppler service token; the OpenRouter preset works with
`OPENROUTER_API_KEY` directly or injected by Doppler under that same environment
name:

```sh
mkdir -p ~/.config/coldsearch
cp config.isoquant.example.toml ~/.config/coldsearch/config.toml
doppler run -- coldsearch --agent "Compare recent browser automation tools"

# For a test run, replace the config with the separate free-router preset:
cp config.openrouter-free.example.toml ~/.config/coldsearch/config.toml
doppler run -- coldsearch --agent "Compare recent browser automation tools"
```

Do not paste credentials into either TOML file. Use a local environment
variable, Doppler injection, or a scoped GitHub Actions secret.

The scheduled canary uses OpenRouter free. Manual dispatch can additionally
select `isoquant_conformance` to test the paid production endpoint. CI may use
either a scoped GitHub Actions `DOPPLER_TOKEN` secret (Doppler injects API keys),
or direct Actions secrets `OPENROUTER_API_KEY` and `ISOQUANT_API_KEY`. The
Doppler token is exposed only to the live smoke step, never dependency
installation or builds. Both credential options may
coexist; Doppler values take precedence when injected. These are Actions
secrets, not GitHub App credentials. Never install real provider secrets into
pull-request workflows that execute untrusted code.

Update deployed TOML/CLI wrappers that set `xai` or a Grok model to the Isoquant
production config above; editing this repository alone cannot modify existing
operator config files. The supported xAI compatibility path now selects the
documented `grok-4.3` model when explicitly requested; agent mode's default and
the routine test path use Isoquant and OpenRouter free, respectively.

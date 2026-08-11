# Testing

## Commands

```bash
npm test          # build + full suite (dot reporter — failures still verbose)
npm run test:docs # matrix + provider doc drift only
npm run typecheck
```

## What belongs in tests

**Keep** tests that would catch a real regression:

- Routing (`FanoutEngine`: random vs all, sequential extract/crawl)
- Security (agent SSRF, capability validation)
- Doc/registry/matrix drift (one test per invariant, not three)
- Provider behavior that is non-obvious (multi-step crawl, URL building, parsing)

**Avoid** tests that only replay the mock:

- Mock returns field X → assert field X (per-provider copy-paste)
- Registry string equals adapter string when both are hand-maintained duplicates
- “Display name appears in markdown” without table semantics

Prefer **contract tests** under `test/adapters/*contract*.test.mjs` for shared shapes; keep provider files for quirks only.

## Three distinct evidence activities

Do not collapse these into “testing”:

| Activity | Purpose | When it runs | Merge gate? |
|---|---|---|---|
| Unit/contract tests | Detect behavioral regressions | Every PR through normal CI | Yes |
| Live provider conformance | Verify an affected real integration still works | Scheduled canary plus scoped manual runs for provider-facing changes | No |
| Search evaluation/exploration | Learn which prior search, result, or provider was useful | Human/agent exploration of accumulated executions | No |

**Provider-effectiveness evaluation is observational and exploratory.** Do not run paid provider comparisons or benchmark workloads as routine validation after code changes. Do not add them to `npm test`, merge gates, default agent completion checklists, or general PR validation. Use accumulated real executions for analysis. Run deliberate comparative evaluation only when the task specifically concerns provider selection, routing quality, search effectiveness, or a suspected provider regression.

**Live conformance is integration-scoped.** Do not run the full live-provider matrix after unrelated changes. Run the relevant provider/path manually when modifying provider adapters, HTTP/request behavior, authentication, normalization, tool dispatch, or provider-facing routing; otherwise rely on scheduled coverage. Native-vs-ColdSearch comparison is conformance evidence, not benchmarking. See the detailed initial [Gate 0 baseline](../../plans/2026-06-23-gate-0-provider-pass-through-proof.md) and the ongoing [Live Provider Conformance plan](../../plans/2026-08-10-live-provider-conformance.md).

### Manual scoped conformance runs

For a provider-facing change, run only the affected rows and write evidence **outside** the committed Gate 0 baseline. The baseline directory (`plans/evidence/2026-06-23-provider-pass-through/`) is protected: a scoped run must pass `--out-dir` pointing elsewhere, and only a deliberate `--all --overwrite-baseline` full-matrix run may write there.

```bash
npm run build
# one capability path
node scripts/provider-pass-through.mjs --provider <provider> --path <path> \
  --out-dir /tmp/coldsearch-conformance-<provider>-<path>
# one catalogued provider tool (runs through the `tool call` CLI path)
node scripts/provider-pass-through.mjs --provider tavily --tool map \
  --out-dir /tmp/coldsearch-conformance-tavily-map
node scripts/provider-pass-through.mjs --provider brave --tool webSearch \
  --out-dir /tmp/coldsearch-conformance-brave-websearch
```

The harness emits one machine-readable row per selected row into `results.jsonl` plus a coverage `summary.md`. Supported rows a scoped selection did not include are listed as `not_run` — never counted as passes. Every row is exactly one of `pass`, `fail`, `blocked_missing_secret`, `blocked_provider`, `not_run`, `waived_by_user`. Use `--list` to enumerate the full matrix (paths and tools), `--tool NAME` (optionally with `--provider`) for a tool row, and `--waive <provider:path|provider.tool>` to mark a specific row waived. `--all` remains the deliberate full-matrix baseline selection.

## Logging / CI output

- Default reporter is **`dot`** (quiet pass, detailed fail).
- Do not add `console.log` in tests; use assertions.
- Production usage logging is separate (`src/logging/usage.ts`, JSONL).

## Adding a provider

1. Adapter + registry + matrix + provider doc
2. Extend `search-normalize.contract.test.mjs` if it implements `search`
3. Add a **provider-specific** test file only for non-shared behavior (crawl polling, URL paths, etc.)

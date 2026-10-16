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

## Logging / CI output

- Default reporter is **`dot`** (quiet pass, detailed fail).
- Do not add `console.log` in tests; use assertions.
- Production usage logging is separate (`src/logging/usage.ts`, JSONL).

## Capture-and-replay of real provider envelopes (test proof layer 2)

Issue #79 defines a three-layer test proof: (1) request shape, (2) provider
contract envelopes, (3) normalized results. Layers 1 and 3 are covered by the
hermetic mock tests. Layer 2 needs the REAL wire shapes: `src/testing/capture.ts`
records them and `src/testing/replay.ts` plays them back through adapter
normalization and `classifyError`.

### Capturing (keyed operators only, off by default)

```bash
COLDSEARCH_CAPTURE_DIR=./captures coldsearch search "query" --provider firecrawl
```

Every HTTP exchange through `fetchWithPolicy` is appended as one JSON line to
`./captures/capture-<YYYYMMDD-HHMMSS>.jsonl`:
`{ts, label, method, url, requestHeaders, requestBody?, status,
responseHeaders: {content-type, retry-after, x-ratelimit-*},
responseBodyText (64 KiB cap), durationMs, error?, errorName?}`.
`errorName` is `"TypeError"`/`"AbortError"` for transport failures.
Truncated bodies carry suffix markers: `…[truncated at 64 KiB]` for the size
cap and `…[capture prefix incomplete]` when the async read did not finish.
Both success and error exchanges (including timeouts) are recorded. When the
env var is unset the recorder is a no-op with zero overhead beyond one env
lookup, and capture write failures emit a `COLDSEARCH_CAPTURE_WRITE_FAILED`
warning without failing the underlying request.

### Redaction guarantees

A capture line must never contain a secret value:

- `authorization`, `proxy-authorization`, `x-api-key`, and
  `x-subscription-token` header values are always replaced by `REDACTED`, as
  is any header whose name matches `key|token|secret|credential|password|
  cookie` (case-insensitive);
- secret values threaded via `RequestPolicy.secrets` (or registered by tests
  with `setCaptureSecrets`) are redacted wherever they appear in request and
  response headers, URLs, bodies, or error messages, including URL-encoded,
  form-encoded, and JSON-escaped variants;
- well-known credential keys (`api_key`, `access_token`, `jwt`, …) are
  redacted in URLs and bodies even when the concrete secret was never threaded
  through — covering string, numeric, boolean, null, and object/array JSON
  values;
- URL userinfo (`user:pass@host`) credentials are redacted, preserving scheme
  and host.

Still treat capture files as sensitive working artifacts: review them before
sharing, and never commit raw captures.

### Converting captures into fixtures

Fixtures live in `test/fixtures/provider-envelopes/*.json` — one JSON object
per file, the capture-line shape plus `fixtureVersion: 1`, `provider`, and a
`notes` provenance field. To promote a capture line: copy it, add the three
fields, and verify no unredacted secrets remain. `loadFixtures(path)` loads a
file or directory; `replayAdapterTest(adapterMethod, fixtures, installFetchMock)`
plays envelopes through an adapter's normalization path using the standard
`test/adapters/_fetch-mock.mjs` installer, and `fixtureResponse(fixture)`
rebuilds the raw `Response` for error-classification replays. See
`test/adapters/replay-fixtures.contract.test.mjs` for the pattern and
`test/lifecycle.test.mjs` for scripted async-job lifecycle sequences.

## Adding a provider

1. Adapter + registry + matrix + provider doc
2. Extend `search-normalize.contract.test.mjs` if it implements `search`
3. Add a **provider-specific** test file only for non-shared behavior (crawl polling, URL paths, etc.)

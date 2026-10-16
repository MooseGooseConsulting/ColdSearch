# ColdSearch — Live Probe Ledger (2026-10-12)

Bounded keyless probes run from the execution sandbox against live provider
APIs. No credentials used; no paid spend (Firecrawl keyless tier consumed its
own anonymous free credits). One request per probe class, cold.

The probes and captures are dated 2026-10-12, after the initial PR-F commit
on 2026-10-11. This follow-up records that later evidence; it was not available
at the initial PR head.

## Reachability

| Host | Result |
|---|---|
| api.tavily.com | reachable |
| api.exa.ai | reachable |
| google.serper.dev | reachable |
| api.firecrawl.dev | reachable |
| r.jina.ai | **blocked** (sandbox egress timeout) |
| api.search.brave.com | **blocked** (sandbox egress timeout) |
| api.brightdata.co | **blocked** (sandbox egress timeout) |

## Probe results

| Provider | Probe | Result | Ledger entry |
|---|---|---|---|
| Tavily | `POST /search` no key | HTTP 401, body `{"detail":{"error":"Unauthorized: missing or invalid API key."}}` | **live-verified**: error envelope `detail.error` shape confirmed |
| Exa | `POST /search` no key | HTTP **402**, `tag: "X402_PAYMENT_REQUIRED"`, x402 v2 payload (USDC on Base/Solana/WorldChain/Arc; `maxTimeoutSeconds`; free-trial via agentkit "Verify your agent is backed by a real human", 100 uses; x402 capped at `numResults` 10) | **live finding, doc drift**: keyless Exa now sits behind an x402 payment gateway — keyless is NOT a free anonymous tier; it is pay-per-call crypto or agent-verified free trial. Docs + `keyless` claims need reconciliation. 402 handling confirmed live. |
| Serper | `POST /search` no key | HTTP 403, `{"message":"Unauthorized. Sign up for a free account.","statusCode":403}` | **live-verified**: error envelope `message`/`statusCode` confirmed; keyless rejection is 403 (not 401) — classifier must not assume 401-only auth failures |
| Firecrawl | `POST /v2/scrape` no key, `formats:["markdown"]` | HTTP 200, `success:true`, `data.markdown` + `data.metadata.{title,sourceURL,statusCode,creditsUsed,cacheState}` | **upstream live evidence**: keyless tier exists (anonymous, per-IP free credits, `creditsUsed` accounting). This direct probe does not establish keyless ColdSearch runtime support; the configured or built-in Firecrawl key is resolved before the adapter request. Scrape envelope + success-flag discipline confirmed. |
| Firecrawl | `POST /v2/search` no key, `{query, limit:2}` | HTTP 200, `success:true`, `data.web[]{url,title,description,position,category}`, `creditsUsed` | **upstream live evidence**: direct API search envelope matches registry profile (position field, category field); not ColdSearch end-to-end keyless support |
| Firecrawl | `POST /v2/scrape` no key, `formats:["html"]` | HTTP 200, `data.html` returned | **upstream live evidence**: `formats` param honored keyless — validates PR-B direction (adapter format passthrough) against the live contract; not ColdSearch end-to-end keyless support |
| Jina | `GET r.jina.ai/...` | egress blocked | **blocked: sandbox egress** — keyless reader claim unverified from this environment |
| Brave | — | egress blocked | **blocked: sandbox egress** |
| Bright Data | — | egress blocked | **blocked: sandbox egress** |
| SearXNG | — | no public instance in config | **not_run: no instance** — requires a configured instance; keyless-by-design claim structurally sound but unexercised |

## Relationship to committed replay fixtures

The three committed Firecrawl fixtures
(`test/fixtures/provider-envelopes/firecrawl-search-200.json`,
`test/fixtures/provider-envelopes/firecrawl-scrape-markdown-200.json`, and
`test/fixtures/provider-envelopes/firecrawl-scrape-html-200.json`) are synthetic
representative envelopes based on the live probe findings, not captured
exchanges or sanitized capture lines. They provide replay parsing coverage for
the adapter, but they are not layer-2 evidence and must not be cited as live
wire evidence. Raw probe capture files and lines are unavailable in this
repository. In particular, the search fixture uses `limit:10` (the live probe
above used `limit:2`), and the markdown scrape fixture omits the live response's
`statusCode`, `creditsUsed`, and `cacheState` metadata. The ledger records the
reported live probe findings; the fixtures are examples for parser coverage
only.

## Consequences for the stack

1. **PR-B** — Firecrawl live behavior confirms the `formats` passthrough fix
   targets the real contract; `creditsUsed` is available for future
   spend-accounting follow-ups.
2. **PR-C** — classifier needs: 402 → quota/billing (Exa x402, Firecrawl
   credits); 403 → credentials but with provider context (Serper 403 =
   missing key; SearXNG 403 = JSON disabled; plan-gating). Provider identity
   must reach `classifyError` (thread `policy.label` into
   `HTTPRequestError`).
3. **Docs (PR-F)** — audit doc and PROVIDERS.md need an addendum: Exa keyless
   x402 gateway (402 confirmed live 2026-10-12); Firecrawl anonymous keyless
   tier confirmed live; Serper/Tavily error envelopes confirmed.
4. Blocked probes did not advance live-verification markers. Profile schema
   dates record documentation reinspection where performed; they do not imply
   a successful live probe.

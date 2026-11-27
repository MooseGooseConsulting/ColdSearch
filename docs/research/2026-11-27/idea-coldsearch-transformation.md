# ColdSearch — what the repository should become (2026-11-27)

Strategy note: options and one recommendation. No code was changed. It does not override `docs/NORTH_STAR.md`; every place the recommendation crosses the North Star is listed in section 3 and needs the owner's rewrite before work starts.
Inputs: `docs/NORTH_STAR.md`, `docs/architecture.md`, the four other files in this folder, `src/` at `959385c`, and issues #40, #75, #79, #91, #109 (issue text may be agent-written and is treated as background, not as decisions).
Not verified: what each agent harness exposes through hooks or transcripts, and which vendor MCP servers accept being proxied. Both are week-one checks.

## 1. The gap between the design and the code

The North Star does not describe a flattening wrapper. It describes one audited surface over provider-native tools, with key and free-quota spreading, comparison, and memory. That design still fits the owner's current direction. What fails is the implementation and its form factor.

| Design (North Star) | Code today | Gap |
|---|---|---|
| G1: one surface reaches provider-native tools | One-shot CLI; 15 of 54 tool profiles wired; no MCP or HTTP entrypoint; not installed where agents run | Agents cannot reach it. In the recorded research run: 116 native searches, 0 through ColdSearch |
| G1, continued: keep up with vendors | Hand-written REST profiles; Exa `/findSimilar` deprecation and Firecrawl `/extract` removal (2026-12-10) untracked; no Exa Agent/Monitors, Firecrawl Alexandria/indexes/agent/parse/interact, Parallel anything | A hand-maintained catalogue loses to vendors shipping monthly |
| "Spread requests across keys and free quotas" | Round-robin restarts at key 1 every process; no remaining-allowance data; quota failover skips to another provider, never another key | Unmet, and unfixable inside a stateless CLI |
| Audit First | Per-host JSONL, cost fields dropped, no run IDs, test suite pollutes the real log | Sees only its own calls, which are near zero |
| G2: compare effectiveness | Fanout/RRF behind a config switch; no compare command or metric | Unmet |
| G3: searchable memory | Per-host unbounded file, substring scan, never consulted before a paid call | Weak |
| G4: preserve provider detail | 5-field results, `raw_available: false` hard-coded; raw only on `tool call` | Unmet on the default path |

Two things matter more now than in June: an allowance ledger (a rotator cannot work without a meter, and neither Doppler nor LiteLLM provides one), and a memory and audit trail that covers lanes ColdSearch does not own.

## 2. Futures

**A. Retire and archive.**
- Day to day: nothing. Agents use vendor tools; the rotator lives elsewhere.
- Reused: nothing. Deleted: everything; repo archived read-only.
- Effort: S. Risk: the ledger, memory and comparison get rebuilt elsewhere without the redaction and error-taxonomy work already done here. Abandons G1–G4.

**B. Control plane only: ledger + rotator + dashboard.**
- Day to day: a scheduled job polls vendor usage endpoints (Firecrawl `/team/credit-usage`, Parallel `/service/v1/usage` and `/balance`, Exa `/credits` where enabled), writes remaining allowance per account, and the rotator moves the Doppler slot. Operators read a dashboard.
- Reused: `src/logging/usage.ts`, `src/status.ts`, `src/http.ts` error categories, Doppler resolution in `src/engine/keypool.ts`, `src/config.ts`.
- Deleted: adapters, fanout, agent, cache, history, batch, registry.
- Effort: M. Risk: delivers quota spreading only. No per-call audit, no memory, no comparison; the Doppler swap is minutes-slow and blind between polls.

**C. Observation layer.**
- Day to day: harness hooks or transcript readers post every native search-tool call (tool, arguments, result URLs, cost fields) to one shared store; agents call `recall` before searching; operators read per-provider outcome reports.
- Reused: `src/history/*` (types, redaction, search), `src/logging/usage.ts`, `src/testing/capture.ts` redaction, `src/contracts/endpoint-identity.ts`.
- Deleted: adapters, fanout, agent, cache, most of the CLI.
- Effort: M. Risk: one ingester per harness, each brittle; observes but cannot act (no key choice, no fail-visible errors); "which result was useful" needs a signal that transcripts only imply.

**D. Routing skill + evaluation harness.**
- Day to day: agents load a skill saying which vendor tool suits which job; a harness replays a fixed task set and checks whether usage actually splits and answers improve (#91's "can the search change the answer" test).
- Reused: `src/batch/*` as task driver, `src/testing/replay.ts`, history types.
- Deleted: the runtime.
- Effort: M. Risk: a repo of prose and fixtures; evaluations cost live credits and decay as vendors change. The guidance itself is another designer's job.

**E. Thin direct-API CLI for what native tools lack.**
- Day to day: scripts and cron run `coldsearch batch` and `tool call` over JSONL; agents do not use it.
- Reused: `src/tools/substrate.ts`, `src/registry/*`, `src/batch/*`, `src/http.ts`, keypool.
- Deleted: normalized adapters, fanout, reranker, dispatch, agent, cache.
- Effort: S. Risk: still a hand-maintained REST catalogue, now for a small audience.

**F. Gateway: ColdSearch becomes the MCP endpoint agents actually use.**
- What it is: one MCP server (stdio and HTTP) that fronts the vendors' own MCP servers and passes their tools through unchanged, injecting the key from the canonical Doppler slot and recording every call.
- Day to day: harness configs list one server, `coldsearch`, instead of four vendor entries. Agents call `exa.agent_run`, `firecrawl.scrape`, `parallel.web_research` with vendor-native arguments and get vendor-native results. Each call writes a ledger row and a memory record; a 402 is returned with a clear category and reported to the rotator; `recall` and `usage` are extra tools. New vendor tools appear with no ColdSearch release because the vendor's tool list is proxied, not re-implemented.
- Reused: history, usage log, redaction, error taxonomy, Doppler resolution, config; `tools/substrate.ts` and the profile registry only for REST-only or self-hosted providers (SearXNG, Jina, Bright Data scrapers); `batch/*` as a non-agent client of the same core.
- Deleted: normalized adapters' search/extract/crawl paths, fanout, reranker, dispatch intents, agent mode, exact-replay cache.
- Effort: M for proxy + ledger; L with in-request failover across accounts.
- Risk: adoption, the same failure that sank the CLI. OAuth-hosted connectors, vendor CLIs and vendor skills bypass it. It is a process to keep running and a single point of failure. LiteLLM already offers an MCP gateway with injected keys, though with one credential per server and no allowance awareness.

## 3. Comparison and recommendation

| | G1 one surface | Quota spreading | Audit / ledger | G2 compare | G3 memory | G4 raw detail | Catalogue upkeep | Effort |
|---|---|---|---|---|---|---|---|---|
| A retire | no | elsewhere | no | no | no | n/a | none | S |
| B control plane | no | yes, slow | account-level only | no | no | n/a | usage endpoints | M |
| C observation | no | no | per call, all lanes | observational | yes | as logged | ingesters | M |
| D skill + eval | no | by guidance | no | yes, costly | no | n/a | task set | M |
| E thin CLI | scripts only | no | own calls | no | own calls | yes | high | S |
| F gateway | yes, API-key lanes | yes, fast signal | per call, own lanes | observational | yes | yes | low | M–L |

**Recommendation: F, built on B's ledger, with C as the collector for lanes F cannot front. Keep E's batch runner as a client. Leave D to the routing-guidance designers and feed it data.**

Reasoning:
1. F is the only future that delivers the North Star as written. B and C each deliver a slice and concede G1.
2. Proxying vendor MCP servers removes the cause of drift: ColdSearch stops re-implementing vendor APIs.
3. The gateway needs an allowance meter and so does the rotator; it is one store, so B is F's first milestone, not a rival.
4. The gateway is the rotator's best sensor (402s and per-response cost at call time) without taking over key selection; it reads the canonical slot the rotator sets.
5. The snapshot in this folder says OAuth-hosted MCP is brokered by nothing. C is how those calls still reach the ledger and memory.
6. Kill test: if the week-one census shows most search calls run through OAuth connectors the owner will not replace, F captures little; fall back to B + C and say so in the North Star.

**North Star conflicts this creates (owner rewrite required):**
- G1 and the "one audited ColdSearch surface" anti-goal: OAuth connectors and vendor CLIs/skills stay outside the surface and are audited by observation only.
- "Not blind model-directed routing": with native tool names passed through, the model picks the tool. Control moves to guidance and allowance, not runtime routing.
- "Ask once, let the runtime use multiple provider tools", "normalized common views", and the Comparable Execution pillar: fanout and normalized search/extract/crawl are removed; comparison becomes observational.
- G3 "before paying providers again": becomes an explicit `recall` tool, not an automatic check.
- "Spread requests across free quotas": Parallel's terms prohibit orchestrating usage among multiple accounts, and Exa grants free credit to a user's first team only. Which vendors are in scope for multi-account rotation is the owner's call.
- `docs/architecture.md`: MCP changes from a planned thin wrapper to the product; key pools leave TOML for the Doppler slot; ADRs 001–003 are superseded.

**First week:**
1. Freeze feature work; surface the conflicts above to the owner.
2. Census one week of harness transcripts: calls per lane (OAuth connector, API-key MCP, vendor CLI, built-in). This decides the kill test.
3. Stand up the shared ledger store; write one usage-endpoint poller (Firecrawl) and fix the test suite writing to the real log.
4. Spike the proxy against one vendor's hosted MCP with header key injection; confirm tools pass through and a call lands in the ledger.
5. Confirm what one harness's hooks expose for the collector.

## 4. Keep / delete for the recommendation

| Area | Fate |
|---|---|
| `src/history/*`, `src/logging/usage.ts`, `src/contracts/*` | Keep; move storage from per-host JSONL to the shared store; add cost, account and run ID fields |
| `src/http.ts`, `src/config.ts`, `src/testing/capture.ts`, `src/testing/replay.ts` | Keep |
| `src/engine/keypool.ts` | Keep Doppler resolution only (pin project/config, surface stderr); delete in-process rotation |
| 8 adapters (`src/adapters/*`) | Delete normalized search/extract/crawl. Vendors with an MCP server are proxied; SearXNG, Jina and Bright Data scrapers stay reachable through `tools/substrate.ts` |
| Tool-profile registry (`src/registry/*`) | Shrink to REST-only providers; stop cataloguing tools a vendor MCP already lists |
| `src/engine/fanout.ts`, `reranker.ts`, `src/dispatch/*`, most of `src/execution/backend.ts` | Delete |
| Agent mode (`src/agent/*`) | Delete; harness agents and vendor agent endpoints replace it. The SSRF fetch goes with it |
| Cache (`src/cache/*`) | Delete exact replay; `recall` over history replaces it |
| Batch runner (`src/batch/*`) | Keep as a scripted client of the gateway core |
| `src/cli.ts`, `src/status.ts` | Cut to `serve`, `batch`, `tool call`, `history`, `status` |
| ~112 process/plan/docs files | Delete `plans/`, `docs/follow-ups/`, `docs/reviews/`, `docs/superpowers/`, the BWS stub. Mark ADRs 001–004 superseded; keep 005. Rewrite `architecture.md`, `PROVIDERS.md`, `KEY_MANAGEMENT.md` after the North Star |
| PR #61 (agent run IDs) | Close; run IDs are rebuilt in the ledger |
| PR #113 (SearXNG digest) | Merge |
| #75 | Becomes the lead issue: MCP is the product |
| #79, #72, #99 | Rescope to the REST-only residue or close. #79 carries an owner-confirmed label, so the owner decides |
| #109 | Keep, rescoped: evaluate providers from observed calls |
| #91 | Hand to the routing-guidance work; this repo supplies trajectories |
| #40, #73, #92, #98 | Close |

## 5. Counter-arguments

**Against the recommendation: stay out of the request path (B + C only).** The owner already has a key mechanism (one slot, a rotator), vendors' own plugins bundle skills tuned to their tool names, and every proxy hop adds a failure point. This is the cheaper build and it is the fallback if the census fails the kill test. I do not accept it as the first choice: it gives up G1 and Fail Visible, leaves memory dependent on per-harness ingesters, and leaves the rotator learning of exhaustion minutes late.

**For a heavier wrapper: keep normalization, fanout and cross-vendor failover in the path.** The case is real for non-MCP harnesses, for one-call cross-provider comparison, and for surviving a vendor outage without the agent noticing. I do not accept it. That is the design point that produced 15 of 54 tools and zero adoption; agents holding native tools fail over by choosing another tool; and non-MCP callers are served by `tool call` and batch on the same core.

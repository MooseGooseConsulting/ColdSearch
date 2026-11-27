# ADR 006: The MCP Gateway Is the Surface

**Date:** 2026-11-27
**Status:** Proposed

## Context

The North Star asks for one audited surface that reaches provider-native
tools, spreads requests across keys and free quotas, makes providers
comparable, keeps a searchable memory, and logs first.

The code built before November 2026 is a one-shot CLI that normalizes
`search`, `extract` and `crawl` across provider adapters. Read against those
goals on 2026-11-27, it falls short in ways that come from its form, not from
bugs:

- **Agents cannot connect to it.** It has no server. Each agent has to shell
  out to a CLI that needs a hand-written config on that host.
- **Key rotation restarts on every call.** `KeyPoolManager.register` sets the
  round-robin index to 0, and each CLI process builds a new pool, so a
  multi-key pool always uses its first key. On an out-of-credit error the
  legacy commands move to another provider, never to the same provider's next
  key, and nothing remembers the exhausted key for the next process.
- **Provider detail is dropped on the main path.** A normalized search result
  has five fields, and the execution records written by `search`, `extract`
  and `crawl` set `raw_available: false`.
- **The hand-written catalogue is small and ages.** Of the 54 provider-tool
  profiles in the registry, 15 back a normalized command and 16 are callable
  only through `tool call`; the rest are not implemented. Each profile is
  maintained by hand against the provider's documentation.

The providers' own hosted MCP servers are not a substitute. They expose a
small part of each API: Exa's lists 3 tools and its search takes 3 parameters,
while its API document has 64 operations and its search takes 23
(`docs/components/gateway.md`).

The direction given for this work is a gateway: agents connect to it, it logs
all calls with the full request and response where possible, it exposes all
tools, it holds the curated skills that route work, and it is hosted as a
remote MCP server so that hosted assistants can connect over the web. Tools
come from the providers' APIs because the hosted MCP servers expose too
little. Commodity work such as crawl and map is done by the gateway itself,
not bought.

## Decision

**The MCP gateway is ColdSearch's surface.** New work builds on it. The
pre-gateway CLI commands stay as they are until a separate change removes
them.

1. **One gateway, one endpoint.** `coldsearch mcp` serves MCP over stdio for
   one agent and over streamable HTTP for many. Both transports share one
   core, so keys, failover, filters and the ledger behave the same for every
   client. The target is a hosted remote MCP server.

2. **Tools come from provider API documents first, hosted MCP where there is
   no document.** An `openapi` upstream turns each operation of the provider's
   published OpenAPI document into one tool whose arguments are the provider's
   own parameters. An `mcp` upstream passes a provider's hosted MCP tools
   through unchanged, for providers that publish no API document or for tools
   only their MCP server has. Tools are named `<upstream>__<tool>`. Results
   are returned as the provider sent them. A new operation in a provider's
   document appears without a ColdSearch change.

3. **Ordered key lists with failover.** Each upstream has a `keys` list, which
   is the order keys are drained in. When a call fails because the account is
   out of credit or the key is rejected, the gateway marks that key skipped
   for a cooldown, retries the same call on the next key, and saves the
   skipped set so a restart does not return to an empty key. A rate limit does
   not skip a key. When every key is skipped the call is still attempted.

4. **A full request and response ledger.** Every attempt writes one ledger
   line (upstream, tool, key reference, attempt number, duration, error class,
   cost when the provider reports one) and one payload file holding the
   complete request and response. The key value never reaches disk: the ledger
   holds the reference, and resolved values are redacted from arguments,
   errors and payloads.

5. **Curated skills are served by the gateway.** Each `skills/<name>/SKILL.md`
   is offered as a tool, an MCP prompt and an MCP resource, and skill names
   are sent in the server instructions at connect time. Because provider tools
   are passed through under their own names, the connecting model picks the
   tool. Skills are where ColdSearch says which tool suits which job; the
   `include` and `exclude` lists are where the operator decides which tools
   are offered at all.

6. **Commodity work is gateway-native.** Fetching a page, mapping a site and
   crawling it become the gateway's own tools. A provider is called only for
   what the gateway cannot do itself, such as a page behind bot protection,
   and that call goes through the same key order and ledger. The gateway's
   fetch must apply the checks of ADR 004 to every address it connects to,
   including each redirect hop. Not built yet.

Items 1 to 5 are implemented in `src/gateway/` and described in
`docs/components/gateway.md`. Item 6 and the hosted deployment are not.

### Not decided here

- How the configured-key rotator and the allowance dashboard are built. This
  ADR fixes only what they build on: the gateway is where an exhausted key is
  first seen, and the ledger is where use per key is recorded.
- Which parts of the pre-gateway CLI are removed.
  `docs/reviews/2026-11-27-legacy-surface-inventory.md` is the input for that
  change.
- How memory over recorded calls is searched (North Star G3).
- How a hosted assistant authenticates. HTTP mode has one bearer token today.

## Alternatives Considered

### A thin MCP or HTTP wrapper over the normalized commands
This was the planned next entrypoint in `docs/architecture.md`. Rejected. The
wrapper would inherit what the normalized commands cannot do: five-field
results, a hand-written catalogue, and per-process key rotation.

### Proxy only the providers' hosted MCP servers
Rejected as the default. It is the least code, but the hosted servers expose a
small part of each API. It stays available per upstream (`kind = "mcp"`) and
is the default where a provider has no API document.

### Use the provider-tool profile registry (ADR 005) as the gateway's catalogue
Rejected. Profiles are written and re-verified by hand, and the registry holds
54 tools across eight providers where Exa's API document alone holds 64
operations. An API document is maintained by the provider and read at run
time.

### Stay out of the request path: a ledger, a key rotator and observation only
Rejected as the first choice. It keeps agents on each provider's own server,
so there is no single surface, no failover inside a call, and the log depends
on what each agent harness can report. It remains the fallback if most search
calls turn out to run through lanes the gateway cannot front (see
Consequences).

### Keep fanout as the way to compare providers
Rejected for the gateway. Fanout pays several providers for every request to
compare them. With every call recorded in full, the same comparison can be
made from real calls afterwards.

### Buy crawl and map from providers
Rejected as the default. A provider charges per page for work that is an HTTP
GET and a sitemap read on most sites. Providers remain the fallback per page.

## Consequences

**Positive:**
- An agent connects once and gets every configured provider's tools with the
  provider's own parameters and results.
- A provider's new operation is reachable without a ColdSearch release.
- An exhausted key costs one failed attempt, not a failed task, and stays
  skipped across restarts.
- Every call is inspectable afterwards, including what was sent and what came
  back.
- Keys live in one place and never reach an agent.

**Negative / known gaps:**
- **The model picks the tool.** Routing quality depends on the skills. The one
  skill that exists is a draft and has not been tested on real agent runs.
- **Large tool lists.** With the six verified upstreams, `all` mode lists 245
  tools and about 680 KB of schemas. `lazy` mode avoids that at the cost of a
  find, describe, call sequence.
- **No one-call comparison.** Nothing sends a request to several providers and
  merges the answers. Comparison waits for enough recorded calls.
- **A process to keep running.** The gateway is a single point of failure for
  every agent's search.
- **Calls that bypass the gateway are not logged.** An agent connected to a
  provider through an OAuth connector or the provider's own CLI does not pass
  through it.
- **Not yet reachable as a hosted server.** There is no OAuth on the HTTP
  endpoint and no deployment manifest.
- **Payload files grow without bound** and hold full queries and page
  contents. Nothing prunes them yet.
- **Cost is known only when the provider reports it**, and remaining
  allowance is not read at all.
- **A long-running provider job** started with one key cannot be polled after
  the gateway moves to another key.
- **Two surfaces coexist until the legacy one is removed.** They have separate
  logs (`usage.jsonl` and `history.jsonl` against the gateway ledger),
  separate key handling (per-process pools against ordered lists), and
  different provider sets: Brave, Serper, Jina and SearXNG exist only as
  legacy adapters; Parallel, TinyFish and context.dev exist only as gateway
  upstreams.
- **Gateway-native crawling makes politeness the operator's job**: robots
  rules, request rates, and the reputation of the address it crawls from.

## Effect On Earlier ADRs

"Narrowed" means the earlier decision still describes code that ships, but no
longer describes how the primary surface works. None is marked "superseded",
because this ADR does not remove the code those decisions describe. Each
becomes superseded when its code is removed.

| ADR | Effect | Why |
|-----|--------|-----|
| 001 Fanout architecture | Narrowed to the legacy `search` command | 001 chose to query every provider in a pool for each request. A gateway call names one provider tool, so there is nothing to fan out. 001's case against a fallback chain concerned falling back across providers; the gateway's failover is across keys of the same provider and returns the same provider's answer, so it does not reopen that argument |
| 002 RRF reranking | Narrowed to legacy fanout | 002 merges result lists from several providers. The gateway returns one provider's result as sent, so there is nothing to merge. 002 has no use once 001's fanout is removed |
| 003 ReAct agent | Narrowed to the legacy `--agent` flag | 003 gave ColdSearch its own research loop. The gateway serves agents and does not run one; the connecting agent does the multi-step work, and providers' research endpoints are reachable as tools. Nothing in this ADR forbids an in-process agent, so 003 is not superseded |
| 004 SSRF protection | Unchanged, and extended in scope | Its checks protect agent-mode fetch today. Decision 6 requires the same checks of the gateway-native fetch |
| 005 Provider-tool profiles | Narrowed to the legacy commands and `tool call` | 005 answered "what does each provider tool accept" with hand-written profiles. The gateway answers it from the provider's API document or MCP tool list at run time and does not read the registry |

## Implementation

- `src/gateway/run.ts` — `coldsearch mcp` flags, stdio and HTTP transports,
  token check for non-loopback binds
- `src/gateway/server.ts` — MCP handlers, the gateway's own tools, lazy mode
- `src/gateway/core.ts` — `GatewayCore`: connections, key order, failover,
  status
- `src/gateway/openapi.ts` — tools from an OpenAPI document
- `src/gateway/config.ts` — upstream presets and `[gateway]` validation
- `src/gateway/ledger.ts` — ledger lines, payload files, redaction, cost
- `src/gateway/skills.ts`, `skills/` — curated skills
- `src/engine/keypool.ts` (`resolveRef`), `src/logging/usage.ts`
  (`safeKeyRef`), `src/config.ts` (`loadConfig`) — the pre-gateway modules the
  gateway uses at run time
- `test/gateway.test.mjs` — gateway tests, with fake upstreams and temp
  directories
- Not implemented: gateway-native fetch, map and crawl; hosted deployment and
  OAuth; remaining-allowance reads; the configured-key rotator and dashboard;
  payload pruning

# ADR 004: SSRF Protection in Agent Fetch

**Date:** 2026-05-28
**Status:** Accepted

## Context

Agent mode (`--agent`) lets the LLM call a `fetch("url")` tool to read arbitrary
URLs while researching. The URL is chosen by the model from untrusted search
results, so it is effectively attacker-influenceable input. Without controls, a
crafted page or prompt could steer the agent into Server-Side Request Forgery
(SSRF): fetching `http://169.254.169.254/…` (cloud instance metadata),
`http://localhost:…` (internal admin endpoints), or RFC 1918 hosts reachable
from wherever ColdSearch runs.

The agent must still be able to fetch the open web, so a pure allowlist is too
restrictive. We need a deny-by-default network policy that blocks private,
loopback, link-local, and metadata targets while letting genuine public URLs
through.

## Decision

**Validate every fetch target through layered checks before connecting, and pin
the connection to the validated IP** — implemented in `validateFetchUrl()` and
`requestValidated()` in `src/safe-fetch.ts`, which agent mode's `fetch` tool and
the gateway's native fetch, map and crawl tools both call.

Layers, in order:

1. **Protocol allowlist** — only `http:` and `https:` are accepted; anything
   else (e.g. `file:`, `ftp:`, `gopher:`) is rejected.
2. **Hostname blocklist** — `localhost`, any `*.localhost`, `metadata`,
   `metadata.google.internal`, and the literal `169.254.169.254` are refused
   outright (bracketed IPv6 literals are unwrapped first).
3. **Literal-IP blocking** — if the host is an IP literal, it is checked against
   the blocked ranges below before any DNS step.
4. **DNS resolution validation** — the host is resolved with `dns.lookup(host,
   { all: true })`; if **any** returned address falls in a blocked range, the
   fetch is refused (fail-closed).
5. **Address pinning (anti-rebinding)** — the request connects to the exact
   address that passed validation via a custom `lookup` callback, so a second
   DNS query cannot return a different (internal) address between validation and
   connection. This closes the DNS-rebinding TOCTOU gap.
6. **Response limits** — a 10 s timeout (`AGENT_FETCH_TIMEOUT_MS`), a 1 MiB body
   cap (`MAX_FETCH_BODY_BYTES`, enforced while streaming), and a content-type
   allowlist (`text/html`, `application/xhtml+xml`, `text/*`).
   These are agent mode's limits. The gateway's native tools use the same
   validation and pinning with their own limits (15 s idle, 45 s total, 5 MiB
   after decompression); see `docs/components/gateway.md`.

### Blocked ranges

| Family | Blocked |
|--------|---------|
| IPv4 | `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8` |
| IPv6 | `::1`, `::`, `fc00::/7` (ULA, `fc`/`fd`), link-local (`fe80::/10` → `fe8`/`fe9`/`fea`/`feb`), and IPv4-mapped (`::ffff:a.b.c.d` / `::ffff:hhhh:hhhh`) which are unwrapped and re-checked against the IPv4 rules |

### Redirects

`requestValidated()` never follows a redirect: a `3xx` comes back to the caller
as a response.

Agent mode does **not** follow redirects. `fetchValidatedBody()` rejects any
non-2xx response, so a `3xx` to an internal Location cannot bypass validation.
The agent does not need redirect support to read public pages.

The gateway's native tools (2026-11-27) do follow redirects, up to five, by
running the full validation again on each hop and pinning each hop's connection
to the address that passed (`fetchUrl()` in `src/gateway/native/http.ts`). A
redirect to an internal address is refused like any other internal URL.

## Alternatives Considered

### Allowlist of permitted domains
Rejected. A research agent needs the open web; maintaining a domain allowlist
would cripple it and require constant edits.

### Third-party SSRF/validation library
Rejected for now. The check is small and auditable in one file; adding a
dependency for it increases supply-chain surface for little gain.

### Egress filtering at the network layer (proxy / firewall)
Deferred. This is the strongest mitigation but is an infrastructure concern
outside the CLI. Application-layer checks are necessary regardless, since
ColdSearch runs on developer machines and CI without a controlled egress proxy.

### Following redirects with per-hop validation
Deferred for agent mode. Adds complexity (re-validate + re-pin each hop) for a
capability the agent does not currently need. Revisit if real public sources
are commonly missed because they redirect. The gateway's native tools do this
(see Redirects): a crawler meets an http-to-https or trailing-slash redirect on
most sites.

## Consequences

**Positive:**
- Deny-by-default: private, loopback, link-local, and cloud-metadata targets are
  blocked before a connection is opened.
- DNS-rebinding resistant via address pinning.
- IPv4-mapped IPv6 (`::ffff:127.0.0.1`) cannot be used to smuggle a blocked IPv4
  address past the filter.
- Bounded blast radius on response handling (timeout, size cap, content-type).

**Negative / known gaps:**
- **IPv6 coverage is prefix-heuristic**, not a full range parser; exotic
  representations of reserved ranges may not all be caught.
- **Not every IANA special-use IPv4 range is blocked** — e.g. `100.64.0.0/10`
  (CGNAT), `192.0.2.0/24`, `198.18.0.0/15`. Add ranges as needed.
- **No port restriction** beyond protocol — a public IP on a non-standard port
  is reachable.
- **Redirecting public URLs fail** in agent mode rather than resolve (see
  Redirects above).
- DNS pinning trusts the first validated address; hosts mixing public and
  private addresses are refused entirely (intended fail-closed behavior).

## Implementation

- `src/safe-fetch.ts` — the only SSRF check in the repository
  - `validateFetchUrl()` — protocol, hostname, literal-IP, and DNS checks
  - `requestValidated()` — one GET over a connection pinned to the validated address; size and time limits
  - `isBlockedIpAddress()` / `isIPv4InCidr()` / `extractIPv4FromMapped()` — range logic
  - `isBlockedHostname()` / `normalizeHostname()` — hostname rules
  - `SafeFetchHooks` — test-only seams (a replacement DNS lookup and an allowance for one address); no config key, environment variable or tool argument sets them
- `src/agent/agent.ts`
  - `SearchAgent.fetchContent()` — entry point for the `fetch` tool
  - `fetchValidatedBody()` — agent mode's limits: non-2xx rejection, 1 MiB, content-type allowlist
- `src/gateway/native/http.ts`
  - `fetchUrl()` — the native tools' GET, with per-hop validation of redirects
- Tests: `test/agent-mode.test.mjs` (blocked hosts) and `test/native.test.mjs` (private addresses refused by the gateway as built for production, redirects to internal addresses refused). See `docs/contributing/testing.md` — "Security (agent SSRF, capability validation)" is a keep-forever invariant.

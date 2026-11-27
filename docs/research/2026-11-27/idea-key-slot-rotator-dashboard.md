# Idea: canonical key slot + allowance rotator + dashboard (2026-11-27)

- Status: design proposal, nothing built. UNCONFIRMED marks a line that needs a short test first.
- Brief: every tool reads one canonical secret per provider from Doppler (`FIRECRAWL_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, ...). Several accounts exist per provider. A rotator decides which account's key sits in the slot; a dashboard shows what each account has left.

One fact shapes everything below: **a swapped-out key is not revoked.** A consumer holding the old key keeps working and keeps draining the old account. A swap is therefore a slow steer, not a cut-over, and the swap floor must leave room for that stale spend.

## 1. Design

### 1.1 Doppler layout

| Item | Where | Notes |
| - | - | - |
| Pool | new project `search-keys`, config `pool` | `EXA_API_KEY__A/B/C`, `TAVILY_API_KEY__A/B/C`, `FIRECRAWL_API_KEY__A/B` (see the Firecrawl note below), `BRAVE_API_KEY__A/B`. Only the rotator reads it. Aliases, never account names. |
| Override | same config | `<PROVIDER>__PIN` = `auto`, an alias (`b`), or `hold`. Editable from any machine or the Doppler UI. |
| Slot | new config `search-keys/slot` | `EXA_API_KEY` etc. plus a non-secret label `EXA_API_KEY_ACCOUNT=b`, written in the same API call so the pair is atomic. |
| Consumer configs | existing workstation config and cluster project | Each holds a static `EXA_API_KEY=${search-keys.slot.EXA_API_KEY}`, written once and never touched again. |

- **Copy, not reference, into the slot.** The rotator must hold every key value anyway to poll usage, so copying costs no privilege, and a mistyped reference injects the literal `${...}` string as the key.
- **Reference from consumers to the slot.** This removes the hand-made cross-project duplicate and confines the rotator's write access to one config with nothing else in it. Cross-project references are documented as paid-plan only. UNCONFIRMED for this workplace: test by creating one reference and reading it back.
- **Fallback if references are gated:** the rotator writes the slot value into both consumer configs (two calls, not atomic; seconds apart). Its write tokens then cover every secret in those configs, so the code posts only an allow-list of names.
- **Lock:** Doppler's API reference describes a config lock as preventing rename or delete. Secret writes should still land; confirm with one write of the label secret. Keep the lock.

### 1.2 Poller

One process, every 10 minutes, for every pool account (not only the one in the slot).

| Provider | Call | Stored | Gap |
| - | - | - | - |
| Tavily | `GET /usage` | `account.plan_usage`, `plan_limit` | No period dates in the response; reset day is configured per account and corrected when usage drops. |
| Firecrawl | `GET /v2/team/credit-usage` | `remainingCredits`, `planCredits`, `billingPeriodEnd` | Whether the call costs credits is undocumented; watch the first day. |
| Serper | `GET /account` | balance | Hourly is enough. |
| Exa | none with an ordinary key | ledger, see 1.3 | |
| Parallel | none with the API key | display "single org, unmetered" | Balance needs a device-flow token whose refresh token rotates on every use; defer. |

Storage is VictoriaMetrics gauges labelled `provider`, `account` (alias): `remaining`, `limit`, `period_end_timestamp`, `slot_active` (0/1), `poll_ok_timestamp`, counter `swaps_total{reason}`. No key material, prefix or hash in any label.

### 1.3 Swap policy per provider

| Provider | Shape | Rule |
| - | - | - |
| Firecrawl | monthly per team, different reset days | **Earliest reset first**: among accounts above the floor, pick the one whose period ends soonest, so credit that is about to lapse is spent first. |
| Tavily | monthly per account | Same rule. If all reset on the same day it reduces to "lowest remaining above the floor first". Today that means finish the account at 883 used, then the one at 339; the third is spent. |
| Exa | fixed balances, no endpoint | **Sticky until dead**, smallest balance first. Nothing lapses, so the only goal is no outage. |
| Parallel, Serper | one account | No rotation; display only. |

Exa ledger: seed each account's balance by hand from the vendor dashboard; subtract every captured `costDollars.total` (LiteLLM spend logs for cluster traffic, hook capture on workstations, section 5). It undercounts whatever is not captured, so treat it as an upper bound and re-seed by hand when the dashboard is open. Swap on estimate at or below floor, or on an observed `402 NO_MORE_CREDITS`. Below 20% estimated, the rotator sends one minimal search per hour as a liveness probe. Smallest fix: ask Exa support to enable the Team Management API per team; `GET /credits` then replaces the ledger.

### 1.4 Thresholds and hysteresis

- **Floor (swap out):** `max(5% of limit, burn rate x worst propagation lag)`. Start at 75 credits for Tavily and Firecrawl, 10% of seed for Exa.
- **Swap in** only an account with at least twice the floor, a successful key check in the last poll, and not inside its blackout.
- **Blackout:** an account is not selectable from 1 hour before to the first good poll after its `billingPeriodEnd`.
- **Dwell:** 6 hours minimum in the slot unless below the floor or returning 402.
- **Cap:** 4 automatic swaps per provider per day; beyond that set `hold` and alert.
- **All accounts below floor:** stay on the one with the most left and alert.
- **Manual override:** `__PIN`. An alias forces that account; `hold` freezes; `auto` resumes. A pin is honoured even below the floor.

## 2. Propagation per consumer

| Consumer | Uses the new key | Cheapest way to shorten |
| - | - | - |
| (a) Agent CLI already running, and stdio MCP servers it spawned | Never, until restarted. | Nothing cheap. Acceptable: the old key still works until it runs dry; then restart. |
| (a) Agent CLI started later | At start, if launched through a reader; not at all if the key came from a login shell export or a `.env` file. | One launcher wrapper per agent that runs `doppler run` against the consumer config; remove exports from shell profiles. `doppler run --watch` is plan-gated and kills the process, so not for interactive agents. |
| (a) Short-lived CLI per call (vendor CLIs, ColdSearch) | Next invocation. | Already immediate; one secret read per call (120/min on the lowest plan). |
| (b) LiteLLM proxy | Up to 60 min (External Secrets refresh) plus a rollout of 1 to 2 min. | Rotator sets the `force-sync` annotation on that one ExternalSecret straight after the write: about 2 min total. Needs patch rights on that object only. Or drop the refresh to 5 min. |
| (c) claude.ai-hosted connectors | **Never.** The OAuth grant is tied to whichever vendor account authorised it. | None. Reconnect by hand to move it. Its spend still appears on the dashboard because the poller reads every account. |
| (d) Vendor CLI after `login` | **Never**; the key lives in the CLI's own config file. | Do not log in; supply the env var through the wrapper. Env-over-file precedence is UNCONFIRMED per CLI. |
| (d) Vendor plugin using OAuth | **Never**, as (c). | None. |
| (d) Vendor plugin or hosted MCP with the key read from env at agent start | Same as (a). | Same wrapper. |


## 3. Dashboard

Per account, one row: provider, alias, in-slot marker, remaining / limit, reset date or "fixed", burn rate (6 h and 7 d), projected exhaustion, **projected unused at reset** (`remaining - burn x time to reset`, the figure the rotator exists to shrink), last good poll. Exa rows are marked "estimate" with the seed date. Below: swap history (time, from, to, reason, auto or manual) and current pins.

Data: the gauges in 1.2; swap history from `swaps_total` and `slot_active` changes, with the Doppler config log as the audit copy.

| Rank | Option | For | Against |
| - | - | - | - |
| 1 | Grafana board fed by the rotator's `/metrics` | Grafana and VictoriaMetrics already run; history, burn rate and alerts come free | No buttons; override is the `__PIN` secret |
| 2 | Tiny page served by the rotator with swap and pin buttons | One-click override | A write-capable web surface to protect |
| 3 | Static page regenerated on each poll | No moving parts | No history, no alerts |

Smallest viable first version: the poller alone, read-only, with the Grafana board. No swapping.

## 4. Where it runs, with what credential

- One single-replica Deployment in the cluster: a loop plus `/metrics`. Workstations sleep; the cluster has the scraper and the ExternalSecret it needs to nudge.
- Doppler credentials: one **read-only service token** on `search-keys/pool` and one **read/write service token** on `search-keys/slot`. Never a personal token. Whether write-capable service tokens are available on the lowest plan is UNCONFIRMED.
- Kubernetes: patch on one named ExternalSecret; nothing else.

Never:

- Log, print, export or label with a key value, prefix or hash. Aliases only.
- Write a slot value that is empty, contains `${`, or did not pass a live key check this cycle.
- Swap on stale data (last good poll older than two intervals) or after a failed Doppler read. On any doubt, leave the slot alone.
- Select an account inside its reset blackout.
- Delete or rewrite pool secrets.
- Run live before a dry-run period that only records would-swap decisions.

## 5. Attribution with a shared slot

| Source | Gives | Limit |
| - | - | - |
| Poller deltas | Exact spend per account over time | No caller |
| Firecrawl `/v2/team/credit-usage/historical?byApiKey=true` | Per key name, per month | One slot key per team, so this is per account again |
| Firecrawl `/v2/team/activity` | Last 24 h of jobs with endpoint and target | No credits, no caller; join to agent transcripts by time and target |
| Tavily `X-Project-ID` header, `/usage` scoped by project | Per-project usage | Only where the client lets a header be set; hosted MCP usually does not |
| Agent post-tool hooks writing host, agent, session, tool, and any cost field (`creditsUsed`, `costDollars`, `_meta["parallel/usage"]`) | Calls per host and agent; cost where the tool result carries it | Only agents with hooks; MCP results often omit cost; (c) is invisible |
| In-path consumers: LiteLLM spend logs, ColdSearch usage log | Exact, per caller, for their share | Only their share |

Workable recipe: take each account's measured delta, subtract what the in-path consumers logged, and split the remainder across hosts by hook call counts. Report what is left as "unattributed (hosted connectors and unhooked tools)".

## 6. Weak points and smallest mitigations

| Weak point | Mitigation |
| - | - |
| Running sessions keep the old key | Size the floor for it; the old key works until empty. |
| Async jobs (Firecrawl crawl, batch, agent; Exa agent runs) started under one account cannot be polled with another | Dwell time and swapping at the floor, not at zero. Long jobs go through an in-path consumer that pins the key per job. |
| One slot means one account takes every machine's traffic and its per-team rate limit, and ColdSearch's own key pool has nothing to spread | In-path consumers (ColdSearch, the LiteLLM proxy) may read the pool and choose per request, as a complement. The poller meters accounts, not the slot, so that spend stays visible. |
| Exhaustion between polls | Floor; later, a `poll-now` ping from any consumer that sees a 402. |
| Exa ledger drifts | Team Management API request; manual re-seed; 402 probe. |
| Each swap restarts a proxy that also carries LLM traffic | Two replicas with rolling update; later, update search tools through the proxy's runtime API (UNCONFIRMED) instead of restarting. |
| Hosted connectors and logged-in CLIs never move | List them on the dashboard as fixed lanes, each tied to an account. |
| Rotator down | Slot stays as it is; alert on `poll_ok_timestamp` age. |

## 7. Build order

1. **Inventory and meter.** Create the pool, group keys by the team they draw on (see the Firecrawl note below), deploy the read-only poller and the Grafana board. Useful alone: it shows what is being wasted today.
2. **Slot and manual swap.** Create the slot config, point both consumer configs at it, ship a `swap <provider> <alias>` command, the launcher wrapper and the force-sync nudge. Removes the hand-made duplicate.
3. **Automatic rotation for Tavily and Firecrawl.** Dry-run for a week, then live with pins, blackout, dwell and the daily cap.
4. **Exa ledger and attribution.** Hook capture on workstations, proxy spend-log import, the unattributed remainder panel.
5. **Optional.** Swap buttons, proxy runtime update without restart, Parallel balance, pool access for in-path consumers.

## Firecrawl pool as measured (2026-11-27)

Four Firecrawl keys are stored. A one-credit scrape on the second key lowered
the first key's balance by one as well, and both report the same billing period
to the millisecond, so those two keys draw on one team. The pool holds three
allowances:

| Team | Keys | Plan credits | Remaining | Period ends |
|------|------|--------------|-----------|-------------|
| A | two keys, one allowance | 1,500 | 1,338 | 2026-12-23 |
| B | one key | 1,000 | 1,025 | 2026-12-24 |
| C | one key | 1,000 | 87 | 2026-12-22 |

Consequences for the design above:

- **Group by team, not by key.** The poller should treat keys with the same
  `billingPeriodStart` as one account, and the rotator should hold one pool
  entry per team. Rotating between two keys of one team spends the same
  credits.
- **Team C is nearly spent** until its period ends, which is the case the
  rotator exists for: it should sit last until 2026-12-22, then first.
- A second key on team A is a spare if the first is revoked.

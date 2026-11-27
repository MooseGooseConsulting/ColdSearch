# Key pools and slot rotation

`coldsearch keys` answers two questions for a provider you hold several
accounts with: how much allowance does each account have left, and which
account is everything using right now. `keys rotate` then moves everything to
another account by changing one secret.

Status: first version (2026-11-27). Tested against a stand-in `doppler`
executable and stand-in usage endpoints. It has not been run against a real
Doppler workplace or a live provider account.

## Slot and pool

| Term | Meaning |
|------|---------|
| Pool | One Doppler secret per account key, for example `FIRECRAWL_API_KEY_1`, `FIRECRAWL_API_KEY_2` |
| Slot | The one secret every tool reads, for example `FIRECRAWL_API_KEY`. Its value is a reference to a pool secret: `${FIRECRAWL_API_KEY_2}` |

Doppler resolves the reference when the slot is read, so a consumer gets the
referenced account's key. Rotating writes a different reference into the slot.
No key value is copied, and pool secrets are never written.

The slot and its pool must be in the same Doppler project and config. The slot
must already hold a reference to a pool secret; create it once in Doppler.

## Configure it

```toml
[keys]
# Gateway ledger to read spend from, for providers with no balance endpoint.
# ledger = "~/.config/coldsearch/gateway-ledger.jsonl"

[keys.firecrawl]
slot = "FIRECRAWL_API_KEY"
pool = ["FIRECRAWL_API_KEY_1", "FIRECRAWL_API_KEY_2", "FIRECRAWL_API_KEY_3"]
project = "example-project"       # Doppler project holding the slot and the pool
config = "prd"                    # Doppler config holding them
policy = "soonest-reset"          # or "in-order"; default "soonest-reset"
floor = 50                        # default 0

[keys.exa]
slot = "EXA_API_KEY"
pool = ["EXA_API_KEY_1", "EXA_API_KEY_2"]
project = "example-project"
config = "prd"
policy = "in-order"
```

| Field | Meaning |
|-------|---------|
| `slot` | Secret name consumers read |
| `pool` | Secret names of the account keys. The order is the preferred use order |
| `project`, `config` | Passed to every `doppler` call as `-p` and `-c`, so the working directory and any `doppler setup` scope have no say |
| `policy` | How `keys rotate` chooses; see below |
| `floor` | An account with this much allowance or less counts as spent |
| `base_url` | Origin of the provider's usage endpoint. For tests; leave unset otherwise |

Supported providers: `firecrawl`, `tavily`, `serper`, `exa`, `parallel`. The
table holds secret names only, never a key. A config with only `[keys]` blocks
is enough for these commands.

## Where the numbers come from

| Provider | Request | Remaining | Limit | Period end |
|----------|---------|-----------|-------|------------|
| `firecrawl` | `GET /v2/team/credit-usage` | `data.remainingCredits` | `data.planCredits` | `data.billingPeriodEnd` |
| `tavily` | `GET /usage` | `account.plan_limit - account.plan_usage` | `account.plan_limit` | not reported |
| `serper` | `GET /account` (unconfirmed, see below) | `balance` | not reported | not reported |
| `exa`, `parallel` | none: no balance endpoint for an ordinary key | unknown | | |

Firecrawl's `planCredits` leaves out coupon and pay-as-you-go credits, so
remaining can be higher than the limit.

The Firecrawl and Tavily rows follow the vendors' reference documentation. The
Serper row does not: Serper publishes no reference outside its login-gated
playground, and `GET /account` returning a top-level numeric `balance` is known
from third-party sources only. It has not been checked against a live account.
If the answer has no numeric `balance`, every Serper account reads as unknown
with the note `account response has no balance`, and `keys rotate serper`
refuses to choose until you pass `--to`.

For `exa` and `parallel` the pool keys are not read from Doppler at all. When
`[keys] ledger` is set, status shows what the [gateway](gateway.md) ledger
recorded against each key reference instead: the sum of `cost.usd` and the
number of calls, over the whole ledger file. That is spend through the gateway
only, and only where the provider reported a cost. Calls the gateway made with
the slot itself (`doppler:EXA_API_KEY`) are shown on their own line, because
the slot may have pointed at different accounts over that time.

Set `[keys] ledger` to the same file the gateway writes (`[gateway] ledger`).
When there is no file at that path, or it cannot be read, status says so on a
`ledger not read:` line and shows no ledger figures. `$0.00 over 0 calls`
therefore always means a ledger that was read and holds no entry for that key.
`keys rotate` does not read the ledger.

### One account behind two keys

Two Firecrawl keys issued by one team draw on one allowance. They report the
same billing period start, end and plan size; pool keys that do are shown as
one account with both names, and a policy treats them as one choice.

## `coldsearch keys status`

```
coldsearch keys status [--provider NAME] [--json] [-c CONFIG]
```

```
firecrawl: FIRECRAWL_API_KEY -> FIRECRAWL_API_KEY_4   policy soonest-reset, floor 50
     KEYS                                      REMAINING  LIMIT  PERIOD ENDS  NOTE
     FIRECRAWL_API_KEY_1, FIRECRAWL_API_KEY_2       1200   1500  2026-12-10   one account
     FIRECRAWL_API_KEY_3                             940   1000  2026-12-18
  *  FIRECRAWL_API_KEY_4                              12   1000  2026-12-05   at or below the floor
```

`*` marks the account the slot points at. `?` means the allowance could not be
read, and NOTE says why: the key was rejected, the secret is missing, the
endpoint was unreachable, or the provider has no endpoint.

`--json` prints `{"providers": [...]}`. Every field is always present; a value
that does not apply is `null`.

| Field | Type | Meaning |
|-------|------|---------|
| `provider`, `project`, `config`, `slot`, `policy`, `floor` | | As configured |
| `slot_state` | string | `pool-reference` (normal), `other-reference` (references something outside the pool), `own-value` (holds a key of its own), `unreadable` |
| `points_at` | string or null | Pool secret the slot references; set only for `pool-reference` |
| `slot_note` | string or null | What the slot holds instead, or why it could not be read |
| `slot_ledger_usd`, `slot_ledger_calls` | number or null | Ledger spend made with the slot's own reference |
| `ledger_note` | string or null | Why the ledger figures are null although `[keys] ledger` is set: no file at that path, or it could not be read. Null when the ledger was read or not looked up |
| `accounts[].keys` | string[] | Pool secrets that draw on this account, in pool order |
| `accounts[].in_slot` | boolean | The slot references one of `keys` |
| `accounts[].remaining`, `limit` | number or null | As the provider reports them |
| `accounts[].unit` | string or null | `credits` |
| `accounts[].period_end` | string or null | ISO 8601, as the provider reports it |
| `accounts[].spent` | boolean or null | `remaining` is at or below `floor`; null when `remaining` is unknown |
| `accounts[].unknown` | string or null | Why `remaining` is null |
| `accounts[].ledger_usd`, `ledger_calls` | number or null | Ledger spend against these keys; set only for `exa` and `parallel` with a ledger configured and readable |

Status exits 0 when it could report, including when some accounts are unknown.

## `coldsearch keys rotate`

```
coldsearch keys rotate <provider> [--to SECRET_NAME] [--dry-run] [-c CONFIG]
```

It chooses a pool secret, writes `${SECRET_NAME}` to the slot, and prints what
the slot was, what it is now, and why:

```
firecrawl: FIRECRAWL_API_KEY
  was: FIRECRAWL_API_KEY_4
  now: FIRECRAWL_API_KEY_1
  why: soonest-reset: its period ends 2026-12-10, the soonest of 2 accounts above the floor of 50 (1200 left)
```

How the target is chosen:

| Case | Target |
|------|--------|
| `--to NAME` | That secret. It must be in `pool`. The policy and the floor are not consulted, and no usage endpoint is called |
| `soonest-reset` | Among accounts known to be above the floor, the one whose period ends soonest, so allowance about to lapse is used first. When none of them reports a period end, the one with the most left. An account whose allowance is unknown is never chosen |
| `in-order` | The first account in pool order that is known to be above the floor. An account whose allowance could not be read (key rejected, HTTP error, timeout, missing secret) is passed over. For `exa` and `parallel`, which have no balance endpoint, unknown counts as above |

A failed read says nothing about what an account has left, so neither policy
moves the slot onto one. Otherwise a revoked key, or a drained account whose
usage request happened to fail, would be chosen and handed to every consumer.

Use `in-order` for `exa` and `parallel`. Their allowance is always unknown, so
`soonest-reset` can never choose, and `in-order` always chooses the first pool
key; move on with `--to` when that account runs out.

When the policy chooses an account the slot already uses, through any of that
account's keys, the slot is left as it is.

What rotate will not do:

| Situation | Result |
|-----------|--------|
| The slot already points at the target | Says so, writes nothing, exit 0 |
| `--dry-run` | Prints `would be:` in place of `now:`, writes nothing, exit 0 |
| Every account is at or below the floor | Writes nothing, exit 1 |
| No account is known to be above the floor because some could not be read | Writes nothing, exit 1, and names `--to`. Both policies, except `in-order` for `exa` and `parallel` |
| The slot cannot be read | Writes nothing, exit 1 |
| The slot holds a key of its own that no pool secret also holds | Writes nothing, exit 1. A reference written over it would lose that key; store it under a pool name first |
| The target secret is missing or empty | Error before any write. A slot pointing at a missing secret hands consumers the literal text `${NAME}` |

After a write, rotate reads the slot back. It must store the reference and
resolve to the target's value, or the command fails and names the slot to
check.

Rotation is a command. Nothing here runs on a schedule; run it by hand or from
whatever scheduler you already have.

## From the gateway dashboard

A gateway in HTTP mode whose config also has a `[keys]` section shows these
pools on its dashboard and serves `keys status --json` at `GET /api/keys`.
Both need the gateway to have been started with `COLDSEARCH_GATEWAY_TOKEN`
set.
Started with `--allow-rotate`, it also offers `keys rotate` as a button and as
`POST /api/keys/rotate`, with a dry-run preview first. The gateway process
then needs the `doppler` CLI and access to the project, as these commands do.
A `[keys]` section that is present but invalid stops the HTTP gateway from
starting, with the same message `keys status` gives. See
[the gateway's Dashboard section](gateway.md#dashboard).

## Key handling

- Secrets are reached through the `doppler` CLI as a child process, with no
  shell. Reads are `doppler secrets get NAME --plain [--raw] -p … -c …`.
- The one write is `doppler secrets set SLOT --silent --no-interactive -p … -c …`
  with the reference text on stdin. No value is ever an argument.
- A key reaches a provider in a request header only.
- Output never contains a key value. Reasons for an unknown allowance are built
  from the status code or the transport error, never from a response body, and
  everything printed is passed through redaction against every value read
  during the run.

## Limits

- A key that leaves the slot is not revoked. A process that already read it
  keeps using it until restarted, so set `floor` high enough to cover that
  spend. The gateway reads a `doppler:` reference again after its secret cache
  expires (5 minutes by default), so it follows a rotation without a restart.
- Tavily and Serper report no period end, so `soonest-reset` falls back to
  most remaining for them.
- An agent connected to a provider through an OAuth connector does not read
  the slot and is not moved by a rotation.
- Each status run makes one Doppler read per pool key plus one for the slot,
  and one usage request per pool key. Firecrawl's documentation does not say
  whether its usage request costs credits.
- The gateway ledger is append-only and nothing trims it. A status run that
  shows ledger spend reads the whole file once, in fixed-size pieces, so
  memory stays flat but the run takes longer as the file grows.

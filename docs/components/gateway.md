# MCP gateway

`coldsearch mcp` is one MCP server that agents connect to in place of each
search provider's own. It offers every operation of the providers' APIs as a
tool and adds three things: it holds the keys, it records every call in full,
and it hands agents the curated skills in `skills/`.

Status: first version (2026-11-27). Verified live against Exa, Firecrawl,
Parallel and Tavily through their API documents, and Bright Data and TinyFish
through their hosted MCP servers. context.dev has a preset taken from its
documentation and has not been run.

## Two kinds of upstream

| Kind | Tools come from | Use for |
|------|-----------------|---------|
| `openapi` | The vendor's published OpenAPI document: one tool per operation, with every path, query and body parameter | Vendors that publish one. Default for `exa`, `firecrawl`, `parallel`, `tavily` |
| `mcp` | The vendor's hosted MCP server, passed through unchanged | Vendors with no API document, or tools only their MCP server has. Default for `brightdata`, `tinyfish`, `context` |

`openapi` is the default where it exists because hosted MCP servers expose a
small part of the API. Exa's lists 3 tools and its search takes 3 parameters;
its API document has 64 operations and its search takes 23. The hosted MCP
servers stay reachable under the presets `examcp`, `firecrawlmcp`,
`parallelmcp` and `tavilymcp`, and both kinds can be configured side by side.

## Run it

```bash
# One agent, over stdio
coldsearch mcp --config ~/.config/coldsearch/config.toml

# Many agents, over HTTP at /mcp, with a dashboard at /dashboard
COLDSEARCH_GATEWAY_TOKEN=... coldsearch mcp --http --host 0.0.0.0 --port 8787
```

HTTP mode binds to `127.0.0.1` by default. It refuses any other bind address
unless `COLDSEARCH_GATEWAY_TOKEN` is set; clients then send
`Authorization: Bearer <token>`. `GET /healthz` answers without a token. HTTP
mode also serves the [dashboard](#dashboard), whose data needs the token on
every bind address, `127.0.0.1` included.

Operator messages go to stderr. In stdio mode stdout carries the protocol.

## Configure it

```toml
[gateway]
mode = "all"                      # or "lazy"; see below
# ledger = "~/.config/coldsearch/gateway-ledger.jsonl"
# state  = "~/.config/coldsearch/gateway-state.json"
# skills_dir = "<package>/skills"
# log_arguments = true            # false keeps tool arguments out of the ledger
# log_payloads = true             # false stops saving full requests and responses
# payload_dir = "<ledger directory>/gateway-payloads"
# exhausted_cooldown = "6h"       # how long an out-of-credit key is skipped
# tool_list_ttl = "10m"

[gateway.upstreams.exa]
keys = ["doppler:EXA_API_KEY", "doppler:EXA_API_KEY_2"]

[gateway.upstreams.firecrawl]
keys = ["doppler:FIRECRAWL_API_KEY"]

# Hide tools agents should not have. `*` is a wildcard; `include` works the
# same way and, when set, hides everything it does not match.
[gateway.upstreams.tinyfish]
keys = ["doppler:TINY_FISH_API_KEY"]
exclude = ["top_up_wallet", "delete_*", "*_profile*"]

# An upstream without a preset needs its connection details.
[gateway.upstreams.internal]
url = "https://mcp.example.internal/mcp"
auth = "header"                   # "header", "query" or "none"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:INTERNAL_MCP_KEY"]
```

Preset blocks need only `keys`. Any other name needs `url`, plus
`kind = "openapi"` and `spec` (a URL or file path) for an API-document
upstream. Key references use
the same `doppler:` and `env:` forms as provider key pools
(`docs/KEY_MANAGEMENT.md`). A gateway-only config needs no `[capabilities]`
or `[providers]` sections.

## What agents see

Tool names are `<upstream>__<tool>`, for example `exa__search` or
`firecrawl__crawlUrls`. For an `openapi` upstream the tool name is the
operation's id, or the method and path when the id is missing or long
(`parallel__post_v1_search`); body fields are top-level arguments. Descriptions
and schemas are the provider's own. An operation the provider adds to its API
document appears within an hour, an MCP tool within `tool_list_ttl`, with no
ColdSearch change. A tool hidden by
an upstream's `include` or `exclude` list is neither listed nor callable.

The gateway adds its own tools:

| Tool | Purpose |
|------|---------|
| `coldsearch_status` | Upstreams, which key each is using, skipped keys, calls and cost per key for 24 hours and 7 days |
| `coldsearch_read_skill` | Return one curated skill by name |
| `coldsearch_find_tools`, `coldsearch_describe_tool`, `coldsearch_call_tool` | Lazy mode only |

### `all` and `lazy`

With the six verified upstreams, `all` mode lists 245 tools whose schemas total
about 680 KB. That suits a client that defers tool schemas until needed. For a
client that loads every schema into context, use `lazy`: it lists five gateway
tools (under 2 KB), and the agent finds an upstream tool by keyword, reads its
schema, then calls it by name. `--mode` overrides the config per process, so
one config can serve both kinds of client.

## Keys

Each upstream's `keys` list is the drain order. The first key not currently
skipped is used. When a call fails because the account is out of credit or the
key is rejected, the gateway marks that key skipped for `exhausted_cooldown`,
retries the same call on the next key, and records both attempts. Skipped keys
are saved in the state file, so a restart does not go back to an empty key.
When every key is skipped the call is still attempted, soonest-to-return key
first, and the agent gets one error naming the upstream if all fail.

Out-of-credit is recognized from the providers' documented signals: HTTP 402,
Tavily's 432, and their error codes. An `openapi` upstream returns a non-2xx
response as an error that starts with the status code. For `mcp` upstreams it
is also recognized in small JSON error objects returned as successful results,
which is how Tavily's MCP server reports an exhausted plan. A rate-limit error
(429) is passed back to the agent and does not skip a key.

A key reference is resolved again after the secret cache expires
(`COLDSEARCH_SECRET_CACHE_TTL`, default 5 minutes for `doppler:` references).
If its value changed, the next call reconnects with the new value, so swapping
a key in the secret store takes effect without restarting the gateway.

## Ledger

One JSON line per attempt, in a file created with mode 0600:

```json
{"ts":"2026-11-27T08:35:21.757Z","session":"…","client":"claude-code/2.1","upstream":"tavily","tool":"tavily_search","key":"env:TAVILY_API_KEY","attempt":2,"ok":true,"duration_ms":1267,"args":"{\"query\":\"…\"}","result_bytes":4211}
```

`key` is the reference, never the value, and resolved key values are replaced
with `[redacted]` in `args` and `error`. `error_class` is `quota`, `auth` or
`upstream`. `cost` holds `usd` or `credits` when the provider reports one in
the response. In live runs Exa's API did (`costDollars`) and Firecrawl's did on
scrape and search (`creditsUsed`). Parallel's and Tavily's search responses
carried none, so calls to those are counted but not priced.

### Full requests and responses

Each attempt's complete request and response is saved as its own file under
`payload_dir`, as `<day>/<time>-<upstream>-<id>.json` with mode 0600, and the
ledger line's `payload` field names it. Keeping bodies out of the ledger keeps
the ledger quick to scan; a crawl result can be megabytes. Key values are
redacted in these files too. Nothing prunes them yet.

## Dashboard

HTTP mode serves one page at `/dashboard` that shows what the gateway and the
key pools are doing:

| Section | Shows |
|---------|-------|
| Key pools | Per provider with a `[keys.<provider>]` block: each account's remaining allowance as a bar against its limit, when its period ends, which account the slot points at, and a Rotate button when rotation is enabled. The same reading as `coldsearch keys status` |
| Upstreams | Per upstream and per key: calls, errors, quota errors and cost for the last 24 hours and 7 days, and each key's state (`active`, `standby`, or `skipped` with the reason and retry time) |
| Recent calls | The newest 200 ledger entries of the last 24 hours: time, client, upstream, tool, key reference, result, duration, cost. The filter box matches any of those plus the error text and arguments; the arrow beside a time opens that call's error, arguments, session and payload file name |

Status: first version (2026-11-27). The endpoints are tested against a
stand-in upstream, a stand-in secret store and a stand-in usage endpoint. The
page was opened in Chromium with stand-in data, in light and dark, and its
rotate flow was clicked through against those stand-ins. It has not been run
against a real Doppler workplace or a live provider account.

The page is a single HTML document with its stylesheet and script inline. It
loads nothing from anywhere else, and a Content-Security-Policy header allows
only that script and stylesheet and forbids framing the page. It is light or
dark by the browser's setting.

### Token

`/dashboard` itself is served without the token, so the page can ask for it.
The page holds no data: the same bytes are served by every gateway. It asks
for the bearer token once, keeps it in the tab's `sessionStorage` (gone when
the tab closes; "Forget token" removes it sooner), and sends it as
`Authorization` on its requests to this gateway's `/api/` endpoints.

The `/api/` endpoints answer only to the token. A gateway started without
`COLDSEARCH_GATEWAY_TOKEN` (possible on `127.0.0.1` only) still serves `/mcp`
and the page, but every `/api/` request gets a 403 that says to set the
token, with the header `X-Coldsearch-Api: token-required`, and the page shows
that message instead of asking for a token. This is stricter than `/mcp` on
purpose. `/api/ledger` returns every agent's call arguments from a file the
gateway keeps at mode 0600, and `/api/keys` returns secret names and account
balances. Without a token, any account on the machine could read those over
HTTP, and so could a web page that gets a browser to resolve its own hostname
to `127.0.0.1`.

The page never receives a key value. The endpoints return key references
(`doppler:NAME`) and secret names, and what they return about key pools passes
through the same redaction as the `keys` commands.

### Endpoints

All take the same bearer token as `/mcp`, answer JSON, and report a refusal as
`{"error": "..."}`. All answer 403 on a gateway started without a token.

| Request | Answer |
|---------|--------|
| `GET /api/status` | What `coldsearch_status` returns: upstreams, key states, totals per key for 24 hours and 7 days. When the ledger cannot be read, the totals are empty and `ledger_error` says why; the key states are still returned |
| `GET /api/ledger?since=&upstream=&limit=` | `{since, upstream, limit, matched, entries}`. `entries` are ledger lines, newest first by start time. `since` is a duration (`90s`, `30m`, `24h`, `7d`; default `24h`), `upstream` an upstream name, `limit` 1 to 1000 (default 200). `matched` counts every entry in the window before `limit` |
| `GET /api/keys?provider=` | What `coldsearch keys status --json` prints (`docs/components/keys.md`). 404 when the config has no `[keys]` section. The response header `X-Coldsearch-Rotate` is `enabled` or `disabled` |
| `POST /api/keys/rotate` | Does what `coldsearch keys rotate` does; see below |

`/api/ledger` reads ledger lines only. An entry's `payload` field names its
payload file; the file is not opened and no request or response body is
returned.

### Rotating from the page

Rotation over HTTP is off unless the gateway is started with `--allow-rotate`:

```bash
COLDSEARCH_GATEWAY_TOKEN=... coldsearch mcp --http --allow-rotate
```

`--allow-rotate` needs `COLDSEARCH_GATEWAY_TOKEN` and a `[keys]` section; the
gateway refuses to start without either. Then:

```
POST /api/keys/rotate
Authorization: Bearer <token>
X-Coldsearch-Confirm: rotate
Content-Type: application/json

{"provider": "firecrawl", "to": "FIRECRAWL_API_KEY_2", "dry_run": true}
```

`to` and `dry_run` are optional and mean what `--to` and `--dry-run` mean.
The answer is `{provider, slot, outcome, before, after, reason, dry_run}`:
`before` is what the slot pointed at, `after` the pool secret it points at now
(or would, for a dry run), `reason` why. `outcome` is `rotated`, `dry-run`,
`unchanged` or `refused`. A refused rotation is HTTP 409 with `after` null and
nothing written. Every request that reaches the rotation, dry runs included,
writes one line to the gateway's stderr.

On the page, Rotate opens a panel. Preview sends a dry run and shows the
before, after and reason. The button that then appears sends the write, with
`to` set to the previewed target, so what is written is what was shown.

Why the extra switch and header. This is the one endpoint that changes a
secret, and a rotation moves every consumer of the slot to another account. A
browser will send a request from any page a person has open, so the endpoint
must not be reachable by accident:

- With the switch off, which is the default, the endpoint refuses everything.
  A gateway started to serve agents and show status cannot rotate.
- `X-Coldsearch-Confirm` cannot be set by an HTML form or a plain link, and a
  script on another site that tries to set it is stopped by the browser,
  because the gateway answers no cross-origin preflight.
- The token is required even on loopback, as for every `/api/` endpoint,
  because without one a page that got a browser to treat the gateway's port
  as its own origin could send the header too.
- The page cannot be framed, so another site cannot overlay it to steer a
  click onto the button.

### What the dashboard costs

- Status and recent calls are refreshed every 30 seconds while the tab is
  visible. Each refresh reads the whole ledger file twice: once for the
  24-hour and 7-day totals together, which `coldsearch_status` also does, and
  once for the recent calls. Both reads take the file in 64 KB pieces and let
  other requests run between pieces, so memory does not grow with the file
  and agents are not held up for the length of a read. Nothing trims the
  ledger, so each refresh still costs more as the file grows. Measured on one
  machine with generated ledgers (2026-11-27): 216 MB and 260,000 lines took
  0.35 s for the totals and 0.30 s for the recent calls; 607 MB and 730,000
  lines took 0.87 s and 0.76 s. The longest the gateway's thread was held at
  a stretch was 1.3 ms in both.
- The key pools are read when the page opens, on Refresh, and after a
  rotation; never on a timer. Each read is one `keys status`: one Doppler read
  per pool key plus one for the slot, and one usage request per pool key.
- Anyone with the gateway token can read every agent's calls through
  `/api/ledger`, arguments included. Set `log_arguments = false` to keep
  arguments out of the ledger.

## Skills

Every `skills/<name>/SKILL.md` with `name` and `description` frontmatter is
served three ways, so any client can reach it: the `coldsearch_read_skill`
tool, an MCP prompt, and an MCP resource at `skill://<name>`. Skill names and
descriptions are also sent in the server instructions at connect time.

## Limits

- An agent connected to a provider through an OAuth connector, or through the
  provider's own CLI, bypasses the gateway; those calls are not logged here.
- A long-running provider job (a crawl, a research agent run) started with one
  key cannot be polled after the gateway moves to another key.
- The gateway reads what a call cost when the provider says so. It does not
  ask providers how much allowance each account has left; `coldsearch keys
  status` does (`docs/components/keys.md`).

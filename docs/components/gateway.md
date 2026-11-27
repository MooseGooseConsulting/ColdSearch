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

# Many agents, over HTTP at /mcp
COLDSEARCH_GATEWAY_TOKEN=... coldsearch mcp --http --host 0.0.0.0 --port 8787
```

HTTP mode binds to `127.0.0.1` by default. It refuses any other bind address
unless `COLDSEARCH_GATEWAY_TOKEN` is set; clients then send
`Authorization: Bearer <token>`. `GET /healthz` answers without a token.

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
  ask providers how much allowance each account has left.

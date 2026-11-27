# MCP gateway

`coldsearch mcp` is one MCP server that agents connect to in place of each
search provider's own. It offers every operation of the providers' APIs as a
tool and adds three things: it holds the keys, it records every call in full,
and it hands agents the curated skills in `skills/`.

Status: first version (2026-11-27). Verified live against Exa, Firecrawl,
Parallel and Tavily through their API documents, and Bright Data and TinyFish
through their hosted MCP servers. context.dev has a preset taken from its
documentation and has not been run.

The connector behaviour under [OpenAPI upstreams](#openapi-upstreams), the
argument pins, and the Tavily 433, Serper, Brave, TinyFish and Bright Data
signals under [Keys](#keys) are covered by tests against local servers. They
have not been run against the vendors.

The presets added after that first run, and every preset's
[default tool list](#default-tool-lists), come from the vendors' published
documents and documentation. The tool lists were matched against the
operation names those documents produce; no operation was called with a key.
`docs/PROVIDERS.md` ("Gateway upstreams") has the table per preset.

## Two kinds of upstream

| Kind | Tools come from | Use for |
|------|-----------------|---------|
| `openapi` | OpenAPI documents, the vendor's own or one shipped in `specs/`: one tool per operation, with every path, query, header and body parameter | Vendors with an HTTP API. `exa`, `exaadmin`, `firecrawl`, `parallel`, `tavily`, `tavilykeys`, `brightdata`, `tinyfishapi`, `tinyfishanswer`, `context`, `jina`, `kagi`, `perplexity`, `serper`, `brave`, `braveanswers`, `searxng` |
| `mcp` | The vendor's hosted MCP server, passed through unchanged | Tools only the hosted server has. `examcp`, `firecrawlmcp`, `parallelmcp`, `tavilymcp`, `brightdatamcp`, `tinyfish`, `contextmcp`, `jinamcp` |

`openapi` is the default where it exists because hosted MCP servers expose a
small part of the API. Exa's lists 3 tools and its search takes 3 parameters;
its API document has 64 operations and its search takes 23. The hosted MCP
servers stay reachable under the `<name>mcp` presets, and both kinds can be
configured side by side. TinyFish is the exception: its hosted server is the
main upstream (`tinyfish`), and `tinyfishapi` adds the REST operations that
server has no tool for.

`brightdata` and `context` named the hosted MCP servers in the first version.
They now name the REST APIs, with the same key: Bright Data's hosted server is
`brightdatamcp` and Context.dev's is `contextmcp`. A block under the old name
keeps working and gets the REST tools, whose names differ (`unlockUrl`, not
`search_engine`).

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

### See what a config offers

```bash
coldsearch mcp --config ~/.config/coldsearch/config.toml --list-tools
coldsearch mcp --list-tools --json
```

Prints, for each upstream, how many tools the provider offers, how many the
config exposes, the exposed names, how many are hidden for each reason, and
which tools have pinned arguments. Then it exits. It reads tool lists only and
calls no tool: an `openapi` upstream is listed from its documents without
resolving a key, and an `mcp` upstream by connecting with the first key that
works and asking for its list. An upstream that cannot be read is reported
with the reason and does not stop the others.

```
tavily (openapi, https://docs.tavily.com/documentation/api-reference/openapi.json)
  offered 10, exposed 6, hidden 4
  exposed: search, extract, crawl, map, createResearch, getResearch
  hidden: account 3, feedback 1
  pinned: createResearch, search, extract, crawl, map, getResearch
```

`--json` gives the same as a list of objects with `upstream`, `kind`,
`source`, `curation`, `offered`, `exposed`, `hidden` (each tool with its
reason), `pinned` and, when the list could not be read, `error`.

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

[gateway.upstreams.firecrawl]
keys = ["doppler:FIRECRAWL_API_KEY"]

[gateway.upstreams.parallel]
keys = ["doppler:PARALLEL_API_KEY"]

# A preset already hides what an agent should not hold and pins expensive
# defaults; see "Default tool lists". A block's own list replaces the
# preset's. `*` is a wildcard; `include`, when set, hides everything it does
# not match.
[gateway.upstreams.tinyfish]
keys = ["doppler:TINY_FISH_API_KEY"]
exclude = ["top_up_wallet", "delete_*", "*monitor*", "*_profile*"]

# Fix arguments for tools whose own defaults are expensive; see "Argument pins".
# A block's pin table replaces the preset's whole table, so repeat what you keep.
[gateway.upstreams.exa]
keys = ["doppler:EXA_API_KEY", "doppler:EXA_API_KEY_2"]
pin = { "createAgentRun" = { default = { effort = "minimal" }, max = { "budget.maxCostDollars" = 1 } } }

# A self-hosted SearXNG: the preset has everything but the address.
[gateway.upstreams.searxng]
url = "http://localhost:8080"

# Several API documents under one upstream, each on the host it names itself.
[gateway.upstreams.example]
kind = "openapi"
url = "https://agent.example.com"
spec = ["https://agent.example.com/openapi/main", "https://agent.example.com/openapi/search"]
auth_name = "X-API-Key"
auth_prefix = ""
keys = ["env:EXAMPLE_API_KEY"]
# stream_timeout = "5m"           # longest an event-stream response is read
# stream_max_bytes = 4194304      # most bytes of one that are read

# An upstream without a preset needs its connection details.
[gateway.upstreams.internal]
url = "https://mcp.example.internal/mcp"
auth = "header"                   # "header", "query" or "none"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:INTERNAL_MCP_KEY"]
```

Preset blocks need only `keys` (`searxng`, which is keyless, needs only
`url`). Any other name needs `url`, plus `kind = "openapi"` and `spec` (a URL
or file path, or a list of them) for an API-document upstream. A spec written
`package:<path>` names a file shipped with ColdSearch, such as
`package:specs/brave.yaml`, and is found wherever the process was started.
Key references use
the same `doppler:` and `env:` forms as provider key pools
(`docs/KEY_MANAGEMENT.md`). A gateway-only config needs no `[capabilities]`
or `[providers]` sections.

## What agents see

Tool names are `<upstream>__<tool>`, for example `exa__search` or
`firecrawl__crawlUrls`. For an `openapi` upstream the tool name is the
operation's id, or the method and path when the id is missing or long
(`parallel__post_v1_search`); body fields are top-level arguments, and so are
the operation's header parameters. Descriptions
and schemas are the provider's own. An operation the provider adds to its API
document appears within an hour, an MCP tool within `tool_list_ttl`, with no
ColdSearch change, unless the preset's default tool list hides it. A tool
hidden by an upstream's `include` or `exclude` list, the preset's or the
block's, is neither listed nor callable.

The gateway adds its own tools:

| Tool | Purpose |
|------|---------|
| `coldsearch_status` | Upstreams, which key each is using, skipped keys, calls and cost per key for 24 hours and 7 days |
| `coldsearch_read_skill` | Return one curated skill by name |
| `coldsearch_find_tools`, `coldsearch_describe_tool`, `coldsearch_call_tool` | Lazy mode only |

### `all` and `lazy`

With the six upstreams of the first version and no tool lists, `all` mode
listed 245 tools whose schemas totalled about 680 KB. The default tool lists
cut that (`--list-tools` shows the count for a config), but a config with many
upstreams still lists over a hundred. That suits a client that defers tool
schemas until needed. For a client that loads every schema into context, use
`lazy`: it lists five gateway
tools (under 2 KB), and the agent finds an upstream tool by keyword, reads its
schema, then calls it by name. `--mode` overrides the config per process, so
one config can serve both kinds of client.

## OpenAPI upstreams

### Which host a call goes to

An operation's base URL is the first of these that exists:

1. a `servers` entry on the operation;
2. a `servers` entry on its path;
3. the document's own top-level `servers` entry, when the upstream lists more
   than one document;
4. the upstream's `url`.

With one document, the upstream's `url` outranks the document's server. That
is how a block points a published document at a regional or self-hosted base:
`url = "https://api.eu.example.com"` with the vendor's usual `spec`. With
several documents each goes to the host it names, so a vendor that publishes
one document per host fits in one block; a document with no server of its own
still uses `url`. To send every document of a list to one base, give each its
own upstream.

Only the first entry of a `servers` list is read, and only when it is an
absolute `http` or `https` URL with no `{variable}` in it. Anything else is
skipped and the next rule applies.

When two documents declare the same method and path on the same base URL, the
first one listed is kept and the later one is dropped. The same path on two
hosts is two tools.

### Header parameters

A parameter the document declares `in: header` is a tool argument, sent as
that request header when the agent supplies it. This is how a request id or
idempotency key (`x-request-id`, `x-idempotency-key`), a per-call beta opt-in,
or `Last-Event-ID` reaches the API. An `Accept` the agent supplies replaces
the gateway's `application/json`.

A tool argument can never set:

- the header that carries the upstream's key (`auth_name`), or
  `Authorization` and `Proxy-Authorization` in any case;
- a header the block's `headers` table fixes;
- `Content-Type`, `Content-Length`, `Host`, `Connection` or
  `Transfer-Encoding`, which the gateway writes itself.

Such a parameter is left out of the tool's schema, and a call that supplies it
anyway is refused with an error naming the argument, before any request is
made. A header value with a line break or control character is refused the
same way.

### Streaming responses

A response with content type `text/event-stream` is read until the upstream
closes it and returned as one JSON array:

```json
[{"event":"progress","data":{"step":1},"id":"7"},{"event":"message","data":"[DONE]"}]
```

`event` is `message` when the stream names none. `data` is parsed as JSON when
it parses and is otherwise the text, or `null` for an event with no data.
`id` is present only when the upstream sent one, so a caller can resume with
`Last-Event-ID` where the API accepts it. Comments and keep-alives are
dropped.

Two per-upstream limits bound the read: `stream_timeout` (default `5m`,
counted from when the request was sent) and `stream_max_bytes` (default
4194304). When either is reached the gateway stops reading, returns the
complete events it has, and adds a second text item that starts
`Stream cut short:` and names the limit. That result is not an error. An
event still arriving at that moment is left out.

A connection that breaks partway through a stream is handled the same way
once at least one complete event has arrived: those events are returned, and
the `Stream cut short:` item says the connection broke and gives the
transport's message. The events are what the agent has to go on to poll or
resume the run, so they are not thrown away. A stream that breaks before its
first complete event is an ordinary failed call.

This applies to whatever answers with an event stream: an events endpoint, or
an operation called with `stream: true`. The gateway does not ask for a stream
itself.

### Binary responses

A response that is not text (a screenshot, a PDF, a compressed download) is
not returned. The result is one line of text naming the content type and the
size in bytes and saying the gateway does not pass binary bodies through; the
bytes reach neither the agent nor the payload file. A body declared as an
image, audio, video, font, PDF, zip or gzip is treated this way without being
kept in memory. A body with a generic or missing content type is returned as
text when it is valid UTF-8 and described as binary when it is not.

## Default tool lists

A preset carries more than connection details. It also says which of the
provider's tools an agent gets and which arguments are pinned, so a block that
names an upstream and its keys is safe to hand to an agent as it stands. The
lists live in `src/gateway/profiles.ts`; `docs/PROVIDERS.md` ("Gateway
upstreams") shows what each preset offers, exposes and hides.

A preset hides a tool for one of these reasons:

| Reason | What it covers |
|--------|----------------|
| `credentials` | The response carries a key, a password or a signing secret |
| `destructive` | Deletes or clears something that cannot be brought back |
| `billing` | Moves money: a top-up, auto-recharge, payment methods |
| `account` | Manages or reports on the account, team, zones, keys, webhooks or policies, or lists every job of the team |
| `feedback` | Sends text to the vendor: feedback, a support assistant |
| `deprecated` | Deprecated, retired, or announced to stop working |
| `unusable` | Cannot work through the gateway: a file upload, a second credential, a plan the key lacks, a remote browser no call can drive |
| `schedule` | A standing schedule that spends until cancelled, and the tools that only read or change one |
| `spend` | One call can spend a large amount and no pin can bound it |
| `duplicate` | A second form of an operation the same upstream offers |
| `housekeeping` | Service plumbing with nothing in it for an agent |

Cancelling or closing something the agent itself started (a crawl, a run, a
browser session) is never hidden. A preset written as an allowlist
(`brightdata`, `perplexity`, `firecrawlmcp` and others) hides everything its
`include` list does not name; `--list-tools` reports those as `not-included`.

A preset hides by name. A tool the vendor adds later is offered unless the
preset is an allowlist, so check `--list-tools` after a vendor release.

### Changing a preset's lists

```toml
# Replace the preset's hidden tools with your own list.
[gateway.upstreams.tavily]
keys = ["doppler:TAVILY_API_KEY"]
exclude = ["post_org_usage"]

# See everything the provider offers.
[gateway.upstreams.firecrawl]
keys = ["doppler:FIRECRAWL_API_KEY"]
curation = "none"
```

- `include`, `exclude` and `pin` in a block each **replace** the preset's
  value for that one setting. They are not merged with it. A block that sets
  `exclude` drops every tool the preset hid and hides only what it lists; the
  preset's `include` and `pin` stay in force because the block did not set
  them. `exclude = []` hides nothing, and `pin = {}` pins nothing.
- `curation = "none"` drops the preset's `include`, `exclude` and `pin`
  together. The block's own lists, if any, still apply. The default is
  `curation = "preset"`.
- Tools hidden for `credentials` are the exception. They stay hidden under a
  block's own lists and under `curation = "none"`, and a call to one is
  refused. `allow_credential_tools = true` lifts that for the block. The
  response of such a tool reaches the agent and the payload file, so a key or
  password it returns is then in both.
- The lists name the tools of the preset's own kind. A block that changes a
  preset's `kind` gets none of them.
- An upstream without a preset has no default lists; only the block's apply.

The tools hidden for `credentials` are: `exa` `createMonitor` and
`webhooks_create` (a webhook signing secret); `exaadmin` `list_api_keys`,
`create_api_key`, `get_api_key`, `update_api_key`, `rotate_api_key` and
`get_api_key_usage`; `tavilykeys` `post_generate_keys`; `brightdata`
`listZonePasswords`, `addZonePassword` and `removeZonePassword`; `context`
`rotateMonitorWebhookSecret`. Firecrawl's partner API, which mints keys, has
no preset.

### Pinned defaults

| Preset | Tool | Pinned | Why |
|--------|------|--------|-----|
| `exa` | `createAgentRun` | `effort` defaults to `low`; `budget.maxCostDollars` defaults to 2 and is capped at 5 | The API default, `auto`, may spend $5 and `ultra` $20; a fixed effort has no cap on contact enrichment |
| `firecrawl` | `startAgent` | `maxCredits` defaults to 200, capped at 500 | The API default is 2,500 credits |
| `firecrawl` | `crawlUrls` | `limit` defaults to 50, capped at 1,000 | The API default is 10,000 pages at a credit each |
| `firecrawlmcp` | `people_company_search`, `people_company_enrich` | `max_credits` defaults to 100, capped at 200 | Vendor defaults are 1,000 credits and no cap |
| `firecrawlmcp` | `jobs_search` | `max_credits` defaults to 50, capped at 200 | Vendor default is 200 credits |
| `parallel` | `post_v1_search`, `post_v1_images_search`, `post_v1_places_search` | `mode` defaults to `fast` | The API default, `advanced`, costs five times as much |
| `parallel` | `post_v1_responses` | `reasoning.effort` defaults to `low` | The API default, `medium`, costs five times as much |
| `parallel` | `get_v1_tasks_runs_run_id_result` | `timeout` defaults to 240, capped at 280 | The API waits 600 s; the gateway gives a request 300 s |
| `tavily` | `createResearch`; `tavilymcp` `tavily_research` | `model` defaults to `mini` | `auto` may pick `pro`, up to 250 credits |
| `tavily` | `search`, `extract`, `crawl`, `map`, `getResearch` | `include_usage` defaults to `true` | Tavily reports a call's cost only when asked, and the ledger records it |
| `context` | `post_web_answers` | `mode` defaults to `fast` | The API default, `ultra`, is 100 credits; `fast` is 10 |
| `searxng` | `search` | `format` defaults to `json` | Without it the instance answers with an HTML page |

The numbers are a starting point chosen from the vendors' price lists, not
measured. A `default` leaves an argument the agent supplied alone, so an agent
can still ask for Parallel's `advanced` mode or Tavily's `pro` model by
naming it. Only a `max` binds.

### Shipped documents

`specs/` holds the OpenAPI documents ColdSearch authors because the vendor
publishes none, or an incomplete one:

| File | Operations | Used by | Written from |
|------|------------|---------|--------------|
| `specs/serper.yaml` | 15, on three hosts | `serper` | The vendor's public web client; Serper publishes no reference |
| `specs/brave.yaml` | 16 | `brave`, `braveanswers` | Brave's reference pages; its one published document has 8 operations with reduced parameters |
| `specs/searxng.yaml` | 4, GET only | `searxng` | The SearXNG documentation and source |
| `specs/firecrawl-additions.yaml` | 6 | `firecrawl`, listed before the published document | Firecrawl's public source and documentation |
| `specs/parallel-suggest.yaml` | 2 | `parallel`, listed after the published document | Parallel's Ingest API page |

Each operation's description names the page it was written from, and says
"unverified against the live API" unless a request confirmed it. Only
Serper's keyless `locations` operation was confirmed. The Firecrawl additions
replace three published operations (the multipart `parseFile` with the JSON
`parseUploadedFile`, and fuller forms of
`interactWithScrapeBrowserSession` and `getHistoricalCreditUsage`) and add
`createParseUploadUrl`, `getAgentThread` and `getConcurrency`.

## Argument pins

`pin` on an upstream fixes arguments for the tools a pattern matches, before
the call is forwarded. It exists so a tool with an expensive default can be
offered safely. It works for both kinds of upstream.

```toml
[gateway.upstreams.exa]
keys = ["doppler:EXA_API_KEY"]

[gateway.upstreams.exa.pin]
"createAgentRun" = { default = { effort = "low" }, max = { "budget.maxCostDollars" = 1 } }
"search*" = { max = { numResults = 25 } }
```

- The key is a tool-name pattern, matched like `include` and `exclude`
  against the upstream's own tool name (without the `exa__` prefix).
- `default` fills an argument the agent left out. An argument the agent
  supplied, including `null`, is left alone.
- `max` lowers a numeric argument that is above it, and the result gains a
  line starting `Gateway note:` that names the argument, the value asked for
  and the value sent. A number given as a string is compared the same way. A
  `max` does not add an argument the agent left out; pair it with a `default`
  when the API's own default is the problem.
- A name with a dot reaches into a nested object: `"budget.maxCostDollars"`,
  or `"body.maxCredits"` for a tool whose JSON body is the single `body`
  argument. Quote such a name in TOML. A dotted `default` creates the
  enclosing object when it is missing. Lists are not searched.
- When several patterns match one tool, all apply in the order written: the
  first `default` for an argument wins, and the lowest `max` wins.
- A capped argument that is neither a number nor a numeric string is refused
  before any call, because it cannot be compared with the cap. That includes
  `null`: the API would read it as "use your own default", which is what the
  cap is there to prevent. A call is refused the same way when an argument on
  the way to a dotted name is present but is not an object, such as
  `budget: null` or a list under a `"budget.maxCostDollars"` cap. The error
  names the argument; leaving it out is always accepted.

The ledger line and the payload file record the arguments as sent. A pin
table that is not shaped like this stops the gateway at start with an error
naming the upstream, the pattern and the setting.

## Keys

Each upstream's `keys` list is the drain order. The first key not currently
skipped is used. When a call fails because the account is out of credit or the
key is rejected, the gateway marks that key skipped for `exhausted_cooldown`,
retries the same call on the next key, and records both attempts. Skipped keys
are saved in the state file, so a restart does not go back to an empty key.
When every key is skipped the call is still attempted, soonest-to-return key
first, and the agent gets one error naming the upstream if all fail.

Out-of-credit is recognized from the providers' documented signals:

| Signal | Provider |
|--------|----------|
| HTTP 402; `Payment Required`; `Insufficient credits` | Exa, Firecrawl, Parallel, Context.dev, TinyFish and others |
| `NO_MORE_CREDITS`, `API_KEY_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED` | Exa |
| HTTP 432 (plan or key limit) and 433 (pay-as-you-go limit) | Tavily |
| `Not enough credits`, sent with HTTP 400 | Serper |
| `free_allowance_exhausted`, sent with HTTP 429 | TinyFish |
| `Usage limit reached`, `out of free credits`, `not enough funds`, `client_10100` | Bright Data |

A rejected key is recognized from HTTP 401, wording such as `Unauthorized` or
`invalid api key`, and Brave's `SUBSCRIPTION_TOKEN_INVALID` (sent with HTTP
422).

An `openapi` upstream returns a non-2xx response as an error that starts
`HTTP <status>:`. Such an error is judged by that status; a number further
into the body is not read as a status, so `HTTP 404: run 402 not found` is an
ordinary error. Bright Data reports an exhausted account in a response header,
so when an error response carries `x-brd-err-code` the gateway appends it to
the error text as `[x-brd-err-code: client_10100]`. For `mcp` upstreams, whose
errors are free text, the status numbers are looked for anywhere in the text,
and a failure is also recognized in a small JSON object with a non-empty
`error` field returned as a successful result, which is how Tavily's MCP
server reports an exhausted plan. Any other successful result is never
examined, whatever numbers or words it contains. A 2xx response from an
`openapi` upstream is always a successful call: the status poll of a failed
run, with an `error` field that quotes the target site's `402`, is returned as
it is and the key stays in use.

A rate-limit error (HTTP 429, or rate-limit wording from an `mcp` upstream) is
passed back to the agent and does not skip a key. The one exception is a 429
that carries one of the phrases in the table: TinyFish answers 429 when a
key's daily Search or Fetch allowance is used up, and that key is skipped.
Tavily's 434 is a capacity error that clears on its own and does not skip a
key either.

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
with `[redacted]` in `args` and `error`. The same replacement is made in every
tool result before it reaches the agent, so an upstream that echoes the key it
was sent (in an error message, a request URL or a dump of request headers)
does not hand it to the agent. A value shorter than six characters is not
replaced. `error_class` is `quota`, `auth` or
`upstream`. `cost` holds `usd`, `credits` or both when the provider reports
one in the response. The two units are recorded as given and never converted:

| Field in the response | Provider | Unit |
|-----------------------|----------|------|
| `costDollars.total` | Exa | `usd` |
| `_meta["parallel/usage"].cost_usd` | Parallel's MCP server | `usd` |
| `creditsUsed`, anywhere in the body | Firecrawl | `credits` |
| `data.creditsCost`, `data.metadata.provider.creditsCost` | Firecrawl, for an Alexandria execution and a provider-routed scrape | `credits` |
| `key_metadata.credits_consumed` | Context.dev | `credits` |
| `usage.credits` | Tavily, only when the call passes `include_usage: true` | `credits` |
| `credits` at the top level | Serper | `credits` |

`creditsUsed` is taken first; the others are read in the order shown, and
only at those places in a JSON body. A Firecrawl catalogue lookup lists a
`creditsCost` price for every capability, and those are not charges.

In live runs Exa's API reported `costDollars` and Firecrawl's reported
`creditsUsed` on scrape and search. Parallel's and Tavily's search responses
carried none, so calls to those are counted but not priced unless a Tavily
call asks for usage (a `pin` default for `include_usage` can add that to
every call). The other rows come from the vendors' documentation and have not
been seen in a live response.

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
- An `openapi` tool sends a JSON body or none. An operation that takes a file
  upload or raw bytes cannot be called, and a binary response is described,
  not delivered.
- An event stream that is cut short is not resumed by the gateway. The agent
  can call again, with `Last-Event-ID` where the API takes it, or poll the
  run's status operation.
- A pin applies to arguments by name. It cannot change an argument inside a
  list, and a `max` does not stop an agent from leaving the argument out.
- A pin cannot rule out one value of an argument. A tool whose price is set
  by a value the agent chooses (Parallel's `generator = "pro"`, a task
  group's run count) is hidden by its preset instead.
- `firecrawl` and `parallel` list two documents each, so the published one
  goes to the host it names, whatever `url` says (see
  [Which host a call goes to](#which-host-a-call-goes-to)). To point either
  preset at another host, such as a self-hosted Firecrawl, set `spec` to one
  document as well as `url`.
- One upstream holds one operation per method, base URL and path. Firecrawl
  runs Alexandria capabilities through the same `POST /scrape` as a page
  scrape, so a second, Alexandria-shaped tool cannot sit beside
  `scrapeAndExtractFromUrl` in the `firecrawl` upstream; `firecrawlmcp`
  offers `alexandria_library_read` for that.
- Brave issues one key per plan. `brave` reaches the Search plan and
  `braveanswers` the Answers plan; the Autosuggest and Spellcheck operations
  are in `specs/brave.yaml` and need a block of their own with
  `spec = "package:specs/brave.yaml"`, that plan's key, and
  `include = ["suggest"]` or `["spellcheck"]`.

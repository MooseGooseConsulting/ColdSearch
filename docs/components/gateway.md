# MCP gateway

`coldsearch mcp` is one MCP server that agents connect to in place of each
search provider's own. It offers every operation of the providers' APIs as a
tool and adds four things: it holds the keys, it records every call in full,
it hands agents the curated skills in `skills/`, and it fetches, maps and
crawls ordinary pages itself so that provider credit is spent only on what
plain HTTP cannot do.

Status: first version (2026-11-27). Verified live against Exa, Firecrawl,
Parallel and Tavily through their API documents, and Bright Data and TinyFish
through their hosted MCP servers. context.dev has a preset taken from its
documentation and has not been run. The native tools are covered by tests
against a local server and were run by hand once against three public sites;
the paid fallback has only been run against a fake upstream.

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

# The gateway's own fetch, map and crawl tools; see "Native tools".
[gateway.native]
# enabled = true
# delay_ms = 500                  # pause between two requests to one host
# fallback = "firecrawl__scrapeAndExtractFromUrl"   # paid tool for pages the gateway cannot read
# fallback_arguments = { url = "{url}", formats = ["markdown"] }
# max_paid_pages = 10             # most pages one crawl may send to the fallback

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
| `coldsearch_fetch`, `coldsearch_map`, `coldsearch_crawl` | Read a URL, list a site's URLs, read many pages of a site, without a provider; see "Native tools" |
| `coldsearch_find_tools`, `coldsearch_describe_tool`, `coldsearch_call_tool` | Lazy mode only |

### `all` and `lazy`

With the six verified upstreams, `all` mode lists 245 tools whose schemas total
about 680 KB. That suits a client that defers tool schemas until needed. For a
client that loads every schema into context, use `lazy`: it lists eight gateway
tools (about 6.5 KB; five and under 2 KB with the native tools turned off), and
the agent finds an upstream tool by keyword, reads its schema, then calls it by
name. `--mode` overrides the config per process, so
one config can serve both kinds of client.

## Native tools

Most fetching, mapping and crawling is ordinary HTTP, and a provider charges
about one credit a page for it. The gateway does that part itself and passes on
only the pages it cannot read. The three tools are listed in both modes and are
on unless `[gateway.native] enabled = false`.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `coldsearch_fetch` | `url`; `format`: `markdown` (default), `text` or `html`; `max_chars` (default 100,000); `allow_paid_fallback` | A JSON item (`url`, `final_url` after a redirect, `status`, `source`, `title`, `truncated`), then the content as a second item |
| `coldsearch_map` | `url`; `limit` (default 200, at most 5,000); `include_subdomains` | JSON: `source` (`sitemap` or `links`), `urls`, `truncated` |
| `coldsearch_crawl` | `url`; `limit` (default 50, at most 500); `max_depth` (default 2); `include`, `exclude`; `allow_paid_fallback`; `max_chars_per_page` (default 20,000) | JSON: `pages` of `{url, title, markdown, source}`, `skipped` of `{url, reason, detail}`, `stats` |

`source` is `direct` for a page the gateway read and `paid` for one that came
through the fallback tool.

### How a page is read

A plain GET, with gzip, deflate and brotli accepted, as
`Mozilla/5.0 (compatible; coldsearch/<version>)`. Every URL passes the SSRF
guard of [ADR 004](../ADRs/004-ssrf-protection.md) before a connection is
opened, and the connection goes to the address that passed. Up to five
redirects are followed, and each hop passes the guard again. Each hop may take
45 seconds, and 15 seconds without a byte ends it. A body is read up to 5 MiB
after decompression; a longer one is cut and marked `truncated`.

HTML is parsed with `parse5` and converted here. Headings, paragraphs, links
(made absolute), lists, code blocks with their language, block quotes and data
tables are kept. Scripts, styles, `<nav>`, form controls and hidden elements
are dropped. When the document has exactly one `<main>`, only it is converted.
A link to another spot on the same page keeps its words and loses its target.
Lists and block quotes nested more than 16 deep are read as plain paragraphs
from there down.

The page, its robots.txt and its sitemaps are text the site chose, and they
are read on the gateway's one thread, so while one is being parsed no other
call moves. Their parsers are written to take time in proportion to the size
of the input. The slowest 5 MiB page found while testing (misnested formatting
tags) converted in about four seconds on a desktop machine, and an ordinary
page of that size in about one; robots.txt and sitemap parsing took
milliseconds at their size caps. A URL whose path and query pass 4,096 characters is not
checked against robots.txt rules; a crawl skips it when the site has any rules.
A response that is not HTML but is text (plain text, JSON, XML, markdown) is
returned as it is. PDFs and other files are not converted; the result says
`unsupported_content_type`.

### When a page needs fallback

The gateway does not run JavaScript and does not try to pass bot protection.
It recognizes when a page needs one of those and says so:

| `reason` | What was seen |
|----------|---------------|
| `http_401`, `http_403`, `http_429`, `http_500` and above | The site refused or failed |
| `challenge_page` | A `cf-mitigated` or `x-vercel-mitigated` challenge header; or a page with under 1,500 characters of text that carries markup only a wall has (a Cloudflare challenge, a DataDome, PerimeterX or Akamai block page, an Anubis challenge); or a script that ordinary pages load too (Cloudflare's `/cdn-cgi/challenge-platform/`, Turnstile, a CAPTCHA, Imperva's or PerimeterX's) together with a 401, 403, 429 or 5xx status, or on a 2xx page with under 200 characters of text |
| `no_text` | A 2xx HTML page with under 200 characters of text that is over 5 KB, or has an empty `#root`, `#__next`, `#app` or `#__nuxt`, or has a `<noscript>` asking for JavaScript |

A 404, a 410 or another 4xx is reported as an error and is not a reason to
pay: a provider would return the same answer.

`coldsearch_fetch` then returns an error result with `needs_fallback: true`,
the reason, and what to do next. `coldsearch_crawl` lists the page under
`skipped` with reason `needs_fallback`.

### Paid fallback

```toml
[gateway.native]
fallback = "firecrawl__scrapeAndExtractFromUrl"
fallback_arguments = { url = "{url}", formats = ["markdown"] }
```

`fallback` names one gateway tool. With `allow_paid_fallback: true`, a page
that needs fallback is read through it: the gateway calls the tool with
`fallback_arguments`, where every `{url}` is replaced by the page's URL,
whether it is a whole value or part of a longer string
(default `{ url = "{url}" }`; a tool that takes a list uses
`{ urls = ["{url}"] }`, one that takes an instruction
`{ prompt = "Read {url} and return markdown" }`). The call takes the same path as an agent's call, so
the upstream's key order applies and the call has its own ledger line under
the upstream's name. When the answer is JSON, the page is the first `markdown`,
`raw_content`, `content` or `text` string in it; otherwise the answer's text is
the page.

The fallback tool may be hidden from agents with `exclude` or `include`. The
gateway still uses it; agents still cannot call it.

A crawl sends at most `max_paid_pages` pages to the fallback (default 10); the
rest are skipped with reason `paid_cap_reached`. A page that robots.txt
disallows is never sent.

A crawl goes on through a page it bought: the same-site targets of the inline
links (`[words](target)`) in the returned markdown are queued like the links
of a page the gateway read. A fallback tool that returns markdown without
links, or with reference-style links only, gives the crawl nowhere to go from
that page; on a site whose start page needs fallback, the crawl then ends
after one page with `stopped: "done"`.

The ledger line and payload file of a native call are redacted with every key
value the gateway has resolved, like an upstream call's, because a paid page
or a paid error is text an upstream returned and may repeat the key it was
sent.

### Map

`coldsearch_map` reads `/robots.txt` for `Sitemap:` lines, or `/sitemap.xml`
when there are none, and follows sitemap indexes, nested indexes and `.gz`
files, up to 20 sitemap files. It returns the URLs on the same site, once each.
When the site has no sitemap it fetches the given URL once and returns that
page's same-site links, with `source: "links"`. It never calls a provider.

"Same site" means the same hostname and port, ignoring a leading `www.` and
the difference between http and https. `include_subdomains` adds hostnames
under the given one.

### Crawl

`coldsearch_crawl` starts at `url` and follows same-site links breadth-first:
the start page, then the pages it links to in page order, then theirs, down to
`max_depth` links away.

- **robots.txt.** Each URL is checked against the rules for user agent
  `coldsearch`, or `*` when the file has no such group. A 4xx answer for
  robots.txt means no rules; a 5xx answer or no answer means the site is not
  crawled (`robots_unreachable`).
- **Pace.** One request at a time per host, `delay_ms` (default 500) after one
  ends before the next starts. The gate is shared by every native call in the
  process, so two agents on one site do not double the rate.
- **`limit`** counts pages asked for, whatever comes back. The site also sees
  one request for robots.txt per hostname, and one more for each redirect a
  page answers with (at most five a page).
- **Redirects.** A page that redirects is read where it lands when that is on
  the same site and robots.txt allows the landing URL. The landing URL has
  been requested by then: the rules are applied to keeping it, not to asking.
- **`include`, `exclude`** are matched against a link's whole path; `*` matches
  any characters, slashes included. The start URL is always read. Links to
  images, archives, PDFs and similar files are not followed.
- **Stopping.** `stats.stopped` is `done`, `limit`, `site_protected` when
  three requests in a row were refused (401, 403, 429 or a challenge page), or
  `cancelled`.
- **Cancelling.** When the agent cancels a native call (the MCP
  `notifications/cancelled` message, which a client also sends when its own
  timeout for the call passes) or its MCP session closes, the call stops at
  its next step:
  the request in flight is dropped, no further request is made, and no further
  page is sent to the paid fallback. A paid call already forwarded is not
  recalled. The ledger line has `ok: false` and `error: "cancelled by the
  client"`. `coldsearch_fetch` and `coldsearch_map` stop the same way.

`skipped` reasons: `robots_disallowed`, `robots_unreachable`, `needs_fallback`,
`paid_cap_reached`, `paid_fallback_failed`, `fetch_failed`,
`redirected_off_site`, `unsupported_content_type`, `http_<status>`.

A crawl runs inside one tool call. Fifty pages take about half a minute plus
the site's response times, so a large `limit` needs a client whose tool
timeout allows it.

### In the ledger

Every native call writes one line and one payload file, with upstream
`coldsearch` and key `coldsearch:keyless`, so `coldsearch_status` counts them
beside provider calls:

```json
{"ts":"2026-11-27T12:00:00.000Z","session":"…","upstream":"coldsearch","tool":"coldsearch_crawl","key":"coldsearch:keyless","attempt":1,"ok":true,"duration_ms":31250,"args":"{\"url\":\"…\"}","result_bytes":412033,"pages":48}
```

`pages` is the number of pages that call read without a provider. A call that
returned nothing has `ok: false`, `error_class: "gateway"` and the reason in
`error`. Pages sent to the fallback are separate lines under their upstream.
`coldsearch` cannot be used as an upstream name.

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
- The native tools do not run JavaScript, do not pass bot protection or a
  login, and do not read PDFs. They do not cache: fetching a URL twice
  requests it twice.
- `coldsearch_fetch` and `coldsearch_map` do not consult robots.txt rules;
  only a crawl does. `Crawl-delay` is not read: the pause is `delay_ms`.
- A crawl has no job to poll. If the client gives up on the call, the crawl
  stops (see Cancelling) and the pages read so far are lost to the client,
  though the requests for them were made; they are in the call's payload file.
  A client that stops waiting without sending a cancellation or closing its
  session is not noticed (in HTTP mode a dropped connection alone does not
  close the session), and the crawl runs to its `limit`.
- The fallback detector is a fixed list of signals. A challenge page it does
  not know is returned as content; check a suspiciously short page.

# Inventory: six providers not yet connected to the MCP gateway

Date: 2026-11-27. Providers: Serper, Brave Search API, Jina AI, Kagi,
Perplexity, SearXNG.

For each provider this file records the programmatic surface as published
today, whether a machine-readable API document or a hosted MCP server exists,
pricing and limits, the failure signals, and the recipe to connect it to
`coldsearch mcp` (`docs/components/gateway.md`).

## Method and limits of this research

- Read-only. No API key was used and no paid endpoint was called. Everything
  below comes from vendor documents fetched today, or from requests sent
  without a key (to read error envelopes, public metadata endpoints, and MCP
  tool lists that answer without a key).
- Where a machine-readable document exists, operations were counted by script
  (`curl` + `python3`), and the tool names the gateway would produce were
  computed by running the repo's own `operationsFromSpec`
  (`dist/gateway/openapi.js`) over the downloaded document.
- `UNCONFIRMED` marks anything that could not be verified from a primary
  source or a keyless request. Behaviour that needs a funded key to observe
  (out-of-credit bodies, authenticated rate-limit bodies) is quoted from vendor
  docs where they state it and marked `UNCONFIRMED` otherwise.
- Serper publishes no reference documentation outside its login-gated
  playground. Its table is reconstructed from the vendor's own public web
  client (the playground page's JavaScript bundle and the homepage's embedded
  example responses). Without a key every Serper path answers `403`, so route
  existence could not be confirmed by request.

## Summary

| Provider | Published API document | Operations (scripted count) | Hosted remote MCP | Recurring free allowance | Key reports own balance | Recommendation |
|---|---|---|---|---|---|---|
| Serper | None | 16 reconstructed (12 search verticals, scrape, account, locations, resolve) | None official | No. 2,500 queries once | `GET /account` (secondary sources) | `openapi`, spec authored in repo |
| Brave | Partial: 8 GET operations at `search.agent.s.brave.app/openapi.json` | 16 documented in the reference (12 paths) + 4 admin | None (official package is stdio or self-hosted HTTP) | Yes. $5 per plan per month | Response headers only (`X-RateLimit-*`) | `openapi`, spec authored in repo; one upstream per plan |
| Jina | Yes: `docs.jina.ai/openapi.json` (three hosts) | 34 (20 paths) + 6 live but undocumented | Yes: `mcp.jina.ai/v1`, 12 tools | No. 10M tokens once per key; Segmenter free | Undocumented dashboard route only | `openapi` (published) + `mcp` preset |
| Kagi | Yes: `kagi.com/api/docs/_bundle/openapi.json` | 2 (v1) + 6 legacy v0 | Yes: `mcp.kagi.com/mcp`, 2 tools | No | v0: `meta.api_balance`. v1: no | `openapi` (published); legacy v0 optional |
| Perplexity | Yes: `docs.perplexity.ai/openapi.json` | 50 (40 paths) | Yes: `api.perplexity.ai/mcp`, 5 tools | No. One-time sign-up credit on some accounts | No | `openapi` (published) with an `include` list, + `mcp` preset |
| SearXNG | None | 4 useful routes | None official | Free (self-hosted) | Not applicable | `openapi`, spec authored in repo; deployment URL from config |

## Gateway facts that shape every recipe

Read from `src/gateway/openapi.ts`, `config.ts`, `core.ts` and `ledger.ts`
as they stand today.

| Fact | Consequence |
|---|---|
| Only `in: path` and `in: query` parameters and an `application/json` body become tool arguments. `in: header` parameters are dropped. | Options a vendor takes only as headers are unreachable per call: Brave `X-Loc-*` and `Api-Version`, Jina Reader `X-*`. Jina also accepts each option as a query parameter, so nothing is lost there. A fixed `headers` table can pin one value per upstream. |
| A `servers` URL is honoured on a path or an operation. The document-level `servers` is ignored; the upstream `url` is the default base. | Jina's unified document works as published (it sets `servers` per operation). An authored Serper document must put `servers` on the scrape and locations operations. |
| `spec` takes a list; a later document's duplicate method + server + path is dropped. | A hand-written supplement can sit beside a published document. |
| A body whose schema is not a plain object (`allOf`, `oneOf`) is passed as one `body` argument. | Perplexity `POST /search`, Jina `POST /v1/embeddings`, `/v1/rerank`, and Reader/Search POST variants take `body`. Prefer the GET variants for Jina. |
| A `multipart/form-data` operation becomes a tool with no body. | Perplexity `createSkill`, `updateSkill`, `createFile` cannot work; exclude them. |
| A path parameter is sent through `encodeURIComponent`. | Jina `GET /{url}` would receive `https%3A%2F%2F…`. Whether Reader decodes it is `UNCONFIRMED`; use `GET /?url=`. |
| One credential per upstream, in one header or one query parameter. | Brave issues a separate key per plan, so each plan needs its own upstream. Kagi v0 (`Bot `) and v1 (`Bearer `) need separate upstreams. |
| The response body is returned as text; response headers are discarded. | Brave's only quota signal (`X-RateLimit-Remaining`) is lost today. Streaming endpoints return raw SSE text. |
| Out-of-credit is recognised by `402`, `432`, and phrases such as `insufficient credit`. `429` never skips a key. | Serper (`400 Not enough credits`) is not recognised. Kagi v1 reports an exhausted usage limit as `429`. |
| A rejected key is recognised by `401`, `unauthorized`, `invalid api key`, `invalid token`. | Brave answers `422 SUBSCRIPTION_TOKEN_INVALID`, which matches none of these. |
| Cost is read from `costDollars.total`, `creditsUsed`, or `_meta["parallel/usage"].cost_usd`. | None of the six report cost in those fields. Serper returns `credits`, Perplexity `usage.cost.total_cost`, Jina `usage.tokens`. |
| A spec file path is read as given, relative to the process working directory. | A preset that points at a spec shipped in the repo needs a package-relative path, the way `defaultSkillsDir()` resolves `skills/`. |
| A preset must carry a `url`. | SearXNG cannot have a complete preset; its URL belongs to the deployment. |

---

## 1. Serper (serper.dev)

### 1.1 API document

None published. `https://serper.dev/docs` answers 404 and
`https://serper.dev/openapi.json` 404. The reference is the login-gated
playground at `https://serper.dev/playground`.

- Base URL: `https://google.serper.dev` (search verticals, account),
  `https://scrape.serper.dev` (page scrape), `https://api.serper.dev`
  (locations list).
- Auth: header `X-API-KEY: <key>`, no prefix. The vendor client also builds
  GET requests with the key in an `apiKey` query parameter.
- Requests: `POST` with a JSON body. The vendor client offers a GET form with
  the same fields as query parameters, and a batch form whose body is a JSON
  array of query objects (maximum batch size `UNCONFIRMED`).

Operation list, complete enough to author an OpenAPI file. "Default set"
means `q` (required), `location`, `gl` (country, default `us`), `hl`
(language, default `en`), `num`, `page`, `tbs`, `autocorrect`. `tbs` takes
`qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`.

| Operation | Method, host, path | Body fields | Response top level | Credits per call | Evidence |
|---|---|---|---|---|---|
| search | `POST google.serper.dev/search` | Default set | `searchParameters`, `knowledgeGraph{title,type,website,imageUrl,description,descriptionSource,descriptionLink,attributes}`, `organic[{title,link,snippet,sitelinks,position}]`, `peopleAlsoAsk[{question,snippet,title,link}]`, `relatedSearches[{query}]` | 1 | Client code + homepage example |
| images | `POST google.serper.dev/images` | Default set | `images[{title,imageUrl,imageWidth,imageHeight,thumbnailUrl,thumbnailWidth,thumbnailHeight,source,domain,link,googleUrl,position}]` | 1; doubled when `num` > 10 | Client code + example |
| videos | `POST google.serper.dev/videos` | Default set | `videos[{title,link,snippet,imageUrl,duration,source,channel,date,position}]` | 1 | Client code + example |
| places | `POST google.serper.dev/places` | Default set (`num` not sent) | `places[{position,title,address,latitude,longitude,rating,ratingCount,category,phoneNumber,website,cid}]` | 1 | Client code + example |
| maps | `POST google.serper.dev/maps` | `q`, `hl`, `ll` (`@latitude,longitude,zoom`), `placeId`, `cid`, `page` | `ll`, `places[{position,title,address,latitude,longitude,rating,ratingCount,type,types,website,phoneNumber,description,cid,placeId}]` | 3 | Client code + example |
| reviews | `POST google.serper.dev/reviews` | one of `cid`, `fid`, `placeId`; `gl`, `hl`, `sortBy` (`mostRelevant`, `newest`, `highestRating`, `lowestRating`), `topicId`, `nextPageToken` | `reviews[]`, `nextPageToken` (`UNCONFIRMED`) | 1 | Client code; no public example |
| news | `POST google.serper.dev/news` | Default set | `news[{title,link,snippet,date,source,imageUrl,position}]` | 1 | Client code + example |
| shopping | `POST google.serper.dev/shopping` | Default set | `shopping[{title,source,link,price,delivery,imageUrl,rating,ratingCount,offers,productId,position}]` | 2 | Client code + example |
| lens | `POST google.serper.dev/lens` | `url` (image URL, required), `location`, `gl`, `hl`, `tbs` | `organic[]` (`UNCONFIRMED`) | 3 | Client code; no public example |
| scholar | `POST google.serper.dev/scholar` | `q`, `location`, `gl`, `hl`, `autocorrect`, `tbs`, `page` (`num` not sent) | `organic[{title,link,publicationInfo,snippet,year,citedBy}]` | 1 | Client code + example |
| patents | `POST google.serper.dev/patents` | Default set | `organic[{title,snippet,link,priorityDate,filingDate,grantDate,publicationDate,inventor,assignee,publicationNumber,language,thumbnailUrl,pdfUrl,figures}]` | 1 | Client code + example |
| autocomplete | `POST google.serper.dev/autocomplete` | `q`, `location`, `gl`, `hl` | `suggestions[{value}]` | 1 | Client code + example |
| webpage | `POST scrape.serper.dev/` (root path) | `url` (required), `includeMarkdown`, `includeImages`, `includeLinks`, `includeVideos` | `text`, `markdown`, `metadata`, `credits` (`UNCONFIRMED`) | 2, 6 or 10 by page difficulty; "the number of credits used is returned in the response" | Client code |
| account | `GET google.serper.dev/account` | none | `{"balance": <credits>, "rateLimit": <queries per second>}` | 0 | Two third-party sources; not in vendor docs |
| locations | `GET api.serper.dev/locations?q=&limit=` | query `q`, `limit` | `[{name,canonicalName,googleId,countryCode,targetType}]` | 0, no key needed | Verified today without a key |
| resolve | `POST google.serper.dev/resolve` | JSON array of Google redirect links | `UNCONFIRMED` | 0, "own rate limit" | Client code; labelled "New" |

Also in the vendor client but gated to staff or named accounts, so not part
of the public surface: `product-reviews`, `maps-autocomplete`,
`serper-search` on `search.serper.dev` ("Search + Scrape", beta),
`bing-search` and `bing-images` on `bing.serper.dev` (beta), `search-full`.

Corrections to the repo's leads (`src/registry/tool-profiles.ts`):
`serper.webpage` is listed as `scrape.serper.dev/webpage`; the vendor client
posts to the root path. `serper.shots` (`scrape.serper.dev/shots`) does not
appear in the vendor client: `UNCONFIRMED`, drop it. `serper.locations`
exists and needs no key. The 12 search verticals and the scrape operation are
all offered to ordinary accounts.

### 1.2 MCP

- Hosted remote MCP: none official. `mcp.serper.dev` did not answer.
- Local package: none official. Community servers exist
  (`garylab/serper-mcp-server`, 13 tools: the 12 verticals and `webpage`;
  `marcopesani/mcp-server-serper`).

### 1.3 Pricing, limits, balance

| Item | Value | Source |
|---|---|---|
| Free allowance | 2,500 queries, one time, no card | Homepage |
| Top-ups | $50 for 50k credits ($1.00/1k); $375 for 500k ($0.75/1k); $1,250 for 2.5M ($0.50/1k); $3,750 for 12.5M ($0.30/1k). No subscription | Homepage |
| Credit lifetime | 6 months | Homepage |
| Rate limit | 50, 100, 200, 300 queries per second by top-up tier. Free-tier limit not stated; one third-party fixture shows `rateLimit: 50` on a free account | Homepage; `UNCONFIRMED` for free |
| Billing rule | Credits deducted on successful responses; at zero "we will stop accepting new queries" | Homepage FAQ |
| Balance self-report | `GET https://google.serper.dev/account` with `X-API-KEY` returns `{"balance", "rateLimit"}` | Third-party sources only |

### 1.4 Failure signals

| Condition | Signal | Evidence |
|---|---|---|
| No key | `403 {"message":"Unauthorized. Sign up for a free account.","statusCode":403}` on every path | Verified today |
| Wrong key | `403 {"message":"Unauthorized.","statusCode":403}` | Verified today |
| Out of credit | `400 {"message":"Not enough credits","statusCode":400}` | Third-party reports; `UNCONFIRMED` |
| Rate limited | `429`; body `UNCONFIRMED` | Not documented |

### 1.5 Recommendation

Connect as `openapi` with a spec authored and shipped in the repo. It is the
cheapest Google SERP in the set and the only source of Google Scholar,
Patents, Lens, Maps and Reviews. Author every row of the table except
`resolve`, which waits until its body is confirmed.

---

## 2. Brave Search API

### 2.1 API document

There is no full OpenAPI document. `api-dashboard.search.brave.com/openapi.json`
answers 404 and the reference pages carry no link to one. Two machine-readable
sources exist:

- `https://api-dashboard.search.brave.com/llms.txt` indexes every doc page as
  markdown (`…/index.html.md`). The 16 operation pages were parsed by script
  for the table below.
- `https://search.agent.s.brave.app/openapi.json` is an OpenAPI 3.1 document
  published for Brave's pay-per-request proxy. It lists 8 GET operations whose
  paths (`/res/v1/…`) are the same as on `api.search.brave.com`, with a
  reduced parameter set (web search: 7 of 20 parameters). It has no `servers`
  and no security scheme, so it can be used against `api.search.brave.com`
  with a subscription key. The gateway builds `webSearch`, `llmContext`,
  `newsSearch`, `videosSearch`, `imagesSearch`, `localPlaceSearch`,
  `localPois`, `localDescriptions` from it (8 tools, 6.8 KB).

Connection facts:

- Base URL: `https://api.search.brave.com/res` (paths below start `/v1`).
- Auth: header `X-Subscription-Token: <key>`, no prefix.
- Each plan issues its own key: "After you've activated a plan, you will need
  to generate a new key … this applies to all plans." Four plans: Search,
  Answers, Autosuggest, Spellcheck.
- Optional headers on every operation: `Api-Version` (`YYYY-MM-DD`, default
  latest), `Cache-Control: no-cache`, `User-Agent`, `Accept`.
- Error envelope on every operation:
  `{"type":"ErrorResponse","error":{"id","status","code","detail","meta"},"time"}`.

Operations. Where a path has both GET and POST, POST takes the same fields in
a JSON body.

| Operation | Method, path | Plan | Parameters | 200 response top level |
|---|---|---|---|---|
| Web search | `GET`, `POST /v1/web/search` | Search | `q`* (600 chars, 75 words), `country`, `search_lang`, `ui_lang`, `count` 1-20, `offset` 0-9, `safesearch` (`off`, `moderate`, `strict`), `spellcheck`, `freshness` (`pd`, `pw`, `pm`, `py`, `YYYY-MM-DDtoYYYY-MM-DD`), `text_decorations`, `result_filter` (`discussions`, `faq`, `infobox`, `news`, `query`, `summarizer`, `videos`, `web`, `locations`), `units`, `goggles`, `goggles_id` (deprecated), `extra_snippets`, `summary`, `enable_rich_callback`, `include_fetch_metadata`, `operators`, `operators_fallback`. Headers: `X-Loc-Lat`, `X-Loc-Long`, `X-Loc-Timezone`, `X-Loc-City`, `X-Loc-State`, `X-Loc-State-Name`, `X-Loc-Country`, `X-Loc-Postal-Code` | `type`, `query`, `web`, `news`, `videos`, `discussions`, `faq`, `infobox`, `locations`, `mixed`, `rich`, `summarizer` |
| LLM Context | `GET`, `POST /v1/llm/context` | Search | `q`*, `country`, `search_lang`, `count` 1-50, `safesearch`, `spellcheck`, `operators`, `operators_fallback`, `maximum_number_of_urls` 1-50, `maximum_number_of_tokens` 1024-32768 (default 8192), `maximum_number_of_tokens_per_url` 512-8192, `context_threshold_mode` (`disabled`, `strict`, `lenient`, `balanced`), `goggles`, `freshness`, `enable_local`, `enable_source_metadata`. Headers: `X-Loc-*` as above without timezone | `grounding{generic[{url,title,snippets[]}], poi{}, map[]}`, `sources{}` |
| News search | `GET`, `POST /v1/news/search` | Search | `q`* (400 chars, 50 words), `search_lang`, `ui_lang`, `country`, `safesearch`, `count` 1-50, `offset` 0-9, `spellcheck`, `freshness`, `extra_snippets`, `goggles`, `include_fetch_metadata`, `operators`, `operators_fallback` | `type`, `query`, `results` |
| Video search | `GET`, `POST /v1/videos/search` | Search | `q`*, `search_lang`, `ui_lang`, `country`, `safesearch`, `count` 1-50, `offset` 0-9, `spellcheck`, `freshness`, `include_fetch_metadata`, `operators`, `operators_fallback` | `type`, `query`, `results`, `extra` |
| Image search | `GET /v1/images/search` | Search | `q`*, `search_lang`, `country`, `safesearch` (`off`, `strict`), `count` 1-200 (default 50, no paging), `spellcheck` | `type`, `query`, `results`, `extra` |
| Place search | `GET /v1/local/place_search` | Search | `q`, `latitude`, `longitude`, `location`, `radius` (metres, a bias), `count` 1-100, `country`, `search_lang`, `ui_lang`, `units`, `safesearch`, `spellcheck`, `geoloc` (`<lat>x<long>`) | `type`, `query`, `results`, `location`, `addresses`, `cities`, `countries`, `regions`, `neighborhoods`, `streets`, `mixed` |
| Local POIs | `GET /v1/local/pois` | Search | `ids`* (repeat `ids=a&ids=b`; ids live about 8 hours), `search_lang`, `ui_lang`, `units`. Headers: `X-Loc-Lat`, `X-Loc-Long` | `type`, `results` |
| POI descriptions | `GET /v1/local/descriptions` | Search | `ids`* | `type`, `results` |
| Rich search | `GET /v1/web/rich` | Search | `callback_key`* (from a web search sent with `enable_rich_callback=true`) | `type`, `results`, `response_callback_info` |
| Suggest | `GET /v1/suggest/search` | Autosuggest | `q`*, `lang`, `country`, `count` 1-20 (default 5), `rich` | `type`, `query`, `results` |
| Spellcheck | `GET /v1/spellcheck/search` | Spellcheck | `q`*, `lang`, `country` | `type`, `query`, `results` |
| Answers | `POST /v1/chat/completions` | Answers | `messages`* (exactly one `user` message), `model` (`brave-pro` default, `brave`), `stream` (default `true`), `max_completion_tokens`, `country`, `language`, `safesearch`, `web_search_options{search_context_size, user_location}`, `enable_entities`, `enable_citations`, `enable_research` (all three need `stream=true`), `research_maximum_number_of_queries` 1-50, `research_maximum_number_of_iterations` 1-5, `research_maximum_number_of_seconds` 1-300, `research_maximum_number_of_tokens_per_query`, `research_maximum_number_of_results_per_query`, `research_allow_thinking`; `metadata` and `seed` accepted and ignored | OpenAI chat completion: `id`, `object`, `created`, `model`, `choices`, `usage{prompt_tokens,completion_tokens,total_tokens}` |

Scripted count: 16 operations on 12 paths (11 GET, 5 POST).

Not in the table:

- Summarizer (`/res/v1/summarizer/search` and its siblings). Brave's own
  pay-per-request notes say "Brave has deprecated it", and the official MCP
  server marks `brave_summarizer` deprecated in favour of Answers. The
  `summary` parameter and `summarizer` response key remain on web search.
- Admin API, a separate read-only surface with its own key type
  (`Authorization: Bearer bsk_admin_live_…` or `X-Admin-Key`), which a search
  key cannot call: `GET /admin/v1/usage` (scope `usage:read`),
  `GET /admin/v1/api_keys`, `GET /admin/v1/admin_keys`, `GET /admin/v1/me`.
  It "reports usage, not cost" and has no balance field.
- Pay-per-request proxy `https://search.agent.s.brave.app` (x402 stablecoin
  payment in place of a key, $0.005 per request on 8 paths). Not relevant to a
  key-holding gateway.

Corrections to the repo's leads: the adapter cites
`api.search.brave.com/app/documentation/…`; documentation now lives at
`api-dashboard.search.brave.com/documentation`. The registry lists 6 Brave
tools (3 marked candidate); the reference documents 16 operations. News,
image and video search are confirmed.

### 2.2 MCP

- Hosted remote MCP: none. The Brave docs index does not mention MCP;
  `mcp.brave.com` and `mcp.search.brave.com` did not answer.
- Official local package: `@brave/brave-search-mcp-server` (also Docker image
  `mcp/brave-search`). Default transport is stdio since 2.x; it can serve
  Streamable HTTP when self-hosted (`BRAVE_MCP_TRANSPORT=http`, port 8080).
  9 tools: `brave_web_search`, `brave_local_search`, `brave_video_search`,
  `brave_image_search`, `brave_news_search`, `brave_answers`,
  `brave_summarizer` (deprecated), `brave_place_search`, `brave_llm_context`.
  A self-hosted instance would hold the key itself, so the gateway's key
  rotation would not apply to it.

### 2.3 Pricing, limits, balance

| Plan | Price | Free allowance | Capacity |
|---|---|---|---|
| Search (web, LLM context, news, videos, images, places, rich) | $5.00 per 1,000 requests | $5 credit every month, about 1,000 requests | 50 requests per second |
| Answers | $4.00 per 1,000 queries + $5.00 per 1M input tokens + $5.00 per 1M output tokens | $5 credit every month | 2 requests per second |
| Autosuggest | $5.00 per 10,000 requests | $5 credit every month, about 10,000 requests | 100 requests per second |
| Spellcheck | $5.00 per 10,000 requests | $5 credit every month, about 10,000 requests | 100 requests per second |

- There is no standalone free plan; a card is required. The monthly $5 is
  "replaced each month rather than carried over". With all four plans active
  the free credit totals $20 a month.
- New accounts are prepaid: when the balance reaches $0 "your service will be
  paused — further API requests are rejected". Older postpaid plans bill
  overage instead.
- "Only successful requests (non-error responses) are counted against your
  quota and billed."
- Rate limit window: 1-second sliding window per plan.
- Balance self-report: none in the body. Every response carries
  `X-RateLimit-Limit` (for example `1, 15000`), `X-RateLimit-Policy`
  (`1;w=1, 15000;w=2592000`), `X-RateLimit-Remaining` (`1, 1000`) and
  `X-RateLimit-Reset` (seconds). The second figure is the monthly window; `0`
  in the limit means unlimited. What the monthly figure shows on a prepaid
  plan is `UNCONFIRMED`.

### 2.4 Failure signals

| Condition | Signal | Evidence |
|---|---|---|
| No key | `422`, `error.code = "VALIDATION"`, `meta.errors[].loc = ["header","x-subscription-token"]` | Verified today |
| Wrong key | `422`, `error.code = "SUBSCRIPTION_TOKEN_INVALID"`, "The provided subscription token is invalid." | Verified today |
| Rate limited | `429` with the error envelope; wait `X-RateLimit-Reset` | Docs |
| Out of credit, Answers | `402` is documented on `POST /v1/chat/completions` | Docs |
| Out of credit, search endpoints | "requests are rejected"; the reference lists only 404, 422, 429 for these paths. Status and code `UNCONFIRMED` | Docs |
| Endpoint not in plan | `403` documented on LLM Context and Answers; code `UNCONFIRMED` | Docs |

### 2.5 Recommendation

Connect as `openapi` with a spec authored and shipped in the repo (16
operations, full parameters), one upstream per plan filtered with `include`.
The published 8-operation document works as an interim with no authoring but
omits Answers, Suggest, Spellcheck, Rich, and most parameters. Brave is the
only independent index in the set with a recurring free allowance.

---

## 3. Jina AI

### 3.1 API documents

Four published documents, all fetched and counted today:

| Document | Host it describes | Operations | Notes |
|---|---|---|---|
| `https://docs.jina.ai/openapi.json` (OpenAPI 3.1, 893 KB) | `r.jina.ai`, `s.jina.ai`, `api.jina.ai` | 34 on 20 paths | Unified. Sets `servers` on each Reader and Search operation, and has `operationId`s. Identical to `api-docs/openapi.json` in `jina-ai/meta-prompt`. **Use this one.** |
| `https://api.jina.ai/openapi.json` | `api.jina.ai` | 11 | Subset of the unified document |
| `https://r.jina.ai/openapi.json` | `r.jina.ai` | 19 | No `operationId`s; the gateway would name tools `get_`, `post_` |
| `https://s.jina.ai/openapi.json` | `s.jina.ai` | 6 | Same |

- Base URLs: `https://api.jina.ai`, `https://r.jina.ai`, `https://s.jina.ai`
  (EU processing: `eu.r.jina.ai`, `eu.s.jina.ai`),
  `https://deepsearch.jina.ai`.
- Auth: `Authorization: Bearer <key>` everywhere; one key covers every
  product. Reader accepts requests without a key at a lower limit; Search
  requires one.
- Send `Accept: application/json` to get the JSON envelope from Reader and
  Search (the gateway always sends it).

The 34 operations of the unified document:

| Group | Operations | Gateway tool names |
|---|---|---|
| Reader, read (5) | `GET r.jina.ai/` (`?url=`), `POST r.jina.ai/`, `GET r.jina.ai/{url}`, `POST r.jina.ai/{url}`, `POST r.jina.ai/read` | `reader_get_root`, `reader_post_root`, `reader_get_url`, `reader_post_url`, `reader_post_read` |
| Reader, housekeeping (14) | `GET`/`POST /ephemeral/{encodedFid}`, five methods each on `/echo` and `/echo/{rest}`, `GET /.well-known/http-message-signatures-directory`, `GET /bot` | `reader_*ephemeral*`, `reader_*echo*`, `get_well_known_…`, `reader_get_bot` |
| Search (4) | `GET`/`POST s.jina.ai/{q}`, `GET`/`POST s.jina.ai/search` | `search_get_q`, `search_post_q`, `search_get_search`, `search_post_search` |
| Embeddings, rerank (2) | `POST /v1/embeddings`, `POST /v1/rerank` | `post_v1_embeddings`, `post_v1_rerank` |
| Models (2) | `GET /v1/models`, `GET /v1/models/{model_id}` (no key needed; lists per-token prices) | `get_v1_models`, `get_v1_models_model_id` |
| Generative (1) | `POST /v1/chat/completions` (OCR and vision models) | `post_v1_chat_completions` |
| Batch embeddings (6) | `POST /v1/batch/embeddings`, `GET /v1/batch/{batch_id}`, `DELETE /v1/batch/{batch_id}`, `GET /v1/batches`, `GET /v1/batch/{batch_id}/output`, `GET /v1/batch/{batch_id}/errors` | `post_v1_batch_embeddings`, `get_v1_batch_batch_id`, … |

All 34 tools together carry 390 KB of schema; the five Reader read tools and
four Search tools account for most of it (17 to 61 KB each).

Reader options (50 query parameters, each with an `X-…` header equivalent):
`url`, `respondWith` (`markdown`, `html`, `text`, `screenshot`, `pageshot`,
`content`, or a model such as `readerlm-v2`, `jina-ocr-v1`), `engine`
(`auto`, `browser`, `curl`, `cf-browser-rendering`), `timeout`,
`targetSelector`, `waitForSelector`, `removeSelector`, `withLinksSummary`,
`withImagesSummary`, `withGeneratedAlt`, `retainImages`, `retainLinks`,
`retainMedia`, `noCache`, `cacheTolerance`, `withIframe`, `withShadowDom`,
`tokenBudget`, `maxTokens`, `markdownChunking`, `locale`, `proxy`,
`proxyUrl`, `setCookies`, `robotsTxt`, `page`, `pdf`, `html`, `file`,
`instruction`, `jsonSchema`, `preset`, and others. Search adds `q`, `num`,
`count`, `gl`, `hl`, `location`, `type` (`web`, `images`, `news`),
`provider` (`google`, `bing`, `reader`), `site`, `filetype`, `ext`,
`intitle`, `loc`, `nfpr`, `fallback`.

Reader response with `Accept: application/json`:
`{"code":200,"status":20000,"data":{title,description,url,content,publishedTime,links,images,usage{tokens},…},"meta"}`.
Search returns the same envelope with `data` as an array.

Live but absent from every published document and from the current
meta-prompt (`curl docs.jina.ai`, version 14). Each route was confirmed to
exist today by its keyless response; request bodies are from earlier versions
of the vendor's meta-prompt in `jina-ai/meta-prompt` (`v9.txt`, `v11.txt`).

| Operation | Method, host, path | Body | Response | Keyless response today |
|---|---|---|---|---|
| Segment | `POST api.jina.ai/v1/segment` (also `POST segment.jina.ai/`); `GET /v1/segment?content=` counts tokens | `content`*, `tokenizer` (`cl100k_base` default, `o200k_base`, `p50k_base`, `r50k_base`, `p50k_edit`, `gpt2`), `return_tokens`, `return_chunks`, `max_chunk_length` (default 1000), `head`, `tail` | `{num_tokens, tokenizer, usage{tokens}, num_chunks, chunk_positions[[start,end]], tokens, chunks[]}` | `200` with a body; free, "your key won't be charged" |
| Classify | `POST api.jina.ai/v1/classify` | `model` (`jina-embeddings-v3` for text, `jina-clip-v2` for images, `jina-embeddings-v4` for either) or `classifier_id`; `input`* (strings, or `{text}` / `{image}` objects); `labels`* | `{usage{total_tokens}, data[{object:"classification", index, prediction, score, predictions[{label,score}]}]}` | `401` |
| Train classifier | `POST api.jina.ai/v1/train` | `UNCONFIRMED` (earlier docs: `model` or `classifier_id`, `access`, `input[{text,label}]`, `num_iters`) | `UNCONFIRMED` | `401` |
| DeepSearch | `POST deepsearch.jina.ai/v1/chat/completions` | `model`* (`jina-deepsearch-v1`, `jina-deepsearch-v2`), `messages`*, `stream` (vendor: keep on, or expect `524` timeouts), `reasoning_effort` (`low`, `medium`, `high`), `budget_tokens`, `max_attempts`, `no_direct_answer`, `max_returned_urls`, `response_format{type:"json_schema", json_schema}`, `boost_hostnames[]`, `bad_hostnames[]`, `only_hostnames[]` | OpenAI chat completion chunks; final message carries `annotations`, `visitedURLs`, `readURLs`, `usage` | `401 {"error":"Unauthorized: API key required"}` |
| DeepSearch models | `GET deepsearch.jina.ai/v1/models` | none | `{object:"list", data[{id, object, created, owned_by}]}` | `200`, two models |
| Multi-vector | `POST api.jina.ai/v1/multi-vector` | `UNCONFIRMED` | `UNCONFIRMED` | `401` |

Classifier, Segmenter and DeepSearch still have product pages on jina.ai, and
the Segmenter FAQ lists Classifier and Segmenter as covered by the shared
key. Their absence from the current reference is a signal they are no longer
promoted; whether they are scheduled for removal is `UNCONFIRMED`.

### 3.2 MCP

- Hosted remote MCP: `https://mcp.jina.ai/v1` (alias `/sse`), Streamable
  HTTP, `Authorization: Bearer <key>`, key optional. Server version 1.11.1.
  Tool list fetched today without a key: 12 tools, 8.7 KB of schema.

| Tool | Arguments | Key needed |
|---|---|---|
| `primer` | none | No |
| `read_url` | `url`*, `withAllLinks`, `withAllImages`, `question`, `chunk_size`, `topk`, `ocr`, `page` | Only with `question` |
| `capture_screenshot_url` | `url`*, `firstScreenOnly`, `return_url` | No |
| `guess_datetime_url` | `url`* | No |
| `search_web` | `query`* (string or array), `num`, `tbs`, `location`, `gl`, `hl` | Yes |
| `search_arxiv` | `query`*, `num`, `tbs` | Yes |
| `search_ssrn` | `query`*, `num`, `tbs` | Yes |
| `search_images` | `query`*, `num`, `return_url`, `tbs`, `location`, `gl`, `hl` | Yes |
| `search_jina_blog` | `query`*, `num`, `tbs` | No |
| `sort_by_relevance` | `query`*, `documents`*, `top_n` | Yes |
| `deduplicate_strings` | `strings`*, `k` | Yes |
| `extract_pdf` | `id`, `url`, `max_edge`, `type` | Yes |

  Tools can be filtered on the server with query parameters on the URL:
  `include_tools`, `exclude_tools`, `include_tags`, `exclude_tags` (tags:
  `search`, `read`, `utility`, `rerank`), and `max_tokens` to cap `read_url`.
  A failed call returns `isError: true` with a plain-text reason.
- Local package: none; clients without remote MCP support use `mcp-remote`
  against the same URL. Source: `github.com/jina-ai/MCP`.
- Not reachable through the REST documents: `search_arxiv`, `search_ssrn`,
  `extract_pdf`, `guess_datetime_url`, `deduplicate_strings`, and `read_url`
  with a `question` (returns ranked passages in place of the whole page).

### 3.3 Pricing, limits, balance

| Item | Value | Source |
|---|---|---|
| Billing unit | Tokens, shared by all products on one key. Top up as needed; auto top-up available | Reader page |
| Free allowance | "Every new API key comes with 10M free tokens". One time, per key | Reader page |
| Free products | Segmenter; Reader without a key | Product pages |
| Per-token price | $0.05 per 1M tokens for most embedding, reranker and reader models; $0.02 per 1M for the `v5` nano models; `jina-ocr-v1` $0.50 per 1M input, $2.00 per 1M output | `GET https://api.jina.ai/v1/models`, `pricing.prompt` / `pricing.completion` |
| Reader metering | Tokens in the output | Rate-limit table |
| Search metering | "Every request costs a fixed number of tokens, starting from 10,000 tokens" | Rate-limit table |
| Top-up package prices | `UNCONFIRMED` (rendered client-side) | |
| DeepSearch price and limits | `UNCONFIRMED` (absent from today's rate-limit table) | |

Rate limits (per key when a key is sent, otherwise per IP):

| Endpoint | No key | Free key | Paid key | Premium key |
|---|---|---|---|---|
| `r.jina.ai` | 20 RPM | 500 RPM | 500 RPM | 5,000 RPM |
| `s.jina.ai` | blocked | 100 RPM | 100 RPM | 1,000 RPM |
| `api.jina.ai/v1/embeddings`, `/v1/rerank` | blocked | 100 RPM, 100K TPM | 500 RPM, 2M TPM | 5,000 RPM, 50M TPM |

There is also an IP limit of 10,000 requests per 60 seconds.

Balance self-report: no documented endpoint. The vendor says to "enter your
API key in the 'API Key & Billing' tab". The dashboard's own route,
`GET https://dash.jina.ai/api/v1/api_key/fe_user?api_key=<key>`, answers
`401 {"detail":"Invalid API key."}` to a wrong key and `422` when the
parameter is missing, so it exists; a third-party project reads
`wallet.total_balance` from it. It is undocumented, puts the key in the URL,
and its response shape is `UNCONFIRMED`. Each response reports the tokens it
used (`data.usage.tokens`, `usage.total_tokens`).

### 3.4 Failure signals

Reader and Search envelope:
`{"data":null,"code":<http>,"name":"<ErrorName>","status":<5 digits>,"message","readableMessage"}`.

| Condition | Signal | Evidence |
|---|---|---|
| No key, Search | `401 AuthenticationRequiredError`, `status 40103` | Verified today |
| No key, Reader | Normally served at 20 RPM. Today it answered `401 AuthenticationRequiredError` (`40103`, "blocked from performing anonymous queries due to bad network reputation"), so keyless Reader depends on the caller's network | Verified today |
| Wrong key | `401 AuthenticationFailedError`, `status 40102` | Published document |
| Out of tokens | `402 InsufficientBalanceError`, `status 40203` | Published document |
| Feature above tier | `402 TierFeatureConstraintError`, `status 40202` | Published document |
| Budget exceeded | `409 BudgetExceededError`, `status 40904` | Published document |
| Rate limited | `429 RateLimitTriggeredError`, `status 42903`, with `retryAfter` and `retryAfterDate` | Published document |
| No key, `api.jina.ai` | `401 {"detail":"Authentication required…","request_id","code":"AUTH_MISSING_API_KEY"}` | Verified today |
| Out of tokens or rate limited, `api.jina.ai` | `UNCONFIRMED` | |

Note that a feature-tier refusal shares status `402` with an empty balance.

### 3.5 Recommendation

Connect as `openapi` from the published unified document, with an `exclude`
list for the housekeeping operations and the oversized POST variants. Add the
hosted MCP as a second preset for the six tools the REST documents lack. A
small authored supplement for Segment (free) and DeepSearch is optional;
skip Classify and Train unless a workflow needs them.

Correction to the repo's leads: the Jina adapter sends `X-Return-Format`.
The published Reader document names the option `X-Respond-With` /
`respondWith`; the meta-prompt still documents both. Whether they are
equivalent is `UNCONFIRMED`. The registry's `jina.search` (candidate) and
`jina.deepSearch` (candidate) both exist.

---

## 4. Kagi

### 4.1 API documents

Kagi replaced its beta (v0) API with v1 during 2026. v1 has a published
OpenAPI 3.0 document:

- Document: `https://kagi.com/api/docs/_bundle/openapi.json` (also
  `…/openapi.yaml` and `https://kagi.com/api/docs/_spec/openapi.yaml`; same
  content).
- Base URL: `https://kagi.com/api/v1` (declared only at document level, so the
  upstream `url` must carry it).
- Auth: `Authorization: Bearer <key>`.
- 2 operations. The gateway names them `search` and `extractContent` (7.8 KB).

| Operation | Method, path | Body | 200 response |
|---|---|---|---|
| `search` | `POST /search` | `query`*, `workflow` (`search`, `images`, `videos`, `news`, `podcasts`), `format` (`json`, `markdown`; experimental), `lens_id`, `lens{sites_included, sites_excluded, keywords_included, keywords_excluded, file_type, time_after, time_before, time_relative, search_region}`, `timeout`, `page` 1-10, `limit` 1-1024, `filters{region, after, before, safe_search}`, `extract{count, timeout}` (replaces `snippet` with page markdown), `personalizations{domains[{domain,kind}], regexes[]}` | `{meta{trace,node,ms}, data{search[], image[], video[], news[], podcast[], podcast_creator[], adjacent_question[], direct_answer[], interesting_news[], interesting_finds[], infobox[], code[], package_tracking[], …}}`; each item `{url, title, snippet, time, image, props}` |
| `extractContent` | `POST /extract` | `pages`* (1-10 objects `{url}`, HTTPS only), `timeout`, `format` | `{meta, data[{url, markdown, error}], errors[]}` |

Also on v1, free and keyless: `GET https://kagi.com/api/v1/smallweb/feed/`
(`limit`), an XML feed.

Legacy v0, base `https://kagi.com/api/v0`, auth `Authorization: Bot <token>`.
No OpenAPI document; from the vendor's markdown docs:

| Operation | Method, path | Parameters | Response `data` | Price |
|---|---|---|---|---|
| Search (deprecated) | `GET /search` | `q`*, `limit` | Array of objects by type `t`: `0` result `{url,title,snippet,published,thumbnail}`, `1` related searches `{list[]}` | $25 per 1,000 |
| FastGPT | `POST /fastgpt` | `query`*, `cache` (default true), `web_search` (must be true) | `{output, tokens, references[{title,snippet,url}]}` | 1.5 cents per query; cached responses free |
| Summarizer | `GET`, `POST /summarize` | `url` or `text` (one required), `engine` (`cecil` default, `agnes`, `muriel`), `summary_type` (`summary`, `takeaway`), `target_language`, `cache` | `{output, tokens}` | $0.030 per 1,000 tokens, capped at 10,000 tokens per request; `muriel` $1 per summary |
| Enrich, web | `GET /enrich/web` | `q`* | Search objects (Teclis index) | $2 per 1,000, billed only when results are returned |
| Enrich, news | `GET /enrich/news` | `q`* | Search objects (TinyGem index) | Same |

v0 responses carry `meta{id, node, ms}`; the search route also returns
`meta.api_balance` (the documented example shows it, and it is present as
`null` on a `401`). Whether FastGPT, Summarizer and Enrich return it is
`UNCONFIRMED`.

Status of v0: the vendor says "The legacy v0 Search API is deprecated", "v0
API users can switch to v1 and continue using any remaining v0 API credit",
and "The summarizer endpoint is not yet available in v1". FastGPT, Summarizer
and Enrich are documented only on v0. Whether a v1 key authenticates on v0
routes is `UNCONFIRMED`.

### 4.2 MCP

- Hosted remote MCP: `https://mcp.kagi.com/mcp`, Streamable HTTP. Auth is
  either OAuth with a Kagi account or `Authorization: Bearer <key>`. Without
  credentials it answers `401` with a `WWW-Authenticate` pointer to its OAuth
  metadata (verified today), so the tool list is from the vendor README: 2
  tools, `kagi_search_fetch` and `kagi_extract`. "The previous `kagi_fastgpt`
  and `kagi_summarizer` tools have been removed. Both are planned to return."
- Local package: `kagimcp` (`uvx kagimcp`, `KAGI_API_KEY`); it can also serve
  HTTP when self-hosted. Source: `github.com/kagisearch/kagimcp`.

### 4.3 Pricing, limits, balance

| Item | Value | Source |
|---|---|---|
| Search (v1) | $12 per 1,000 requests | `kagi.com/api/pricing` |
| Extract (v1) | $4 per 1,000 pages | `kagi.com/api/pricing` |
| Free allowance | None stated. A payment method or existing v0 credit is required | Quick start |
| Billing | Pay per use; invoiced every 30 days or when usage reaches $100. Prepaid credit and a spending cap are also offered | Pricing page, API portal docs |
| Rate limits | `UNCONFIRMED` (not published; "custom rate limits" is an enterprise feature) | |
| Balance self-report | v0 search: `meta.api_balance` (present, `null`, even on a `401`). v1: `meta` has only `trace`, `node`, `ms`; no balance | Verified today; published document |

### 4.4 Failure signals

| Condition | Signal | Evidence |
|---|---|---|
| v1, key missing or invalid | `401`, `{meta, data, error[{code, url, message, location}]}` | Published document |
| v1, IP not on the key's allow list | `403` | Published document |
| v1, rate limited **or usage limit exhausted** | `429`; one status for both | Published document |
| v1 error codes | Namespaced (example `extract.invalid_url`); the linked error pages are placeholders during the preview | Published document |
| v0, no key | `401`, `error[{code:2,msg:"Unauthorized",ref:null}]` | Verified today |
| v0, malformed key | `401`, `msg:"Malformed authorization token"` | Verified today |
| v0, out of credit | Message "Insufficient credit to perform this request."; status `UNCONFIRMED` | Vendor docs |

### 4.5 Recommendation

Connect v1 as `openapi` from the published document: two tools, no authoring.
It has no free allowance and is the most expensive search per request in this
set, so it should be called on purpose, not by default. The hosted MCP offers
the same two operations and adds nothing. Skip v0 unless FastGPT, the
Summarizer or the Enrich indexes are wanted; that needs a second upstream
with an authored spec and the `Bot ` prefix.

---

## 5. Perplexity

### 5.1 API document

- Document: `https://docs.perplexity.ai/openapi.json` (OpenAPI 3.1, 734 KB).
  The doc index is `https://docs.perplexity.ai/llms.txt`; every page is
  available as markdown by appending `.md`.
- Base URL: `https://api.perplexity.ai`.
- Auth: `Authorization: Bearer <key>`.
- 50 operations on 40 paths; the gateway would build 50 tools, 181 KB.

| Group | Count | Operations | Gateway tool names |
|---|---|---|---|
| Search API | 1 | `POST /search` | `post_search` (takes one `body` argument) |
| Context API | 1 | `POST /v1/context` | `context` |
| Agent API | 5 | `POST /v1/agent`, `GET /v1/agent/{id}`, `GET /v1/agent/{id}/files`, `GET /v1/agent/{id}/files/{file_id}/content`, `POST /v1/agent/{id}/cancel` | `createAgent`, `retrieveAgent`, `listAgentFiles`, `downloadAgentFile`, `cancelAgentResponse` |
| Sonar (legacy) | 4 | `POST /v1/sonar`, `POST /v1/async/sonar`, `GET /v1/async/sonar`, `GET /v1/async/sonar/{api_request}` | `post_v1_sonar`, `post_v1_async_sonar`, `get_v1_async_sonar`, `get_v1_async_sonar_api_request` |
| Decisions API | 1 | `POST /v1/decisions` | `post_v1_decisions` |
| Embeddings | 2 | `POST /v1/embeddings`, `POST /v1/contextualizedembeddings` | `post_v1_embeddings`, `post_v1_contextualizedembeddings` |
| Models | 1 | `GET /v1/models` | `listModels` |
| Monitors | 11 | create, list, get, update, delete, pause, resume, run, webhook test, list runs, get run under `/v1/monitors` | `createMonitor`, `listMonitors`, … |
| Skills | 7 | list, create, get, update, delete, revisions, download under `/v1/skills` | `listSkills`, `createSkill`, … |
| Files | 5 | list, create, get, delete, content under `/v1/files` | `listFiles`, `createFile`, … |
| Batches | 4 | list, create, get, cancel under `/v1/batches` | `listBatches`, `createBatch`, … |
| Orchestrator | 5 | `POST /orchestrator/v1/chat/completions`, `/responses`, `/messages`; `GET /orchestrator/v1/models`, `/models/{model}` | `gateway_create_chat_completion`, `gateway_create_response`, `gateway_create_message`, `gateway_list_models`, `gateway_retrieve_model` |
| Analytics, audit | 3 | `GET /v1/analytics/computer/usage`, `GET /v2/analytics/computer/usage`, `GET /v1/admin/audit-events` | `getComputerUsageAnalytics`, … |

The three `multipart/form-data` operations (`createSkill`, `updateSkill`,
`createFile`) cannot be called through the gateway.

The operations that matter for search:

| Operation | Body | Response |
|---|---|---|
| `POST /search` | `query`* (string, or array of 1-5; each up to 8,192 bytes), `max_results` (1-20, default 10; up to 50 for people), `search_type` (`web`, `fast`, `people`), `country`, `search_domain_filter[]` (up to 200; `-` prefix excludes), `search_language_filter[]` (up to 20), `search_recency_filter` (`hour`, `day`, `week`, `month`, `year`), `search_after_date_filter`, `search_before_date_filter`, `last_updated_after_filter`, `last_updated_before_filter` (`MM/DD/YYYY`), `snapshot_as_of` (RFC 3339, up to 365 days back), `display_server_time` | `{results[{title, url, snippet, date, last_updated, source}], id, server_time}`. No cost field |
| `POST /v1/context` | `urls`*, `formats` (default `["markdown"]`), `highlights`, `criteria`, `if_modified_since`, `max_age_seconds` (default 172800), `cache_only`, `snapshot_as_of`, `timeout_ms` | `{request_id, results[], usage{fetched_urls, cost{total_cost}}}` |
| `POST /v1/agent` | `input`*, `model` or `models[]`, `effort` (`fast`, `low`, `medium`, `high`, `xhigh`), `profile`, `instructions`, `tools[]` (`web_search`, `image_search`, `fetch_url`, `people_search`, `finance_search`, `sandbox`, MCP, functions), `tool_choice`, `response_format`, `background`, `stream`, `store`, `previous_response_id`, `max_output_tokens`, `max_steps`, `reasoning`, `temperature`, `top_p`, and others | `{id, object:"response", status, model, effort, output[], usage, error}`; `usage.cost.total_cost` when present |

Sonar status: "Sonar Chat Completions support ended on September 27, 2026.
Synchronous and streaming requests keep working: they are being reformulated
as Agent API requests … Asynchronous Sonar requests are not reformulated and
are no longer supported." The four Sonar operations are still in the
document; three of them (the async ones) no longer work.

### 5.2 MCP

- Hosted remote MCP: `https://api.perplexity.ai/mcp`, Streamable HTTP. Auth is
  OAuth 2.1 or `Authorization: Bearer <key>`. Without credentials it answers
  `401 invalid_api_key` (verified today), so the tool list is from vendor
  docs: 5 tools.

| Tool | Backed by |
|---|---|
| `perplexity_search` | Search API (`search_type: "fast"` supported) |
| `perplexity_context` | Context API, same parameter names as `POST /v1/context` |
| `perplexity_ask` | Agent API, `fast` effort |
| `perplexity_reason` | Agent API, `medium` effort |
| `perplexity_research` | Agent API, `high` effort |

  "Tool calls are billed at standard API pricing to the API key you connect
  with."
- Local package: `@perplexity-ai/mcp-server` (`npx -y`, stdio,
  `PERPLEXITY_API_KEY`). Source: `github.com/perplexityai/modelcontextprotocol`.
- A separate "Perplexity Computer MCP Server" exists for a different product
  and is out of scope here.

### 5.3 Pricing, limits, balance

| Item | Value |
|---|---|
| Search API | $5.00 per 1,000 successful requests; $1.00 per 1,000 with `search_type: "fast"`. One request with up to five queries is one unit. No token charges |
| Context API | $1.00 per 1,000 URLs returned `ok` or `not_modified` |
| Agent API | Model tokens at each model's rate, plus tools: `web_search` $0.0025 (fast $0.001), `image_search` $0.0025, `fetch_url` $0.0005, `people_search` $0.005, `finance_search` $0.005, `sandbox` $0.03 per started 20 minutes |
| Decisions API | $0.01 to $0.02 per 1M input tokens; output free |
| Embeddings | $0.004 to $0.12 per 1M tokens by model |
| Free allowance | None recurring. "Some new accounts receive a one-time sign-up credit. It expires 60 days after it is added"; it does not unlock the Agent API, Orchestrator API or batch creation. "A subscription does not include API credits" |
| Credits | Prepaid; auto top-up available. The vendor Help Center says purchased credits do not expire |
| Search API rate limit | 50 query units per second, burst 50, at every tier. A five-query request uses five units |
| Agent API rate limit | 1, 3, 8, 17, 33, 33 requests per second for tiers 0 to 5 (tier by lifetime purchases: $0, $50, $250, $500, $1,000, $5,000), plus per-model token limits (tier 0: 5M per minute, 300M per hour). Polling counts as a request |
| Balance self-report | None. The balance is shown only in the console; a signed-in MCP connection "cannot … view balances". Agent API successes carry `x-ratelimit-limit`, `-remaining`, `-used`, `-reset` for the request limit |

### 5.4 Failure signals

Envelope: `{"error":{"message","type","code"}}`.

| Condition | Signal | Evidence |
|---|---|---|
| Key missing or invalid | `401`, `type: "invalid_api_key"` | Verified today on `/search`, `/v1/models`, `/mcp` |
| Out of credit | "requests can return `402 Payment Required`"; "your API keys will be blocked until you add to your credit balance". Body `UNCONFIRMED` | Vendor FAQ, billing page |
| Rate limited | `429` with `Retry-After`; `type` is `request_rate_limit_exceeded`, `token_rate_limit_exceeded`, or `overloaded` (capacity, not a limit). Not billed | Vendor docs |
| Product not enabled for the key | `403`, `type: "api_product_not_allowed"` (Context API) | Published document |
| Invalid request | `400`, `type: "invalid_request"` | Vendor docs |

### 5.5 Recommendation

Connect as `openapi` from the published document with an `include` list, and
add the hosted MCP as a second preset. The Search API overlaps with Brave,
Exa and Tavily at the same or a higher price and has no recurring free
allowance, so it earns its place only as one more comparable backend; the
Context API (page fetch at $1 per 1,000) and the Decisions API are the parts
nothing else here offers.

**Conflict to settle before connecting.** `docs/NORTH_STAR.md` rules out
paying per token for Anthropic models through any reseller. The Agent API and
the Orchestrator API both sell Anthropic models per token. Exclude the five
`gateway_*` Orchestrator tools outright. `createAgent` accepts any model id,
so either exclude it or accept that an agent could select an Anthropic model.
Which models the MCP tools `perplexity_ask`, `perplexity_reason` and
`perplexity_research` run is set by Perplexity's effort presets and is
`UNCONFIRMED`.

---

## 6. SearXNG (self-hosted)

### 6.1 API document

None published. The API is documented at
`https://docs.searxng.org/dev/search_api.html`; routes and response shapes
below were read from the upstream source (`searx/webapp.py`,
`searx/webutils.py`, `searx/webadapter.py`, branch `master`).

- Base URL: the deployment's own; no public default.
- Auth: none. A reverse proxy in front may add its own.
- `GET` takes query parameters; `POST` takes `application/x-www-form-urlencoded`
  (not JSON), so the gateway can use only the GET forms.

| Operation | Method, path | Parameters | Response |
|---|---|---|---|
| Search | `GET /search` (also `GET /`) | `q`*, `format`* = `json` (also `csv`, `rss`; default `html`), `categories` (comma list), `engines` (comma list), `language`, `pageno` (default 1), `time_range` (`day`, `month`, `year`), `safesearch` (`0`, `1`, `2`), `timeout_limit`, `theme` | `{query, results[], answers[], corrections[], infoboxes[], suggestions[], unresponsive_engines[]}`. Result items carry `url`, `title`, `content`, `engine`, `score`; other fields (`engines[]`, `category`, `publishedDate`, `thumbnail`, `img_src`) vary by engine and are `UNCONFIRMED` here |
| Autocomplete | `GET /autocompleter` | `q`* | JSON array `[query, [suggestions], [], [], …]` (`application/x-suggestions+json`); a plain suggestion list when `X-Requested-With: XMLHttpRequest` is sent |
| Instance config | `GET /config` | none | `{categories[], engines[{name, categories, shortcut, enabled, paging, language_support, safesearch, time_range_support, timeout, …}], plugins[], instance_name, locales, default_locale, autocomplete, safe_search, default_theme, version, limiter{enabled,…}, public_instance, …}` |
| Health | `GET /healthz` | none | `200` plain text |

Other routes (`/preferences`, `/stats`, `/stats/errors`, `/metrics`,
`/image`, `/opensearch.xml`, `/engine_descriptions.json`) serve the web UI or
operators and are not useful as agent tools.

### 6.2 MCP

No official hosted or local MCP server is mentioned in the SearXNG
documentation. Community servers exist; none is needed.

### 6.3 Pricing, limits, balance

Free. Limits are whatever the deployment sets and whatever the upstream
engines tolerate. There is no balance. An engine that blocked or timed out is
named in `unresponsive_engines` of an otherwise successful response.

### 6.4 Failure signals

| Condition | Signal | Evidence |
|---|---|---|
| `format=json` requested but not enabled | `403` with an HTML body | Docs, source |
| Missing `q` or a bad parameter | `400 {"error": "<message>"}` | Source |
| Search failure | `500 {"error": "search error"}` | Source |
| Limiter (bot detection) refuses the client | Applies to non-browser clients when `server.limiter` is on. Status code `UNCONFIRMED` (the limiter page does not state it) | Limiter docs |

### 6.5 What the gateway needs

1. The base URL from configuration. It cannot be a preset value.
2. `auth = "none"` and no `keys`, which the config already accepts. If a
   reverse proxy protects the instance, `auth = "header"` with that
   credential.
3. An authored spec shipped in the repo, GET operations only, with `format`
   declared required with the single value `json` so every call sends it. The
   gateway has no way to add a fixed query parameter.
4. On the server, `search.formats` in `settings.yml` must include `json`.
   The shipped default is `formats: [html]`, which makes every JSON request a
   `403`.
5. On the server, either `server.limiter: false` (the default) or the
   gateway's address in `botdetection.ip_lists.pass_ip` in `limiter.toml`.
   The gateway sends its own `User-Agent`, which bot detection may reject.

Recommendation: connect as `openapi` with the authored spec. It has no
per-call cost.

---

## Gateway changes needed

### Per provider

Every config block below was parsed with the gateway's own
`resolveGatewayConfig` and accepted. The spec paths under `specs/` name files
that do not exist yet.

**1. Serper.** Author `specs/serper.yaml` (15 operations from section 1.1)
and add a preset:

```toml
[gateway.upstreams.serper]
kind = "openapi"
url = "https://google.serper.dev"
spec = "specs/serper.yaml"          # authored; see path note below
auth = "header"
auth_name = "X-API-KEY"
auth_prefix = ""
keys = ["env:SERPER_API_KEY"]
```

In the spec, give the scrape operation `servers: [{url: "https://scrape.serper.dev"}]`
with path `/`, and the locations operation
`servers: [{url: "https://api.serper.dev"}]`. Code changes: add
`not enough credits` to `QUOTA_PATTERN` (Serper uses HTTP 400), and read
`"credits": <n>` in `extractCost`. `GET /account` gives the gateway a way to
ask a key for its balance.

**2. Brave.** Author `specs/brave.yaml` (16 operations from section 2.1,
paths written as `/res/v1/…`) and add one upstream per plan, because each
plan has its own key:

```toml
[gateway.upstreams.brave]            # Search plan
kind = "openapi"
url = "https://api.search.brave.com"
spec = "specs/brave.yaml"
auth = "header"
auth_name = "X-Subscription-Token"
auth_prefix = ""
keys = ["env:BRAVE_SEARCH_API_KEY"]
exclude = ["*answers*", "*suggest*", "*spellcheck*"]

[gateway.upstreams.braveanswers]     # Answers plan, its own key
kind = "openapi"
url = "https://api.search.brave.com"
spec = "specs/brave.yaml"
auth = "header"
auth_name = "X-Subscription-Token"
auth_prefix = ""
keys = ["env:BRAVE_ANSWERS_API_KEY"]
include = ["*answers*"]
```

The filters assume the authored `operationId`s contain `answers`, `suggest`
and `spellcheck`. Add `bravesuggest` and `bravespell` the same way if those
plans are active.
Interim with no authoring: `spec = "https://search.agent.s.brave.app/openapi.json"`
gives 8 Search-plan tools with reduced parameters. Code changes: add
`SUBSCRIPTION_TOKEN_INVALID` to `AUTH_PATTERN` (Brave rejects a key with HTTP
422); keep `X-RateLimit-Remaining` from the response, the only quota signal;
confirm with a funded key what an empty prepaid balance returns on search
paths. The `X-Loc-*` location headers stay unreachable per call.

**3. Jina.** No authoring needed for the main surface:

```toml
[gateway.upstreams.jina]
kind = "openapi"
url = "https://api.jina.ai"
spec = "https://docs.jina.ai/openapi.json"
auth = "header"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:JINA_API_KEY"]
exclude = ["reader_*echo*", "reader_*ephemeral*", "get_well_known_*",
           "reader_get_bot", "reader_get_url", "reader_post_*", "search_post_*", "search_get_q"]

[gateway.upstreams.jinamcp]
kind = "mcp"
url = "https://mcp.jina.ai/v1"
auth = "header"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:JINA_API_KEY"]
```

Checked against the gateway's own filter: that leaves 13 of 34 tools (80 KB
of schema): `reader_get_root`, `search_get_search`, embeddings, rerank,
models, chat completions and batch. Optional authored supplement
`specs/jina-extra.yaml` for `POST /v1/segment` and DeepSearch
(`servers: [{url: "https://deepsearch.jina.ai"}]`), listed second in `spec`.
Code changes: none required (`402` already rotates keys). Optional: a token
unit in `extractCost` for `usage.tokens`.

**4. Kagi.** No authoring needed:

```toml
[gateway.upstreams.kagi]
kind = "openapi"
url = "https://kagi.com/api/v1"
spec = "https://kagi.com/api/docs/_bundle/openapi.json"
auth = "header"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:KAGI_API_KEY"]
```

Optional `kagimcp` (`kind = "mcp"`, `url = "https://mcp.kagi.com/mcp"`, same
auth) offers the same two operations. Legacy v0 would be a separate upstream
with `url = "https://kagi.com/api/v0"`, `auth_prefix = "Bot "` and an authored
spec. Code change to consider: Kagi v1 reports an exhausted usage limit as
`429`, which the gateway treats as a rate limit and never rotates on; the
error codes that would tell the two apart are not yet published.

**5. Perplexity.** No authoring needed; an `include` list is:

```toml
[gateway.upstreams.perplexity]
kind = "openapi"
url = "https://api.perplexity.ai"
spec = "https://docs.perplexity.ai/openapi.json"
auth = "header"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:PERPLEXITY_API_KEY"]
include = ["post_search", "context", "post_v1_decisions", "listModels"]

[gateway.upstreams.perplexitymcp]
kind = "mcp"
url = "https://api.perplexity.ai/mcp"
auth = "header"
auth_name = "Authorization"
auth_prefix = "Bearer "
keys = ["env:PERPLEXITY_API_KEY"]
```

Checked against the gateway's own filter: 4 of 50 tools, 17 KB of schema.
Decide the Anthropic pay-per-token question in section 5.5 before adding
`createAgent`, `retrieveAgent`, `cancelAgentResponse` to `include` or enabling
`perplexity_ask`, `perplexity_reason`, `perplexity_research`. Never include
`gateway_*`. Code changes: none required (`401` and `402` are already
recognised). Optional: read `usage.cost.total_cost` in `extractCost`.

**6. SearXNG.** Author `specs/searxng.yaml` (4 GET operations from section
6.1, `format` required with the single value `json`):

```toml
[gateway.upstreams.searxng]
kind = "openapi"
url = "https://searxng.example.org"  # placeholder: your instance's address
spec = "specs/searxng.yaml"
auth = "none"
```

Code changes: allow a preset without a `url` so `searxng` can ship `kind`,
`spec` and `auth` and ask only for the address. Server-side: enable `json` in
`search.formats`, and exempt the gateway from the limiter if it is on.

### Across providers

| Change | Why |
|---|---|
| Resolve a preset's spec file relative to the package, not the working directory | Three of the six need a spec shipped in the repo (Serper, Brave, SearXNG) |
| `QUOTA_PATTERN`: add `not enough credits` | Serper |
| `AUTH_PATTERN`: add `SUBSCRIPTION_TOKEN_INVALID` | Brave |
| `extractCost`: add `"credits"`, `usage.cost.total_cost`; optionally a token unit | Serper, Perplexity, Jina |
| Keep selected response headers (`X-RateLimit-*`, `Retry-After`) | Brave's quota, Perplexity's back-off |
| Optional: per-upstream fixed query parameters | Would let SearXNG's `format=json` be set in config, not in the spec |
| Optional: pass declared `in: header` parameters through | Brave location headers, `Api-Version` per call |

The two pattern changes come from running the gateway's `classifyFault` over
each provider's error text as the gateway would see it:

| Error text | Classified today | Should be |
|---|---|---|
| Serper `HTTP 400 … "Not enough credits"` (third-party report) | nothing | quota |
| Serper `HTTP 403 … "Unauthorized."` | auth | auth |
| Brave `HTTP 422 … SUBSCRIPTION_TOKEN_INVALID` | nothing | auth |
| Jina Reader `HTTP 402 … InsufficientBalanceError` | quota | quota |
| Jina `HTTP 401 … AUTH_MISSING_API_KEY` | auth | auth |
| Kagi v1 `HTTP 429 … usage limit exhausted` | nothing | quota, once its error codes are published |
| Kagi v0 "Insufficient credit to perform this request." | quota | quota |
| Perplexity `HTTP 401 … invalid_api_key` | auth | auth |
| Perplexity `HTTP 402` | quota | quota |
| SearXNG `HTTP 403` (JSON not enabled) | nothing | nothing; it is a server setting, not a key fault |

## What could not be verified

- Any Serper route by request, the `/account` response, and Serper's
  out-of-credit and rate-limit bodies. All need a key.
- What Brave returns on search paths when a prepaid balance is empty.
- Whether Jina Reader accepts a percent-encoded URL in the path, and whether
  `GET r.jina.ai/?url=` behaves the same as the path form. Keyless Reader was
  refused from the network used for this research.
- Kagi v1 rate limits and error codes; whether a v1 key works on v0 routes.
- The Perplexity `402` body, and which models the hosted MCP's three
  answering tools run.
- The hosted MCP tool lists for Kagi and Perplexity, which need a key; they
  are quoted from vendor documentation.

## Sources

All fetched 2026-11-27.

Serper
- https://serper.dev/ (pricing, free queries, FAQ, example responses)
- https://serper.dev/playground and its public script bundles under
  `https://serper.dev/_next/static/chunks/` (endpoint hosts, per-type request
  fields, credit costs, type list)
- https://api.serper.dev/locations (keyless request)
- https://quotacanary.com/directory/serper and
  https://github.com/superdesigndev/treg (third-party use of `/account`)
- https://github.com/garylab/serper-mcp-server (community MCP)

Brave
- https://api-dashboard.search.brave.com/llms.txt and the pages it indexes
  under `/documentation/` and `/api-reference/` (markdown form)
- https://api-dashboard.search.brave.com/documentation/pricing
- https://api-dashboard.search.brave.com/documentation/guides/rate-limiting
- https://api-dashboard.search.brave.com/documentation/guides/admin-api
- https://api-dashboard.search.brave.com/documentation/resources/help-feedback
- https://search.agent.s.brave.app/openapi.json and
  https://search.agent.s.brave.app/llms.txt
- https://github.com/brave/brave-search-mcp-server

Jina
- https://docs.jina.ai/openapi.json, https://docs.jina.ai/ (meta-prompt)
- https://api.jina.ai/openapi.json, https://r.jina.ai/openapi.json,
  https://s.jina.ai/openapi.json
- https://api.jina.ai/v1/models, https://deepsearch.jina.ai/v1/models
- https://github.com/jina-ai/meta-prompt (`api-docs/`, `v9.txt`, `v11.txt`)
- https://mcp.jina.ai/ and https://github.com/jina-ai/MCP
- https://jina.ai/reader, https://jina.ai/api-dashboard/rate-limit,
  https://jina.ai/segmenter, https://jina.ai/classifier,
  https://jina.ai/deepsearch

Kagi
- https://kagi.com/api/docs/_bundle/openapi.json
- https://kagi.com/api/pricing
- https://help.kagi.com/kagi/api/overview.html and the markdown sources in
  https://github.com/kagisearch/kagi-docs (`docs/kagi/api/`)
- https://github.com/kagisearch/kagimcp
- https://mcp.kagi.com/.well-known/oauth-protected-resource/mcp

Perplexity
- https://docs.perplexity.ai/openapi.json, https://docs.perplexity.ai/llms.txt
- https://docs.perplexity.ai/docs/getting-started/pricing.md
- https://docs.perplexity.ai/docs/getting-started/projects.md
- https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers.md
- https://docs.perplexity.ai/docs/search/overview.md
- https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server.md
- https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview.md
- https://docs.perplexity.ai/docs/resources/faq.md

SearXNG
- https://docs.searxng.org/dev/search_api.html
- https://docs.searxng.org/admin/settings/settings_search.html
- https://docs.searxng.org/admin/searx.limiter.html
- https://github.com/searxng/searxng (`searx/webapp.py`, `searx/webutils.py`,
  `searx/webadapter.py`, `searx/settings.yml`)

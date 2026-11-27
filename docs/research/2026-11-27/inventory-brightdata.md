# Bright Data — complete programmatic surface, and what the MCP gateway is missing (2026-11-27)

- **Date researched:** 2026-11-27.
- **Nature of this file:** a dated inventory taken from Bright Data's own documentation site, the 52 OpenAPI files it publishes, its public scraper catalogue, its pricing pages, and the source code of its MCP server. Where a machine-readable list exists the counts below were produced by scripts over the downloaded files, not by reading pages.
- **No account was touched.** No API key was used, no paid endpoint was called and the hosted MCP server was not contacted. Anything that depends on how a live account behaves is marked **UNCONFIRMED**.
- **Compared against:** the gateway's tool dump of the same day, in which Bright Data is reached only through its hosted MCP server and offers 30 tools.
- Prices are the vendor's published pay-as-you-go prices on the date above.

## 1. Result in brief

| Question | Answer |
| - | - |
| OpenAPI files Bright Data publishes | **52**: 16 English API documents, 22 per-scraper example documents (`sdk-specs`), 14 Chinese-language copies |
| Operations in the 38 English files | 182 as written; **148** distinct method and path; **123** once the 25-operation reseller API (not usable by an ordinary account) is left out |
| Specs needed to get all 123 | **10** (the other 6 English documents only repeat operations already in those 10) |
| Base URL and auth for every spec | `https://api.brightdata.com`, `Authorization: Bearer <API key>`. No spec sets a per-operation server |
| Hosted MCP tool universe | **30 tools, all on by default.** No flag, group or mode yields more. `&groups=` and `&tools=` only narrow it |
| The old `web_data_*` tools | **Gone.** 50 existed in September 2026; removed in server version 3.0.0 on 2026-10-11 and replaced by `search_scrapers` → `get_scraper_details` → `run_scraper` |
| Pro mode | **Gone.** `PRO_MODE` was removed in 3.1.0 on 2026-10-15; setting it is ignored |
| Scraper catalogue | **1,304** scrapers on 1,210 domains, 1,912 collection methods; 90% are e-commerce sites |
| What the gateway offers today | The 30 MCP tools |
| What the gateway does not offer | All 123 REST operations, of which about 25 matter to a coding agent (full search-engine results, JavaScript-rendered page fetch, scraper job control, account balance and free-credit counters) |

## 2. Sources and method

| Source | URL | Used for |
| - | - | - |
| Docs index | https://docs.brightdata.com/llms.txt (states `Version: 2026-09-30.3`) | Product map, entry points |
| Full docs text | https://docs.brightdata.com/llms-full.txt (5.4 MB) | Searching for endpoints, prices, limits |
| Sitemap | https://docs.brightdata.com/sitemap.xml (1,395 URLs, 698 English, 340 English API-reference pages) | Enumerating API pages |
| Every English API-reference page as markdown | `https://docs.brightdata.com/<page>.md` (340 fetched) | Each page names the spec file and operation it is generated from |
| Docs MCP server | https://docs.brightdata.com/mcp (public, no key; `find /openapi -type f`) | The authoritative list of the 52 spec files |
| OpenAPI files | listed in section 3 | Operation counts, parameters, auth |
| Scraper catalogue | https://docs.brightdata.com/scrapers.json, https://docs.brightdata.com/scrapers-full.json | Scraper counts |
| MCP server source | https://github.com/brightdata/brightdata-mcp (`main`, package version 4.10.0, released 2026-11-26): `server.js`, `tool_groups.js`, `scraper_tools.js`, `scraper_catalog.js`, `scraper_run.js`, `browser_tools.js`, `errors.js`, `content_gate.js`, `CHANGELOG.md`; and `server.js` as of 2026-09-15 for the retired tools | Tool universe, flags, what each tool calls |
| MCP docs | https://docs.brightdata.com/products/mcp-server/tools.md, `/remote/quickstart.md`, `/remote/advanced.md`, `/remote/oauth.md`, `/local/advanced.md` | Hosted URL parameters |
| Pricing | https://brightdata.com/llms.txt (states "Last updated: October 2026"), https://brightdata.com/pricing/web-unlocker, `/pricing/serp`, `/pricing/web-scraper`, `/pricing/scraping-browser`, `/pricing/mcp-server` | Prices |
| Free tier | https://docs.brightdata.com/general/account/billing-and-pricing/free-tier.md | Free tier |

Method for the operation counts: each spec was parsed with a script; a second script copies the gateway's own rules for naming tools and dropping duplicate method-and-path pairs (`src/gateway/openapi.ts`) to work out the tool list a given ordered set of specs would produce. For the recommended set the result was then confirmed against the gateway's own loader run on the downloaded files.

## 3. Published OpenAPI documents

### 3.1 The 16 English API documents

All 16 declare `servers: https://api.brightdata.com` and a global `bearerAuth` security scheme (HTTP bearer; the API key is the token). None declares a server on an individual path or operation. Each URL below was fetched and returned HTTP 200 with `application/json`.

| # | Spec URL (`https://docs.brightdata.com/` + ) | OpenAPI | Operations | New operations after the documents above it | Zone or dataset id required | Covers |
| - | - | - | - | - | - | - |
| 1 | `api-reference/dca-api.json` | 3.1.0 | 30 | 30 | `dataset_id` (query) on trigger, sync scrape and snapshot list; otherwise a `snapshot_id`, or nothing | **Web Scraper API** (datasets v3: list scrapers, sync scrape, async trigger, progress, snapshot download, deliver, cancel, pause, resume, rerun, logs, fill rates) and **Marketplace Dataset API** (list datasets, filter, snapshots, views, delivery settings) |
| 2 | `api-reference/unlocker-rest-api.json` | 3.0.1 | 4 | 4 | `zone` (a Web Unlocker zone) | **Web Unlocker API**: `POST /request`, `GET /request`, `GET /response`, success rate per domain |
| 3 | `api-reference/serp-rest-api.json` | 3.0.1 | 3 | 0 | `zone` (a SERP zone) | **SERP API**: the same `POST /request`, `GET /request`, `GET /response`; the zone's type decides the product |
| 4 | `api-reference/proxy-rest-api.json` | 3.0.1 | 3 | 0 | `zone` (a proxy zone) | **Proxy REST API**: the same three paths again, routed through a proxy zone |
| 5 | `api-reference/async-api-reference.json` | 3.1.0 | 4 | 4 | `zone` (query) | Older async pair for Unlocker and SERP: `POST /unblocker/req`, `GET /unblocker/get_result`, `POST /serp/req`, `GET /serp/get_result` (webhook delivery supported) |
| 6 | `api-reference/business-search/business-search-api.json` | 3.1.0 | 2 | 2 | none | **Business Search**: `POST /search/company`, `POST /search/people` |
| 7 | `api-reference/openapi.json` | 3.0.1 | 50 | 50 | `zone` on per-zone operations | **Account Management API**: zones (create, read, delete, passwords, IPs, allow and deny lists), balance, free-tier credits, pricing plans, cost and bandwidth, cost export, account status, billing settings, country and city lists |
| 8 | `api-reference/web-scraper-ide-rest-api.json` | 3.1.0 | 22 | 22 | `collector` (a Scraper Studio scraper id) on run operations | **Scraper Studio API** (`/dca/*`): list, create and delete scrapers; batch, real-time and sync runs; job control; AI generation and self-healing |
| 9 | `api-reference/browser-api.json` | 3.1.0 | 2 | 2 | none | **Browser API sessions**: list sessions, get one session. Records of browser sessions, not browser control |
| 10 | `api-reference/web-archive-api.json` | 3.1.0 | 7 | 7 | none | **Web Archive API**: search the archive, check a search, list searches, deliver a dump, export metadata, dump status |
| 11 | `api-reference/media-data-api/media-data-api.json` | 3.1.0 | 2 | 1 | `collector` | **Media Data API**: trigger a media extraction job (`POST /dca/trigger_hp`, also in document 8), job errors. The spec says the API is not enabled by default |
| 12 | `api-reference/proxy-manager.json` | 3.1.0 | 1 | 1 | none | `GET /domains/{metric}`: usage per target domain (bandwidth or request count), by zone and day |
| 13 | `api-reference/rest-api/scraper/scraper-rest-api.json` | 3.1.0 | 3 | 0 | `dataset_id` | Short copy of trigger, progress and snapshot download from document 1 |
| 14 | `api-reference/filter-csv-json.json` | 3.1.0 | 1 | 0 | `dataset_id` | `POST /datasets/filter` with a multipart file upload only |
| 15 | `api-reference/dca-custom-inputs.json` | 3.1.0 | 1 | 0 | `dataset_id` | Variant page of `POST /datasets/v3/scrape` |
| 16 | `api-reference/openapi-reseller.json` | 3.0.1 | 25 | 25 | a partner name in the path | **Reseller API** (`/api/{PARTNER_NAME}/…`): sub-customer sign-up, IPs, usage limits. For partner accounts only |

Totals: 160 operations across the 16; 148 distinct method and path; 123 without the reseller document.

### 3.2 The 123 operations, with the tool name the gateway would give each

Order of specs is the one recommended in section 9. The names follow the gateway's naming rule (operation id when present and at most 32 characters, otherwise method and path, cut at 48 characters). They were checked by feeding the ten downloaded spec files to the gateway's own loader (the built `dist/gateway/openapi.js`, reading local files, no request to Bright Data): it produced these 123 names, all unique, with 176 KB of schemas in total.

**`api-reference/dca-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `filterDataset` | `POST /datasets/filter` | `body` | one `body` argument (object) | Create a dataset snapshot based on a provided filter |
| `listDatasets` | `GET /datasets/list` | — | — | Retrieve a list of available datasets |
| `listDatasetSnapshots` | `GET /datasets/snapshots` | — | — | Get dataset snapshots metadata |
| `getDatasetSnapshot` | `GET /datasets/snapshots/{id}` | `id` | — | Get dataset snapshot metadata |
| `listDatasetSnapshotParts` | `GET /datasets/snapshots/{id}/parts` | `id` | — | Get dataset snapshot delivery parts. |
| `downloadDatasetSnapshot` | `GET /datasets/snapshots/{id}/download` | `id` | — | Get dataset snapshot content |
| `deliverDatasetSnapshot` | `POST /datasets/snapshots/{id}/deliver` | `id` | JSON fields as arguments | Deliver the dataset snapshot |
| `listDeliveryOptions` | `GET /datasets/delivery_settings/options` | — | — | Returns the options available for configuring delivery settings on a dataset view, including supported destin… |
| `getDeliveryDestinationSchema` | `GET /datasets/delivery_settings/{destination_type}/schema` | `destination_type` | — | Returns the exact fields required for a specific delivery destination type (for example `s3`, `sftp`, `gcs`, … |
| `listDatasetViews` | `GET /datasets/views` | — | — | Retrieves the customer's dataset views. |
| `getDatasetViewDeliverySettings` | `GET /datasets/views/{view_id}/delivery_settings` | `view_id` | — | Retrieves the current delivery configuration for a specific dataset view. |
| `put_datasets_views_view_id_delivery_settings` | `PUT /datasets/views/{view_id}/delivery_settings` | `view_id` | JSON fields as arguments | Updates the delivery configuration for a specific dataset view. |
| `put_datasets_views_delivery_settings_bulk` | `PUT /datasets/views/delivery_settings/bulk` | `body` | one `body` argument (object) | Updates delivery configurations for multiple dataset views in a single request. |
| `getScrapeSnapshotLog` | `GET /datasets/v3/log/{snapshot_id}` | `snapshot_id` | — | Retrieve the logs for a specific dataset snapshot |
| `triggerScrape` | `POST /datasets/v3/trigger` | `body`, `dataset_id` | one `body` argument (oneOf) | Scrape the target website based on the inputs provided in body |
| `downloadScrapeSnapshot` | `GET /datasets/v3/snapshot/{snapshot_id}` | `snapshot_id` | — | Download the snapshot content. |
| `deliverScrapeSnapshot` | `POST /datasets/v3/deliver/{snapshot_id}` | `snapshot_id` | JSON fields as arguments | Deliver the snapshot content to the specified storage |
| `getScrapeProgress` | `GET /datasets/v3/progress/{snapshot_id}` | `snapshot_id` | — | The Monitor Progress API is designed to track the current status of a data collection job, also known as a sn… |
| `listScrapeSnapshots` | `GET /datasets/v3/snapshots` | `dataset_id` | — | Get a list of triggered collections, the list contains only snapshots created for a specific dataset |
| `listScrapers` | `GET /datasets/v3/scrapers` | — | — | Get every scraper available to your account, with the full input schema, output field list and sample payload… |
| `scrapeSync` | `POST /datasets/v3/scrape` | `body`, `dataset_id` | one `body` argument (oneOf) | Scrape data and return it directly in the response. |
| `getDeliveryStatus` | `GET /datasets/v3/delivery/{delivery_id}` | `delivery_id` | — | The call returns the delivery status |
| `listScrapeSnapshotParts` | `GET /datasets/v3/snapshot/{snapshot_id}/parts` | `snapshot_id` | — | When requesting a delivery in batches (see available delivery APIs) use this endpoint to check how many parts… |
| `getScrapeSnapshotInput` | `GET /datasets/v3/snapshot/{snapshot_id}/input` | `snapshot_id` | — | Get the inputs that were used to trigger the collection |
| `pauseScrape` | `POST /datasets/v3/snapshot/{snapshot_id}/pause` | `snapshot_id` | — | Pause the running collection |
| `resumeScrape` | `POST /datasets/v3/snapshot/{snapshot_id}/resume` | `snapshot_id` | — | Resume a paused collection |
| `cancelScrape` | `POST /datasets/v3/snapshot/{snapshot_id}/cancel` | `snapshot_id` | — | Cancel the running collection |
| `rerunScrape` | `POST /datasets/v3/snapshot/{snapshot_id}/rerun` | `snapshot_id` | — | Rerun previously created snapshot |
| `getSnapshotFillRate` | `GET /datasets/v3/snapshot/{snapshot_id}/fill_rate` | `snapshot_id` | — | Returns field-level fill rates for one snapshot. |
| `getScraperFillRate` | `GET /datasets/v3/scraper/{dataset_id}/fill_rate` | `dataset_id`, `from_date`, `to_date` | — | Returns field-level fill rates for a scraper, aggregated across the snapshots the account collected with that… |

**`api-reference/unlocker-rest-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `unlockUrlViaQuery` | `GET /request` | `format`, `url`, `zone` | — | Unlock a URL (query parameters) |
| `unlockUrl` | `POST /request` | `format`, `url`, `zone` | JSON fields as arguments | Unlock a URL |
| `getUnlockerAsyncResponse` | `GET /response` | `response_id` | — | Get an async Web Unlocker response |
| `getUnlockerSuccessRate` | `GET /unblocker/success_rate/{domain}` | `domain` | — | Get success rate statistics per domain |

**`api-reference/async-api-reference.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `post_unblocker_req` | `POST /unblocker/req` | `url`, `zone` | JSON fields as arguments |  |
| `post_serp_req` | `POST /serp/req` | `query`, `zone` | JSON fields as arguments |  |
| `get_unblocker_get_result` | `GET /unblocker/get_result` | `response_id` | — |  |
| `get_serp_get_result` | `GET /serp/get_result` | `response_id` | — |  |

**`api-reference/business-search/business-search-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `searchCompany` | `POST /search/company` | `mode`, `query` | JSON fields as arguments | Search companies |
| `searchPeople` | `POST /search/people` | `mode`, `query` | JSON fields as arguments | Search people |

**`api-reference/openapi.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `listPaymentMethods` | `GET /billing/pmethods` | — | — | Get the active, confirmed payment methods of your account. |
| `getAutoRecharge` | `GET /billing/autorecharge` | — | — | Get the regular and dataset auto-recharge settings of your account. |
| `setRegularAutoRecharge` | `PUT /billing/autorecharge/regular` | `body` | one `body` argument (oneOf) | Enable, change or disable regular auto-recharge. |
| `setDatasetAutoRecharge` | `PUT /billing/autorecharge/dataset` | `body` | one `body` argument (oneOf) | Enable or disable dataset auto-recharge. |
| `listCities` | `GET /cities` | `country` | — | Get a list of cities from a Country |
| `get_countrieslist` | `GET /countrieslist` | — | — | List all available countries per zone type |
| `getAccountBalance` | `GET /customer/balance` | — | — | Get your account balance information: available balance, free credits, prepayment and pending usage costs. |
| `getFreeTierCredits` | `GET /trials/free_tier` | — | — | Get the free tier credits on your account: whether the free tier is enabled and the included, used and left c… |
| `listPricingPlans` | `GET /pricing_plans` | — | — | Get your account's current pricing plan and the plans available to it, with per-product prices for each plan. |
| `getAccountBandwidth` | `GET /customer/bw` | — | — | Get the bandwidth stats for all your Zones |
| `getNetworkStatus` | `GET /network_status/{NETWORK_TYPE}` | `NETWORK_TYPE` | — |  |
| `getAccountStatus` | `GET /status` | — | — | Get account status |
| `updateAccountStatus` | `PUT /status` | — | JSON fields as arguments |  |
| `getZone` | `GET /zone` | `zone` | — | Get Zone status |
| `createZone` | `POST /zone` | `plan`, `zone` | JSON fields as arguments | Add a new zone |
| `deleteZone` | `DELETE /zone` | — | JSON fields as arguments |  |
| `listZoneDenylistIps` | `GET /zone/blacklist` | — | — | Get a list of denylisted IPs for a specific Zone |
| `addZoneDenylistIp` | `POST /zone/blacklist` | `ip` | JSON fields as arguments | Add IP to zone's denylist |
| `removeZoneDenylistIp` | `DELETE /zone/blacklist` | — | JSON fields as arguments |  |
| `getZoneBandwidth` | `GET /zone/bw` | `zone` | — | Get the bandwidth stats for a Zone |
| `setZoneDisabled` | `POST /zone/change_disable` | `disable`, `zone` | JSON fields as arguments |  |
| `countZoneAvailableIps` | `GET /zone/count_available_ips` | — | — |  |
| `getZoneCost` | `GET /zone/cost` | `zone` | — | Returns billed cost, bandwidth, and usage stats for a Zone over a date range. |
| `exportCostsJson` | `POST /costs/export/json` | `dimension`, `from`, `to` | JSON fields as arguments | Export account cost data broken down by dimension (products, zones, datasets, Web Scraper APIs, and more) as … |
| `exportCostsCsv` | `POST /costs/export/csv` | `dimension`, `from`, `to` | JSON fields as arguments | Same data as `POST /costs/export/json`, returned as CSV instead of JSON. |
| `addZoneDomainPermission` | `POST /zone/domain_perm` | `type`, `zone` | JSON fields as arguments | Add domain to Zone allowlist or denylist |
| `removeZoneDomainPermission` | `DELETE /zone/domain_perm` | `domain`, `type`, `zone` | JSON fields as arguments |  |
| `listActiveZones` | `GET /zone/get_active_zones` | — | — | Return all active zones |
| `listAllZones` | `GET /zone/get_all_zones` | — | — | Return all zones |
| `listZoneStaticIps` | `GET /zone/ips` | `zone` | — | Get Zone Static (Datacenter/ISP) IPs |
| `addZoneStaticIps` | `POST /zone/ips` | `count`, `customer`, `zone` | JSON fields as arguments | Add Static IPs for Datacenter and ISP |
| `removeZoneStaticIps` | `DELETE /zone/ips` | — | JSON fields as arguments |  |
| `migrateZoneStaticIps` | `POST /zone/ips/migrate` | `from`, `ips`, `to` | JSON fields as arguments | Migrate Static IPs between zones (Datacenter/ISP) |
| `refreshZoneStaticIps` | `POST /zone/ips/refresh` | `zone` | JSON fields as arguments |  |
| `listZoneUnavailableIps` | `GET /zone/ips/unavailable` | — | — | Get live status of Static (Datacenter/ISP) Zone and IPs with connectivity problem |
| `listZonePasswords` | `GET /zone/passwords` | `zone` | — | Get Zone passwords |
| `getZonePermissions` | `GET /zone/permissions` | `zone` | — | Get Zone permissions |
| `get_zone_proxies_pending_replacement` | `GET /zone/proxies_pending_replacement` | — | — | Get list of all proxies in the provided zone, which are pending replacement |
| `listZoneRecentIps` | `GET /zone/recent_ips` | — | — |  |
| `listZoneRouteIps` | `GET /zone/route_ips` | `zone` | — | Get the available Data center/ISP IPs per Zone |
| `listZoneRouteVips` | `GET /zone/route_vips` | `zone` | — | Get all available residential dedicated IPs per Zone |
| `listStaticNetworkCities` | `GET /zone/static/cities` | `country` | — | Get list of available cities of static network per country |
| `getZoneStatus` | `GET /zone/status` | `zone` | — | Get Zone status |
| `setZoneAutoFailover` | `POST /zone/switch_100uptime` | `ip` | JSON fields as arguments | Switch automatic failover ON/OFF in a Static zone |
| `removeZoneVips` | `DELETE /zone/vips` | `gips`, `zone` | JSON fields as arguments |  |
| `listZoneAllowlistIps` | `GET /zone/whitelist` | — | — | Get a list of allowlisted IPs for a specific Zone |
| `addZoneAllowlistIp` | `POST /zone/whitelist` | `ip` | JSON fields as arguments | Add IP to zone's allowlist |
| `removeZoneAllowlistIp` | `DELETE /zone/whitelist` | — | JSON fields as arguments |  |
| `addZonePassword` | `POST /zone/add_password` | `password`, `zone` | JSON fields as arguments | Add Zone Password |
| `removeZonePassword` | `POST /zone/remove_password` | `password`, `zone` | JSON fields as arguments | Remove Zone Password |

**`api-reference/web-scraper-ide-rest-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `listScraperStudioJobs` | `GET /dca/collector/jobs` | `from_date`, `to_date` | — | List Scraper Studio jobs |
| `listScraperStudioScrapers` | `GET /dca/collectors_list` | — | — | List Scraper Studio scrapers |
| `getScraperStudioBatchResult` | `GET /dca/dataset` | `id` | — | Retrieve the results of an asynchronous Scraper Studio batch collection. |
| `getScraperStudioRealtimeResult` | `GET /dca/get_result` | `response_id` | — | Receive data from real-time work scraper |
| `getScraperStudioJob` | `GET /dca/log/{job_id}` | `job_id` | — | Get job data by job ID |
| `post_dca_trigger_immediate` | `POST /dca/trigger_immediate` | `collector` | JSON fields as arguments | Trigger an asynchronous real-time run of a Scraper Studio collector. |
| `triggerScraperStudioBatch` | `POST /dca/trigger` | `body`, `collector` | one `body` argument (array) | Start an asynchronous batch collection for a published Scraper Studio collector. |
| `runScraperStudioRealtimeSync` | `POST /dca/crawl` | `collector`, `timeout` | JSON fields as arguments | Trigger a synchronous real-time run of a Scraper Studio collector. |
| `triggerScraperStudioHpBatch` | `POST /dca/trigger_hp` | `body`, `collector` | one `body` argument (array) | Trigger a scraper for batch collection method |
| `pauseScraperStudioJob` | `POST /dca/jobs/{job_id}/pause` | `job_id` | — | Pause a Scraper Studio job |
| `resumeScraperStudioJob` | `POST /dca/jobs/{job_id}/resume` | `job_id` | — | Resume a Scraper Studio job |
| `cancelScraperStudioJob` | `POST /dca/jobs/{job_id}/cancel` | `job_id` | — | Cancel a Scraper Studio job |
| `rerunScraperStudioJob` | `POST /dca/jobs/{job_id}/rerun` | `job_id` | JSON fields as arguments | Rerun a Scraper Studio job |
| `createScraperStudioScraper` | `POST /dca/collector` | `deliver`, `name` | JSON fields as arguments | Create Scraper Template |
| `deleteScraperStudioScraper` | `DELETE /dca/collector/{scraper_id}` | `scraper_id` | — | Delete a Scraper Studio scraper |
| `triggerScraperStudioAiGeneration` | `POST /dca/collectors/{collector_id}/automate_template` | `collector_id`, `description`, `urls` | JSON fields as arguments | Trigger AI Flow |
| `get_dca_collectors_collector_id_automate_templat` | `GET /dca/collectors/{collector_id}/automate_template/progress` | `collector_id` | — | Get AI Job Progress |
| `triggerScraperStudioSelfHealing` | `POST /dca/collectors/{collector_id}/refactor_template` | `collector_id`, `prompt` | JSON fields as arguments | Trigger Self-Healing |
| `get_dca_collectors_collector_id_refactor_templat` | `GET /dca/collectors/{collector_id}/refactor_template/progress` | `collector_id` | — | Get Self-Healing Job Progress |
| `post_dca_collectors_collector_id_resume_automati` | `POST /dca/collectors/{collector_id}/resume_automation_job` | `collector_id`, `message` | JSON fields as arguments | Resume Self-Healing Job |
| `post_dca_collectors_collector_id_cancel_automati` | `POST /dca/collectors/{collector_id}/cancel_automation` | `collector_id`, `type` | JSON fields as arguments | Cancel Self-Healing Job |
| `post_dca_auto_self_healing_create` | `POST /dca/auto_self_healing/create` | `collector`, `enabled`, `sr_threshold`, `trigger_frequency` | JSON fields as arguments | Enable Auto Self-Healing |

**`api-reference/browser-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `getBrowserSession` | `GET /browser_sessions/{session_id}` | `session_id` | — | Get single browser session |
| `listBrowserSessions` | `GET /browser_sessions` | — | — | List browser sessions |

**`api-reference/web-archive-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `post_webarchive_search` | `POST /webarchive/search` | `filters` | JSON fields as arguments | Run a search |
| `get_webarchive_search_search_id` | `GET /webarchive/search/{search_id}` | `search_id` | — | Get search status |
| `get_webarchive_searches` | `GET /webarchive/searches` | — | — | Get all search statuses |
| `post_webarchive_dump` | `POST /webarchive/dump` | `delivery`, `search_id` | JSON fields as arguments | Deliver a snapshot to Amazon S3, Azure Blob Storage or a Webhook |
| `post_webarchive_dump_metadata` | `POST /webarchive/dump_metadata` | `delivery`, `search_id` | JSON fields as arguments | Export search metadata |
| `get_webarchive_dump_dump_id` | `GET /webarchive/dump/{dump_id}` | `dump_id` | — | Get data snapshot (dump) status |
| `get_webarchive_dumps` | `GET /webarchive/dumps` | — | — | Get all data snapshot statuses |

**`api-reference/media-data-api/media-data-api.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `getMediaDataJobErrors` | `GET /dca/jobs/{job_id}/hp_errors` | `job_id` | — | Get errors for a Media Data API job |

**`api-reference/proxy-manager.json`**

| Gateway tool name | Operation | Required | Body | Purpose |
| - | - | - | - | - |
| `getDomainMetrics` | `GET /domains/{metric}` | `from`, `metric`, `to` | — | Domain usage metrics |

### 3.3 Things in these specs a gateway must know

| Fact | Consequence |
| - | - |
| `POST /request` is in three documents (Unlocker, SERP, Proxy). The gateway keeps the first copy of a method and path and drops later ones | List `unlocker-rest-api.json` and leave the SERP and Proxy documents out. Its body is a superset (`render`, `debug`), and one tool then serves SERP, Unlocker and proxy requests: the `zone` argument selects which |
| The `data_format` field is declared as an enum of `markdown` and `screenshot` only, but the SERP docs also use `parsed_light`, and the MCP server sends `parsed_light` and `parsed_bing` | A client that enforces the enum cannot ask for parsed search JSON through `data_format`. The documented alternative is to add `brd_json=1` to the search URL itself. Source: https://docs.brightdata.com/products/serp-api/introduction.md |
| `data_format: "screenshot"` returns a PNG; `compress=true` on downloads returns gzip | The gateway reads every response as text, so these come back unusable |
| `POST /datasets/v3/trigger` and `POST /datasets/v3/scrape` declare the body as `oneOf` (a bare array of inputs, or an object with `input`) | The gateway passes it as one `body` argument: `body: [{"url": "…"}]` |
| `POST /datasets/filter` has `dataset_id` both as a query parameter and a body field | Also becomes one `body` argument. The multipart file-upload form is not reachable |
| `GET /datasets/v3/scrapers` with no filter returns every scraper with schemas and samples | The public file with the same fields (`scrapers-full.json`) is 7.4 MB. Always pass `dataset_id` or `domain` |
| `GET /zone/passwords` returns zone passwords | Must be hidden: the result would land in the agent's context and in the gateway's payload log |
| 11 operations have no operation id (the four async ones and the seven web-archive ones) and 10 have an id longer than 32 characters | These 21 get method-and-path names such as `post_webarchive_search`; four Scraper Studio names are cut at 48 characters |
| Sync scrape answers HTTP 202 with a `snapshot_id` when the job runs past 1 minute | 202 is a success to the gateway; the agent must then poll progress and download the snapshot |

### 3.4 The 22 per-scraper example documents (`sdk-specs`)

Each holds one operation, `POST /datasets/v3/scrape`, with one scraper's `dataset_id` and input fields filled in. They add no operation: under the gateway's duplicate rule all 22 collapse into `scrapeSync`. They are useful as worked examples only. They declare no security scheme.

| Spec file (under `https://docs.brightdata.com/api-reference/sdk-specs/`) | Fixed `dataset_id` | In `scrapers.json` |
| - | - | - |
| `amazon-products-collect-by-url.json` | `gd_l7q7dkf244hwjntr0` | yes |
| `amazon-reviews-collect-by-url.json` | `gd_le8e811kzy4ggddlq` | yes |
| `amazon-sellers-info-collect-by-url.json` | `gd_lhotzucw1etoe5iw1k` | yes |
| `chatgpt-search-by-prompt.json` | `gd_m7aof0k82r803d5bjm` | yes |
| `facebook-comments-collect-by-url.json` | `gd_lkay758p1eanlolqw8` | yes |
| `facebook-pages-posts-collect-by-url.json` | `gd_lkaxegm826bjpoo9m5` | yes |
| `facebook-posts-by-group-collect-by-url.json` | `gd_lz11l67o2cb3r0lkj3` | yes |
| `facebook-posts-collect-by-url.json` | `gd_lyclm1571iy3mv57zw` | yes |
| `facebook-reels-collect-by-url.json` | `gd_lyclm3ey2q6rww027t` | yes |
| `instagram-comments-collect-by-url.json` | `gd_ltppn085pokosxh13` | yes |
| `instagram-posts-collect-by-url.json` | `gd_lk5ns7kz21pck8jpis` | yes |
| `instagram-profiles-collect-by-url.json` | `gd_l1vikfch901nx3by4` | yes |
| `instagram-reels-collect-by-url.json` | `gd_lyclm20il4r5helnj` | yes |
| `linkedin-companies-collect-by-url.json` | `gd_l1vikfnt1wgvvqz95w` | yes |
| `linkedin-jobs-collect-by-url.json` | `gd_lpfll7v5hcqtkxl6l` | yes |
| `linkedin-posts-collect-by-url.json` | `gd_lyy3tktm25m4avu764` | yes |
| `linkedin-profiles-collect-by-url.json` | `gd_l1viktl72bvl7bjuj0` | yes |
| `reddit-posts-collect-by-url.json` | `gd_lvz8ah06191smkebj4` | yes |
| `tiktok-comments-collect-by-url.json` | `gd_lkf2st302ap89utw5k` | yes |
| `tiktok-posts-collect-by-url.json` | `gd_lu702nij2f790tmv9h` | yes |
| `tiktok-profiles-collect-by-url.json` | `gd_l1villgoiiidt09ci` | yes |
| `youtube-videos-collect-by-url.json` | `gd_lk56epmy2i5g7lzu0k` | yes |

### 3.5 The 14 Chinese-language copies

`api-reference/cn-openapi.json`, `cn-dca-api.json`, `cn-unlocker-rest-api.json`, `cn-serp-rest-api.json`, `cn-proxy-rest-api.json`, `cn-web-scraper-ide-rest-api.json`, `cn-openapi-reseller.json`, `cn-filter-csv-json.json`, `rest-api/scraper/cn-scraper-rest-api.json`, `scrapers/cn-web-scraper-ide-rest-api.json`, and under `cn/api-reference/`: `openapi.json`, `proxy-rest-api.json`, `openapi-reseller.json`, `datasets-rest-api.json`. Same base URL and paths as the English documents; several are older and shorter (the `cn/api-reference/openapi.json` copy has 40 operations against 50). Not needed.

### 3.6 Documented REST endpoints that are in no spec

| Endpoint | Documented at | Shape | Reachable today |
| - | - | - | - |
| `POST /datasets/search/{dataset_id}` | https://docs.brightdata.com/api-reference/marketplace-dataset-api/search-dataset.md | Body: `filter` (object, required), `size` (number, default 100, up to 1,000), `sort` (`"default"`, `"random"`, or an array such as `[{"timestamp":"asc"}]`), `search_after` (array). Returns `hits`, `total_hits`, `took`, `search_after`. Three datasets only: `gd_l1viktl72bvl7bjuj0` (LinkedIn people), `gd_me5ppxjr2ge6icjuh0` (LinkedIn people, contact-enriched), `gd_l1vikfnt1wgvvqz95w` (LinkedIn companies). Errors: 402 not enough funds, 404 unsupported dataset, 422 zero matches | Yes, through MCP `search_dataset`, capped at 10 records per call |
| `GET /datasets/{dataset_id}/metadata` | https://docs.brightdata.com/api-reference/marketplace-dataset-api/get-dataset-metadata.md (the docs navigation points it at `dca-api.json`, which does not contain it) | No body. Returns the dataset's fields with types and descriptions | Yes, through MCP `list_dataset_fields`, for the same three datasets |
| `POST /sophie/dialog`, `GET /sophie/dialog/{dialog_id}` | Not documented. Found in `sophie_assistant.js` of the MCP server | POST body `{"message": "...", "dialog_id": "<optional>"}` returns `dialog_id`; GET returns the message list, polled every 2 s for up to 60 s | Yes, through MCP `ask_brightdata_assistant` |
| `GET https://docs.brightdata.com/scrapers.json` | https://docs.brightdata.com/llms.txt | Public, no key, different host. `{count, scrapers: [{dataset_id, name, domain, collection_methods}]}`, 272 KB, refreshed daily | Yes, through MCP `search_scrapers`, which searches this file |
| `GET https://docs.brightdata.com/scrapers/{dataset_id}.json` | same | Public. One scraper's input schema and output fields per method | Fallback of MCP `get_scraper_details` |
| `GET https://docs.brightdata.com/scrapers/{domain}.json` | same | Public. Exists for ten domains only: linkedin.com, instagram.com, tiktok.com, amazon.com, facebook.com, x.com, youtube.com, reddit.com, chatgpt.com, google.com | No |
| `GET https://docs.brightdata.com/scrapers-full.json` | same | Public. Every scraper with schemas, samples, category and description, 7.4 MB | No |
| `GET /serp/duckduckgo/kl_values`, `GET /serp/duckduckgo/kad_values` | Linked from the DuckDuckGo parameter page | Lookup lists of region and language codes. Auth requirement UNCONFIRMED | No |

### 3.7 Products asked about that have no current API documentation

| Product | Finding |
| - | - |
| **Crawl API** | Renamed **Fetch API**. It is one scraper in the Web Scraper API: `POST /datasets/v3/scrape?dataset_id=gd_m6gjtfmeh43we6cqc` (or `/trigger`), returning `markdown`, `html2text`, `page_html` and `ld_json` per URL. The old docs URL redirects to https://docs.brightdata.com/api-reference/scrapers/web-content-apis/fetch-api-collect-by-url. The marketing page https://brightdata.com/products/crawl-api still describes whole-site crawling, but the catalogue entry offers only `collect_by_url` and no link-following endpoint is documented |
| **Discover API** | No page, no spec, zero mentions in the full docs text. The old docs URL (`/api-reference/discover/overview`) redirects to the Web Scraper overview and the product page `brightdata.com/products/discover-api` redirects to the home page. The MCP server removed its `discover` tool "and its Discover API integration" in 4.0.0 (2026-10-18). The price list in https://brightdata.com/llms.txt still has a row "Discover API: Free". Whether `POST /discover` still answers is **UNCONFIRMED**; treat it as retired |
| **Deep Lookup** | No API page and no spec. The old docs URL redirects to a leftover datasets page. It is listed as a beta product at `deeplookup.com` and as a Control Panel feature. API availability **UNCONFIRMED** |
| **Marketplace Dataset API** | Documented and mostly in `dca-api.json` (section 3.2); the two exceptions are in section 3.6 |
| **Browser API** | Browser control has no REST API. It is a Chrome DevTools Protocol websocket, `wss://brd-customer-<account id>-zone-<zone>:<zone password>@brd.superproxy.io:9222`, driven with Playwright, Puppeteer or Selenium. Only the two session-record operations in `browser-api.json` are REST |
| **Proxies** (residential, datacenter, ISP) | Proxy protocol, not REST, apart from the Proxy REST API in document 4. Zone management is in the Account Management API |
| **Proxy Manager** | An open-source program the customer runs; its 35 documented endpoints are on that local program, not on `api.brightdata.com` |
| **Data feeds, Data Firehose, Jobs Data API, Company Data API, Retail Intelligence, managed services** | Marketing pages only; no API documentation found. **UNCONFIRMED** whether any has an endpoint beyond those above |

## 4. The hosted MCP server

### 4.1 Endpoints and authentication

| Item | Value | Source |
| - | - | - |
| Streamable HTTP | `https://mcp.brightdata.com/mcp?token=<API key>` | `/remote/quickstart.md` |
| SSE | `https://mcp.brightdata.com/sse?token=<API key>` | same |
| Alternative auth | OAuth 2.1 with the access token in an `Authorization: Bearer` header (PKCE S256, dynamic client registration, scope `mcp`). An API key in a header is not documented | `/remote/oauth.md` |
| Local equivalent | `npx @brightdata/mcp` with `API_TOKEN` | repository README |

### 4.2 URL parameters (hosted) and environment variables (local)

| Hosted URL parameter | Local variable | Effect |
| - | - | - |
| `&groups=<ids>` | `GROUPS` | Limits the server to those groups. Documented ids: `scrapers`, `browser`, `advanced_scraping`, `geo` |
| `&tools=<names>` | `TOOLS` | Adds individual tools; on its own, limits the server to exactly those tools |
| `&serp=<zone>` | `SERP_ZONE` | SERP zone used by the search tools (default `mcp_serp`) |
| `&browser=<zone>` | `BROWSER_ZONE` | Browser zone (default `mcp_browser`) |
| not documented for hosted | `RATE_LIMIT`, `BASE_TIMEOUT`, `BASE_MAX_RETRIES`, `CONTENT_GATE`, `CONTENT_GATE_TIMEOUT`, `BROWSER_FILTERED_SNAPSHOT` | Local only |
| `&pro=1` | `PRO_MODE` | **No longer exists.** Removed in 3.1.0; the local server ignores it. Not in the hosted docs. Whether the hosted server still accepts and ignores `&pro=1` is UNCONFIRMED |

### 4.3 The tool universe

The server registers every tool unless `GROUPS` or `TOOLS` is set (`server.js`: a tool is skipped only when the allowed set is non-empty and does not contain it). The set registered in the source, the union of all groups in `tool_groups.js`, and the gateway's dump are the same 30 names.

| Group id | Tools it enables | Count |
| - | - | - |
| (every group) | `search_engine`, `web_fetch`, `ask_brightdata_assistant` | 3 |
| `scrapers` | base + `search_scrapers`, `get_scraper_details`, `run_scraper`, `get_scraper_progress`, `get_scraper_results`, `refresh_scrapers` | 9 |
| `browser` | base + the 14 `scraping_browser_*` tools | 17 |
| `advanced_scraping` | base + `search_engine_batch`, `scrape_batch`, `session_stats` | 6 |
| `geo` | base + `chatgpt_ai_insights` | 4 |
| `social`, `business` (older ids, still accepted) | the `scrapers` set + `list_dataset_fields`, `search_dataset`, `business_search` | 12 |
| `ecommerce`, `finance`, `research`, `app_stores`, `travel`, `code` (older ids) | same as `scrapers` | 9 |

- **Maximum tool set: `https://mcp.brightdata.com/mcp?token=<API key>` with no `groups` and no `tools` parameter. 30 tools.** This is what the gateway already connects to.
- The four documented groups together (`&groups=scrapers,browser,advanced_scraping,geo`) give **27**, not 30: `list_dataset_fields`, `search_dataset` and `business_search` belong only to the older ids. `&groups=scrapers,browser,advanced_scraping,geo,business` gives 30 (computed from the source; not run).
- An old name in `tools` still resolves: `scrape_as_markdown` enables `web_fetch`; any `web_data_*` name enables the six scraper tools.
- The docs tool table (https://docs.brightdata.com/products/mcp-server/tools.md) says 30 and lists 29; it omits `business_search`, added four days before this snapshot. The README has one heading that says 31.

### 4.4 How the tool set changed (from `CHANGELOG.md`)

| Date | Version | Change |
| - | - | - |
| 2026-10-08 | 2.12.0 | Six scraper tools added over a self-updating catalogue; content gate added |
| 2026-10-11 | 3.0.0 | **46 `web_data_*` tools removed**, plus `web_data_grok_ai_insights` and `web_data_reuter_news` (their scrapers no longer existed). `web_data_chatgpt_ai_insights` and `web_data_perplexity_ai_insights` renamed without the prefix |
| 2026-10-15 | 3.1.0 | All tools on by default. **`PRO_MODE` removed** |
| 2026-10-18 | 4.0.0 | `ask_brightdata_assistant` added. **`discover` removed** |
| 2026-11-01 | 4.2.0 | Page tools moved from Web Unlocker to the Fetch API: **no JavaScript rendering** |
| 2026-11-02 | 4.3.0 | Search moved to a SERP zone; Bing became the default engine; Yandex removed |
| 2026-11-05 | 4.6.0 | `scrape_as_html` and `extract` removed; the server no longer uses a Web Unlocker zone |
| 2026-11-10 | 4.8.0 | Long pages can be read in parts from the saved snapshot |
| 2026-11-23 | 4.9.0 | `business_search` added; the two MCP prompts removed |
| 2026-11-26 | 4.10.0 | `scrape_as_markdown` renamed `web_fetch`; `perplexity_ai_insights` removed |

Before 3.1.0 the default mode offered five tools (`search_engine`, `scrape_as_markdown`, `search_engine_batch`, `scrape_batch`, `discover`) and `PRO_MODE=true` unlocked the rest (September 2026 `server.js`). There are no modes now. The word "rapid" for the default mode appears in neither the current docs nor the September 2026 README.

The 50 retired dataset tools and where their scrapers are today. They used 49 distinct dataset ids (the two X tools shared one); 46 of those ids are still in the catalogue and can be run with `run_scraper` or `POST /datasets/v3/scrape`:

| Retired tool | `dataset_id` | Catalogue name today | Methods today |
| - | - | - | - |
| `web_data_amazon_product` | `gd_l7q7dkf244hwjntr0` | Amazon products | collect_by_url, discover_by_best_sellers_url, discover_by_category_url, discover_by_keyword, discover_by_upc |
| `web_data_amazon_product_reviews` | `gd_le8e811kzy4ggddlq` | Amazon Reviews | collect_by_url |
| `web_data_amazon_product_search` | `gd_lwdb4vjm1ehb499uxs` | Amazon products search | collect_by_url |
| `web_data_walmart_product` | `gd_l95fol7l1ru6rlo116` | Walmart - products | collect_by_url, discover_by_category_url, discover_by_keyword, discover_by_sku |
| `web_data_walmart_seller` | `gd_m7ke48w81ocyu4hhz0` | Walmart sellers info | collect_by_url |
| `web_data_ebay_product` | `gd_ltr9mjt81n0zzdk1fb` | eBay | collect_by_url, discover_by_category, discover_by_keywords, discover_by_shop_url |
| `web_data_homedepot_products` | `gd_lmusivh019i7g97q2n` | Home Depot US | collect_by_url, discover_by_category_url, discover_by_keyword, discover_by_upc, discover_by_url |
| `web_data_zara_products` | `gd_lct4vafw1tgx27d4o0` | Zara - Products | collect_by_url, discover_by_category |
| `web_data_etsy_products` | `gd_ltppk0jdv1jqz25mz` | Etsy | collect_by_url, discover_by_keywords, discover_by_shop_url |
| `web_data_bestbuy_products` | `gd_ltre1jqe1jfr7cccf` | Best Buy products | collect_by_url, discover_by_keywords |
| `web_data_linkedin_person_profile` | `gd_l1viktl72bvl7bjuj0` | LinkedIn people profiles | collect_by_url |
| `web_data_linkedin_company_profile` | `gd_l1vikfnt1wgvvqz95w` | LinkedIn company information | collect_by_url |
| `web_data_linkedin_job_listings` | `gd_lpfll7v5hcqtkxl6l` | Linkedin job listings information | collect_by_url, discover_by_keyword, discover_by_url |
| `web_data_linkedin_posts` | `gd_lyy3tktm25m4avu764` | LinkedIn posts | collect_by_url, discover_by_company_url, discover_by_profile_url, discover_by_url |
| `web_data_linkedin_people_search` | `gd_m8d03he47z8nwb5xc` | LinkedIn people search | collect_by_url |
| `web_data_crunchbase_company` | `gd_l1vijqt9jfj7olije` | Crunchbase companies information | collect_by_url, discover_by_keyword |
| `web_data_zoominfo_company_profile` | `gd_m0ci4a4ivx3j5l6nx` | Zoominfo companies information | collect_by_url, discover_by_search_url |
| `web_data_instagram_profiles` | `gd_l1vikfch901nx3by4` | Instagram - Profiles | collect_by_url, discover_by_user_name |
| `web_data_instagram_posts` | `gd_lk5ns7kz21pck8jpis` | Instagram - Posts | collect_by_url, discover_by_url |
| `web_data_instagram_reels` | `gd_lyclm20il4r5helnj` | Instagram - Reels | collect_by_url, discover_by_url, discover_by_url_all_reels |
| `web_data_instagram_comments` | `gd_ltppn085pokosxh13` | Instagram - Comments | collect_by_url |
| `web_data_facebook_posts` | `gd_lyclm1571iy3mv57zw` | Facebook - Posts by post URL | collect_by_url |
| `web_data_facebook_marketplace_listings` | `gd_lvt9iwuh6fbcwmx1a` | Facebook Marketplace | collect_by_url, discover_by_keyword, discover_by_url |
| `web_data_facebook_company_reviews` | `gd_m0dtqpiu1mbcyc2g86` | Facebook Company Reviews | collect_by_url |
| `web_data_facebook_events` | `gd_m14sd0to1jz48ppm51` | Facebook Events | collect_by_url, discover_by_url, discover_by_venue |
| `web_data_tiktok_profiles` | `gd_l1villgoiiidt09ci` | TikTok - Profiles | collect_by_url, discover_by_search_url |
| `web_data_tiktok_posts` | `gd_lu702nij2f790tmv9h` | TikTok - Posts | collect_by_url, discover_by_keyword, discover_by_profile_url, discover_by_url |
| `web_data_tiktok_shop` | `gd_m45m1u911dsa4274pi` | TikTok Shop | collect_by_url, discover_by_category, discover_by_keyword, discover_by_shop |
| `web_data_tiktok_comments` | `gd_lkf2st302ap89utw5k` | TikTok - Comments | collect_by_url |
| `web_data_google_maps_reviews` | `gd_luzfs1dn2oa0teb81` | Google maps reviews | collect_by_url |
| `web_data_google_shopping` | `gd_ltppk50q18kdw67omz` | Google Shopping | collect_by_url, discover_by_keyword |
| `web_data_google_play_store` | `gd_lsk382l8xei8vzm4u` | Google Play Store | collect_by_url |
| `web_data_apple_app_store` | `gd_lsk9ki3u2iishmwrui` | Apple App Store | collect_by_url |
| `web_data_reuter_news` | `gd_lyptx9h74wtlvpnfu` | not in catalogue | — |
| `web_data_github_repository_file` | `gd_lyrexgxc24b3d4imjt` | Github repository | collect_by_url, discover_by_search_url, discover_by_url |
| `web_data_yahoo_finance_business` | `gd_lmrpz3vxmz972ghd7` | Yahoo Finance business information | collect_by_url, discover_by_keyword |
| `web_data_x_posts` | `gd_lwxkxvnf1cynvib9co` | X (formerly Twitter) - Posts | collect_by_url, discover_by_profile_url |
| `web_data_x_profile_posts` | `gd_lwxkxvnf1cynvib9co` | X (formerly Twitter) - Posts | collect_by_url, discover_by_profile_url |
| `web_data_zillow_properties_listing` | `gd_lfqkr8wm13ixtbd8f5` | Zillow properties listing information | collect_by_url, discover_by_input_filters, discover_by_url |
| `web_data_booking_hotel_listings` | `gd_m5mbdl081229ln6t4a` | Booking Hotel Listings | collect_by_url |
| `web_data_youtube_profiles` | `gd_lk538t2k2p1k3oos71` | YouTube - Channels | collect_by_url, discover_by_keyword |
| `web_data_youtube_comments` | `gd_lk9q0ew71spt1mxywf` | Youtube - Comments | collect_by_url |
| `web_data_reddit_posts` | `gd_lvz8ah06191smkebj4` | Reddit- Posts | collect_by_url, discover_by_author_url, discover_by_keyword, discover_by_subreddit_url |
| `web_data_reddit_comments` | `gd_lvzdpsdlw09j6t702` | Reddit - Comments | collect_by_url |
| `web_data_youtube_videos` | `gd_lk56epmy2i5g7lzu0k` | Youtube - Videos posts | collect_by_url, discover_by_explore, discover_by_hashtag, discover_by_keyword, discover_by_podcast_url, discover_by_search_filters, discover_by_url |
| `web_data_chatgpt_ai_insights` | `gd_m7aof0k82r803d5bjm` | ChatGPT Search | collect_by_url |
| `web_data_grok_ai_insights` | `gd_m8ve0u141icu75ae74` | not in catalogue | — |
| `web_data_perplexity_ai_insights` | `gd_m7dhdot1vw9a7gc1n` | not in catalogue | — |
| `web_data_npm_package` | `gd_mk57m0301khq4jmsul` | npmjs | collect_by_url |
| `web_data_pypi_package` | `gd_mk57kc3t1wwgmnepp9` | pypi | collect_by_url |

### 4.5 What each MCP tool calls

Every non-browser tool is a thin wrapper over REST calls from section 3. Source: `server.js`, `scraper_catalog.js`, `scraper_run.js`, `business_search.js`, `sophie_assistant.js`, `browser_tools.js`.

| MCP tool | Underlying call | Limits the wrapper adds |
| - | - | - |
| `search_engine`, `search_engine_batch` | `POST /request` with the SERP zone, `format: raw`, `data_format: parsed_light` (Google) or `parsed_bing` (Bing) | Bing or Google only; organic `link`, `title`, `description` only; 10 per page; 5 queries per batch; 55 s |
| `web_fetch`, `scrape_batch` | `POST /datasets/v3/scrape?dataset_id=gd_m6gjtfmeh43we6cqc` (Fetch API); batches through trigger and snapshot | No JavaScript rendering; cut at 40,000 characters (rest readable by `snapshot_id`); 45 s; 5 URLs per batch |
| `search_scrapers` | `GET https://docs.brightdata.com/scrapers.json` (public), keyword match on name and domain | Up to 50 results |
| `get_scraper_details` | `GET /datasets/v3/scrapers?dataset_id=…`; falls back to the public `scrapers/{id}.json` | One method at a time |
| `run_scraper` | `POST /datasets/v3/trigger` (`type=discover_new`, `discover_by`, `limit_per_input` for discover methods), then polls `GET /datasets/v3/snapshot/{id}?format=json` | Waits 45 s, then hands back the `snapshot_id`; `limit_per_input` 1 to 1,000, default 10; no cancel tool |
| `get_scraper_progress` | `GET /datasets/v3/progress/{snapshot_id}` | |
| `get_scraper_results` | `GET /datasets/v3/snapshot/{snapshot_id}?format=json` | |
| `list_dataset_fields` | `GET /datasets/{dataset_id}/metadata` | Three LinkedIn dataset ids |
| `search_dataset` | `POST /datasets/search/{dataset_id}` | 10 records per call (REST allows 1,000) |
| `business_search` | `POST /search/company` or `/search/people` | 10 records per call (REST allows 100 in two of three modes) |
| `chatgpt_ai_insights` | `POST /datasets/v3/trigger?dataset_id=gd_m7aof0k82r803d5bjm`, polled for up to 600 s | One prompt, web search off |
| `ask_brightdata_assistant` | `POST /sophie/dialog`, `GET /sophie/dialog/{id}` | 60 s |
| 14 `scraping_browser_*` | `GET /zone/passwords?zone=<browser zone>`, then Playwright over the CDP websocket | One session per MCP connection |
| `session_stats`, `refresh_scrapers` | In-process only | |

### 4.6 Two behaviours that matter behind a gateway

| Behaviour | Detail | Status |
| - | - | - |
| Content gate | When a page or search result contains text that reads like instructions to change MCP configuration (`mcpServers`, `npx -y`, `.mcp.json`, `claude_desktop_config.json`, "add … MCP config"), the server asks the user through MCP elicitation. A client that does not declare the elicitation capability gets the content **withheld**. The gateway's MCP client declares no capabilities. Pages about MCP setup, which coding agents read often, would therefore come back as a refusal. Applies to `web_fetch`, `search_engine` and their batch forms | In the local server source (`content_gate.js`, on by default). Whether the hosted server runs the same gate is UNCONFIRMED. The REST calls have no gate |
| Out-of-credit signal | The server recognises an exhausted account by the response header `x-brd-err-code: client_10100` and reports it as text starting `Usage limit reached:`. A key restricted to other IPs is `client_10030`, reported as `IP not allowed:`. A rejected key is `Sign-in failed:` | From `errors.js`. The gateway's quota pattern (`src/gateway/core.ts`) matches none of these texts, so it would not move to the next key |

### 4.7 The docs MCP server (a second, separate server)

`https://docs.brightdata.com/mcp`, streamable HTTP, **no authentication**. Three tools, listed live on the date above: `search_bright_data_docs`, `query_docs_filesystem_bright_data_docs` (read-only shell over the docs pages and OpenAPI files) and `submit_feedback`. Limits: 200 requests per user per hour. Free. Source: https://docs.brightdata.com/general/docs-mcp.md

## 5. The scraper catalogue

### 5.1 Size (counted from `scrapers.json` and `scrapers-full.json`)

| Measure | Count |
| - | - |
| Scrapers (`count` field and array length agree) | 1,304 |
| Distinct domains | 1,210 |
| Collection methods in total | 1,912 |
| Distinct method names | 49 |
| Scrapers with at least one `discover_by_*` method | 507 |
| Scrapers with only `collect_by_url` | 797 |

Marketing copy says "1,200+" (MCP), "thousands" (docs) and "1500+" (brightdata.com); the file says 1,304.

| Category (from `scrapers-full.json`) | Scrapers |
| - | - |
| `ecomm` | 1179 |
| `social` | 40 |
| `business` | 26 |
| `travel` | 17 |
| `real_estate` | 16 |
| `Data for AI` | 5 |
| `free_datasets` | 4 |
| `ad_verification` | 4 |
| `AI Search` | 4 |
| `classifieds` | 3 |
| `(none)` | 3 |
| `other` | 1 |
| `financial` | 1 |
| `geospatial` | 1 |

| Collection method | Scrapers offering it |
| - | - |
| `collect_by_url` | 1304 |
| `discover_by_sitemap` | 337 |
| `discover_by_category` | 60 |
| `discover_by_keyword` | 51 |
| `discover_by_category_url` | 44 |
| `discover_by_url` | 22 |
| `discover_by_search_url` | 9 |
| `discover_by_location` | 7 |
| `discover_by_keywords` | 7 |
| `discover_by_sku` | 6 |
| `discover_by_brand` | 5 |
| `discover_by_profile_url` | 5 |
| (other 37 method names) | 55 |

Scrapers most relevant to a coding agent: GitHub repository (`gd_lyrexgxc24b3d4imjt`: by URL, by search URL), npm (`gd_mk57m0301khq4jmsul`), PyPI (`gd_mk57kc3t1wwgmnepp9`), Wikipedia articles (`gd_lr9978962kkjr3nx49`), Reddit posts and comments, YouTube videos and comments, Google SERP 100 results (`gd_mfz5x93lmsjjjylob`), Google AI Mode (`gd_mcswdt6z2elth3zqr2`), ChatGPT (`gd_m7aof0k82r803d5bjm`), Gemini (`gd_mbz66arm2mf9cu856y`), and the Fetch API for any URL (`gd_m6gjtfmeh43we6cqc`).

### 5.2 Discovering and running a scraper

| Step | Over REST | Over MCP |
| - | - | - |
| Find a scraper | Public: `GET https://docs.brightdata.com/scrapers.json` (no key). With a key: `GET /datasets/v3/scrapers?domain=<domain>` | `search_scrapers(query, limit)` |
| Read its inputs | `GET /datasets/v3/scrapers?dataset_id=<id>` (input schema, sample input and output fields per method), or the public `scrapers/<id>.json` | `get_scraper_details(dataset_id, method)` |
| Run, results in the response | `POST /datasets/v3/scrape?dataset_id=<id>&format=json`, body `[{"url": "…"}]`. Waits up to 1 minute; then HTTP 202 with a `snapshot_id`. One input per request is recommended | `run_scraper(dataset_id, method, input, limit_per_input)`: always async underneath, waits 45 s |
| Run as a job | `POST /datasets/v3/trigger?dataset_id=<id>` (add `type=discover_new&discover_by=<name>&limit_per_input=<n>` for a discover method). Up to 1 GB of input per job. Optional webhook or storage delivery | same tool |
| Check | `GET /datasets/v3/progress/{snapshot_id}` | `get_scraper_progress` |
| Fetch records | `GET /datasets/v3/snapshot/{snapshot_id}?format=json` (also `ndjson`, `csv`; parts for large results). Kept 30 days | `get_scraper_results` |
| Stop, rerun, inspect | `POST …/cancel`, `/pause`, `/resume`, `/rerun`; `GET /datasets/v3/log/{snapshot_id}`; `GET /datasets/v3/snapshots?dataset_id=<id>` | Not available |
| Cost of a finished job | `GET /datasets/snapshots/{id}` returns `cost`, `dataset_size`, `status` | Not available |

Limits (https://docs.brightdata.com/products/scrapers/limits.md): 5,000 running jobs per dataset; 25 HTTP 429 responses from one IP within 5 minutes blocks that IP for an hour; 5 GB per download request.

### 5.3 Price per record

| Plan | Price | Source |
| - | - | - |
| Free tier | 1 credit per delivered record, from the shared 5,000 credits a month | free-tier page |
| Pay as you go | $1.50 per 1,000 records | https://brightdata.com/pricing/web-scraper; scraper FAQ ("as of September 2026") |
| $499 a month plan | $1.30 per 1,000 additional records | same |
| Lowest advertised | "From $0.75/1K records" | https://brightdata.com/llms.txt |

- The catalogue files carry no price field. Whether any scraper is priced differently from the flat rate is UNCONFIRMED.
- A `discover_by_*` method bills every record it returns; `limit_per_input` is the cap.
- The docs disagree on failures: the scraper FAQ says records that fail because the input was wrong are still billed; a concepts page says failed deliveries are not charged.

## 6. SDKs, CLI, free tier, and usage endpoints

### 6.1 What is reachable only by SDK, CLI or browser library

| Surface | Reachable by | REST equivalent |
| - | - | - |
| Browser control (navigate, click, type, screenshot) | Playwright, Puppeteer or Selenium on the CDP websocket; the CLI's `brightdata browser …` commands; the SDKs' `client.browser.get_connect_url()`; the MCP `scraping_browser_*` tools | **None** |
| Proxy traffic | Any HTTP client using the proxy protocol with zone credentials | Only the Proxy REST API form of `POST /request` |
| Scraper Studio IDE (writing scraper code by hand) | Control Panel in a browser | The AI generation and self-healing endpoints in `/dca/*` cover creation from a prompt |
| Account creation without a form | A documented registration protocol at https://brightdata.com/auth.md (email plus a 6-character code, or a GitHub identity). It returns a key and three ready zones named `agent_serp`, `agent_unlocker`, `agent_browser_api` | Its own endpoints under `brightdata.com/users/auth/agent_registration/`. Not something a gateway should expose |
| Creating API keys, KYC, buying a Marketplace dataset, Deep Lookup, Retail Intelligence | Control Panel | None documented |

Everything else the tools do is REST underneath:

| Tool | Install | Commands or methods | Maps to |
| - | - | - | - |
| CLI (`@brightdata/cli`, alias `bdata`; https://github.com/brightdata/cli) | `npx -p @brightdata/cli brightdata` | `scrape` (markdown, html, screenshot, json), `search` (google, bing, yandex; web, news, images, shopping), `pipelines search/info/run/status/results/refresh`, `scraper create/run/heal/approve`, `browser …`, `zones`, `budget`, `config`, `login`, `init`, `skill add`, `add mcp` | `POST /request`, `/datasets/v3/*`, `/dca/*`, `/zone/*`, `/customer/balance`, `/zone/cost`. First login creates zones `cli_unlocker` and `cli_browser` |
| Python SDK (`brightdata-sdk`; https://github.com/brightdata/sdk-python) | `pip install brightdata-sdk` | `client.scrape_url`, `client.search.google/bing/yandex`, `client.scrape.<platform>.<method>` (Amazon, LinkedIn, Facebook, Instagram, TikTok, YouTube, Reddit, Pinterest, ChatGPT, Perplexity, DigiKey), `client.scraper_studio.*`, `client.datasets.*`, typed payload classes, automatic polling and zone creation | Same endpoints |
| JavaScript SDK (`@brightdata/sdk`; https://github.com/brightdata/bright-data-sdk-js) | `npm install @brightdata/sdk` | The same families in camelCase, plus `listZones()` | Same endpoints |
| Agent skills (https://github.com/brightdata/skills) | `npx skills add brightdata/skills` | Instruction files that drive the CLI | Nothing new |

### 6.2 Free tier

| Item | Value | Source |
| - | - | - |
| Allowance | 5,000 credits a month per account (about $7.50), one shared pool, renewed on the 1st, no rollover, no card needed | free-tier page |
| Covered, 1 credit each | Web Unlocker API request; SERP API request; Web Scraper API record (this includes Fetch API records) | same |
| Covered, other rates | Scraper Studio: 1 credit per page load. Browser API: 5 credits per MB (about 1 GB a month) | same; the Browser API pricing page also shows "1GB included per month" |
| Conflict | https://brightdata.com/llms.txt ("Last updated: October 2026") says the free tier does **not** cover the Browser API. The docs page and the pricing page say it does | |
| Not covered | Datacenter, ISP and residential proxies (they get a one-time $2 trial credit, plus $5 when a payment method is added) | free-tier page |
| Not mentioned either way | Business Search, Marketplace Dataset search and filter, Web Archive, Media Data. Treat as paid; UNCONFIRMED | |
| MCP "5,000 requests a month" | The same pool, not a second allowance. MCP search draws on the SERP API and MCP page fetch on the Fetch API | free-tier page; MCP overview |
| When it runs out | With no deposited funds: requests fail (hard stop). With funds: usage continues at pay-as-you-go rates | free-tier page |
| Rate limit while unfunded | 1,000 requests a minute across SERP, Unlocker and proxies | same |
| Not eligible | Accounts on custom pay-as-you-go pricing or pre-commit plans | same |
| Team accounts | The pool is shared by all users of the account | MCP overview |

### 6.3 Endpoints a usage tracker can poll with the API key

All are `GET` on `https://api.brightdata.com` unless marked, in `openapi.json` unless noted.

| Endpoint | Returns | Notes |
| - | - | - |
| `GET /trials/free_tier` | `is_enabled`, `included_credits`, `used_credits`, `left_credits` | The free-credit counter. Needs a key with Admin or Finance permission (`billing.read`). Limit 600 requests a minute per IP |
| `GET /customer/balance` | `balance`, `credit`, `prepayment`, `pending_costs` (USD) | Paid balance and this month's pending cost |
| `POST /costs/export/json` | Cost per day, keyed by the chosen `dimension`: `products`, `types`, `zones`, `datasets`, `web_apis`, `collectors`, `domains`, `ws_api_snaps`, `snapshots`. Body needs `dimension`, `from`, `to` (`to` is exclusive) | Same data as the Control Panel cost explorer. `POST /costs/export/csv` is the CSV form |
| `GET /zone/cost?zone=&from=&to=` | Cost and bandwidth for one zone, by day and month | Needs the zone name |
| `GET /zone/bw`, `GET /customer/bw` | Bandwidth per zone, or for all zones | |
| `GET /pricing_plans` | Current plan and per-product prices | Admin or Finance key |
| `GET /status` | `status`, `can_make_requests`, `auth_fail_reason` | Cheap liveness and key check |
| `GET /zone/get_active_zones`, `GET /zone?zone=` | Zones and their configuration | Tells a tracker which zone names exist |
| `GET /datasets/snapshots/{id}` (`dca-api.json`) | `cost`, `dataset_size`, `status` of one scraper or dataset job | Per-job cost |
| `GET /datasets/v3/snapshots?dataset_id=` (`dca-api.json`) | Jobs run against one scraper | |
| `GET /browser_sessions` (`browser-api.json`) | Past browser sessions | |
| `GET /domains/{metric}` (`proxy-manager.json`) | Bandwidth or request count per target domain | Usage only, never cost |
| `GET /unblocker/success_rate/{domain}` (`unlocker-rest-api.json`) | Success rate for a domain | |

Individual data responses do not report what the call cost. The Unlocker's optional `debug` flag adds an `x-brd-debug` response header with a billing status, which the gateway does not read.

## 7. Comparison with the gateway

### 7.1 What the gateway does not expose, and how to add it

| Missing | How to add | Detail |
| - | - | - |
| All 123 REST operations | **OpenAPI upstream, configuration only.** Base URL `https://api.brightdata.com`, header `Authorization`, prefix `Bearer `, and the ten spec URLs of section 9 item 1 | The API key is the same one the MCP URL takes as `token` |
| Full search-engine results (Google full parsed JSON with ads, knowledge panel, people-also-ask, AI overview; news, images, videos, shopping, jobs, maps, hotels, flights, trends, lens, reviews; DuckDuckGo, Yandex, Baidu, Yahoo, Naver; city-level location; mobile; more than 10 results) | Tool `unlockUrl` (`POST /request`) with a SERP zone and the search URL | The MCP `search_engine` returns only Bing or Google organic links |
| Page fetch with JavaScript rendering, country choice, no 40,000-character cut | Tool `unlockUrl` with a Web Unlocker zone, `render: "true"`, `data_format: "markdown"` | The MCP `web_fetch` does not render JavaScript |
| Scraper job control: sync scrape with `custom_output_fields` and `format`, cancel, rerun, logs, job list, per-job cost, delivery to storage | Tools `scrapeSync`, `triggerScrape`, `getScrapeProgress`, `downloadScrapeSnapshot`, `cancelScrape`, `listScrapeSnapshots`, `getScrapeSnapshotLog`, `getDatasetSnapshot` | |
| Marketplace datasets: list, filter any of 900+ datasets, download | Tools `listDatasets`, `filterDataset`, `getDatasetSnapshot`, `downloadDatasetSnapshot` | $2.50 per 1,000 records |
| Business Search at full page size | Tools `searchCompany`, `searchPeople` | Already present through MCP at 10 records |
| Balance, free credits, cost, zones | Tools `getFreeTierCredits`, `getAccountBalance`, `exportCostsJson`, `getZoneCost`, `listPricingPlans`, `getAccountStatus`, `listActiveZones`, `getZone`, `createZone` | Nothing like these exists in the MCP server |
| Scraper Studio (22), Web Archive (7), browser session records (2), media (1), async Unlocker and SERP (4) | Same upstream; hide unless wanted | Low value for a coding agent |
| `POST /datasets/search/{dataset_id}` and `GET /datasets/{dataset_id}/metadata` at full size | **No machine-readable spec.** Needs a hand-written two-operation document (shapes in section 3.6), or stay with the MCP tools | |
| Support assistant | Already present through MCP. REST form is undocumented (`/sophie/dialog`) | |
| Browser control | **Not possible as an OpenAPI upstream.** Only through the MCP `scraping_browser_*` tools | |
| Docs search | **MCP upstream** at `https://docs.brightdata.com/mcp`, `auth = "none"` | 3 tools; hide `submit_feedback` |
| More MCP tools through URL parameters | **Nothing to add.** No parameter yields more than the 30 already listed | |
| Discover API, Deep Lookup | Nothing to add: no documentation and no spec (section 3.7) | |

### 7.2 The 30 current tools, rated for coding agents

| Tool | Value | Reason |
| - | - | - |
| `search_engine` | High | Cheap web search. Organic links only |
| `search_engine_batch` | High | Five searches in one call |
| `web_fetch` | High | Any URL as markdown, with paging for long pages. No JavaScript |
| `scrape_batch` | High | Five pages in one call |
| `search_scrapers` | High | The only keyword search over the catalogue; no REST call does this |
| `get_scraper_details` | High | Needed before every `run_scraper` |
| `run_scraper` | High | GitHub, npm, PyPI, Reddit, YouTube and 1,300 other sites as JSON |
| `get_scraper_progress` | Medium | Needed only when a run passes 45 s |
| `get_scraper_results` | Medium | Same |
| `business_search` | Medium | Useful for company and people lookup, not for coding. Account must be enabled |
| `list_dataset_fields` | Low | LinkedIn datasets only |
| `search_dataset` | Low | LinkedIn datasets only; $2.50 per 1,000 records |
| `chatgpt_ai_insights` | Low | What ChatGPT answers to a prompt; up to 10 minutes |
| `ask_brightdata_assistant` | Low | Vendor support bot; useful only when debugging Bright Data itself |
| `refresh_scrapers` | Low | The catalogue refreshes daily by itself |
| `session_stats` | None behind a gateway | Counts calls in one MCP session; the gateway's ledger already does this |
| `scraping_browser_navigate`, `_snapshot`, `_click_ref`, `_type_ref`, `_fill_form`, `_wait_for_ref`, `_get_text`, `_get_html`, `_screenshot`, `_scroll`, `_scroll_to_ref`, `_go_back`, `_go_forward`, `_network_requests` (14) | Low | Step-by-step remote browser. Fourteen schemas in every tool list for a need (log in, click through) that coding agents rarely have; a JavaScript-rendered read is one `unlockUrl` call over REST. Billed by traffic. The browser session belongs to the server-side connection and the gateway keeps one connection per key, so agents behind the gateway would probably share one browser (inferred from the source, UNCONFIRMED) |

High or medium: 10. Low or none: 20 (14 of them the browser set).

### 7.3 What needs per-account setup before it works

| Capability | Needs | How it gets there |
| - | - | - |
| Web Scraper API, Fetch API, catalogue (`/datasets/v3/*`) | Nothing but the key and a `dataset_id` | |
| SERP API through `POST /request` | A zone of SERP type, named in every call | Control Panel, or `POST /zone` with `{"zone": {"name": "<name>", "type": "unblocker"}, "plan": {"type": "unblocker", "serp": true}}` (the payload the MCP server sends). The local MCP server creates a zone named `mcp_serp` at startup when it is missing; the hosted server uses the same default name, so an account that has used it since 2026-11-02 probably has one. UNCONFIRMED for any given account |
| Web Unlocker through `POST /request` | A zone of Web Unlocker type | Control Panel or `POST /zone` (zone and plan type `unblocker`; see https://docs.brightdata.com/api-reference/account-management-api/Add_a_Zone.md). The MCP server stopped creating one on 2026-11-05, so an MCP-only account may not have it |
| Browser tools | A Browser API zone and its password | The local MCP server creates `mcp_browser` itself (zone and plan type `browser_api`) and reads the password with `GET /zone/passwords` |
| Zone creation and deletion | A key with Admin or Ops permission | Key permission levels: Admin, Finance, Ops, Limit, User (https://docs.brightdata.com/api-reference/authentication.md) |
| Balance, free credits, pricing plans | A key with Admin or Finance permission | |
| Business Search | Beta access for the account ("sign up with a business email") | The MCP tool answers `Business Search not enabled` otherwise |
| Marketplace dataset search | One of three LinkedIn dataset ids; funds | |
| Scraper Studio run | A scraper (`collector` id `c_…`) created first | `POST /dca/collector`, then AI generation, or the Control Panel |
| Media Data API | Enabled by support | |
| Residential proxy zones | KYC-verified business account (zones created after 2026-07-07) | |
| Any call | The key's IP allow-list, if one is set, must include the gateway host | Otherwise error code `client_10030` |
| Zone count | 50 zones free per account, $5 a month each beyond | Billing FAQ |

## 8. Tool families: purpose and price

| Family | What it is for | Price (pay as you go) |
| - | - | - |
| SERP API (`POST /request`, SERP zone; MCP `search_engine`) | Search-engine result pages as HTML, markdown or parsed JSON | $1.50 per 1,000 successful requests; 1 free credit each. Failed requests not billed unless the zone uses custom headers or cookies |
| Web Unlocker API (`POST /request`, Unlocker zone) | Any page past anti-bot protection, optionally rendered, as HTML, markdown or screenshot | $1.50 per 1,000 requests ($1.30 on the $499 plan); 1 free credit each |
| Fetch API, formerly Crawl API (scraper `gd_m6gjtfmeh43we6cqc`; MCP `web_fetch`, `scrape_batch`) | Any URL as markdown, text, HTML and JSON-LD in one record, no rendering | Billed as a Web Scraper API record: $1.50 per 1,000; 1 free credit each |
| Web Scraper API (`/datasets/v3/*`; MCP scraper tools) | Structured JSON records from 1,304 site-specific scrapers | $1.50 per 1,000 records ($1.30 on the $499 plan); 1 free credit per record |
| Marketplace Dataset API (`/datasets/filter`, `/datasets/search/…`; MCP `search_dataset`) | Query Bright Data's stored datasets instead of scraping live | $2.50 per 1,000 records returned; zero-match queries free. Whole-dataset purchases have a $250 minimum |
| Business Search (`/search/company`, `/search/people`; MCP `business_search`) | Find companies or people by description or field conditions, from an index of over 700 million records | $2 per 1,000 searches (`instant`, `ludicrous`, up to 100 results each); $3 per 1,000 (`smart`, 10 results). Billed on results requested |
| Scraper Studio (`/dca/*`) | Build, run and repair a custom scraper for a site with no pre-built one | "From $1/1K requests"; 1 free credit per page load |
| Browser API (CDP websocket; MCP `scraping_browser_*`) | Remote browser for clicks, forms and screenshots | $8 per GB of traffic; 5 free credits per MB |
| Web Archive API (`/webarchive/*`) | Bulk export of pages Bright Data has already collected, to S3, Azure or a webhook | $0.20 per 1,000 pages from the last 24 hours; $1 per 1,000 older |
| Media Data API (`/dca/trigger_hp`) | Bulk download of media files | Media delivery is $2 per GB in the Marketplace docs; price for this API UNCONFIRMED |
| Account Management API | Zones, balance, free credits, cost, plans, status | Free (no price stated; refreshing or adding proxy IPs through it is charged per IP) |
| Proxy REST API and proxy networks | Raw requests through residential, ISP or datacenter IPs | From $2.50 per GB residential; from $0.90 per IP datacenter; from $1.30 per IP ISP. Not in the free tier |
| Hosted MCP server | The 30 tools above | No charge of its own: each tool bills as the product it calls ($1.50 per 1,000 search and fetch requests, $8 per GB browser) |
| ChatGPT scraper (MCP `chatgpt_ai_insights`) | What ChatGPT answers to a prompt, with citations | One Web Scraper API record per prompt |
| Support assistant (MCP `ask_brightdata_assistant`) | Questions about Bright Data itself | No price stated; UNCONFIRMED |
| Docs MCP server | Search Bright Data's documentation | Free, no key |
| Reseller API | Partner accounts managing sub-customers | Not applicable |

## 9. Gateway changes needed

1. **Add the REST API as an OpenAPI upstream (configuration only).** Base URL `https://api.brightdata.com`; auth header `Authorization` with prefix `Bearer `; the same key as the MCP `token`. Spec list, in this order (the order matters because later duplicates are dropped):
   1. `https://docs.brightdata.com/api-reference/dca-api.json`
   2. `https://docs.brightdata.com/api-reference/unlocker-rest-api.json`
   3. `https://docs.brightdata.com/api-reference/async-api-reference.json`
   4. `https://docs.brightdata.com/api-reference/business-search/business-search-api.json`
   5. `https://docs.brightdata.com/api-reference/openapi.json`
   6. `https://docs.brightdata.com/api-reference/web-scraper-ide-rest-api.json`
   7. `https://docs.brightdata.com/api-reference/browser-api.json`
   8. `https://docs.brightdata.com/api-reference/web-archive-api.json`
   9. `https://docs.brightdata.com/api-reference/media-data-api/media-data-api.json`
   10. `https://docs.brightdata.com/api-reference/proxy-manager.json`

   Result: 123 tools, 176 KB of schemas (confirmed with the gateway's loader on the downloaded files; no live call made). Leave out `serp-rest-api.json`, `proxy-rest-api.json`, `rest-api/scraper/scraper-rest-api.json`, `filter-csv-json.json`, `dca-custom-inputs.json`, all `sdk-specs/*.json` (they add nothing), `openapi-reseller.json` (partner-only) and every `cn` file. No fixed extra header is needed. To follow the existing naming (`exa` for the API, `examcp` for the hosted server) the preset `brightdata` would become this upstream and the current one would move to `brightdatamcp`; without a code change, add it under a new name such as `brightdataapi`.

2. **Offer a short list by default with `include`** (25 tools, 48 KB of schemas): `unlockUrl`, `getUnlockerAsyncResponse`, `scrapeSync`, `triggerScrape`, `getScrapeProgress`, `downloadScrapeSnapshot`, `cancelScrape`, `listScrapers`, `listScrapeSnapshots`, `getScrapeSnapshotLog`, `searchCompany`, `searchPeople`, `listDatasets`, `filterDataset`, `getDatasetSnapshot`, `downloadDatasetSnapshot`, `getFreeTierCredits`, `getAccountBalance`, `getZoneCost`, `exportCostsJson`, `listPricingPlans`, `getAccountStatus`, `listActiveZones`, `getZone`, `createZone`.

3. **If the full list is offered instead, hide these with `exclude`:** `listZonePasswords`, `addZonePassword`, `removeZonePassword` (zone passwords would reach the agent and the payload log); `deleteZone`, `setZoneDisabled`, `updateAccountStatus`, `setRegularAutoRecharge`, `setDatasetAutoRecharge`, `listPaymentMethods`, `addZoneStaticIps`, `removeZoneStaticIps`, `migrateZoneStaticIps`, `refreshZoneStaticIps`, `removeZoneVips`, `setZoneAutoFailover`, `addZoneAllowlistIp`, `removeZoneAllowlistIp`, `addZoneDenylistIp`, `removeZoneDenylistIp`, `addZoneDomainPermission`, `removeZoneDomainPermission`, `deleteScraperStudioScraper` (they change the account or spend money).

4. **Keep the hosted MCP URL as it is** (`https://mcp.brightdata.com/mcp`, query parameter `token`, no `groups`, no `tools`): that is already the maximum, 30 tools. Hide the low-value ones with `exclude = ["scraping_browser_*", "session_stats", "refresh_scrapers"]`, leaving 14. If browser control is wanted, expose it as a second MCP upstream on the same URL with `include = ["scraping_browser_*"]`, or reach it in lazy mode.

5. **Teach the quota check Bright Data's signals** (`src/gateway/core.ts`). Add to the quota pattern: `usage limit reached`, `out of free credits`, `not enough funds`, `client_10100`. Add to the auth pattern: `sign-in failed`, `ip not allowed`, `client_10030`. For OpenAPI upstreams, append the response header `x-brd-err-code` to the error text, because that header, not the status or body, is how Bright Data reports an exhausted account. The HTTP status that accompanies it is UNCONFIRMED.

6. **Declare the elicitation capability on the gateway's MCP client, or prefer the REST fetch for pages about MCP setup.** Without it the Bright Data server's content gate withholds such pages (section 4.6).

7. **Handle non-text responses.** `unlockUrl` with `data_format: "screenshot"` and any download with `compress=true` return bytes; return them as an image or base64 block, or refuse those argument values with a clear message.

8. **Give agents the zone names.** `unlockUrl` needs a `zone` on every call and the spec cannot say which zones the account has. Either add a per-upstream default-arguments setting, or put the SERP and Unlocker zone names in a skill. One-time account setup: create one SERP zone and one Web Unlocker zone (section 7.3).

9. **Add a two-operation hand-written spec only if 1,000-record dataset search is wanted:** `POST /datasets/search/{dataset_id}` and `GET /datasets/{dataset_id}/metadata` (shapes in section 3.6). Otherwise the MCP tools `search_dataset` and `list_dataset_fields` cover it at 10 records.

10. **Add the docs server as an MCP upstream:** `https://docs.brightdata.com/mcp`, `auth = "none"`, `exclude = ["submit_feedback"]`.

11. **Poll usage for the status tool:** `GET /trials/free_tier` and `GET /customer/balance` (key with Admin or Finance permission); read `cost` from `GET /datasets/snapshots/{id}` after a scraper job.

12. **Retire two entries of the older hand-written integration** (`src/registry/brightdata-tool-profiles.ts`): `brightdata.discover` points at documentation that no longer exists, and `brightdata.crawl` is now the Fetch API scraper `gd_m6gjtfmeh43we6cqc`, already reachable through `scrapeSync`.

## 10. Unconfirmed

| Item | Why |
| - | - |
| That the 123 operations answer as their specs describe | Tool names and schemas were confirmed with the gateway's loader, but no operation was called |
| That the hosted MCP server runs exactly the published source (content gate, error texts, group resolution) | Hosted server not contacted. Its 30 tool names do match the source |
| Whether the hosted server accepts and ignores `&pro=1` | Not documented; not tested |
| Whether `POST /discover` and any Deep Lookup endpoint still answer | No documentation; would need a key |
| HTTP status and body sent with `x-brd-err-code: client_10100` | Known only from the MCP server's error handling |
| Whether any scraper is priced above the flat per-record rate | No price field in the catalogue |
| Free-tier coverage of the Browser API | Vendor sources disagree (section 6.2) |
| Free-tier coverage of Business Search, Marketplace dataset queries, Web Archive | Not stated |
| Whether a given account already has SERP and Unlocker zones | Account not inspected |
| Auth requirement of the DuckDuckGo lookup lists | Not tested |
| Price of the support assistant and of the Media Data API | Not stated |

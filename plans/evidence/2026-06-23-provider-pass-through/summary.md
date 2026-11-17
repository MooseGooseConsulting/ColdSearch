# Gate 0 Provider Pass-Through Evidence

Generated: 2026-06-24T07:58:19.302Z

Inventory schema version: 1

## Commands

- Baseline command for this evidence: `node scripts/provider-pass-through.mjs --all`
- Native provider calls use direct HTTP requests.
- ColdSearch calls use `node dist/cli.js <path> --providers <provider> --single-provider --json`.
- Agent mode is not executed by this gate.

## Inputs

| Path | Input |
|---|---|
| search | `openai` |
| extract | default `https://example.com`; provider fallback recorded in the row input when needed |
| crawl | `https://docs.tavily.com`, limit `3` |

## Status Counts

| Status | Count |
|---|---:|
| pass | 11 |
| fail | 0 |
| blocked_missing_secret | 2 |
| blocked_provider | 0 |
| waived_by_user | 0 |

## Results

| Provider | Path | Status | Native Count | ColdSearch Count | Notes |
|---|---|---|---:|---:|---|
| tavily | search | pass | 5 | 5 | ColdSearch search output keeps title, url, snippet, score, source; raw provider-only fields are not exposed in the normalized result. |
| tavily | extract | pass | 1 | 1 | ColdSearch extract output keeps content, url, title, source; raw provider metadata is not exposed in the normalized result. |
| tavily | crawl | pass | 20 | 20 | ColdSearch crawl output keeps url, title, content and top-level provider; raw provider crawl job metadata is not exposed. |
| firecrawl | search | pass | 10 | 10 | ColdSearch search output keeps title, url, snippet, score, source; raw provider-only fields are not exposed in the normalized result. |
| firecrawl | extract | pass | 1 | 1 | ColdSearch extract output keeps content, url, title, source; raw provider metadata is not exposed in the normalized result. |
| firecrawl | crawl | pass | 3 | 3 | ColdSearch crawl output keeps url, title, content and top-level provider; raw provider crawl job metadata is not exposed. |
| exa | search | pass | 10 | 10 | ColdSearch search output keeps title, url, snippet, score, source; raw provider-only fields are not exposed in the normalized result. |
| exa | extract | pass | 1 | 1 | ColdSearch extract output keeps content, url, title, source; raw provider metadata is not exposed in the normalized result. |
| exa | crawl | pass | 3 | 3 | Exa crawl is synthesized by search discovery plus contents/livecrawl, not a native crawl endpoint.; ColdSearch crawl output keeps url, title, content and top-level provider; raw provider crawl job metadata is not exposed. |
| brave | search | pass | 10 | 10 | ColdSearch search output keeps title, url, snippet, score, source; raw provider-only fields are not exposed in the normalized result. |
| serper | search | blocked_missing_secret | - | - | missing SERPER_API_KEY; missing: SERPER_API_KEY |
| jina | extract | pass | 1 | 1 | ColdSearch extract output keeps content, url, title, source; raw provider metadata is not exposed in the normalized result. |
| searxng | search | blocked_missing_secret | - | - | missing SEARXNG_BASE_URL; missing: SEARXNG_BASE_URL |

## Evidence Files

- `results.jsonl`: one machine-readable row per required provider/path.
- `samples/`: redacted native and ColdSearch samples for rows that ran.
- `coldsearch-usage.jsonl`: usage log emitted by the ColdSearch calls.

Missing credentials or endpoints are recorded as `blocked_missing_secret`, not skipped or passed.

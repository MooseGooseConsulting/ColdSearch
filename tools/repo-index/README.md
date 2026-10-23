# repo-index

A Postgres index of GitHub repos that came up in past Claude Code and Codex sessions. Research can exclude them from new searches ("already evaluated") and still query what we concluded about each one. It serves G3 in `docs/NORTH_STAR.md` (search and reuse prior work). It is separate from ColdSearch's own execution history and cache (`docs/architecture.md`). Those record ColdSearch calls; this records what agents concluded about repos across every tool. ColdSearch search does not read it yet. Wiring it in as a result filter would need its own plan or ADR.

**Database:** Neon project `coldsearch` (`lively-wildflower-09919715`, personal org), database `repo_index`. The scripts read `REPO_INDEX_DATABASE_URL`. It is not in Doppler yet. Locally it is at `~/.config/coldsearch/repo-index.dburl` (mode 600), or get it from the Neon console.

## Tables

- `repos`: one row per canonical repo (GitHub `nameWithOwner`, so renames merge). Holds GitHub metadata, `category`, `is_research_find`, `verdict` (`adopted | rejected | reference | considered | unknown`), `summary`, `our_take`, `topics`, session counts and dates. `search_tsv` is a weighted full-text index over name, description, summary and take.
- `repo_mentions`: transcript snippets for each repo, with source, session, timestamp, cwd, kind and tool. Mentions from local file reads are not stored.
- `search_exclusions` (view): research finds plus anything adopted (even if it only surfaced as a CI pin), limited to `exclude_from_search`. This is the list a search step filters against.

```sql
-- have we looked at this already?
select full_name, verdict, our_take from search_exclusions where lower(full_name) = lower('vllm-project/vllm');
-- what have we seen about a topic?
select full_name, verdict, our_take from repos, websearch_to_tsquery('english', 'kubernetes runner') q
where search_tsv @@ q order by ts_rank(search_tsv, q) desc limit 20;
```

## Pipeline

All steps write to `OUT_DIR`, a scratch directory outside the repo, because the generated data contains transcript text. Run the Python steps with `python3 -I`.

1. `extract.py OUT_DIR` scans `~/.claude/projects` (including subagent transcripts) and `~/.codex/sessions` for `github.com`, `api.github.com/repos`, `raw.githubusercontent.com` and `gh … owner/repo` references. It tags each mention by where it appeared: `prose_assistant`, `prose_user`, `search` (web or GitHub research tools, `gh search` / `gh api` / `git clone` commands), `call`, or `local`. Placeholders and GitHub UI paths are dropped. Writes `mentions.jsonl` and `repos.json`.
2. `ghmeta.py OUT_DIR` resolves every repo in batched GraphQL calls through `gh`, picking up renames, forks, archived and deleted repos. It resumes from `ghmeta.json`.
3. `candidates.py OUT_DIR [BATCH_SIZE]` merges aliases and drops Coldaine/MooseGooseConsulting repos (forks map to their upstream). It also drops repos that only appeared in local or tool-call output. Writes `candidates.json` and `batches/batch-<run>-NNN.json` for repos not yet fully classified in `out/`, or whose snippets changed since they were classified (tracked in `fingerprints.json`). The newest `out/` file wins.
4. **Triage.** A small model (we used Haiku subagents) follows `CLASSIFIER.md`, reading `batches/batch-<run>-NNN.json` and writing `out/` files with the same name. It looks only at our transcript snippets and the GitHub description, and sets `is_research_find` and `verdict` (with a provisional one-line summary). This step only decides which repos deserve a real summary.
5. **Summarize, categorize, tag from the repo itself.** `enrich.py OUT_DIR [BATCH_SIZE]` fetches each research find's README (cleaned, truncated to 3,500 chars) and top-level file listing through GraphQL, caches them in `repo_content.json`, and writes `batches/summary-<run>-NNN.json`. A Haiku pass then follows `SUMMARIZER.md`. It writes a 2–3 sentence `summary` of what the repo does and how it is used, one `category` from a fixed list, and 3–6 normalized `topics`. It also refreshes `our_take`, `verdict` and `is_research_find` from the snippets. A repo is re-summarized only when its README changes. Pass `--all` to also summarize incidental repos.
6. `load.py OUT_DIR` builds CSVs and upserts them with `psql \copy` (`load.sql`). Rows key on `full_name`. Later `out/` files win, so `summary-*` overrides `batch-*`. For each (repo, session) it re-reads, it replaces stale snippets. Apply `schema.sql` first; it is idempotent.

In steps 4–5, READMEs and snippets are third-party text, so the model treats them as data, ignores any instructions inside them, and gets read/write access only to the batch files.

Re-runs are incremental: metadata, READMEs, triage and summaries are only redone for new or changed repos.

## Known limitations

- `ghmeta.json` caches each repo once. A repo renamed or transferred after it was cached keeps its old metadata, and if the new name later appears it loads as a separate row. Delete `ghmeta.json` to force a full refresh; merging old rows by alias is not implemented.

## First run (2026-10-22)

1,274 transcript files produced 89,370 raw mentions, which deduplicated to 53,872 across 3,366 repos. Dropping 167 owned repos and 834 local-only repos left 2,314 candidates, of which 950 were classified as research finds. Verdicts among those: 118 adopted, 23 rejected, 429 reference, 217 considered and 163 unknown.

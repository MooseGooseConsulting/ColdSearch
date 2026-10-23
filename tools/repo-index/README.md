# repo-index

A Postgres index of GitHub repos that came up in past Claude Code and Codex sessions. Research can exclude them from new searches ("already evaluated") and still query what we concluded about each one. It serves G3 in `docs/NORTH_STAR.md` (search and reuse prior work). ColdSearch search does not read it yet.

**Database:** Neon project `coldsearch` (`lively-wildflower-09919715`, personal org), database `repo_index`. The scripts read `REPO_INDEX_DATABASE_URL`.

## Tables

- `repos`: one row per canonical repo (GitHub `nameWithOwner`, so renames merge). Holds GitHub metadata, `is_research_find`, `verdict` (`adopted | rejected | reference | considered | unknown`), `summary`, `our_take`, `topics`, session counts and dates. `search_tsv` is a weighted full-text index over name, description, summary and take.
- `repo_mentions`: transcript snippets for each repo, with source, session, timestamp, cwd, kind and tool. Mentions from local file reads are not stored.
- `search_exclusions` (view): research finds marked `exclude_from_search`. This is the list a search step filters against.

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
3. `candidates.py OUT_DIR [BATCH_SIZE]` merges aliases and drops Coldaine/MooseGooseConsulting repos (forks map to their upstream). It also drops repos that only appeared in local or tool-call output. Writes `candidates.json` and `batches/batch-NNN.json`.
4. Classify: a small model (we used Haiku subagents, 4–5 batches each) follows `CLASSIFIER.md` and writes `out/batch-NNN.json`. It sets `is_research_find`, `verdict`, `summary`, `our_take` and `topics`, and uses `unknown` unless a snippet supports a verdict.
5. `load.py OUT_DIR` builds CSVs and upserts them with `psql \copy` (`load.sql`). Rows key on `full_name`. A re-run without new classifications keeps earlier verdicts. Apply `schema.sql` once first.

Re-running on newer transcripts is incremental for the GitHub metadata. Only the new batches need classifying.

## First run (2026-10-22)

1,274 transcript files produced 89,370 raw mentions, which deduplicated to 53,872 across 3,366 repos. Dropping 167 owned repos and 834 local-only repos left 2,314 candidates, of which 950 were classified as research finds. Verdicts among those: 118 adopted, 23 rejected, 429 reference, 217 considered and 163 unknown.

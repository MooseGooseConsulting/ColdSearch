\set ON_ERROR_STOP 1
begin;
create temp table s_repos (like repos including defaults) on commit drop;
alter table s_repos drop column search_tsv, drop column updated_at, drop column exclude_from_search;
\copy s_repos (full_name, aliases, url, exists_on_gh, description, stars, language, gh_topics, archived, pushed_at, we_forked_it, is_research_find, verdict, summary, our_take, topics, sessions, mentions, first_seen, last_seen, projects, classified_by) from '{DIR}/repos.csv' with (format csv, null '')

insert into repos (full_name, aliases, url, exists_on_gh, description, stars, language, gh_topics, archived, pushed_at,
                   we_forked_it, is_research_find, verdict, summary, our_take, topics, sessions, mentions,
                   first_seen, last_seen, projects, classified_by)
select full_name, aliases, url, exists_on_gh, description, stars, language, gh_topics, archived, pushed_at,
       we_forked_it, is_research_find, verdict, summary, our_take, topics, sessions, mentions,
       first_seen, last_seen, projects, classified_by
from s_repos
on conflict (full_name) do update set
    aliases = excluded.aliases, url = excluded.url, exists_on_gh = excluded.exists_on_gh,
    description = excluded.description, stars = excluded.stars, language = excluded.language,
    gh_topics = excluded.gh_topics, archived = excluded.archived, pushed_at = excluded.pushed_at,
    we_forked_it = excluded.we_forked_it,
    -- keep earlier classification when this run has none
    -- a row classified in this run replaces the old classification (including clearing our_take);
    -- an unclassified row keeps whatever an earlier run decided
    is_research_find = case when excluded.classified_by is not null then excluded.is_research_find else repos.is_research_find end,
    verdict = case when excluded.classified_by is not null then excluded.verdict else repos.verdict end,
    summary = case when excluded.classified_by is not null then excluded.summary else repos.summary end,
    our_take = case when excluded.classified_by is not null then excluded.our_take else repos.our_take end,
    topics = case when excluded.classified_by is not null then excluded.topics else repos.topics end,
    classified_by = coalesce(excluded.classified_by, repos.classified_by),
    sessions = excluded.sessions, mentions = excluded.mentions, first_seen = excluded.first_seen,
    last_seen = excluded.last_seen, projects = excluded.projects, updated_at = now();

create temp table s_mentions (full_name text, source text, session text, ts timestamptz, cwd text, kind text,
                              tool text, snippet text) on commit drop;
\copy s_mentions from '{DIR}/mentions.csv' with (format csv, null '')
-- a (repo, session) pair re-extracted this run is replaced wholesale, so snippets from older
-- extraction/redaction rules don't linger; sessions whose transcripts are gone keep their rows
delete from repo_mentions m using (select distinct full_name, session from s_mentions) s
 where m.full_name = s.full_name and m.session is not distinct from s.session
   and not exists (select 1 from s_mentions x where x.full_name = m.full_name
                   and x.session is not distinct from m.session and x.snippet = m.snippet);
insert into repo_mentions (full_name, source, session, ts, cwd, kind, tool, snippet)
select full_name, source, session, ts, cwd, kind, tool, snippet from s_mentions
on conflict (full_name, session, snippet) do nothing;
commit;
select count(*) repos, count(verdict) classified, (select count(*) from repo_mentions) mentions from repos;

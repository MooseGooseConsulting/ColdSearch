-- repo_index: GitHub repos we've already evaluated in past sessions.
-- Research agents exclude these from new searches but can query what we concluded.

create table if not exists repos (
    full_name      text primary key,              -- canonical GitHub nameWithOwner
    aliases        text[] not null default '{}',  -- old names / redirects seen in transcripts
    url            text,
    exists_on_gh   boolean not null default true,
    description    text,
    stars          integer,
    language       text,
    gh_topics      text[] not null default '{}',
    archived       boolean,
    pushed_at      timestamptz,
    we_forked_it   boolean not null default false,
    is_research_find boolean,
    verdict        text check (verdict in ('adopted','rejected','reference','considered','unknown')),
    summary        text,
    our_take       text,
    topics         text[] not null default '{}',
    exclude_from_search boolean not null default true,
    sessions       integer not null default 0,
    mentions       integer not null default 0,
    first_seen     timestamptz,
    last_seen      timestamptz,
    projects       text[] not null default '{}',
    classified_by  text,
    updated_at     timestamptz not null default now(),
    search_tsv     tsvector generated always as (
        setweight(to_tsvector('english', replace(coalesce(full_name, ''), '/', ' ')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(our_take, '')), 'C')
    ) stored
);
create index if not exists repos_search_tsv on repos using gin (search_tsv);
create index if not exists repos_topics on repos using gin (topics);
create index if not exists repos_lower_name on repos (lower(full_name));

create table if not exists repo_mentions (
    id        bigserial primary key,
    full_name text not null references repos (full_name) on delete cascade,
    source    text not null,       -- claude | codex
    session   text,
    ts        timestamptz,
    cwd       text,
    kind      text not null,       -- prose_assistant | prose_user | search | call | local
    tool      text,
    snippet   text,
    unique nulls not distinct (full_name, session, snippet)
);
create index if not exists repo_mentions_repo on repo_mentions (full_name);
-- migrate databases created before the constraint became nulls-not-distinct:
-- drop NULL-session duplicates the old constraint allowed, then swap it, atomically
do $$
begin
    if exists (select 1 from pg_constraint c join pg_index i on i.indexrelid = c.conindid
               where c.conname = 'repo_mentions_full_name_session_snippet_key' and not i.indnullsnotdistinct) then
        delete from repo_mentions a using repo_mentions b
         where a.id > b.id and a.full_name = b.full_name and a.session is null and b.session is null
           and a.snippet is not distinct from b.snippet;
        alter table repo_mentions drop constraint repo_mentions_full_name_session_snippet_key;
        alter table repo_mentions add constraint repo_mentions_full_name_session_snippet_key
            unique nulls not distinct (full_name, session, snippet);
    end if;
end $$;

-- what research agents read before searching: research finds, plus anything we adopted
create or replace view search_exclusions as
    select full_name, aliases, verdict, summary, our_take
    from repos where exclude_from_search and (is_research_find is true or verdict = 'adopted');

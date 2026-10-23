#!/usr/bin/env python3
"""Build CSVs from candidates + Haiku outputs + mentions, then upsert into Neon via psql.

Usage: python3 -I load.py OUT_DIR
Reads OUT_DIR/candidates.json, OUT_DIR/out/*.json (merged: triage owns verdicts, summaries own
summary/category/topics), OUT_DIR/mentions.jsonl.
Needs REPO_INDEX_DATABASE_URL. Re-runnable: rows upsert on full_name; mentions dedupe on (full_name, session, snippet).
"""
import csv
import glob
import json
import os
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # python3 -I leaves the script dir off sys.path
from candidates import complete, merged_classifications  # noqa: E402
VERDICTS = {"adopted", "rejected", "reference", "considered", "unknown"}


def pgarr(xs):
    return "{" + ",".join('"' + str(x).replace("\\", "\\\\").replace('"', '\\"') + '"' for x in xs) + "}"


def main():
    out = sys.argv[1]
    url = os.environ.get("REPO_INDEX_DATABASE_URL")
    if not url:
        sys.exit("REPO_INDEX_DATABASE_URL is not set (run under doppler run, or export it)")
    cands = json.load(open(os.path.join(out, "candidates.json")))
    # partial rows never overwrite a stored classification
    cls = {k: r for k, r in merged_classifications(out).items() if complete(r)}
    alias_to_name = {}
    rows = []
    for c in cands:
        g = c["gh"] or {}
        k = cls.get(c["repo"].lower(), {})
        verdict = k.get("verdict") if k.get("verdict") in VERDICTS else None
        for a in [c["repo"], *c["aliases"]]:
            alias_to_name[a.lower()] = c["repo"]
        rows.append([
            c["repo"], pgarr(c["aliases"]), g.get("url") or f"https://github.com/{c['repo']}",
            "t" if c["gh"] else "f", g.get("description") or "", g.get("stargazerCount") if c["gh"] else "",
            (g.get("primaryLanguage") or {}).get("name") or "",
            pgarr(t["topic"]["name"] for t in (g.get("repositoryTopics") or {}).get("nodes", [])),
            ("t" if g.get("isArchived") else "f") if c["gh"] else "", g.get("pushedAt") or "",
            "t" if c["forked_by_us"] else "f",
            ("t" if k["is_research_find"] else "f") if isinstance(k.get("is_research_find"), bool) else "",
            verdict or "", k.get("summary") or "", k.get("our_take") or "", pgarr(k.get("topics") or []),
            c["session_n"], c["mentions"], c["first_seen"] or "", c["last_seen"] or "", pgarr(c["cwds"]),
            ("haiku-readme" if k.get("readme_hash") else "haiku-snippets") if k else "",
            k.get("category") or "",
        ])
    with open(os.path.join(out, "repos.csv"), "w", newline="") as f:
        csv.writer(f).writerows(rows)
    seen = set()
    with open(os.path.join(out, "mentions.jsonl")) as mf, open(os.path.join(out, "mentions.csv"), "w", newline="") as f:
        w = csv.writer(f)
        for line in mf:
            m = json.loads(line)
            name = alias_to_name.get(m["repo"].lower())
            if not name or m["kind"] == "local":
                continue
            key = (name, m["session"], m["snippet"])
            if key in seen:
                continue
            seen.add(key)
            w.writerow([name, m["source"], m["session"] or "", m["ts"] or "", m["cwd"] or "", m["kind"],
                        m["tool"] or "", m["snippet"]])
    print(json.dumps({"repos": len(rows), "classified": sum(1 for r in rows if r[-1]), "mentions": len(seen)}))
    sql = open(os.path.join(HERE, "load.sql")).read().replace("{DIR}", os.path.abspath(out))
    subprocess.run(["psql", "-q", "-f", "-"], input=sql, text=True, check=True, env={**os.environ, **pg_env(url)})


def pg_env(url):
    """libpq env vars for a postgres:// URL, so the password never appears in psql's argv."""
    u = urlparse(url)
    env = {"PGHOST": u.hostname or "", "PGPORT": str(u.port or 5432), "PGUSER": unquote(u.username or ""),
           "PGPASSWORD": unquote(u.password or ""), "PGDATABASE": u.path.lstrip("/")}
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    for key, var in (("sslmode", "PGSSLMODE"), ("channel_binding", "PGCHANNELBINDING")):
        if key in q:
            env[var] = q[key]
    return env


if __name__ == "__main__":
    main()

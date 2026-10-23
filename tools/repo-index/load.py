#!/usr/bin/env python3
"""Build CSVs from candidates + Haiku outputs + mentions, then upsert into Neon via psql.

Usage: python3 -I load.py OUT_DIR
Reads OUT_DIR/candidates.json, OUT_DIR/out/batch-*.json, OUT_DIR/mentions.jsonl.
Needs REPO_INDEX_DATABASE_URL. Re-runnable: rows upsert on full_name; mentions dedupe on (full_name, session, snippet).
"""
import csv
import glob
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERDICTS = {"adopted", "rejected", "reference", "considered", "unknown"}


def pgarr(xs):
    return "{" + ",".join('"' + str(x).replace("\\", "\\\\").replace('"', '\\"') + '"' for x in xs) + "}"


def main():
    out = sys.argv[1]
    cands = json.load(open(os.path.join(out, "candidates.json")))
    cls = {}
    for f in sorted(glob.glob(os.path.join(out, "out", "batch-*.json"))):
        try:
            for row in json.load(open(f)):
                cls[row["repo"].lower()] = row
        except (ValueError, KeyError, TypeError) as e:
            print(f"skip {f}: {e}", file=sys.stderr)
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
            "claude-haiku" if k else "",
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
    url = os.environ.get("REPO_INDEX_DATABASE_URL")
    if not url:
        sys.exit("REPO_INDEX_DATABASE_URL is not set (run under doppler run, or export it)")
    sql = open(os.path.join(HERE, "load.sql")).read().replace("{DIR}", os.path.abspath(out))
    subprocess.run(["psql", url, "-q", "-f", "-"], input=sql, text=True, check=True)


if __name__ == "__main__":
    main()

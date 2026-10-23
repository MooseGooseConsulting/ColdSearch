#!/usr/bin/env python3
"""Resolve repos.json entries against GitHub GraphQL (renames, forks, deleted).

Usage: python3 -I ghmeta.py OUT_DIR   -> writes OUT_DIR/ghmeta.json keyed by lowercase mention name
"""
import json
import os
import subprocess
import sys

FIELDS = """nameWithOwner description stargazerCount pushedAt isArchived isFork url homepageUrl
primaryLanguage { name } repositoryTopics(first: 10) { nodes { topic { name } } }
parent { nameWithOwner }"""
OWN = {"coldaine", "moosegooseconsulting"}


def query(batch):
    parts = []
    for i, r in enumerate(batch):
        o, n = r.split("/", 1)
        parts.append(f'r{i}: repository(owner: {json.dumps(o)}, name: {json.dumps(n)}) {{ {FIELDS} }}')
    q = "query {" + "\n".join(parts) + "}"
    p = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True,
                       env={**os.environ, "MISE_QUIET": "1"})
    try:
        body = json.loads(p.stdout or "{}")
    except ValueError:
        body = {}
    data = body.get("data")
    if not data:
        # auth, rate limit or network failure: cache nothing so the next run retries
        sys.exit(f"GraphQL batch failed (exit {p.returncode}): {(p.stderr or p.stdout)[:500]}")
    # NOT_FOUND is a real answer (deleted/renamed away); any other per-repo error is retried next run
    retry = {e["path"][0] for e in body.get("errors", []) if e.get("type") != "NOT_FOUND" and e.get("path")}
    return {batch[i].lower(): data.get(f"r{i}") for i in range(len(batch)) if f"r{i}" not in retry}


def main():
    out = sys.argv[1]
    repos = [r["repo"] for r in json.load(open(os.path.join(out, "repos.json")))]
    path = os.path.join(out, "ghmeta.json")
    meta = json.load(open(path)) if os.path.exists(path) else {}
    todo = [r for r in repos if r.lower() not in meta]
    for i in range(0, len(todo), 80):
        meta.update(query(todo[i:i + 80]))
        json.dump(meta, open(path, "w"))
        print(f"{min(i + 80, len(todo))}/{len(todo)}", file=sys.stderr)
    # upstreams of our forks, so candidates.py can attach their metadata
    parents = {v["parent"]["nameWithOwner"] for v in meta.values()
               if v and v.get("parent") and v["nameWithOwner"].split("/")[0].lower() in OWN}
    todo = [p for p in parents if p.lower() not in meta]
    for i in range(0, len(todo), 80):
        meta.update(query(todo[i:i + 80]))
        json.dump(meta, open(path, "w"))
    missing = [r for r in [*repos, *parents] if r.lower() not in meta]
    print(json.dumps({"total": len(meta), "resolved": sum(1 for v in meta.values() if v), "retry": len(missing)}))
    if missing:
        sys.exit(f"{len(missing)} repos hit retryable GraphQL errors; re-run before candidates.py")


if __name__ == "__main__":
    main()

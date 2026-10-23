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


def query(batch):
    parts = []
    for i, r in enumerate(batch):
        o, n = r.split("/", 1)
        parts.append(f'r{i}: repository(owner: {json.dumps(o)}, name: {json.dumps(n)}) {{ {FIELDS} }}')
    q = "query {" + "\n".join(parts) + "}"
    p = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True,
                       env={**os.environ, "MISE_QUIET": "1"})
    data = json.loads(p.stdout or "{}").get("data") or {}
    return {batch[i].lower(): data.get(f"r{i}") for i in range(len(batch))}


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
    print(json.dumps({"total": len(meta), "resolved": sum(1 for v in meta.values() if v)}))


if __name__ == "__main__":
    main()

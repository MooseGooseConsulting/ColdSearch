#!/usr/bin/env python3
"""Fetch each repo's README and top-level file listing, and build summarize batches from them.

Usage: python3 -I enrich.py OUT_DIR [BATCH_SIZE] [--all]
Reads OUT_DIR/candidates.json and OUT_DIR/out/*.json. Caches repo content in OUT_DIR/repo_content.json
and writes OUT_DIR/batches/summary-<run>-NNN.json. Without --all, only research finds and adopted
repos are summarized; incidental repos (lockfile hits, unengaged search results) keep their GitHub
description. A summary is redone only when the README changed since it was last summarized.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python3 -I leaves the script dir off sys.path
from candidates import merged_classifications  # noqa: E402

README_NAMES = ["README.md", "readme.md", "Readme.md", "README.rst", "README.txt", "README", "README.markdown"]
README_CHARS = 3500


def fetch(batch):
    parts = []
    for i, r in enumerate(batch):
        o, n = r.split("/", 1)
        blobs = " ".join(f'f{j}: object(expression: {json.dumps("HEAD:" + f)}) {{ ... on Blob {{ text }} }}'
                         for j, f in enumerate(README_NAMES))
        parts.append(f'r{i}: repository(owner: {json.dumps(o)}, name: {json.dumps(n)}) {{ {blobs} '
                     f'root: object(expression: "HEAD:") {{ ... on Tree {{ entries {{ name type }} }} }} }}')
    p = subprocess.run(["gh", "api", "graphql", "-f", "query=query {" + "\n".join(parts) + "}"],
                       capture_output=True, text=True, env={**os.environ, "MISE_QUIET": "1"})
    try:
        body = json.loads(p.stdout or "{}")
    except ValueError:
        body = {}
    data = body.get("data")
    if not data:
        sys.exit(f"GraphQL batch failed (exit {p.returncode}): {(p.stderr or p.stdout)[:500]}")
    retry = {e["path"][0] for e in body.get("errors", []) if e.get("type") != "NOT_FOUND" and e.get("path")}
    out = {}
    for i, r in enumerate(batch):
        if f"r{i}" in retry:
            continue
        d = data.get(f"r{i}")
        if not d:
            out[r.lower()] = None
            continue
        text = next((d[f"f{j}"]["text"] for j in range(len(README_NAMES)) if (d.get(f"f{j}") or {}).get("text")), "")
        entries = ((d.get("root") or {}).get("entries")) or []
        out[r.lower()] = {"readme": clean(text),
                          "files": [e["name"] + ("/" if e["type"] == "tree" else "") for e in entries][:60]}
    return out


def clean(md):
    md = re.sub(r"<!--.*?-->", "", md, flags=re.S)
    md = re.sub(r"\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)", "", md)  # linked badges
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)  # images
    md = re.sub(r"<img[^>]*>|</?(p|div|a|picture|source|br|h\d)[^>]*>", "", md, flags=re.I)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()[:README_CHARS]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out, size = args[0], int(args[1]) if len(args) > 1 else 25
    cands = json.load(open(os.path.join(out, "candidates.json")))
    cls = merged_classifications(out)
    if "--all" not in sys.argv:
        cands = [c for c in cands if cls.get(c["repo"].lower(), {}).get("is_research_find") is True
                 or cls.get(c["repo"].lower(), {}).get("verdict") == "adopted"]
    cache_path = os.path.join(out, "repo_content.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    todo = [c["repo"] for c in cands if c["gh"] and c["repo"].lower() not in cache]
    for i in range(0, len(todo), 20):
        cache.update(fetch(todo[i:i + 20]))
        json.dump(cache, open(cache_path, "w"))
        print(f"fetched {min(i + 20, len(todo))}/{len(todo)}", file=sys.stderr)
    batch_rows = []
    for c in cands:
        key = c["repo"].lower()
        content = cache.get(key) or {}
        rhash = hashlib.sha1(content.get("readme", "").encode()).hexdigest()[:12]
        if cls.get(key, {}).get("readme_hash") == rhash and cls[key].get("category"):
            continue  # already summarized from this README
        g = c["gh"] or {}
        batch_rows.append({
            "repo": c["repo"],
            "readme_hash": rhash,
            "github": None if not c["gh"] else {
                "description": g.get("description"), "stars": g.get("stargazerCount"),
                "archived": g.get("isArchived"), "language": (g.get("primaryLanguage") or {}).get("name"),
                "topics": [t["topic"]["name"] for t in (g.get("repositoryTopics") or {}).get("nodes", [])],
                "pushed_at": (g.get("pushedAt") or "")[:10],
            },
            "readme": content.get("readme", ""),
            "top_level_files": content.get("files", []),
            "our_snippets": [{"kind": s["kind"], "date": (s.get("ts") or "")[:10], "text": s["snippet"][:300]}
                             for s in c["snippets"]],
        })
    run = time.strftime("%Y%m%d%H%M")
    bdir = os.path.join(out, "batches")
    os.makedirs(bdir, exist_ok=True)
    os.makedirs(os.path.join(out, "out"), exist_ok=True)
    for i in range(0, len(batch_rows), size):
        json.dump(batch_rows[i:i + size], open(os.path.join(bdir, f"summary-{run}-{i // size:03d}.json"), "w"), indent=0)
    print(json.dumps({"in_scope": len(cands), "fetched_now": len(todo), "to_summarize": len(batch_rows),
                      "no_readme": sum(1 for c in cands if not (cache.get(c["repo"].lower()) or {}).get("readme")),
                      "batches": (len(batch_rows) + size - 1) // size}))


if __name__ == "__main__":
    main()

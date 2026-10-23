#!/usr/bin/env python3
"""Merge repos.json + ghmeta.json into research candidates and Haiku batch files.

Usage: python3 -I candidates.py OUT_DIR [BATCH_SIZE]
Writes OUT_DIR/candidates.json and OUT_DIR/batches/batch-<run>-NNN.json for repos that
no OUT_DIR/out/batch-*.json has classified yet, so re-runs only classify new repos.
"""
import glob
import json
import os
import sys
import time
from collections import defaultdict

OWN = {"coldaine", "moosegooseconsulting"}
RESEARCH_KINDS = ("search", "prose_assistant", "prose_user")


def main():
    out = sys.argv[1]
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 55
    repos = json.load(open(os.path.join(out, "repos.json")))
    meta = json.load(open(os.path.join(out, "ghmeta.json")))
    merged = {}
    stats = defaultdict(int)
    for r in repos:
        m = meta.get(r["repo"].lower())
        name = m["nameWithOwner"] if m else r["repo"]
        if name.split("/")[0].lower() in OWN:
            parent = (m or {}).get("parent") or {}
            pname = parent.get("nameWithOwner")
            if not pname or pname.split("/")[0].lower() in OWN:
                stats["owned_dropped"] += 1
                continue
            stats["owned_fork_to_parent"] += 1
            name, m = pname, meta.get(pname.lower())  # parent metadata may be absent; keep name
        key = name.lower()
        c = merged.setdefault(key, {"repo": name, "gh": m, "aliases": set(), "mentions": 0, "session_n": 0,
                                    "kinds": defaultdict(int), "first_seen": None, "last_seen": None,
                                    "cwds": set(), "snippets": [], "forked_by_us": False})
        if m and not c["gh"]:
            c["gh"] = m
        if r["repo"] != name:
            c["aliases"].add(r["repo"])
        if r["owned"]:
            c["forked_by_us"] = True
        c["mentions"] += r["mentions"]
        c["session_n"] += r["sessions"]
        for k, v in r["kinds"].items():
            c["kinds"][k] += v
        for f, op in (("first_seen", min), ("last_seen", max)):
            if r[f]:
                c[f] = op(c[f], r[f]) if c[f] else r[f]
        c["cwds"].update(r["cwds"])
        c["snippets"] += r["snippets"]
    cands = []
    for c in merged.values():
        if not any(c["kinds"].get(k) for k in RESEARCH_KINDS) and not c["forked_by_us"]:
            stats["local_only_dropped"] += 1
            continue
        c["aliases"] = sorted(c["aliases"])
        c["cwds"] = sorted(c["cwds"])[:4]
        c["kinds"] = dict(c["kinds"])
        c["snippets"] = c["snippets"][:3]
        cands.append(c)
    cands.sort(key=lambda c: -c["session_n"])
    json.dump(cands, open(os.path.join(out, "candidates.json"), "w"))
    done = set()
    for f in glob.glob(os.path.join(out, "out", "batch-*.json")):
        done.update(r["repo"].lower() for r in json.load(open(f)))
    todo = [c for c in cands if c["repo"].lower() not in done]
    run = time.strftime("%Y%m%d%H%M")
    bdir = os.path.join(out, "batches")
    os.makedirs(bdir, exist_ok=True)
    for i in range(0, len(todo), size):
        batch = []
        for c in todo[i:i + size]:
            g = c["gh"] or {}
            batch.append({
                "repo": c["repo"],
                "github": None if not c["gh"] else {
                    "description": g.get("description"), "stars": g.get("stargazerCount"),
                    "archived": g.get("isArchived"), "language": (g.get("primaryLanguage") or {}).get("name"),
                    "topics": [t["topic"]["name"] for t in (g.get("repositoryTopics") or {}).get("nodes", [])],
                },
                "we_forked_it": c["forked_by_us"],
                "sessions": c["session_n"], "first_seen": (c["first_seen"] or "")[:10],
                "last_seen": (c["last_seen"] or "")[:10], "projects": c["cwds"],
                "snippets": [{"kind": s["kind"], "date": (s.get("ts") or "")[:10], "text": s["snippet"][:400]}
                             for s in c["snippets"]],
            })
        json.dump(batch, open(os.path.join(bdir, f"batch-{run}-{i // size:03d}.json"), "w"), indent=0)
    stats.update(candidates=len(cands), already_classified=len(cands) - len(todo),
                 batches=(len(todo) + size - 1) // size,
                 unresolved=sum(1 for c in cands if not c["gh"]))
    print(json.dumps(stats))


if __name__ == "__main__":
    main()

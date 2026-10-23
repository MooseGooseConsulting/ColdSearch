#!/usr/bin/env python3
"""Merge repos.json + ghmeta.json into research candidates and Haiku batch files.

Usage: python3 -I candidates.py OUT_DIR [BATCH_SIZE]
Writes OUT_DIR/candidates.json and OUT_DIR/batches/batch-<run>-NNN.json for repos that
no OUT_DIR/out/batch-*.json has classified yet, or whose evidence changed since they were
batched (OUT_DIR/fingerprints.json), so re-runs only classify new or changed repos.
"""
import glob
import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict

OWN = {"coldaine", "moosegooseconsulting"}
RESEARCH_KINDS = ("search", "prose_assistant", "prose_user")
VERDICTS = {"adopted", "rejected", "reference", "considered", "unknown"}


def fingerprint(c):
    """Hash of the classifier's evidence; when it changes, the repo is re-batched."""
    ev = json.dumps([sorted(c["kinds"]), [s["snippet"] for s in c["snippets"]]], sort_keys=True)
    return hashlib.sha1(ev.encode()).hexdigest()


SUMMARY_FIELDS = ("summary", "category", "topics", "readme_hash")
CATEGORIES = {"llm-inference", "llm-gateway", "ai-agents", "agent-tooling", "llm-evals-observability", "ml-models-data",
              "kubernetes", "infrastructure", "ci-cd", "observability", "databases-storage", "networking-security",
              "developer-tools", "search-scraping", "frontend-ui", "hardware-embedded", "docs-reference", "other"}


def run_order(path):
    """Sort out/ files by the run timestamp in their name (batch-NNN from the first run sorts first)."""
    m = re.search(r"-(\d{12})-", os.path.basename(path))
    return (m.group(1) if m else "0", os.path.basename(path))


def merged_classifications(out):
    """Per-repo rows from out/: triage (batch-*) owns is_research_find/verdict, the README-based
    summarize pass (summary-*) owns summary/category/topics, and a non-empty our_take from either wins."""
    rows = {}
    for f in sorted(glob.glob(os.path.join(out, "out", "*.json")), key=run_order):  # oldest run first
        try:
            data = json.load(open(f))
        except (OSError, ValueError) as e:
            print(f"skip {f}: {e}", file=sys.stderr)
            continue
        is_summary = os.path.basename(f).startswith("summary-")
        for r in data if isinstance(data, list) else []:
            if not (isinstance(r, dict) and isinstance(r.get("repo"), str)):
                continue
            cur = rows.setdefault(r["repo"].lower(), {})
            if is_summary:
                cur.update({k: r[k] for k in SUMMARY_FIELDS if k in r})
                if cur.get("category") not in CATEGORIES:  # off-list value: treat as not summarized
                    cur["category"] = None
                cur.setdefault("repo", r["repo"])
                for k in ("is_research_find", "verdict"):  # only fills gaps when no triage row exists
                    cur.setdefault(k, r.get(k))
            else:
                cur.update({k: v for k, v in r.items() if k not in SUMMARY_FIELDS or "category" not in cur})
            if r.get("our_take"):
                cur["our_take"] = r["our_take"]
            cur.setdefault("our_take", "")
    return rows


def complete(r):
    return (isinstance(r, dict) and isinstance(r.get("repo"), str) and isinstance(r.get("is_research_find"), bool)
            and isinstance(r.get("verdict"), str) and r["verdict"] in VERDICTS and isinstance(r.get("summary"), str)
            and isinstance(r.get("our_take"), str) and isinstance(r.get("topics"), list))


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
        c = merged.setdefault(key, {"repo": name, "gh": m, "aliases": set(), "mentions": 0, "session_n": 0, "session_ids": set(),
                                    "kinds": defaultdict(int), "first_seen": None, "last_seen": None,
                                    "cwds": set(), "snippets": [], "forked_by_us": False})
        if m and not c["gh"]:
            c["gh"] = m
        if r["repo"] != name:
            c["aliases"].add(r["repo"])
        if r["owned"]:
            c["forked_by_us"] = True
        c["mentions"] += r["mentions"]
        c["session_ids"].update(r.get("session_ids", []))
        c["session_n"] = max(len(c["session_ids"]), c["session_n"], r["sessions"])  # distinct across aliases
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
        del c["session_ids"]
        c["cwds"] = sorted(c["cwds"])[:4]
        c["kinds"] = dict(c["kinds"])
        c["snippets"] = c["snippets"][:3]
        cands.append(c)
    cands.sort(key=lambda c: -c["session_n"])
    json.dump(cands, open(os.path.join(out, "candidates.json"), "w"))
    # only fully triaged rows count as done; anything partial gets re-batched
    done = {k for k, r in merged_classifications(out).items() if complete(r)}
    fp_path = os.path.join(out, "fingerprints.json")
    fps = json.load(open(fp_path)) if os.path.exists(fp_path) else {}
    todo = []
    for c in cands:
        key, fp = c["repo"].lower(), fingerprint(c)
        if key in done and fps.setdefault(key, fp) == fp:  # first sighting of a classified repo sets the baseline
            continue
        todo.append(c)
        fps[key] = fp
    run = time.strftime("%Y%m%d%H%M")
    bdir = os.path.join(out, "batches")
    os.makedirs(bdir, exist_ok=True)
    os.makedirs(os.path.join(out, "out"), exist_ok=True)
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
    json.dump(fps, open(fp_path, "w"))
    stats.update(candidates=len(cands), already_classified=len(cands) - len(todo),
                 batches=(len(todo) + size - 1) // size,
                 unresolved=sum(1 for c in cands if not c["gh"]))
    print(json.dumps(stats))


if __name__ == "__main__":
    main()

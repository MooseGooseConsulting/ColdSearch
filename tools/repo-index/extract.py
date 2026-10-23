#!/usr/bin/env python3
"""Extract GitHub repo mentions from Claude Code and Codex transcripts.

Usage: python3 -I extract.py OUT_DIR
Writes OUT_DIR/mentions.jsonl (one deduped mention per line) and OUT_DIR/repos.json
(per-repo aggregate with ranked snippets). Each mention is tagged by where it
appeared: prose (assistant/user text), search (web/GitHub research tools), or
local (file reads, ordinary shell output) so research finds can be told apart
from lockfile noise without asking a model.
"""
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from multiprocessing import Pool

HOME = os.path.expanduser("~")
ROOTS = [("claude", f"{HOME}/.claude/projects"), ("codex", f"{HOME}/.codex/sessions")]
OWN_OWNERS = {"coldaine", "moosegooseconsulting"}

SEG = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})"
NAME = r"[A-Za-z0-9_.-]{1,100}"
URL_RE = re.compile(
    rf"(?<![A-Za-z0-9_.-])(?:https?://)?(?:www\.)?(?:github\.com|api\.github\.com/repos|raw\.githubusercontent\.com|codeload\.github\.com)/({SEG})/({NAME})"
)
# bare owner/repo where gh names it explicitly
GH_ARG_RE = re.compile(rf"(?:gh\s+repo\s+(?:view|clone|fork)\s+|--repo[ =]|-R\s+|gh\s+api\s+/?repos/)({SEG})/({NAME})")
GH_SEARCH_LINE_RE = re.compile(rf"^({SEG})/({NAME})\s", re.M)
# gh/GitHub API JSON output: "fullName" / "nameWithOwner" / "full_name": "owner/repo"
GH_JSON_RE = re.compile(rf"\"(?:fullName|nameWithOwner|full_name)\"\s*:\s*\"({SEG})/({NAME})\"")

NON_OWNERS = {
    "settings", "orgs", "apps", "topics", "marketplace", "sponsors", "user-attachments", "features",
    "login", "logout", "join", "about", "pricing", "search", "explore", "notifications", "issues",
    "pulls", "new", "collections", "trending", "enterprise", "security", "site", "contact", "customer-stories",
    "readme", "team", "codespaces", "copilot", "github-copilot", "account", "dashboard", "events",
    "repos", "users", "repositories", "advisories", "solutions", "resources", "home", "stars", "watching",
}
NON_NAMES = {"", ".", "..", "repos", "settings", "followers", "following"}
PLACEHOLDER_OWNERS = {"owner", "user", "org", "your-org", "your-username", "username", "you", "example", "foo", "myorg", "<owner>", "yourname", "your_username", "organization"}

SEARCH_TOOL_RE = re.compile(
    r"websearch|webfetch|web_search|web_fetch|exa|brightdata|bright_data|context7|query-docs|firecrawl|tavily|perplexity|"
    r"github\.(search|fetch)|deepwiki|get_page_text|navigate|browser|agent_run",
    re.I,
)
SEARCH_CMD_RE = re.compile(
    r"\bgh\s+(search|repo\s+view|api\s+/?(repos|search|graphql))|api\.github\.com|curl[^\n|]*github|git\s+(clone|ls-remote)|"
    r"raw\.githubusercontent|wget[^\n|]*github",
    re.I,
)


def norm(owner, name):
    name = re.sub(r"\.git$", "", name.rstrip(".,;:)]}>'\"`*_"))
    if owner.lower() in NON_OWNERS or owner.lower() in PLACEHOLDER_OWNERS or name.lower() in NON_NAMES or name.startswith("."):
        return None
    return f"{owner}/{name}"


def find_repos(text, gh_search_output=False):
    out = []
    for rx in (URL_RE, GH_ARG_RE, GH_JSON_RE):
        for m in rx.finditer(text):
            r = norm(m.group(1), m.group(2))
            if r:
                out.append((r, m.start()))
    if gh_search_output:
        for m in GH_SEARCH_LINE_RE.finditer(text):
            r = norm(m.group(1), m.group(2))
            if r:
                out.append((r, m.start()))
    return out


# credentials that show up in transcript tool output; snippets end up in a shared database
SECRET_RE = re.compile(
    r"(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|npg_[A-Za-z0-9]{8,}|"
    r"AKIA[0-9A-Z]{12,}|dp\.(st|pt|ct|sa)\.[A-Za-z0-9._-]{10,}|xox[abpr]-[A-Za-z0-9-]{10,}|"
    r"(?<=Bearer )[A-Za-z0-9._~+/-]{20,}|(?<=://)[^/\s:@]+:[^/\s@]+(?=@))"
)
# NAME_KEY=value / "api_key": "value" style assignments, whatever the token format
SECRET_ASSIGN_RE = re.compile(
    r"(?i)\b([A-Z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH_CONFIG|AUTHORIZATION)"
    r"[A-Z0-9_.-]*[\"']?\s*[=:]\s*)(\"[^\"\n]{8,}\"|'[^'\n]{8,}'|[^\s\"',;}{)]{8,})"
)


def redact(s):
    s = SECRET_RE.sub("[REDACTED]", s)
    return SECRET_ASSIGN_RE.sub(lambda m: m.group(1) + "[REDACTED]", s)


def snippet(text, pos, width=220, margin=300):
    # redact a wider window first so an assignment name just outside the slice still masks its value
    start = max(0, pos - width - margin)
    window = redact(text[start: pos + width + margin])
    rel = len(redact(text[start:pos]))  # where pos lands after redaction shrank the prefix
    s = window[max(0, rel - width): rel + width]
    return re.sub(r"\s+", " ", s).strip()


def to_text(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n".join(to_text(x) for x in v)
    if isinstance(v, dict):
        if "text" in v and isinstance(v["text"], str):
            return v["text"]
        if "content" in v:
            return to_text(v["content"])
        return json.dumps(v)[:20000]
    return str(v)


def classify(tool, tool_input):
    if tool is None:
        return None
    if SEARCH_TOOL_RE.search(tool):
        return "search"
    if SEARCH_CMD_RE.search(tool_input or ""):
        return "search"
    return "local"


def emit(acc, repo_hits, text, kind, tool, meta, gh_search=False):
    for repo, pos in repo_hits:
        acc.append({**meta, "repo": repo, "kind": kind, "tool": tool, "snippet": snippet(text, pos)})


def scan_claude(path):
    acc, tools = [], {}
    meta_base = {"source": "claude", "file": path}
    session = None
    try:
        fh = open(path, errors="replace")
    except OSError:
        return acc
    with fh:
        for line in fh:
            if "github" not in line and "tool_use" not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            msg = d.get("message") or {}
            session = d.get("sessionId") or session
            meta = {**meta_base, "session": session, "ts": d.get("timestamp"), "cwd": d.get("cwd")}
            role = msg.get("role") or d.get("type")
            content = msg.get("content")
            blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "tool_use":
                    inp = json.dumps(b.get("input") or {})
                    tools[b.get("id")] = (b.get("name") or "", inp)
                    hits = find_repos(inp)
                    if hits:
                        k = classify(b.get("name") or "", inp)
                        emit(acc, hits, inp, "search" if k == "search" else "call", b.get("name"), meta)
                elif t == "tool_result":
                    name, inp = tools.get(b.get("tool_use_id"), ("?", ""))
                    text = to_text(b.get("content"))
                    gh_search = bool(re.search(r"gh\s+search\s+repos", inp))
                    hits = find_repos(text, gh_search)
                    if hits:
                        emit(acc, hits, text, classify(name, inp), name, meta)
                elif t == "text":
                    text = b.get("text") or ""
                    hits = find_repos(text)
                    if hits:
                        emit(acc, hits, text, "prose_assistant" if role == "assistant" else "prose_user", None, meta)
    return acc


def scan_codex(path):
    acc = []
    session, cwd = None, None
    calls = {}
    try:
        fh = open(path, errors="replace")
    except OSError:
        return acc
    seen_items = False
    with fh:
        for line in fh:
            if not any(k in line for k in ("github", "item_completed", "session_meta", "turn_context", "function_call", "custom_tool_call")):
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            p = d.get("payload") or {}
            typ = d.get("type")
            if typ == "session_meta":
                session = p.get("id") or p.get("session_id")
                cwd = p.get("cwd")
                continue
            if typ == "turn_context":
                cwd = p.get("cwd") or cwd
                continue
            meta = {"source": "codex", "file": path, "session": session, "ts": d.get("timestamp"), "cwd": cwd}
            if typ == "event_msg" and p.get("type") == "item_completed":
                seen_items = True
                it = p.get("item") or {}
                it_t = it.get("type")
                if it_t == "CommandExecution":
                    cmd = to_text(it.get("command"))
                    out = to_text(it.get("aggregated_output") or it.get("stdout"))
                    k = classify("exec", cmd)
                    hits = find_repos(cmd)
                    emit(acc, hits, cmd, "search" if k == "search" else "call", "exec", meta)
                    hits = find_repos(out, bool(re.search(r"gh\s+search\s+repos", cmd)))
                    emit(acc, hits, out, k, "exec", meta)
                elif it_t == "McpToolCall":
                    name = f"{it.get('server')}.{it.get('tool')}"
                    args = to_text(it.get("arguments"))
                    res = to_text(it.get("result"))
                    k = classify(name, args)
                    emit(acc, find_repos(args), args, "search" if k == "search" else "call", name, meta)
                    emit(acc, find_repos(res), res, k, name, meta)
                elif it_t in ("AgentMessage", "UserMessage"):
                    text = to_text(it.get("content"))
                    emit(acc, find_repos(text), text,
                         "prose_assistant" if it_t == "AgentMessage" else "prose_user", None, meta)
            elif typ == "response_item" and not seen_items:
                # older rollouts without item_completed events
                pt = p.get("type")
                if pt in ("function_call", "custom_tool_call", "local_shell_call"):
                    inp = to_text(p.get("arguments") or p.get("input") or p.get("action"))
                    calls[p.get("call_id")] = (p.get("name") or pt, inp)
                    k = classify(p.get("name") or pt, inp)
                    emit(acc, find_repos(inp), inp, "search" if k == "search" else "call", p.get("name"), meta)
                elif pt in ("function_call_output", "custom_tool_call_output"):
                    name, inp = calls.get(p.get("call_id"), ("?", ""))
                    out = to_text(p.get("output"))
                    emit(acc, find_repos(out, bool(re.search(r"gh\s+search\s+repos", inp))), out,
                         classify(name, inp), name, meta)
                elif pt == "message":
                    text = to_text(p.get("content"))
                    role = p.get("role")
                    if role in ("assistant", "user"):
                        emit(acc, find_repos(text), text, f"prose_{role}", None, meta)
    return acc


def scan(arg):
    src, path = arg
    return scan_claude(path) if src == "claude" else scan_codex(path)


KIND_RANK = {"prose_assistant": 0, "search": 1, "prose_user": 2, "call": 3, "local": 4}


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for src, root in ROOTS:
        for dp, _, fns in os.walk(root):
            files += [(src, os.path.join(dp, f)) for f in fns if f.endswith(".jsonl")]
    seen = set()
    by_repo = defaultdict(list)
    raw = 0
    with Pool() as pool, open(os.path.join(out_dir, "mentions.jsonl"), "w") as mf:
        for res in pool.imap_unordered(scan, files, chunksize=4):
            for m in res:
                raw += 1
                key = m["repo"].lower()
                h = hashlib.sha1(f"{key}|{m['session']}|{m['snippet']}".encode()).hexdigest()
                if h in seen:
                    continue
                seen.add(h)
                mf.write(json.dumps(m) + "\n")
                by_repo[key].append(m)
    repos = []
    for key, ms in by_repo.items():
        names = defaultdict(int)
        for m in ms:
            names[m["repo"]] += 1
        kinds = defaultdict(int)
        for m in ms:
            kinds[m["kind"]] += 1
        sessions = {m["session"] for m in ms}
        ts = sorted(m["ts"] for m in ms if m.get("ts"))
        ms_sorted = sorted(ms, key=lambda m: (KIND_RANK.get(m["kind"], 9), -len(m["snippet"])))
        picked, picked_sessions = [], set()
        for m in ms_sorted:  # prefer snippets from distinct sessions
            if m["session"] not in picked_sessions and len(picked) < 4:
                picked.append(m)
                picked_sessions.add(m["session"])
        repos.append({
            "repo": max(names, key=names.get),
            "owned": key.split("/")[0] in OWN_OWNERS,
            "mentions": len(ms),
            "sessions": len(sessions),
            "kinds": dict(kinds),
            "first_seen": ts[0] if ts else None,
            "last_seen": ts[-1] if ts else None,
            "cwds": sorted({m["cwd"] for m in ms if m.get("cwd")})[:5],
            "snippets": [{k: m[k] for k in ("kind", "tool", "ts", "cwd", "snippet")} for m in picked],
        })
    repos.sort(key=lambda r: -r["sessions"])
    with open(os.path.join(out_dir, "repos.json"), "w") as f:
        json.dump(repos, f)
    print(json.dumps({"files": len(files), "raw_mentions": raw, "deduped_mentions": len(seen), "repos": len(repos),
                      "owned": sum(r["owned"] for r in repos),
                      "research_sourced": sum(1 for r in repos if not r["owned"] and (
                          r["kinds"].get("search") or r["kinds"].get("prose_assistant") or r["kinds"].get("prose_user")))}))


if __name__ == "__main__":
    main()

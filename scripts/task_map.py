#!/usr/bin/env python3
"""Generate the task map: which tasks are done, in progress, ready to pick, or blocked.

Reads task dependencies from tasks/todo.md and live status from GitHub issues
(closed = done; open with an assignee = picked). Writes:
  tasks/task-map.html  for people (open in a browser)
  tasks/task-map.json  for AI agents (see "suggestions")

Usage:
  python3 scripts/task_map.py                       # live sync via `gh` (gh auth login)
  python3 scripts/task_map.py --issues-json f.json  # offline, from saved issue data

Files are only rewritten when task data changes, so scheduled syncs don't create
empty commits. Standard library only.
"""

# ruff: noqa: E501, UP017  (long lines are the HTML/CSS template; timezone.utc keeps Python 3.9 working)

from __future__ import annotations

import argparse
import functools
import hashlib
import html
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
TODO = ROOT / "tasks" / "todo.md"
OUT_HTML = ROOT / "tasks" / "task-map.html"
OUT_JSON = ROOT / "tasks" / "task-map.json"
REPO = "melvin1117/wildworth"
ROLES = ["PD", "D1", "D2", "D3"]
PRIORITY_RANK = {"Must": 0, "Should": 1, "Could": 2}

HEADING = re.compile(
    r"^### (?P<id>[TP]\d\d) · (?P<title>.+?) \(#(?P<issue>\d+)\) — (?P<owner>.+?) · "
    r"(?P<size>XS|S|M|L) · (?P<prio>Must|Should|Could)",
    re.M,
)


def parse_todo(text: str) -> dict[str, dict[str, Any]]:
    """Extract id, title, issue, owner roles, priority, week and deps for every task."""
    tasks: dict[str, dict[str, Any]] = {}
    week = 0
    blocks = re.split(r"\n(?=## |### )", text)
    for block in blocks:
        week_match = re.match(r"## Week (\d)", block)
        if week_match:
            week = int(week_match.group(1))
            continue
        m = HEADING.match(block)
        if not m:
            continue
        deps_match = re.search(r"\*\*Deps:\*\* ([^·\n]+)", block)
        owner_text = m.group("owner")
        roles = [r for r in ROLES if r in owner_text] or (["All"] if "All" in owner_text else [])
        tasks[m.group("id")] = {
            "id": m.group("id"),
            "title": m.group("title"),
            "issue": int(m.group("issue")),
            "owner": owner_text,
            "roles": roles,
            "size": m.group("size"),
            "priority": m.group("prio"),
            "week": week,
            "deps": re.findall(r"[TP]\d\d", deps_match.group(1) if deps_match else ""),
        }
    if not tasks:
        sys.exit(f"No tasks found in {TODO}; has the heading format changed?")
    unknown = {d for t in tasks.values() for d in t["deps"] if d not in tasks}
    if unknown:
        sys.exit(f"Unknown dependencies in todo.md: {sorted(unknown)}")
    return tasks


def fetch_issues(issues_json: Path | None) -> dict[int, dict[str, Any]]:
    if issues_json:
        raw = json.loads(issues_json.read_text())
    else:
        try:
            out = subprocess.run(
                [
                    "gh",
                    "issue",
                    "list",
                    "-R",
                    REPO,
                    "--state",
                    "all",
                    "--limit",
                    "500",
                    "--json",
                    "number,state,assignees",
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        except FileNotFoundError:
            sys.exit(
                "`gh` not found. Install GitHub CLI and run `gh auth login`, or pass --issues-json."
            )
        except subprocess.CalledProcessError as exc:
            sys.exit(f"`gh issue list` failed (run `gh auth login`?):\n{exc.stderr}")
        raw = json.loads(out)
    return {
        int(i["number"]): {
            "closed": str(i["state"]).upper() == "CLOSED",
            "assignees": sorted(
                a["login"] if isinstance(a, dict) else a for a in i.get("assignees", [])
            ),
        }
        for i in raw
    }


def build(tasks: dict[str, dict[str, Any]], issues: dict[int, dict[str, Any]]) -> dict[str, Any]:
    done: set[str] = {tid for tid, t in tasks.items() if issues.get(t["issue"], {}).get("closed")}

    @functools.cache
    def step(tid: str) -> int:
        deps = tasks[tid]["deps"]
        return 0 if not deps else 1 + max(step(d) for d in deps)

    dependents: dict[str, list[str]] = {tid: [] for tid in tasks}
    for tid, t in tasks.items():
        for d in t["deps"]:
            dependents[d].append(tid)

    @functools.cache
    def chain(tid: str) -> int:
        """Length of the longest chain of unfinished work starting at this task."""
        if tid in done:
            return 0
        return 1 + max((chain(k) for k in dependents[tid]), default=0)

    # Critical path: follow the longest unfinished chain from the best starting task.
    critical: list[str] = []
    open_ids = [t for t in tasks if t not in done]
    if open_ids:
        current: str | None = max(open_ids, key=lambda t: (chain(t), -step(t)))
        while current:
            critical.append(current)
            nxt = [k for k in dependents[current] if k not in done]
            current = max(nxt, key=chain) if nxt else None

    out_tasks = []
    for tid, t in sorted(tasks.items(), key=lambda kv: (step(kv[0]), kv[0])):
        issue = issues.get(t["issue"], {"closed": False, "assignees": []})
        waiting = [d for d in t["deps"] if d not in done]
        if tid in done:
            status = "done"
        elif issue["assignees"] and waiting:
            status = "picked_early"
        elif issue["assignees"]:
            status = "in_progress"
        elif waiting:
            status = "blocked"
        else:
            status = "ready"
        out_tasks.append(
            {
                **t,
                "status": status,
                "assignees": issue["assignees"],
                "waiting_on": waiting,
                "unlocks": sorted(dependents[tid]),
                "step": step(tid),
                "chain": chain(tid),
                "critical": tid in critical,
            }
        )

    def rank(task: dict[str, Any]) -> tuple:
        return (
            not task["critical"],
            -task["chain"],
            PRIORITY_RANK[task["priority"]],
            task["week"],
            task["id"],
        )

    ready = sorted((t for t in out_tasks if t["status"] == "ready"), key=rank)
    suggestions = {
        role: [t["id"] for t in ready if role in t["roles"] or "All" in t["roles"]][:3]
        for role in ROLES
    }
    suggestions["any"] = [t["id"] for t in ready][:5]
    counts = {
        s: sum(1 for t in out_tasks if t["status"] == s)
        for s in ("done", "in_progress", "picked_early", "ready", "blocked")
    }
    data = {
        "tasks": out_tasks,
        "critical_path": critical,
        "suggestions": suggestions,
        "counts": counts,
    }
    data["data_hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]
    return data


STATUS_META = {
    "done": ("✅", "Done"),
    "in_progress": ("🔨", "In progress"),
    "picked_early": ("⚠️", "Picked before prerequisites are done"),
    "ready": ("🟢", "Ready to pick"),
    "blocked": ("⏳", "Blocked"),
}


def render_html(data: dict[str, Any], generated_at: str) -> str:
    by_id = {t["id"]: t for t in data["tasks"]}
    issue_url = f"https://github.com/{REPO}/issues/"

    def chip(tid: str) -> str:
        t = by_id[tid]
        icon = STATUS_META[t["status"]][0]
        return (
            f'<a class="chip s-{t["status"]}" href="{issue_url}{t["issue"]}" '
            f'title="{html.escape(t["title"])}">{icon} {tid}</a>'
        )

    def card(t: dict[str, Any]) -> str:
        icon, label = STATUS_META[t["status"]]
        who = ", ".join("@" + a for a in t["assignees"]) or "unassigned"
        waits = " ".join(chip(d) for d in t["waiting_on"]) or "—"
        deps = " ".join(chip(d) for d in t["deps"]) or "none"
        flags = (
            ' <span class="crit" title="On the critical path">critical path</span>'
            if t["critical"]
            else ""
        )
        flags += f' <span class="prio">{t["priority"]}</span>' if t["priority"] != "Must" else ""
        return (
            f'<div class="card s-{t["status"]}" data-roles="{" ".join(t["roles"])}" data-status="{t["status"]}">'
            f'<div class="top"><span title="{label}">{icon}</span> <b>{t["id"]}</b> '
            f'<a href="{issue_url}{t["issue"]}">#{t["issue"]}</a>{flags}</div>'
            f'<div class="title">{html.escape(t["title"])}</div>'
            f'<div class="meta">{html.escape(t["owner"])} · {t["size"]} · {who}</div>'
            f'<div class="deps">Needs: {deps}</div>'
            + (f'<div class="waits">Waiting on: {waits}</div>' if t["waiting_on"] else "")
            + "</div>"
        )

    steps: dict[int, list[dict[str, Any]]] = {}
    for t in data["tasks"]:
        steps.setdefault(t["step"], []).append(t)
    columns = "".join(
        f'<section class="col"><h3>Step {s}</h3>{"".join(card(t) for t in ts)}</section>'
        for s, ts in sorted(steps.items())
    )

    def suggestion_list(ids: list[str]) -> str:
        if not ids:
            return '<span class="muted">Nothing ready: help finish an in-progress task</span>'
        return " ".join(
            f'<a class="chip s-ready" href="{issue_url}{by_id[i]["issue"]}">🟢 {i} {html.escape(by_id[i]["title"])}</a>'
            for i in ids
        )

    picks = "".join(
        f"<tr><th>{role}</th><td>{suggestion_list(data['suggestions'][role])}</td></tr>"
        for role in ROLES
    )
    early = [t for t in data["tasks"] if t["status"] == "picked_early"]
    warn = ""
    if early:
        items = "".join(
            f"<li>{chip(t['id'])} {html.escape(t['title'])} (@{', @'.join(t['assignees'])}) "
            f"is waiting on {' '.join(chip(d) for d in t['waiting_on'])}</li>"
            for t in early
        )
        warn = (
            f'<div class="warn"><b>⚠️ Picked before prerequisites are done</b><ul>{items}</ul></div>'
        )
    c = data["counts"]
    total = len(data["tasks"])
    path = " → ".join(chip(t) for t in data["critical_path"]) or "All done 🎉"
    legend = " ".join(
        f'<span class="chip s-{k}">{v[0]} {v[1]}</span>' for k, v in STATUS_META.items()
    )
    filters = "".join(f'<button data-role="{r}">{r}</button>' for r in ["All roles"] + ROLES)

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WildWorth task map</title>
<style>
:root {{ --bg:#f5f7f3; --panel:#fff; --border:#dde5da; --text:#26332d; --muted:#5f6f67; --accent:#4f7d63; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }}
header {{ padding:18px 24px; background:var(--panel); border-bottom:1px solid var(--border); }}
h1 {{ margin:0 0 4px; font-size:20px; }} h2 {{ font-size:14px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent); margin:22px 0 8px; }}
.muted {{ color:var(--muted); font-size:13px; }}
main {{ padding:0 24px 40px; }}
.stats {{ display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }}
.stat {{ background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:6px 12px; font-size:14px; }}
table.picks {{ border-collapse:collapse; background:var(--panel); border:1px solid var(--border); border-radius:12px; width:100%; }}
table.picks th {{ text-align:left; padding:10px 14px; width:60px; border-bottom:1px solid var(--border); }}
table.picks td {{ padding:8px 14px; border-bottom:1px solid var(--border); }}
.chip {{ display:inline-block; padding:2px 8px; border-radius:999px; font-size:12.5px; margin:2px 2px; text-decoration:none; color:var(--text); border:1px solid rgba(0,0,0,.08); white-space:nowrap; }}
.s-done {{ background:#e3efe6; }} .s-in_progress {{ background:#dbe8f5; }} .s-picked_early {{ background:#fbe3d6; }}
.s-ready {{ background:#d9f2df; border-color:#8cc79c; }} .s-blocked {{ background:#eef0ee; color:#6b756f; }}
.warn {{ background:#fdf1ea; border:1px solid #f1c7b0; border-radius:12px; padding:10px 16px; margin-top:16px; font-size:14px; }}
.warn ul {{ margin:6px 0 0; padding-left:18px; }}
.board {{ display:flex; gap:12px; overflow-x:auto; padding-bottom:12px; align-items:flex-start; }}
.col {{ min-width:230px; max-width:230px; }} .col h3 {{ font-size:13px; color:var(--muted); margin:0 0 8px; }}
.card {{ background:var(--panel); border:1px solid var(--border); border-left:5px solid #c9d3cc; border-radius:10px; padding:8px 10px; margin-bottom:8px; font-size:13px; }}
.card.s-done {{ border-left-color:#6f9f7e; opacity:.7; }} .card.s-in_progress {{ border-left-color:#5b8ec2; }}
.card.s-picked_early {{ border-left-color:#d9825b; }} .card.s-ready {{ border-left-color:#3fae5c; box-shadow:0 0 0 1px #8cc79c; }}
.card.s-blocked {{ background:#fafbfa; }}
.card .title {{ font-weight:600; margin:2px 0; }} .card .meta, .card .deps, .card .waits {{ color:var(--muted); font-size:12px; margin-top:2px; }}
.card a {{ color:var(--accent); }} .crit {{ background:#fff3c4; border-radius:6px; padding:0 5px; font-size:11px; }}
.prio {{ background:#eef0ee; border-radius:6px; padding:0 5px; font-size:11px; }}
.filters button {{ border:1px solid var(--border); background:var(--panel); border-radius:999px; padding:5px 12px; margin-right:4px; cursor:pointer; }}
.filters button.on {{ background:var(--accent); color:#fff; border-color:var(--accent); }}
.card.hide {{ display:none; }}
</style></head><body>
<header>
  <h1>🌿 WildWorth task map</h1>
  <div class="muted">Synced from GitHub issues {generated_at} · source: <code>tasks/todo.md</code> + issue status · regenerate: <code>make task-map</code></div>
  <div class="stats">
    <span class="stat">✅ Done <b>{c["done"]}</b>/{total}</span><span class="stat">🔨 In progress <b>{c["in_progress"]}</b></span>
    <span class="stat">⚠️ Picked early <b>{c["picked_early"]}</b></span><span class="stat">🟢 Ready <b>{c["ready"]}</b></span>
    <span class="stat">⏳ Blocked <b>{c["blocked"]}</b></span>
  </div>
</header>
<main>
  <h2>Pick next (ready, unassigned, best first)</h2>
  <table class="picks">{picks}</table>
  <p class="muted">How to pick: choose a 🟢 task for your role, <b>assign yourself on the issue</b> (that marks it picked), then work on a branch and open a PR. Never start a ⏳ task.</p>
  {warn}
  <h2>Critical path (any delay here delays submission)</h2>
  <div>{path}</div>
  <h2>All tasks by step</h2>
  <div class="filters">{filters}</div>
  <p class="muted">{legend}</p>
  <div class="board">{columns}</div>
</main>
<script>
document.querySelectorAll('.filters button').forEach(b => b.addEventListener('click', () => {{
  document.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b));
  const role = b.dataset.role;
  document.querySelectorAll('.card').forEach(c => c.classList.toggle('hide',
    role !== 'All roles' && !c.dataset.roles.split(' ').some(r => r === role || r === 'All')));
}}));
document.querySelector('.filters button').classList.add('on');
</script>
</body></html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--issues-json", type=Path, help="offline: JSON list of {number, state, assignees}"
    )
    parser.add_argument(
        "--force", action="store_true", help="rewrite files even if task data is unchanged"
    )
    args = parser.parse_args()

    data = build(parse_todo(TODO.read_text()), fetch_issues(args.issues_json))
    if not args.force and OUT_JSON.exists():
        try:
            if json.loads(OUT_JSON.read_text()).get("data_hash") == data["data_hash"]:
                print("Task map unchanged.")
                return
        except json.JSONDecodeError:
            pass
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    OUT_JSON.write_text(json.dumps({"generated_at": generated_at, **data}, indent=2) + "\n")
    OUT_HTML.write_text(render_html(data, generated_at))
    c = data["counts"]
    print(
        f"Task map updated: {c['done']} done, {c['in_progress']} in progress, "
        f"{c['picked_early']} picked early, {c['ready']} ready, {c['blocked']} blocked."
    )


if __name__ == "__main__":
    main()

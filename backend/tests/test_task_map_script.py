"""scripts/task_map.py: the task map generator (ADR-0007). `--check` must reject a todo.md the
map can't be built from, and a regeneration must only rewrite the files when something changed."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "task_map.py"

TODO = """# Todo

## Week 1

### T01 · First task (#1) — D1 · S · Must
**Deps:** —

### T02 · Second task (#2) — D2 · M · Should
**Deps:** T01
"""


def write_issues(path: Path, closed: tuple[int, ...] = ()) -> Path:
    issues = [
        {"number": n, "state": "CLOSED" if n in closed else "OPEN", "assignees": []} for n in (1, 2)
    ]
    path.write_text(json.dumps(issues))
    return path


def run(*args: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *map(str, args)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def check(tmp_path: Path, todo: str) -> subprocess.CompletedProcess[str]:
    (tmp_path / "todo.md").write_text(todo)
    return run("--check", "--todo", tmp_path / "todo.md", "--out-dir", tmp_path / "out")


def test_check_accepts_a_valid_todo_and_writes_nothing(tmp_path: Path) -> None:
    result = check(tmp_path, TODO)

    assert result.returncode == 0, result.stderr
    assert "todo.md OK: 2 tasks" in result.stdout
    assert not (tmp_path / "out").exists()


def test_check_passes_on_the_real_todo() -> None:
    result = run("--check")

    assert result.returncode == 0, result.stderr


def test_check_rejects_an_unknown_dependency(tmp_path: Path) -> None:
    result = check(tmp_path, TODO.replace("**Deps:** T01", "**Deps:** T01, T99"))

    assert result.returncode != 0
    assert "Unknown dependencies in todo.md: ['T99']" in result.stderr


def test_check_rejects_a_task_heading_that_does_not_parse(tmp_path: Path) -> None:
    bad = TODO + "\n### T03 · Third task (#3) — D1 · Huge · Must\n**Deps:** —\n"

    result = check(tmp_path, bad)

    assert result.returncode != 0
    assert "Heading doesn't match the expected format: ### T03 · Third task" in result.stderr


def test_check_rejects_a_duplicate_id(tmp_path: Path) -> None:
    dup = TODO + "\n### T02 · Copy of the second task (#3) — D3 · S · Could\n**Deps:** —\n"

    result = check(tmp_path, dup)

    assert result.returncode != 0
    assert "Duplicate task id T02" in result.stderr


def test_out_dir_receives_both_files(tmp_path: Path) -> None:
    (tmp_path / "todo.md").write_text(TODO)
    out = tmp_path / "nested" / "out"

    result = run(
        "--todo",
        tmp_path / "todo.md",
        "--issues-json",
        write_issues(tmp_path / "i.json"),
        "--out-dir",
        out,
    )

    assert result.returncode == 0, result.stderr
    data = json.loads((out / "task-map.json").read_text())
    assert [t["status"] for t in data["tasks"]] == ["ready", "blocked"]
    assert data["suggestions"]["D1"] == ["T01"]
    assert "T01" in (out / "task-map.html").read_text()


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_data_hash_covers_the_generator(tmp_path: Path) -> None:
    (tmp_path / "todo.md").write_text(TODO)
    out = tmp_path / "out"

    run(
        "--todo",
        tmp_path / "todo.md",
        "--issues-json",
        write_issues(tmp_path / "i.json"),
        "--out-dir",
        out,
    )

    blob = subprocess.run(
        ["git", "hash-object", "--no-filters", str(SCRIPT)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert json.loads((out / "task-map.json").read_text())["generator"] == blob


def test_unchanged_data_is_not_rewritten(tmp_path: Path) -> None:
    (tmp_path / "todo.md").write_text(TODO)
    out = tmp_path / "out"
    args = ("--todo", tmp_path / "todo.md", "--out-dir", out, "--issues-json")
    run(*args, write_issues(tmp_path / "i.json"))
    first = (out / "task-map.json").read_text()

    again = run(*args, write_issues(tmp_path / "i.json"))

    assert "Task map unchanged." in again.stdout
    assert (out / "task-map.json").read_text() == first

    changed = run(*args, write_issues(tmp_path / "i.json", closed=(1,)))

    assert "Task map updated: 1 done" in changed.stdout
    data = json.loads((out / "task-map.json").read_text())
    assert data["data_hash"] != json.loads(first)["data_hash"]
    assert [t["status"] for t in data["tasks"]] == ["done", "ready"]

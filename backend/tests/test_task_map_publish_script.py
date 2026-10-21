"""scripts/task_map_publish.sh (ADR-0007) force-pushes the task map to the `task-map` branch, so
its lease must stop it from overwriting a branch that moved, and an unchanged map must not be
republished. Runs against a local bare remote."""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
PUBLISH = SCRIPTS / "task_map_publish.sh"

TODO = """## Week 1

### T01 · First task (#1) — D1 · S · Must
**Deps:** —

### T02 · Second task (#2) — D2 · M · Should
**Deps:** T01
"""

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("git") is None or shutil.which("python3") is None,
    reason="needs bash, git and python3",
)


def clean_env() -> dict[str, str]:
    drop = ("GIT_CONFIG_", "TASK_MAP_TOKEN", "GITHUB_ACTIONS", "GIT_DIR", "GIT_WORK_TREE")
    return {k: v for k, v in os.environ.items() if not k.startswith(drop)}


def git(*args: str | Path) -> str:
    return subprocess.run(
        ["git", *map(str, args)], capture_output=True, text=True, check=True, env=clean_env()
    ).stdout.strip()


def bash(script: str, *args: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script, "bash", *map(str, args)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        env=clean_env(),
    )


class Fixture:
    def __init__(self, tmp_path: Path) -> None:
        self.tmp = tmp_path
        self.remote = tmp_path / "remote.git"
        git("init", "--quiet", "--bare", self.remote)
        self.todo = tmp_path / "todo.md"
        self.todo.write_text(TODO)
        self.runs = 0

    def publish(self, closed: tuple[int, ...] = ()) -> subprocess.CompletedProcess[str]:
        self.runs += 1
        issues = self.tmp / f"issues-{self.runs}.json"
        issues.write_text(
            json.dumps(
                [{"number": n, "state": "CLOSED" if n in closed else "OPEN"} for n in (1, 2)]
            )
        )
        return bash(
            '"$0" "$@"',
            PUBLISH,
            self.remote,
            self.tmp / f"work-{self.runs}",
            "--todo",
            self.todo,
            "--issues-json",
            issues,
        )

    def push_with_lease(self, lease: str) -> subprocess.CompletedProcess[str]:
        """Read the published map, change it, and push it expecting the branch at `lease`."""
        self.runs += 1
        work = self.tmp / f"work-{self.runs}"
        return bash(
            'source "$1" && fetch_map "$2" "$3" >/dev/null && echo " " >> "$3/task-map.json" '
            '&& push_map "$2" "$3" "$4"',
            PUBLISH,
            self.remote,
            work,
            lease,
        )

    def head(self) -> str:
        return git("--git-dir", self.remote, "rev-parse", "refs/heads/task-map")


@pytest.fixture
def fx(tmp_path: Path) -> Fixture:
    return Fixture(tmp_path)


def test_first_run_creates_the_branch_with_one_parentless_commit(fx: Fixture) -> None:
    result = fx.publish()

    assert result.returncode == 0, result.stderr
    assert "No task-map branch yet" in result.stderr
    assert "Published" in result.stdout
    files = git("--git-dir", fx.remote, "ls-tree", "--name-only", "task-map").splitlines()
    assert sorted(files) == [".nojekyll", "index.html", "task-map.html", "task-map.json"]
    assert git("--git-dir", fx.remote, "rev-list", "--count", "task-map") == "1"


def test_unchanged_map_is_not_republished(fx: Fixture) -> None:
    fx.publish()
    before = fx.head()

    result = fx.publish()

    assert result.returncode == 0, result.stderr
    assert "No change." in result.stdout
    assert fx.head() == before


def test_changed_map_replaces_the_commit(fx: Fixture) -> None:
    fx.publish()
    before = fx.head()

    result = fx.publish(closed=(1,))

    assert result.returncode == 0, result.stderr
    assert fx.head() != before
    assert git("--git-dir", fx.remote, "rev-list", "--count", "task-map") == "1"
    published = json.loads(git("--git-dir", fx.remote, "show", "task-map:task-map.json"))
    assert published["counts"]["done"] == 1


def test_empty_lease_is_rejected_when_the_branch_exists(fx: Fixture) -> None:
    fx.publish()
    before = fx.head()

    result = fx.push_with_lease("")

    assert result.returncode != 0
    assert "push rejected" in result.stderr
    assert fx.head() == before


def test_stale_lease_is_rejected(fx: Fixture) -> None:
    fx.publish()
    stale = fx.head()
    fx.publish(closed=(1,))
    current = fx.head()
    assert current != stale

    result = fx.push_with_lease(stale)

    assert result.returncode != 0
    assert "push rejected" in result.stderr
    assert fx.head() == current


def test_unreachable_remote_fails_instead_of_starting_a_new_branch(fx: Fixture) -> None:
    fx.remote = fx.tmp / "missing.git"

    result = fx.publish()

    assert result.returncode != 0
    assert "couldn't list branches on the remote" in result.stderr
    assert "No task-map branch yet" not in result.stderr


def test_token_becomes_a_masked_header_in_the_environment_only(tmp_path: Path) -> None:
    git("init", "--quiet", tmp_path)
    script = (
        'source "$1" && setup_auth && git config --get http.https://github.com/.extraheader '
        '&& git config --get core.kept && echo "count=$GIT_CONFIG_COUNT"'
    )
    env = clean_env() | {
        "GITHUB_ACTIONS": "true",
        "TASK_MAP_TOKEN": "s3cret",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.kept",
        "GIT_CONFIG_VALUE_0": "yes",
    }

    result = subprocess.run(
        ["bash", "-c", script, "bash", str(PUBLISH)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        env=env,
        cwd=tmp_path,
    )

    basic = base64.b64encode(b"x-access-token:s3cret").decode()
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        f"::add-mask::{basic}",
        f"AUTHORIZATION: basic {basic}",
        "yes",
        "count=2",
    ]
    config = (tmp_path / ".git" / "config").read_text()
    assert "s3cret" not in config
    assert basic not in config

"""scripts/e2e-backend.sh (T74) drops and recreates its database, so its guard must refuse any
database that isn't a local `*e2e*` one before it connects anywhere."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "e2e-backend.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("uv") is None, reason="needs bash and uv"
)


def run_script(database_url: str, **extra: str) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("E2E_")}
    env |= {
        "E2E_DATABASE_URL": database_url,
        "E2E_API_PORT": "1",
        "E2E_WEB_ORIGIN": "http://localhost:1",
        "E2E_ADMIN_EMAIL": "guard@wildworth.test",
        "E2E_ADMIN_PASSWORD": "never used by these tests",
        **extra,
    }
    return subprocess.run(
        ["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120, check=False
    )


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql+psycopg://wildworth:wildworth@db.example.org:5432/wildworth_e2e",
        "postgresql+psycopg://wildworth:wildworth@10.0.0.5:5432/wildworth_e2e",
    ],
)
def test_refuses_a_remote_host(database_url: str) -> None:
    result = run_script(database_url)

    assert result.returncode != 0
    assert "refusing to recreate 'wildworth_e2e' on host" in result.stderr
    assert "recreated database" not in result.stdout


@pytest.mark.parametrize("name", ["wildworth", "wildworth_test"])
def test_refuses_a_name_without_e2e(name: str) -> None:
    result = run_script(f"postgresql+psycopg://wildworth:wildworth@localhost:5432/{name}")

    assert result.returncode != 0
    assert f"refusing to recreate {name!r}" in result.stderr
    assert "recreated database" not in result.stdout


def test_a_remote_host_needs_the_explicit_opt_in() -> None:
    # `.invalid` never resolves, so the run fails at connect time, after the guard let it through.
    result = run_script(
        "postgresql+psycopg://wildworth:wildworth@db.invalid:5432/wildworth_e2e",
        E2E_ALLOW_REMOTE_DB="1",
    )

    assert result.returncode != 0
    assert "refusing" not in result.stderr
    assert "recreated database" not in result.stdout

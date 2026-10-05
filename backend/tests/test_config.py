"""Settings load .env from the repo root (README) and from backend/."""

from pathlib import Path

import pytest

from app.config import Settings


def test_reads_repo_root_env_when_run_from_backend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    backend = tmp_path / "backend"
    backend.mkdir()
    (tmp_path / ".env").write_text("APP_NAME=from-root\n")
    monkeypatch.chdir(backend)
    monkeypatch.delenv("APP_NAME", raising=False)

    assert Settings().app_name == "from-root"


def test_backend_env_overrides_root_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    backend = tmp_path / "backend"
    backend.mkdir()
    (tmp_path / ".env").write_text("APP_NAME=from-root\n")
    (backend / ".env").write_text("APP_NAME=from-backend\n")
    monkeypatch.chdir(backend)
    monkeypatch.delenv("APP_NAME", raising=False)

    assert Settings().app_name == "from-backend"

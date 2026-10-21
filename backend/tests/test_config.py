"""Settings load .env from the repo root (README) and backend/, unless NATUREX_ENV_FILE=none."""

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
    monkeypatch.delenv("NATUREX_ENV_FILE", raising=False)

    assert Settings().app_name == "from-root"


def test_backend_env_overrides_root_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    backend = tmp_path / "backend"
    backend.mkdir()
    (tmp_path / ".env").write_text("APP_NAME=from-root\n")
    (backend / ".env").write_text("APP_NAME=from-backend\n")
    monkeypatch.chdir(backend)
    monkeypatch.delenv("APP_NAME", raising=False)
    monkeypatch.delenv("NATUREX_ENV_FILE", raising=False)

    assert Settings().app_name == "from-backend"


def test_env_file_switch_none_ignores_every_env_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    backend = tmp_path / "backend"
    backend.mkdir()
    (tmp_path / ".env").write_text("APP_NAME=from-root\nUSE_MOCKS=false\n")
    (backend / ".env").write_text("APP_NAME=from-backend\nLLM_BUDGET_USD=999\n")
    monkeypatch.chdir(backend)
    monkeypatch.delenv("APP_NAME", raising=False)
    monkeypatch.delenv("USE_MOCKS", raising=False)
    monkeypatch.delenv("LLM_BUDGET_USD", raising=False)
    monkeypatch.setenv("NATUREX_ENV_FILE", "none")

    settings = Settings()

    assert settings.app_name == "NatureX"
    assert settings.use_mocks is True
    assert settings.llm_budget_usd == 20.0


def test_env_file_switch_still_reads_the_process_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("APP_NAME=from-file\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("NATUREX_ENV_FILE", "none")
    monkeypatch.setenv("APP_NAME", "from-environment")

    assert Settings().app_name == "from-environment"


def test_env_file_switch_other_values_keep_reading_env_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("APP_NAME=from-file\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("APP_NAME", raising=False)
    monkeypatch.setenv("NATUREX_ENV_FILE", "")

    assert Settings().app_name == "from-file"

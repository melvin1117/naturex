"""Settings load .env from the repo root (README) and backend/, unless WILDWORTH_ENV_FILE=none."""

import re
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
    monkeypatch.delenv("WILDWORTH_ENV_FILE", raising=False)

    assert Settings().app_name == "from-root"


def test_backend_env_overrides_root_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    backend = tmp_path / "backend"
    backend.mkdir()
    (tmp_path / ".env").write_text("APP_NAME=from-root\n")
    (backend / ".env").write_text("APP_NAME=from-backend\n")
    monkeypatch.chdir(backend)
    monkeypatch.delenv("APP_NAME", raising=False)
    monkeypatch.delenv("WILDWORTH_ENV_FILE", raising=False)

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
    monkeypatch.setenv("WILDWORTH_ENV_FILE", "none")

    settings = Settings()

    assert settings.app_name == "WildWorth"
    assert settings.use_mocks is True
    assert settings.llm_budget_usd == 20.0


def test_env_file_switch_still_reads_the_process_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("APP_NAME=from-file\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("WILDWORTH_ENV_FILE", "none")
    monkeypatch.setenv("APP_NAME", "from-environment")

    assert Settings().app_name == "from-environment"


def test_env_file_switch_other_values_keep_reading_env_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("APP_NAME=from-file\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("APP_NAME", raising=False)
    monkeypatch.setenv("WILDWORTH_ENV_FILE", "")

    assert Settings().app_name == "from-file"


REPO_ROOT = Path(__file__).resolve().parents[2]


def _postgres_env(text: str) -> tuple[str, str, str]:
    values = dict(re.findall(r"POSTGRES_(USER|PASSWORD|DB): (\S+)", text))
    return values["USER"], values["PASSWORD"], values["DB"]


def test_every_setup_file_names_the_same_database() -> None:
    """compose, .env.example, the Settings default, CI and E2E agree, so a partial rename can't
    pass CI and leave a fresh setup unable to connect."""
    default = Settings.model_fields["database_url"].default
    env_example = (REPO_ROOT / ".env.example").read_text()
    assert f"\nDATABASE_URL={default}\n" in env_example
    url = re.fullmatch(r"postgresql\+psycopg://(\w+):(\w+)@localhost:5432/(\w+)", default)
    assert url is not None, default
    user_password_db = url.groups()

    assert _postgres_env((REPO_ROOT / "compose.yml").read_text()) == user_password_db
    for name in ("backend", "database", "e2e"):
        workflow = (REPO_ROOT / ".github" / "workflows" / f"{name}.yml").read_text()
        assert _postgres_env(workflow) == user_password_db, name
        if name != "e2e":
            assert f"DATABASE_URL: {default}\n" in workflow, name
    e2e_url = f"{default}_e2e"
    assert (
        f"E2E_DATABASE_URL: {e2e_url}\n"
        in (REPO_ROOT / ".github" / "workflows" / "e2e.yml").read_text()
    )
    assert f'"{e2e_url}"' in (REPO_ROOT / "frontend" / "e2e" / "env.ts").read_text()

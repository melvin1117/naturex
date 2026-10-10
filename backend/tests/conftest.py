"""Shared test setup.

DB tests run against a separate `<dbname>_test` database (created on demand, or set
TEST_DATABASE_URL), so `make test` never touches your dev data. They skip when Postgres
is down, unless REQUIRE_DB=true (CI), where they run and fail instead.
"""

from __future__ import annotations

import os

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError

from app.config import Settings, get_settings


def _test_database_url() -> str:
    explicit = os.environ.get("TEST_DATABASE_URL")
    if explicit:
        return explicit
    url = make_url(Settings().database_url)
    name = url.database or "naturex"
    if not name.endswith("_test"):
        url = url.set(database=f"{name}_test")
    return url.render_as_string(hide_password=False)


# Point the app (settings, engine, Alembic env) at the test database before any test imports it.
TEST_DATABASE_URL = _test_database_url()
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
# Cookies drop `Secure` only when ENVIRONMENT is explicitly development or test (fail closed).
os.environ.setdefault("ENVIRONMENT", "test")
get_settings.cache_clear()


def _can_connect(url: str) -> bool:
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except OperationalError:
        return False
    finally:
        engine.dispose()


def _ensure_test_database() -> bool:
    """Return True when the test database is reachable, creating it if the server allows."""
    if _can_connect(TEST_DATABASE_URL):
        return True
    url = make_url(TEST_DATABASE_URL)
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            name = str(url.database)
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": name}
            ).scalar()
            if not exists:
                quoted = name.replace('"', '""')
                conn.execute(text(f'CREATE DATABASE "{quoted}"'))
    except OperationalError:
        return False
    finally:
        admin.dispose()
    return _can_connect(TEST_DATABASE_URL)


requires_db = pytest.mark.skipif(
    not _ensure_test_database() and os.environ.get("REQUIRE_DB", "").lower() != "true",
    reason="Postgres not reachable (start with: docker compose up -d)",
)


def alembic_cfg() -> Config:
    """Alembic config pointed at the test database (`%` escaped for configparser)."""
    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url.replace("%", "%%"))
    return cfg

"""Shared fixtures. DB-backed tests skip when Postgres is unavailable."""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

from app.config import get_settings


def _database_available() -> bool:
    url = os.environ.get("DATABASE_URL", get_settings().database_url)
    engine = create_engine(url, pool_pre_ping=True)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except OperationalError:
        return False
    finally:
        engine.dispose()


# Skip DB tests locally when Postgres is down; with REQUIRE_DB=true (CI) they run and fail instead.
requires_db = pytest.mark.skipif(
    not _database_available() and os.environ.get("REQUIRE_DB", "").lower() != "true",
    reason="Postgres not reachable (start with: docker compose up -d)",
)

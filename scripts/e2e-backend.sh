#!/usr/bin/env bash
# T74: the API for the sandbox E2E, started by Playwright's webServer (frontend/playwright.config.ts).
# Recreates a dedicated database (never the dev `wildworth` one), migrates, seeds, then serves the
# API in the foreground. Every visitor's sandbox is started by the journey itself (no accounts).
# WILDWORTH_ENV_FILE=none makes the backend ignore every .env file (backend/app/config.py), so a
# developer's .env (real keys, USE_MOCKS=false, lower limits) can't leak in; the settings the
# journey depends on are also set explicitly below, and every other one keeps its default.
set -euo pipefail

: "${E2E_DATABASE_URL:?set by playwright.config.ts}"
: "${E2E_API_PORT:?set by playwright.config.ts}"
: "${E2E_WEB_ORIGIN:?set by playwright.config.ts}"

cd "$(dirname "$0")/../backend"

export WILDWORTH_ENV_FILE=none
export DATABASE_URL="$E2E_DATABASE_URL"
export ENVIRONMENT=test
export USE_MOCKS=true
export DEMO_MODE=true
export LOCAL_JOBS=true
export LIVE_WORLD_ON_STARTUP=true
export EARTH_ENGINE_LIVE=false
export VERIFICATION_AI_LIVE=false
export NEBIUS_API_KEY=""
export TAVILY_API_KEY=""
export EE_SERVICE_ACCOUNT_JSON=""
export ALLOWED_ORIGINS="$E2E_WEB_ORIGIN"
export TRUSTED_PROXY_HOPS=0
export LLM_BUDGET_USD=20
export LLM_RESERVE_USD=0
export RATING_RUNS_PER_WORLD_PER_HOUR=6
export RATING_RUNS_GLOBAL_PER_HOUR=60
export DOCUMENT_UPLOADS_PER_HOUR=20

uv run --frozen python - <<'PY'
import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

url = make_url(os.environ["DATABASE_URL"])
name = str(url.database)
if "e2e" not in name:
    raise SystemExit(f"refusing to recreate {name!r}: the E2E database name must contain 'e2e'")
if url.host not in ("localhost", "127.0.0.1") and os.environ.get("E2E_ALLOW_REMOTE_DB") != "1":
    raise SystemExit(
        f"refusing to recreate {name!r} on host {url.host!r}: the E2E database must be on "
        "localhost or 127.0.0.1 (set E2E_ALLOW_REMOTE_DB=1 to allow another host)"
    )
admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
with admin.connect() as conn:
    quoted = name.replace('"', '""')
    conn.execute(text(f'DROP DATABASE IF EXISTS "{quoted}" WITH (FORCE)'))
    conn.execute(text(f'CREATE DATABASE "{quoted}"'))
admin.dispose()
print(f"e2e: recreated database {name}")
PY

uv run --frozen alembic upgrade head
uv run --frozen python -m app.seed

exec uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port "$E2E_API_PORT" --log-level warning

#!/usr/bin/env bash
# T74: the API for the real-account E2E, started by Playwright's webServer (frontend/playwright.config.ts).
# Recreates a dedicated database (never the dev `naturex` one), migrates, seeds, creates the E2E
# admin with the supported CLI (password on stdin), then serves the API in the foreground.
# Every setting is explicit so a developer's .env (real keys, USE_MOCKS=false) can't leak in.
set -euo pipefail

: "${E2E_DATABASE_URL:?set by playwright.config.ts}"
: "${E2E_API_PORT:?set by playwright.config.ts}"
: "${E2E_WEB_ORIGIN:?set by playwright.config.ts}"
: "${E2E_ADMIN_EMAIL:?set by playwright.config.ts}"
: "${E2E_ADMIN_PASSWORD:?set by playwright.config.ts}"

cd "$(dirname "$0")/../backend"

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

uv run --frozen python - <<'PY'
import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

url = make_url(os.environ["DATABASE_URL"])
name = str(url.database)
if "e2e" not in name:
    raise SystemExit(f"refusing to recreate {name!r}: the E2E database name must contain 'e2e'")
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
printf '%s\n' "$E2E_ADMIN_PASSWORD" |
  uv run --frozen python -m app.cli create-admin \
    --email "$E2E_ADMIN_EMAIL" --name "E2E Admin" --password-stdin

exec uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port "$E2E_API_PORT" --log-level warning

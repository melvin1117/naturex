#!/usr/bin/env bash
# Run the whole app locally: Postgres (Docker), migrations, the API and the web app.
# Ctrl-C stops the API and the web app (Postgres keeps running; `docker compose down` stops it).
#
#   make dev            # uses the values in .env (USE_MOCKS=true there means mock agents and data)
#   make dev LIVE=1     # real services: USE_MOCKS=false and EARTH_ENGINE_LIVE=true (needs keys in .env)
#
# Override ports with API_PORT and WEB_PORT. Works with macOS's bash 3.2.
set -euo pipefail
set -m # each server gets its own process group, so cleanup stops its children too

root="$(cd "$(dirname "$0")/.." && pwd)"
api_port="${API_PORT:-8000}"
web_port="${WEB_PORT:-3000}"

export ENVIRONMENT="${ENVIRONMENT:-development}"
if [ "${LIVE:-0}" = "1" ]; then
  export USE_MOCKS=false
  export EARTH_ENGINE_LIVE=true
fi

for port in "$api_port" "$web_port"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop that process or set API_PORT / WEB_PORT." >&2
    exit 1
  fi
done

cd "$root"
echo "Starting Postgres..."
docker compose up -d --wait
echo "Applying migrations..."
make -s migrate

if [ ! -d frontend/node_modules ]; then
  (cd frontend && pnpm install --frozen-lockfile)
fi

prefix() { awk -v tag="$1" '{ print tag " " $0; fflush() }'; }

(cd backend && PYTHONUNBUFFERED=1 uv run uvicorn app.main:app --reload --port "$api_port" 2>&1 | prefix "[api]") &
api_pid=$!
(cd frontend && BACKEND_URL="http://localhost:$api_port" pnpm exec next dev --port "$web_port" 2>&1 | prefix "[web]") &
web_pid=$!

stop() {
  trap - INT TERM HUP EXIT
  echo "Stopping the API and the web app..."
  kill -TERM -- "-$api_pid" "-$web_pid" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap stop INT TERM HUP EXIT

echo "API  http://localhost:$api_port/healthz  (ENVIRONMENT=$ENVIRONMENT, USE_MOCKS=${USE_MOCKS:-from .env})"
echo "Web  http://localhost:$web_port  (Ctrl-C to stop both)"

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 1
done
echo "A server exited; stopping the other." >&2
exit 1

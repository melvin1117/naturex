#!/usr/bin/env bash
# Run the whole app locally: Postgres (Docker), migrations, the API and the web app.
# Ctrl-C stops the API and the web app (Postgres keeps running; `docker compose down` stops it).
#
#   make dev            # uses the values in .env (USE_MOCKS=true there means mock agents and data)
#   make dev LIVE=1     # real services: USE_MOCKS=false and EARTH_ENGINE_LIVE=true (needs keys in .env)
#   make preview        # the production build (`next build`, then `next start`): what visitors get
#
# The dev server compiles each page the first time it's opened, so a first visit can take a few
# seconds; it runs on Turbopack (`WEBPACK=1` for webpack) and opens the main pages itself once
# it's up (`WARM=0` to skip). The preview has every page built and prefetches links.
#
# Override ports with API_PORT and WEB_PORT. Works with macOS's bash 3.2.
set -euo pipefail
set -m # each server gets its own process group, so cleanup stops its children too

root="$(cd "$(dirname "$0")/.." && pwd)"
api_port="${API_PORT:-8000}"
web_port="${WEB_PORT:-3000}"

export ENVIRONMENT="${ENVIRONMENT:-development}"
# The API's CSRF check only accepts writes from the web app's own origin (default :3000).
if [ "$web_port" != "3000" ] && [ -z "${ALLOWED_ORIGINS:-}" ]; then
  export ALLOWED_ORIGINS="http://localhost:$web_port"
fi
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

# Run the servers' own binaries, not through `uv run` / `pnpm exec`: a wrapper forwards the stop
# signal on top of the one sent to the process group, and two SIGTERMs at once can deadlock
# uvicorn's reloader in its signal handler, leaving the port held. `make migrate` synced the venv.
preview="${PREVIEW:-0}"
reload="--reload"
next_flags=(dev --port "$web_port")
if [ "$preview" = "1" ]; then
  echo "Building the web app for production..."
  (cd frontend && BACKEND_URL="http://localhost:$api_port" node_modules/.bin/next build)
  reload=""
  next_flags=(start --port "$web_port")
elif [ "${WEBPACK:-0}" != "1" ]; then
  next_flags+=(--turbopack)
fi

(cd backend && PYTHONUNBUFFERED=1 .venv/bin/python -m uvicorn app.main:app $reload --port "$api_port" 2>&1 | prefix "[api]") &
api_pid=$!
(cd frontend && BACKEND_URL="http://localhost:$api_port" node_modules/.bin/next "${next_flags[@]}" 2>&1 | prefix "[web]") &
web_pid=$!

# The dev server compiles a page on its first request: open the main ones now, in the background,
# so the first click on each doesn't wait. Any ID compiles the site page.
warm() {
  local base="http://localhost:$web_port" waited=0
  until curl -s -o /dev/null "$base/robots.txt"; do
    sleep 1
    waited=$((waited + 1))
    [ "$waited" -lt 90 ] || return 0
  done
  for route in / /how /sandbox /sandbox/steward /sandbox/steward/list /sandbox/portfolio \
    /sandbox/asset/00000000-0000-4000-8000-000000000000 /sandbox/admin /sandbox/admin/verifications; do
    curl -s -o /dev/null "$base$route" || return 0
  done
  echo "[web] Main pages compiled: first visits are quick now."
}
warm_pid=""
if [ "$preview" != "1" ] && [ "${WARM:-1}" != "0" ]; then
  warm &
  warm_pid=$!
fi

running() { kill -0 -- "-$api_pid" 2>/dev/null || kill -0 -- "-$web_pid" 2>/dev/null; }

stop() {
  local status="${1:-0}"
  # Nothing may cut the cleanup short: not a failed echo after the terminal closed (set -e),
  # nor a second Ctrl-C during the wait (signals are ignored until the servers are gone).
  set +e
  trap '' INT TERM HUP
  trap - EXIT
  echo "Stopping the API and the web app..."
  [ -n "$warm_pid" ] && kill -TERM -- "-$warm_pid" 2>/dev/null
  kill -TERM -- "-$api_pid" 2>/dev/null || true
  kill -TERM -- "-$web_pid" 2>/dev/null || true
  local waited=0
  while running && [ "$waited" -lt 20 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done
  if running; then
    echo "A server didn't stop in 10 s; forcing it." >&2
    kill -KILL -- "-$api_pid" 2>/dev/null || true
    kill -KILL -- "-$web_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP
trap 'stop $?' EXIT

echo "API  http://localhost:$api_port/healthz  (ENVIRONMENT=$ENVIRONMENT, USE_MOCKS=${USE_MOCKS:-from .env})"
echo "Web  http://localhost:$web_port  (Ctrl-C to stop both)$([ "$preview" = "1" ] && echo "  · production build")"

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 1
done
echo "A server exited; stopping the other." >&2
exit 1

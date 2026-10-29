#!/usr/bin/env bash
# On the VM: deploy main (or one commit), then wait until the API and the web app are healthy; if
# they aren't, go back to the commit that ran before (docs/deploy.md). Run it after a merge to
# main (or from cron, to deploy automatically).
#
#   deploy/update.sh            # the latest main; does nothing if it's already running
#   deploy/update.sh <sha>      # that commit, pinned: later runs keep it until `deploy/update.sh --unpin`
#   deploy/update.sh --unpin    # follow main again
#   FORCE=1 deploy/update.sh    # rebuild and restart even if nothing changed
set -euo pipefail

main() {
  cd "$(dirname "$0")/.."
  if command -v flock >/dev/null; then
    exec 9>/tmp/wildworth-deploy.lock
    flock -n 9 || { echo "another deploy is running"; return 0; }
  fi
  local pin=deploy/.pinned failed=deploy/.failed
  local compose=(docker compose -f deploy/compose.yml)
  case "${1:-}" in
    "") ;;
    --unpin) rm -f "$pin" ;;
    *)
      [[ "$1" =~ ^[0-9a-f]{7,40}$ ]] || { echo "usage: $0 [<commit sha> | --unpin]" >&2; return 2; }
      echo "$1" >"$pin"
      ;;
  esac

  git fetch --quiet origin main
  local target current
  if [ -f "$pin" ]; then target=$(git rev-parse "$(cat "$pin")^{commit}"); else target=$(git rev-parse origin/main); fi
  current=$(git rev-parse HEAD)
  local running
  running=$("${compose[@]}" ps --status running --quiet backend 2>/dev/null || true)
  if [ "${FORCE:-0}" != 1 ] && [ -n "$running" ]; then
    [ "$target" = "$current" ] && return 0
    # A commit that failed its health check isn't retried until main moves on.
    [ -f "$failed" ] && [ "$(cat "$failed")" = "$target" ] && return 0
  fi

  echo "$(date -u +%FT%TZ) deploying ${target:0:12} (was ${current:0:12})"
  git checkout --quiet --detach "$target"
  if "${compose[@]}" up -d --build --remove-orphans && healthy "${compose[@]}"; then
    rm -f "$failed"
    docker image prune -f >/dev/null
    echo "$(date -u +%FT%TZ) deployed ${target:0:12}"
  else
    echo "$target" >"$failed"
    echo "$(date -u +%FT%TZ) ${target:0:12} isn't healthy; back to ${current:0:12}" >&2
    git checkout --quiet --detach "$current"
    "${compose[@]}" up -d --build --remove-orphans
    return 1
  fi
}

# Both services answer within 5 minutes (the API runs its migrations first).
healthy() {
  local _
  for _ in $(seq 1 60); do
    if "$@" exec -T backend python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz', timeout=4)" >/dev/null 2>&1 &&
      "$@" exec -T web node -e "fetch('http://localhost:3000/robots.txt').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# Read whole before running: the checkout above may replace this file.
main "$@"; exit $?

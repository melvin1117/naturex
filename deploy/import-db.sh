#!/usr/bin/env bash
# On the VM: load a dump from deploy/export-db.sh into the deployed database, replacing what's
# there, then start everything (docs/deploy.md). The API and the web app stop while it loads.
#
#   deploy/import-db.sh wildworth-YYYYMMDD-HHMM.dump
set -euo pipefail
cd "$(dirname "$0")/.."
dump=${1:?usage: deploy/import-db.sh <file.dump>}
compose=(docker compose -f deploy/compose.yml)

"${compose[@]}" up -d --wait db
"${compose[@]}" stop caddy web backend >/dev/null 2>&1 || true
"${compose[@]}" exec -T db pg_restore -U wildworth -d wildworth --clean --if-exists --no-owner \
  --single-transaction <"$dump"
"${compose[@]}" up -d
echo "Loaded $dump"

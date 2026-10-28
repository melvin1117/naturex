#!/usr/bin/env bash
# On a laptop: write the local database, minus every visitor sandbox, to a dump for a deployment
# (docs/deploy.md). It keeps the template and the live world: the showcase sites with their
# reports, trades and history, and the logged model calls. Needs the dev Postgres
# (`docker compose up -d`) and the backend venv.
#
#   deploy/export-db.sh [out.dump]
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-wildworth-$(date +%Y%m%d-%H%M).dump}"
db=(docker compose exec -T db)

# A scratch copy, so the local database itself keeps its sandboxes.
"${db[@]}" dropdb -U wildworth --if-exists wildworth_export
"${db[@]}" createdb -U wildworth wildworth_export
"${db[@]}" sh -c 'pg_dump -U wildworth -Fc wildworth | pg_restore -U wildworth -d wildworth_export --no-owner'
(cd backend && DATABASE_URL=postgresql+psycopg://wildworth:wildworth@localhost:5432/wildworth_export \
  uv run python -m app.cli prune-sandboxes)
"${db[@]}" pg_dump -U wildworth -Fc wildworth_export >"$out"
"${db[@]}" dropdb -U wildworth wildworth_export
echo "Wrote $out ($(du -h "$out" | cut -f1))"

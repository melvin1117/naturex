#!/usr/bin/env bash
# On the VM (cron, nightly): dump the deployed database to ~/backups (BACKUP_DIR), keeping the
# last 7 (docs/deploy.md). Restore one with deploy/import-db.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="${BACKUP_DIR:-$HOME/backups}"
mkdir -p "$dir" && chmod 700 "$dir"
file="$dir/wildworth-$(date -u +%Y%m%d-%H%M).dump"
docker compose -f deploy/compose.yml exec -T db pg_dump -U wildworth -Fc wildworth >"$file"
ls -1t "$dir"/wildworth-*.dump | tail -n +8 | xargs -r rm --
echo "Wrote $file"

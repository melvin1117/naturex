#!/usr/bin/env bash
# Generate the TypeScript API client from FastAPI's OpenAPI schema.
# Usage: from repo root → ./scripts/generate-client.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/frontend/src/lib/api"
OPENAPI_JSON="$OUT_DIR/openapi.json"

mkdir -p "$OUT_DIR"

echo "Exporting OpenAPI schema…"
(
  cd "$ROOT/backend"
  uv run python - <<'PY'
from pathlib import Path
import json
from app.main import app

out = Path("../frontend/src/lib/api/openapi.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(app.openapi(), indent=2) + "\n")
print(f"wrote {out}")
PY
)

echo "Generating TypeScript types…"
(
  cd "$ROOT/frontend"
  if [[ ! -d node_modules ]]; then
    corepack enable
    pnpm install --frozen-lockfile
  fi
  pnpm exec openapi-typescript "$OPENAPI_JSON" -o src/lib/api/schema.d.ts
)

echo "Client generated in frontend/src/lib/api/"

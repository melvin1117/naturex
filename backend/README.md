# NatureX backend

FastAPI service for ratings, market, ledger and agents.

## Setup

```bash
# from repo root
cp .env.example .env
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

Health check: `GET http://localhost:8000/healthz`

Postgres (local): `docker compose up -d` from the repo root.

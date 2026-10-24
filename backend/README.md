# WildWorth backend

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

Seed (template world, and the live world with the 3 curated sites; idempotent): `make migrate && make seed`.

Live-world admins are created only by an operator, with the password prompted for (never on the
command line): `make create-admin EMAIL=ops@example.org NAME="Ops"`, or
`uv run python -m app.cli create-admin --email ... --name ...` from `backend/` (ADR-0005 §1).

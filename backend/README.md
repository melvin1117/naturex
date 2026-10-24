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

## Live data (`app.jobs.seed_live`)

Fills the live world with real activity from `data/live_seed.json`, through the real API, so
every rating, report, verification, offer, trade, alert and Record entry is made by the product
itself, with live models and Earth Engine:

- **Communities:** four, each run by an owner and a steward.
- **Listings:** six new listings drawn on real land (one held at "needs evidence" by the
  confidence gate), plus the three curated sites.
- **Market and quarter:** supporters' trades, the news sweep and the quarter's re-rate with
  its payouts.

The people are fictional sandbox accounts. The verification documents are generated samples,
labelled as such: nothing here is a legal title.

```bash
# 1. a fresh database (the old one stays as it is)
docker compose exec -T db psql -U naturex -d postgres -c "CREATE DATABASE wildworth;"
export DATABASE_URL=postgresql+psycopg://naturex:naturex@localhost:5432/wildworth
uv run alembic upgrade head && uv run python -m app.seed

# 2. the API in live mode on that database (the raised caps are for this run only)
USE_MOCKS=false EARTH_ENGINE_LIVE=true RATING_RUNS_PER_WORLD_PER_HOUR=40 \
  LIVE_RATINGS_PER_USER_PER_DAY=10 ALLOWED_ORIGINS=http://localhost:3100 \
  uv run uvicorn app.main:app --port 8123

# 3. the seed, in another shell with the same DATABASE_URL (re-run any phase with --phase NAME)
USE_MOCKS=false EARTH_ENGINE_LIVE=true \
  uv run python -m app.jobs.seed_live --api http://localhost:8123 --origin http://localhost:3100
```

- **Accounts:** the seed creates them with the register and login endpoints' own functions, so
  14 accounts don't wait out the per-IP sign-up and login throttles. Every other step goes
  through HTTP.
- **Passwords:** generated once and kept in `../.env.seed-accounts.json`, which is git-ignored
  and never printed.
- **Caps:** the quarter's re-rate keeps its own hourly cap. If it stops at `rating_rate_limited`,
  re-run `--phase rerate` an hour later.
- **Cost:** well under $1 of Token Factory credit (about $0.30 for the run in this repo).
- **Deploying this data:** `pg_dump -Fc -d wildworth > wildworth.dump`, then `pg_restore` it into
  the hosted database.

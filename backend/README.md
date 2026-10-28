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

Postgres (local): `docker compose up -d` from the repo root. The database, user and password are
all `wildworth` (Compose project `wildworth`, volume `wildworth_pgdata`), as in `.env.example`.

Tests create their own `wildworth_test` database (and E2E `wildworth_e2e`) on demand.

Seed (template world, and the live world with the 3 curated sites; idempotent): `make migrate && make seed`.

Live-world admins are created only by an operator, with the password prompted for (never on the
command line): `make create-admin EMAIL=ops@example.org NAME="Ops"`, or
`uv run python -m app.cli create-admin --email ... --name ...` from `backend/` (ADR-0005 §1).

## Template showcase (`app.jobs.build_template_sites`)

Gives the template world, which every sandbox copies, a year of history on real places, from
`data/template_sites.json`: two fictional communities (Olympic Rainforest Keepers in Washington,
Florida Keys Mangrove Keepers), six listings drawn on OpenStreetMap boundaries (ODbL: park and
island outlines as mapped, river valleys as a buffer around the mapped river), and the
supporters, Arjun and Rosa trading them. Rosa owns the Keys community (Marisol and Darnell steward it).

- **Ratings:** each listing is rated when it's listed and then every quarter (up to five
  reports), each with Earth Engine observations for its own quarter (`ObservationWindow`),
  News Scout (Tavily, once per listing; each rating sees only what was published by its date)
  and the rating runner (Nemotron). Grades and prices move with the data.
- **Offers:** launched through the Reviewer's approval (`app.services.offers`), with a round
  number of units so one costs about $50 (old-growth forests are valued at hundreds of
  millions); one was sent back with a note and sent again, one waits in Reviews, one isn't
  sent yet.
- **Trades:** the market engine fills each order as `POST /orders` does (seeded, so a rebuild
  repeats them).
- **Dates:** each step runs now and its rows are then moved to the step's date, so the history
  reads as the year it describes (the ledger's hashes don't cover times).

```bash
make migrate && make seed   # the template with only the seed's content
cd backend && USE_MOCKS=false EARTH_ENGINE_LIVE=true EARTH_ENGINE_TIMEOUT_S=400 \
  uv run python -m app.jobs.build_template_sites ../brag-output/template-news.json
```

The optional path keeps News Scout's results, so a retried build spends no Tavily credits
again (about 6 per listing). The job refuses to run twice on the same template. To deploy it,
restore a dump of the whole database, as for the live world below.

## Live data (`app.jobs.seed_live`)

Fills the live world with activity from `data/live_seed.json`. Ratings, reports, alerts, trades
and Record entries are made by the product itself, with live models and Earth Engine:

- **Communities:** the three curated ones, handed from their seeded owner persona to a person,
  and one new community; each has an owner and a steward.
- **Listings:** new listings drawn on real land and rated live. The confidence gate may hold
  some back (e.g. at "needs evidence"); those stay unlisted.
- **Market and quarter:** supporters' trades, the news sweep and the quarter's re-rate with
  its payouts.

The people and communities are fictional sandbox accounts; the land is real. New listings open
**self-attested**, like the curated sites (the Exchange says "Self-attested by the community"):
the seed makes up no documents and fakes no review. Play money only.

```bash
# 1. a database for the live world, apart from your dev data (DB=wildworth seeds the default one)
DB=wildworth_live
docker compose exec -T db createdb -U wildworth "$DB"   # skip this line for DB=wildworth
export DATABASE_URL="postgresql+psycopg://wildworth:wildworth@localhost:5432/$DB"
uv run alembic upgrade head && uv run python -m app.seed

# 2. the API in live mode on that database (the raised caps are for this run only)
USE_MOCKS=false EARTH_ENGINE_LIVE=true RATING_RUNS_PER_WORLD_PER_HOUR=40 \
  LIVE_RATINGS_PER_USER_PER_DAY=10 ALLOWED_ORIGINS=http://localhost:3100 \
  uv run uvicorn app.main:app --port 8123

# 3. the seed, in another shell with the same DATABASE_URL (re-run any phase with --phase NAME)
USE_MOCKS=false EARTH_ENGINE_LIVE=true \
  uv run python -m app.jobs.seed_live --api http://localhost:8123 --origin http://localhost:3100

# 4. your admin account, from the repo root with the same DATABASE_URL (the seed creates none)
make create-admin EMAIL=you@example.org NAME="Your name"
```

- **Live only:** the seed refuses to run with `USE_MOCKS=true` or `EARTH_ENGINE_LIVE=false`,
  and stops if a rating comes back from mock metrics.
- **Operator steps:** accounts are created and signed in with the register and login
  endpoints' own functions (no per-IP throttles); handing over a curated community
  (`transfer_ownership`) and opening a listing without the verification gate
  (`launch(require_verification=False)`) run in-process. No route can do either. Everything
  else goes through HTTP.
- **Passwords:** generated once into `.env.seed-accounts.json` at the repo root (mode 0600,
  git-ignored, never printed). Finished trades and owner re-rates are kept in
  `.env.seed-state.json`, so a re-run doesn't repeat them (or spend more model credit).
- **Caps:** the quarter's re-rate keeps its own hourly cap. When a job stops early the seed
  exits 1 and names the phase: re-run it (`--phase rerate`) an hour later.
- **Deploying this data:** sign everyone out of the seeded database (`DB` from step 1), then
  dump it outside the repo and `pg_restore` it into the hosted database:

  ```bash
  docker compose exec -T db psql -U wildworth -d "$DB" \
    -c "DELETE FROM sessions; DELETE FROM auth_attempts;"
  (umask 077; docker compose exec -T db pg_dump -U wildworth -Fc "$DB" > ~/wildworth.dump)
  ```

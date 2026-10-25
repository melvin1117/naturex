# ADR-0002: Repository layout

## Status
Accepted

## Date
2026-10-04

## Context
Four owners need to work in parallel without colliding. The planned layout in [dev-spec.md](../specs/dev-spec.md) §4 and T04 (`compose.yml`, `backend/app/`, root `Makefile`) must be consistent so CI paths and generated clients stay stable.

## Decision
Use a **plain-folder monorepo** (no Turborepo/Nx):

```
wildworth/
├── LICENSE
├── README.md, AGENTS.md, CLAUDE.md, Makefile, compose.yml, .env.example
├── docs/          # specs, diagrams, adr/
├── backend/       # uv project; package root is app/
│   ├── app/       # FastAPI, models, routers, agents, tools, market, rag
│   ├── tests/
│   ├── migrations/# Alembic (from T07)
│   ├── data/      # demo sites, coefficients (no secrets / no raw ESVD)
│   ├── pyproject.toml
│   └── uv.lock
├── frontend/      # pnpm + Next.js App Router (T05)
├── jobs/          # Serverless Job entrypoints
├── evals/
├── scripts/
└── .github/workflows/
```

Conventions:
- **Compose file name:** `compose.yml` at repo root (Docker Compose v2 default).
- **API client:** generated into `frontend/src/lib/api/` from FastAPI OpenAPI; never hand-edited (T08).
- **Mocks:** `USE_MOCKS=true` behind interfaces so CI runs without keys.
- **Skills:** `.agents/skills/` is canonical; `.claude/skills/` mirrors via `scripts/sync-skills.sh`.

## Alternatives considered

### Turborepo / pnpm workspace monorepo
- Pros: shared scripts, caching
- Cons: overhead with one JS package and one Python package
- Rejected per research.md §2

### Backend as `src/wildworth` package layout
- Pros: default `uv init --package` layout
- Cons: diverges from dev-spec paths (`backend/app/...`) used everywhere in tasks
- Rejected: keep `backend/app` as the import root

## Consequences
- All task file paths in `tasks/todo.md` remain valid.
- Root `make lint` / `make test` operate on `backend/`; `make fe-check` lands with T05.

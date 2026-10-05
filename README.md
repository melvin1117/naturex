# 🌿 NatureX

**An AI rating agency and sandbox exchange for living nature.** NatureX uses NVIDIA Nemotron agents on Nebius Token Factory to rate land from satellite data and local news, turn it into a graded, investable (play-money) asset, and keep monitoring it, so keeping nature alive pays more than destroying it.

Built for the **Nebius × NVIDIA Global AI Hackathon**, *Best Apps & Agents* track.

> **Status:** foundations in progress: backend walking skeleton, market engine and frontend skeleton (route stubs).

### Quick start (backend)
```bash
cp .env.example .env    # add your keys, then: make check-keys
cd backend && uv sync
uv run uvicorn app.main:app --reload --port 8000
# GET http://localhost:8000/healthz

# from repo root
make lint && make test
docker compose up -d   # Postgres + pgvector (requires Docker)
```

### Quick start (frontend)
Needs Node 22 and Corepack (`corepack enable`), which installs the pinned pnpm.
```bash
cd frontend && pnpm install
pnpm dev               # http://localhost:3000 (/, /list, /asset/[id], /portfolio, /admin, /dev/ui)

# from repo root: lint (ESLint + Prettier), types, unit tests, build
make fe-check
```

## Documentation
| Doc | What's in it |
|---|---|
| [One-pager](./docs/one-pager.md) | The problem, the idea, and the pitch |
| [Diagrams](./docs/diagrams.html) | Interactive overview, rating engine, architecture, flows (download and open in a browser) |
| [PM spec](./docs/specs/pm-spec.md) | Scope, user stories, judging plan, timeline |
| [Dev spec](./docs/specs/dev-spec.md) | Architecture, data model, API, formulas, cost plan |
| [Demo plan](./docs/specs/demo-plan.md) | Judge tour and demo video |
| [Research](./docs/research.md) | Open-source tools reviewed and chosen |
| [AI setup](./docs/ai-setup.md) | Shared skills and MCP servers for AI coding assistants |
| [CI](./docs/ci.md) | GitHub Actions workflows, local check commands, required status checks |

Contributors using AI assistants: the shared rules are in [AGENTS.md](./AGENTS.md).

# AGENTS.md — NatureX

Instructions for every AI coding assistant on this repo (GitHub Copilot, Cursor, Codex and Claude Code, via `CLAUDE.md`). Keep this file short; put detail in skills or the docs below.

## Project
NatureX is an AI rating agency and sandbox exchange for living nature, built for the **Nebius × NVIDIA Global AI Hackathon** (Best Apps & Agents track, deadline Oct 30, 2026). A community lists land, Nemotron agents rate it from satellite data and news, investors trade play-money shares, and ratings update as nature heals or is damaged.

**Status:** planning. Application code isn't scaffolded yet; follow the planned layout in `docs/specs/dev-spec.md` §4 when creating it.

## Read before building
| Doc | Use it for |
|---|---|
| [pm-spec.md](./docs/specs/pm-spec.md) | Scope, user stories and acceptance criteria, weekly gates |
| [dev-spec.md](./docs/specs/dev-spec.md) | Architecture, data model, API, rating formulas, cost plan |
| [demo-plan.md](./docs/specs/demo-plan.md) | Judge tour, per-visitor sandbox, demo video |
| [research.md](./docs/research.md) | Chosen libraries and open decisions (§6) |
| [ai-setup.md](./docs/ai-setup.md) | Skills and MCP servers for your AI tool |
| [tasks/plan.md](./tasks/plan.md), [tasks/todo.md](./tasks/todo.md) | Team roles, weekly gates, the task you're working on |

If code and docs disagree, stop and ask; don't silently pick one.

## Non-negotiables
1. **AI calls use NVIDIA Nemotron via Nebius Token Factory only** (OpenAI-compatible `base_url`). Never Azure OpenAI or other hosted LLMs for product features; this is a hackathon requirement.
2. **Numbers come from deterministic, tested code.** LLMs orchestrate, classify, explain and may adjust the health score only within ±10 with cited evidence. Never let a model invent a metric, value or price.
3. **Every LLM output is schema-validated** (Pydantic) with retry; every call is logged (model, tokens, latency) and counts against `LLM_BUDGET_USD`.
4. **No secrets in the repo.** Use `.env` (git-ignored) and `.env.example`.
5. **Free tiers only** unless covered by hackathon credits; see `docs/specs/dev-spec.md` §21.
6. **Licences:** the repo is MIT. Don't add GPL/AGPL code or non-open data (e.g. raw ESVD data). No third-party logos or unlicensed music in demo assets. Keep data attributions (Dynamic World, Copernicus, JRC, Hansen, OpenStreetMap).
7. **Sandbox framing:** play money only; never present anything as a real security.

## Conventions
- **Python (backend):** 3.12, FastAPI, SQLModel, Pydantic v2; `uv`; `ruff` (lint + format); `mypy --strict`; `pytest`. Type-hint everything. Business logic stays in pure functions under `tools/`, `market/` and `ledger`, not in routers.
- **TypeScript (frontend):** Next.js App Router, `strict` mode, Tailwind, **shadcn/ui components only** (no ad-hoc styled clones), shared design tokens; follow `PRODUCT.md` once it exists (created by `impeccable`).
- **API contract first:** FastAPI's OpenAPI schema is the source of truth; the frontend client is **generated**, never hand-edited.
- **Tests with every change:** unit tests for formulas, market invariants and the ledger; contract tests for agent outputs.
- **Never push to `main`.** Branch, run `make ci` (with `docker compose up -d`), open a PR, get 1 teammate approval, squash-merge only when CI is green. GitHub doesn't enforce this on the private repo, so it's on us (`docs/ci.md`).
- **Small PRs** (~100–300 lines), one concern each, **Conventional Commit** titles (`feat:`, `fix:`, `docs:`…). Update the docs when behaviour changes.
- **Local development uses no cloud:** Docker Compose for Postgres; cloud hosting is chosen later (T20).
- **Mocks behind interfaces** (`USE_MOCKS=true`) so work can proceed in parallel and CI runs without keys.

## Skills (in `.agents/skills`, mirrored in `.claude/skills`)
Load the matching skill before starting; `using-agent-skills` picks one if unsure.
| Task | Skill |
|---|---|
| Clarify or refine a feature | `interview-me`, `idea-refine`, `spec-driven-development` |
| Break work into tasks | `planning-and-task-breakdown` |
| Implement | `incremental-implementation`, `test-driven-development`, `source-driven-development` |
| API or module boundaries | `api-and-interface-design` |
| Database schema, migrations, pgvector | `supabase-postgres-best-practices`, `supabase` |
| UI screens and design | `impeccable`, `frontend-ui-engineering` |
| UI review / Next.js performance | `web-design-guidelines`, `vercel-react-best-practices` |
| Debugging | `debugging-and-error-recovery`, `browser-testing-with-devtools` |
| Review before merge | `code-review-and-quality`, `security-and-hardening`, `code-simplification` |
| Decisions and docs | `documentation-and-adrs` (ADRs go in `docs/adr/`) |
| Git and CI | `git-workflow-and-versioning`, `ci-cd-and-automation` |

Update skills only with `scripts/sync-skills.sh`; never edit them in place.

## MCP servers
GitHub (issues, PRs, board), Context7 (current library docs; use it before writing framework code), shadcn (components), Playwright (E2E and demo recording), Chrome DevTools (debugging and performance). Setup is in `docs/ai-setup.md`.

## Definition of done
- [ ] Meets the story's acceptance criteria in `docs/specs/pm-spec.md`
- [ ] Lint, type-check and tests pass locally and in CI
- [ ] No secrets, no new paid services, licences respected
- [ ] Docs and generated API client updated if behaviour or contracts changed
- [ ] UI changes checked with `web-design-guidelines`; screenshots in the PR

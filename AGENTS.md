# AGENTS.md — WildWorth

Instructions for every AI coding assistant on this repo (GitHub Copilot, Cursor, Codex and Claude Code, via `CLAUDE.md`). Keep this file short; put detail in skills or the docs below.

## Project
WildWorth is the AI rating agency for living nature, with a sandbox exchange, built for the **Nebius × NVIDIA Global AI Hackathon** (Best Apps & Agents track, deadline Oct 30, 2026). A community lists land, Nemotron agents rate it from satellite data and news, investors trade play-money shares, and ratings update as nature heals or is damaged. The old working name, `naturex`, survives only where changing it would rewrite history: migrations before 0030, the price re-anchor seed (`market/engine.py`, past shocks must stay reproducible), the brand proposal in `docs/design/`, captured test fixtures, and data recorded before the rename. Leave those as they are.

**Status:** built and deployed at https://wildworth.westus2.cloudapp.azure.com (one Azure VM, `docs/deploy.md`); the layout follows `docs/specs/dev-spec.md` §4.

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
1. **All AI calls go through Nebius Token Factory** (OpenAI-compatible `base_url`); never Azure OpenAI or other providers. **Nemotron does all reasoning and text.** A non-NVIDIA Token Factory model is allowed only where no Nemotron model can do the job (today: photo perception, embeddings); see [ADR-0003](./docs/adr/0003-model-routing-on-token-factory.md). No local models.
2. **Numbers come from deterministic, tested code.** LLMs orchestrate, classify, explain and may adjust the health score only within ±10 with cited evidence. Never let a model invent a metric, value or price.
3. **Every LLM output is schema-validated** (Pydantic) with retry; every call is logged (model, tokens, latency) and counts against `LLM_BUDGET_USD`.
4. **No secrets in the repo.** Use `.env` (git-ignored) and `.env.example`.
5. **Free tiers only** unless covered by credits: hackathon credits, or personal credits the team approves for hosting (e.g. Azure in T20). Ranked hosting options in `docs/specs/dev-spec.md` §21.
6. **Licences:** the repo is MIT. Don't add GPL/AGPL code or non-open data (e.g. raw ESVD data). No third-party logos or unlicensed music in demo assets. Keep data attributions (Dynamic World, Copernicus, JRC, Hansen, OpenStreetMap).
7. **Sandbox framing:** play money only; never present anything as a real security.

## Conventions
- **Python (backend):** 3.12, FastAPI, SQLModel, Pydantic v2; `uv`; `ruff` (lint + format); `mypy --strict`; `pytest`. Type-hint everything. Business logic stays in pure functions under `tools/`, `market/` and `ledger`, not in routers.
- **TypeScript (frontend):** Next.js App Router, `strict` mode, Tailwind, **shadcn/ui components only** (no ad-hoc styled clones), shared design tokens; follow `PRODUCT.md` once it exists (created by `impeccable`).
- **API contract first:** FastAPI's OpenAPI schema is the source of truth; the frontend client is **generated**, never hand-edited.
- **Tests with every change:** unit tests for formulas, market invariants and the ledger; contract tests for agent outputs.
- **Never push to `main`.** Branch, run `make ci` (with `docker compose up -d`), get an independent agent review, open a PR, get 1 teammate approval, squash-merge only when CI is green. GitHub doesn't enforce this on the private repo, so it's on us (`docs/ci.md`).
- **Small PRs** (~100–300 lines), one concern each, **Conventional Commit** titles (`feat:`, `fix:`, `docs:`…). Update the docs when behaviour changes.
- **Local development uses no cloud:** Docker Compose for Postgres. The demo runs on one Azure VM ([ADR-0009](./docs/adr/0009-one-vm-on-azure.md), [docs/deploy.md](./docs/deploy.md)).
- **Mocks behind interfaces** (`USE_MOCKS=true`) so work can proceed in parallel and CI runs without keys.

## Picking a task
`tasks/task-map.html` (people) and `tasks/task-map.json` (agents) show what's done, picked, ready or blocked; the Project board mirrors the same status. The `task-map` workflow re-commits the map to `main` on every issue change, so pull `main` first. Commands need `gh auth login -s project`.
- Only pick a 🟢 **ready** task (every dependency closed). Never start a ⏳ **blocked** one.
- When asked "what should I pick?", answer from `suggestions[<role>]` in the JSON (critical path first), then show that task's `waiting_on`/`unlocks`.
- **Every task, in this order:**
  1. **Claim:** `make board ISSUE=<n> STATUS="In progress"` (sets the board Status and assigns you).
  2. **Branch and build:** `git checkout -b <type>/<tNN>-<slug>`, implement with tests, `make ci`.
  3. **Check the map:** the workflow updates it on `main` within a minute of step 1. **Never commit `tasks/task-map.*` in a PR**: it conflicts with the workflow's commits and blocks CI. (`make task-map` is only for a local look; discard the result.)
  4. **Independent review before the PR:** commit, `git fetch origin`, then have a **separate agent with fresh context** (a sub-agent or a new session, never the one that wrote the code) review **only the changes** (`git diff origin/main...HEAD`, reading surrounding code only where needed to judge a change) with the `code-review-and-quality` skill (plus `security-and-hardening` for auth, cookies, sessions, user input or text sent to an LLM). Fresh context means it gets only the standard prompt in `docs/ai-setup.md` (task, acceptance criteria, specs), not your explanation of the design. **Show the findings to the user and let them decide** which to fix and which to reject (with a reason). Don't apply, commit or push review fixes without the user's go-ahead; after fixing, re-run `make ci`. Repeat the review if the teammate's comments lead to large changes. Skip it only for trivial changes (typo, link or comment, no behaviour change) and Dependabot PRs.
  5. **PR:** use the PR template, Conventional Commit title, `Closes #<n>` in the body, a short summary of the review (findings fixed or rejected), then `make board ISSUE=<n> STATUS="In review"`.
  6. Merging closes the issue, which marks it done on the map and the board.

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
| Launch teaser video | `brag-slim` (not the 3-minute demo video) |
| Git and CI | `git-workflow-and-versioning`, `ci-cd-and-automation` |

Update skills only with `scripts/sync-skills.sh`; never edit them in place.

## MCP servers
GitHub (issues, PRs, board), Context7 (current library docs; use it before writing framework code), shadcn (components), Playwright (E2E and demo recording), Chrome DevTools (debugging and performance). Setup is in `docs/ai-setup.md`.

## Definition of done
- [ ] Meets the story's acceptance criteria in `docs/specs/pm-spec.md`
- [ ] Lint, type-check and tests pass locally and in CI
- [ ] Reviewed by a separate agent with `code-review-and-quality` before the PR; Critical and Required findings fixed or rejected with a reason
- [ ] No secrets, no new paid services, licences respected
- [ ] Docs and generated API client updated if behaviour or contracts changed
- [ ] UI changes checked with `web-design-guidelines`; screenshots in the PR

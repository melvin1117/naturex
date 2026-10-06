# CI

GitHub Actions quality gates for NatureX. No deployments. No production database access.

## Bootstrap order

1. Merge this CI config to `main` first (workflows + Dependabot + this doc).
2. Then land the application skeleton (`backend/`, `frontend/`, migrations).
3. Only after (2) is green, turn on branch-protection **required** checks listed below.

Until the app dirs exist, each component workflow runs a `*/ detect` job and **skips** lint/test/build/migrate (so `main` is not permanently red). `security / gitleaks` always runs.

## Workflows

| Workflow | Jobs | When |
|---|---|---|
| `backend` | detect · lint · test · build · api-client drift | every PR, push to `main`, manual |
| `frontend` | detect · lint · typecheck · test · build | every PR, push to `main`, manual |
| `database` | detect · migrate (upgrade / downgrade / upgrade + seed) | every PR, push to `main`, manual |
| `security` | gitleaks (always); dependency-review + CodeQL **public repos only** | every PR, push to `main`, manual |
| `task-map` | regenerate `tasks/task-map.{html,json}` from issues; commits to `main` only if changed (`[skip ci]`) | issue opened/closed/assigned/edited, push to `main` touching `tasks/todo.md`, daily, manual |
| AI / evals | **not yet** — deferred until T09 (LLM client) | — |

No path filters on triggers (every PR runs every workflow). Heavy jobs are gated on whether the component is present in the commit. Superseded runs are cancelled via `concurrency`.

## Team rule: every change goes through a PR

While the repo is private, GitHub **doesn't enforce** the `protect-main` ruleset (that needs a paid GitHub Team plan; it becomes enforced automatically if the repo goes public). So the team follows it by agreement:

1. **Never push to `main`.** Work on a branch (`feat/…`, `fix/…`, `docs/…`).
2. **Run `make ci` locally** and get it green before opening the PR (start Postgres first: `docker compose up -d`).
3. **Get an independent agent review** before opening the PR: a separate agent with fresh context runs the `code-review-and-quality` skill on the diff; fix or explain every Critical and Required finding (the *Independent review* step in [AGENTS.md](../AGENTS.md)). Skip it for trivial changes (typo, link or comment only, no behaviour change) and Dependabot PRs; the teammate review covers those.
4. **Open a PR** using the template, with `Closes #NN` for the task.
5. **Get 1 approval from a teammate.** Don't approve or merge your own PR. The agent review doesn't replace this.
6. **Merge only when GitHub CI is green**, using **Squash and merge**. Never click merge before the checks have finished.

## Local commands

```bash
# Everything CI checks, in one command (run before every PR)
docker compose up -d && make ci
# Backend (Python 3.12, uv)
cd backend && uv sync
make lint
make test                    # DB tests use a separate <db>_test database (created on demand); skip without Postgres
REQUIRE_DB=true make test    # fail if Postgres is down (CI behaviour)
docker compose up -d && make migrate && make seed

# Frontend (Node 22, pnpm via Corepack; see ADR-0001/0002)
cd frontend && corepack enable && pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
make fe-check                # all of the above

# OpenAPI client drift
./scripts/generate-client.sh
make check-client
```

`make eval` and `make e2e` are stubs until T47 / T46 — do not treat them as green CI.

## Runtime pins

| Runtime | Pin |
|---|---|
| Python | 3.12 (`backend/.python-version`) |
| Node | 22 LTS (CI); `engines.node >= 22` in `frontend/package.json` (Node 20 reached end-of-life in April 2026) |
| Postgres | `pgvector/pgvector:pg16` (service container / compose) |
| Package managers | `uv` + `backend/uv.lock`; `pnpm` + `frontend/pnpm-lock.yaml` (pin via `"packageManager": "pnpm@<version>"`) |

## Secrets

Current workflows need **no repository secrets**. Tests use `USE_MOCKS=true` and a disposable Postgres service.

Do not add Token Factory / Tavily keys to PR workflows. Live AI evals will be a separate manual workflow later (T47).

## GitHub plan / visibility limits

| Feature | Public repo | Private repo without Advanced Security |
| Branch rulesets (`protect-main`) | Enforced (free) | **Not enforced** on the free plan; see the team rule above |
|---|---|---|
| Actions (these workflows) | Free minutes (subject to quotas) | Free minutes (subject to quotas) |
| Dependabot alerts + PRs | Yes | Yes |
| Dependency review Action | Yes | Needs GitHub Advanced Security |
| CodeQL analysis | Yes | Needs GitHub Advanced Security |
| Secret scanning (GitHub native) | Yes (push protection optional) | Needs GitHub Advanced Security |

We run **gitleaks** ourselves so secret scanning works on private repos without GHAS. CodeQL and dependency-review are gated with `github.event.repository.visibility == 'public'`.

## Required status checks (branch protection on `main`)

Settings → Branches → Branch protection rule for `main`:

- Require a pull request before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging (recommended)

**While bootstrapping (before app code):** require only

1. `backend / detect`
2. `frontend / detect`
3. `database / detect`
4. `security / gitleaks`

**After the skeleton is on `main`:** require

1. `backend / detect`
2. `backend / lint`
3. `backend / test`
4. `backend / build`
5. `backend / api-client drift`
6. `frontend / detect`
7. `frontend / lint`
8. `frontend / typecheck`
9. `frontend / test`
10. `frontend / build`
11. `database / detect`
12. `database / migrate` (includes `alembic check`: models must match migrations)
13. `security / gitleaks`

Do **not** require `security / dependency-review` or `security / codeql` unless the repo is public (or GHAS is enabled); otherwise they are skipped and would block merges if marked required.

## What CI cannot prove locally

- Full GitHub Actions runner behaviour (action SHAs, service containers networking)
- CodeQL / dependency-review on a public repo
- Branch protection enforcement

After the first push of these workflows, open a PR and confirm all required jobs go green.

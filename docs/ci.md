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
| `e2e` | real accounts (T74): Playwright drives both apps on the real stack, `USE_MOCKS=true`; uploads the report and traces on failure | PRs (not drafts) and pushes to `main` touching `frontend/`, `backend/` or the E2E harness, manual |
| `task-map` | regenerate `tasks/task-map.{html,json}` from issues; commits to `main` only if changed (`[skip ci]`) | issue opened/closed/assigned/edited, push to `main` touching `tasks/todo.md`, daily, manual |
| AI / evals | **not yet** — deferred until T09 (LLM client) | — |

No path filters on triggers (every PR runs every workflow), except `e2e`: it only runs on PRs (once ready for review) and pushes to `main` that touch `frontend/`, `backend/`, `scripts/e2e-backend.sh` or its workflow, to save Actions minutes; the push to `main` catches a break that two separately green PRs make together. Heavy jobs are gated on whether the component is present in the commit. Superseded runs are cancelled via `concurrency`.

## Team rule: every change goes through a PR

While the repo is private, GitHub **doesn't enforce** the `protect-main` ruleset (that needs a paid GitHub Team plan; it becomes enforced automatically if the repo goes public). So the team follows it by agreement:

1. **Never push to `main`.** Work on a branch (`feat/…`, `fix/…`, `docs/…`).
2. **Run `make ci` locally** and get it green before opening the PR (start Postgres first: `docker compose up -d`).
3. **Get an independent agent review** before opening the PR: a separate agent with fresh context runs the `code-review-and-quality` skill on the diff only (not the whole codebase); you decide which findings to fix or reject (with a reason) before anything is committed (the *Independent review* step in [AGENTS.md](../AGENTS.md)). Skip it for trivial changes (typo, link or comment only, no behaviour change) and Dependabot PRs; the teammate review covers those.
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

# Real-account E2E (T74): needs Postgres (docker compose up -d), uv and Node 22
make e2e
```

`make eval` is a stub until T47 — do not treat it as green CI.

### Real-account E2E (`make e2e`, T74)

One Playwright journey through both apps on the real stack (`frontend/e2e/real-accounts.spec.ts`): an owner registers, creates a community, draws a polygon by clicking the real map, lists it and waits for the rating, uploads documents; an admin approves them in the review queue; the owner launches the IPO; an anonymous visitor browses but can't trade; a second account registers, buys and sells; the portfolio and the community home reflect it; everyone signs out. It also checks that the investor is refused (403) on Steward and admin actions.

- **Isolated and idempotent.** `frontend/playwright.config.ts` starts both servers through Playwright's `webServer` and stops them afterwards: the API on port 8100 via `scripts/e2e-backend.sh`, which drops and recreates the `naturex_e2e` database (never `naturex`: the name must contain `e2e`, and the host must be `localhost` or `127.0.0.1` unless you set `E2E_ALLOW_REMOTE_DB=1`), migrates, seeds and creates the E2E admin; and a production build of the frontend in `.next-e2e` (so your `.next` is untouched) on port 3100. Accounts and names are unique per run. Override with `E2E_API_PORT`, `E2E_WEB_PORT` and `E2E_DATABASE_URL`; `E2E_SKIP_BUILD=1` (exactly `1`) reuses the last build while iterating on the spec (only with the same `E2E_API_PORT`, which the build bakes into the `/api` proxy).
- **No keys, no `.env`.** The script sets `NATUREX_ENV_FILE=none`, which makes the backend's settings skip every `.env` file (`backend/app/config.py`), so a developer's `.env` (real keys, `USE_MOCKS=false`, lower limits) can't leak in; every setting is then its default unless the script sets it. It also sets the ones the journey depends on explicitly (`USE_MOCKS=true`, `ENVIRONMENT=test`, live Earth Engine and the AI document check off, empty API keys, the LLM budget and the rating-run and upload limits), so a variable exported in your shell doesn't change them either. The browser refuses every request that leaves the machine (map tiles). Mock listing metrics stay fresh until about 2026-12-30 (dev-spec §6.2); after that the listing lands in `needs_evidence` and the journey fails until the mock's `data_version` moves.
- **The admin.** There's no admin sign-up: the script runs the operator CLI, `python -m app.cli create-admin --password-stdin` (piped input only; it refuses a terminal), with a test-only password, in the throwaway database. That password is typed into the login form, so it appears in Playwright traces and reports: never reuse it, or a real one, anywhere else.
- **Auth rate limits.** Every browser reaches the API through the Next.js `/api` proxy on `127.0.0.1` (and `TRUSTED_PROXY_HOPS=0`), so all the journey's accounts share one per-IP bucket: 5 registrations an hour and 10 sign-ins per 15 minutes (`backend/app/auth.py`). The database is recreated every run, which resets them; a spec that adds more registrations or sign-ins than that in one run gets `429`.
- **Debugging.** The HTML report is in `frontend/playwright-report` (`pnpm exec playwright show-report`); a failure keeps a trace and screenshots in `frontend/test-results`. In CI both are uploaded as the `e2e-playwright-report` artifact, and the Chromium headless shell is cached per Playwright version.

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

**Dependabot** (`.github/dependabot.yml`) opens at most one grouped PR per ecosystem (Actions, backend, frontend) each month, with minor and patch updates only. Major upgrades, and minor bumps of the pinned `next` and `eslint-config-next`, are done by hand as planned work. Security updates still arrive as soon as an advisory is published.

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

Do **not** require `security / dependency-review` or `security / codeql` unless the repo is public (or GHAS is enabled); otherwise they are skipped and would block merges if marked required. Don't require `e2e / real accounts` either: it's path-filtered, so a PR that doesn't touch the apps never reports it and would wait forever.

## What CI cannot prove locally

- Full GitHub Actions runner behaviour (action SHAs, service containers networking)
- CodeQL / dependency-review on a public repo
- Branch protection enforcement

After the first push of these workflows, open a PR and confirm all required jobs go green.

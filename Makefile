.PHONY: ci lint test migrate seed fe-check check-client eval e2e task-map task-map-latest board rerate-all news-sweep

# Run before every PR: the same checks GitHub CI runs. Start Postgres first: docker compose up -d
ci:
	$(MAKE) lint
	cd backend && REQUIRE_DB=true uv run pytest -q
	$(MAKE) fe-check
	@if command -v actionlint >/dev/null; then actionlint; else echo "actionlint not installed (brew install actionlint): workflow check skipped"; fi
	python3 scripts/task_map.py --check
	@if command -v gitleaks >/dev/null; then gitleaks detect --source . --redact; else echo "gitleaks not installed (brew install gitleaks): secret scan skipped"; fi

lint:
	cd backend && uv run ruff check app tests migrations
	cd backend && uv run ruff format --check app tests migrations
	cd backend && uv run mypy app

test:
	cd backend && uv run pytest -q

migrate:
	cd backend && uv run alembic upgrade head

# Run the app locally (Postgres, migrations, API on :8000, web on :3000); Ctrl-C stops both.
# LIVE=1 uses real services (USE_MOCKS=false, EARTH_ENGINE_LIVE=true). Ports: API_PORT, WEB_PORT.
.PHONY: dev
dev:
	LIVE=$(or $(LIVE),$(live)) ./scripts/dev.sh

# T01: check your .env keys work (Token Factory, Tavily, Earth Engine); spends no credits
.PHONY: check-keys
check-keys:
	cd backend && uv run python -m app.check_keys

seed:
	cd backend && uv run python -m app.seed

# T75 monitoring jobs (idempotent, budget-capped); ARGS e.g. ARGS="--period 2026Q4 --max-usd 1"
rerate-all:
	cd backend && uv run python -m app.jobs.rerate_all $(ARGS)

news-sweep:
	cd backend && uv run python -m app.jobs.news_sweep $(ARGS)

# Frontend lint (ESLint + Prettier), types, unit tests and build. Needs Node 22 + Corepack.
fe-check:
	cd frontend && pnpm install --frozen-lockfile
	cd frontend && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build

check-client:
	./scripts/generate-client.sh
	cd frontend && git diff --exit-code -- src/lib/api/openapi.json src/lib/api/schema.d.ts

eval:
	@echo "eval: harness lands in T47; to run the News Scout eval now, see evals/README.md" >&2; exit 1

# T74 real-account E2E: Playwright starts the API and a production frontend build on their own
# ports (8100, 3100) with a freshly recreated naturex_e2e database, then stops them. Start
# Postgres first: docker compose up -d. Override with E2E_API_PORT, E2E_WEB_PORT,
# E2E_DATABASE_URL; E2E_SKIP_BUILD=1 reuses the last build. Report: frontend/playwright-report.
e2e:
	cd frontend && pnpm install --frozen-lockfile
	cd frontend && pnpm exec playwright install chromium
	cd frontend && pnpm exec playwright test

# Download the published task map (branch task-map, kept current by the task-map workflow)
# into tasks/task-map.html and .json (git-ignored); see ADR-0007. TASK_MAP_REMOTE is a remote name.
TASK_MAP_REMOTE ?= origin
task-map-latest:
	@git fetch --quiet $(TASK_MAP_REMOTE) +refs/heads/task-map:refs/remotes/$(TASK_MAP_REMOTE)/task-map || { echo "No task-map branch on $(TASK_MAP_REMOTE) yet: run the task-map workflow (Actions > task-map > Run workflow)." >&2; exit 1; }
	bash -o pipefail -c 'git archive refs/remotes/$(TASK_MAP_REMOTE)/task-map task-map.html task-map.json | tar -x -C tasks'
	@python3 -c "import json; d = json.load(open('tasks/task-map.json')); c = d['counts']; print(f\"Task map {d['generated_at']}: {c['done']} done, {c['in_progress']} in progress, {c['ready']} ready, {c['blocked']} blocked. Open tasks/task-map.html or read tasks/task-map.json.\")"

# Regenerate the task map locally from GitHub issues into tasks/ (git-ignored; needs `gh auth login`)
task-map:
	python3 scripts/task_map.py

# Set a task's board Status, e.g. make board ISSUE=27 STATUS="In progress" (needs gh auth login -s project)
board:
	scripts/board_status.sh "$(ISSUE)" "$(STATUS)"

# T54: create a live-world admin (prompts for the password; never pass it on the command line)
# e.g. make create-admin EMAIL=ops@example.org NAME="Ops"
.PHONY: create-admin
create-admin:
	cd backend && uv run python -m app.cli create-admin --email "$(EMAIL)" --name "$(NAME)"

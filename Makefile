.PHONY: ci lint test migrate seed fe-check check-client eval e2e task-map board

# Run before every PR: the same checks GitHub CI runs. Start Postgres first: docker compose up -d
ci:
	$(MAKE) lint
	cd backend && REQUIRE_DB=true uv run pytest -q
	$(MAKE) fe-check
	@if command -v actionlint >/dev/null; then actionlint; else echo "actionlint not installed (brew install actionlint): workflow check skipped"; fi
	@if command -v gitleaks >/dev/null; then gitleaks detect --source . --redact; else echo "gitleaks not installed (brew install gitleaks): secret scan skipped"; fi

lint:
	cd backend && uv run ruff check app tests migrations
	cd backend && uv run ruff format --check app tests migrations
	cd backend && uv run mypy app

test:
	cd backend && uv run pytest -q

migrate:
	cd backend && uv run alembic upgrade head

# T01: check your .env keys work (Token Factory, Tavily, Earth Engine); spends no credits
.PHONY: check-keys
check-keys:
	cd backend && uv run python -m app.check_keys

seed:
	cd backend && uv run python -m app.seed

# Frontend lint (ESLint + Prettier), types, unit tests and build. Needs Node 22 + Corepack.
fe-check:
	cd frontend && pnpm install --frozen-lockfile
	cd frontend && pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run build

check-client:
	./scripts/generate-client.sh
	cd frontend && git diff --exit-code -- src/lib/api/openapi.json src/lib/api/schema.d.ts

eval:
	@echo "eval: harness lands in T47; to run the News Scout eval now, see evals/README.md" >&2; exit 1

e2e:
	@echo "e2e: Playwright suite lands in T46" >&2; exit 1

# Refresh tasks/task-map.html and .json from GitHub issues (needs `gh auth login`)
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

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

seed:
	cd backend && uv run python -m app.seed

fe-check:
	@echo "fe-check: frontend scaffold lands in T05"

eval:
	@echo "eval: harness lands in T47"

check-client:
	@echo "check-client: OpenAPI client drift check lands in T08"

e2e:
	@echo "e2e: Playwright suite lands in T46"

# Refresh tasks/task-map.html and .json from GitHub issues (needs `gh auth login`)
task-map:
	python3 scripts/task_map.py

# Set a task's board Status, e.g. make board ISSUE=27 STATUS="In progress" (needs gh auth login -s project)
board:
	scripts/board_status.sh "$(ISSUE)" "$(STATUS)"

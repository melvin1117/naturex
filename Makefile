.PHONY: lint test migrate seed fe-check check-client eval e2e

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

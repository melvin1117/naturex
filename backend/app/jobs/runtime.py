"""What both monitoring jobs need to run outside the API: settings, sessions, an inline rating
runner, News Scout and the LLM spend, plus their shared command line."""

from __future__ import annotations

import argparse
import logging
from collections.abc import Callable, Sequence
from concurrent.futures import Executor, Future
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlmodel import Session

from app.config import Settings, get_settings, validate_mock_settings
from app.db import engine
from app.llm import DbCallLog, get_llm_client
from app.services.monitoring import JobReport, NewsFn, SessionFactory
from app.services.rating_runs import RatingRunner, build_runner, news_runner
from app.worlds import LIVE_WORLD_ID


class InlineExecutor(Executor):
    """Runs each rating run in the calling thread, so a job waits for every run it starts."""

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:
            future.set_exception(exc)
        return future


def session_factory() -> Session:
    return Session(engine)


def job_settings() -> Settings:
    settings = get_settings()
    validate_mock_settings(settings)
    return settings


def inline_runner(settings: Settings, sessions: SessionFactory = session_factory) -> RatingRunner:
    return build_runner(settings, sessions, InlineExecutor())


def production_news(settings: Settings, sessions: SessionFactory = session_factory) -> NewsFn:
    """News Scout as rating runs call it: the fixture with USE_MOCKS, else Token Factory."""
    run = news_runner(settings)
    llm = None if settings.use_mocks else get_llm_client(settings, sessions)
    return lambda asset: run(asset, llm)


def spend(sessions: SessionFactory = session_factory) -> Callable[[], Decimal]:
    log = DbCallLog(sessions)
    return log.spent_usd


def parse_args(
    description: str, default_period: Callable[[datetime], str], argv: Sequence[str] | None
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--world", type=UUID, default=LIVE_WORLD_ID, help="world ID (default: the live world)"
    )
    parser.add_argument(
        "--period",
        default=default_period(datetime.now(UTC)),
        help="idempotency period (default: the current one)",
    )
    parser.add_argument(
        "--max-usd",
        type=Decimal,
        default=None,
        help="this run's LLM cap (default: MONITOR_JOB_BUDGET_USD)",
    )
    return parser.parse_args(argv)


def report_and_exit_code(report: JobReport) -> int:
    """Log the summary; 1 when an asset failed (the next run retries it), else 0."""
    logging.getLogger("app.jobs").info("%s", report.summary())
    print(report.summary())
    for asset_id, reason in report.failed:
        print(f"  failed {asset_id}: {reason}")
    return 1 if report.failed else 0

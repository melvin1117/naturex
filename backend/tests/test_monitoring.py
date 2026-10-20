"""T75 monitoring jobs: idempotent, budget-capped `rerate_all` and `news_sweep`.

Rating runs use the real `RatingRunner` in mock mode (fixed pipeline, no model) on one rolled-back
connection; News Scout is a stand-in function.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from sqlalchemy import Connection, create_engine, update
from sqlmodel import Session, col, func, select

from app.agents.news_scout import NewsScoutAsset
from app.config import get_settings
from app.jobs import news_sweep as news_sweep_cli
from app.jobs.runtime import InlineExecutor
from app.market.revenue import PayoutAlreadyApplied, pay_quarter
from app.models import (
    Alert,
    AlertRecipient,
    Asset,
    Event,
    Holding,
    LedgerEntry,
    LedgerKind,
    MonitorRun,
    Report,
    User,
)
from app.sandbox import create_world
from app.schemas import NewsScoutItem, NewsScoutOutput
from app.seed import seed
from app.services import monitoring
from app.services.monitoring import (
    NEWS_SWEEP,
    PAYOUT,
    RERATE,
    Budget,
    budget_stop,
    claim,
    day_label,
    finish,
    parse_day_period,
    parse_job_cap,
    parse_quarter_period,
    quarter_label,
)
from app.services.rating_runs import RatingRunner, news_runner
from tests.conftest import alembic_cfg, requires_db
from tests.test_llm import settings

PERIOD = "2026Q4"
TODAY = "2026-10-19"
NO_SPEND: Callable[[], Decimal] = lambda: Decimal(0)  # noqa: E731


# --- pure ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "label"),
    [(date(2026, 1, 1), "2026Q1"), (date(2026, 3, 31), "2026Q1"), (date(2026, 10, 19), "2026Q4")],
)
def test_quarter_labels(day: date, label: str) -> None:
    assert quarter_label(day) == label
    assert day_label(day) == day.isoformat()


@pytest.mark.parametrize(
    ("spent", "at_start", "expected"),
    [
        ("0", "0", None),
        ("19.50", "19.00", None),  # 19.50 + 0.50 = 20: exactly at the global cap
        ("19.51", "19.00", "llm_budget_exhausted"),
        ("11.50", "10.00", None),  # this job spent 1.50 + 0.50 = 2: exactly at its cap
        ("11.51", "10.00", "job_budget_exhausted"),
    ],
)
def test_the_budget_stops_before_an_asset_could_pass_a_cap(
    spent: str, at_start: str, expected: str | None
) -> None:
    budget = Budget(Decimal(20), Decimal(2), Decimal("0.50"))
    assert (
        budget_stop(budget, spent_total=Decimal(spent), spent_at_start=Decimal(at_start))
        == expected
    )


@pytest.mark.parametrize("value", ["2026Q4", "2026Q1", "2025Q3"])
def test_valid_quarter_periods(value: str) -> None:
    assert parse_quarter_period(value, date(2026, 10, 19)) == value


@pytest.mark.parametrize(
    "value", ["2026-Q4", "2026q4", "2026Q5", "2026Q0", " 2026Q4", "2026Q4 ", "2027Q1", "x"]
)
def test_malformed_or_future_quarter_periods_are_refused(value: str) -> None:
    with pytest.raises(ValueError):
        parse_quarter_period(value, date(2026, 10, 19))


@pytest.mark.parametrize("value", ["2026-10-19", "2026-01-01"])
def test_valid_day_periods(value: str) -> None:
    assert parse_day_period(value, date(2026, 10, 19)) == value


@pytest.mark.parametrize(
    "value", ["2026-10-20", "2026-02-30", "20261019", "2026-10-19T00:00", "2026-1-9", ""]
)
def test_malformed_or_future_day_periods_are_refused(value: str) -> None:
    with pytest.raises(ValueError):
        parse_day_period(value, date(2026, 10, 19))


@pytest.mark.parametrize("value", ["-1", "-0.01", "NaN", "sNaN", "Infinity", "-inf", "abc", ""])
def test_job_caps_must_be_finite_and_not_negative(value: str) -> None:
    with pytest.raises(ValueError):
        parse_job_cap(value)


def test_job_caps() -> None:
    assert parse_job_cap("0") == Decimal(0)
    assert parse_job_cap("1.5") == Decimal("1.5")


@pytest.mark.parametrize(
    ("module", "args"),
    [
        ("rerate_all", ["--period", "2026-Q4"]),
        ("rerate_all", ["--period", "2999Q1"]),
        ("rerate_all", ["--max-usd", "NaN"]),
        ("news_sweep", ["--period", "2999-01-01"]),
        ("news_sweep", ["--max-usd", "-1"]),
    ],
)
def test_the_clis_refuse_bad_periods_and_caps_before_any_work(
    module: str, args: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    import importlib

    cli = importlib.import_module(f"app.jobs.{module}")
    monkeypatch.setattr(cli, "job_settings", lambda: pytest.fail("parsed past bad arguments"))
    with pytest.raises(SystemExit) as exit_:
        cli.main(args)
    assert exit_.value.code == 2


# --- DB fixtures --------------------------------------------------------------------------------


def sessions(conn: Connection) -> Callable[[], Session]:
    return lambda: Session(bind=conn, join_transaction_mode="create_savepoint")


@pytest.fixture
def db() -> Iterator[Connection]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        with sessions(conn)() as setup:
            seed(setup)
        yield conn
        outer.rollback()
    engine.dispose()


@pytest.fixture
def world_id(db: Connection) -> UUID:
    with sessions(db)() as session:
        return create_world(session).id


def listed(db: Connection, world_id: UUID) -> list[Asset]:
    with sessions(db)() as session:
        return monitoring.listed_assets(session, world_id)


def count(db: Connection, model: Any, world_id: UUID, *where: Any) -> int:
    with sessions(db)() as session:
        return session.exec(
            select(func.count()).select_from(model).where(model.world_id == world_id, *where)
        ).one()


class ScenarioRunner:
    """T27's runner in mock mode, inline; every run uses `scenario` (a Time Machine quarter
    that moves the grade), so a re-rate has something to alert on."""

    def __init__(self, conn: Connection, scenario: str = "encroachment", **cfg_: Any) -> None:
        cfg = settings(use_mocks=True, **cfg_)
        self.inner = RatingRunner(
            session_factory=sessions(conn),
            settings=cfg,
            executor=InlineExecutor(),
            llm_factory=lambda wrap: None,
            news=news_runner(cfg),
            today=lambda: date(2026, 10, 7),
        )
        self.scenario = scenario
        self.started: list[UUID] = []

    def start(self, world_id: UUID, asset_id: UUID, **kwargs: Any) -> UUID:
        self.started.append(asset_id)
        return self.inner.start(world_id, asset_id, scenario=self.scenario, **kwargs)  # type: ignore[arg-type]


def rerate(db: Connection, world_id: UUID, runner: Any, **overrides: Any) -> monitoring.JobReport:
    kwargs: dict[str, Any] = {
        "world_id": world_id,
        "period": PERIOD,
        "spend": NO_SPEND,
        "llm_budget_usd": Decimal(20),
        "job_cap_usd": Decimal(2),
        **overrides,
    }
    return monitoring.rerate_all(sessions(db), runner, **kwargs)


# --- claims -------------------------------------------------------------------------------------


@requires_db
def test_a_claim_is_won_once_and_retried_only_after_a_failure(
    db: Connection, world_id: UUID
) -> None:
    asset = listed(db, world_id)[0].id
    with sessions(db)() as s:
        assert claim(s, RERATE, PERIOD, world_id, asset)
        assert not claim(s, RERATE, PERIOD, world_id, asset)  # running elsewhere
        assert claim(s, NEWS_SWEEP, PERIOD, world_id, asset)  # another job
        assert claim(s, RERATE, "2027Q1", world_id, asset)  # another period
        finish(s, RERATE, PERIOD, asset, "failed", "rating_busy")
        assert claim(s, RERATE, PERIOD, world_id, asset)  # a failure is retried
        finish(s, RERATE, PERIOD, asset, "done")
        assert not claim(s, RERATE, PERIOD, world_id, asset)  # done is never redone
        finish(s, NEWS_SWEEP, PERIOD, asset, "skipped", "asset_is_draft")
        assert not claim(s, NEWS_SWEEP, PERIOD, world_id, asset)


@requires_db
def test_a_stale_running_claim_is_taken_over(db: Connection, world_id: UUID) -> None:
    asset = listed(db, world_id)[0].id
    with sessions(db)() as s:
        assert claim(s, RERATE, PERIOD, world_id, asset)
        s.execute(
            update(MonitorRun)
            .where(col(MonitorRun.asset_id) == asset)
            .values(updated_at=func.now() - monitoring.CLAIM_STALE_AFTER * 2)
        )
        s.commit()
        assert claim(s, RERATE, PERIOD, world_id, asset)


# --- rerate_all ---------------------------------------------------------------------------------


@requires_db
def test_rerate_all_rerates_alerts_holders_and_owner_and_pays_once(
    db: Connection, world_id: UUID
) -> None:
    assets = listed(db, world_id)
    with sessions(db)() as session:
        arjun = session.exec(
            select(User).where(User.world_id == world_id, User.persona_key == "arjun")
        ).one()
        rosa = session.exec(
            select(User).where(User.world_id == world_id, User.persona_key == "rosa")
        ).one()
        arjun_id, rosa_id = arjun.id, rosa.id
        session.add(Holding(world_id=world_id, user_id=arjun_id, asset_id=assets[0].id, shares=5))
        session.commit()
    reports_before = count(db, Report, world_id)
    runner = ScenarioRunner(db)

    report = rerate(db, world_id, runner)

    assert report.failed == [] and report.stopped is None
    assert sorted(report.done) == sorted(a.id for a in assets) == sorted(runner.started)
    assert count(db, Report, world_id) == reports_before + len(assets)
    assert report.alerts == len(assets) > 0
    assert report.payouts == len(assets)
    with sessions(db)() as session:
        alert = session.exec(
            select(Alert).where(Alert.world_id == world_id, Alert.asset_id == assets[0].id)
        ).one()
        assert alert.kind in {"grade_change", "health_change"} and alert.report_id is not None
        delivered = {
            r.user_id
            for r in session.exec(
                select(AlertRecipient).where(AlertRecipient.alert_id == alert.id)
            ).all()
        }
        assert delivered == {arjun_id, rosa_id}
    payouts = count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT)

    again = rerate(db, world_id, runner)

    assert again.done == [] and len(again.skipped) == len(assets)
    assert len(runner.started) == len(assets)  # nothing re-run
    assert count(db, Report, world_id) == reports_before + len(assets)
    assert count(db, Alert, world_id) == len(assets)
    assert count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT) == payouts


@requires_db
def test_rerate_all_stays_in_its_world(db: Connection, world_id: UUID) -> None:
    with sessions(db)() as session:
        other = create_world(session).id
    before = (count(db, Report, other), count(db, Alert, other))

    rerate(db, world_id, ScenarioRunner(db))

    assert (count(db, Report, other), count(db, Alert, other)) == before


@requires_db
def test_rerate_all_stops_at_the_budget(db: Connection, world_id: UUID) -> None:
    runner = ScenarioRunner(db)
    spent = iter([Decimal(0), Decimal(0), Decimal("1.60")])  # start, asset 1, then asset 2

    report = rerate(db, world_id, runner, spend=lambda: next(spent, Decimal("1.60")))

    assert report.stopped == "job_budget_exhausted"
    assert len(runner.started) == 1
    with sessions(db)() as session:
        claims = session.exec(select(MonitorRun).where(MonitorRun.world_id == world_id)).all()
    # The rest is left for the next run; the one re-rated asset is also paid.
    assert sorted((c.job, c.status) for c in claims) == [(PAYOUT, "done"), (RERATE, "done")]

    exhausted = rerate(db, world_id, runner, period="2027Q1", spend=lambda: Decimal("19.9"))
    assert exhausted.stopped == "llm_budget_exhausted" and exhausted.done == []


@requires_db
def test_a_failed_rerate_is_retried_by_the_next_run(db: Connection, world_id: UUID) -> None:
    class Busy:
        def start(self, *_: Any, **__: Any) -> UUID:
            from app.services.rating_runs import RunnerBusy

            raise RunnerBusy()

    first = rerate(db, world_id, Busy())
    assert first.done == [] and {reason for _, reason in first.failed} == {"rating_busy"}

    assert first.payouts == 0  # a failed re-rate isn't paid
    assert count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT) == 0

    retry = rerate(db, world_id, ScenarioRunner(db))
    assert len(retry.done) == len(listed(db, world_id))
    assert retry.payouts == len(listed(db, world_id))


@requires_db
def test_a_rate_limit_stops_the_job_and_leaves_the_rest(db: Connection, world_id: UUID) -> None:
    from app.services.rating_runs import RunRateLimited

    class Limited:
        calls = 0

        def start(self, *_: Any, **__: Any) -> UUID:
            Limited.calls += 1
            raise RunRateLimited(60, code="rating_global_limit")

    report = rerate(db, world_id, Limited())

    assert report.stopped == "rating_global_limit" and Limited.calls == 1
    assert count(db, MonitorRun, world_id) == 1  # the rest is claimed by the next run


@requires_db
def test_a_second_label_for_the_same_quarter_cant_pay_twice(db: Connection, world_id: UUID) -> None:
    report = rerate(db, world_id, ScenarioRunner(db))
    asset = report.done[0]
    with sessions(db)() as session:
        value = session.exec(
            select(Report.value_mid)
            .where(Report.world_id == world_id, Report.asset_id == asset)
            .order_by(col(Report.version).desc())
        ).first()
        assert value is not None
        for label in ("2026-Q4", "2026-q4", " 2026Q4"):
            with pytest.raises(PayoutAlreadyApplied):
                pay_quarter(
                    session, world_id=world_id, asset_id=asset, value_mid=value, quarter_label=label
                )
            session.rollback()
    assert count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT) == len(
        report.done
    )


@requires_db
def test_a_payout_error_is_retried_and_the_quarter_is_paid_once(
    db: Connection, world_id: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    assets = listed(db, world_id)
    real = monitoring.pay_quarter
    calls = {"n": 0}

    def flaky(*args: Any, **kwargs: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("ledger hiccup")
        return real(*args, **kwargs)

    monkeypatch.setattr(monitoring, "pay_quarter", flaky)
    runner = ScenarioRunner(db)

    first = rerate(db, world_id, runner)

    assert len(first.done) == len(assets)  # every re-rate stands
    assert [reason for _, reason in first.failed] == ["payout_failed:RuntimeError"]
    assert first.payouts == len(assets) - 1

    retry = rerate(db, world_id, runner)

    assert retry.done == [] and len(runner.started) == len(assets)  # nothing re-rated
    assert retry.payouts == 1 and retry.failed == []
    assert count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT) == len(assets)
    assert rerate(db, world_id, runner).payouts == 0


@requires_db
def test_scheduled_runs_leave_the_worlds_hourly_window_to_people(
    db: Connection, world_id: UUID
) -> None:
    runner = ScenarioRunner(db, rating_runs_per_world_per_hour=1)

    report = rerate(db, world_id, runner)
    assert len(report.done) == len(listed(db, world_id)) > 1

    # An admin's re-rate still fits the world's window of 1 run per hour.
    runner.inner.start(world_id, report.done[0], trigger="api")


# --- news_sweep ---------------------------------------------------------------------------------


def scout(*items: NewsScoutItem) -> Callable[[NewsScoutAsset], NewsScoutOutput]:
    def run(asset: NewsScoutAsset) -> NewsScoutOutput:
        return NewsScoutOutput(
            events=[i.model_copy(update={"url": f"{i.url}/{asset.id}"}) for i in items]
        )

    return run


def news(severity: int, slug: str, relevant: bool = True) -> NewsScoutItem:
    return NewsScoutItem(
        id=f"evt-{slug}",
        relevant=relevant,
        impact_type="encroachment",
        direction=-1,
        severity=severity,
        summary=f"Clearing reported ({slug}).",
        title=f"Clearing {slug}",
        url=f"https://news.example.org/{slug}",
    )


def sweep(db: Connection, world_id: UUID, fn: Any, **overrides: Any) -> monitoring.JobReport:
    kwargs: dict[str, Any] = {
        "world_id": world_id,
        "period": TODAY,
        "spend": NO_SPEND,
        "llm_budget_usd": Decimal(20),
        "job_cap_usd": Decimal(2),
        **overrides,
    }
    return monitoring.news_sweep(sessions(db), fn, **kwargs)


@requires_db
def test_news_sweep_stores_events_and_alerts_on_severity_four(
    db: Connection, world_id: UUID
) -> None:
    assets = listed(db, world_id)
    fn = scout(news(5, "big"), news(2, "small"), news(5, "elsewhere", relevant=False))

    report = sweep(db, world_id, fn)

    assert len(report.done) == len(assets) and report.failed == []
    assert report.events == 2 * len(assets) == count(db, Event, world_id)
    assert report.alerts == len(assets) == count(db, Alert, world_id, Alert.kind == "news")


@requires_db
def test_news_sweep_is_idempotent_per_day_and_per_article(db: Connection, world_id: UUID) -> None:
    fn = scout(news(5, "big"))
    sweep(db, world_id, fn)
    events, alerts = count(db, Event, world_id), count(db, Alert, world_id)

    same_day = sweep(db, world_id, fn)
    next_day = sweep(db, world_id, fn, period="2026-10-20")

    assert same_day.done == [] and same_day.events == same_day.alerts == 0
    assert len(next_day.done) == len(listed(db, world_id))
    assert next_day.events == next_day.alerts == 0  # the same articles: nothing new
    assert (count(db, Event, world_id), count(db, Alert, world_id)) == (events, alerts)


@requires_db
def test_news_sweep_retries_a_failed_asset_and_respects_the_budget(
    db: Connection, world_id: UUID
) -> None:
    def broken(_: NewsScoutAsset) -> NewsScoutOutput:
        raise RuntimeError("tavily down")

    failed = sweep(db, world_id, broken)
    assert {reason for _, reason in failed.failed} == {"RuntimeError"}

    capped = sweep(db, world_id, scout(news(4, "x")), spend=lambda: Decimal("19.99"))
    assert capped.stopped == "llm_budget_exhausted" and capped.done == []

    retried = sweep(db, world_id, scout(news(4, "x")))
    assert len(retried.done) == len(listed(db, world_id))


@requires_db
def test_the_mock_news_sweep_cli_runs_without_keys(
    db: Connection, world_id: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    """USE_MOCKS=true (CI): the entrypoint runs News Scout's fixture, no key and no model."""
    import app.jobs.news_sweep as cli
    import app.jobs.runtime as runtime

    monkeypatch.setattr(cli, "session_factory", sessions(db))
    monkeypatch.setattr(cli, "job_settings", lambda: settings(use_mocks=True))
    monkeypatch.setattr(cli, "spend", lambda: NO_SPEND)
    monkeypatch.setattr(runtime, "session_factory", sessions(db))

    assert news_sweep_cli.main(["--world", str(world_id), "--period", TODAY]) == 0
    assert count(db, MonitorRun, world_id, MonitorRun.status == "done") == len(listed(db, world_id))


@requires_db
def test_unverified_locality_stores_events_but_alerts_nobody(
    db: Connection, world_id: UUID
) -> None:
    def unverified(asset: NewsScoutAsset) -> NewsScoutOutput:
        return scout(news(5, "big"))(asset).model_copy(update={"locality_unverified": True})

    report = sweep(db, world_id, unverified)

    assert len(report.done) == len(listed(db, world_id))
    assert report.events == len(report.done) == count(db, Event, world_id)
    assert report.alerts == 0 == count(db, Alert, world_id)


@requires_db
def test_a_failure_to_store_the_news_is_retried(
    db: Connection, world_id: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("disk full")

    monkeypatch.setattr(monitoring, "record_news", broken)
    failed = sweep(db, world_id, scout(news(5, "big")))
    assert {reason for _, reason in failed.failed} == {"store_failed:RuntimeError"}
    assert failed.done == [] and count(db, Event, world_id) == 0

    monkeypatch.undo()
    retried = sweep(db, world_id, scout(news(5, "big")))
    assert len(retried.done) == len(listed(db, world_id))
    assert retried.alerts == len(retried.done)


@requires_db
def test_an_asset_without_a_centroid_is_skipped(db: Connection, world_id: UUID) -> None:
    first = listed(db, world_id)[0].id
    with sessions(db)() as session:
        session.execute(
            update(Asset).where(col(Asset.id) == first).values(centroid_lat=None, centroid_lon=None)
        )
        session.commit()
    asked: list[UUID] = []

    def fn(asset: NewsScoutAsset) -> NewsScoutOutput:
        asked.append(asset.id)
        return NewsScoutOutput(events=[])

    report = sweep(db, world_id, fn)

    assert (first, "no_centroid") in report.skipped and first not in asked
    with sessions(db)() as session:
        assert monitoring.claim_status(session, NEWS_SWEEP, TODAY, first) == "skipped"

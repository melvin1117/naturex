"""#201: a Time Machine quarter runs in the background (202 + job), one per world, and survives
its process dying without re-rating or paying twice.

Service tests run T27's real runner in mock mode inline on one rolled-back connection, like
`test_time_machine.py`, with `Parked` standing in for the job pool when a test needs a job to
wait. A process dying is a `Crash` (a BaseException nothing catches), then an aged heartbeat.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Executor, Future
from dataclasses import replace
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, inspect, text
from sqlmodel import Session, col, select

from app.config import Settings, get_settings
from app.db import get_session
from app.main import app
from app.models import (
    LedgerEntry,
    LedgerKind,
    LlmCall,
    Metrics,
    MonitorRun,
    QuarterJob,
    Report,
)
from app.routers.admin import get_time_machine_env
from app.sandbox import create_world, reset_world
from app.seed import seed
from app.services import quarter_jobs as qj
from app.services import time_machine as tm
from app.services.monitoring import PAYOUT, RERATE, listed_assets, pay_period
from app.services.quarter_jobs import QuarterContext, QuarterJobRunning, QuarterJobs
from app.services.rating_runs import InlineExecutor
from tests.conftest import alembic_cfg, requires_db
from tests.test_time_machine import count, runner, sessions, step_of
from tests.worlds import drop_worlds, mock_time_machine_env, start_demo

NO_SPEND: Callable[[], Decimal] = lambda: Decimal(0)  # noqa: E731


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


@pytest.fixture
def api_session() -> Iterator[Session]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        session = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(session)
        yield session
        session.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(api_session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: api_session
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, use_mocks=True)
    app.dependency_overrides[get_time_machine_env] = lambda: mock_time_machine_env(api_session)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


class Parked(Executor):
    """Holds submitted jobs until `run_all`, as a busy pool would."""

    def __init__(self) -> None:
        self.parked: list[Callable[[], Any]] = []

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        self.parked.append(lambda: fn(*args, **kwargs))
        return Future()

    def run_all(self) -> None:
        while self.parked:
            self.parked.pop(0)()


class Crash(BaseException):
    """The process dying: no handler in the job catches it."""


class CrashAfter:
    """T27's runner, whose process dies right after its `n`th run sealed its report."""

    def __init__(self, inner: Any, n: int) -> None:
        self.inner, self.n, self.calls = inner, n, 0

    def start(self, *args: Any, **kwargs: Any) -> UUID:
        run_id: UUID = self.inner.start(*args, **kwargs)
        self.calls += 1
        if self.calls == self.n:
            raise Crash()
        return run_id


def ctx(
    conn: Connection,
    run: Any = None,
    spend: Callable[[], Decimal] = NO_SPEND,
    job_cap: Decimal = Decimal(2),
) -> QuarterContext:
    return QuarterContext(
        session_factory=sessions(conn),
        runner=run or runner(conn),
        spend=spend,
        llm_budget_usd=Decimal(20),
        job_cap_usd=job_cap,
        runs_per_hour=6,
    )


def job_of(conn: Connection, job_id: UUID) -> QuarterJob:
    with sessions(conn)() as session:
        return session.get_one(QuarterJob, job_id)


def age(conn: Connection, job_id: UUID) -> None:
    """The job's process stopped beating long ago."""
    with sessions(conn)() as session:
        session.execute(
            text(
                "UPDATE quarter_jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id = :id"
            ),
            {"id": job_id},
        )
        session.commit()


def payouts(conn: Connection, world: UUID) -> int:
    return count(conn, LedgerEntry, world, LedgerEntry.kind == LedgerKind.PAYOUT)


def listed(conn: Connection, world: UUID) -> list[UUID]:
    with sessions(conn)() as session:
        return [asset.id for asset in listed_assets(session, world)]


def quarter_reports(conn: Connection, world: UUID, asset_id: UUID) -> int:
    """How many of the asset's reports were rated with the 2026Q4 quarter (`sim-1`)."""
    with sessions(conn)() as session:
        return len(
            session.exec(
                select(Report.id)
                .join(Metrics, col(Metrics.id) == col(Report.metrics_id))
                .where(
                    Report.world_id == world,
                    Report.asset_id == asset_id,
                    Metrics.data_version == "sim-1",
                )
            ).all()
        )


# --- the job ------------------------------------------------------------------------------------


@requires_db
def test_a_job_moves_the_world_then_rerates_and_pays_every_listed_asset(
    db: Connection, world_id: UUID
) -> None:
    pool = Parked()
    jobs = QuarterJobs(executor=pool)

    queued = jobs.start(ctx(db), world_id, "2026Q4")

    assert (queued.status, queued.step, queued.replayed) == ("queued", 1, False)
    assert step_of(db, world_id) == 1  # the world moved before the 202
    assert job_of(db, queued.id).assets == []
    reports = count(db, Report, world_id)

    pool.run_all()

    job = job_of(db, queued.id)
    assets = listed(db, world_id)
    assert (job.status, job.stopped, job.error) == ("done", None, None)
    assert job.finished_at is not None and job.planned is not None
    assert [UUID(p["asset_id"]) for p in job.planned] == assets
    assert [UUID(a["asset_id"]) for a in job.assets] == assets
    assert {(a["status"], a["payout"]) for a in job.assets} == {("rerated", "paid")}
    hero = next(a for a in job.assets if a["name"].startswith("Xochimilco"))
    assert (hero["before"]["grade"], hero["after"]["grade"]) == ("A", "AA")
    assert hero["after"]["data_version"] == "sim-1" and hero["run_id"]
    assert count(db, Report, world_id) == reports + len(assets)
    assert payouts(db, world_id) == len(assets)


@requires_db
def test_one_job_per_world_at_a_time(db: Connection, world_id: UUID) -> None:
    pool = Parked()
    jobs = QuarterJobs(executor=pool)
    first = jobs.start(ctx(db), world_id, "2026Q4")

    with pytest.raises(QuarterJobRunning) as running:
        jobs.start(ctx(db), world_id, "2026Q4")
    assert running.value.job_id == first.id
    with pytest.raises(QuarterJobRunning):
        jobs.start(ctx(db), world_id, "2027Q1")  # whatever the quarter
    with sessions(db)() as session:
        other = create_world(session).id
    assert jobs.start(ctx(db), other, "2026Q4").status == "queued"  # other worlds aren't held

    pool.run_all()
    replay = jobs.start(ctx(db), world_id, "2026Q4")
    pool.run_all()

    assert step_of(db, world_id) == 1
    done = job_of(db, replay.id)
    assert done.replayed and done.status == "done"
    assert {(a["status"], a["payout"]) for a in done.assets} == {("already_done", "already_paid")}


@requires_db
def test_a_refused_quarter_records_no_job(db: Connection, world_id: UUID) -> None:
    jobs = QuarterJobs()
    with pytest.raises(tm.TimeMachineRefused, match="quarter_mismatch"):
        jobs.start(ctx(db), world_id, "2027Q1")

    assert count(db, QuarterJob, world_id) == 0 and step_of(db, world_id) == 0


@requires_db
def test_a_job_stopped_by_the_budget_says_so_and_a_replay_finishes_it(
    db: Connection, world_id: UUID
) -> None:
    jobs = QuarterJobs()

    stopped = job_of(db, jobs.start(ctx(db, spend=lambda: Decimal("19.60")), world_id, "2026Q4").id)

    assert (stopped.status, stopped.stopped) == ("stopped", "llm_budget_exhausted")
    assert {a["status"] for a in stopped.assets} == {"stopped"}
    finished = job_of(db, jobs.start(ctx(db), world_id, "2026Q4").id)
    assert finished.status == "done" and {a["status"] for a in finished.assets} == {"rerated"}


@requires_db
def test_a_job_that_raises_is_failed_and_a_replay_finishes_it(
    db: Connection, world_id: UUID
) -> None:
    class Broken:
        def start(self, *_: Any, **__: Any) -> UUID:
            raise RuntimeError("worker lost its database")

    jobs = QuarterJobs()

    failed = job_of(db, jobs.start(ctx(db, run=Broken()), world_id, "2026Q4").id)

    assert (failed.status, failed.error) == ("failed", "job_failed:RuntimeError")
    assert failed.finished_at is not None
    replay = job_of(db, jobs.start(ctx(db), world_id, "2026Q4").id)
    assert replay.status == "done"
    assert payouts(db, world_id) == len(listed(db, world_id))


# --- restart safety -----------------------------------------------------------------------------


@requires_db
def test_a_job_whose_process_died_after_a_rerate_resumes_without_rerating_or_paying_twice(
    db: Connection, world_id: UUID
) -> None:
    assets = listed(db, world_id)
    reports = count(db, Report, world_id)
    jobs = QuarterJobs()

    job_id = jobs.start(ctx(db, run=CrashAfter(runner(db), 2)), world_id, "2026Q4").id

    # Died after the 2nd asset's report sealed, before its claim or result were written.
    dead = job_of(db, job_id)
    assert dead.status == "running" and len(dead.assets) == 1
    with sessions(db)() as session:
        claim = session.get_one(MonitorRun, (RERATE, "tm-sim-1", assets[1]))
    assert claim.status == "running"
    assert count(db, Report, world_id) == reports + 2 and payouts(db, world_id) == 1
    assert not jobs.resume_if_stale(ctx(db), job_id)  # still beating: alive as far as we know

    age(db, job_id)
    assert QuarterJobs().resume_if_stale(ctx(db), job_id)  # the next poll, in a new process

    job = job_of(db, job_id)
    assert (job.status, job.error) == ("done", None)
    assert [UUID(a["asset_id"]) for a in job.assets] == assets
    statuses = [a["status"] for a in job.assets]
    assert statuses == ["rerated", "already_done", *["rerated"] * (len(assets) - 2)]
    second = job.assets[1]
    assert second["run_id"] and second["after"]["data_version"] == "sim-1"
    assert second["payout"] == "paid"
    # Each asset re-rated once with the quarter, and paid once.
    assert count(db, Report, world_id) == reports + len(assets)
    assert {quarter_reports(db, world_id, asset) for asset in assets} == {1}
    assert payouts(db, world_id) == len(assets)
    assert not QuarterJobs().resume_if_stale(ctx(db), job_id)  # finished: nothing to resume


@requires_db
def test_a_job_whose_process_died_during_a_payout_pays_it_once_on_resume(
    db: Connection, world_id: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    assets = listed(db, world_id)
    crashed: list[UUID] = []

    def pay_then_die(*args: Any, **kwargs: Any) -> Any:
        paid = pay_period(*args, **kwargs)
        if not crashed:
            crashed.append(args[2])
            raise Crash()
        return paid

    monkeypatch.setattr(tm, "pay_period", pay_then_die)
    job_id = QuarterJobs().start(ctx(db), world_id, "2026Q4").id
    assert job_of(db, job_id).assets == [] and payouts(db, world_id) == 1
    with sessions(db)() as session:
        assert session.get_one(MonitorRun, (PAYOUT, "tm-sim-1", assets[0])).status == "running"

    age(db, job_id)
    assert QuarterJobs().resume_if_stale(ctx(db), job_id)

    job = job_of(db, job_id)
    assert job.status == "done"
    assert (job.assets[0]["status"], job.assets[0]["payout"]) == ("already_done", "already_paid")
    assert {a["payout"] for a in job.assets[1:]} == {"paid"}
    assert payouts(db, world_id) == len(assets)


@requires_db
def test_a_job_waiting_in_this_process_keeps_beating(db: Connection, world_id: UUID) -> None:
    pool = Parked()
    jobs = QuarterJobs(executor=pool)
    job_id = jobs.start(ctx(db), world_id, "2026Q4").id
    age(db, job_id)

    jobs.beat()

    with sessions(db)() as session:
        assert not qj.is_stale(session, session.get_one(QuarterJob, job_id))
    assert not QuarterJobs().resume_if_stale(ctx(db), job_id)


@requires_db
def test_a_taken_over_attempt_writes_nothing(db: Connection, world_id: UUID) -> None:
    pool = Parked()
    job_id = QuarterJobs(executor=pool).start(ctx(db), world_id, "2026Q4").id
    age(db, job_id)
    takeover = Parked()
    assert QuarterJobs(executor=takeover).resume_if_stale(ctx(db), job_id)

    pool.run_all()  # the first attempt finally runs: its lease is gone

    assert job_of(db, job_id).status == "queued" and payouts(db, world_id) == 0
    takeover.run_all()
    assert job_of(db, job_id).status == "done"


@requires_db
def test_a_reset_deletes_the_job_and_its_attempt_stops(db: Connection, world_id: UUID) -> None:
    pool = Parked()
    job_id = QuarterJobs(executor=pool).start(ctx(db), world_id, "2026Q4").id

    with sessions(db)() as session:
        reset_world(session, world_id)
    pool.run_all()

    assert count(db, QuarterJob, world_id) == 0
    assert step_of(db, world_id) == 0 and payouts(db, world_id) == 0
    with sessions(db)() as session:
        assert qj.get_job(session, world_id, job_id) is None


# --- API ----------------------------------------------------------------------------------------


def _parked_env(api_session: Session, pool: Executor, run: Any = None) -> None:
    env = mock_time_machine_env(api_session)
    env = replace(env, jobs=QuarterJobs(executor=pool), runner=run or env.runner)
    app.dependency_overrides[get_time_machine_env] = lambda: env


@requires_db
def test_a_second_start_while_a_quarter_runs_is_409_with_the_running_job(
    client: TestClient, api_session: Session
) -> None:
    start_demo(client, api_session, persona_key="admin")
    pool = Parked()
    _parked_env(api_session, pool)

    first = client.post("/admin/simulate/quarter", json={"period": "2026Q4"})

    assert first.status_code == 202, first.text
    job = first.json()
    assert (job["status"], job["assets"], job["asset_count"], job["step"]) == (
        "queued",
        [],
        None,
        1,
    )
    location = first.headers["Location"]
    assert client.get("/admin/time-machine").json()["quarter_job"]["status"] == "queued"

    second = client.post("/admin/simulate/quarter", json={"period": "2026Q4"})

    assert (second.status_code, second.json()["detail"]) == (409, "quarter_job_running")
    assert second.headers["Location"] == location
    assert client.get(location).json()["status"] == "queued"

    pool.run_all()

    done = client.get(location).json()
    assert done["status"] == "done" and done["assets_rerated"] == len(done["assets"]) > 0
    assert done["payouts"] == done["asset_count"] == len(done["assets"])


@requires_db
def test_polling_resumes_a_quarter_whose_process_died(
    client: TestClient, api_session: Session
) -> None:
    sandbox = start_demo(client, api_session, persona_key="admin")
    env = mock_time_machine_env(api_session)
    _parked_env(api_session, InlineExecutor(), run=CrashAfter(env.runner, 1))
    started = client.post("/admin/simulate/quarter", json={"period": "2026Q4"})
    assert started.status_code == 202, started.text
    location = started.headers["Location"]
    dead = client.get(location).json()
    assert (dead["status"], dead["assets"]) == ("running", [])

    app.dependency_overrides[get_time_machine_env] = lambda: mock_time_machine_env(api_session)
    api_session.execute(text("UPDATE quarter_jobs SET heartbeat_at = now() - interval '5 minutes'"))
    api_session.commit()

    resumed = client.get(location).json()

    assert resumed["status"] == "done"
    assert resumed["assets"][0]["status"] == "already_done"
    assert {a["payout"] for a in resumed["assets"]} == {"paid"}
    listed_count = len(listed_assets(api_session, sandbox.id))
    assert resumed["asset_count"] == len(resumed["assets"]) == listed_count
    paid = api_session.exec(
        select(LedgerEntry.id).where(
            LedgerEntry.world_id == sandbox.id, LedgerEntry.kind == LedgerKind.PAYOUT
        )
    ).all()
    assert len(paid) == listed_count


@requires_db
def test_quarter_jobs_are_admin_only_and_stay_in_their_world(
    client: TestClient, api_session: Session
) -> None:
    sandbox = start_demo(client, api_session, persona_key="admin")
    job = client.post("/admin/simulate/quarter", json={"period": "2026Q4"}).json()
    other = create_world(api_session)
    start_demo(client, api_session, other, persona_key="admin")

    elsewhere = client.get(f"/admin/simulate/quarter/{job['id']}")
    unknown = client.get(f"/admin/simulate/quarter/{UUID(int=7)}")

    assert (elsewhere.status_code, elsewhere.json()["detail"]) == (404, "not_found")
    assert (unknown.status_code, unknown.json()["detail"]) == (404, "not_found")
    assert client.get("/admin/time-machine").json()["quarter_job"] is None
    start_demo(client, api_session, sandbox, persona_key="arjun")  # the demo investor
    investor = client.get(f"/admin/simulate/quarter/{job['id']}")
    assert (investor.status_code, investor.json()["detail"]) == (403, "admin_only")
    anonymous = TestClient(app).get(f"/admin/simulate/quarter/{job['id']}")
    assert anonymous.status_code == 401


@requires_db
def test_migration_0025_downgrades_and_upgrades() -> None:
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)

    def has_table() -> bool:
        with engine.connect() as conn:
            return inspect(conn).has_table("quarter_jobs")

    try:
        assert has_table()
        command.downgrade(cfg, "0023")
        assert not has_table()
    finally:
        command.upgrade(cfg, "head")
        assert has_table()
        engine.dispose()


# --- hardening (#201 review) --------------------------------------------------------------------


def active_job_id(conn: Connection, world: UUID) -> UUID:
    with sessions(conn)() as session:
        return session.exec(
            select(QuarterJob.id).where(
                QuarterJob.world_id == world, col(QuarterJob.status).in_(("queued", "running"))
            )
        ).one()


@requires_db
def test_a_crash_before_the_quarter_runs_is_logged_and_the_job_recovers(
    db: Connection,
    world_id: UUID,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("could not connect to postgres://naturex:hunter2@db")

    monkeypatch.setattr(qj, "listed_assets", broken)
    jobs = QuarterJobs()
    with caplog.at_level(logging.ERROR, logger="app.services.quarter_jobs"):
        job_id = jobs.start(ctx(db), world_id, "2026Q4").id

    failed = job_of(db, job_id)
    assert (failed.status, failed.error) == ("failed", "job_failed:RuntimeError")
    assert failed.finished_at is not None and not jobs._live
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "crashed: RuntimeError" in logged and "in run" in logged  # type and frames
    assert "hunter2" not in logged  # never the message
    monkeypatch.undo()
    assert job_of(db, jobs.start(ctx(db), world_id, "2026Q4").id).status == "done"


@requires_db
def test_a_pool_that_refuses_the_job_fails_it_instead_of_leaving_a_phantom(
    db: Connection, world_id: UUID
) -> None:
    class Closed(Executor):
        def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
            raise RuntimeError("cannot schedule new futures after shutdown")

    jobs = QuarterJobs(executor=Closed())

    job = job_of(db, jobs.start(ctx(db), world_id, "2026Q4").id)

    assert (job.status, job.error) == ("failed", "job_not_started:RuntimeError")
    assert not jobs._live
    assert job_of(db, QuarterJobs().start(ctx(db), world_id, "2026Q4").id).status == "done"


@requires_db
def test_an_attempt_taken_over_mid_asset_neither_pays_nor_records(
    db: Connection, world_id: UUID
) -> None:
    assets = listed(db, world_id)
    reports = count(db, Report, world_id)
    takeover = Parked()

    class TakenOverDuringRun:
        """The first run seals, then another process takes the job over before it's paid."""

        def __init__(self) -> None:
            self.inner, self.done = runner(db), False

        def start(self, *args: Any, **kwargs: Any) -> UUID:
            run_id: UUID = self.inner.start(*args, **kwargs)
            if not self.done:
                self.done = True
                job_id = active_job_id(db, world_id)
                age(db, job_id)
                assert QuarterJobs(executor=takeover).resume_if_stale(ctx(db), job_id)
            return run_id

    job_id = QuarterJobs().start(ctx(db, run=TakenOverDuringRun()), world_id, "2026Q4").id

    lost = job_of(db, job_id)
    assert lost.status == "running" and lost.assets == []  # the first attempt stopped
    assert payouts(db, world_id) == 0 and count(db, Report, world_id) == reports + 1
    takeover.run_all()

    job = job_of(db, job_id)
    assert job.status == "done"
    assert [UUID(a["asset_id"]) for a in job.assets] == assets
    assert (job.assets[0]["status"], job.assets[0]["payout"]) == ("already_done", "paid")
    assert job.assets[0]["run_id"] is not None
    assert count(db, Report, world_id) == reports + len(assets)
    assert payouts(db, world_id) == len(assets)


@requires_db
def test_a_reset_mid_attempt_stops_it_without_paying(db: Connection, world_id: UUID) -> None:
    class ResetDuringRun:
        def __init__(self) -> None:
            self.inner = runner(db)

        def start(self, *args: Any, **kwargs: Any) -> UUID:
            run_id: UUID = self.inner.start(*args, **kwargs)
            with sessions(db)() as session:
                reset_world(session, world_id)
            return run_id

    QuarterJobs().start(ctx(db, run=ResetDuringRun()), world_id, "2026Q4")

    assert count(db, QuarterJob, world_id) == 0
    assert step_of(db, world_id) == 0 and payouts(db, world_id) == 0


def spent(conn: Connection, world: UUID | None, usd: str) -> None:
    with sessions(conn)() as session:
        session.add(LlmCall(world_id=world, agent="auditor", cost_usd=Decimal(usd)))
        session.commit()


@requires_db
def test_the_job_budget_counts_its_own_world_from_its_first_start_across_resumes(
    db: Connection, world_id: UUID
) -> None:
    with sessions(db)() as session:
        other = create_world(session).id

    class SpendsThenDies:
        """Each run costs $0.60 in this world (and another world's quarter $5 meanwhile);
        the process dies after the first."""

        def __init__(self) -> None:
            self.inner, self.calls = runner(db), 0

        def start(self, *args: Any, **kwargs: Any) -> UUID:
            run_id: UUID = self.inner.start(*args, **kwargs)
            spent(db, world_id, "0.60")
            spent(db, other, "5.00")
            self.calls += 1
            if self.calls == 1:
                raise Crash()
            return run_id

    cap = Decimal("1.50")  # $0.60 spent + $0.50 per asset: one more asset fits, not two
    run = SpendsThenDies()
    job_id = QuarterJobs().start(ctx(db, run=run, job_cap=cap), world_id, "2026Q4").id
    first = job_of(db, job_id)
    assert first.started_at is not None
    age(db, job_id)

    assert QuarterJobs().resume_if_stale(ctx(db, run=run, job_cap=cap), job_id)

    job = job_of(db, job_id)
    assert job.started_at == first.started_at  # the baseline survives the resume
    assert (job.status, job.stopped) == ("stopped", "job_budget_exhausted")
    statuses = [a["status"] for a in job.assets]
    # Resumed: the 1st (sealed before the crash) and the 2nd fit ($0.60, then $1.20 spent);
    # another world's $10 never counted, a restarted budget would have run all three.
    assert statuses == ["already_done", "rerated", "stopped"]


@requires_db
def test_a_wedged_job_is_failed_and_frees_the_world(db: Connection, world_id: UUID) -> None:
    pool = Parked()
    jobs = QuarterJobs(executor=pool)
    job_id = jobs.start(ctx(db), world_id, "2026Q4").id
    with sessions(db)() as session:  # beating, but nothing settled for an hour
        session.execute(
            text("UPDATE quarter_jobs SET updated_at = now() - interval '1 hour' WHERE id = :id"),
            {"id": job_id},
        )
        session.commit()

    replay = jobs.start(ctx(db), world_id, "2026Q4")

    stuck = job_of(db, job_id)
    assert (stuck.status, stuck.error) == ("failed", qj.JOB_STUCK)
    assert replay.id != job_id and replay.replayed
    pool.run_all()  # the wedged attempt finally runs: it finds its job failed and does nothing
    assert job_of(db, job_id).assets == []
    assert job_of(db, replay.id).status == "done"


class FakeSession:
    def __init__(self, calls: list[str]) -> None:
        self.calls = calls

    def __enter__(self) -> FakeSession:
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def execute(self, *_: Any) -> None:
        self.calls.append("beat")

    def commit(self) -> None:
        return None


def test_the_heartbeat_starts_once_survives_a_failed_beat_and_stops_on_shutdown() -> None:
    calls: list[str] = []

    def factory() -> Any:
        if not calls:
            calls.append("failed")
            raise RuntimeError("database restarting")
        return FakeSession(calls)

    context = QuarterContext(
        session_factory=factory,
        runner=object(),  # type: ignore[arg-type]
        spend=NO_SPEND,
        llm_budget_usd=Decimal(20),
        job_cap_usd=Decimal(2),
        runs_per_hour=6,
    )
    jobs = QuarterJobs(executor=Parked(), heartbeat_s=0.01)

    jobs._submit(context, uuid4(), uuid4())
    jobs._submit(context, uuid4(), uuid4())
    deadline = time.monotonic() + 5
    while calls.count("beat") < 2 and time.monotonic() < deadline:
        time.sleep(0.01)

    beaters = [t for t in threading.enumerate() if t.name == "quarter-job-heartbeat"]
    assert len(beaters) == 1 and calls[0] == "failed" and calls.count("beat") >= 2
    jobs.shutdown()
    beaters[0].join(5)
    assert not beaters[0].is_alive()
    jobs._submit(context, uuid4(), uuid4())  # after shutdown: no new heartbeat
    assert not [t for t in threading.enumerate() if t.name == "quarter-job-heartbeat"]


@requires_db
def test_two_pollers_resuming_the_same_dead_job_one_wins() -> None:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as setup:
        seed(setup)
        world = create_world(setup).id
        job = QuarterJob(world_id=world, period="2026Q4", step=1, replayed=False, lease=uuid4())
        setup.add(job)
        setup.commit()
        job_id = job.id
        setup.execute(
            text("UPDATE quarter_jobs SET heartbeat_at = now() - interval '5 minutes'"),
        )
        setup.commit()
    barrier = threading.Barrier(2)
    won: list[bool] = []

    def poll() -> None:
        context = QuarterContext(
            session_factory=lambda: Session(engine),
            runner=object(),  # type: ignore[arg-type]
            spend=NO_SPEND,
            llm_budget_usd=Decimal(20),
            job_cap_usd=Decimal(2),
            runs_per_hour=6,
        )
        barrier.wait()
        won.append(QuarterJobs(executor=Parked()).resume_if_stale(context, job_id))

    try:
        threads = [threading.Thread(target=poll) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        assert sorted(won) == [False, True]
    finally:
        drop_worlds(engine, [world])
        engine.dispose()


@requires_db
def test_polling_without_local_jobs_never_resumes(client: TestClient, api_session: Session) -> None:
    start_demo(client, api_session, persona_key="admin")
    pool = Parked()
    _parked_env(api_session, pool)
    location = client.post("/admin/simulate/quarter", json={"period": "2026Q4"}).headers["Location"]
    api_session.execute(text("UPDATE quarter_jobs SET heartbeat_at = now() - interval '1 hour'"))
    api_session.commit()
    lease = api_session.exec(select(QuarterJob.lease)).one()
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, use_mocks=True, local_jobs=False
    )

    res = client.get(location)

    assert res.status_code == 200 and res.json()["status"] == "queued"
    api_session.expire_all()
    assert api_session.exec(select(QuarterJob.lease)).one() == lease
    assert len(pool.parked) == 1

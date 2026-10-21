"""Time Machine quarters as background jobs (#201, dev-spec §9 "As built (#201)").

With live models a quarter re-rates every listed asset, one full rating each, which can outlast
a hosting proxy's timeout. So `POST /admin/simulate/quarter` only checks the request, moves the
world and records a `quarter_jobs` row (`queued`) in one transaction, then answers 202; a worker
thread runs T38's `time_machine.run_quarter` and appends each asset's result to the row once its
re-rate and payout are settled. `GET /admin/simulate/quarter/{job_id}` reads it.

**One job per world.** The world row is locked while the job is recorded, and a partial unique
index allows one `queued`/`running` job per world, so a second start answers 409 with the
running job.

**Restart-safe.** Re-rates and payouts stay T75's `monitor_runs` claims, so nothing is done
twice. A job's process proves it's alive with `heartbeat_at` (every `HEARTBEAT_EVERY_S`, from
this process's heartbeat thread, and after each asset). A job whose heartbeat is older than
`JOB_STALE_AFTER` lost its process: the next poll or start takes it over with a new `lease`
(a conditional update, so only one caller wins), releases its period's `running` claims
(`time_machine.recover_claims`) and resumes it with the assets it hadn't settled. Every write
of a job is conditional on its lease, and the lease is checked again before each payout, so an
attempt that was taken over (or a job deleted by a sandbox reset) stops without paying or
recording anything more.

**Bounded.** A job that made no progress (`updated_at`: its start, each settled asset) for
`JOB_STUCK_AFTER` is ended `failed` (`job_stuck`) by the next poll or start, even if its process
still beats, so a wedged worker can't hold a world's quarters forever. One asset's rating is
bounded well below that: each model call times out (`llm.REQUEST_TIMEOUT_S`, retried a few
times) and T27 counts a run with no event for `RUN_STALE_AFTER` as failed.

**Budget.** The job's own spend is the world's LLM spend (`llm_calls`) since the job first
started (`started_at`, kept on resume), so `MONITOR_JOB_BUDGET_USD` covers the whole job across
attempts and a quarter running in another world isn't counted. Other activity in the same world
meanwhile (a preset, the Copilot) is counted too: the cap errs on the safe side.

**Locks.** Writes that can race a sandbox reset (taking over, ending a job and releasing its
claims) lock the world row (`FOR KEY SHARE`) before the job row, in the order a reset takes
them (world `FOR UPDATE`, then the world's rows), so they wait for a reset instead of
deadlocking with it.
"""

from __future__ import annotations

import logging
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import Executor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import and_, bindparam, func, or_, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from app.models import QUARTER_JOB_ACTIVE, LlmCall, QuarterJob, World
from app.services import time_machine
from app.services.monitoring import Spend, listed_assets
from app.services.rating_runs import InlineExecutor
from app.tools.scenarios import ScenarioSpec, load_scenario_spec, timeline_version

log = logging.getLogger(__name__)

JOB_STALE_AFTER = timedelta(minutes=2)
"""No heartbeat for this long: the job's process died; the next poll or start resumes it."""
JOB_STUCK_AFTER = timedelta(minutes=30)
"""No settled asset for this long: the job is wedged; the next poll or start fails it."""
HEARTBEAT_EVERY_S = 20.0
JOB_STUCK = "job_stuck"
JOB_NOT_STARTED = "job_not_started"

JobStatus = Literal["queued", "running", "done", "stopped", "failed"]


class QuarterJobRunning(Exception):
    """The world already has a queued or running quarter job (409, Location: that job)."""

    def __init__(self, job_id: UUID) -> None:
        super().__init__(str(job_id))
        self.job_id = job_id


class _JobLost(Exception):
    """This attempt no longer owns the job (taken over, or deleted by a sandbox reset)."""


@dataclass(frozen=True, slots=True)
class QuarterContext:
    """What a job runs with: sessions, the API's rating runner (each run inline in the job's
    thread, holding one of the runner's shared slots), the LLM spend and the caps."""

    session_factory: Callable[[], Session]
    runner: time_machine.Runner
    spend: Spend
    llm_budget_usd: Decimal
    job_cap_usd: Decimal
    runs_per_hour: int


# --- results as JSON ----------------------------------------------------------------------------


def _decimal(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def rating_json(view: time_machine.RatingView | None) -> dict[str, Any] | None:
    if view is None:
        return None
    return {
        "report_id": str(view.report_id),
        "version": view.version,
        "health_score": _decimal(view.health_score),
        "grade": view.grade,
        "data_version": view.data_version,
        "simulated": view.simulated,
        "fair_value_per_share": _decimal(view.fair_value_per_share),
        "price": _decimal(view.price),
    }


def asset_json(result: time_machine.AssetOutcome) -> dict[str, Any]:
    """One asset's result as stored in `quarter_jobs.assets` (the `SimulatedAssetOut` shape)."""
    return {
        "asset_id": str(result.asset_id),
        "name": result.name,
        "status": result.status,
        "detail": result.detail,
        "run_id": str(result.run_id) if result.run_id else None,
        "before": rating_json(result.before),
        "after": rating_json(result.after),
        "alert_ids": [str(alert_id) for alert_id in result.alert_ids],
        "payout": result.payout,
        "payout_detail": result.payout_detail,
    }


# --- reads --------------------------------------------------------------------------------------


def get_job(session: Session, world_id: UUID, job_id: UUID) -> QuarterJob | None:
    """The world's job, or None (unknown, or another world's)."""
    return session.exec(
        select(QuarterJob).where(QuarterJob.world_id == world_id, QuarterJob.id == job_id)
    ).first()


def latest_job(session: Session, world_id: UUID) -> QuarterJob | None:
    return session.exec(
        select(QuarterJob)
        .where(QuarterJob.world_id == world_id)
        .order_by(col(QuarterJob.created_at).desc(), col(QuarterJob.id))
        .limit(1)
    ).first()


def _active_job(session: Session, world_id: UUID) -> QuarterJob | None:
    return session.exec(
        select(QuarterJob).where(
            QuarterJob.world_id == world_id, col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE)
        )
    ).first()


def is_stale(session: Session, job: QuarterJob) -> bool:
    """An active job whose process stopped beating (by the database clock)."""
    if job.status not in QUARTER_JOB_ACTIVE:
        return False
    stale: bool = session.exec(select(func.now() - JOB_STALE_AFTER > job.heartbeat_at)).one()
    return stale


def world_spent_since(
    session_factory: Callable[[], Session], world_id: UUID, since: datetime
) -> Decimal:
    """The world's LLM spend (`llm_calls`, reservations included) since `since`."""
    with session_factory() as session:
        total = session.exec(
            select(func.coalesce(func.sum(LlmCall.cost_usd), 0)).where(
                LlmCall.world_id == world_id, col(LlmCall.created_at) >= since
            )
        ).one()
    return Decimal(total)


def _lock_world(session: Session, world_id: UUID) -> None:
    """`FOR KEY SHARE` on the world row: waits for a sandbox reset (which holds it `FOR UPDATE`
    while it deletes the world's rows), so job writes never deadlock with one."""
    session.exec(
        select(World.id).where(World.id == world_id).with_for_update(read=True, key_share=True)
    ).first()


def _crash_report(exc: BaseException) -> str:
    """The exception's type and traceback frames (file, line, function), without its message
    or source lines (which may quote SQL parameters or connection details)."""
    frames = "".join(
        f'  File "{frame.filename}", line {frame.lineno}, in {frame.name}\n'
        for frame in traceback.extract_tb(exc.__traceback__)
    )
    return f"{type(exc).__name__}\n{frames}"


# --- the process's jobs -------------------------------------------------------------------------


@dataclass(slots=True)
class _Live:
    lease: UUID
    session_factory: Callable[[], Session]


@dataclass
class QuarterJobs:
    """Starts, runs, heartbeats and resumes this process's quarter jobs.

    `executor` runs each job (a small thread pool in the API; `InlineExecutor` in tests, so a
    job is done before `start` returns). `heartbeat_s` None turns the heartbeat thread off (each
    settled asset still beats). `shutdown` stops both at API shutdown."""

    executor: Executor = field(default_factory=InlineExecutor)
    heartbeat_s: float | None = None
    load_spec: Callable[[], ScenarioSpec] = load_scenario_spec
    _live: dict[UUID, _Live] = field(default_factory=dict, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _stop: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _beater: threading.Thread | None = field(default=None, init=False, repr=False)

    # --- starting ---

    def start(
        self,
        ctx: QuarterContext,
        world_id: UUID,
        period: str,
        *,
        requested_by: UUID | None = None,
    ) -> QuarterJob:
        """Move the world to `period` (or replay it) and queue its job; returns the job.

        Raises TimeMachineRefused (`time_machine_sandbox_only`, `quarter_mismatch`,
        `timeline_end`), QuarterJobRunning or LookupError (no such world)."""
        if not time_machine.available(world_id):
            raise time_machine.TimeMachineRefused(time_machine.SANDBOX_ONLY)
        spec = self.load_spec()
        with ctx.session_factory() as session:
            active_id = session.exec(
                select(QuarterJob.id).where(
                    QuarterJob.world_id == world_id,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                )
            ).first()
        if active_id is not None:
            # A dead job is resumed (and still refused below); a stuck one fails, freeing the world.
            self.heal(ctx, active_id)
        with ctx.session_factory() as session:
            # The world's row lock orders this against another start and a sandbox reset.
            step = session.exec(
                select(World.time_machine_step)
                .where(World.id == world_id)
                .with_for_update(key_share=True)  # FOR NO KEY UPDATE
            ).one_or_none()
            if step is None:
                raise LookupError(f"world {world_id} not found")
            active = _active_job(session, world_id)
            if active is not None:
                session.rollback()
                raise QuarterJobRunning(active.id)
            target, replayed = time_machine.quarter_target(step, period, spec)
            if not replayed:
                session.execute(
                    update(World).where(col(World.id) == world_id).values(time_machine_step=target)
                )
            job = QuarterJob(
                world_id=world_id,
                period=period,
                step=target,
                replayed=replayed,
                requested_by=requested_by,
                lease=uuid4(),
            )
            session.add(job)
            try:
                session.commit()
            except IntegrityError:  # another process recorded one first
                session.rollback()
                other = _active_job(session, world_id)
                if other is None:
                    raise
                raise QuarterJobRunning(other.id) from None
            session.refresh(job)
            session.expunge(job)
        assert job.lease is not None
        self._submit(ctx, job.id, job.lease)
        return job

    def heal(self, ctx: QuarterContext, job_id: UUID) -> bool:
        """For an active job: fail it if it's stuck (`JOB_STUCK_AFTER`), else resume it here
        if its process died (`JOB_STALE_AFTER`). True when either happened."""
        return self.fail_if_stuck(ctx, job_id) or self.resume_if_stale(ctx, job_id)

    def fail_if_stuck(self, ctx: QuarterContext, job_id: UUID) -> bool:
        """End an active job that settled nothing for `JOB_STUCK_AFTER` as `failed`
        (`job_stuck`) and release its claims; its attempt, if alive, stops at its next write."""
        stuck = func.now() - JOB_STUCK_AFTER
        ended = self._end_where(
            ctx,
            job_id,
            col(QuarterJob.updated_at) < stuck,
            "failed",
            error=JOB_STUCK,
            release=True,
        )
        if ended:
            log.warning(
                "quarter job %s made no progress for %s; failed it", job_id, JOB_STUCK_AFTER
            )
        return ended

    def resume_if_stale(self, ctx: QuarterContext, job_id: UUID) -> bool:
        """Take over an active job whose process died and resume it here. False when it's
        alive, finished or gone, or another caller took it over first."""
        new_lease = uuid4()
        stale = func.now() - JOB_STALE_AFTER
        with ctx.session_factory() as session:
            world_id = session.exec(
                select(QuarterJob.world_id).where(QuarterJob.id == job_id)
            ).first()
            if world_id is None:
                return False
            _lock_world(session, world_id)
            row = session.execute(
                update(QuarterJob)
                .where(
                    col(QuarterJob.id) == job_id,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                    col(QuarterJob.heartbeat_at) < stale,
                )
                .values(lease=new_lease, heartbeat_at=func.now(), updated_at=func.now())
                .returning(col(QuarterJob.step))
            ).first()
            if row is None:
                session.rollback()
                return False
            version = timeline_version(self.load_spec(), row[0])
            released = time_machine.recover_claims(session, world_id, version)
            session.commit()
        log.warning(
            "quarter job %s (world %s) lost its process; resuming it (%d claims released)",
            job_id,
            world_id,
            released,
        )
        self._submit(ctx, job_id, new_lease)
        return True

    def _submit(self, ctx: QuarterContext, job_id: UUID, lease: UUID) -> None:
        with self._lock:
            self._live[job_id] = _Live(lease, ctx.session_factory)
            if self.heartbeat_s is not None and self._beater is None and not self._stop.is_set():
                self._beater = threading.Thread(
                    target=self._beat_until_stopped, name="quarter-job-heartbeat", daemon=True
                )
                self._beater.start()
        try:
            self.executor.submit(self._run_and_forget, ctx, job_id, lease)
        except Exception as exc:  # e.g. the pool is shutting down: don't leave a phantom
            self._forget(job_id, lease)
            log.error("quarter job %s could not be started: %s", job_id, type(exc).__name__)
            self._end(ctx, job_id, lease, "failed", error=f"{JOB_NOT_STARTED}:{type(exc).__name__}")

    def _forget(self, job_id: UUID, lease: UUID) -> None:
        with self._lock:
            live = self._live.get(job_id)
            if live is not None and live.lease == lease:
                del self._live[job_id]

    def _run_and_forget(self, ctx: QuarterContext, job_id: UUID, lease: UUID) -> None:
        """The pool's entry point: nothing may escape it (a pool swallows it silently)."""
        try:
            self.run(ctx, job_id, lease)
        except Exception as exc:
            log.error("quarter job %s crashed: %s", job_id, _crash_report(exc))
            try:
                failed = f"job_failed:{type(exc).__name__}"
                self._end(ctx, job_id, lease, "failed", error=failed, release=True)
            except Exception as end_exc:  # the database is gone too: a poll resumes it later
                log.error(
                    "quarter job %s could not be marked failed: %s",
                    job_id,
                    _crash_report(end_exc),
                )
        finally:
            self._forget(job_id, lease)

    def shutdown(self) -> None:
        """At API shutdown: stop the heartbeat and drop queued jobs (running ones finish their
        current asset in their thread; a job left unfinished is resumed by the next poll)."""
        self._stop.set()
        self.executor.shutdown(wait=False, cancel_futures=True)

    # --- running ---

    def run(self, ctx: QuarterContext, job_id: UUID, lease: UUID) -> None:
        """Run (or resume) the job under `lease`: re-rate and pay each planned asset it hasn't
        settled, then end it `done` or `stopped`; `failed` if the job itself raised. Raises
        only if the job couldn't even be read or started."""
        spec = self.load_spec()
        with ctx.session_factory() as session:
            job = session.exec(
                select(QuarterJob).where(
                    QuarterJob.id == job_id,
                    QuarterJob.lease == lease,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                )
            ).first()
            if job is None:
                return  # taken over, finished or reset meanwhile
            # Conditional: only this attempt, only while the job is still active (a takeover
            # changes the lease, so one attempt at most passes). The first attempt fixes the
            # planned assets and the start of the job's spend.
            values: dict[str, Any] = {}
            if job.planned is None:  # JSON null: not planned yet
                values["planned"] = [
                    {"asset_id": str(asset.id), "name": asset.name}
                    for asset in listed_assets(session, job.world_id)
                ]
            row = session.execute(
                update(QuarterJob)
                .where(
                    col(QuarterJob.id) == job_id,
                    col(QuarterJob.lease) == lease,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                )
                .values(
                    **values,
                    status="running",
                    started_at=func.coalesce(col(QuarterJob.started_at), func.now()),
                    heartbeat_at=func.now(),
                    updated_at=func.now(),
                )
                .returning(
                    col(QuarterJob.world_id),
                    col(QuarterJob.step),
                    col(QuarterJob.replayed),
                    col(QuarterJob.planned),
                    col(QuarterJob.assets),
                    col(QuarterJob.started_at),
                )
            ).first()
            if row is None:
                session.rollback()
                return
            session.commit()
        world_id, step, replayed, planned, done_assets, started_at = row
        settled = {str(item["asset_id"]) for item in done_assets}
        todo = [
            (UUID(item["asset_id"]), str(item["name"]))
            for item in planned
            if item["asset_id"] not in settled
        ]
        try:
            outcome = time_machine.run_quarter(
                ctx.session_factory,
                ctx.runner,
                world_id=world_id,
                step=step,
                replayed=replayed,
                assets=todo,
                spend=ctx.spend,
                job_spent=lambda: world_spent_since(ctx.session_factory, world_id, started_at),
                llm_budget_usd=ctx.llm_budget_usd,
                job_cap_usd=ctx.job_cap_usd,
                run_cap=ctx.runs_per_hour + len(planned),
                spec=spec,
                before_payout=lambda _: self._hold(ctx, job_id, lease),
                on_asset=lambda result: self._record(ctx, job_id, lease, result),
            )
        except _JobLost:
            log.info("quarter job %s: this attempt was taken over or reset; stopping", job_id)
            return
        except Exception as exc:  # the job itself broke: a new start replays it
            log.error("quarter job %s failed: %s", job_id, _crash_report(exc))
            failed = f"job_failed:{type(exc).__name__}"
            self._end(ctx, job_id, lease, "failed", error=failed, release=True)
            return
        if outcome.stopped is not None:
            self._end(ctx, job_id, lease, "stopped", stopped=outcome.stopped)
        else:
            self._end(ctx, job_id, lease, "done")

    def _hold(self, ctx: QuarterContext, job_id: UUID, lease: UUID) -> None:
        """Before paying an asset: _JobLost unless this attempt still owns the running job."""
        with ctx.session_factory() as session:
            held = session.exec(
                select(QuarterJob.id).where(
                    QuarterJob.id == job_id,
                    QuarterJob.lease == lease,
                    QuarterJob.status == "running",
                )
            ).first()
        if held is None:
            raise _JobLost()

    def _record(
        self, ctx: QuarterContext, job_id: UUID, lease: UUID, result: time_machine.AssetOutcome
    ) -> None:
        """Append one settled asset's result and beat; _JobLost if this attempt lost the job."""
        item = bindparam("item", [asset_json(result)], type_=JSONB)
        with ctx.session_factory() as session:
            moved = session.execute(
                update(QuarterJob)
                .where(
                    col(QuarterJob.id) == job_id,
                    col(QuarterJob.lease) == lease,
                    col(QuarterJob.status) == "running",
                )
                .values(
                    assets=col(QuarterJob.assets).op("||")(item),
                    heartbeat_at=func.now(),
                    updated_at=func.now(),
                )
            )
            session.commit()
        if moved.rowcount != 1:  # type: ignore[attr-defined]
            raise _JobLost()

    def _end(
        self,
        ctx: QuarterContext,
        job_id: UUID,
        lease: UUID,
        status: JobStatus,
        *,
        stopped: str | None = None,
        error: str | None = None,
        release: bool = False,
    ) -> bool:
        """End this attempt's job; with `release` (a failed job), also release the claims it
        left running, so a replay retries them at once (it was the world's only job)."""
        return self._end_where(
            ctx,
            job_id,
            col(QuarterJob.lease) == lease,
            status,
            stopped=stopped,
            error=error,
            release=release,
        )

    def _end_where(
        self,
        ctx: QuarterContext,
        job_id: UUID,
        condition: Any,
        status: JobStatus,
        *,
        stopped: str | None = None,
        error: str | None = None,
        release: bool = False,
    ) -> bool:
        with ctx.session_factory() as session:
            world_id = session.exec(
                select(QuarterJob.world_id).where(QuarterJob.id == job_id)
            ).first()
            if world_id is None:
                return False
            _lock_world(session, world_id)
            ended = session.execute(
                update(QuarterJob)
                .where(
                    col(QuarterJob.id) == job_id,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                    condition,
                )
                .values(
                    status=status,
                    stopped=stopped,
                    error=error,
                    heartbeat_at=func.now(),
                    updated_at=func.now(),
                    finished_at=func.now(),
                )
                .returning(col(QuarterJob.step))
            ).first()
            if ended is not None and release:
                version = timeline_version(self.load_spec(), ended[0])
                time_machine.recover_claims(session, world_id, version)
            session.commit()
        return ended is not None

    # --- heartbeat ---

    def _beat_until_stopped(self) -> None:
        assert self.heartbeat_s is not None
        while not self._stop.wait(self.heartbeat_s):
            self.beat()

    def beat(self) -> None:
        """Mark every job this process holds as alive (queued in the pool or running)."""
        with self._lock:
            live = dict(self._live)
        by_factory: dict[int, tuple[Callable[[], Session], list[tuple[UUID, UUID]]]] = {}
        for job_id, held in live.items():
            entry = by_factory.setdefault(id(held.session_factory), (held.session_factory, []))
            entry[1].append((job_id, held.lease))
        for session_factory, jobs in by_factory.values():
            try:
                with session_factory() as session:
                    session.execute(
                        update(QuarterJob)
                        .where(
                            or_(
                                *(
                                    and_(col(QuarterJob.id) == job, col(QuarterJob.lease) == lease)
                                    for job, lease in jobs
                                )
                            ),
                            col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                        )
                        .values(heartbeat_at=func.now())
                    )
                    session.commit()
            except Exception as exc:  # the next beat tries again; a long outage makes it stale
                log.error("quarter job heartbeat failed: %s", _crash_report(exc))

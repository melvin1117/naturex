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
of a job is conditional on its lease, so an attempt that was taken over (or a job deleted by a
sandbox reset) stops after its current asset.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from concurrent.futures import Executor
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import and_, bindparam, func, or_, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from app.models import QUARTER_JOB_ACTIVE, QuarterJob, World
from app.services import time_machine
from app.services.monitoring import Spend, listed_assets
from app.services.rating_runs import InlineExecutor
from app.tools.scenarios import ScenarioSpec, load_scenario_spec, timeline_version

log = logging.getLogger(__name__)

JOB_STALE_AFTER = timedelta(minutes=2)
HEARTBEAT_EVERY_S = 20.0

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
    settled asset still beats)."""

    executor: Executor = field(default_factory=InlineExecutor)
    heartbeat_s: float | None = None
    load_spec: Callable[[], ScenarioSpec] = load_scenario_spec
    _live: dict[UUID, _Live] = field(default_factory=dict, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _beating: bool = field(default=False, init=False, repr=False)

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
            # The world's row lock orders this against another start and a sandbox reset.
            step = session.exec(
                select(World.time_machine_step).where(World.id == world_id).with_for_update()
            ).one_or_none()
            if step is None:
                raise LookupError(f"world {world_id} not found")
            active = _active_job(session, world_id)
            if active is not None:
                session.rollback()
                self.resume_if_stale(ctx, active.id)
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

    def resume_if_stale(self, ctx: QuarterContext, job_id: UUID) -> bool:
        """Take over an active job whose process died and resume it here. False when it's
        alive, finished or gone, or another caller took it over first."""
        new_lease = uuid4()
        stale = func.now() - JOB_STALE_AFTER
        with ctx.session_factory() as session:
            row = session.execute(
                update(QuarterJob)
                .where(
                    col(QuarterJob.id) == job_id,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                    col(QuarterJob.heartbeat_at) < stale,
                )
                .values(lease=new_lease, heartbeat_at=func.now(), updated_at=func.now())
                .returning(col(QuarterJob.world_id), col(QuarterJob.step))
            ).first()
            if row is None:
                session.rollback()
                return False
            world_id, step = row
            version = timeline_version(self.load_spec(), step)
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
            if self.heartbeat_s is not None and not self._beating:
                self._beating = True
                threading.Thread(
                    target=self._beat_forever, name="quarter-job-heartbeat", daemon=True
                ).start()
        self.executor.submit(self._run_and_forget, ctx, job_id, lease)

    def _run_and_forget(self, ctx: QuarterContext, job_id: UUID, lease: UUID) -> None:
        try:
            self.run(ctx, job_id, lease)
        finally:
            with self._lock:
                live = self._live.get(job_id)
                if live is not None and live.lease == lease:
                    del self._live[job_id]

    # --- running ---

    def run(self, ctx: QuarterContext, job_id: UUID, lease: UUID) -> None:
        """Run (or resume) the job under `lease`: re-rate and pay each planned asset it hasn't
        settled, then end it `done` or `stopped`; `failed` if the job itself raised."""
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
            if job.planned is None:
                job.planned = [
                    {"asset_id": str(asset.id), "name": asset.name}
                    for asset in listed_assets(session, job.world_id)
                ]
            world_id, step, replayed = job.world_id, job.step, job.replayed
            planned = list(job.planned)
            settled = {str(item["asset_id"]) for item in job.assets}
            job.status = "running"
            session.add(job)
            session.commit()
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
                llm_budget_usd=ctx.llm_budget_usd,
                job_cap_usd=ctx.job_cap_usd,
                run_cap=ctx.runs_per_hour + len(planned),
                spec=spec,
                on_asset=lambda result: self._record(ctx, job_id, lease, result),
            )
        except _JobLost:
            log.info("quarter job %s: this attempt was taken over or reset; stopping", job_id)
            return
        except Exception as exc:  # the job itself broke: a new start replays it
            log.exception("quarter job %s failed", job_id)
            failed = f"job_failed:{type(exc).__name__}"
            self._end(ctx, job_id, lease, "failed", error=failed, release=spec)
            return
        if outcome.stopped is not None:
            self._end(ctx, job_id, lease, "stopped", stopped=outcome.stopped)
        else:
            self._end(ctx, job_id, lease, "done")

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
        release: ScenarioSpec | None = None,
    ) -> None:
        """End the job; with `release` (a failed job), also release the claims it left
        running, so a replay retries them at once (it was the world's only job)."""
        with ctx.session_factory() as session:
            ended = session.execute(
                update(QuarterJob)
                .where(
                    col(QuarterJob.id) == job_id,
                    col(QuarterJob.lease) == lease,
                    col(QuarterJob.status).in_(QUARTER_JOB_ACTIVE),
                )
                .values(
                    status=status,
                    stopped=stopped,
                    error=error,
                    heartbeat_at=func.now(),
                    updated_at=func.now(),
                    finished_at=func.now(),
                )
                .returning(col(QuarterJob.world_id), col(QuarterJob.step))
            ).first()
            if ended is not None and release is not None:
                world_id, step = ended
                time_machine.recover_claims(session, world_id, timeline_version(release, step))
            session.commit()

    # --- heartbeat ---

    def _beat_forever(self) -> None:
        assert self.heartbeat_s is not None
        stop = threading.Event()
        while not stop.wait(self.heartbeat_s):
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
            except Exception:  # the next beat tries again; a long outage makes the job stale
                log.exception("quarter job heartbeat failed")

"""Time Machine, event injection, and call log. Tamper demo lives on the ledger router.

The Time Machine (`GET /admin/time-machine`, `POST /admin/simulate/quarter` and its job,
`GET /admin/simulate/quarter/{job_id}`) and event injection (`POST /admin/simulate/event`) are
operator actions: admins only, in their own world (`Action.OPERATE`; a demo admin persona
operates only its sandbox). Their logic is `app/services/time_machine.py` (T38) and
`app/services/quarter_jobs.py` (#201: a quarter runs in the background). `GET /admin/alerts`
shows the operator the alerts a simulation sent (T43). The agent trace is a read
(`Action.BROWSE`, ADR-0005 §3 matrix row 1).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlmodel import Session, col, func, select

from app.authz import (
    Action,
    AssetRef,
    DenyReason,
    OptionalActor,
    WorldRef,
    acting_world,
    asset_ref_in,
    denied,
    require,
)
from app.config import Settings
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.llm import DbCallLog
from app.models import Alert, AlertRecipient, Asset, LlmCall, QuarterJob
from app.schemas import (
    AlertKindOut,
    AssetRatingOut,
    EventOut,
    EventPresetOut,
    QuarterJobOut,
    QuarterJobRef,
    SentAlertOut,
    SimulatedAssetOut,
    SimulateEventRequest,
    SimulateEventResponse,
    SimulateQuarterRequest,
    TimeMachineOut,
    TimeMachineQuarter,
    TraceOut,
    TraceStep,
)
from app.services import quarter_jobs, time_machine
from app.services.alerts import NEWS_ALERT_SEVERITY
from app.services.quarter_jobs import QuarterContext, QuarterJobRunning, QuarterJobs
from app.services.rating_runs import (
    AssetNotRateable,
    RunError,
    RunInProgress,
    RunnerBusy,
    RunRateLimited,
    default_runner,
)
from app.tools.scenarios import ScenarioVersion, load_scenario_spec, timeline_version

router = APIRouter(prefix="/admin", tags=["admin"])


OPERATE = require(Action.OPERATE)
ADMIN_ONLY_RESPONSE: dict[int | str, dict[str, Any]] = denied(DenyReason.ADMIN_ONLY)


def injected_asset_ref(
    body: SimulateEventRequest, actor: OptionalActor, session: SessionDep
) -> AssetRef | None:
    """The asset an event is injected into, by `(world_id, id)` from the route's own body (parsed
    once, so the request schema is unchanged); None (a 404) outside the caller's world."""
    return asset_ref_in(session, acting_world(actor), body.asset_id)


def trace_target(
    actor: OptionalActor,
    session: SessionDep,
    asset_id: Annotated[UUID | None, Query()] = None,
) -> WorldRef | AssetRef | None:
    """The traced asset by `(world_id, id)` (None, a 404, if it isn't in the caller's world),
    or the world when no asset is given."""
    world_id = acting_world(actor)
    return WorldRef(world_id) if asset_id is None else asset_ref_in(session, world_id, asset_id)


QUARTER_WORKERS = 2
"""Quarter jobs running at once in this process (others wait, heartbeating, in the pool)."""


@dataclass(frozen=True, slots=True)
class TimeMachineEnv:
    """What the Time Machine runs with: sessions, the API's rating runner (its runs execute
    inline in the calling thread, under the runner's shared concurrency slots), the LLM spend
    and the quarter jobs (`jobs`: inline by default, so a test's quarter is done when its
    request returns)."""

    session_factory: Callable[[], Session]
    runner: time_machine.Runner
    spend: Callable[[], Decimal]
    jobs: QuarterJobs = field(default_factory=QuarterJobs)


_env: TimeMachineEnv | None = None
_env_lock = threading.Lock()


def get_time_machine_env() -> TimeMachineEnv:
    """The process-wide Time Machine environment: presets run in the request's thread and
    quarters on a small job pool, all on the API's runner, so their runs count against the same
    `MAX_PENDING_RUNS` as `POST /assets/{id}/rate`."""
    global _env
    with _env_lock:
        if _env is None:
            from app.db import engine

            def session_factory() -> Session:
                return Session(engine)

            _env = TimeMachineEnv(
                session_factory=session_factory,
                runner=default_runner(),
                spend=DbCallLog(session_factory).spent_usd,
                jobs=QuarterJobs(
                    executor=ThreadPoolExecutor(
                        max_workers=QUARTER_WORKERS, thread_name_prefix="time-machine"
                    ),
                    heartbeat_s=quarter_jobs.HEARTBEAT_EVERY_S,
                ),
            )
        return _env


TimeMachineEnvDep = Annotated[TimeMachineEnv, Depends(get_time_machine_env)]


def _quarter_out(quarter: ScenarioVersion, step: int) -> TimeMachineQuarter:
    return TimeMachineQuarter(
        step=step,
        period=quarter.period,
        scenario=quarter.scenario,
        data_version=quarter.data_version,
    )


def _simulated_version(version: ScenarioVersion) -> str:
    """A simulated quarter's or preset's `sim-…` label (the observed baseline has none)."""
    if version.data_version is None:
        raise RuntimeError(f"{version.period} is not a simulated version")
    return version.data_version


def _quarter_context(env: TimeMachineEnv, settings: Settings) -> QuarterContext:
    return QuarterContext(
        session_factory=env.session_factory,
        runner=env.runner,
        spend=env.spend,
        llm_budget_usd=Decimal(str(settings.llm_budget_usd)),
        job_cap_usd=Decimal(str(settings.monitor_job_budget_usd)),
        runs_per_hour=settings.rating_runs_per_world_per_hour,
    )


def _job_location(job_id: UUID) -> str:
    return f"/admin/simulate/quarter/{job_id}"


def _job_out(job: QuarterJob) -> QuarterJobOut:
    """The job as stored: every number is a stored row's, nothing is recomputed."""
    version = timeline_version(load_scenario_spec(), job.step)
    assets = [SimulatedAssetOut.model_validate(item) for item in job.assets]

    def count(status: str) -> int:
        return sum(1 for asset in assets if asset.status == status)

    return QuarterJobOut(
        id=job.id,
        status=cast(Any, job.status),
        error=job.error,
        asset_count=None if job.planned is None else len(job.planned),
        created_at=job.created_at,
        updated_at=job.updated_at,
        finished_at=job.finished_at,
        step=job.step,
        period=version.period,
        scenario=version.scenario,
        data_version=_simulated_version(version),
        payout_label=time_machine.payout_label(version),
        replayed=job.replayed,
        assets_rerated=count("rerated"),
        assets_failed=count("failed"),
        assets_skipped=count("skipped"),
        payouts=sum(1 for asset in assets if asset.payout == "paid"),
        alerts=sum(len(asset.alert_ids) for asset in assets),
        stopped=job.stopped,
        assets=assets,
    )


def _refuse_outside_sandbox(world_id: UUID) -> None:
    if not time_machine.available(world_id):
        raise HTTPException(status.HTTP_409_CONFLICT, time_machine.SANDBOX_ONLY)


def _rating_out(view: time_machine.RatingView | None) -> AssetRatingOut | None:
    if view is None:
        return None
    return AssetRatingOut(
        report_id=view.report_id,
        version=view.version,
        health_score=view.health_score,
        grade=view.grade,
        data_version=view.data_version,
        simulated=view.simulated,
        fair_value_per_share=view.fair_value_per_share,
        price=view.price,
    )


def _run_error(exc: Exception) -> HTTPException:
    """A rating run that couldn't start, as T27's `POST /assets/{id}/rate` answers it."""
    if isinstance(exc, RunInProgress):
        return HTTPException(
            status.HTTP_409_CONFLICT, "run_in_progress", headers={"Location": f"/runs/{exc.run_id}"}
        )
    if isinstance(exc, RunRateLimited):
        return HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            exc.code,
            headers={"Retry-After": str(exc.retry_after_s)},
        )
    if isinstance(exc, RunnerBusy):
        return HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "rating_busy",
            headers={"Retry-After": str(exc.retry_after_s)},
        )
    if isinstance(exc, AssetNotRateable):
        return HTTPException(status.HTTP_409_CONFLICT, exc.code)
    if isinstance(exc, time_machine.RerateFailed):
        return HTTPException(exc.status, exc.code, headers={"Location": f"/runs/{exc.run_id}"})
    if isinstance(exc, time_machine.TimeMachineRefused):
        return HTTPException(exc.status, exc.code)
    return HTTPException(status.HTTP_404_NOT_FOUND, "not_found")


@router.get(
    "/time-machine",
    response_model=TimeMachineOut,
    dependencies=[OPERATE],
    responses=ADMIN_ONLY_RESPONSE,
)
def get_time_machine(
    world: CurrentWorld, session: SessionDep, settings: SettingsDep
) -> TimeMachineOut:
    """The world's Time Machine quarter, the next one and the event presets (T38). `available`
    is false outside a sandbox (the live world): hide the controls, both actions answer 409
    `time_machine_sandbox_only`."""
    at = time_machine.state(session, world.id)
    available = time_machine.available(world.id)
    latest = quarter_jobs.latest_job(session, world.id)
    return TimeMachineOut(
        available=available,
        unavailable_reason=None if available else time_machine.SANDBOX_ONLY,
        step=at.step,
        current=_quarter_out(at.current, at.step),
        next=None if at.next is None else _quarter_out(at.next, at.step + 1),
        timeline=[_quarter_out(quarter, step) for step, quarter in enumerate(at.timeline)],
        presets=[
            EventPresetOut(
                preset=preset.name,
                label=preset.label,
                impact_type=preset.impact_type,
                direction=preset.direction,
                severity=preset.severity,
                alerts=preset.severity >= NEWS_ALERT_SEVERITY,
                description=preset.deltas.description,
            )
            for preset in time_machine.presets()
        ],
        local_jobs=settings.local_jobs,
        quarter_job=None
        if latest is None
        else QuarterJobRef(id=latest.id, status=cast(Any, latest.status), period=latest.period),
    )


@router.post(
    "/simulate/quarter",
    response_model=QuarterJobOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[OPERATE],
    responses={
        **ADMIN_ONLY_RESPONSE,
        409: {
            "description": "`quarter_mismatch` (not the world's next or current quarter; see "
            "`GET /admin/time-machine`), `timeline_end` (reset the demo to start again), "
            "`time_machine_sandbox_only` (not a sandbox: the live world), "
            "`local_jobs_disabled` (`LOCAL_JOBS=false`) or `quarter_job_running` (the world "
            "already runs a quarter; Location: that job)"
        },
    },
)
def simulate_quarter(
    body: SimulateQuarterRequest,
    world: CurrentWorld,
    session: SessionDep,
    settings: SettingsDep,
    env: TimeMachineEnvDep,
    actor: OptionalActor,
    response: Response,
) -> QuarterJobOut:
    """Advance the world to the next Time Machine quarter (or replay the current one), then
    re-rate every listed asset with that quarter's scenario, re-anchor prices, alert and pay the
    quarter's revenue in the background (T38, #201). Answers 202 with the job (Location: `GET
    /admin/simulate/quarter/{job_id}`) once the world has moved; poll it for each asset's result.
    Progress also streams as `rating_progress` events (trigger `time_machine`)."""
    _refuse_outside_sandbox(world.id)
    if not settings.local_jobs:
        raise HTTPException(status.HTTP_409_CONFLICT, "local_jobs_disabled")
    world_id = world.id
    session.commit()  # end the read transaction: the job uses its own sessions
    try:
        job = env.jobs.start(
            _quarter_context(env, settings),
            world_id,
            body.period,
            requested_by=actor.user_id if actor else None,
        )
    except QuarterJobRunning as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "quarter_job_running",
            headers={"Location": _job_location(exc.job_id)},
        ) from exc
    except time_machine.TimeMachineRefused as exc:
        raise _run_error(exc) from exc
    response.headers["Location"] = _job_location(job.id)
    stored = quarter_jobs.get_job(session, world_id, job.id)
    if stored is None:  # a sandbox reset deleted it already
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return _job_out(stored)


@router.get(
    "/simulate/quarter/{job_id}",
    response_model=QuarterJobOut,
    dependencies=[OPERATE],
    responses={**ADMIN_ONLY_RESPONSE, 404: {"description": "Not a quarter job of this world"}},
)
def get_quarter_job(
    job_id: UUID,
    world: CurrentWorld,
    session: SessionDep,
    settings: SettingsDep,
    env: TimeMachineEnvDep,
) -> QuarterJobOut:
    """A quarter job of the caller's world and each asset's result so far (#201). A job whose
    process died (no heartbeat for `JOB_STALE_AFTER`) is taken over and resumed by this read
    (with `LOCAL_JOBS=true`): the claims make it finish without re-rating or paying twice."""
    job = quarter_jobs.get_job(session, world.id, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    if settings.local_jobs and quarter_jobs.is_stale(session, job):
        session.commit()
        if env.jobs.resume_if_stale(_quarter_context(env, settings), job_id):
            session.expire_all()
            job = quarter_jobs.get_job(session, world.id, job_id)
            if job is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return _job_out(job)


@router.post(
    "/simulate/event",
    response_model=SimulateEventResponse,
    # On the asset, so an admin in the asset's community is refused (`conflict_of_interest`).
    dependencies=[require(Action.OPERATE, injected_asset_ref)],
    responses={
        **denied(DenyReason.ADMIN_ONLY, DenyReason.CONFLICT_OF_INTEREST),
        409: {
            "description": "`asset_not_listed`, `no_current_metrics` (no stored rating to start "
            "from), `time_machine_sandbox_only` (not a sandbox: the live world), "
            "`run_in_progress` (Location: the active run) or `stale_metrics` (the asset was "
            "re-rated meanwhile; Location: the run; nothing was stored, try again)"
        },
        429: {"description": "`rating_rate_limited` or `rating_global_limit`; see Retry-After"},
        503: {
            "description": "`rating_busy`, `llm_budget_exhausted`, `rerate_failed` "
            "(Location: the run; nothing was stored) or `event_not_recorded` (Location: the "
            "run; the re-rate is sealed but its event isn't stored)"
        },
    },
)
def simulate_event(
    body: SimulateEventRequest,
    world: CurrentWorld,
    session: SessionDep,
    settings: SettingsDep,
    env: TimeMachineEnvDep,
) -> SimulateEventResponse:
    """Inject an event preset into one asset of the caller's world: its deterministic effect on
    the metrics, a re-rate (alert and price re-anchor as for any re-rate), then the stored event
    and, for severity ≥ 4, its own alert (T38). The world's quarter doesn't move. Allowed with
    `LOCAL_JOBS=false` (one asset, one run)."""
    _refuse_outside_sandbox(world.id)
    world_id = world.id
    session.commit()
    try:
        outcome = time_machine.inject_event(
            env.session_factory,
            env.runner,
            world_id=world_id,
            asset_id=body.asset_id,
            preset_name=body.preset,
            spend=env.spend,
            llm_budget_usd=Decimal(str(settings.llm_budget_usd)),
        )
    except (LookupError, RunError, time_machine.TimeMachineRefused) as exc:
        raise _run_error(exc) from exc
    event = outcome.event
    return SimulateEventResponse(
        event=EventOut(
            id=event.id,
            asset_id=event.asset_id,
            source=event.source.value,
            title=event.title,
            url=event.url,
            published_at=event.published_at,
            impact_type=event.impact_type,
            direction=event.direction,
            severity=event.severity,
            summary=event.summary,
            created_at=event.created_at,
        ),
        preset=outcome.preset.name,
        period=outcome.version.period,
        data_version=_simulated_version(outcome.version),
        description=outcome.description,
        run_id=outcome.run_id,
        before=_rating_out(outcome.before),
        after=_rating_out(outcome.after),
        alert_ids=outcome.alert_ids,
        alert_created=bool(outcome.alert_ids),
    )


MAX_SENT_ALERTS = 50


@router.get(
    "/alerts",
    response_model=list[SentAlertOut],
    dependencies=[OPERATE],
    responses=ADMIN_ONLY_RESPONSE,
)
def get_sent_alerts(
    world: CurrentWorld,
    session: SessionDep,
    ids: Annotated[list[UUID], Query(min_length=1, max_length=MAX_SENT_ALERTS)],
) -> list[SentAlertOut]:
    """The given alerts of the caller's world as their recipients got them, with how many
    accounts each reached, newest first (T43: what a Time Machine quarter or event sent; its
    response lists the `alert_ids`). IDs from another world, or unknown, are left out."""
    recipients = (
        select(func.count())
        .where(
            AlertRecipient.world_id == Alert.world_id,
            AlertRecipient.alert_id == Alert.id,
        )
        .scalar_subquery()
    )
    rows = session.exec(
        select(Alert, Asset.name, recipients)
        .join(Asset, col(Asset.id) == col(Alert.asset_id))
        .where(
            Alert.world_id == world.id,
            Asset.world_id == world.id,
            col(Alert.id).in_(ids),
        )
        .order_by(col(Alert.created_at).desc(), col(Alert.id))
    ).all()
    return [
        SentAlertOut(
            id=alert.id,
            asset_id=alert.asset_id,
            asset_name=name,
            kind=cast(AlertKindOut, alert.kind),
            title=alert.title or "",
            message=alert.message or "",
            severity=alert.severity or 1,
            url=alert.url,
            report_id=alert.report_id,
            created_at=alert.created_at,
            recipients=count,
        )
        for alert, name, count in rows
    ]


@router.get("/trace", response_model=TraceOut, dependencies=[require(Action.BROWSE, trace_target)])
def get_trace(
    world: CurrentWorld, session: SessionDep, asset_id: Annotated[UUID | None, Query()] = None
) -> TraceOut:
    """Recent call metadata for this world or asset; for per-run tool spans use /runs/{id}/trace."""
    query = select(LlmCall).where(LlmCall.world_id == world.id)
    if asset_id is not None:
        query = query.where(LlmCall.asset_id == asset_id)
    calls = session.exec(query.order_by(col(LlmCall.id).desc()).limit(50)).all()
    return TraceOut(
        asset_id=asset_id,
        steps=[
            TraceStep(
                agent=call.agent,
                model=call.model,
                prompt_tokens=call.prompt_tokens,
                completion_tokens=call.completion_tokens,
                latency_ms=call.latency_ms,
                created_at=call.created_at,
                status=call.status,
            )
            for call in calls
        ],
    )

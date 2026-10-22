"""Time Machine (T38, stories D1–D4, dev-spec §9): "Next quarter" and event presets.

**Next quarter** moves a world one step along the scenario timeline (`data/demo_sites/
scenarios.json`: `baseline` 2026Q3 → `restoration` `sim-1` 2026Q4 → `encroachment` `sim-2`
2027Q1) and, for every listed asset, applies that quarter's scripted deltas for its site to the
asset's *current* metrics (`tools.scenarios.advance`; from a committed version that is exactly
the committed next version) and re-rates it through T27's `RatingRunner` (trigger
`time_machine`, run inline under the runner's shared slots). The run's `_store` raises the
re-rate alert (T75) and re-anchors the price (`market.anchoring`). Each asset's quarter is then
paid through T41's `pay_quarter` (T75's `pay_period`), labelled `<period>-<data_version>` (e.g.
`2026Q4-sim-1`) so a simulated quarter never collides with a real one. Assets without Time
Machine versions (new polygons) are `skipped` but still paid: the quarter passes for them too
(no other skip is paid).

**In the background (#201).** The API runs a quarter as a job (`services.quarter_jobs`): the
request moves the world and answers 202, and a worker runs `run_quarter` and records each asset's
result as it settles. `next_quarter` does both in the caller's thread (tests, scripts).

**Sandboxes only.** Like a reset, the Time Machine refuses the protected worlds (the template
and the live world) with `time_machine_sandbox_only`.

**Idempotent per world and quarter.** The request names the quarter (`period`). The world's
next quarter advances the world (`worlds.time_machine_step`, a conditional update, so two
concurrent requests advance it once); its current quarter replays it. Re-rates and payouts are
T75's claims (`monitor_runs`, jobs `rerate_all` / `payout`, period `tm-<data_version>`), so a
replay re-rates only what failed and never pays twice. An asset whose latest report already
carries the quarter's version isn't re-rated again (a job that died after the run sealed).

**Event presets** (fire, encroachment, drought, restoration, protection) apply one preset's
deltas to one asset's current metrics (a curated site's own scripted encroachment or
restoration, else the preset's generic effect) and re-rate it the same way. Every Time Machine
run names the report version its metrics came from, so a re-rate sealed meanwhile makes it fail
(`stale_metrics`) without writing. Once the re-rate is sealed, the event is stored (`events`,
source `admin`) with a public ledger entry carrying the run's ID (a failed store is retried once,
idempotently), and an event of severity ≥ 4 alerts the holders and community like a news item.
The world doesn't move.

**Budget.** Before each asset the LLM spend is checked (T75's `budget_stop`): the quarter stops
when the next asset could pass `LLM_BUDGET_USD` or `MONITOR_JOB_BUDGET_USD`; a preset is refused
(`llm_budget_exhausted`) when it could pass `LLM_BUDGET_USD`. Rating runs keep their own caps
(per world, global; the quarter raises the per-world one by its asset count).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import func, update
from sqlmodel import Session, col, select

from app.ledger import append
from app.market.anchoring import latest_price
from app.models import (
    Alert,
    Asset,
    AssetStatus,
    Event,
    EventSource,
    LedgerEntry,
    LedgerKind,
    Metrics,
    MonitorRun,
    Report,
    World,
)
from app.services import monitoring
from app.services.alerts import NEWS_ALERT_SEVERITY, AlertDraft, AlertKind, raise_alert
from app.services.monitoring import (
    PAYOUT,
    RERATE,
    RERATE_ESTIMATE_USD,
    Budget,
    SessionFactory,
    Spend,
    budget_stop,
    claim,
    claim_status,
    finish,
    listed_assets,
    pay_period,
    run_to_end,
)
from app.services.rating import latest_report
from app.services.rating_runs import STALE_METRICS, get_run
from app.tools.earth_obs import EarthObsMetrics, is_curated_site, load_site_metrics
from app.tools.scenarios import (
    EVENT_PRESETS,
    PRESET_NAMES,
    EventPreset,
    PresetName,
    ScenarioSpec,
    ScenarioVersion,
    advance,
    load_scenario_spec,
    preset_deltas,
    preset_version,
    timeline_version,
)
from app.worlds import PROTECTED_WORLDS

log = logging.getLogger(__name__)

CLAIM_PREFIX = "tm-"
NO_VERSION = "no_time_machine_version"
NO_METRICS = "no_current_metrics"
SANDBOX_ONLY = "time_machine_sandbox_only"
EVENT_NOT_RECORDED = "event_not_recorded"
INTERRUPTED = "interrupted"
"""A claim released by `recover_claims`: its job's process died before settling it."""
ALREADY_RATED = "already_rated"
"""A re-rate claim settled because the quarter's report was already sealed (an interrupted job)."""
PAYABLE_SKIPS = frozenset({NO_VERSION, NO_METRICS})
"""Skipped re-rates whose quarter is still paid: the asset just has no Time Machine version."""
STOPS = monitoring.RATE_LIMITED | {"rating_busy"}
"""Run errors that stop a quarter: every later asset would be refused too."""


class TimeMachineRefused(Exception):
    """The request can't run as asked; the router answers `status` with `code`."""

    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class Runner(Protocol):
    """The part of T27's `RatingRunner` the Time Machine uses: `inline=True` executes the run
    before `start` returns, under the runner's shared concurrency slots."""

    def start(
        self,
        world_id: UUID,
        asset_id: UUID,
        *,
        trigger: Literal["time_machine"],
        max_runs_per_hour: int | None = None,
        metrics: EarthObsMetrics | None = None,
        based_on_report: int | None = None,
        inline: bool = False,
    ) -> UUID: ...


# --- labels -------------------------------------------------------------------------------------


def claim_period(version: ScenarioVersion) -> str:
    """The `monitor_runs` period of a Time Machine quarter (never a real `YYYYQn`)."""
    return f"{CLAIM_PREFIX}{version.data_version}"


def payout_label(version: ScenarioVersion) -> str:
    """The payout's `quarter_label`: the quarter shown, then the simulated version."""
    return f"{version.period}-{version.data_version}"


# --- state --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TimeMachineState:
    step: int
    timeline: tuple[ScenarioVersion, ...]

    @property
    def current(self) -> ScenarioVersion:
        return self.timeline[self.step]

    @property
    def next(self) -> ScenarioVersion | None:
        return self.timeline[self.step + 1] if self.step + 1 < len(self.timeline) else None


def world_step(session: Session, world_id: UUID) -> int:
    step = session.exec(select(World.time_machine_step).where(World.id == world_id)).one_or_none()
    if step is None:
        raise LookupError(f"world {world_id} not found")
    return step


def state(session: Session, world_id: UUID, spec: ScenarioSpec | None = None) -> TimeMachineState:
    spec = spec or load_scenario_spec()
    step = min(world_step(session, world_id), len(spec.timeline) - 1)
    return TimeMachineState(step, spec.timeline)


def presets() -> list[EventPreset]:
    return [EVENT_PRESETS[name] for name in PRESET_NAMES]


def current_metrics(session: Session, world_id: UUID, asset: Asset) -> EarthObsMetrics | None:
    """The full metrics of the asset's latest report (see `metrics_of`)."""
    return metrics_of(session, world_id, asset, latest_report(session, world_id, asset.id))


def metrics_of(
    session: Session, world_id: UUID, asset: Asset, report: Report | None
) -> EarthObsMetrics | None:
    """The full metrics `report` was rated with: its stored document (since migration 0020),
    else, for a curated site, the committed version it was rated with. None when unknown (no
    report, or an older row of a new polygon)."""
    if report is None or report.metrics_id is None:
        return None
    row = session.get(Metrics, report.metrics_id)
    if row is None or row.world_id != world_id:
        return None
    if row.provenance is not None:
        try:
            return EarthObsMetrics.model_validate(row.provenance)
        except ValidationError:
            return None
    rated = ((report.auditor_json or {}).get("rating") or {}).get("metrics") or {}
    scenario = rated.get("scenario", "baseline")
    if not asset.site_key or not is_curated_site(asset.site_key):
        return None
    try:
        metrics = load_site_metrics(asset.site_key, scenario)
    except ValueError:
        return None
    return metrics if metrics.data_version == row.data_version else None


# --- results ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RatingView:
    """An asset's latest report and price at one moment, read from the DB."""

    report_id: UUID
    version: int
    health_score: Decimal | None
    grade: str | None
    data_version: str | None
    simulated: bool
    fair_value_per_share: Decimal | None
    price: Decimal | None


def rating_view(
    session: Session, world_id: UUID, asset_id: UUID, report: Report | None = None
) -> RatingView | None:
    """`report` (default: the asset's latest) and the asset's latest price."""
    report = report or latest_report(session, world_id, asset_id)
    if report is None:
        return None
    data_version = None
    if report.metrics_id is not None:
        data_version = session.exec(
            select(Metrics.data_version).where(Metrics.id == report.metrics_id)
        ).first()
    price = latest_price(session, world_id, asset_id)
    return RatingView(
        report_id=report.id,
        version=report.version,
        health_score=report.health_score,
        grade=report.grade,
        data_version=data_version,
        simulated=bool(data_version and data_version.startswith("sim-")),
        fair_value_per_share=report.fair_value_per_share,
        price=price.price if price else None,
    )


AssetStatusOut = Literal["rerated", "already_done", "skipped", "failed", "in_progress", "stopped"]
PayoutStatus = Literal["paid", "already_paid", "skipped", "failed"]
_OUTCOME: dict[str, AssetStatusOut] = {"done": "rerated", "skipped": "skipped", "failed": "failed"}


@dataclass(slots=True)
class AssetOutcome:
    asset_id: UUID
    name: str
    status: AssetStatusOut = "skipped"
    detail: str | None = None
    run_id: UUID | None = None
    before: RatingView | None = None
    after: RatingView | None = None
    alert_ids: list[UUID] = field(default_factory=list)
    payout: PayoutStatus | None = None
    payout_detail: str | None = None


@dataclass(slots=True)
class QuarterOutcome:
    step: int
    version: ScenarioVersion
    replayed: bool
    assets: list[AssetOutcome] = field(default_factory=list)
    stopped: str | None = None

    def count(self, status: AssetStatusOut) -> int:
        return sum(1 for asset in self.assets if asset.status == status)

    @property
    def payouts(self) -> int:
        return sum(1 for asset in self.assets if asset.payout == "paid")

    @property
    def alerts(self) -> int:
        return sum(len(asset.alert_ids) for asset in self.assets)


def _alert_ids(session: Session, world_id: UUID, *, report_id: UUID) -> list[UUID]:
    return list(
        session.exec(
            select(Alert.id).where(Alert.world_id == world_id, Alert.report_id == report_id)
        ).all()
    )


def available(world_id: UUID) -> bool:
    """The Time Machine runs in sandboxes only, like a reset: never in the template (copied into
    every sandbox, it must never hold payouts; T67) nor in the live world (real listings must
    never get simulated versions or payouts)."""
    return world_id not in PROTECTED_WORLDS


def _refuse_protected(world_id: UUID) -> None:
    if not available(world_id):
        raise TimeMachineRefused(SANDBOX_ONLY)


# --- next quarter -------------------------------------------------------------------------------


def quarter_target(step: int, period: str, spec: ScenarioSpec) -> tuple[int, bool]:
    """Where `period` takes a world at `step`: (its next step, False) or (`step`, True) for a
    replay of the current quarter. Raises TimeMachineRefused otherwise."""
    if 0 < step < len(spec.timeline) and spec.timeline[step].period == period:
        return step, True
    if step + 1 >= len(spec.timeline):
        later = period > spec.timeline[-1].period  # `YYYYQn` sorts in time order
        raise TimeMachineRefused("timeline_end" if later else "quarter_mismatch")
    if spec.timeline[step + 1].period != period:
        raise TimeMachineRefused("quarter_mismatch")
    return step + 1, False


def _move_to(session: Session, world_id: UUID, period: str, spec: ScenarioSpec) -> tuple[int, bool]:
    """Advance the world to `period` if it's the next quarter, or replay it if it's the current
    one. Returns (step, replayed); commits. Raises TimeMachineRefused otherwise."""
    for _ in range(2):  # a concurrent advance makes the second pass a replay
        step = world_step(session, world_id)
        target, replayed = quarter_target(step, period, spec)
        if replayed:
            session.commit()
            return step, True
        moved = session.execute(
            update(World)
            .where(col(World.id) == world_id, col(World.time_machine_step) == step)
            .values(time_machine_step=target)
        )
        session.commit()
        if moved.rowcount == 1:  # type: ignore[attr-defined]
            return target, False
    raise TimeMachineRefused("quarter_mismatch")


def _quarter_metrics(
    session: Session,
    world_id: UUID,
    asset: Asset,
    report: Report | None,
    version: ScenarioVersion,
    spec: ScenarioSpec,
) -> tuple[EarthObsMetrics | None, str | None]:
    site = spec.sites.get(asset.site_key or "")
    if site is None or version.scenario not in site:
        return None, NO_VERSION  # new polygons have no Time Machine versions (T60)
    current = metrics_of(session, world_id, asset, report)
    if current is None:
        return None, NO_METRICS
    return advance(current, site[version.scenario], version), None


def next_quarter(
    session_factory: SessionFactory,
    runner: Runner,
    *,
    world_id: UUID,
    period: str,
    spend: Spend,
    llm_budget_usd: Decimal,
    job_cap_usd: Decimal,
    runs_per_hour: int,
    spec: ScenarioSpec | None = None,
) -> QuarterOutcome:
    """Advance the world to `period` (or replay it) and re-rate and pay every listed asset, in
    the caller's thread (the API runs it as a background job instead: `services.quarter_jobs`).

    `runs_per_hour` is the world's usual run cap; the quarter's runs may exceed it by the
    number of listed assets, so one quarter always fits."""
    _refuse_protected(world_id)
    spec = spec or load_scenario_spec()
    with session_factory() as session:
        step, replayed = _move_to(session, world_id, period, spec)
        assets = [(asset.id, asset.name) for asset in listed_assets(session, world_id)]
    return run_quarter(
        session_factory,
        runner,
        world_id=world_id,
        step=step,
        replayed=replayed,
        assets=assets,
        spend=spend,
        llm_budget_usd=llm_budget_usd,
        job_cap_usd=job_cap_usd,
        run_cap=runs_per_hour + len(assets),
        spec=spec,
    )


def run_quarter(
    session_factory: SessionFactory,
    runner: Runner,
    *,
    world_id: UUID,
    step: int,
    replayed: bool,
    assets: Sequence[tuple[UUID, str]],
    spend: Spend,
    llm_budget_usd: Decimal,
    job_cap_usd: Decimal,
    run_cap: int,
    spec: ScenarioSpec,
    job_spent: Callable[[], Decimal] | None = None,
    before_payout: Callable[[AssetOutcome], None] | None = None,
    on_asset: Callable[[AssetOutcome], None] | None = None,
) -> QuarterOutcome:
    """Re-rate and pay `assets` (id, name) for the world's quarter at `step`, which the world
    already reached. `run_cap` is the per-world hourly run cap for the quarter's runs.
    `job_spent` is what this quarter has spent so far, for `job_cap_usd` (default: the global
    spend since this call began). `before_payout` sees each asset once its re-rate settled
    (it may raise to stop before paying it); `on_asset` once its payout settled too."""
    _refuse_protected(world_id)
    version = timeline_version(spec, step)
    outcome = QuarterOutcome(step, version, replayed)
    budget = Budget(llm_budget_usd, job_cap_usd, RERATE_ESTIMATE_USD)
    at_start = spend()
    for asset_id, name in assets:
        result = AssetOutcome(asset_id, name)
        if outcome.stopped is None:
            total = spend()
            mine = job_spent() if job_spent is not None else total - at_start
            outcome.stopped = budget_stop(budget, spent_total=total, spent_at_start=total - mine)
        if outcome.stopped is None:
            _rerate(session_factory, runner, world_id, version, spec, run_cap, result)
            if result.detail in STOPS:  # every later asset would be refused
                outcome.stopped = result.detail
        else:
            result.status, result.detail = "stopped", outcome.stopped
        if before_payout is not None:
            before_payout(result)
        _settle_payout(session_factory, world_id, version, result)
        outcome.assets.append(result)
        if on_asset is not None:
            on_asset(result)
    return outcome


def recover_claims(session: Session, world_id: UUID, version: ScenarioVersion) -> int:
    """Mark the quarter's `running` re-rate and payout claims in this world `failed`
    (`interrupted`), so the next pass retries them at once instead of after T75's
    `CLAIM_STALE_AFTER`. Only for a quarter job that failed or was taken over from a dead
    process: one quarter job per world, so every running claim of its period was that job's.
    Never pays twice (payouts are unique per quarter) nor re-rates twice (`_rerate` finds a
    re-rate sealed before the crash). Returns how many claims it released; the caller commits."""
    released = session.execute(
        update(MonitorRun)
        .where(
            col(MonitorRun.world_id) == world_id,
            col(MonitorRun.period) == claim_period(version),
            col(MonitorRun.job).in_((RERATE, PAYOUT)),
            col(MonitorRun.status) == "running",
        )
        .values(status="failed", detail=INTERRUPTED, updated_at=func.now())
    )
    return int(released.rowcount)  # type: ignore[attr-defined]


def _rerate(
    session_factory: SessionFactory,
    runner: Runner,
    world_id: UUID,
    version: ScenarioVersion,
    spec: ScenarioSpec,
    cap: int,
    result: AssetOutcome,
) -> None:
    period = claim_period(version)
    with session_factory() as session:
        if not claim(session, RERATE, period, world_id, result.asset_id):
            _claimed_elsewhere(session, world_id, period, result)
            return
        asset = session.exec(
            select(Asset).where(Asset.world_id == world_id, Asset.id == result.asset_id)
        ).one()
        report = latest_report(session, world_id, result.asset_id)
        result.before = rating_view(session, world_id, result.asset_id, report)
        sealed = result.before
        if sealed is not None and sealed.data_version == version.data_version:
            # Sealed before its claim was settled (an interrupted job): applying the quarter
            # again would apply its deltas twice.
            run_id = _report_run_id(report)
            finish(session, RERATE, period, result.asset_id, "done", ALREADY_RATED, run_id)
            result.status, result.run_id = "already_done", run_id
            result.before, result.after = None, sealed
            result.alert_ids = _alert_ids(session, world_id, report_id=sealed.report_id)
            return
        try:
            metrics, reason = _quarter_metrics(session, world_id, asset, report, version, spec)
        except ValueError:  # deterministic: a retry would fail the same way
            metrics, reason = None, "scenario_not_applicable"
    if metrics is None:
        with session_factory() as session:
            finish(session, RERATE, period, result.asset_id, "skipped", reason)
        result.status, result.detail, result.after = "skipped", reason, result.before
        return
    based_on = report.version if report is not None else None
    status, detail, run_id = run_to_end(
        session_factory,
        lambda: runner.start(
            world_id,
            result.asset_id,
            trigger="time_machine",
            max_runs_per_hour=cap,
            metrics=metrics,
            based_on_report=based_on,
            inline=True,
        ),
        world_id,
    )
    with session_factory() as session:
        finish(session, RERATE, period, result.asset_id, status, detail, run_id)
        result.after = rating_view(session, world_id, result.asset_id)
        if status == "done" and result.after is not None:
            result.alert_ids = _alert_ids(session, world_id, report_id=result.after.report_id)
    result.run_id = run_id
    result.status = _OUTCOME[status]
    result.detail = None if status == "done" else detail


def _report_run_id(report: Report | None) -> UUID | None:
    """The rating run that sealed `report`, from its stored run record (T27)."""
    run = ((report.auditor_json or {}).get("run") if report else None) or {}
    try:
        return UUID(str(run["run_id"]))
    except (KeyError, ValueError):
        return None


def _rerate_claim(session: Session, period: str, asset_id: UUID) -> MonitorRun | None:
    return session.exec(
        select(MonitorRun).where(
            MonitorRun.job == RERATE, MonitorRun.period == period, MonitorRun.asset_id == asset_id
        )
    ).first()


def _claimed_elsewhere(session: Session, world_id: UUID, period: str, result: AssetOutcome) -> None:
    """A replay: what an earlier request did with the asset's claim."""
    row = _rerate_claim(session, period, result.asset_id)
    if row is None:
        raise RuntimeError(f"claim {period} for asset {result.asset_id} vanished")
    result.after = rating_view(session, world_id, result.asset_id)
    if row.status == "done":
        result.status, result.run_id = "already_done", row.run_id
    elif row.status == "skipped":
        result.status, result.detail = "skipped", row.detail
    else:
        result.status, result.detail = "in_progress", "claimed"


def _settle_payout(
    session_factory: SessionFactory, world_id: UUID, version: ScenarioVersion, result: AssetOutcome
) -> None:
    """Pay the asset's quarter once its re-rate is settled: `done`, or `skipped` because the
    asset has no Time Machine version or current metrics (`PAYABLE_SKIPS`: the quarter passes
    for it too). Any other skip (not listed any more, not found…) isn't paid. Its own claim, as
    in T75."""
    period = claim_period(version)
    with session_factory() as session:
        rerate = _rerate_claim(session, period, result.asset_id)
        if rerate is None or not (
            rerate.status == "done"
            or (rerate.status == "skipped" and rerate.detail in PAYABLE_SKIPS)
        ):
            return
        if not claim(session, PAYOUT, period, world_id, result.asset_id):
            paid = claim_status(session, PAYOUT, period, result.asset_id)
            result.payout = "already_paid" if paid == "done" else "skipped"
            result.payout_detail = None if paid == "done" else f"payout_{paid}"
            return
    status: Literal["done", "failed", "skipped"]
    try:
        status, detail = pay_period(
            session_factory, world_id, result.asset_id, payout_label(version)
        )
    except Exception as exc:  # retried by the next replay
        log.exception("time machine payout failed for %s", result.asset_id)
        status, detail = "failed", f"payout_failed:{type(exc).__name__}"
    with session_factory() as session:
        finish(session, PAYOUT, period, result.asset_id, status, detail)
    if status == "failed":
        result.payout, result.payout_detail = "failed", detail
    elif detail == "paid":
        result.payout = "paid"
    elif detail == "already_paid":
        result.payout = "already_paid"
    else:
        result.payout, result.payout_detail = "skipped", detail


# --- event presets ------------------------------------------------------------------------------


@dataclass(slots=True)
class EventOutcome:
    event: Event
    preset: EventPreset
    version: ScenarioVersion
    description: str
    run_id: UUID | None
    before: RatingView | None
    after: RatingView | None
    alert_ids: list[UUID]


def _event_payload(
    event: Event, preset: EventPreset, version: ScenarioVersion, run_id: UUID | None
) -> dict[str, Any]:
    return {
        "source": EventSource.ADMIN.value,
        "preset": preset.name,
        "simulated": True,
        "data_version": version.data_version,
        "run_id": str(run_id) if run_id else None,
        "title": event.title,
        "impact_type": event.impact_type,
        "direction": event.direction,
        "severity": event.severity,
    }


def record_event(
    session: Session,
    asset: Asset,
    preset: EventPreset,
    version: ScenarioVersion,
    description: str,
    *,
    day: date,
    run_id: UUID | None = None,
) -> tuple[Event, Alert | None]:
    """Store an injected preset as an event (source `admin`, labelled simulated) with its public
    ledger entry (carrying the re-rate's `run_id`) and, for severity >= 4, its own alert to the
    holders and community, in the caller's transaction."""
    event = Event(
        world_id=asset.world_id,
        asset_id=asset.id,
        source=EventSource.ADMIN,
        title=f"{preset.label} at {asset.name} (simulated)"[:200],
        url=None,
        published_at=day,
        impact_type=preset.impact_type,
        direction=preset.direction,
        severity=preset.severity,
        summary=f"Time Machine event, simulated: {description}",
    )
    session.add(event)
    session.flush()
    append(
        session,
        world_id=asset.world_id,
        asset_id=asset.id,
        kind=LedgerKind.EVENT,
        payload=_event_payload(event, preset, version, run_id),
        ref_id=event.id,
    )
    alert = None
    if preset.severity >= NEWS_ALERT_SEVERITY:
        alert = raise_alert(
            session,
            asset.world_id,
            asset,
            AlertDraft(
                kind=AlertKind.NEWS,
                title=event.title or preset.label,
                message=event.summary or description,
                severity=preset.severity,
                dedupe_key=_event_dedupe_key(event.id),
            ),
        )
    return event, alert


def _event_dedupe_key(event_id: UUID) -> str:
    return f"event:{event_id}"


def recorded_event(session: Session, world_id: UUID, asset_id: UUID, run_id: UUID) -> Event | None:
    """The event already stored for the preset re-rated by `run_id`, if any."""
    event_id = session.exec(
        select(LedgerEntry.ref_id).where(
            LedgerEntry.world_id == world_id,
            LedgerEntry.asset_id == asset_id,
            LedgerEntry.kind == LedgerKind.EVENT,
            col(LedgerEntry.payload)["run_id"].astext == str(run_id),
        )
    ).first()
    return None if event_id is None else session.get(Event, event_id)


@dataclass(frozen=True, slots=True)
class _Injection:
    world_id: UUID
    asset_id: UUID
    preset: EventPreset
    version: ScenarioVersion
    description: str
    day: date
    run_id: UUID
    report_id: UUID


def _store_event(
    session_factory: SessionFactory, job: _Injection
) -> tuple[Event, list[UUID], RatingView | None]:
    """Store the preset's event once per run (a retry finds the first one), and read the
    re-rate's and the event's alerts and the asset's rating after it."""
    with session_factory() as session:
        event = recorded_event(session, job.world_id, job.asset_id, job.run_id)
        if event is None:
            asset = session.exec(
                select(Asset).where(Asset.world_id == job.world_id, Asset.id == job.asset_id)
            ).one()
            event, _ = record_event(
                session,
                asset,
                job.preset,
                job.version,
                job.description,
                day=job.day,
                run_id=job.run_id,
            )
            session.commit()
            session.refresh(event)
        alert_ids = _alert_ids(session, job.world_id, report_id=job.report_id)
        alert_ids += session.exec(
            select(Alert.id).where(
                Alert.world_id == job.world_id, Alert.dedupe_key == _event_dedupe_key(event.id)
            )
        ).all()
        return event, alert_ids, rating_view(session, job.world_id, job.asset_id)


def _store_event_with_retry(
    session_factory: SessionFactory, job: _Injection
) -> tuple[Event, list[UUID], RatingView | None]:
    """The re-rate is already sealed: retry storing its event once (idempotent per run), then
    give up with a recoverable error naming the run."""
    try:
        return _store_event(session_factory, job)
    except Exception:
        log.exception("time machine event for run %s not stored; retrying once", job.run_id)
    try:
        return _store_event(session_factory, job)
    except Exception as exc:
        log.error(
            "recoverable: run %s re-rated asset %s for preset %s but its event isn't stored; "
            "store it with `record_event(..., run_id=%s)`",
            job.run_id,
            job.asset_id,
            job.preset.name,
            job.run_id,
        )
        raise RerateFailed(job.run_id, None, EVENT_NOT_RECORDED) from exc


def inject_event(
    session_factory: SessionFactory,
    runner: Runner,
    *,
    world_id: UUID,
    asset_id: UUID,
    preset_name: PresetName,
    spend: Spend,
    llm_budget_usd: Decimal,
    spec: ScenarioSpec | None = None,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> EventOutcome:
    """Apply a preset to one listed asset, re-rate it, then store the event (see the module
    docstring). Raises LookupError (not in this world), TimeMachineRefused (`RerateFailed` with
    `stale_metrics` when the asset was re-rated after its metrics were read: nothing is stored),
    or the runner's start errors (`RunInProgress`, `RunRateLimited`, `RunnerBusy`,
    `AssetNotRateable`)."""
    _refuse_protected(world_id)
    spec = spec or load_scenario_spec()
    preset = EVENT_PRESETS[preset_name]
    with session_factory() as session:
        at = state(session, world_id, spec)
        asset = session.exec(
            select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
        ).one_or_none()
        if asset is None:
            raise LookupError(f"asset {asset_id} not found in world {world_id}")
        if asset.status is not AssetStatus.LISTED:
            raise TimeMachineRefused("asset_not_listed")
        report = latest_report(session, world_id, asset_id)
        current = metrics_of(session, world_id, asset, report)
        if report is None or current is None:
            raise TimeMachineRefused(NO_METRICS)
        deltas = preset_deltas(preset_name, asset.site_key, spec)
        version = preset_version(preset_name, at.step, at.current.period)
        metrics = advance(current, deltas, version)
        before = rating_view(session, world_id, asset_id, report)
        based_on = report.version
    budget = Budget(llm_budget_usd, llm_budget_usd, RERATE_ESTIMATE_USD)
    stop = budget_stop(budget, spent_total=spend(), spent_at_start=Decimal(0))
    if stop is not None:
        raise TimeMachineRefused(stop, 503)
    run_id = runner.start(
        world_id,
        asset_id,
        trigger="time_machine",
        metrics=metrics,
        based_on_report=based_on,
        inline=True,
    )
    with session_factory() as session:
        run = get_run(session, world_id, run_id)
    if run is None or run.report_id is None:
        error = run.error if run else None
        if error == STALE_METRICS:  # re-rated since the metrics were read
            raise RerateFailed(run_id, error, STALE_METRICS, 409)
        raise RerateFailed(run_id, error)
    event, alert_ids, after = _store_event_with_retry(
        session_factory,
        _Injection(
            world_id=world_id,
            asset_id=asset_id,
            preset=preset,
            version=version,
            description=deltas.description,
            day=now().date(),
            run_id=run_id,
            report_id=run.report_id,
        ),
    )
    return EventOutcome(
        event=event,
        preset=preset,
        version=version,
        description=deltas.description,
        run_id=run_id,
        before=before,
        after=after,
        alert_ids=alert_ids,
    )


class RerateFailed(TimeMachineRefused):
    """A preset's re-rate went wrong; `Location` names the run. `rerate_failed` (503): no report
    was sealed, nothing stored; `stale_metrics` (409): the asset was re-rated after the preset
    read its metrics, nothing stored; `event_not_recorded` (503): the re-rate is sealed but its
    event couldn't be stored (logged as recoverable)."""

    def __init__(
        self, run_id: UUID, error: str | None, code: str = "rerate_failed", status: int = 503
    ) -> None:
        super().__init__(code, status)
        self.run_id = run_id
        self.error = error

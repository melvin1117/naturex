"""Time Machine (T38, stories D1–D4, dev-spec §9): "Next quarter" and event presets.

**Next quarter** moves a world one step along the scenario timeline (`data/demo_sites/
scenarios.json`: `baseline` 2026Q3 → `restoration` `sim-1` 2026Q4 → `encroachment` `sim-2`
2027Q1) and, for every listed asset, applies that quarter's scripted deltas for its site to the
asset's *current* metrics (`tools.scenarios.advance`; from a committed version that is exactly
the committed next version) and re-rates it through T27's `RatingRunner` (trigger
`time_machine`, run inline). The run's `_store` raises the re-rate alert (T75) and re-anchors
the price (`market.anchoring`). Each asset's quarter is then paid through T41's `pay_quarter`
(T75's `pay_period`), labelled `<period>-<data_version>` (e.g. `2026Q4-sim-1`) so a simulated
quarter never collides with a real one. Assets without Time Machine versions (new polygons) are
`skipped` but still paid: the quarter passes for them too.

**Idempotent per world and quarter.** The request names the quarter (`period`). The world's
next quarter advances the world (`worlds.time_machine_step`, a conditional update, so two
concurrent requests advance it once); its current quarter replays it. Re-rates and payouts are
T75's claims (`monitor_runs`, jobs `rerate_all` / `payout`, period `tm-<data_version>`), so a
replay re-rates only what failed and never pays twice.

**Event presets** (fire, encroachment, drought, restoration, protection) apply one preset's
deltas to one asset's current metrics (a curated site's own scripted encroachment or
restoration, else the preset's generic effect) and re-rate it the same way. Once the re-rate is
sealed, the event is stored (`events`, source `admin`) with a public ledger entry, and an event
of severity ≥ 4 alerts the holders and community like a news item. The world doesn't move.

**Budget.** Before each asset the LLM spend is checked (T75's `budget_stop`): the quarter stops
when the next asset could pass `LLM_BUDGET_USD` or `MONITOR_JOB_BUDGET_USD`; a preset is refused
(`llm_budget_exhausted`) when it could pass `LLM_BUDGET_USD`. Rating runs keep their own caps
(per world, global; the quarter raises the per-world one by its asset count).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import update
from sqlmodel import Session, col, select

from app.ledger import append
from app.market.anchoring import latest_price
from app.models import (
    Alert,
    Asset,
    AssetStatus,
    Event,
    EventSource,
    LedgerKind,
    Metrics,
    MonitorRun,
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
from app.services.rating_runs import get_run
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
from app.worlds import WORLD_ID as TEMPLATE_WORLD_ID

log = logging.getLogger(__name__)

CLAIM_PREFIX = "tm-"
NO_VERSION = "no_time_machine_version"
NO_METRICS = "no_current_metrics"
_RUN_IN_DETAIL = re.compile(r"run=([0-9a-f-]{36})")


class TimeMachineRefused(Exception):
    """The request can't run as asked; the router answers `status` with `code`."""

    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class Runner(Protocol):
    """The part of T27's `RatingRunner` the Time Machine uses; `start` must run inline."""

    def start(
        self,
        world_id: UUID,
        asset_id: UUID,
        *,
        trigger: Literal["time_machine"],
        max_runs_per_hour: int | None = None,
        metrics: EarthObsMetrics | None = None,
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
    """The full metrics of the asset's latest report: its stored document (since migration
    0020), else, for a curated site, the committed version it was rated with. None when unknown
    (no report, or an older row of a new polygon)."""
    report = latest_report(session, world_id, asset.id)
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


def rating_view(session: Session, world_id: UUID, asset_id: UUID) -> RatingView | None:
    report = latest_report(session, world_id, asset_id)
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

    def count(self, status: str) -> int:
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


def _refuse_template(world_id: UUID) -> None:
    # The template is copied into every sandbox and must never hold payouts (T67).
    if world_id == TEMPLATE_WORLD_ID:
        raise TimeMachineRefused("template_world")


# --- next quarter -------------------------------------------------------------------------------


def _move_to(session: Session, world_id: UUID, period: str, spec: ScenarioSpec) -> tuple[int, bool]:
    """Advance the world to `period` if it's the next quarter, or replay it if it's the current
    one. Returns (step, replayed); commits. Raises TimeMachineRefused otherwise."""
    for _ in range(2):  # a concurrent advance makes the second pass a replay
        step = world_step(session, world_id)
        if step > 0 and step < len(spec.timeline) and spec.timeline[step].period == period:
            session.commit()
            return step, True
        if step + 1 >= len(spec.timeline):
            later = period > spec.timeline[-1].period  # `YYYYQn` sorts in time order
            raise TimeMachineRefused("timeline_end" if later else "quarter_mismatch")
        if spec.timeline[step + 1].period != period:
            raise TimeMachineRefused("quarter_mismatch")
        moved = session.execute(
            update(World)
            .where(col(World.id) == world_id, col(World.time_machine_step) == step)
            .values(time_machine_step=step + 1)
        )
        session.commit()
        if moved.rowcount == 1:  # type: ignore[attr-defined]
            return step + 1, False
    raise TimeMachineRefused("quarter_mismatch")


def _quarter_metrics(
    session: Session, world_id: UUID, asset: Asset, version: ScenarioVersion, spec: ScenarioSpec
) -> tuple[EarthObsMetrics | None, str | None]:
    site = spec.sites.get(asset.site_key or "")
    if site is None or version.scenario not in site:
        return None, NO_VERSION  # new polygons have no Time Machine versions (T60)
    current = current_metrics(session, world_id, asset)
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
    """Advance the world to `period` (or replay it) and re-rate and pay every listed asset.

    `runs_per_hour` is the world's usual run cap; the quarter's runs may exceed it by the
    number of listed assets, so one quarter always fits."""
    _refuse_template(world_id)
    spec = spec or load_scenario_spec()
    with session_factory() as session:
        step, replayed = _move_to(session, world_id, period, spec)
        assets = [(asset.id, asset.name) for asset in listed_assets(session, world_id)]
    version = timeline_version(spec, step)
    outcome = QuarterOutcome(step, version, replayed)
    budget = Budget(llm_budget_usd, job_cap_usd, RERATE_ESTIMATE_USD)
    at_start = spend()
    cap = runs_per_hour + len(assets)
    for asset_id, name in assets:
        result = AssetOutcome(asset_id, name)
        if outcome.stopped is None:
            outcome.stopped = budget_stop(budget, spent_total=spend(), spent_at_start=at_start)
        if outcome.stopped is None:
            _rerate(session_factory, runner, world_id, version, spec, cap, result)
            if result.detail in monitoring.RATE_LIMITED:  # every later asset would be refused
                outcome.stopped = result.detail
        else:
            result.status, result.detail = "stopped", outcome.stopped
        _settle_payout(session_factory, world_id, version, result)
        outcome.assets.append(result)
    return outcome


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
        result.before = rating_view(session, world_id, result.asset_id)
        try:
            metrics, reason = _quarter_metrics(session, world_id, asset, version, spec)
        except ValueError:  # deterministic: a retry would fail the same way
            metrics, reason = None, "scenario_not_applicable"
    if metrics is None:
        with session_factory() as session:
            finish(session, RERATE, period, result.asset_id, "skipped", reason)
        result.status, result.detail, result.after = "skipped", reason, result.before
        return
    status, detail, run_id = run_to_end(
        session_factory,
        lambda: runner.start(
            world_id,
            result.asset_id,
            trigger="time_machine",
            max_runs_per_hour=cap,
            metrics=metrics,
        ),
        world_id,
    )
    with session_factory() as session:
        finish(session, RERATE, period, result.asset_id, status, detail)
        result.after = rating_view(session, world_id, result.asset_id)
        if status == "done" and result.after is not None:
            result.alert_ids = _alert_ids(session, world_id, report_id=result.after.report_id)
    result.run_id = run_id
    result.status = _OUTCOME[status]
    result.detail = None if status == "done" else detail


def _claimed_elsewhere(session: Session, world_id: UUID, period: str, result: AssetOutcome) -> None:
    """A replay: what an earlier request did with the asset's claim."""
    row = session.exec(
        select(MonitorRun).where(
            MonitorRun.job == RERATE,
            MonitorRun.period == period,
            MonitorRun.asset_id == result.asset_id,
        )
    ).one()
    result.after = rating_view(session, world_id, result.asset_id)
    if row.status == "done":
        result.status = "already_done"
        found = _RUN_IN_DETAIL.search(row.detail or "")
        result.run_id = UUID(found[1]) if found else None
    elif row.status == "skipped":
        result.status, result.detail = "skipped", row.detail
    else:
        result.status, result.detail = "in_progress", "claimed"


def _settle_payout(
    session_factory: SessionFactory, world_id: UUID, version: ScenarioVersion, result: AssetOutcome
) -> None:
    """Pay the asset's quarter once its re-rate is settled (`done`, or `skipped`: the quarter
    passes for an asset without Time Machine versions too). Its own claim, as in T75."""
    period = claim_period(version)
    with session_factory() as session:
        if claim_status(session, RERATE, period, result.asset_id) not in ("done", "skipped"):
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


def _event_payload(event: Event, preset: EventPreset, version: ScenarioVersion) -> dict[str, Any]:
    return {
        "source": EventSource.ADMIN.value,
        "preset": preset.name,
        "simulated": True,
        "data_version": version.data_version,
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
) -> tuple[Event, Alert | None]:
    """Store an injected preset as an event (source `admin`, labelled simulated) with its public
    ledger entry and, for severity >= 4, its own alert to the holders and community, in the
    caller's transaction."""
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
        payload=_event_payload(event, preset, version),
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
                dedupe_key=f"event:{event.id}",
            ),
        )
    return event, alert


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
    docstring). Raises LookupError (not in this world), TimeMachineRefused, or the runner's
    start errors (`RunInProgress`, `RunRateLimited`, `RunnerBusy`, `AssetNotRateable`)."""
    _refuse_template(world_id)
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
        current = current_metrics(session, world_id, asset)
        if current is None:
            raise TimeMachineRefused(NO_METRICS)
        deltas = preset_deltas(preset_name, asset.site_key, spec)
        version = preset_version(preset_name, at.step, at.current.period)
        metrics = advance(current, deltas, version)
        before = rating_view(session, world_id, asset_id)
    budget = Budget(llm_budget_usd, llm_budget_usd, RERATE_ESTIMATE_USD)
    stop = budget_stop(budget, spent_total=spend(), spent_at_start=Decimal(0))
    if stop is not None:
        raise TimeMachineRefused(stop, 503)
    run_id = runner.start(world_id, asset_id, trigger="time_machine", metrics=metrics)
    with session_factory() as session:
        run = get_run(session, world_id, run_id)
        if run is None or run.report_id is None:
            raise RerateFailed(run_id, run.error if run else None)
        alert_ids = _alert_ids(session, world_id, report_id=run.report_id)
        asset = session.exec(
            select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
        ).one()
        event, alert = record_event(
            session, asset, preset, version, deltas.description, day=now().date()
        )
        if alert is not None:
            alert_ids.append(alert.id)
        session.commit()
        session.refresh(event)
        after = rating_view(session, world_id, asset_id)
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
    """The preset's re-rate sealed no report; nothing else was written."""

    def __init__(self, run_id: UUID, error: str | None) -> None:
        super().__init__("rerate_failed", 503)
        self.run_id = run_id
        self.error = error

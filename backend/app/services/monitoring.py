"""The monitoring loop (T75, dev-spec §9): `rerate_all` and `news_sweep`.

- **`rerate_all`** re-rates every listed asset of a world through the rating service (T27's
  `RatingRunner`, trigger `scheduled`), which raises the re-rate alerts with the sealed report
  (`services.alerts.alert_on_rerate`), then pays the quarter's revenue (T41's `pay_quarter`,
  once per asset and quarter).
- **`news_sweep`** runs News Scout per listed asset, stores new relevant events (`events`) and
  raises an alert for each event of severity ≥ 4 (`services.alerts.news_alert`).

**Idempotent.** Each job claims `(job, period, asset)` in `monitor_runs` with one
`INSERT … ON CONFLICT` (the primary key picks the winner): a `done` or `skipped` claim is never
redone, a running one is left alone unless it went stale (`CLAIM_STALE_AFTER`, e.g. a crashed
job), and a `failed` one is retried by the next run. Alerts are deduplicated by cause and payouts
by quarter, so even a retried asset never alerts or pays twice.

**Budget-capped.** Before each asset the job checks the LLM spend (`llm_calls`, the same ledger
`LLM_BUDGET_USD` caps): it stops when the next asset's worst case (`RERATE_ESTIMATE_USD`,
`NEWS_ESTIMATE_USD`) could pass `LLM_BUDGET_USD` or this run's own `MONITOR_JOB_BUDGET_USD`.
The rating runs' own caps (one per asset, per world, global per hour) still apply; a global cap
stops the job.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal, Protocol
from uuid import UUID

from sqlalchemy import func, or_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, col, select

from app.agents.news_scout import NewsScoutAsset
from app.market.revenue import CommunityStakeMissing, PayoutAlreadyApplied, pay_quarter
from app.models import Alert, Asset, AssetStatus, Event, EventSource, MonitorRun
from app.schemas import NewsScoutItem, NewsScoutOutput, RatingRunStatus
from app.services.alerts import news_alert, raise_alert, safe_url
from app.services.rating import latest_report
from app.services.rating_runs import (
    AssetNotRateable,
    RunInProgress,
    RunnerBusy,
    RunRateLimited,
    get_run,
)

log = logging.getLogger(__name__)

Job = Literal["rerate_all", "news_sweep", "payout"]
RERATE: Job = "rerate_all"
NEWS_SWEEP: Job = "news_sweep"
PAYOUT: Job = "payout"
CLAIM_STALE_AFTER = timedelta(hours=1)
# Worst-case LLM spend of one asset, checked before starting it (generous on purpose).
RERATE_ESTIMATE_USD = Decimal("0.50")
NEWS_ESTIMATE_USD = Decimal("0.05")
DETAIL_MAX = 200
RATE_LIMITED = frozenset({"rating_rate_limited", "rating_global_limit"})

SessionFactory = Callable[[], Session]


# --- pure ---------------------------------------------------------------------------------------


def quarter_label(day: date) -> str:
    """`2026Q4`: the period of `rerate_all` and the payout's `quarter_label`."""
    return f"{day.year}Q{(day.month - 1) // 3 + 1}"


def day_label(day: date) -> str:
    """`2026-10-19`: the period of `news_sweep`."""
    return day.isoformat()


_QUARTER_PERIOD = re.compile(r"\d{4}Q[1-4]")
_DAY_PERIOD = re.compile(r"\d{4}-\d{2}-\d{2}")


def parse_quarter_period(value: str, today: date) -> str:
    """A `rerate_all` period: exactly `YYYYQn`, not after `today`'s quarter. Raises ValueError.

    One spelling per quarter keeps claims and payouts keyed on the same label."""
    if not _QUARTER_PERIOD.fullmatch(value):
        raise ValueError(f"period must look like 2026Q4, got {value!r}")
    if value > quarter_label(today):
        raise ValueError(f"period {value} is in the future")
    return value


def parse_day_period(value: str, today: date) -> str:
    """A `news_sweep` period: an ISO date (`YYYY-MM-DD`), not after `today`. Raises ValueError."""
    if not _DAY_PERIOD.fullmatch(value):
        raise ValueError(f"period must be an ISO date like 2026-10-19, got {value!r}")
    day = date.fromisoformat(value)  # ValueError for 2026-02-30
    if day > today:
        raise ValueError(f"period {value} is in the future")
    return value


def parse_job_cap(value: str) -> Decimal:
    """A `--max-usd` cap: a finite, non-negative amount. Raises ValueError."""
    try:
        cap = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"not an amount: {value!r}") from exc
    if not cap.is_finite() or cap < 0:
        raise ValueError(f"the cap must be a finite amount ≥ 0, got {value!r}")
    return cap


@dataclass(frozen=True, slots=True)
class Budget:
    llm_budget_usd: Decimal
    """`LLM_BUDGET_USD`: the global hard cap."""
    job_cap_usd: Decimal
    """`MONITOR_JOB_BUDGET_USD`: this run's own cap."""
    per_asset_usd: Decimal
    """The worst case of the next asset."""


def budget_stop(budget: Budget, *, spent_total: Decimal, spent_at_start: Decimal) -> str | None:
    """Why the job must stop before the next asset, or None to go on.

    `spent_total` is all LLM spend so far (every caller); `spent_at_start` the same figure when
    the job began, so the difference is (at most) this job's spend.
    """
    if spent_total + budget.per_asset_usd > budget.llm_budget_usd:
        return "llm_budget_exhausted"
    if (spent_total - spent_at_start) + budget.per_asset_usd > budget.job_cap_usd:
        return "job_budget_exhausted"
    return None


# --- claims -------------------------------------------------------------------------------------


def claim(session: Session, job: Job, period: str, world_id: UUID, asset_id: UUID) -> bool:
    """Atomically claim the asset for this job and period; False if it's done, skipped or in
    progress elsewhere. Commits."""
    table = MonitorRun.__table__  # type: ignore[attr-defined]
    stale = func.now() - CLAIM_STALE_AFTER
    stmt = (
        pg_insert(table)
        .values(job=job, period=period, asset_id=asset_id, world_id=world_id, status="running")
        .on_conflict_do_update(
            index_elements=["job", "period", "asset_id"],
            set_={"status": "running", "detail": None, "updated_at": func.now()},
            where=or_(
                table.c.status == "failed",
                (table.c.status == "running") & (table.c.updated_at < stale),
            ),
        )
        .returning(table.c.job)
    )
    won = session.execute(stmt).first() is not None
    session.commit()
    return won


def finish(
    session: Session,
    job: Job,
    period: str,
    asset_id: UUID,
    status: Literal["done", "failed", "skipped"],
    detail: str | None = None,
) -> None:
    session.execute(
        update(MonitorRun)
        .where(
            col(MonitorRun.job) == job,
            col(MonitorRun.period) == period,
            col(MonitorRun.asset_id) == asset_id,
        )
        .values(
            status=status,
            detail=detail[:DETAIL_MAX] if detail else None,
            updated_at=func.now(),
        )
    )
    session.commit()


# --- shared -------------------------------------------------------------------------------------


@dataclass(slots=True)
class JobReport:
    job: Job
    period: str
    world_id: UUID
    done: list[UUID] = field(default_factory=list)
    skipped: list[tuple[UUID, str]] = field(default_factory=list)
    failed: list[tuple[UUID, str]] = field(default_factory=list)
    stopped: str | None = None
    alerts: int = 0
    events: int = 0
    payouts: int = 0

    def summary(self) -> str:
        return (
            f"{self.job} {self.period} world={self.world_id}: done={len(self.done)} "
            f"skipped={len(self.skipped)} failed={len(self.failed)} alerts={self.alerts} "
            f"events={self.events} payouts={self.payouts}"
            + (f" stopped={self.stopped}" if self.stopped else "")
        )


def listed_assets(session: Session, world_id: UUID) -> list[Asset]:
    """The world's listed assets in a stable order (suspended ones aren't monitored)."""
    return list(
        session.exec(
            select(Asset)
            .where(Asset.world_id == world_id, Asset.status == AssetStatus.LISTED)
            .order_by(col(Asset.name), col(Asset.id))
        ).all()
    )


class Runner(Protocol):
    """The part of T27's `RatingRunner` the job uses (it executes the run before returning)."""

    def start(
        self,
        world_id: UUID,
        asset_id: UUID,
        *,
        trigger: Literal["scheduled"],
        max_runs_per_hour: int | None = None,
    ) -> UUID: ...


Spend = Callable[[], Decimal]


# --- rerate_all ---------------------------------------------------------------------------------


def rerate_all(
    session_factory: SessionFactory,
    runner: Runner,
    *,
    world_id: UUID,
    period: str,
    spend: Spend,
    llm_budget_usd: Decimal,
    job_cap_usd: Decimal,
) -> JobReport:
    """Re-rate every listed asset once per period; pay each re-rated asset's quarterly revenue.

    The payout is its own claim (`payout`, same period), taken only once the asset's re-rate
    claim is `done`, so a payout that failed is retried by the next run without re-rating, and
    an asset whose re-rate failed is paid only after its retried re-rate succeeds. A budget or
    rate-limit stop ends the re-rates but still settles the payouts of assets already re-rated.
    """
    report = JobReport(RERATE, period, world_id)
    with session_factory() as session:
        assets = [asset.id for asset in listed_assets(session, world_id)]
    budget = Budget(llm_budget_usd, job_cap_usd, RERATE_ESTIMATE_USD)
    at_start = spend()
    for asset_id in assets:
        if report.stopped is None:
            report.stopped = budget_stop(budget, spent_total=spend(), spent_at_start=at_start)
        if report.stopped is None:
            _rerate_claimed(session_factory, runner, report, asset_id, len(assets))
        _settle_payout(session_factory, report, asset_id)
    with session_factory() as session:
        report.alerts = _alerts_for_reports(session, world_id, report.done)
    return report


def _rerate_claimed(
    session_factory: SessionFactory,
    runner: Runner,
    report: JobReport,
    asset_id: UUID,
    asset_count: int,
) -> None:
    with session_factory() as session:
        if not claim(session, RERATE, report.period, report.world_id, asset_id):
            report.skipped.append((asset_id, "claimed"))
            return
    status, detail = _rerate_one(session_factory, runner, report.world_id, asset_id, asset_count)
    with session_factory() as session:
        finish(session, RERATE, report.period, asset_id, status, detail)
    if status == "done":
        report.done.append(asset_id)
    elif status == "skipped":
        report.skipped.append((asset_id, detail or ""))
    else:
        report.failed.append((asset_id, detail or ""))
        if detail in RATE_LIMITED:  # every later asset would be refused too
            report.stopped = detail


def claim_status(session: Session, job: Job, period: str, asset_id: UUID) -> str | None:
    return session.exec(
        select(MonitorRun.status).where(
            MonitorRun.job == job, MonitorRun.period == period, MonitorRun.asset_id == asset_id
        )
    ).first()


def _settle_payout(session_factory: SessionFactory, report: JobReport, asset_id: UUID) -> None:
    """Pay the asset's quarter once its re-rate is `done` (own claim; see `rerate_all`)."""
    with session_factory() as session:
        if claim_status(session, RERATE, report.period, asset_id) != "done":
            return
        if not claim(session, PAYOUT, report.period, report.world_id, asset_id):
            return
    status: Literal["done", "failed", "skipped"]
    try:
        status, detail = pay_period(session_factory, report.world_id, asset_id, report.period)
    except Exception as exc:  # anything unexpected: retried by the next run
        log.exception("payout failed for %s %s", asset_id, report.period)
        status, detail = "failed", f"payout_failed:{type(exc).__name__}"
    with session_factory() as session:
        finish(session, PAYOUT, report.period, asset_id, status, detail)
    if status == "failed":
        report.failed.append((asset_id, detail or ""))
    elif detail == "paid":
        report.payouts += 1


def _rerate_one(
    session_factory: SessionFactory,
    runner: Runner,
    world_id: UUID,
    asset_id: UUID,
    asset_count: int,
) -> tuple[Literal["done", "failed", "skipped"], str | None]:
    status, detail, _ = run_to_end(
        session_factory,
        lambda: runner.start(
            world_id, asset_id, trigger="scheduled", max_runs_per_hour=asset_count + 1
        ),
        world_id,
    )
    return status, detail


def run_to_end(
    session_factory: SessionFactory, start: Callable[[], UUID], world_id: UUID
) -> tuple[Literal["done", "failed", "skipped"], str | None, UUID | None]:
    """Start one inline rating run and read how it ended: `done` (a report was sealed),
    `skipped` (the asset can't be rated) or `failed` (retried by the next run), with a detail
    and the run's ID. Shared by `rerate_all` and T38's Time Machine."""
    try:
        run_id = start()
    except AssetNotRateable as exc:
        return "skipped", exc.code, None
    except LookupError:
        return "skipped", "asset_not_found", None
    except RunRateLimited as exc:
        return "failed", exc.code, None
    except RunInProgress:
        return "failed", "run_in_progress", None
    except RunnerBusy:
        return "failed", "rating_busy", None
    with session_factory() as session:
        run = get_run(session, world_id, run_id)
    if run is None:
        return "failed", "run_not_found", run_id
    if run.status in (RatingRunStatus.SUCCEEDED, RatingRunStatus.DEGRADED):
        return "done", f"run={run_id} status={run.status.value}", run_id
    return "failed", run.error or run.status.value, run_id


def pay_period(
    session_factory: SessionFactory, world_id: UUID, asset_id: UUID, period: str
) -> tuple[Literal["done", "skipped"], str]:
    """Pay the quarter's revenue from the latest report's value (T41), once per asset and
    quarter. An asset without a report value or a recorded community stake isn't paid
    (`skipped`); other errors propagate."""
    with session_factory() as session:
        latest = latest_report(session, world_id, asset_id)
        if latest is None or latest.value_mid is None:
            return "skipped", "no_report_value"
        try:
            pay_quarter(
                session,
                world_id=world_id,
                asset_id=asset_id,
                value_mid=latest.value_mid,
                quarter_label=period,
            )
        except PayoutAlreadyApplied:
            session.rollback()
            return "done", "already_paid"
        except CommunityStakeMissing:
            session.rollback()
            return "skipped", "no_community_stake"
        session.commit()
        return "done", "paid"


def _alerts_for_reports(session: Session, world_id: UUID, asset_ids: Sequence[UUID]) -> int:
    """How many alerts the re-rated assets' latest reports raised (for the job summary)."""
    if not asset_ids:
        return 0
    reports = [latest_report(session, world_id, asset_id) for asset_id in asset_ids]
    ids = [r.id for r in reports if r is not None]
    return session.exec(
        select(func.count())
        .select_from(Alert)
        .where(Alert.world_id == world_id, col(Alert.report_id).in_(ids))
    ).one()


# --- news_sweep ---------------------------------------------------------------------------------

NewsFn = Callable[[NewsScoutAsset], NewsScoutOutput]


def news_asset(asset: Asset) -> NewsScoutAsset | None:
    """What News Scout needs; None without a centroid (it geocodes the centroid)."""
    if asset.centroid_lat is None or asset.centroid_lon is None:
        return None
    return NewsScoutAsset(
        id=asset.id,
        name=asset.name,
        centroid_lat=asset.centroid_lat,
        centroid_lon=asset.centroid_lon,
        country=asset.country,
    )


def news_sweep(
    session_factory: SessionFactory,
    news: NewsFn,
    *,
    world_id: UUID,
    period: str,
    spend: Spend,
    llm_budget_usd: Decimal,
    job_cap_usd: Decimal,
) -> JobReport:
    """Run News Scout once per listed asset and period; store new events and alert on
    severity ≥ 4. An asset without a centroid is `skipped` (`no_centroid`); when News Scout
    couldn't verify the locality (`locality_unverified`), events are stored but nobody is
    alerted. A failure of News Scout or of storing its output marks the asset `failed`, so the
    next run retries it."""
    report = JobReport(NEWS_SWEEP, period, world_id)
    with session_factory() as session:
        targets = [(asset.id, news_asset(asset)) for asset in listed_assets(session, world_id)]
    budget = Budget(llm_budget_usd, job_cap_usd, NEWS_ESTIMATE_USD)
    at_start = spend()
    for asset_id, target in targets:
        stop = budget_stop(budget, spent_total=spend(), spent_at_start=at_start)
        if stop is not None:
            report.stopped = stop
            break
        with session_factory() as session:
            if not claim(session, NEWS_SWEEP, period, world_id, asset_id):
                report.skipped.append((asset_id, "claimed"))
                continue
            if target is None:
                finish(session, NEWS_SWEEP, period, asset_id, "skipped", "no_centroid")
                report.skipped.append((asset_id, "no_centroid"))
                continue
        try:
            output = news(target)
        except Exception as exc:  # News Scout or its LLM failed: retry on the next run
            _news_failed(session_factory, report, asset_id, type(exc).__name__)
            continue
        try:
            with session_factory() as session:
                stored, alerted = record_news(
                    session,
                    world_id,
                    asset_id,
                    output.events,
                    alert=not output.locality_unverified,
                )
                session.commit()
        except Exception as exc:  # storing failed (rolled back): retry on the next run
            _news_failed(session_factory, report, asset_id, f"store_failed:{type(exc).__name__}")
            continue
        detail = f"events={stored}" + (" locality_unverified" if output.locality_unverified else "")
        with session_factory() as session:
            finish(session, NEWS_SWEEP, period, asset_id, "done", detail)
        report.done.append(asset_id)
        report.events += stored
        report.alerts += alerted
    return report


def _news_failed(
    session_factory: SessionFactory, report: JobReport, asset_id: UUID, detail: str
) -> None:
    log.warning("news sweep failed for %s: %s", asset_id, detail)
    with session_factory() as session:
        finish(session, NEWS_SWEEP, report.period, asset_id, "failed", detail)
    report.failed.append((asset_id, detail))


def record_news(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    items: Sequence[NewsScoutItem],
    *,
    alert: bool = True,
) -> tuple[int, int]:
    """Store the relevant events not stored yet and, with `alert`, raise their alerts, in the
    caller's transaction. Returns (events stored, alerts raised)."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one()
    stored = alerted = 0
    for item in items:
        if not item.relevant:
            continue
        url = safe_url(item.url)
        same = select(Event.id).where(Event.world_id == world_id, Event.asset_id == asset_id)
        same = same.where(Event.url == url) if url else same.where(Event.title == item.title)
        if session.exec(same.limit(1)).first() is None:
            session.add(
                Event(
                    world_id=world_id,
                    asset_id=asset_id,
                    source=EventSource.TAVILY,
                    title=item.title,
                    url=url,
                    published_at=item.published_at,
                    impact_type=item.impact_type,
                    direction=item.direction,
                    severity=item.severity,
                    summary=item.summary,
                )
            )
            stored += 1
        draft = news_alert(asset_id, asset.name, item) if alert else None
        if draft is not None and raise_alert(session, world_id, asset, draft) is not None:
            alerted += 1
    session.flush()
    return stored, alerted

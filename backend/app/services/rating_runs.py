"""Async rating runs (T27): `start_rating_run` → background orchestration → sealed report vN.

`start_rating_run(world_id, asset_id, *, scenario=None, trigger=...)` checks the caps, records
the run as a `queued` `rating_progress` event and returns its `run_id` at once. A worker thread
then runs the Orchestrator (`agents/orchestrator.py`) with its own short DB sessions (never the
request's) and stores the result through T19's `rate_asset`, with the audit applied (T26).

**Run state lives in the database, not in memory.** Each step publishes one `rating_progress`
event to `world_events` (T29) in its own short transaction: `queued` → `started` →
`earth_obs` → `valuation` → `news` → `evidence` → `audit` → `done` (plus `fallback` when the
fixed pipeline takes over). Every payload carries `run_id`, `asset_id`, a per-run `seq`, the
step, its status and, for tool steps, the tool, pipeline, model, tokens, cost, latency and the
`llm_calls` it made, so the T28 trace and `GET /runs/{run_id}` can be rebuilt by any worker.
The `done` event is published in the same transaction as the report row and its ledger entry,
so "done" exists exactly when the sealed report does. Events are pruned after 24 h (T29); the
report keeps the run record in `auditor_json["run"]`, so a finished run's status survives.

**Caps.** One run per asset at a time (409 `run_in_progress`), `RATING_RUNS_PER_WORLD_PER_HOUR`
runs per world (429 `rating_rate_limited`) and `RATING_RUNS_GLOBAL_PER_HOUR` runs across all
worlds (429 `rating_global_limit`, so free visitor worlds can't drain `LLM_BUDGET_USD`) are
checked in the same transaction that publishes `queued`, so two workers can't both pass.
**Lock order:** the global run lock (`GLOBAL_RUNS_LOCK_KEY`) first, then the world's publisher
lock; nothing else takes the global lock, so there is no cycle. Both waits are bounded by
`lock_timeout` (`LOCK_TIMEOUT_MS`), and a timeout is 503 `rating_busy`, like T66's rate limits.
A run with no event for `RUN_STALE_AFTER` counts as failed (e.g. its worker died), which frees
the asset; a worker that picks up a run that went stale while it waited marks it failed and
doesn't run it. At most `MAX_PENDING_RUNS` runs wait or run per process (503 `rating_busy`),
and `LLM_BUDGET_USD` stays the global hard cap inside `llm.py`. With `LLM_RESERVE_USD` set,
API-triggered runs use the fixed pipeline without any model once the remaining budget falls
below the reserve, so Time Machine and listing runs keep it.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from math import ceil
from typing import Any, Literal, Protocol, cast
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlmodel import Session, col, select

from app.agents.auditor import (
    REASONING_EXCERPT_CHARS,
    AuditEvent,
    AuditResult,
    PreviousReport,
    audit_events_from_news,
    build_auditor_input,
    no_op_audit,
    run_auditor,
)
from app.agents.news_scout import NewsScoutAsset, run_news_scout
from app.agents.orchestrator import (
    STEP_NAMES,
    FallbackReason,
    Orchestration,
    Pipeline,
    RunAborted,
    Tool,
    orchestrate,
)
from app.config import Settings, get_settings
from app.events import lock_world_publisher, publish
from app.llm import PRICES_PER_M, CallLog, CallRecord, LLMClient, LLMError, LLMResult, cost_usd
from app.market.anchoring import reanchor_on_rerate
from app.models import Asset, AssetStatus, Report, StreamEventType, World, WorldEvent
from app.schemas import (
    CostBaseline,
    ModelUsage,
    NewsScoutItem,
    NewsScoutOutput,
    RatingRunOut,
    RatingRunStatus,
    RatingRunStep,
    RunTraceOut,
    RunTraceStep,
    RunTraceTotals,
)
from app.services.alerts import alert_on_rerate
from app.services.earth_obs_live import (
    EARTH_ENGINE_BUSY,
    LiveEarthObs,
    LiveMetricsError,
    LiveQuota,
    build_live_earth_obs,
    refund_live_rating,
)
from app.services.field_evidence import DbEvidenceProvider
from app.services.lifecycle import is_public
from app.services.listings import apply_rating_result, lock_asset, note_rating_failure
from app.services.listings import audience as listing_audience
from app.services.news_events import record_news
from app.services.rating import SiteRating, asset_is_wetland, latest_report, rate_asset, rate_site
from app.tools.earth_obs import (
    EarthObsMetrics,
    ScenarioName,
    is_curated_site,
    is_mock_metrics,
    load_site_metrics,
    mock_listing_metrics,
)
from app.tools.ecosystem import Ecosystem, infer_ecosystem
from app.tools.geometry import geometry_sha256, metrics_match_polygon
from app.tools.signals import Signal, find_signals
from app.worlds import LIVE_WORLD_ID

log = logging.getLogger(__name__)

ORCHESTRATION_VERSION = "naturex-orchestrator/1.0 (T27)"
# A rating weighs a year of news; the daily sweep looks at the latest week.
RATING_NEWS_LOOKBACK_DAYS = 365
RUN_WINDOW = timedelta(hours=1)
RUN_STALE_AFTER = timedelta(minutes=15)
RUN_WORKERS = 4
MAX_PENDING_RUNS = 16
BUSY_RETRY_AFTER_S = 30
LOCK_TIMEOUT_MS = 2000
GLOBAL_RUNS_LOCK_KEY = 0x4E585252
"""Advisory key ("NXRR") serialising the global run count; always taken before a world lock."""
REQUIRED_TOOLS = frozenset({Tool.EARTH_OBS, Tool.VALUATION, Tool.AUDITOR})
NO_CACHED_METRICS = "no_cached_metrics"
NOT_COMPUTED = frozenset({"stale", f"earth_obs_failed:{EARTH_ENGINE_BUSY}"})
"""Run failures that never reached Earth Engine, so their live rating is refunded (T60)."""
STALE_METRICS = "stale_metrics"
"""The asset was re-rated after the caller computed its metrics (T38): the run stores nothing."""
LIVE_METRICS_PENDING = "live_metrics_pending"
"""Live Earth Engine is on but this polygon isn't computed yet, and the run may not compute it
(only a listing submit, which counts against the live-rating quota, may)."""


def _cap_retry_after(oldest: datetime, now: datetime) -> int:
    remaining = ceil((oldest + RUN_WINDOW - now).total_seconds())
    if remaining > RUN_WINDOW.total_seconds():
        log.warning(
            "retry_after_clamped: rating event is %.3fs ahead of database time",
            (oldest - now).total_seconds(),
        )
    return min(max(remaining, 1), int(RUN_WINDOW.total_seconds()))


Trigger = Literal["api", "time_machine", "listing", "scheduled"]


class RunError(Exception):
    """A run can't be started; the router maps each subclass to an HTTP status."""


class AssetNotRateable(RunError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class RunInProgress(RunError):
    def __init__(self, run_id: UUID) -> None:
        super().__init__(f"run {run_id} is still in progress for this asset")
        self.run_id = run_id


class RunRateLimited(RunError):
    def __init__(self, retry_after_s: int, code: str = "rating_rate_limited") -> None:
        super().__init__(f"{code}: retry in {retry_after_s} s")
        self.retry_after_s = retry_after_s
        self.code = code


class RunnerBusy(RunError):
    def __init__(self, retry_after_s: int = BUSY_RETRY_AFTER_S) -> None:
        super().__init__("too many rating runs in progress")
        self.retry_after_s = retry_after_s


class ToolFailed(Exception):
    """One attempt of a tool failed; `retryable=False` skips the retry."""

    def __init__(self, code: str, *, retryable: bool = True) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class RunSpec:
    run_id: UUID
    world_id: UUID
    asset_id: UUID
    scenario: ScenarioName
    trigger: Trigger
    audience: UUID | None = None
    """Live-event audience: None for a public asset; the listing's community while it's under
    review (T58), so its progress never reaches the public stream."""
    metrics: EarthObsMetrics | None = None
    """Metrics computed by the caller (T38's Time Machine: a quarter or an event preset applied
    to the asset's current state) instead of the loader's; they must describe the asset."""
    based_on_report: int | None = None
    """The report version `metrics` was computed from (T38): if the asset's latest report is
    another one when the run stores, the run fails with `stale_metrics` and writes nothing."""


@dataclass(frozen=True, slots=True)
class AssetInfo:
    """The bound asset, read once at the start of the run (the model never sees its ID)."""

    id: UUID
    world_id: UUID
    name: str
    site_key: str | None
    country: str | None
    centroid_lat: float | None
    centroid_lon: float | None
    total_shares: int
    area_ha: float | None = None
    geojson: Mapping[str, Any] | None = None


# ----- pluggable steps --------------------------------------------------------------------------


class EvidenceProvider(Protocol):
    """Field evidence for the `field_evidence` tool: `available` offers the tool, `load` gives
    the validated photos as events (T40: `services.field_evidence.DbEvidenceProvider`)."""

    def available(self, world_id: UUID, asset_id: UUID) -> bool: ...

    def load(self, world_id: UUID, asset_id: UUID) -> list[AuditEvent]: ...


class NoFieldEvidence:
    """No evidence, so the tool is never offered and the step is `skipped` (tests)."""

    def available(self, world_id: UUID, asset_id: UUID) -> bool:
        return False

    def load(self, world_id: UUID, asset_id: UUID) -> list[AuditEvent]:
        return []


MetricsLoader = Callable[[AssetInfo, ScenarioName], EarthObsMetrics]


class QueueHook(Protocol):
    """Writes that must commit with a queued run (T58's `ListingSubmit`)."""

    def lock(self, session: Session, world_id: UUID, asset_id: UUID) -> None:
        """Take the hook's locks; called before the world's publisher lock."""

    def __call__(self, session: Session, asset: Asset, run_id: UUID) -> None:
        """Called once every run check passed, just before `queued` is published."""


NewsRunner = Callable[[NewsScoutAsset, LLMClient | None], NewsScoutOutput]
LlmFactory = Callable[[Callable[[CallLog], CallLog]], LLMClient | None]


def resolve_metrics(
    loader: MetricsLoader,
    asset: AssetInfo,
    scenario: ScenarioName,
    use_mocks: bool,
    live: LiveEarthObs | None = None,
    *,
    compute_live: bool = False,
) -> EarthObsMetrics:
    """The run's metrics for the asset: the loader's, else for a new polygon with none (T60)
    its live Earth Engine metrics when live is on (cached, or computed if `compute_live`),
    else (with `USE_MOCKS=true` only) `mock_listing_metrics`. Metrics for a new polygon must
    describe it: never a curated site's, centroid in its convex hull and area within ±10 %
    (`foreign_metrics`)."""
    try:
        metrics = loader(asset, scenario)
    except ToolFailed as exc:
        new_polygon = asset.site_key is None and scenario == "baseline"
        if exc.code != NO_CACHED_METRICS or not new_polygon:
            raise
        metrics = _new_polygon_metrics(asset, exc, use_mocks, live, compute_live)
    if asset.site_key is None and not _describes_polygon(asset, metrics):
        raise ToolFailed("foreign_metrics", retryable=False)  # never another site's data
    return metrics


def _new_polygon_metrics(
    asset: AssetInfo,
    missing: ToolFailed,
    use_mocks: bool,
    live: LiveEarthObs | None,
    compute_live: bool,
) -> EarthObsMetrics:
    lat, lon, area = asset.centroid_lat, asset.centroid_lon, asset.area_ha
    if live is not None and asset.geojson is not None:
        cached = live.cached(asset.geojson)  # any world may reuse a computed polygon
        if cached is not None:
            return cached
        if asset.world_id == LIVE_WORLD_ID:
            # Live world: rated with its own observations, never mocks. Demo sandboxes never
            # compute (they would spend the live world's capacity): they fall through to mocks
            # or `no_cached_metrics`, and the cached example (T60).
            if not compute_live:
                raise ToolFailed(LIVE_METRICS_PENDING, retryable=False)
            try:
                return live.compute(asset.geojson)
            except LiveMetricsError as exc:
                raise ToolFailed(exc.code, retryable=False) from exc
    if not use_mocks or lat is None or lon is None or area is None:
        raise missing
    return mock_listing_metrics(area_ha=area, centroid_lat=lat, centroid_lon=lon)


def _describes_polygon(asset: AssetInfo, metrics: EarthObsMetrics) -> bool:
    if is_curated_site(metrics.site_key) or asset.geojson is None or asset.area_ha is None:
        return False
    return metrics_match_polygon(
        asset.geojson,
        area_ha=asset.area_ha,
        metrics_area_ha=metrics.area_ha,
        metrics_lat=metrics.centroid.lat,
        metrics_lon=metrics.centroid.lon,
    )


def given_metrics_fit(asset: AssetInfo, metrics: EarthObsMetrics) -> bool:
    """Caller-computed metrics (T38) describe the run's asset: a curated site's own key, or for a
    new polygon its area and centroid (never a curated site's data)."""
    if asset.site_key is not None:
        return metrics.site_key == asset.site_key
    return _describes_polygon(asset, metrics)


def asset_info(asset: Asset) -> AssetInfo:
    return AssetInfo(
        id=asset.id,
        world_id=asset.world_id,
        name=asset.name,
        site_key=asset.site_key,
        country=asset.country,
        centroid_lat=asset.centroid_lat,
        centroid_lon=asset.centroid_lon,
        total_shares=asset.total_shares,
        area_ha=float(asset.area_ha),
        geojson=asset.geojson,
    )


def load_cached_metrics(asset: AssetInfo, scenario: ScenarioName) -> EarthObsMetrics:
    """Committed demo-site metrics (T11/T13).

    A new polygon has no `site_key`, so this raises `no_cached_metrics`; `resolve_metrics`
    then uses live Earth Engine (T60, `RatingRunner.live_metrics`) when it is on, else (with
    `USE_MOCKS=true` only) `mock_listing_metrics`, labelled as mock data. With neither, the run
    fails before any rating; the listing stays in `rating` with `status_reason =
    no_satellite_metrics` and never shows another site's data.
    """
    if asset.site_key is None:
        raise ToolFailed(NO_CACHED_METRICS, retryable=False)
    try:
        return load_site_metrics(asset.site_key, scenario)
    except ValueError as exc:
        raise ToolFailed(NO_CACHED_METRICS, retryable=False) from exc


class _NoLLM:
    """Stands in for the LLM where News Scout must not call one (mock mode)."""

    def structured(self, **_: Any) -> LLMResult[Any]:
        raise LLMError("no LLM in this run")


def news_runner(
    settings: Settings, *, lookback_days: int = RATING_NEWS_LOOKBACK_DAYS
) -> NewsRunner:
    """News Scout for rating runs (a year of news by default) and for the daily sweep."""

    def run(asset: NewsScoutAsset, llm: LLMClient | None) -> NewsScoutOutput:
        if settings.use_mocks:
            return run_news_scout(asset, settings=settings, llm=_NoLLM())
        if llm is None:
            raise ToolFailed("llm_unavailable", retryable=False)
        return run_news_scout(asset, settings=settings, llm=llm, lookback_days=lookback_days)

    return run


# ----- call recording ---------------------------------------------------------------------------


@dataclass(slots=True)
class _Recorded:
    handle: int
    call: CallRecord


class RecordingCallLog:
    """Wraps the spend log and remembers this run's calls, so each progress event can say
    which model calls its step made. Spend still goes through the wrapped log first."""

    def __init__(self, inner: CallLog) -> None:
        self._inner = inner
        self._calls: list[_Recorded] = []
        self._cursor = 0

    def spent_usd(self) -> Decimal:
        return self._inner.spent_usd()

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        return self._inner.reserve(call, budget)

    def settle(self, handle: int, call: CallRecord) -> None:
        self._inner.settle(handle, call)
        self._calls.append(_Recorded(handle, call))

    def mark(self, handle: int, status: str) -> None:
        self._inner.mark(handle, status)
        for recorded in self._calls:
            if recorded.handle == handle:
                recorded.call = replace(recorded.call, status=status)

    def drain(self) -> list[_Recorded]:
        """Calls settled since the last drain."""
        new = self._calls[self._cursor :]
        self._cursor = len(self._calls)
        return new

    def all(self) -> list[_Recorded]:
        return list(self._calls)


def _call_json(recorded: _Recorded) -> dict[str, Any]:
    call = recorded.call
    return {
        "id": recorded.handle,
        "agent": call.agent,
        "model": call.model,
        "tier": call.tier.value,
        "status": call.status,
        "prompt_tokens": call.prompt_tokens,
        "completion_tokens": call.completion_tokens,
        "latency_ms": call.latency_ms,
        "cost_usd": str(call.cost_usd),
    }


def usage(calls: Sequence[_Recorded], *, agent: str | None = None) -> dict[str, Any]:
    """Tokens, cost and the answering model of some recorded calls (for one event)."""
    own = [r for r in calls if agent is None or r.call.agent == agent]
    answered = [r.call.model for r in (own or list(calls)) if r.call.status == "ok"]
    return {
        "model": answered[-1] if answered else None,
        "prompt_tokens": sum(r.call.prompt_tokens for r in calls),
        "completion_tokens": sum(r.call.completion_tokens for r in calls),
        "cost_usd": str(sum((r.call.cost_usd for r in calls), Decimal(0))),
        "llm_calls": [_call_json(r) for r in calls],
    }


_TOOL_AGENT = {Tool.NEWS_SCOUT: "news_scout", Tool.AUDITOR: "auditor"}


# ----- progress ---------------------------------------------------------------------------------


class RunProgress:
    """Publishes a run's `rating_progress` events, each in its own short transaction."""

    def __init__(self, spec: RunSpec, session_factory: Callable[[], Session], seq: int) -> None:
        self._spec = spec
        self._session_factory = session_factory
        self._seq = seq

    @property
    def spec(self) -> RunSpec:
        return self._spec

    def payload(self, step: str, status: str, **fields: Any) -> dict[str, Any]:
        self._seq += 1
        return {
            "run_id": str(self._spec.run_id),
            "asset_id": str(self._spec.asset_id),
            "seq": self._seq,
            "step": step,
            "status": status,
            **fields,
        }

    def emit(self, step: str, status: str, **fields: Any) -> None:
        with self._session_factory() as session:
            publish(
                session,
                self._spec.world_id,
                StreamEventType.RATING_PROGRESS,
                self.payload(step, status, **fields),
                audience=self._spec.audience,
            )
            session.commit()


# ----- the toolbox ------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MetricsProbe:
    version: str | None
    """The data version a run would rate with, or None (no metrics for the polygon)."""
    live_compute: bool = False
    """True when that run must compute the metrics live (T60): the submit counts the quota."""


@dataclass(slots=True)
class RunDeps:
    session_factory: Callable[[], Session]
    settings: Settings
    metrics_loader: MetricsLoader
    news: NewsRunner
    evidence: EvidenceProvider
    today: Callable[[], date]
    clock: Callable[[], float] = time.perf_counter
    live: LiveEarthObs | None = None


def previous_for_bundle(report: Report | None) -> PreviousReport | None:
    """The Auditor's view of the asset's last report, when it has every headline number."""
    if report is None or None in (
        report.health_score,
        report.grade,
        report.confidence,
        report.value_mid,
    ):
        return None
    stored = report.auditor_json or {}
    period = (stored.get("rating") or {}).get("period")
    adjustment = int((stored.get("auditor") or {}).get("auditor_adjustment", 0))
    return PreviousReport(
        version=report.version,
        period=period,
        health=cast(Decimal, report.health_score),
        grade=cast(str, report.grade),
        confidence=cast(Decimal, report.confidence),
        value_mid=int(cast(Decimal, report.value_mid)),
        auditor_adjustment=adjustment,
    )


def _dedupe(events: Sequence[AuditEvent]) -> list[AuditEvent]:
    seen: dict[str, AuditEvent] = {}
    for event in events:
        seen.setdefault(event.citation_id, event)
    return list(seen.values())


def _flag(code: str, source: str, detail: str) -> dict[str, str]:
    return {"type": code, "source": source, "detail": detail}


class RunToolbox:
    """The tools of one bound run (`orchestrator.Toolbox`). Every step runs deterministic code
    or a guarded agent, retries once on failure and publishes one progress event."""

    def __init__(
        self,
        spec: RunSpec,
        asset: AssetInfo,
        deps: RunDeps,
        *,
        llm: LLMClient | None,
        no_llm_reason: FallbackReason | None,
        progress: RunProgress,
        recorder: RecordingCallLog | None,
    ) -> None:
        self._spec = spec
        self._asset = asset
        self._deps = deps
        self._llm = llm
        self._no_llm_reason = no_llm_reason
        self._progress = progress
        self._recorder = recorder
        self._done: dict[Tool, str] = {}
        self._evidence = deps.evidence.available(spec.world_id, spec.asset_id)
        self.as_of = deps.today()
        self.metrics: EarthObsMetrics | None = None
        self.is_wetland: bool | None = None
        self.valuation: SiteRating | None = None
        self.signals: list[Signal] = []
        self.news_events: list[AuditEvent] = []
        self.news_items: list[NewsScoutItem] = []
        """News Scout's kept events, stored with the report (`services.news_events`)."""
        self.evidence_events: list[AuditEvent] = []
        self.audit: AuditResult | None = None
        self.steps: list[dict[str, Any]] = []
        self.flags: list[dict[str, str]] = []
        self.failed: list[str] = []

    @property
    def scenario(self) -> ScenarioName:
        return self._spec.scenario

    @property
    def events(self) -> list[AuditEvent]:
        return _dedupe([*self.news_events, *self.evidence_events])

    def offered(self) -> tuple[Tool, ...]:
        return tuple(t for t in Tool if t is not Tool.FIELD_EVIDENCE or self._evidence)

    def is_done(self, tool: Tool) -> bool:
        return tool in self._done

    def _drain(self) -> list[_Recorded]:
        return self._recorder.drain() if self._recorder else []

    def _record_step(self, step: dict[str, Any]) -> None:
        self.steps.append(step)
        self._progress.emit(**step)

    def fallback(self, reason: FallbackReason, violations: Sequence[dict[str, str]]) -> None:
        self.flags.append(
            _flag(
                "orchestrator_fallback",
                "orchestrator",
                f"The fixed pipeline ran the rating steps ({reason.value}).",
            )
        )
        self._record_step(
            {
                "step": "fallback",
                "status": "running",
                "pipeline": "fixed",
                "reason": reason.value,
                "violations": list(violations),
                **usage(self._drain()),
            }
        )

    def call(self, tool: Tool, *, pipeline: Pipeline) -> dict[str, Any]:
        if tool is Tool.AUDITOR and not self._evidence and not self.is_done(Tool.FIELD_EVIDENCE):
            self._done[Tool.FIELD_EVIDENCE] = "skipped"
            self._record_step(
                {"step": "evidence", "status": "skipped", "tool": Tool.FIELD_EVIDENCE.value}
            )
        start = self._deps.clock()
        error: str | None = None
        summary: dict[str, Any] = {}
        attempts = 0
        while attempts < 2:
            attempts += 1
            try:
                summary = self._execute(tool)
                error = None
                break
            except ToolFailed as exc:
                error = exc.code
                if not exc.retryable:
                    break
        status = "ok" if error is None else "failed"
        latency_ms = int((self._deps.clock() - start) * 1000)
        self._record_step(
            {
                "step": STEP_NAMES[tool],
                "status": status,
                "tool": tool.value,
                "pipeline": pipeline,
                "attempts": attempts,
                "latency_ms": latency_ms,
                "error": error,
                "output": summary if error is None else None,
                **usage(self._drain(), agent=_TOOL_AGENT.get(tool)),
            }
        )
        if error is not None:
            if tool in REQUIRED_TOOLS:
                raise RunAborted(f"{STEP_NAMES[tool]}_failed:{error}")
            self._done[tool] = status
            self.failed.append(STEP_NAMES[tool])
            self.flags.append(
                _flag(
                    f"{STEP_NAMES[tool]}_unavailable",
                    tool.value,
                    f"The {tool.value} step failed ({error}); the rating continued without it.",
                )
            )
            return {"status": "failed", "error": error}
        self._done[tool] = status
        return {"status": "ok", **summary}

    # --- the steps (deterministic code, or a guarded agent) ---

    def _execute(self, tool: Tool) -> dict[str, Any]:
        match tool:
            case Tool.EARTH_OBS:
                return self._earth_obs()
            case Tool.VALUATION:
                return self._valuation()
            case Tool.NEWS_SCOUT:
                return self._news()
            case Tool.FIELD_EVIDENCE:
                return self._field_evidence()
            case Tool.AUDITOR:
                return self._auditor()
            case _:  # pragma: no cover - Tool is closed
                raise AssertionError(tool)

    def _load_metrics(self) -> EarthObsMetrics:
        given = self._spec.metrics
        if given is not None:
            if not given_metrics_fit(self._asset, given):
                raise ToolFailed("foreign_metrics", retryable=False)
            return given
        return resolve_metrics(
            self._deps.metrics_loader,
            self._asset,
            self.scenario,
            self._deps.settings.use_mocks,
            self._deps.live,
            # Only a listing submit counted the live-rating quota (T60), so only it computes.
            compute_live=self._spec.trigger == "listing",
        )

    def _earth_obs(self) -> dict[str, Any]:
        metrics = self._load_metrics()
        with self._deps.session_factory() as session:
            row = _world_asset(session, self._spec.world_id, self._spec.asset_id)
            if row is None:
                raise ToolFailed("asset_not_found", retryable=False)
            try:
                wetland = asset_is_wetland(session, row, metrics)
            except ValueError as exc:
                raise ToolFailed("no_baseline", retryable=False) from exc
        self.metrics, self.is_wetland = metrics, wetland
        self.signals = find_signals(metrics)
        return {
            "data_version": metrics.data_version,
            "scenario": metrics.scenario,
            "simulated": metrics.simulated,
            "area_ha": round(metrics.area_ha, 1),
            "natural_fraction": round(metrics.natural_fraction, 3),
            "cloud_free_obs": metrics.cloud_free_obs,
            "wetland": wetland,
            "mock": is_mock_metrics(metrics),
            # Dated changes found by code in the 5-year history (`tools.signals`).
            "signals": [signal.to_json() for signal in self.signals],
        }

    def _bound_metrics(self) -> tuple[EarthObsMetrics, bool]:
        if self.metrics is None or self.is_wetland is None:
            raise ToolFailed("earth_obs_missing", retryable=False)
        return self.metrics, self.is_wetland

    def _rate(self, events: Sequence[AuditEvent] = ()) -> SiteRating:
        metrics, wetland = self._bound_metrics()
        return rate_site(
            metrics,
            is_wetland=wetland,
            as_of=self.as_of,
            total_shares=self._asset.total_shares,
            events=events,
        )

    def _valuation(self) -> dict[str, Any]:
        self.valuation = self._rate()
        value = self.valuation.valuation
        return {
            "unit": value.unit,
            "value_low": value.value_low,
            "value_mid": value.value_mid,
            "value_high": value.value_high,
            "carbon_stock_tco2": value.carbon.total_stock_tco2,
        }

    def _news(self) -> dict[str, Any]:
        asset = self._asset
        lat, lon = asset.centroid_lat, asset.centroid_lon
        if (lat is None or lon is None) and self.metrics is not None:
            lat, lon = self.metrics.centroid.lat, self.metrics.centroid.lon
        if lat is None or lon is None:
            raise ToolFailed("no_location", retryable=False)
        scout_asset = NewsScoutAsset(
            id=asset.id,
            name=asset.name,
            centroid_lat=lat,
            centroid_lon=lon,
            country=asset.country,
            ecosystem=self._ecosystem(),
        )
        try:
            output = self._deps.news(scout_asset, self._llm)
        except ToolFailed:
            raise
        except Exception as exc:
            log.warning("News Scout failed for a rating run: %s", type(exc).__name__)
            raise ToolFailed("news_scout_error") from exc
        events = _dedupe(audit_events_from_news(output.events))
        self.news_events = events
        self.news_items = list(output.events)
        relevant = [event for event in events if event.relevant]
        # Counts, categories and our own query text only: article text never reaches the
        # orchestrator (T72).
        return {
            "events": len(events),
            "relevant": len(relevant),
            "negative": sum(1 for event in relevant if event.direction == -1),
            "positive": sum(1 for event in relevant if event.direction == 1),
            "max_severity": max((event.severity for event in relevant), default=0),
            "impact_types": sorted({event.impact_type for event in relevant}),
            "dropped_off_site": output.dropped_off_site,
            "locality_unverified": output.locality_unverified,
            **({"news_paused": True} if output.news_paused else {}),
            "ecosystem": scout_asset.ecosystem.value if scout_asset.ecosystem else None,
            "searches": [
                {
                    "query": s.query,
                    "language": s.language,
                    "results": s.results,
                    "latency_ms": s.latency_ms,
                    "credits": s.credits,
                    **({"error": s.error} if s.error else {}),
                }
                for s in output.searches
            ],
            **({"funnel": output.funnel.model_dump()} if output.funnel else {}),
        }

    def _ecosystem(self) -> Ecosystem:
        m = self.metrics
        return infer_ecosystem(
            name=self._asset.name,
            landcover=m.landcover if m else None,
            mangrove_fraction=m.mangrove_fraction if m else None,
        )

    def _field_evidence(self) -> dict[str, Any]:
        events = self._deps.evidence.load(self._spec.world_id, self._spec.asset_id)
        self.evidence_events = [event for event in events if event.source == "evidence"]
        validated = [event for event in self.evidence_events if event.validated]
        # Counts only, as for news: the photos' labels never reach the orchestrator.
        return {
            "items": len(self.evidence_events),
            "validated": len(validated),
            "negative": sum(1 for event in validated if event.direction == -1),
            "positive": sum(1 for event in validated if event.direction == 1),
        }

    def _auditor(self) -> dict[str, Any]:
        metrics, _ = self._bound_metrics()
        events = self.events
        base = self._rate(events)
        with self._deps.session_factory() as session:
            previous = previous_for_bundle(
                latest_report(session, self._spec.world_id, self._spec.asset_id)
            )
        try:
            bundle = build_auditor_input(
                asset_name=self._asset.name,
                rating_date=self.as_of,
                metrics=metrics,
                valuation=base.valuation,
                base=base.score,
                events=events,
                previous=previous,
                signals=self.signals,
            )
        except ValueError as exc:
            raise ToolFailed("bundle_invalid", retryable=False) from exc
        if self._llm is None:
            reason = (self._no_llm_reason or FallbackReason.LLM_UNAVAILABLE).value
            audit = no_op_audit(bundle, rejections=[f"no LLM in this run ({reason})"])
        else:
            audit = run_auditor(
                bundle, llm=self._llm, world_id=self._spec.world_id, asset_id=self._spec.asset_id
            )
        self.audit = audit
        return {
            "source": audit.source,
            "auditor_adjustment": audit.output.auditor_adjustment,
            "flags": [flag.type for flag in audit.output.flags],
            **_audit_case(audit),
        }


def _audit_case(audit: AuditResult) -> dict[str, Any]:
    """The Auditor's case and checks for the Agent Trace: checked, cited model text only, plus
    a short excerpt of its own notes, labelled as notes by the UI."""
    output = audit.output
    return {
        "agreement": output.agreement,
        "greenwashing_risk": audit.greenwashing_risk,
        "hypotheses": [h.model_dump() for h in output.hypotheses],
        "verdict": output.verdict or None,
        "adjustment_reason": output.adjustment_reason or None,
        "rounds": audit.rounds,
        "rejections": [r[:200] for r in audit.rejections[:8]],
        "reasoning_tokens": audit.reasoning_tokens,
        "notes": (audit.reasoning or "")[:REASONING_EXCERPT_CHARS] or None,
        "checks": {
            "citations": len(output.citations),
            "resolved": len(audit.citations),
            "placeholders_filled": audit.placeholders_filled,
            # Every round of a no-op audit was refused; an accepted audit's last round passed.
            "rejected_answers": max(0, audit.rounds - (0 if audit.fallback else 1)),
        },
    }


def _world_asset(session: Session, world_id: UUID, asset_id: UUID) -> Asset | None:
    return session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one_or_none()


# ----- the runner -------------------------------------------------------------------------------


def degraded_reasons(
    orchestration: Orchestration, audit: AuditResult, failed_steps: Sequence[str]
) -> list[str]:
    reasons: list[str] = []
    if orchestration.reason is not None:
        reasons.append(f"pipeline_fixed:{orchestration.reason.value}")
    if orchestration.degraded_model:
        reasons.append("orchestrator_lower_tier")
    if audit.fallback:
        reasons.append("auditor_unavailable")
    elif audit.degraded:
        reasons.append(f"auditor_{audit.source}")
    reasons += [f"{step}_unavailable" for step in failed_steps]
    return reasons


def _totals(recorder: RecordingCallLog | None) -> dict[str, Any]:
    calls = recorder.all() if recorder else []
    return {
        "llm_calls": len(calls),
        "prompt_tokens": sum(r.call.prompt_tokens for r in calls),
        "completion_tokens": sum(r.call.completion_tokens for r in calls),
        "cost_usd": str(sum((r.call.cost_usd for r in calls), Decimal(0))),
    }


@dataclass
class RatingRunner:
    """Starts runs (caps, `queued` event) and executes them on a worker thread."""

    session_factory: Callable[[], Session]
    settings: Settings
    executor: Executor
    llm_factory: LlmFactory
    news: NewsRunner
    metrics_loader: MetricsLoader = load_cached_metrics
    live_metrics: LiveEarthObs | None = None
    """Live Earth Engine for new polygons (T60); None when `EARTH_ENGINE_LIVE` is off."""
    evidence: EvidenceProvider = field(default_factory=NoFieldEvidence)
    today: Callable[[], date] = field(default=lambda: datetime.now(UTC).date())
    max_pending: int = MAX_PENDING_RUNS
    _slots: threading.BoundedSemaphore = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._slots = threading.BoundedSemaphore(self.max_pending)

    # --- starting ---

    def start(
        self,
        world_id: UUID,
        asset_id: UUID,
        *,
        scenario: ScenarioName | None = None,
        trigger: Trigger = "api",
        max_runs_per_hour: int | None = None,
        on_queue: QueueHook | None = None,
        metrics: EarthObsMetrics | None = None,
        based_on_report: int | None = None,
        inline: bool = False,
    ) -> UUID:
        """Record a queued run and hand it to a worker; returns its `run_id`.

        Raises LookupError (asset not in this world), AssetNotRateable, RunInProgress,
        RunRateLimited or RunnerBusy. ``max_runs_per_hour`` overrides the per-world cap
        (`RATING_RUNS_PER_WORLD_PER_HOUR`), e.g. for a Time Machine quarter (T38).
        ``on_queue`` (T58's submit) takes its locks first (`on_queue.lock`, before the
        publisher lock) and writes once every check passed, just before `queued` is published,
        so its writes commit with the queued run or not at all. Without it, listings under
        review are refused (`asset_is_draft`, `asset_not_listed`): they are rated through
        submit only. ``metrics`` (T38's Time Machine) replaces the loader's metrics for this run;
        its scenario is the run's, and ``based_on_report`` is the report version they were
        computed from (see `RunSpec`). ``inline`` executes the run in the calling thread before
        returning (T38), still holding one of this runner's slots, so inline and pooled runs
        share the same concurrency limit.
        """
        if not self._slots.acquire(blocking=False):
            raise RunnerBusy()
        try:
            spec = RunSpec(
                run_id=uuid4(),
                world_id=world_id,
                asset_id=asset_id,
                scenario=metrics.scenario if metrics is not None else scenario or "baseline",
                trigger=trigger,
                metrics=metrics,
                based_on_report=based_on_report,
            )
            cap = max_runs_per_hour or self.settings.rating_runs_per_world_per_hour
            spec = self._enqueue(spec, cap, on_queue)
            if not inline:
                self.executor.submit(self._execute_and_release, spec)
        except BaseException:
            self._slots.release()
            raise
        if inline:
            self._execute_and_release(spec)  # `execute` never raises; releases the slot
        return spec.run_id

    def _enqueue(self, spec: RunSpec, cap: int, on_queue: QueueHook | None = None) -> RunSpec:
        with self.session_factory() as session:
            try:
                return self._enqueue_locked(session, spec, cap, on_queue)
            except OperationalError as exc:  # lock_timeout (or a lost connection)
                session.rollback()
                raise RunnerBusy() from exc

    def _enqueue_locked(
        self, session: Session, spec: RunSpec, cap: int, on_queue: QueueHook | None = None
    ) -> RunSpec:
        session.execute(
            text("SELECT set_config('lock_timeout', :value, true)"),
            {"value": f"{LOCK_TIMEOUT_MS}ms"},
        )
        # Lock order: global run lock, the hook's locks (world, listings, asset; T58), then the
        # world's publisher lock (see module docstring).
        session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": GLOBAL_RUNS_LOCK_KEY})
        if on_queue is not None:
            on_queue.lock(session, spec.world_id, spec.asset_id)
        lock_world_publisher(session, spec.world_id)
        asset = _world_asset(session, spec.world_id, spec.asset_id)
        if asset is None:
            raise LookupError(f"asset {spec.asset_id} not found in world {spec.world_id}")
        if on_queue is None and not is_public(asset.status):
            # Listings under review are rated through T58's submit, never re-rated directly.
            draft = asset.status is AssetStatus.DRAFT
            raise AssetNotRateable("asset_is_draft" if draft else "asset_not_listed")
        now, recent = _recent_runs(session, spec.world_id)
        for run in recent.values():
            if run.asset_id == spec.asset_id and run.active(now):
                raise RunInProgress(run.run_id)
        # Scheduled re-rates (T75) don't use up the world's hourly window, so a monitoring run
        # never locks people out of rating; the global cap below still counts them.
        counted = [
            run
            for run in recent.values()
            if spec.trigger == "scheduled" or run.trigger != "scheduled"
        ]
        queued = sorted(run.queued_at for run in counted if run.queued_at is not None)
        if len(queued) >= cap:
            raise RunRateLimited(_cap_retry_after(queued[len(queued) - cap], now))
        global_cap = self.settings.rating_runs_global_per_hour
        oldest = _global_cap_reached(session, now, global_cap)
        if oldest is not None:
            raise RunRateLimited(_cap_retry_after(oldest, now), code="rating_global_limit")
        if on_queue is not None:
            on_queue(session, asset, spec.run_id)
        spec = replace(spec, audience=listing_audience(asset))
        publish(
            session,
            spec.world_id,
            StreamEventType.RATING_PROGRESS,
            {
                "run_id": str(spec.run_id),
                "asset_id": str(spec.asset_id),
                "seq": 0,
                "step": "queued",
                "status": RatingRunStatus.QUEUED.value,
                "trigger": spec.trigger,
                "scenario": spec.scenario,
            },
            audience=spec.audience,
        )
        session.commit()
        return spec

    # --- executing ---

    def _execute_and_release(self, spec: RunSpec) -> None:
        try:
            self.execute(spec)
        finally:
            self._slots.release()

    def _client(
        self, trigger: Trigger
    ) -> tuple[LLMClient | None, FallbackReason | None, RecordingCallLog | None]:
        if self.settings.use_mocks:
            return None, FallbackReason.USE_MOCKS, None
        recorders: list[RecordingCallLog] = []

        def wrap(inner: CallLog) -> CallLog:
            recorder = RecordingCallLog(inner)
            recorders.append(recorder)
            return recorder

        try:
            llm = self.llm_factory(wrap)
        except LLMError:
            llm = None
        if llm is None:
            return None, FallbackReason.LLM_UNAVAILABLE, None
        recorder = recorders[0] if recorders else None
        reserve = Decimal(str(self.settings.llm_reserve_usd))
        if trigger == "api" and reserve > 0 and recorder is not None:
            remaining = Decimal(str(self.settings.llm_budget_usd)) - recorder.spent_usd()
            if remaining < reserve:
                return None, FallbackReason.BUDGET_RESERVE, None
        return llm, None, recorder

    def execute(self, spec: RunSpec) -> None:
        """Run the orchestration and store the sealed report. Never raises: a failure ends
        the run with a `done` / `failed` event carrying an error code."""
        progress = RunProgress(spec, self.session_factory, seq=0)
        started = time.perf_counter()
        try:
            asset = self._asset_info(spec)
            llm, no_llm_reason, recorder = self._client(spec.trigger)
            if not self._claim(spec, progress, llm, no_llm_reason, started):
                return
            deps = RunDeps(
                session_factory=self.session_factory,
                settings=self.settings,
                metrics_loader=self.metrics_loader,
                news=self.news,
                evidence=self.evidence,
                today=self.today,
                live=self.live_metrics,
            )
            toolbox = RunToolbox(
                spec,
                asset,
                deps,
                llm=llm,
                no_llm_reason=no_llm_reason,
                progress=progress,
                recorder=recorder,
            )
            orchestration = orchestrate(
                toolbox,
                llm,
                world_id=spec.world_id,
                asset_id=spec.asset_id,
                no_llm_reason=no_llm_reason or FallbackReason.LLM_UNAVAILABLE,
            )
            self._store(spec, toolbox, orchestration, progress, recorder, started)
        except RunAborted as exc:
            self._fail(progress, exc.code, started)
        except Exception:
            log.exception("rating run %s failed", spec.run_id)
            self._fail(progress, "internal_error", started)

    def _claim(
        self,
        spec: RunSpec,
        progress: RunProgress,
        llm: LLMClient | None,
        no_llm_reason: FallbackReason | None,
        started: float,
    ) -> bool:
        """Publish `started`, unless the run went stale while it waited for a worker.

        Runs under the world's publisher lock, the lock `_enqueue` checks activity under, so
        a run is either still active (and a new one for the asset gets 409) or it is closed
        here as `failed: stale` before any model is called (and may already be replaced).
        """
        with self.session_factory() as session:
            lock_world_publisher(session, spec.world_id)
            now = _db_now(session)
            run = _run_events(session, spec.world_id, spec.run_id)
            if run is None or not run.active(now):
                fields: dict[str, Any] = {
                    "error": "stale",
                    "latency_ms": int((time.perf_counter() - started) * 1000),
                }
                step, status = "done", RatingRunStatus.FAILED.value
            else:
                fields = {
                    "pipeline": "fixed" if llm is None else "orchestrator",
                    "reason": no_llm_reason.value if no_llm_reason else None,
                }
                step, status = "started", RatingRunStatus.RUNNING.value
            publish(
                session,
                spec.world_id,
                StreamEventType.RATING_PROGRESS,
                progress.payload(step, status, **fields),
                audience=spec.audience,
            )
            session.commit()
        if step == "done":
            log.warning("rating run %s went stale before a worker picked it up", spec.run_id)
            self._note_listing_failure(spec, "stale")  # own transaction: asset, then publisher
            return False
        return True

    def _asset_info(self, spec: RunSpec) -> AssetInfo:
        with self.session_factory() as session:
            asset = _world_asset(session, spec.world_id, spec.asset_id)
            if asset is None:
                raise RunAborted("asset_not_found")
            return asset_info(asset)

    def metrics_probe(self, asset: Asset) -> MetricsProbe:
        """What a run's metrics would be for `asset` now, without computing anything (T58's
        resubmit check, T60's quota). Never raises for missing metrics."""
        try:
            metrics = resolve_metrics(
                self.metrics_loader,
                asset_info(asset),
                "baseline",
                self.settings.use_mocks,
                self.live_metrics,
            )
        except ToolFailed as exc:
            if exc.code == LIVE_METRICS_PENDING and self.live_metrics is not None:
                return MetricsProbe(self.live_metrics.data_version, live_compute=True)
            return MetricsProbe(None)
        return MetricsProbe(metrics.data_version)

    def live_area_allowed(self, asset: Asset) -> bool:
        """Whether `asset` is small enough to compute live (`EARTH_ENGINE_LIVE_MAX_HA`)."""
        live = self.live_metrics
        return live is None or live.area_allowed(float(asset.area_ha))

    def live_quota(self, asset: Asset, user_id: UUID) -> LiveQuota:
        """The live rating a submit of `asset` by `user_id` counts (T60)."""
        return LiveQuota(
            user_id=user_id,
            geometry_sha256=geometry_sha256(asset.geojson),
            per_user_per_day=self.settings.live_ratings_per_user_per_day,
            global_per_day=self.settings.live_ratings_global_per_day,
        )

    def _store(
        self,
        spec: RunSpec,
        toolbox: RunToolbox,
        orchestration: Orchestration,
        progress: RunProgress,
        recorder: RecordingCallLog | None,
        started: float,
    ) -> None:
        audit = toolbox.audit
        if audit is None or toolbox.metrics is None or toolbox.is_wetland is None:
            raise RunAborted("incomplete_run")
        reasons = degraded_reasons(orchestration, audit, toolbox.failed)
        degraded = bool(reasons)
        flags = list(toolbox.flags)
        if orchestration.degraded_model:
            flags.append(
                _flag(
                    "degraded_model",
                    "orchestrator",
                    "A lower model tier answered part of the orchestration.",
                )
            )
        if audit.degraded and not audit.fallback:
            flags.append(
                _flag(
                    "degraded_model",
                    "auditor",
                    f"The audit came from the {audit.source} tier, not Ultra.",
                )
            )
        status = RatingRunStatus.DEGRADED if degraded else RatingRunStatus.SUCCEEDED
        tail = usage(recorder.drain() if recorder else [])
        record: dict[str, Any] = {
            "run_id": str(spec.run_id),
            "trigger": spec.trigger,
            "scenario": spec.scenario,
            "method_version": ORCHESTRATION_VERSION,
            "as_of": toolbox.as_of.isoformat(),
            "status": status.value,
            "pipeline": orchestration.pipeline,
            "degraded": degraded,
            "reasons": reasons,
            "orchestrator": orchestration.to_json(),
            "steps": list(toolbox.steps),
            "totals": _totals(recorder),
        }
        with self.session_factory() as session:
            # Same lock order as orders (T17) and listings (T58): world, then the asset row
            # (locked here, so the listing transition below reads its current status), then
            # the publisher lock.
            session.exec(
                select(World.id).where(World.id == spec.world_id).with_for_update(key_share=True)
            ).one()
            try:
                asset = lock_asset(session, spec.world_id, spec.asset_id)
            except LookupError as exc:
                raise RunAborted("asset_not_found") from exc
            previous = latest_report(session, spec.world_id, spec.asset_id)
            if spec.based_on_report is not None and (
                previous is None or previous.version != spec.based_on_report
            ):
                raise RunAborted(STALE_METRICS)  # re-rated since: the metrics are out of date
            # `rate_asset` prices per share with the locked row's `total_shares`, re-read here,
            # never the `AssetInfo` captured when the run started: an IPO (T59) may have set
            # the share count since (launches are refused while a run is active; this is
            # defence in depth).
            report = rate_asset(
                session,
                spec.world_id,
                asset,
                metrics=toolbox.metrics,
                as_of=toolbox.as_of,
                previous_report=previous,
                is_wetland=toolbox.is_wetland,
                events=toolbox.events,
                audit=audit,
                run=record,
                extra_flags=flags,
            )
            listing = apply_rating_result(session, asset, report)
            if not self.settings.use_mocks:
                # The news this run found shows on the asset page at once. The daily sweep
                # alerts on it; a rating run never does.
                record_news(session, spec.world_id, spec.asset_id, toolbox.news_items, alert=False)
            publish(
                session,
                spec.world_id,
                StreamEventType.RATING_PROGRESS,
                progress.payload(
                    "done",
                    status.value,
                    pipeline=orchestration.pipeline,
                    degraded=degraded,
                    reasons=reasons,
                    report_id=str(report.id),
                    version=report.version,
                    grade=report.grade,
                    previous_grade=previous.grade if previous else None,
                    health_score=str(report.health_score),
                    confidence=str(report.confidence),
                    fair_value_per_share=str(report.fair_value_per_share),
                    greenwashing_risk=audit.greenwashing_risk,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    totals=record["totals"],
                    llm_calls=tail["llm_calls"],
                    **({"listing_status": listing.to_status.value} if listing else {}),
                ),
                audience=spec.audience,
            )
            # T75: health Δ ≥ 5 or a grade change alerts the holders and the community, with
            # the report (same transaction, so no alert without its report).
            alert_on_rerate(session, spec.world_id, asset, previous, report)
            # T38: a re-rate of a trading asset that changed its data or health pulls its price
            # toward the new fair value.
            reanchor_on_rerate(session, asset, previous, report)
            events = _run_events(session, spec.world_id, spec.run_id)
            if events is None:
                raise RuntimeError("completed rating run has no progress events")
            record["trace_steps"] = [
                {"payload": payload, "ts": ts.isoformat()} for payload, ts in events.events
            ]
            report.auditor_json = {**(report.auditor_json or {}), "run": record}
            session.add(report)
            session.commit()

    def _fail(self, progress: RunProgress, code: str, started: float) -> None:
        try:
            progress.emit(
                "done",
                RatingRunStatus.FAILED.value,
                error=code[:120],
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        except SQLAlchemyError:
            log.exception("could not publish the failure of a rating run")
        self._note_listing_failure(progress.spec, code[:120])

    def _note_listing_failure(self, spec: RunSpec, code: str) -> None:
        try:
            with self.session_factory() as session:
                changed = note_rating_failure(session, spec.world_id, spec.asset_id, code)
                # A run that never reached Earth Engine gives its live rating back (T60).
                refunded = code in NOT_COMPUTED and refund_live_rating(session, spec.run_id)
                if changed or refunded:
                    session.commit()
        except SQLAlchemyError:
            log.exception("could not record why a listing's rating run failed")


# ----- status from events -----------------------------------------------------------------------


@dataclass(slots=True)
class _RunEvents:
    run_id: UUID
    asset_id: UUID
    events: list[tuple[dict[str, Any], datetime]] = field(default_factory=list)

    @property
    def queued_at(self) -> datetime | None:
        return next((ts for p, ts in self.events if p.get("step") == "queued"), None)

    @property
    def trigger(self) -> str | None:
        return next((p.get("trigger") for p, _ in self.events if p.get("step") == "queued"), None)

    @property
    def done(self) -> dict[str, Any] | None:
        return next((p for p, _ in self.events if p.get("step") == "done"), None)

    @property
    def last_at(self) -> datetime:
        return self.events[-1][1]

    def active(self, now: datetime) -> bool:
        return self.done is None and now - self.last_at < RUN_STALE_AFTER


def _group(rows: Sequence[tuple[Mapping[str, Any], datetime]]) -> dict[str, _RunEvents]:
    runs: dict[str, _RunEvents] = {}
    for payload, ts in rows:
        try:
            run_id, asset_id = UUID(str(payload["run_id"])), UUID(str(payload["asset_id"]))
        except (KeyError, ValueError):
            continue
        run = runs.setdefault(str(run_id), _RunEvents(run_id, asset_id))
        run.events.append((dict(payload), ts))
    return runs


def _db_now(session: Session) -> datetime:
    return session.exec(select(func.now())).one()


def _recent_runs(session: Session, world_id: UUID) -> tuple[datetime, dict[str, _RunEvents]]:
    """Runs with any event in the last `RUN_WINDOW` (enough for caps and staleness)."""
    now = _db_now(session)
    rows = session.exec(
        select(WorldEvent.payload, WorldEvent.created_at)
        .where(
            WorldEvent.world_id == world_id,
            WorldEvent.type == StreamEventType.RATING_PROGRESS,
            col(WorldEvent.created_at) > now - RUN_WINDOW,
        )
        .order_by(col(WorldEvent.id))
    ).all()
    return now, _group([(payload, ts) for payload, ts in rows])


def active_run(session: Session, world_id: UUID, asset_id: UUID) -> UUID | None:
    """The asset's active run, if any. Exact only under the world's publisher lock."""
    now, recent = _recent_runs(session, world_id)
    return next(
        (run.run_id for run in recent.values() if run.asset_id == asset_id and run.active(now)),
        None,
    )


def run_active(session: Session, world_id: UUID, asset_id: UUID) -> bool:
    return active_run(session, world_id, asset_id) is not None


def assets_with_active_runs(session: Session, world_id: UUID) -> set[UUID]:
    now, recent = _recent_runs(session, world_id)
    return {run.asset_id for run in recent.values() if run.active(now)}


def latest_run_id(session: Session, world_id: UUID, asset_id: UUID) -> UUID | None:
    """The asset's newest run: its latest `queued` event while events are kept (T29 prunes
    them after 24 h), else the run recorded with its latest report; None before any run."""
    payload_col = cast(Any, WorldEvent.payload)
    queued = session.exec(
        select(WorldEvent.payload)
        .where(
            WorldEvent.world_id == world_id,
            WorldEvent.type == StreamEventType.RATING_PROGRESS,
            payload_col["asset_id"].astext == str(asset_id),
            payload_col["step"].astext == "queued",
        )
        .order_by(col(WorldEvent.id).desc())
        .limit(1)
    ).first()
    if queued is not None and isinstance(queued.get("run_id"), str):
        return UUID(queued["run_id"])
    stored = session.exec(
        select(Report.auditor_json)
        .where(Report.world_id == world_id, Report.asset_id == asset_id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()
    run = (stored or {}).get("run") if isinstance(stored, dict) else None
    run_id = run.get("run_id") if isinstance(run, dict) else None
    return UUID(run_id) if isinstance(run_id, str) else None


def global_runs_queued(session: Session, now: datetime) -> list[datetime]:
    """When each run queued in the last `RUN_WINDOW`, across every world, newest first."""
    payload_col = cast(Any, WorldEvent.payload)
    return list(
        session.exec(
            select(WorldEvent.created_at)
            .where(
                WorldEvent.type == StreamEventType.RATING_PROGRESS,
                col(WorldEvent.created_at) > now - RUN_WINDOW,
                payload_col["step"].astext == "queued",
            )
            .order_by(col(WorldEvent.created_at).desc())
        ).all()
    )


def _global_cap_reached(session: Session, now: datetime, cap: int) -> datetime | None:
    """The queue time whose expiry frees a global slot, or None while under the cap."""
    queued = global_runs_queued(session, now)
    return queued[cap - 1] if len(queued) >= cap else None


def _run_events(session: Session, world_id: UUID, run_id: UUID) -> _RunEvents | None:
    payload_col = cast(Any, WorldEvent.payload)
    rows = session.exec(
        select(WorldEvent.payload, WorldEvent.created_at)
        .where(
            WorldEvent.world_id == world_id,
            WorldEvent.type == StreamEventType.RATING_PROGRESS,
            payload_col["run_id"].astext == str(run_id),
        )
        .order_by(col(WorldEvent.id))
    ).all()
    return _group([(payload, ts) for payload, ts in rows]).get(str(run_id))


def _report_for_run(
    session: Session, world_id: UUID, run_id: UUID, asset_id: UUID | None = None
) -> Report | None:
    stored = cast(Any, Report.auditor_json)
    stmt = select(Report).where(
        Report.world_id == world_id, stored["run"]["run_id"].astext == str(run_id)
    )
    if asset_id is not None:
        stmt = stmt.where(Report.asset_id == asset_id)
    return session.exec(stmt.limit(1)).first()


class _StepView(BaseModel):
    """Lenient reader for a step payload (older or partial events still render)."""

    step: str
    status: str
    tool: str | None = None
    pipeline: str | None = None
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int | None = None
    cost_usd: Decimal | None = None
    error: str | None = None


def _step_out(payload: Mapping[str, Any], ts: datetime | None) -> RatingRunStep:
    view = _StepView.model_validate(
        {key: payload.get(key) for key in _StepView.model_fields if payload.get(key) is not None}
    )
    return RatingRunStep(**view.model_dump(), ts=ts)


def _from_report(report: Report, run: Mapping[str, Any], run_id: UUID) -> RatingRunOut:
    status = RatingRunStatus(run.get("status", RatingRunStatus.SUCCEEDED.value))
    return RatingRunOut(
        run_id=run_id,
        asset_id=report.asset_id,
        status=status,
        trigger=run.get("trigger"),
        scenario=run.get("scenario"),
        pipeline=run.get("pipeline"),
        degraded=bool(run.get("degraded")),
        reasons=[str(reason) for reason in run.get("reasons", [])],
        error=None,
        report_id=report.id,
        version=report.version,
        grade=report.grade,
        health_score=report.health_score,
        confidence=report.confidence,
        steps=[_step_out(step, None) for step in run.get("steps", [])],
        created_at=None,
        updated_at=report.created_at,
    )


def get_run(
    session: Session, world_id: UUID, run_id: UUID, *, now: datetime | None = None
) -> RatingRunOut | None:
    """A run's status, rebuilt from its events (any worker can answer), or from the report's
    run record once the events are pruned. None when the run isn't in this world."""
    run = _run_events(session, world_id, run_id)
    if run is None:
        sealed = _report_for_run(session, world_id, run_id)
        stored = (sealed.auditor_json or {}).get("run") if sealed else None
        return _from_report(sealed, stored, run_id) if sealed and stored else None

    now = now or _db_now(session)
    first = run.events[0][0]
    done = run.done
    report: Report | None = None
    error: str | None = None
    if done is not None:
        status = RatingRunStatus(done["status"])
        error = done.get("error")
    elif (report := _report_for_run(session, world_id, run_id, run.asset_id)) is not None:
        stored_run = (report.auditor_json or {}).get("run") or {}
        status = RatingRunStatus(stored_run.get("status", RatingRunStatus.SUCCEEDED.value))
    elif not run.active(now):
        status, error = RatingRunStatus.FAILED, "stale"
    elif all(payload.get("step") == "queued" for payload, _ in run.events):
        status = RatingRunStatus.QUEUED
    else:
        status = RatingRunStatus.RUNNING
    pipeline = next((p.get("pipeline") for p, _ in reversed(run.events) if p.get("pipeline")), None)
    final = done or {}
    report_id = final.get("report_id") or (str(report.id) if report else None)
    return RatingRunOut(
        run_id=run_id,
        asset_id=run.asset_id,
        status=status,
        trigger=first.get("trigger"),
        scenario=first.get("scenario"),
        pipeline=pipeline,
        degraded=bool(final.get("degraded", status is RatingRunStatus.DEGRADED)),
        reasons=[str(reason) for reason in final.get("reasons", [])],
        error=error,
        report_id=UUID(report_id) if report_id else None,
        version=final.get("version") or (report.version if report else None),
        grade=final.get("grade") or (report.grade if report else None),
        health_score=final.get("health_score") or (report.health_score if report else None),
        confidence=final.get("confidence") or (report.confidence if report else None),
        steps=[_step_out(payload, ts) for payload, ts in run.events],
        created_at=run.events[0][1],
        updated_at=run.last_at,
    )


def model_usage(
    calls: Sequence[Mapping[str, Any]], *, baseline_model: str
) -> tuple[list[ModelUsage], CostBaseline | None]:
    """Group a run's recorded calls by model, and price its text-model tokens on
    `baseline_model` (embeddings and image reading have no text-model equivalent)."""
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for call in calls:
        grouped.setdefault(str(call.get("model") or "unknown"), []).append(call)
    models = [
        ModelUsage(
            model=model,
            calls=len(rows),
            prompt_tokens=sum(int(r.get("prompt_tokens") or 0) for r in rows),
            completion_tokens=sum(int(r.get("completion_tokens") or 0) for r in rows),
            latency_ms=sum(int(r.get("latency_ms") or 0) for r in rows),
            cost_usd=sum((Decimal(str(r.get("cost_usd") or 0)) for r in rows), Decimal(0)),
        )
        for model, rows in grouped.items()
    ]
    models.sort(key=lambda m: m.cost_usd, reverse=True)
    text = [c for c in calls if c.get("tier") not in ("embed", "perception")]
    if not text or baseline_model not in PRICES_PER_M:
        return models, None
    cost = sum(
        (
            cost_usd(
                baseline_model,
                int(c.get("prompt_tokens") or 0),
                int(c.get("completion_tokens") or 0),
            )
            for c in text
        ),
        Decimal(0),
    )
    return models, CostBaseline(model=baseline_model, cost_usd=cost)


def get_run_trace(session: Session, world_id: UUID, run_id: UUID) -> RunTraceOut | None:
    """Read the scoped run's spans, or the sealed report's snapshot after event pruning."""
    run = get_run(session, world_id, run_id)
    if run is None:
        return None
    events = _run_events(session, world_id, run_id)
    spans: list[tuple[dict[str, Any], datetime | None]]
    stored: dict[str, Any] = {}
    if events is not None:
        spans = [(payload, ts) for payload, ts in events.events]
    else:
        report = _report_for_run(session, world_id, run_id, run.asset_id)
        if report is None:
            return None
        stored = (report.auditor_json or {}).get("run") or {}
        archived = stored.get("trace_steps")
        spans = (
            [(item["payload"], datetime.fromisoformat(item["ts"])) for item in archived]
            if archived is not None
            else [(step, None) for step in stored.get("steps", [])]
        )
    # The runner's own totals (every call, including the tail on the `done` span), stored on
    # the `done` span and in the report's run record; none before the run seals a report.
    totals = next(
        (p["totals"] for p, _ in reversed(spans) if isinstance(p.get("totals"), dict)),
        stored.get("totals"),
    )
    calls = [c for payload, _ in spans for c in payload.get("llm_calls", []) or []]
    models, baseline = model_usage(calls, baseline_model=get_settings().model_auditor)
    return RunTraceOut(
        totals=RunTraceTotals.model_validate(totals) if isinstance(totals, dict) else None,
        models=models,
        baseline=baseline,
        run_id=run_id,
        asset_id=run.asset_id,
        status=run.status,
        steps=[
            RunTraceStep.model_validate(
                {
                    **_step_out(payload, ts).model_dump(),
                    "attempts": payload.get("attempts"),
                    "output": payload.get("output"),
                    "llm_calls": payload.get("llm_calls", []),
                }
            )
            for payload, ts in spans
        ],
    )


# ----- the process-wide runner ------------------------------------------------------------------


class InlineExecutor(Executor):
    """Runs each rating run in the calling thread, so the caller waits for every run it starts
    (T75's jobs, T38's Time Machine)."""

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as exc:
            future.set_exception(exc)
        return future


_default_runner: RatingRunner | None = None
_default_lock = threading.Lock()


def _production_llm(settings: Settings, session_factory: Callable[[], Session]) -> LlmFactory:
    from app.llm import get_llm_client

    def factory(wrap: Callable[[CallLog], CallLog]) -> LLMClient | None:
        return get_llm_client(settings, session_factory, wrap_log=wrap)

    return factory


def default_runner() -> RatingRunner:
    """The API's runner: a small thread pool, sessions on the app engine, settings from env."""
    global _default_runner
    with _default_lock:
        if _default_runner is None:
            from app.config import get_settings
            from app.db import engine

            def session_factory() -> Session:
                return Session(engine)

            _default_runner = build_runner(
                get_settings(),
                session_factory,
                ThreadPoolExecutor(max_workers=RUN_WORKERS, thread_name_prefix="rating-run"),
            )
        return _default_runner


def build_runner(
    settings: Settings, session_factory: Callable[[], Session], executor: Executor
) -> RatingRunner:
    """A production runner on `executor` (the API's thread pool; T75's jobs run inline)."""
    return RatingRunner(
        session_factory=session_factory,
        settings=settings,
        executor=executor,
        llm_factory=_production_llm(settings, session_factory),
        news=news_runner(settings),
        live_metrics=build_live_earth_obs(settings, session_factory),
        evidence=DbEvidenceProvider(session_factory),
    )


def start_rating_run(
    world_id: UUID,
    asset_id: UUID,
    *,
    scenario: ScenarioName | None = None,
    trigger: Trigger = "api",
    max_runs_per_hour: int | None = None,
) -> UUID:
    """Start a rating run on the process-wide runner (API, Time Machine T38, listings T58/T60).

    Returns the `run_id` at once; follow it with `GET /runs/{run_id}` or the SSE stream.
    """
    return default_runner().start(
        world_id,
        asset_id,
        scenario=scenario,
        trigger=trigger,
        max_runs_per_hour=max_runs_per_hour,
    )

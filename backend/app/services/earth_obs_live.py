"""Live Earth Engine metrics for new listings (T60).

A new listing's polygon has no precomputed metrics, so its rating run computes them live with the
T11/T13 methods (`app.tools.earth_engine.compute_polygon_metrics`, the same code as
`scripts/precompute_sites.py`): in the **live world**, and in **demo sandboxes** so judges can
rate land of their choice. `live_policy` is the one place that decides whether a world computes
and which caps apply; the template never computes.

- **Cache:** results are stored in `earth_obs_cache`, keyed by the SHA-256 of the bare geometry
  and the data version, so a polygon is computed once per data version. A row that doesn't
  describe its polygon is a miss: it is deleted and the polygon computed again.
- **Timeout and concurrency:** at most `EARTH_ENGINE_MAX_CONCURRENT` computations run at once
  **per API process** (one by default; the daily quotas below are global, in the database). A
  live-world run waits up to `EARTH_ENGINE_TIMEOUT_S` for a slot (`earth_engine_busy`); a
  sandbox run takes a slot only if one is free right now, so it never queues ahead of the live
  world. Either then has `EARTH_ENGINE_TIMEOUT_S` to finish (`earth_engine_timeout`). The
  computation checks its deadline before each Earth Engine round trip and each request has the
  same deadline (no retries), so an abandoned one stops soon after and only then frees its slot.
  A result that still arrives after the deadline is cached by the worker thread, so the retry is
  free.
- **Area:** polygons above `EARTH_ENGINE_LIVE_MAX_HA` are never computed (`live_area_too_large`).
- **Quotas:** `reserve_live_rating` counts a live rating in the transaction that queues the run:
  against the submitting account (`LIVE_RATINGS_PER_USER_PER_DAY`, sandbox personas included),
  then for a sandbox against that sandbox (`SANDBOX_LIVE_RATINGS_PER_WORLD_PER_DAY`), then
  against the world's pool: the live world's own (`LIVE_RATINGS_GLOBAL_PER_DAY`), or every
  sandbox's together (`SANDBOX_LIVE_RATINGS_PER_DAY`); neither pool counts the other's. Only
  submits that need a computation count; a cache hit is free, and a run that never reached
  Earth Engine (`earth_engine_busy`, or stale before a worker took it) is refunded. In the live
  world a spent quota is a 429; in a sandbox it is a hidden guardrail: the run doesn't compute
  and falls back as if sandboxes never did. `LLM_BUDGET_USD` stays the hard cap for the run's
  model calls, and `SANDBOX_LLM_BUDGET_USD` a sandbox's (`app/llm.py`).

Tests never call Earth Engine: they plug in a fake `EarthEngineClient`.
"""

from __future__ import annotations

import logging
import math
import sys
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import ColumnElement, delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, col, select

from app.config import Settings
from app.models import EarthObsCache, LiveRatingRequest
from app.tools.earth_obs import EarthObsMetrics
from app.tools.geometry import bare_geometry, check_shape, geometry_sha256, metrics_match_polygon
from app.worlds import LIVE_WORLD_ID, PROTECTED_WORLDS, is_sandbox_world

log = logging.getLogger(__name__)

LIVE_DATA_VERSION = "2026Q3"
"""`app.tools.earth_engine.DATA_VERSION` (kept here so the API needn't import Earth Engine)."""
LIVE_SITE_KEY_PREFIX = "live_"
QUOTA_WINDOW = timedelta(days=1)
QUOTA_RETENTION = timedelta(days=2)

EARTH_ENGINE_BUSY = "earth_engine_busy"
EARTH_ENGINE_TIMEOUT = "earth_engine_timeout"
EARTH_ENGINE_ERROR = "earth_engine_error"
EARTH_ENGINE_INVALID_OUTPUT = "earth_engine_invalid_output"
LIVE_AREA_TOO_LARGE = "live_area_too_large"
LIVE_RATING_QUOTA = "live_rating_quota"
LIVE_RATING_WORLD_LIMIT = "live_rating_world_limit"
"""A sandbox's own daily cap; never shown (a sandbox falls back instead)."""
LIVE_RATING_GLOBAL_LIMIT = "live_rating_global_limit"

Checkpoint = Callable[[], None]


class EarthEngineClient(Protocol):
    """Computes a polygon's metrics document (`EarthObsMetrics` JSON). The real one is
    `app.tools.earth_engine.EarthEngineApi`; tests use a fake."""

    def compute(
        self, geojson: Mapping[str, Any], *, site_key: str, checkpoint: Checkpoint
    ) -> dict[str, Any]: ...


class LiveMetricsError(Exception):
    """A live computation failed; `code` is one of the `EARTH_ENGINE_*` codes."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class LiveQuotaExceeded(Exception):
    def __init__(self, code: str, retry_after_s: int) -> None:
        super().__init__(f"{code}: retry in {retry_after_s} s")
        self.code = code
        self.retry_after_s = retry_after_s


class _DeadlinePassed(Exception):
    pass


@dataclass(frozen=True, slots=True)
class LivePolicy:
    """Whether a world computes new polygons live, and under which caps (see `live_policy`)."""

    computes: bool
    """A listing submit may compute a new polygon live (with live Earth Engine on)."""
    sandbox: bool
    """Sandbox rules: a refused live rating falls back silently instead of a 429/409, the
    computation slot is taken only if free right now, and overlays and views render only what
    the run computed itself, on their own lane."""
    per_user_per_day: int
    per_world_per_day: int | None
    """The world's own daily cap; None for the live world, whose pool is the world itself."""
    pool_per_day: int
    """The pool's daily cap: the live world's requests, or every sandbox's together."""


NO_LIVE = LivePolicy(
    computes=False, sandbox=False, per_user_per_day=0, per_world_per_day=0, pool_per_day=0
)
"""Never computes: the template, and a sandbox run falling back."""


def live_policy(world_id: UUID, settings: Settings) -> LivePolicy:
    """How `world_id` computes new polygons live (T60): the live world with its own allowance,
    demo sandboxes with per-sandbox and shared allowances (none: never computes), the template
    never."""
    if world_id == LIVE_WORLD_ID:
        return LivePolicy(
            computes=True,
            sandbox=False,
            per_user_per_day=settings.live_ratings_per_user_per_day,
            per_world_per_day=None,
            pool_per_day=settings.live_ratings_global_per_day,
        )
    if not is_sandbox_world(world_id):
        return NO_LIVE
    per_world, pool = (
        settings.sandbox_live_ratings_per_world_per_day,
        settings.sandbox_live_ratings_per_day,
    )
    return LivePolicy(
        computes=per_world > 0 and pool > 0,
        sandbox=True,
        per_user_per_day=settings.live_ratings_per_user_per_day,
        per_world_per_day=per_world,
        pool_per_day=pool,
    )


def live_site_key(sha256: str) -> str:
    """`site_key` of live metrics: never a curated site's key (those have committed files)."""
    return f"{LIVE_SITE_KEY_PREFIX}{sha256[:16]}"


def loggable(exc: BaseException) -> str:
    """What may be logged about a failure: the exception type, plus the message of an Earth
    Engine error only (other messages, e.g. a file error, could contain the key setting)."""
    ee = sys.modules.get("ee")
    if ee is not None and isinstance(exc, ee.EEException):
        return f"{type(exc).__name__}: {str(exc)[:200]}"
    return type(exc).__name__


@dataclass
class LiveEarthObs:
    """Cached live Earth Engine metrics for any validated polygon."""

    session_factory: Callable[[], Session]
    client: EarthEngineClient
    timeout_s: float
    max_concurrent: int = 1
    max_area_ha: float | None = None
    clock: Callable[[], float] = time.monotonic
    data_version: str = LIVE_DATA_VERSION
    _slots: threading.BoundedSemaphore = field(init=False, repr=False)
    _executor: ThreadPoolExecutor = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._slots = threading.BoundedSemaphore(self.max_concurrent)
        self._executor = ThreadPoolExecutor(
            max_workers=self.max_concurrent, thread_name_prefix="earth-engine"
        )

    def area_allowed(self, area_ha: float) -> bool:
        return self.max_area_ha is None or area_ha <= self.max_area_ha

    def cached(self, geojson: Mapping[str, Any]) -> EarthObsMetrics | None:
        """The cached metrics of this exact geometry for the current data version, or None. A
        row that is unreadable or doesn't describe the polygon is deleted (a miss), so it can
        never rate a listing nor leave one waiting for metrics forever."""
        sha256 = geometry_sha256(geojson)
        key = (sha256, self.data_version)
        with self.session_factory() as session:
            row = session.get(EarthObsCache, key)
            if row is None:
                return None
            try:
                metrics = EarthObsMetrics.model_validate(row.metrics)
            except ValidationError:
                metrics = None
            if metrics is not None and self._describes(geojson, sha256, metrics):
                return metrics
            log.warning("deleting an earth_obs_cache row that doesn't describe its polygon")
            session.delete(row)
            session.commit()
        return None

    def load(self, geojson: Mapping[str, Any]) -> EarthObsMetrics:
        """Cached metrics, else a live computation (stored in the cache). Raises
        LiveMetricsError."""
        return self.cached(geojson) or self.compute(geojson)

    def compute(self, geojson: Mapping[str, Any], *, wait: bool = True) -> EarthObsMetrics:
        return self.compute_fresh(geojson, wait=wait)[0]

    def compute_fresh(
        self, geojson: Mapping[str, Any], *, wait: bool = True
    ) -> tuple[EarthObsMetrics, bool]:
        """The polygon's live metrics, and whether this call computed them (False: another run
        cached them meanwhile). With `wait` it waits up to `timeout_s` for a slot; without (a
        sandbox), it takes one only if free right now, else `earth_engine_busy` at once."""
        sha256 = geometry_sha256(geojson)
        area = check_shape(geojson).area_ha
        if area is None or not self.area_allowed(area):
            raise LiveMetricsError(LIVE_AREA_TOO_LARGE)
        acquired = (
            self._slots.acquire(timeout=self.timeout_s)
            if wait
            else self._slots.acquire(blocking=False)
        )
        if not acquired:
            raise LiveMetricsError(EARTH_ENGINE_BUSY)
        # Another run may have computed the same geometry while this one waited.
        try:
            hit = self.cached(geojson)
        except BaseException:
            self._slots.release()
            raise
        if hit is not None:
            self._slots.release()
            return hit, False
        started = self.clock()
        deadline = started + self.timeout_s

        def checkpoint() -> None:
            if self.clock() > deadline:
                raise _DeadlinePassed()

        def work() -> EarthObsMetrics:
            try:
                document = self.client.compute(
                    bare_geometry(geojson), site_key=live_site_key(sha256), checkpoint=checkpoint
                )
                # Validated and cached here, so a result that arrives after the caller gave up
                # still makes the retry free.
                return self._accept(geojson, sha256, document, started)
            finally:
                self._slots.release()  # only once the computation really stopped

        try:
            future = self._executor.submit(work)
        except BaseException:
            self._slots.release()
            raise
        try:
            return future.result(timeout=max(0.0, deadline - self.clock())), True
        except LiveMetricsError:
            raise
        except (FutureTimeout, _DeadlinePassed) as exc:  # incl. a request's own deadline
            raise LiveMetricsError(EARTH_ENGINE_TIMEOUT) from exc
        except Exception as exc:
            log.warning("live Earth Engine computation failed: %s", loggable(exc))
            raise LiveMetricsError(EARTH_ENGINE_ERROR) from exc

    def _accept(
        self, geojson: Mapping[str, Any], sha256: str, document: Any, started: float
    ) -> EarthObsMetrics:
        latency_ms = int((self.clock() - started) * 1000)
        try:
            metrics = EarthObsMetrics.model_validate(document)
        except ValidationError as exc:
            raise LiveMetricsError(EARTH_ENGINE_INVALID_OUTPUT) from exc
        if not self._describes(geojson, sha256, metrics):
            raise LiveMetricsError(EARTH_ENGINE_INVALID_OUTPUT)  # never cached
        try:
            self._store(sha256, metrics, latency_ms)
        except SQLAlchemyError as exc:  # the metrics are still good for this run
            log.warning("could not cache live Earth Engine metrics: %s", type(exc).__name__)
        log.info("live Earth Engine metrics for %s in %d ms", metrics.site_key, latency_ms)
        return metrics

    def _describes(self, geojson: Mapping[str, Any], sha256: str, metrics: EarthObsMetrics) -> bool:
        """Only metrics of this polygon, labelled as such, may be cached or served from the
        cache (the run checks again: T58's `foreign_metrics`)."""
        check = check_shape(geojson)
        return (
            metrics.data_version == self.data_version
            and metrics.site_key == live_site_key(sha256)
            and not metrics.simulated
            and check.area_ha is not None
            and metrics_match_polygon(
                geojson,
                area_ha=check.area_ha,
                metrics_area_ha=metrics.area_ha,
                metrics_lat=metrics.centroid.lat,
                metrics_lon=metrics.centroid.lon,
            )
        )

    def _store(self, sha256: str, metrics: EarthObsMetrics, latency_ms: int) -> None:
        with self.session_factory() as session:
            session.execute(
                insert(EarthObsCache)
                .values(
                    geometry_sha256=sha256,
                    data_version=metrics.data_version,
                    metrics=metrics.model_dump(mode="json"),
                    latency_ms=latency_ms,
                )
                .on_conflict_do_nothing()
            )
            session.commit()


def build_live_earth_obs(
    settings: Settings, session_factory: Callable[[], Session]
) -> LiveEarthObs | None:
    """The API's live Earth Engine, or None when it is off (`EARTH_ENGINE_LIVE=false`, the
    default) or has no service account (`EE_SERVICE_ACCOUNT_JSON`)."""
    if not settings.earth_engine_live:
        return None
    if not settings.ee_service_account_json.strip():
        log.warning("EARTH_ENGINE_LIVE=true but EE_SERVICE_ACCOUNT_JSON is empty: live is off")
        return None
    from app.tools.earth_engine import EarthEngineApi

    return LiveEarthObs(
        session_factory=session_factory,
        client=EarthEngineApi(
            settings.ee_service_account_json, request_timeout_s=settings.earth_engine_timeout_s
        ),
        timeout_s=settings.earth_engine_timeout_s,
        max_concurrent=settings.earth_engine_max_concurrent,
        max_area_ha=settings.earth_engine_live_max_ha,
    )


# ----- quotas -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class LiveQuota:
    """One live rating to count: the submitting account, its world, the polygon and the world's
    `LivePolicy` (its caps)."""

    user_id: UUID
    world_id: UUID
    geometry_sha256: str
    policy: LivePolicy


def _retry_after(times: list[datetime], cap: int, now: datetime) -> int:
    """Seconds until fewer than `cap` of `times` (sorted) are inside the window."""
    if cap <= 0 or not times:
        return int(QUOTA_WINDOW.total_seconds())
    oldest_counted = times[len(times) - cap]
    return max(1, math.ceil((oldest_counted + QUOTA_WINDOW - now).total_seconds()))


def reserve_live_rating(
    session: Session, quota: LiveQuota, now: datetime, run_id: UUID | None = None
) -> None:
    """Count one live rating for `run_id`, or raise LiveQuotaExceeded with the seconds until one
    frees up: `live_rating_quota` for the account, `live_rating_world_limit` for a sandbox's own
    cap, `live_rating_global_limit` for the world's pool (the live world, or all sandboxes
    together, pruned ones included).

    The caller must hold the global run lock (`rating_runs.GLOBAL_RUNS_LOCK_KEY`, taken by
    every enqueue), so two submits can't both take the last slot of any cap."""
    policy = quota.policy
    session.execute(
        delete(LiveRatingRequest).where(col(LiveRatingRequest.created_at) < now - QUOTA_RETENTION)
    )
    since = now - QUOTA_WINDOW
    recent = select(LiveRatingRequest.created_at).where(col(LiveRatingRequest.created_at) > since)
    user, world = col(LiveRatingRequest.user_id), col(LiveRatingRequest.world_id)
    caps: list[tuple[str, ColumnElement[bool], int]] = [
        (LIVE_RATING_QUOTA, user == quota.user_id, policy.per_user_per_day)
    ]
    if policy.per_world_per_day is not None:
        caps.append((LIVE_RATING_WORLD_LIMIT, world == quota.world_id, policy.per_world_per_day))
    pool = world.not_in(PROTECTED_WORLDS) if policy.sandbox else world == quota.world_id
    caps.append((LIVE_RATING_GLOBAL_LIMIT, pool, policy.pool_per_day))
    for code, counted, cap in caps:
        times = list(
            session.exec(recent.where(counted).order_by(col(LiveRatingRequest.created_at))).all()
        )
        if len(times) >= cap:
            raise LiveQuotaExceeded(code, _retry_after(times, cap, now))
    session.add(
        LiveRatingRequest(
            user_id=quota.user_id,
            world_id=quota.world_id,
            geometry_sha256=quota.geometry_sha256,
            run_id=run_id,
            created_at=now,
        )
    )
    session.flush()


def refund_live_rating(session: Session, run_id: UUID) -> bool:
    """Give back the live rating a run counted, when it never reached Earth Engine. Returns
    whether there was one; the caller commits."""
    result = session.execute(
        delete(LiveRatingRequest).where(col(LiveRatingRequest.run_id) == run_id)
    )
    return bool(getattr(result, "rowcount", 0))

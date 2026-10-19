"""Live Earth Engine metrics for new listings (T60).

A new listing's polygon has no precomputed metrics, so its rating run computes them live with
the T11/T13 methods (`app.tools.earth_engine.compute_polygon_metrics`, the same code as
`scripts/precompute_sites.py`):

- **Cache:** results are stored in `earth_obs_cache`, keyed by the SHA-256 of the bare geometry
  and the data version, so a polygon is computed once per data version, in any world.
- **Timeout and concurrency:** at most `EARTH_ENGINE_MAX_CONCURRENT` computations run at once
  (one by default); a run waits up to `EARTH_ENGINE_TIMEOUT_S` for a slot (`earth_engine_busy`)
  and then has `EARTH_ENGINE_TIMEOUT_S` to finish (`earth_engine_timeout`). The computation
  checks its deadline before each Earth Engine round trip and each request has the same
  deadline, so an abandoned one stops soon after and only then frees its slot.
- **Quotas:** `reserve_live_rating` counts a live rating against the submitting account
  (`LIVE_RATINGS_PER_USER_PER_DAY`) and globally (`LIVE_RATINGS_GLOBAL_PER_DAY`) in the
  transaction that queues the run. Only submits that need a computation count; a cache hit is
  free. `LLM_BUDGET_USD` stays the hard cap for the run's model calls (`app/llm.py`).

Nothing here is called by tests against Earth Engine: they plug in a fake `EarthEngineClient`.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Protocol, cast
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlmodel import Session, col, select

from app.config import Settings
from app.models import Asset, AssetStatus, EarthObsCache, LiveRatingRequest
from app.services.lifecycle import NO_SATELLITE_METRICS, PUBLIC_STATUSES, RATING_FAILED_PREFIX
from app.tools.earth_obs import EarthObsMetrics
from app.tools.geometry import bare_geometry, check_shape, geometry_sha256, metrics_match_polygon
from app.worlds import LIVE_WORLD_ID

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
LIVE_RATING_QUOTA = "live_rating_quota"
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


def live_site_key(sha256: str) -> str:
    """`site_key` of live metrics: never a curated site's key (those have committed files)."""
    return f"{LIVE_SITE_KEY_PREFIX}{sha256[:16]}"


@dataclass
class LiveEarthObs:
    """Cached live Earth Engine metrics for any validated polygon."""

    session_factory: Callable[[], Session]
    client: EarthEngineClient
    timeout_s: float
    max_concurrent: int = 1
    clock: Callable[[], float] = time.monotonic
    data_version: str = LIVE_DATA_VERSION
    _slots: threading.BoundedSemaphore = field(init=False, repr=False)
    _executor: ThreadPoolExecutor = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._slots = threading.BoundedSemaphore(self.max_concurrent)
        self._executor = ThreadPoolExecutor(
            max_workers=self.max_concurrent, thread_name_prefix="earth-engine"
        )

    def cached(self, geojson: Mapping[str, Any]) -> EarthObsMetrics | None:
        """The cached metrics of this exact geometry for the current data version, or None."""
        key = (geometry_sha256(geojson), self.data_version)
        with self.session_factory() as session:
            row = session.get(EarthObsCache, key)
            document = None if row is None else row.metrics
        if document is None:
            return None
        try:
            return EarthObsMetrics.model_validate(document)
        except ValidationError:
            log.warning("ignoring an unreadable earth_obs_cache row")
            return None

    def load(self, geojson: Mapping[str, Any]) -> EarthObsMetrics:
        """Cached metrics, else a live computation (stored in the cache). Raises
        LiveMetricsError."""
        return self.cached(geojson) or self.compute(geojson)

    def compute(self, geojson: Mapping[str, Any]) -> EarthObsMetrics:
        sha256 = geometry_sha256(geojson)
        if not self._slots.acquire(timeout=self.timeout_s):
            raise LiveMetricsError(EARTH_ENGINE_BUSY)
        # Another run may have computed the same geometry while this one waited.
        try:
            hit = self.cached(geojson)
        except BaseException:
            self._slots.release()
            raise
        if hit is not None:
            self._slots.release()
            return hit
        started = self.clock()
        deadline = started + self.timeout_s

        def checkpoint() -> None:
            if self.clock() > deadline:
                raise _DeadlinePassed()

        def work() -> dict[str, Any]:
            try:
                return self.client.compute(
                    bare_geometry(geojson), site_key=live_site_key(sha256), checkpoint=checkpoint
                )
            finally:
                self._slots.release()  # only once the computation really stopped

        try:
            future = self._executor.submit(work)
        except BaseException:
            self._slots.release()
            raise
        try:
            document = future.result(timeout=max(0.0, deadline - self.clock()))
        except (FutureTimeout, _DeadlinePassed) as exc:  # incl. a request's own deadline
            raise LiveMetricsError(EARTH_ENGINE_TIMEOUT) from exc
        except Exception as exc:
            # Earth Engine messages name limits and datasets, never credentials.
            log.warning("live Earth Engine computation failed: %s: %.200s", type(exc).__name__, exc)
            raise LiveMetricsError(EARTH_ENGINE_ERROR) from exc
        latency_ms = int((self.clock() - started) * 1000)
        try:
            metrics = EarthObsMetrics.model_validate(document)
        except ValidationError as exc:
            raise LiveMetricsError(EARTH_ENGINE_INVALID_OUTPUT) from exc
        if not self._describes(geojson, sha256, metrics):
            raise LiveMetricsError(EARTH_ENGINE_INVALID_OUTPUT)  # never cached
        self._store(sha256, metrics, latency_ms)
        log.info("live Earth Engine metrics for %s in %d ms", metrics.site_key, latency_ms)
        return metrics

    def _describes(self, geojson: Mapping[str, Any], sha256: str, metrics: EarthObsMetrics) -> bool:
        """Only metrics of this polygon, labelled as such, may enter the cache (the run checks
        again: T58's `foreign_metrics`)."""
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
    )


# ----- quotas -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class LiveQuota:
    """One live rating to count: the submitting account and the polygon."""

    user_id: UUID
    geometry_sha256: str
    per_user_per_day: int
    global_per_day: int


def _retry_after(times: list[datetime], cap: int, now: datetime) -> int:
    """Seconds until fewer than `cap` of `times` (sorted) are inside the window."""
    if cap <= 0 or not times:
        return int(QUOTA_WINDOW.total_seconds())
    oldest_counted = times[len(times) - cap]
    return max(1, math.ceil((oldest_counted + QUOTA_WINDOW - now).total_seconds()))


def reserve_live_rating(session: Session, quota: LiveQuota, now: datetime) -> None:
    """Count one live rating, or raise LiveQuotaExceeded (`live_rating_quota` for the account,
    `live_rating_global_limit` across everyone) with the seconds until one frees up.

    The caller must hold the global run lock (`rating_runs.GLOBAL_RUNS_LOCK_KEY`, taken by
    every enqueue), so two submits can't both take the last slot."""
    session.execute(
        delete(LiveRatingRequest).where(col(LiveRatingRequest.created_at) < now - QUOTA_RETENTION)
    )
    since = now - QUOTA_WINDOW
    recent = select(LiveRatingRequest.created_at).where(col(LiveRatingRequest.created_at) > since)
    mine = list(
        session.exec(
            recent.where(LiveRatingRequest.user_id == quota.user_id).order_by(
                col(LiveRatingRequest.created_at)
            )
        ).all()
    )
    if len(mine) >= quota.per_user_per_day:
        if not mine:
            raise LiveQuotaExceeded(LIVE_RATING_QUOTA, int(QUOTA_WINDOW.total_seconds()))
        raise LiveQuotaExceeded(LIVE_RATING_QUOTA, _retry_after(mine, quota.per_user_per_day, now))
    everyone = list(session.exec(recent.order_by(col(LiveRatingRequest.created_at))).all())
    if len(everyone) >= quota.global_per_day:
        raise LiveQuotaExceeded(
            LIVE_RATING_GLOBAL_LIMIT, _retry_after(everyone, quota.global_per_day, now)
        )
    session.add(
        LiveRatingRequest(
            user_id=quota.user_id, geometry_sha256=quota.geometry_sha256, created_at=now
        )
    )
    session.flush()


# ----- the demo-world "cached example" ------------------------------------------------------------

EARTH_OBS_FAILED = f"{RATING_FAILED_PREFIX}earth_obs_failed:"
EARTH_RADIUS_KM = 6371.0088


@dataclass(frozen=True, slots=True)
class CachedExample:
    asset_id: UUID
    name: str
    site_key: str
    distance_km: float
    notice: str


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle (haversine) distance."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def waiting_for_satellite_metrics(asset: Asset) -> bool:
    """A new listing whose rating failed for lack of satellite metrics (none, or a failed live
    computation) and is still in `rating`."""
    reason = asset.status_reason or ""
    return (
        asset.site_key is None
        and asset.status is AssetStatus.RATING
        and (reason == NO_SATELLITE_METRICS or reason.startswith(EARTH_OBS_FAILED))
    )


def cached_example(session: Session, asset: Asset) -> CachedExample | None:
    """In demo worlds only: the nearest precomputed demo site of the same world, as an explicit
    "cached example" for a listing whose live rating failed. It is shown next to the listing,
    never as its data: the listing keeps no report and stays in `rating`. Never in the live
    world."""
    if asset.world_id == LIVE_WORLD_ID or not waiting_for_satellite_metrics(asset):
        return None
    if asset.centroid_lat is None or asset.centroid_lon is None:
        return None
    sites = session.exec(
        select(Asset).where(
            Asset.world_id == asset.world_id,
            col(Asset.site_key).is_not(None),
            col(Asset.status).in_(PUBLIC_STATUSES),
            col(Asset.centroid_lat).is_not(None),
            col(Asset.centroid_lon).is_not(None),
        )
    ).all()
    lat, lon = asset.centroid_lat, asset.centroid_lon
    ranked = sorted(
        (distance_km(lat, lon, cast(float, s.centroid_lat), cast(float, s.centroid_lon)), s)
        for s in sites
        if s.site_key is not None
    )
    if not ranked:
        return None
    km, site = ranked[0]
    return CachedExample(
        asset_id=site.id,
        name=site.name,
        site_key=cast(str, site.site_key),
        distance_km=round(km, 1),
        notice=(
            f"Cached example: live satellite metrics for this listing aren't available yet. "
            f"{site.name}, a precomputed demo site {km:,.0f} km away, shows what a rating looks "
            f"like. Its numbers describe that site, not this land."
        ),
    )

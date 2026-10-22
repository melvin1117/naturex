"""Live land-cover overlays for listings rated with live Earth Engine (#231).

The demo sites' Dynamic World overlay is precomputed offline (T35, `scripts/precompute_sites.py
--images`). A listing rated live gets the same overlay from its rating run: once its metrics are
known, the run starts a render of the polygon's Dynamic World mode (the land-cover metric's
method and date window, `app.tools.earth_engine.land_cover_labels`) on the same Web Mercator grid
and palette (`app.tools.site_images`), stores it in `asset_overlays` and serves it at
`GET /assets/{asset_id}/overlay.png`.

- **Never fails a rating.** The render runs on its own worker thread while the rating's other
  steps run; the run waits for it at most until `timeout_s` after it started, before sealing the
  report. Any failure (Earth Engine, decoding, the database) is logged without secrets
  (`loggable`) and the listing keeps showing its boundary map.
- **Bounded.** At most `max_pending` renders queued per API process (one runs at a time; more
  are skipped and a later rating renders them), at most `OVERLAY_MAX_PX` on the long side, and
  halved until the PNG fits `MAX_IMAGE_BYTES`. Each Earth Engine request has the live client's
  deadline and no retries.
- **Replaced, never stale.** One row per asset, keyed to the boundary (`geometry_sha256`) and data
  version it was rendered for. A rating renders only when the row is missing or describes
  another boundary or data version (a stale row is deleted first); reads ignore a stale row.
- **Live only.** Built only with live Earth Engine on (`EARTH_ENGINE_LIVE=true` and a service
  account); with mocks or Earth Engine off there is no render and no network call. Tests plug in
  a fake `LandCoverClient`.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Protocol
from uuid import UUID

from shapely.geometry import shape
from sqlalchemy import delete, func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from app.models import AssetOverlay
from app.services.earth_obs_live import LIVE_DATA_VERSION, LiveEarthObs, loggable
from app.tools.geometry import bare_geometry, geometry_sha256
from app.tools.site_images import (
    MAX_IMAGE_BYTES,
    OVERLAY_MAX_PX,
    Bounds,
    LandCoverLabels,
    PixelGrid,
    halve_labels,
    overlay_grid,
    overlay_png_from_labels,
    png_dimensions,
)

log = logging.getLogger(__name__)

OVERLAY_TIMEOUT_S = 60.0
"""How long a rating waits for its overlay (from when the render started) before sealing."""
OVERLAY_MAX_PENDING = 4


class LandCoverClient(Protocol):
    """Renders a polygon's Dynamic World labels on a grid. The real one is
    `app.tools.earth_engine.EarthEngineApi`; tests use a fake."""

    def land_cover_labels(self, geojson: Mapping[str, Any], grid: PixelGrid) -> LandCoverLabels: ...


def geometry_bounds(geojson: Mapping[str, Any]) -> Bounds:
    """``((south, west), (north, east))`` of a Polygon or MultiPolygon (or its Feature)."""
    west, south, east, north = shape(bare_geometry(geojson)).bounds
    return (float(south), float(west)), (float(north), float(east))


def fit_overlay_png(grid_labels: LandCoverLabels, max_bytes: int = MAX_IMAGE_BYTES) -> bytes:
    """The overlay PNG, halved (nearest neighbour) until it fits ``max_bytes``. Raises
    ValueError for labels that aren't Dynamic World classes."""
    labels, width, height = grid_labels.labels, grid_labels.width, grid_labels.height
    while True:
        png = overlay_png_from_labels(labels, width, height)
        if len(png) <= max_bytes:
            return png
        if width == 1 and height == 1:  # pragma: no cover - a 1x1 PNG is ~100 bytes
            raise ValueError("overlay does not fit its byte budget")
        labels, width, height = halve_labels(labels, width, height)


def overlay_is_current(overlay: AssetOverlay, geojson: Mapping[str, Any]) -> bool:
    """Whether a stored overlay was rendered for this boundary and the current data version."""
    return overlay.data_version == LIVE_DATA_VERSION and overlay.geometry_sha256 == geometry_sha256(
        geojson
    )


def current_overlay(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    geojson: Mapping[str, Any],
    *,
    with_png: bool = True,
) -> AssetOverlay | None:
    """The asset's overlay if it describes its current boundary, else None. Without `with_png`
    the image isn't loaded (the asset page's metadata)."""
    query = select(AssetOverlay).where(
        AssetOverlay.world_id == world_id, AssetOverlay.asset_id == asset_id
    )
    if not with_png:
        query = query.options(defer(getattr(AssetOverlay, "png")))  # noqa: B009 (typed as bytes)
    overlay = session.exec(query).first()
    return overlay if overlay is not None and overlay_is_current(overlay, geojson) else None


@dataclass
class OverlayJob:
    """A render in progress; `wait` never raises."""

    future: Future[bool]
    deadline: float
    clock: Callable[[], float]

    def wait(self) -> bool:
        """Whether the overlay was stored, waiting at most until the job's deadline. A render
        that finishes later still stores its overlay."""
        try:
            return self.future.result(timeout=max(0.0, self.deadline - self.clock()))
        except FutureTimeout:
            log.warning("land-cover overlay still rendering at the rating's deadline")
            return False
        except Exception as exc:  # pragma: no cover - `_render` catches everything
            log.warning("land-cover overlay failed: %s", loggable(exc))
            return False


@dataclass
class LiveOverlays:
    """Renders and stores live listings' land-cover overlays (see the module docstring)."""

    session_factory: Callable[[], Session]
    client: LandCoverClient
    timeout_s: float = OVERLAY_TIMEOUT_S
    max_pending: int = OVERLAY_MAX_PENDING
    max_px: int = OVERLAY_MAX_PX
    max_bytes: int = MAX_IMAGE_BYTES
    clock: Callable[[], float] = time.monotonic
    data_version: str = LIVE_DATA_VERSION
    executor: Executor = field(
        default_factory=lambda: ThreadPoolExecutor(max_workers=1, thread_name_prefix="land-cover")
    )
    """One render at a time per API process."""
    _pending: threading.BoundedSemaphore = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._pending = threading.BoundedSemaphore(self.max_pending)

    def start(
        self, world_id: UUID, asset_id: UUID, geojson: Mapping[str, Any]
    ) -> OverlayJob | None:
        """Start rendering the asset's overlay unless a current one is stored; None when there's
        nothing to do or no capacity. Never raises."""
        try:
            sha256 = geometry_sha256(geojson)
            if not self._drop_stale(world_id, asset_id, sha256):
                return None  # already current
        except Exception as exc:
            log.warning("could not check the land-cover overlay: %s", loggable(exc))
            return None
        if not self._pending.acquire(blocking=False):
            log.warning("land-cover overlay skipped: too many renders queued")
            return None
        started = self.clock()
        try:
            future = self.executor.submit(self._render, world_id, asset_id, geojson, sha256)
        except BaseException:
            self._pending.release()
            raise
        return OverlayJob(future, started + self.timeout_s, self.clock)

    def _drop_stale(self, world_id: UUID, asset_id: UUID, sha256: str) -> bool:
        """Delete an overlay for another boundary or data version; False if a current one exists."""
        with self.session_factory() as session:
            row = session.get(AssetOverlay, asset_id)
            if row is None:
                return True
            if (
                row.world_id == world_id
                and row.geometry_sha256 == sha256
                and row.data_version == self.data_version
            ):
                return False
            session.execute(delete(AssetOverlay).where(col(AssetOverlay.asset_id) == asset_id))
            session.commit()
        return True

    def _render(
        self, world_id: UUID, asset_id: UUID, geojson: Mapping[str, Any], sha256: str
    ) -> bool:
        started = self.clock()
        try:
            bounds = geometry_bounds(geojson)
            grid = overlay_grid(bounds, self.max_px)
            grid_labels = self.client.land_cover_labels(bare_geometry(geojson), grid)
            if (grid_labels.width, grid_labels.height) != (grid.width, grid.height):
                raise ValueError("the labels don't match the grid")
            png = fit_overlay_png(grid_labels, self.max_bytes)
            width, height = png_dimensions(png)
            self._store(world_id, asset_id, sha256, png, width, height, bounds, grid_labels)
            latency_ms = int((self.clock() - started) * 1000)
            log.info("land-cover overlay rendered (%d bytes) in %d ms", len(png), latency_ms)
            return True
        except Exception as exc:
            log.warning("land-cover overlay failed: %s", loggable(exc))
            return False
        finally:
            self._pending.release()  # only once the render really stopped

    def _store(
        self,
        world_id: UUID,
        asset_id: UUID,
        sha256: str,
        png: bytes,
        width: int,
        height: int,
        bounds: Bounds,
        grid_labels: LandCoverLabels,
    ) -> None:
        (south, west), (north, east) = bounds
        values = {
            "world_id": world_id,
            "geometry_sha256": sha256,
            "data_version": self.data_version,
            "png": png,
            "width": width,
            "height": height,
            "south": south,
            "west": west,
            "north": north,
            "east": east,
            "date_start": date.fromisoformat(grid_labels.date_start),
            "date_end": date.fromisoformat(grid_labels.date_end),
        }
        with self.session_factory() as session:
            session.execute(
                insert(AssetOverlay)
                .values(asset_id=asset_id, **values)
                .on_conflict_do_update(
                    index_elements=[col(AssetOverlay.asset_id)],
                    set_={**values, "created_at": func.now()},
                )
            )
            session.commit()


def build_live_overlays(
    session_factory: Callable[[], Session], live: LiveEarthObs | None
) -> LiveOverlays | None:
    """Overlays for live ratings, on the live metrics' Earth Engine client; None when live Earth
    Engine is off (no render, no network call)."""
    if live is None:
        return None
    from app.tools.earth_engine import EarthEngineApi

    if not isinstance(live.client, EarthEngineApi):
        return None
    return LiveOverlays(
        session_factory=session_factory,
        client=live.client,
        timeout_s=min(OVERLAY_TIMEOUT_S, live.timeout_s),
    )

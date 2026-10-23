"""Live before/after views for listings rated with live Earth Engine.

The demo sites' two Sentinel-2 true-colour views five years apart are precomputed offline (T35,
`scripts/precompute_sites.py --images --before`). A listing rated live gets the same pair from its
rating run: once its metrics are known, the run starts rendering the first year of the 5-year
window and the latest 12 months (`app.tools.earth_engine.BEFORE_WINDOW` and `AFTER_WINDOW`) on
the demo sites' card-shaped grid around the boundary (`app.tools.site_images.thumbnail_grid`),
stores them in `asset_views` and serves them at `GET /assets/{asset_id}/views/{before,after}.webp`.
The rating's vision step reads the same pair (`app.agents.site_vision`).

As the land-cover overlay (`app.services.land_cover_overlays`): it never fails a rating (its own
worker thread, every failure logged without secrets), it's bounded (`max_pending` queued per API
process, one at a time, each image at most `MAX_IMAGE_BYTES`), it's replaced, never stale (one row
per asset, keyed to the boundary and data version), and it's live only (built only with live Earth
Engine on; tests plug in a fake `TrueColourClient`).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal, Protocol
from uuid import UUID

from sqlalchemy import delete, func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from app.models import AssetView
from app.services.earth_obs_live import LIVE_DATA_VERSION, LiveEarthObs, loggable
from app.services.land_cover_overlays import (
    SANDBOX_RENDERS_MAX_PENDING,
    OverlayJob,
    RenderLane,
    geometry_bounds,
)
from app.tools.geometry import geometry_sha256, outline_rings
from app.tools.site_images import (
    MAX_IMAGE_BYTES,
    Bounds,
    PixelGrid,
    thumbnail_grid,
    webp_dimensions,
)

log = logging.getLogger(__name__)

VIEWS_TIMEOUT_S = 90.0
"""How long a rating waits for its views (from when the render started): two composites."""
VIEWS_MAX_PENDING = 4
VIEW_OUTLINE_MAX_POINTS = 2_000
"""Corners of the outline drawn on the views (a 640 px image needs no more)."""

Window = tuple[str, str]
"""A date window, ISO start and end."""


class TrueColourClient(Protocol):
    """Renders a true-colour composite with the outline drawn on it. The real one is
    `app.tools.earth_engine.EarthEngineApi`; tests use a fake."""

    def true_colour_webp(
        self, rings: Sequence[Sequence[Sequence[float]]], grid: PixelGrid, start: str, end: str
    ) -> bytes: ...


def views_are_current(views: AssetView, geojson: Mapping[str, Any]) -> bool:
    """Whether stored views were rendered for this boundary and the current data version."""
    return views.data_version == LIVE_DATA_VERSION and views.geometry_sha256 == geometry_sha256(
        geojson
    )


def current_views(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    geojson: Mapping[str, Any] | None,
    *,
    images: Literal["both", "before", "after", "none"] = "both",
) -> AssetView | None:
    """The asset's views if they describe its current boundary, else None. `images` says which
    images to load: "none" for the asset page's metadata, one of them to serve it."""
    if geojson is None:
        return None
    query = select(AssetView).where(AssetView.world_id == world_id, AssetView.asset_id == asset_id)
    if images in ("none", "after"):
        query = query.options(defer(getattr(AssetView, "before_webp")))  # noqa: B009 (bytes)
    if images in ("none", "before"):
        query = query.options(defer(getattr(AssetView, "after_webp")))  # noqa: B009
    views = session.exec(query).first()
    return views if views is not None and views_are_current(views, geojson) else None


@dataclass
class LiveSiteViews:
    """Renders and stores live listings' before/after views (see the module docstring)."""

    session_factory: Callable[[], Session]
    client: TrueColourClient
    before: Window
    after: Window
    timeout_s: float = VIEWS_TIMEOUT_S
    max_pending: int = VIEWS_MAX_PENDING
    max_bytes: int = MAX_IMAGE_BYTES
    clock: Callable[[], float] = time.monotonic
    data_version: str = LIVE_DATA_VERSION
    executor: Executor = field(
        default_factory=lambda: ThreadPoolExecutor(max_workers=1, thread_name_prefix="site-views")
    )
    """One render at a time per API process, beside the overlay's own worker."""
    _pending: threading.BoundedSemaphore = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._pending = threading.BoundedSemaphore(self.max_pending)

    def start(
        self, world_id: UUID, asset_id: UUID, geojson: Mapping[str, Any]
    ) -> OverlayJob | None:
        """Start rendering the asset's views unless current ones are stored; None when there's
        nothing to do or no capacity. Never raises."""
        try:
            sha256 = geometry_sha256(geojson)
            if not self._drop_stale(world_id, asset_id, sha256):
                return None  # already current
        except Exception as exc:
            log.warning("could not check the before/after views: %s", loggable(exc))
            return None
        if not self._pending.acquire(blocking=False):
            log.warning("before/after views skipped: too many renders queued")
            return None
        started = self.clock()
        try:
            future = self.executor.submit(self._render, world_id, asset_id, geojson, sha256)
        except Exception as exc:  # e.g. the executor shut down with the API
            self._pending.release()
            log.warning("before/after views not started: %s", loggable(exc))
            return None
        return OverlayJob(future, started + self.timeout_s, self.clock, "before/after views")

    def _drop_stale(self, world_id: UUID, asset_id: UUID, sha256: str) -> bool:
        """Delete views of another boundary or data version; False if current ones exist."""
        with self.session_factory() as session:
            row = session.get(AssetView, asset_id)
            if row is None:
                return True
            if (
                row.world_id == world_id
                and row.geometry_sha256 == sha256
                and row.data_version == self.data_version
            ):
                return False
            session.execute(delete(AssetView).where(col(AssetView.asset_id) == asset_id))
            session.commit()
        return True

    def _render(
        self, world_id: UUID, asset_id: UUID, geojson: Mapping[str, Any], sha256: str
    ) -> bool:
        started = self.clock()
        try:
            grid = thumbnail_grid(geometry_bounds(geojson))
            rings = outline_rings(geojson, max_points=VIEW_OUTLINE_MAX_POINTS)
            if not rings:
                raise ValueError("the boundary has no outline")
            # Both windows at once: two Earth Engine requests, each with its own deadline.
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="site-view") as pool:
                pending = [
                    pool.submit(self._image, rings, grid, w) for w in (self.before, self.after)
                ]
                before, after = (job.result() for job in pending)
            self._store(world_id, asset_id, sha256, grid, before, after)
            latency_ms = int((self.clock() - started) * 1000)
            log.info(
                "before/after views rendered (%d + %d bytes) in %d ms",
                len(before),
                len(after),
                latency_ms,
            )
            return True
        except Exception as exc:
            log.warning("before/after views failed: %s", loggable(exc))
            return False
        finally:
            self._pending.release()  # only once the render really stopped

    def _image(
        self, rings: Sequence[Sequence[Sequence[float]]], grid: PixelGrid, window: Window
    ) -> bytes:
        image = self.client.true_colour_webp(rings, grid, *window)
        if webp_dimensions(image) != (grid.width, grid.height):
            raise ValueError("the view doesn't match the grid")
        if len(image) > self.max_bytes:
            raise ValueError("the view does not fit its byte budget")
        return image

    def _store(
        self,
        world_id: UUID,
        asset_id: UUID,
        sha256: str,
        grid: PixelGrid,
        before: bytes,
        after: bytes,
    ) -> None:
        bounds: Bounds = grid.bounds()
        (south, west), (north, east) = bounds
        values = {
            "world_id": world_id,
            "geometry_sha256": sha256,
            "data_version": self.data_version,
            "before_webp": before,
            "after_webp": after,
            "width": grid.width,
            "height": grid.height,
            "south": south,
            "west": west,
            "north": north,
            "east": east,
            "before_start": date.fromisoformat(self.before[0]),
            "before_end": date.fromisoformat(self.before[1]),
            "after_start": date.fromisoformat(self.after[0]),
            "after_end": date.fromisoformat(self.after[1]),
        }
        with self.session_factory() as session:
            session.execute(
                insert(AssetView)
                .values(asset_id=asset_id, **values)
                .on_conflict_do_update(
                    index_elements=[col(AssetView.asset_id)],
                    set_={**values, "created_at": func.now()},
                )
            )
            session.commit()


def build_live_views(
    session_factory: Callable[[], Session], live: LiveEarthObs | None, lane: RenderLane = "live"
) -> LiveSiteViews | None:
    """Views for live ratings, on the live metrics' Earth Engine client; None when live Earth
    Engine is off (no render, no network call). The sandboxes' `lane` has its own worker and
    `SANDBOX_RENDERS_MAX_PENDING`."""
    if live is None:
        return None
    from app.tools.earth_engine import AFTER_WINDOW, BEFORE_WINDOW, EarthEngineApi

    if not isinstance(live.client, EarthEngineApi):
        return None
    sandbox = lane == "sandbox"
    return LiveSiteViews(
        session_factory=session_factory,
        client=live.client,
        before=BEFORE_WINDOW,
        after=AFTER_WINDOW,
        timeout_s=min(VIEWS_TIMEOUT_S, live.timeout_s),
        max_pending=SANDBOX_RENDERS_MAX_PENDING if sandbox else VIEWS_MAX_PENDING,
        executor=ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="site-views-sandbox" if sandbox else "site-views"
        ),
    )

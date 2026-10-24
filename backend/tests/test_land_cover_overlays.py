"""Live land-cover overlays (#231): rendered by a live rating, stored per asset, replaced for a new
boundary, served at `GET /assets/{id}/overlay.png`, and never able to fail the rating. Earth
Engine is never called: the overlays run on a fake `LandCoverClient`."""

from __future__ import annotations

import logging
import random
from collections.abc import Callable, Mapping
from concurrent.futures import Executor, Future
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect
from sqlmodel import Session, select

from app.config import get_settings
from app.models import Asset, AssetOverlay, AssetStatus
from app.services.earth_obs_live import LIVE_DATA_VERSION, LiveEarthObs
from app.services.land_cover_overlays import (
    SANDBOX_RENDERS_MAX_PENDING,
    LiveOverlays,
    OverlayJob,
    build_live_overlays,
    fit_overlay_png,
    geometry_bounds,
)
from app.services.rating_runs import build_runner
from app.tools import earth_engine as eng
from app.tools.geometry import geometry_sha256
from app.tools.site_images import (
    DW_NO_DATA,
    DW_PALETTE,
    MAX_IMAGE_BYTES,
    OVERLAY_ATTRIBUTIONS,
    TRANSPARENT_INDEX,
    LandCoverLabels,
    PixelGrid,
    decode_indexed_png,
    halve_labels,
    overlay_png_from_labels,
    palette_rgba,
)
from app.worlds import LIVE_WORLD_ID
from tests import test_earth_obs_live as live_tests
from tests import test_lifecycle as lifecycle
from tests.conftest import alembic_cfg, requires_db
from tests.test_earth_obs_live import FakeEarthEngine, Live, go_live
from tests.test_lifecycle import LAT, square, status_of

conn = lifecycle.conn
world = lifecycle.world
live = live_tests.live

TREES = 1


class Inline(Executor):
    """Renders in the caller's thread (DB tests share one rolled-back connection)."""

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        future.set_result(fn(*args, **kwargs))
        return future


class FakeLandCover:
    """Trees inside a one-pixel transparent frame, on whatever grid it's asked for."""

    def __init__(self, *, fail: Exception | None = None) -> None:
        self.fail = fail
        self.calls: list[str] = []

    def land_cover_labels(self, geojson: Mapping[str, Any], grid: PixelGrid) -> LandCoverLabels:
        self.calls.append(geometry_sha256(geojson))
        if self.fail is not None:
            raise self.fail
        w, h = grid.width, grid.height
        labels = bytes(
            DW_NO_DATA if x in (0, w - 1) or y in (0, h - 1) else TREES
            for y in range(h)
            for x in range(w)
        )
        return LandCoverLabels(labels, w, h, eng.START_12M, eng.END_DATE)


# ----- pure parts ---------------------------------------------------------------------------------


def test_labels_become_the_demo_sites_indexed_png_transparent_outside() -> None:
    png = overlay_png_from_labels(bytes([DW_NO_DATA, TREES, 0, 8]), 2, 2)
    decoded = decode_indexed_png(png)
    assert (decoded.width, decoded.height) == (2, 2)
    assert decoded.pixels == bytes([TRANSPARENT_INDEX, TREES, 0, 8])
    assert list(decoded.palette) == palette_rgba(DW_PALETTE)
    assert decoded.palette[TRANSPARENT_INDEX][3] == 0


@pytest.mark.parametrize(
    ("labels", "message"),
    [(bytes([9, 0, 0, 0]), "Unexpected"), (bytes(3), "Expected 2x2")],
)
def test_labels_that_arent_dynamic_world_classes_are_refused(labels: bytes, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        overlay_png_from_labels(labels, 2, 2)


def test_halving_keeps_every_other_row_and_column() -> None:
    labels = bytes(range(15))  # 5 x 3
    assert halve_labels(labels, 5, 3) == (bytes([0, 2, 4, 10, 12, 14]), 3, 2)
    assert halve_labels(bytes([7]), 1, 1) == (bytes([7]), 1, 1)


def test_an_overlay_over_its_byte_budget_is_halved_until_it_fits() -> None:
    noise = random.Random(231)
    labels = bytes(noise.randrange(9) for _ in range(256 * 256))
    grid_labels = LandCoverLabels(labels, 256, 256, eng.START_12M, eng.END_DATE)
    full = fit_overlay_png(grid_labels)
    assert decode_indexed_png(full).width == 256  # fits MAX_IMAGE_BYTES as is
    fitted = decode_indexed_png(fit_overlay_png(grid_labels, max_bytes=len(full) // 3))
    assert (fitted.width, fitted.height) in {(128, 128), (64, 64)}
    assert MAX_IMAGE_BYTES == 300_000  # the `ck_asset_overlays_png_size` check


def test_bounds_cover_polygons_and_multipolygons() -> None:
    polygon = {"type": "Polygon", "coordinates": [[[1, 2], [3, 2], [3, 5], [1, 2]]]}
    assert geometry_bounds(polygon) == ((2.0, 1.0), (5.0, 3.0))
    multi = {
        "type": "Feature",
        "properties": {},
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [
                [[[1, 2], [3, 2], [3, 5], [1, 2]]],
                [[[-4, -1], [-2, -1], [-2, 0], [-4, -1]]],
            ],
        },
    }
    assert geometry_bounds(multi) == ((-1.0, -4.0), (5.0, 3.0))


def test_a_slow_render_doesnt_hold_the_rating_past_its_deadline() -> None:
    job = OverlayJob(Future(), deadline=0.0, clock=lambda: 1.0)
    assert job.wait() is False


def test_overlays_exist_only_with_live_earth_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    factory: Callable[[], Session] = lambda: pytest.fail("no session needed")  # noqa: E731
    assert build_live_overlays(factory, None) is None
    fake = LiveEarthObs(session_factory=factory, client=FakeEarthEngine(), timeout_s=5.0)
    assert build_live_overlays(factory, fake) is None  # not an Earth Engine client
    api = eng.EarthEngineApi("/k.json", request_timeout_s=120.0)
    real = LiveEarthObs(session_factory=factory, client=api, timeout_s=120.0)
    overlays = build_live_overlays(factory, real)
    assert overlays is not None and overlays.client is api and overlays.timeout_s == 60.0
    lane = build_live_overlays(factory, real, lane="sandbox")  # the sandboxes' own worker
    assert lane is not None and lane.max_pending == SANDBOX_RENDERS_MAX_PENDING == 1
    assert lane.executor is not overlays.executor and overlays.max_pending == 4

    for use_mocks in (True, False):  # Earth Engine off (the default), with or without mocks
        runner = build_runner(lifecycle._settings(use_mocks=use_mocks), factory, Inline())
        assert runner.live_metrics is None and runner.live_overlays is None
        assert runner.sandbox_overlays is None and runner.sandbox_views is None


# ----- with a database ----------------------------------------------------------------------------


def overlays_for(live: Live, client: FakeLandCover) -> LiveOverlays:
    overlays = LiveOverlays(
        session_factory=live.w.runner.session_factory, client=client, executor=Inline()
    )
    live.w.runner.live_overlays = overlays
    return overlays


def stored(live: Live, asset_id: str) -> list[AssetOverlay]:
    session = live.w.session
    session.expire_all()
    return list(
        session.exec(select(AssetOverlay).where(AssetOverlay.asset_id == UUID(asset_id))).all()
    )


def rate(live: Live, asset_id: str) -> None:
    assert live.submit(asset_id).status_code == 202
    live.w.executor.run_all()


def rerate(live: Live, asset_id: str) -> None:
    live.w.runner.start(LIVE_WORLD_ID, UUID(asset_id))
    live.w.executor.run_all()
    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)


@requires_db
def test_a_live_rating_stores_and_serves_its_land_cover_overlay(live: Live) -> None:
    go_live(live.w, FakeEarthEngine())
    land_cover = FakeLandCover()
    overlays_for(live, land_cover)
    geometry = square(800)
    asset_id = live.draft(geometry)
    rate(live, asset_id)

    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)
    [row] = stored(live, asset_id)
    assert land_cover.calls == [geometry_sha256(geometry)]
    assert row.world_id == LIVE_WORLD_ID and row.data_version == LIVE_DATA_VERSION
    assert (row.date_start.isoformat(), row.date_end.isoformat()) == (eng.START_12M, eng.END_DATE)
    detail = live.detail(asset_id)["land_cover_overlay"]
    (south, west), (north, east) = geometry_bounds(geometry)
    assert detail["bounds"] == {"south": south, "west": west, "north": north, "east": east}
    assert detail["date_window"] == {"start": eng.START_12M, "end": eng.END_DATE}
    assert detail["attributions"] == list(OVERLAY_ATTRIBUTIONS)
    assert detail["dataset_id"] == "GOOGLE/DYNAMICWORLD/V1"
    assert (detail["width"], detail["height"]) == (row.width, row.height)
    assert max(row.width, row.height) == 1024

    response = live.client().get(f"/assets/{asset_id}/overlay.png?v={detail['version']}")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    # Listed but not launched yet: private to its community, so never cached publicly.
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    image = decode_indexed_png(response.content)
    assert (image.width, image.height) == (row.width, row.height)
    assert set(image.pixels) == {TRANSPARENT_INDEX, TREES}
    launched = live.w.session.get_one(Asset, UUID(asset_id))
    launched.ipo_at = datetime.now(UTC)
    live.w.session.add(launched)
    live.w.session.commit()
    response = live.client().get(f"/assets/{asset_id}/overlay.png?v={detail['version']}")
    assert response.headers["cache-control"] == "public, max-age=86400"


@requires_db
def test_a_rerating_replaces_an_overlay_only_for_a_new_boundary(live: Live) -> None:
    service = go_live(live.w, FakeEarthEngine())
    land_cover = FakeLandCover()
    overlays = overlays_for(live, land_cover)
    asset_id = live.draft(square(800))
    rate(live, asset_id)
    [first] = stored(live, asset_id)
    first_sha, first_south = first.geometry_sha256, first.south

    # A re-rating of the same boundary: the stored overlay is current, nothing is rendered.
    rerate(live, asset_id)
    assert overlays.start(LIVE_WORLD_ID, UUID(asset_id), square(800)) is None
    assert len(land_cover.calls) == 1
    assert [row.geometry_sha256 for row in stored(live, asset_id)] == [first_sha]

    # A new boundary (as after an edit), then a re-rating: rendered again, the row replaced.
    moved = square(800, lat=LAT + 0.0004)
    asset = live.w.session.get_one(Asset, UUID(asset_id))
    asset.geojson = moved
    live.w.session.add(asset)
    live.w.session.commit()
    service.load(moved)  # its metrics, as the edit's resubmit would compute them
    rerate(live, asset_id)
    [second] = stored(live, asset_id)
    assert second.geometry_sha256 == geometry_sha256(moved) != first_sha
    assert second.south > first_south
    assert len(land_cover.calls) == 2


@requires_db
def test_an_overlay_for_another_boundary_is_never_served(live: Live) -> None:
    go_live(live.w, FakeEarthEngine())
    overlays_for(live, FakeLandCover())
    asset_id = live.draft(square(800))
    rate(live, asset_id)
    [row] = stored(live, asset_id)
    row.geometry_sha256 = "0" * 64  # e.g. rendered before the boundary changed
    live.w.session.add(row)
    live.w.session.commit()

    assert live.detail(asset_id)["land_cover_overlay"] is None
    response = live.client().get(f"/assets/{asset_id}/overlay.png")
    assert (response.status_code, response.json()["detail"]) == (404, "overlay_not_found")


@requires_db
def test_a_failed_render_never_fails_the_rating(
    live: Live, caplog: pytest.LogCaptureFixture
) -> None:
    go_live(live.w, FakeEarthEngine())
    land_cover = FakeLandCover(fail=OSError("/secret/key.json: permission denied"))
    overlays_for(live, land_cover)
    asset_id = live.draft(square(800))
    with caplog.at_level(logging.WARNING):
        rate(live, asset_id)

    assert land_cover.calls  # it was tried
    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)
    assert stored(live, asset_id) == []
    assert live.detail(asset_id)["land_cover_overlay"] is None
    assert "land-cover overlay failed: OSError" in caplog.text
    assert "secret" not in caplog.text
    response = live.client().get(f"/assets/{asset_id}/overlay.png")
    assert (response.status_code, response.json()["detail"]) == (404, "overlay_not_found")


def sandbox_lane(live: Live, client: FakeLandCover) -> LiveOverlays:
    """The sandboxes' own render lane, as `build_live_overlays(..., lane="sandbox")` makes it."""
    overlays = LiveOverlays(
        session_factory=live.w.runner.session_factory,
        client=client,
        executor=Inline(),
        max_pending=SANDBOX_RENDERS_MAX_PENDING,
    )
    live.w.runner.sandbox_overlays = overlays
    return overlays


def sandbox_rating(live: Live, geometry: dict[str, Any]) -> str:
    w = live.w
    asset_id = str(lifecycle.draft(w, geojson=geometry)["id"])
    assert lifecycle.submit(w, asset_id).status_code == 202
    w.executor.run_all()
    assert status_of(w, asset_id) == (AssetStatus.LISTED, None)  # a render never fails it
    return asset_id


@requires_db
def test_mock_ratings_and_sandbox_cache_hits_never_render(live: Live) -> None:
    land_cover, sandbox_cover = FakeLandCover(), FakeLandCover()
    overlays_for(live, land_cover)
    sandbox_lane(live, sandbox_cover)
    # Mock mode in the live world: no live metrics, so no overlay.
    asset_id = live.draft(square(800))
    rate(live, asset_id)
    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)
    assert live.detail(asset_id)["mock"] is True
    # A sandbox listing reusing a polygon computed live: it computed nothing, so no render.
    go_live(live.w, FakeEarthEngine()).load(square(1_200))
    sandbox_asset = sandbox_rating(live, square(1_200))

    assert land_cover.calls == [] and sandbox_cover.calls == []
    assert stored(live, asset_id) == [] and stored(live, sandbox_asset) == []


@requires_db
def test_a_sandbox_listing_computed_live_gets_its_overlay_on_its_own_lane(live: Live) -> None:
    land_cover, sandbox_cover = FakeLandCover(), FakeLandCover()
    overlays_for(live, land_cover)
    sandbox_lane(live, sandbox_cover)
    go_live(live.w, FakeEarthEngine())
    geometry = square(800)
    sandbox_asset = sandbox_rating(live, geometry)

    [row] = stored(live, sandbox_asset)
    assert row.world_id == live.w.id and sandbox_cover.calls == [geometry_sha256(geometry)]
    assert land_cover.calls == []  # never the live world's lane


@requires_db
def test_a_busy_sandbox_lane_skips_and_never_displaces_live_world_renders(live: Live) -> None:
    land_cover, sandbox_cover = FakeLandCover(), FakeLandCover()
    overlays_for(live, land_cover)
    busy = sandbox_lane(live, sandbox_cover)
    assert busy._pending.acquire(blocking=False)  # another sandbox's render holds the lane
    try:
        go_live(live.w, FakeEarthEngine())
        sandbox_asset = sandbox_rating(live, square(800))
        assert sandbox_cover.calls == [] and stored(live, sandbox_asset) == []  # skipped
        geometry = square(800, lat=LAT + 0.1)
        asset_id = live.draft(geometry)
        rate(live, asset_id)  # the live world renders at once on its own lane
        assert land_cover.calls == [geometry_sha256(geometry)] and len(stored(live, asset_id)) == 1
    finally:
        busy._pending.release()


@requires_db
def test_the_overlays_migration_downgrades_and_upgrades() -> None:
    """#231 (0026): `asset_overlays` comes and goes."""
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)

    def tables() -> set[str]:
        with engine.connect() as c:
            return set(inspect(c).get_table_names())

    try:
        assert "asset_overlays" in tables()
        command.downgrade(cfg, "0025")
        assert "asset_overlays" not in tables()
    finally:
        command.upgrade(cfg, "head")
        assert "asset_overlays" in tables()
        engine.dispose()

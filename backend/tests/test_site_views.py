"""Live before/after views: a live-rated listing's Sentinel-2 views five years apart, rendered by
its rating run, stored in `asset_views`, served at `/assets/{id}/views/{before,after}.webp` and read
by the vision model."""

from __future__ import annotations

import io
import logging
from collections.abc import Callable, Sequence
from concurrent.futures import Executor, Future
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from PIL import Image
from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select

from app.config import get_settings
from app.llm import LLMClient
from app.models import Asset, AssetOverlay, AssetStatus, AssetView
from app.services import rating_runs
from app.services.earth_obs_live import LIVE_DATA_VERSION, LiveEarthObs
from app.services.land_cover_overlays import LiveOverlays, geometry_bounds
from app.services.rating_runs import (
    AssetInfo,
    NoFieldEvidence,
    RunDeps,
    RunProgress,
    RunSpec,
    RunToolbox,
    build_runner,
)
from app.services.site_views import LiveSiteViews, build_live_views
from app.tools import earth_engine as eng
from app.tools.earth_obs import EarthObsMetrics
from app.tools.geometry import geometry_sha256
from app.tools.site_images import VIEW_ATTRIBUTIONS, PixelGrid, thumbnail_grid
from app.worlds import LIVE_WORLD_ID
from tests import test_earth_obs_live as live_tests
from tests import test_lifecycle as lifecycle
from tests.conftest import alembic_cfg, requires_db
from tests.test_earth_obs_live import FakeEarthEngine, Live, go_live
from tests.test_land_cover_overlays import FakeLandCover, Inline
from tests.test_lifecycle import LAT, square, status_of

conn = lifecycle.conn
world = lifecycle.world
live = live_tests.live

BEFORE = ("2021-10-01", "2022-10-01")
AFTER = ("2025-10-01", "2026-10-01")


class FakeTrueColour:
    """A flat WebP on whatever grid it's asked for: dark for the earlier window, light after."""

    def __init__(self, *, fail: Exception | None = None, size: tuple[int, int] | None = None):
        self.fail = fail
        self.size = size
        self.calls: list[tuple[int, str, str]] = []

    def true_colour_webp(
        self, rings: Sequence[Sequence[Sequence[float]]], grid: PixelGrid, start: str, end: str
    ) -> bytes:
        self.calls.append((len(rings), start, end))
        if self.fail is not None:
            raise self.fail
        shade = 40 if start < "2023" else 200
        out = io.BytesIO()
        size = self.size or (grid.width, grid.height)
        Image.new("RGB", size, (shade, shade, shade)).save(out, "WEBP")
        return out.getvalue()


def views_for(live: Live, client: FakeTrueColour) -> LiveSiteViews:
    views = LiveSiteViews(
        session_factory=live.w.runner.session_factory,
        client=client,
        before=BEFORE,
        after=AFTER,
        executor=Inline(),
    )
    live.w.runner.live_views = views
    return views


def stored(live: Live, asset_id: str) -> list[AssetView]:
    session = live.w.session
    session.expire_all()
    return list(session.exec(select(AssetView).where(AssetView.asset_id == UUID(asset_id))).all())


def rate(live: Live, asset_id: str) -> None:
    assert live.submit(asset_id).status_code == 202
    live.w.executor.run_all()


def rerate(live: Live, asset_id: str) -> None:
    live.w.runner.start(LIVE_WORLD_ID, UUID(asset_id))
    live.w.executor.run_all()
    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)


def launch(live: Live, asset_id: str) -> None:
    asset = live.w.session.get_one(Asset, UUID(asset_id))
    asset.ipo_at = datetime.now(UTC)
    live.w.session.add(asset)
    live.w.session.commit()


# ----- without a database -------------------------------------------------------------------------


def test_views_exist_only_with_live_earth_engine() -> None:
    factory: Callable[[], Session] = lambda: pytest.fail("no session needed")  # noqa: E731
    assert build_live_views(factory, None) is None
    fake = LiveEarthObs(session_factory=factory, client=FakeEarthEngine(), timeout_s=5.0)
    assert build_live_views(factory, fake) is None  # not an Earth Engine client
    api = eng.EarthEngineApi("/k.json", request_timeout_s=120.0)
    real = LiveEarthObs(session_factory=factory, client=api, timeout_s=120.0)
    views = build_live_views(factory, real)
    assert views is not None and views.client is api
    # The demo sites' windows: the first year of the five, and the latest twelve months.
    assert (views.before, views.after) == (eng.BEFORE_WINDOW, eng.AFTER_WINDOW)
    assert views.before[0] == eng.START_5Y and views.after == (eng.START_12M, eng.END_DATE)
    assert views.before[0] < views.before[1] <= views.after[0] < views.after[1]
    assert views.timeout_s == 90.0  # the live client's own deadline (120 s) is longer

    for use_mocks in (True, False):  # Earth Engine off (the default), with or without mocks
        runner = build_runner(lifecycle._settings(use_mocks=use_mocks), factory, Inline())
        assert runner.live_views is None


class Held(Executor):
    """Never runs what it's given: a render stuck in the queue."""

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        return Future()


class ShutDown(Executor):
    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        raise RuntimeError("cannot schedule new futures after shutdown")


def unused_session() -> Session:
    raise AssertionError("no session needed")


def test_renders_are_bounded_and_starting_one_never_raises(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(LiveSiteViews, "_drop_stale", lambda *_: True)  # nothing stored yet
    asset, geometry = uuid4(), square(800)
    held = LiveSiteViews(unused_session, FakeTrueColour(), BEFORE, AFTER, max_pending=1)
    held.executor = Held()
    assert held.start(LIVE_WORLD_ID, asset, geometry) is not None
    with caplog.at_level(logging.WARNING):
        assert held.start(LIVE_WORLD_ID, asset, geometry) is None  # the queue is full
    assert "too many renders queued" in caplog.text

    gone = LiveSiteViews(unused_session, FakeTrueColour(), BEFORE, AFTER, max_pending=1)
    gone.executor = ShutDown()
    with caplog.at_level(logging.WARNING):
        assert gone.start(LIVE_WORLD_ID, asset, geometry) is None
        assert gone.start(LIVE_WORLD_ID, asset, geometry) is None  # its slot came back
    assert "before/after views not started: RuntimeError" in caplog.text


# ----- with a database ----------------------------------------------------------------------------


@requires_db
def test_a_live_rating_stores_and_serves_its_views_five_years_apart(live: Live) -> None:
    go_live(live.w, FakeEarthEngine())
    client = FakeTrueColour()
    views_for(live, client)
    geometry = square(800)
    asset_id = live.draft(geometry)
    rate(live, asset_id)

    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)
    [row] = stored(live, asset_id)
    assert client.calls == [(1, *BEFORE), (1, *AFTER)]  # one outline, both windows
    grid = thumbnail_grid(geometry_bounds(geometry))
    assert (row.width, row.height) == (grid.width, grid.height)
    assert row.world_id == LIVE_WORLD_ID and row.data_version == LIVE_DATA_VERSION
    assert row.geometry_sha256 == geometry_sha256(geometry)
    detail = live.detail(asset_id)["site_views"]
    assert detail["before"] == {"start": BEFORE[0], "end": BEFORE[1]}
    assert detail["after"] == {"start": AFTER[0], "end": AFTER[1]}
    assert (detail["width"], detail["height"]) == (row.width, row.height)
    assert detail["attributions"] == list(VIEW_ATTRIBUTIONS)
    (south, west), (north, east) = grid.bounds()
    assert detail["bounds"] == {"south": south, "west": west, "north": north, "east": east}

    shades = {}
    for which in ("before", "after"):
        response = live.client().get(f"/assets/{asset_id}/views/{which}.webp?v={detail['version']}")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/webp"
        # Listed but not launched yet: private to its community, so never cached publicly.
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        with Image.open(io.BytesIO(response.content)) as image:
            assert image.size == (row.width, row.height)
            shades[which] = image.convert("L").getpixel((0, 0))
    assert cast(int, shades["before"]) < cast(int, shades["after"])
    # Others can't see it before its launch; after, it's public and cached.
    outsider = live.client(lifecycle._person(live.w.session, LIVE_WORLD_ID, "Outsider"))
    hidden = outsider.get(f"/assets/{asset_id}/views/after.webp")
    assert (hidden.status_code, hidden.json()["detail"]) == (404, "not_found")
    launch(live, asset_id)
    response = live.client().get(f"/assets/{asset_id}/views/after.webp?v={detail['version']}")
    assert response.headers["cache-control"] == "public, max-age=86400"


@requires_db
def test_views_render_beside_a_current_overlay_and_only_for_a_new_boundary(live: Live) -> None:
    service = go_live(live.w, FakeEarthEngine())
    land_cover = FakeLandCover()
    live.w.runner.live_overlays = LiveOverlays(
        session_factory=live.w.runner.session_factory, client=land_cover, executor=Inline()
    )
    asset_id = live.draft(square(800))
    rate(live, asset_id)  # an overlay, but no views yet (as a listing rated before views)
    assert len(land_cover.calls) == 1

    client = FakeTrueColour()
    views = views_for(live, client)
    rerate(live, asset_id)
    [first] = stored(live, asset_id)
    first_sha, first_south = first.geometry_sha256, first.south
    assert len(client.calls) == 2 and len(land_cover.calls) == 1  # the overlay was current

    rerate(live, asset_id)  # same boundary: nothing to render
    assert views.start(LIVE_WORLD_ID, UUID(asset_id), square(800)) is None
    assert len(client.calls) == 2

    moved = square(800, lat=LAT + 0.0004)
    asset = live.w.session.get_one(Asset, UUID(asset_id))
    asset.geojson = moved
    live.w.session.add(asset)
    live.w.session.commit()
    service.load(moved)
    rerate(live, asset_id)
    [second] = stored(live, asset_id)
    assert second.geometry_sha256 == geometry_sha256(moved) != first_sha
    assert second.south > first_south
    assert len(client.calls) == 4
    live.w.session.expire_all()
    assert live.w.session.get(AssetOverlay, UUID(asset_id)) is not None


@requires_db
def test_views_for_another_boundary_are_never_served(live: Live) -> None:
    go_live(live.w, FakeEarthEngine())
    views_for(live, FakeTrueColour())
    asset_id = live.draft(square(800))
    rate(live, asset_id)
    [row] = stored(live, asset_id)
    row.geometry_sha256 = "0" * 64  # e.g. rendered before the boundary changed
    live.w.session.add(row)
    live.w.session.commit()

    assert live.detail(asset_id)["site_views"] is None
    response = live.client().get(f"/assets/{asset_id}/views/before.webp")
    assert (response.status_code, response.json()["detail"]) == (404, "views_not_found")


@pytest.mark.parametrize(
    ("client", "logged"),
    [
        (FakeTrueColour(fail=OSError("/secret/key.json: permission denied")), "OSError"),
        (FakeTrueColour(size=(7, 7)), "ValueError"),  # not the grid it was asked for
    ],
    ids=["earth-engine-error", "wrong-size"],
)
@requires_db
def test_a_failed_render_never_fails_the_rating(
    live: Live, caplog: pytest.LogCaptureFixture, client: FakeTrueColour, logged: str
) -> None:
    go_live(live.w, FakeEarthEngine())
    views_for(live, client)
    asset_id = live.draft(square(800))
    with caplog.at_level(logging.WARNING):
        rate(live, asset_id)

    assert client.calls  # it was tried
    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)
    assert stored(live, asset_id) == []
    assert live.detail(asset_id)["site_views"] is None
    assert f"before/after views failed: {logged}" in caplog.text
    assert "secret" not in caplog.text


@requires_db
def test_a_view_over_its_byte_budget_is_never_stored(
    live: Live, caplog: pytest.LogCaptureFixture
) -> None:
    go_live(live.w, FakeEarthEngine())
    views_for(live, FakeTrueColour()).max_bytes = 10
    asset_id = live.draft(square(800))
    with caplog.at_level(logging.WARNING):
        rate(live, asset_id)
    assert status_of(live.w, asset_id) == (AssetStatus.LISTED, None)
    assert stored(live, asset_id) == []
    assert "before/after views failed: ValueError" in caplog.text


@requires_db
def test_mock_ratings_and_sandboxes_never_render(live: Live) -> None:
    client = FakeTrueColour()
    views_for(live, client)
    asset_id = live.draft(square(800))  # mock mode in the live world: no live metrics
    rate(live, asset_id)
    assert live.detail(asset_id)["mock"] is True
    w = live.w
    go_live(w, FakeEarthEngine()).load(square(1_200))
    sandbox_asset = str(lifecycle.draft(w)["id"])
    assert lifecycle.submit(w, sandbox_asset).status_code == 202
    w.executor.run_all()

    assert status_of(w, sandbox_asset)[0] is AssetStatus.LISTED
    assert client.calls == []
    assert stored(live, asset_id) == [] and stored(live, sandbox_asset) == []


def toolbox_for(live: Live, asset_id: str, geometry: dict[str, Any], views: LiveSiteViews) -> Any:
    """The rating's tools for a live listing, with a model to hand the images to."""
    factory = live.w.runner.session_factory
    spec = RunSpec(uuid4(), LIVE_WORLD_ID, UUID(asset_id), "baseline", "api")
    info = AssetInfo(
        UUID(asset_id), LIVE_WORLD_ID, "Live", None, None, None, None, 1, None, geometry
    )
    deps = RunDeps(
        session_factory=factory,
        settings=lifecycle._settings(use_mocks=False, site_vision_live=True),
        metrics_loader=lambda *_: pytest.fail("not loaded"),
        news=lambda *_: pytest.fail("no news"),  # type: ignore[arg-type,return-value]
        evidence=NoFieldEvidence(),
        today=lambda: date(2026, 10, 18),
        views=views,
    )
    return RunToolbox(
        spec,
        info,
        deps,
        llm=cast(LLMClient, object()),
        no_llm_reason=None,
        progress=RunProgress(spec, factory, 0),
        recorder=None,
    )


METRICS = cast(EarthObsMetrics, SimpleNamespace(simulated=False))


@requires_db
def test_the_vision_model_compares_the_views_this_rating_rendered(
    live: Live, monkeypatch: pytest.MonkeyPatch
) -> None:
    go_live(live.w, FakeEarthEngine())
    asset_id = live.draft(square(800))
    rate(live, asset_id)  # rated before views existed: none stored
    assert stored(live, asset_id) == []
    read: list[tuple[bytes, bytes]] = []

    def fake_read(images: tuple[bytes, bytes], **_: Any) -> Any:
        read.append(images)
        return SimpleNamespace(changes=[], to_json=lambda: {"changes": []})

    monkeypatch.setattr(rating_runs, "read_site_change", fake_read)
    views = views_for(live, FakeTrueColour())
    toolbox = toolbox_for(live, asset_id, square(800), views)
    toolbox.views = views.start(LIVE_WORLD_ID, UUID(asset_id), square(800))  # as the step does

    assert toolbox._read_images(METRICS) == {"changes": []}
    [row] = stored(live, asset_id)
    assert read == [(row.before_webp, row.after_webp)]


@requires_db
def test_a_database_error_loading_the_views_never_fails_the_rating(
    live: Live, monkeypatch: pytest.MonkeyPatch
) -> None:
    go_live(live.w, FakeEarthEngine())
    views = views_for(live, FakeTrueColour())
    asset_id = live.draft(square(800))
    rate(live, asset_id)

    def broken(*_: Any, **__: Any) -> Any:
        raise OperationalError("SELECT", {}, Exception("connection pool timed out"))

    monkeypatch.setattr(rating_runs, "current_views", broken)
    toolbox = toolbox_for(live, asset_id, square(800), views)
    assert toolbox._read_images(METRICS) == {"error": "OperationalError"}


@requires_db
def test_the_views_migration_downgrades_and_upgrades() -> None:
    """0027: `asset_views` comes and goes."""
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)

    def tables() -> set[str]:
        with engine.connect() as c:
            return set(inspect(c).get_table_names())

    try:
        assert "asset_views" in tables()
        command.downgrade(cfg, "0026")
        assert "asset_views" not in tables()
    finally:
        command.upgrade(cfg, "head")
        assert "asset_views" in tables()
        engine.dispose()

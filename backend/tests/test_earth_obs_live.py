"""Live Earth Engine ratings for new listings (T60): cache, timeout, quotas and the listing flow.
Earth Engine is never called: the live service runs on a fake client."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, func
from sqlmodel import Session, col, select

from app.config import Settings
from app.models import Asset, AssetStatus, EarthObsCache, LiveRatingRequest, Metrics, Report
from app.services.earth_obs_live import (
    EARTH_ENGINE_BUSY,
    EARTH_ENGINE_ERROR,
    EARTH_ENGINE_INVALID_OUTPUT,
    EARTH_ENGINE_TIMEOUT,
    LIVE_DATA_VERSION,
    LIVE_RATING_GLOBAL_LIMIT,
    LIVE_RATING_QUOTA,
    QUOTA_WINDOW,
    LiveEarthObs,
    LiveMetricsError,
    LiveQuota,
    LiveQuotaExceeded,
    build_live_earth_obs,
    live_site_key,
    reserve_live_rating,
)
from app.services.lifecycle import NO_SATELLITE_METRICS
from app.services.rating_runs import (
    LIVE_METRICS_PENDING,
    AssetInfo,
    ToolFailed,
    load_cached_metrics,
    resolve_metrics,
)
from app.tools import earth_engine as eng
from app.tools.earth_obs import EarthObsMetrics, is_curated_site, is_mock_metrics
from app.tools.geometry import geometry_sha256, validate_polygon
from tests import test_lifecycle as lifecycle
from tests.conftest import requires_db
from tests.test_earth_engine import LAND_COVER, ndvi_fixture
from tests.test_lifecycle import (
    LAT,
    LON,
    World_,
    age_submission,
    client_as,
    draft,
    square,
    status_of,
    submit,
    transitions,
)

conn = lifecycle.conn
world = lifecycle.world


def test_the_api_names_the_shared_data_version_without_importing_earth_engine() -> None:
    assert LIVE_DATA_VERSION == eng.DATA_VERSION
    assert not is_curated_site(live_site_key("ab" * 32))


def test_live_is_off_unless_switched_on_and_configured() -> None:
    def settings(**overrides: Any) -> Settings:
        return Settings(_env_file=None, **overrides)  # type: ignore[arg-type]

    factory: Callable[[], Session] = lambda: pytest.fail("no session needed")  # noqa: E731
    assert build_live_earth_obs(settings(), factory) is None
    assert build_live_earth_obs(settings(ee_service_account_json="/k.json"), factory) is None
    assert build_live_earth_obs(settings(earth_engine_live=True), factory) is None
    live = build_live_earth_obs(
        settings(earth_engine_live=True, ee_service_account_json="/k.json"), factory
    )
    assert isinstance(live, LiveEarthObs) and live.timeout_s == 120.0


# ----- a fake Earth Engine ------------------------------------------------------------------------


class FakeEarthEngine:
    """Computes plausible metrics for any polygon with the shared assembly, without Earth
    Engine. `fail`, `delay` and `change` simulate errors, slowness and odd outputs."""

    def __init__(
        self,
        *,
        fail: Exception | None = None,
        delay_s: float = 0.0,
        change: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        gate: threading.Event | None = None,
    ) -> None:
        self.fail = fail
        self.delay_s = delay_s
        self.change = change
        self.gate = gate
        self.calls: list[str] = []

    def compute(
        self, geojson: Any, *, site_key: str, checkpoint: Callable[[], None]
    ) -> dict[str, Any]:
        self.calls.append(site_key)
        checkpoint()
        if self.gate is not None:
            self.gate.wait(5)
        if self.delay_s:
            time.sleep(self.delay_s)
            checkpoint()
        if self.fail is not None:
            raise self.fail
        check = validate_polygon(geojson)
        assert check.ok and check.area_ha and check.centroid_lat and check.centroid_lon
        document = eng.assemble_metrics(
            site_key=site_key,
            computed_at_utc="2026-10-19T10:00:00Z",
            area_ha=check.area_ha,
            centroid_lat=check.centroid_lat,
            centroid_lon=check.centroid_lon,
            land_cover=LAND_COVER,
            ndvi=eng.ndvi_summary(ndvi_fixture(tau=0.05, slope=0.004)),
            water_change=0.0,
            forest_loss=(0.0, 0.0),
            biomass=(150.0, None),
            mangrove_fraction=0.0,
            soc_t_c_ha=70.0,
        )
        return self.change(document) if self.change else document


def sessions(c: Connection) -> Callable[[], Session]:
    return lambda: Session(bind=c, join_transaction_mode="create_savepoint")


def live_service(
    c: Connection, client: FakeEarthEngine, *, timeout_s: float = 5.0, max_concurrent: int = 1
) -> LiveEarthObs:
    return LiveEarthObs(
        session_factory=sessions(c),
        client=client,
        timeout_s=timeout_s,
        max_concurrent=max_concurrent,
    )


POLYGON = square(800)
"""About 64 ha far from every curated site."""


# ----- the live service: cache, timeout, concurrency, errors (DB) -----------------------------


@requires_db
def test_a_polygon_is_computed_once_then_served_from_the_cache(conn: Connection) -> None:
    fake = FakeEarthEngine()
    live = live_service(conn, fake)
    assert live.cached(POLYGON) is None

    first = live.load(POLYGON)
    sha = geometry_sha256(POLYGON)
    assert first.site_key == live_site_key(sha) and first.data_version == LIVE_DATA_VERSION
    assert not is_mock_metrics(first) and first.attributions  # Dynamic World, Copernicus, …
    assert any("Dynamic World" in text for text in first.attributions)
    feature = {"type": "Feature", "properties": {"name": "x"}, "geometry": POLYGON}
    assert live.load(feature) == first  # same bare geometry, same cache key
    assert fake.calls == [first.site_key]
    with Session(bind=conn) as session:
        row = session.get_one(EarthObsCache, (sha, LIVE_DATA_VERSION))
        assert row.latency_ms >= 0 and EarthObsMetrics.model_validate(row.metrics) == first

    other = live_service(conn, FakeEarthEngine(), timeout_s=1.0)
    other.data_version = "2026Q4"  # a new data version computes again
    assert other.cached(POLYGON) is None


@requires_db
def test_a_slow_computation_times_out_and_frees_its_slot_once_it_stops(conn: Connection) -> None:
    slow = FakeEarthEngine(delay_s=0.4)
    live = live_service(conn, slow, timeout_s=0.1)
    started = time.monotonic()
    with pytest.raises(LiveMetricsError) as failed:
        live.compute(POLYGON)
    assert failed.value.code == EARTH_ENGINE_TIMEOUT and time.monotonic() - started < 0.35
    assert live.cached(POLYGON) is None  # nothing half-computed is cached
    time.sleep(0.5)  # the abandoned call reached its next checkpoint and stopped
    slow.delay_s = 0.0
    assert live.compute(POLYGON).data_version == LIVE_DATA_VERSION


@requires_db
def test_runs_wait_for_a_free_slot_and_give_up_as_busy(conn: Connection) -> None:
    gate = threading.Event()
    blocked = FakeEarthEngine(gate=gate)
    live = live_service(conn, blocked, timeout_s=0.2)
    first = threading.Thread(target=lambda: pytest.raises(LiveMetricsError, live.compute, POLYGON))
    first.start()
    time.sleep(0.05)
    with pytest.raises(LiveMetricsError) as busy:
        live.compute(square(800, lat=LAT + 0.1))
    assert busy.value.code == EARTH_ENGINE_BUSY
    gate.set()
    first.join(5)


@pytest.mark.parametrize(
    ("fake", "code"),
    [
        (FakeEarthEngine(fail=RuntimeError("User memory limit exceeded.")), EARTH_ENGINE_ERROR),
        (FakeEarthEngine(change=lambda d: {**d, "area_ha": "lots"}), EARTH_ENGINE_INVALID_OUTPUT),
        (FakeEarthEngine(change=lambda d: {**d, "data_version": "2020Q1"}), "invalid"),
    ],
    ids=["earth-engine-error", "invalid-output", "other-data-version"],
)
@requires_db
def test_failures_have_a_code_and_cache_nothing(
    conn: Connection, fake: FakeEarthEngine, code: str
) -> None:
    live = live_service(conn, fake)
    with pytest.raises(LiveMetricsError) as failed:
        live.compute(POLYGON)
    expected = EARTH_ENGINE_INVALID_OUTPUT if code == "invalid" else code
    assert failed.value.code == expected
    assert live.cached(POLYGON) is None


# ----- resolving a run's metrics --------------------------------------------------------------


def asset_for(polygon: dict[str, Any]) -> AssetInfo:
    check = validate_polygon(polygon)
    return AssetInfo(
        id=uuid4(),
        world_id=uuid4(),
        name="New",
        site_key=None,
        country="CR",
        centroid_lat=check.centroid_lat,
        centroid_lon=check.centroid_lon,
        total_shares=0,
        area_ha=check.area_ha,
        geojson=polygon,
    )


@requires_db
def test_only_a_listing_run_computes_and_live_replaces_mocks(conn: Connection) -> None:
    fake = FakeEarthEngine()
    live = live_service(conn, fake)
    asset = asset_for(POLYGON)

    with pytest.raises(ToolFailed) as pending:  # e.g. an API re-rate: never computes
        resolve_metrics(load_cached_metrics, asset, "baseline", True, live)
    assert pending.value.code == LIVE_METRICS_PENDING and fake.calls == []

    computed = resolve_metrics(
        load_cached_metrics, asset, "baseline", True, live, compute_live=True
    )
    assert not is_mock_metrics(computed) and len(fake.calls) == 1
    assert resolve_metrics(load_cached_metrics, asset, "baseline", True, live) == computed
    with pytest.raises(ToolFailed) as simulated:  # no Time Machine for new polygons
        resolve_metrics(load_cached_metrics, asset, "restoration", True, live, compute_live=True)
    assert simulated.value.code == "no_cached_metrics"


FOREIGN = [
    pytest.param(lambda d: {**d, "centroid": {"lat": LAT + 1, "lon": LON}}, id="centroid"),
    pytest.param(lambda d: {**d, "area_ha": d["area_ha"] * 1.5}, id="area"),
    pytest.param(lambda d: {**d, "site_key": "wetland_mx"}, id="curated-site-key"),
]


@pytest.mark.parametrize("change", FOREIGN)
@requires_db
def test_live_metrics_that_dont_describe_the_polygon_are_never_cached(
    conn: Connection, change: Callable[[dict[str, Any]], dict[str, Any]]
) -> None:
    live = live_service(conn, FakeEarthEngine(change=change))
    with pytest.raises(ToolFailed) as invalid:
        resolve_metrics(
            load_cached_metrics, asset_for(POLYGON), "baseline", False, live, compute_live=True
        )
    assert invalid.value.code == EARTH_ENGINE_INVALID_OUTPUT
    assert live.cached(POLYGON) is None


@pytest.mark.parametrize("change", FOREIGN)
@requires_db
def test_a_cache_row_of_another_place_is_foreign(
    conn: Connection, change: Callable[[dict[str, Any]], dict[str, Any]]
) -> None:
    """T58's guard still runs on cached live metrics: a bad row never rates a listing."""
    fake = FakeEarthEngine()
    live = live_service(conn, fake)
    poisoned = change(fake.compute(POLYGON, site_key="x", checkpoint=lambda: None))
    with Session(bind=conn) as session:
        session.add(
            EarthObsCache(
                geometry_sha256=geometry_sha256(POLYGON),
                data_version=LIVE_DATA_VERSION,
                metrics=poisoned,
                latency_ms=1,
            )
        )
        session.commit()
    with pytest.raises(ToolFailed) as foreign:
        resolve_metrics(
            load_cached_metrics, asset_for(POLYGON), "baseline", False, live, compute_live=True
        )
    assert foreign.value.code == "foreign_metrics"


@requires_db
def test_live_failures_fail_the_step_without_a_retry(conn: Connection) -> None:
    for error, code in (
        (RuntimeError("Too many concurrent aggregations."), EARTH_ENGINE_ERROR),
        (TimeoutError("read timed out"), EARTH_ENGINE_TIMEOUT),  # a request's own deadline
    ):
        live = live_service(conn, FakeEarthEngine(fail=error))
        with pytest.raises(ToolFailed) as failed:
            resolve_metrics(
                load_cached_metrics, asset_for(POLYGON), "baseline", True, live, compute_live=True
            )
        assert failed.value.code == code and failed.value.retryable is False


# ----- quotas (DB) ----------------------------------------------------------------------------


def quota(user_id: UUID, *, per_user: int = 2, everyone: int = 50) -> LiveQuota:
    return LiveQuota(
        user_id=user_id,
        geometry_sha256="a" * 64,
        per_user_per_day=per_user,
        global_per_day=everyone,
    )


@pytest.fixture
def session(conn: Connection) -> Iterator[Session]:
    with Session(bind=conn, join_transaction_mode="create_savepoint") as s:
        s.execute(LiveRatingRequest.__table__.delete())  # type: ignore[attr-defined]
        yield s


@requires_db
def test_two_live_ratings_per_account_per_rolling_day(session: Session) -> None:
    ada, bo = uuid4(), uuid4()
    now = datetime(2026, 10, 19, 12, tzinfo=UTC)
    reserve_live_rating(session, quota(ada), now - timedelta(hours=20))
    reserve_live_rating(session, quota(ada), now - timedelta(hours=2))
    with pytest.raises(LiveQuotaExceeded) as spent:
        reserve_live_rating(session, quota(ada), now)
    assert spent.value.code == LIVE_RATING_QUOTA
    assert spent.value.retry_after_s == 4 * 3600  # when the 20-hour-old one leaves the window
    reserve_live_rating(session, quota(bo), now)  # another account still may
    reserve_live_rating(session, quota(ada), now + timedelta(hours=4, seconds=1))
    with pytest.raises(LiveQuotaExceeded):
        reserve_live_rating(session, quota(ada, per_user=0), now)


@requires_db
def test_a_global_daily_cap_bounds_every_account_together(session: Session) -> None:
    now = datetime(2026, 10, 19, 12, tzinfo=UTC)
    for hours in (23, 1):
        reserve_live_rating(session, quota(uuid4(), everyone=2), now - timedelta(hours=hours))
    with pytest.raises(LiveQuotaExceeded) as capped:
        reserve_live_rating(session, quota(uuid4(), everyone=2), now)
    assert capped.value.code == LIVE_RATING_GLOBAL_LIMIT and capped.value.retry_after_s == 3600


@requires_db
def test_counted_rows_older_than_two_days_are_pruned(session: Session) -> None:
    now = datetime(2026, 10, 19, 12, tzinfo=UTC)
    reserve_live_rating(session, quota(uuid4()), now - timedelta(days=3))
    reserve_live_rating(session, quota(uuid4()), now)
    times = session.exec(select(LiveRatingRequest.created_at)).all()
    assert times == [now] and timedelta(days=1) == QUOTA_WINDOW


# ----- the listing flow, end to end (DB) -------------------------------------------------------


def go_live(w: World_, fake: FakeEarthEngine, **overrides: Any) -> None:
    w.runner.settings = lifecycle._settings(use_mocks=False, **overrides)
    w.runner.live_metrics = LiveEarthObs(
        session_factory=w.runner.session_factory, client=fake, timeout_s=5.0
    )


def counted(w: World_) -> int:
    return int(w.session.exec(select(func.count()).select_from(LiveRatingRequest)).one())


@pytest.fixture
def live_world(world: World_) -> World_:
    world.session.execute(LiveRatingRequest.__table__.delete())  # type: ignore[attr-defined]
    world.session.execute(EarthObsCache.__table__.delete())  # type: ignore[attr-defined]
    world.session.commit()
    return world


@requires_db
def test_a_new_listing_is_rated_with_its_own_live_metrics(live_world: World_) -> None:
    w, fake = live_world, FakeEarthEngine()
    go_live(w, fake)
    asset = draft(w)
    run_id = submit(w, asset["id"]).json()["run_id"]
    assert counted(w) == 1 and fake.calls == []  # counted at submit, computed by the run
    w.executor.run_all()

    assert status_of(w, asset["id"]) == (AssetStatus.LISTED, None)
    run = client_as(w, w.steward).get(f"/runs/{run_id}").json()
    assert run["status"] in {"succeeded", "degraded"}
    earth_obs = next(step for step in run["steps"] if step["step"] == "earth_obs")
    assert earth_obs["status"] == "ok"
    detail = client_as(w, w.steward).get(f"/assets/{asset['id']}").json()
    assert detail["mock"] is False
    metrics = w.session.exec(
        select(Metrics)
        .join(Report, col(Report.metrics_id) == col(Metrics.id))
        .where(Report.asset_id == UUID(asset["id"]))
    ).one()
    assert metrics.data_version == LIVE_DATA_VERSION
    assert len(fake.calls) == 1


@requires_db
def test_a_cached_polygon_is_free_and_a_third_live_rating_a_day_is_refused(
    live_world: World_,
) -> None:
    w, fake = live_world, FakeEarthEngine()
    go_live(w, fake)
    first = draft(w, geojson=square(800))
    second = draft(w, geojson=square(800, lat=LAT + 0.05))
    third = draft(w, geojson=square(800, lat=LAT + 0.1))
    live = w.runner.live_metrics
    assert live is not None
    live.load(square(800, lat=LAT + 0.1))  # e.g. a sandbox listed the same land before
    assert submit(w, first["id"]).status_code == 202
    assert submit(w, second["id"]).status_code == 202
    assert counted(w) == 2
    assert submit(w, third["id"]).status_code == 202  # cached: not a live rating
    assert counted(w) == 2

    fourth = draft(w, geojson=square(800, lat=LAT + 0.15))
    refused = submit(w, fourth["id"])
    assert (refused.status_code, refused.json()["detail"]) == (429, LIVE_RATING_QUOTA)
    assert 1 <= int(refused.headers["retry-after"]) <= 86_400
    assert status_of(w, fourth["id"]) == (AssetStatus.DRAFT, None)  # untouched
    other = draft(w, user=w.owner, geojson=square(800, lat=LAT + 0.2))
    assert submit(w, other["id"], user=w.owner).status_code == 202  # quotas are per account


@requires_db
def test_the_global_daily_cap_refuses_live_ratings(live_world: World_) -> None:
    w = live_world
    go_live(w, FakeEarthEngine(), live_ratings_global_per_day=1)
    assert submit(w, draft(w)["id"]).status_code == 202
    late = draft(w, user=w.owner, geojson=square(800, lat=LAT + 0.1))
    refused = submit(w, late["id"], user=w.owner)
    assert (refused.status_code, refused.json()["detail"]) == (429, LIVE_RATING_GLOBAL_LIMIT)


@requires_db
def test_a_failed_live_run_keeps_the_listing_in_rating_and_it_can_retry(
    live_world: World_,
) -> None:
    w, fake = live_world, FakeEarthEngine(fail=RuntimeError("Computation timed out."))
    go_live(w, fake)
    asset = draft(w)
    run_id = submit(w, asset["id"]).json()["run_id"]
    w.executor.run_all()

    run = client_as(w, w.steward).get(f"/runs/{run_id}").json()
    assert run["status"] == "failed" and run["error"] == f"earth_obs_failed:{EARTH_ENGINE_ERROR}"
    reason = f"rating_failed:earth_obs_failed:{EARTH_ENGINE_ERROR}"
    assert status_of(w, asset["id"]) == (AssetStatus.RATING, reason)
    assert (
        w.session.exec(select(Report).where(Report.asset_id == UUID(asset["id"]))).first() is None
    )
    assert len(fake.calls) == 1  # no retry inside the run

    cooling = submit(w, asset["id"])
    assert (cooling.status_code, cooling.json()["detail"]) == (429, "resubmit_cooldown")
    age_submission(w, asset["id"])
    fake.fail = None
    assert submit(w, asset["id"]).status_code == 202
    assert counted(w) == 2  # the retry is a live rating too
    w.executor.run_all()
    assert status_of(w, asset["id"]) == (AssetStatus.LISTED, None)
    assert transitions(w, asset["id"]) == ["create", "submit", "submit", None, "rated"]


@requires_db
def test_a_listing_waiting_for_metrics_can_retry_once_live_is_on(live_world: World_) -> None:
    w = live_world
    w.runner.settings = lifecycle._settings(use_mocks=False)  # live off, no mocks
    asset = draft(w)
    submit(w, asset["id"])
    w.executor.run_all()
    assert status_of(w, asset["id"]) == (AssetStatus.RATING, NO_SATELLITE_METRICS)
    age_submission(w, asset["id"])
    waiting = submit(w, asset["id"])
    assert (waiting.status_code, waiting.json()["detail"]) == (409, "metrics_unavailable")

    go_live(w, FakeEarthEngine())
    assert submit(w, asset["id"]).status_code == 202
    w.executor.run_all()
    assert status_of(w, asset["id"]) == (AssetStatus.LISTED, None)


@requires_db
def test_a_live_listing_never_shows_another_sites_data(live_world: World_) -> None:
    w = live_world
    go_live(w, FakeEarthEngine(change=lambda d: {**d, "centroid": {"lat": 19.29, "lon": -99.1}}))
    asset = draft(w)
    run_id = submit(w, asset["id"]).json()["run_id"]
    w.executor.run_all()
    run = client_as(w, w.steward).get(f"/runs/{run_id}").json()
    assert run["error"] == f"earth_obs_failed:{EARTH_ENGINE_INVALID_OUTPUT}"
    row = w.session.get_one(Asset, UUID(asset["id"]))
    assert row.status is AssetStatus.RATING
    assert w.session.exec(select(Report).where(Report.asset_id == row.id)).first() is None

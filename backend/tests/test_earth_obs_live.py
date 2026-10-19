"""Live Earth Engine ratings for new listings (T60): cache, timeout, quotas and the listing flow.
Earth Engine is never called: the live service runs on a fake client."""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, func
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, col, select

from app.auth import SESSION_COOKIE, start_session
from app.communities import create_community
from app.config import Settings
from app.main import app
from app.models import (
    Asset,
    AssetStatus,
    EarthObsCache,
    LiveRatingRequest,
    Metrics,
    Report,
    SessionKind,
    User,
)
from app.services.cached_example import cached_example, distance_km, waiting_for_satellite_metrics
from app.services.earth_obs_live import (
    EARTH_ENGINE_BUSY,
    EARTH_ENGINE_ERROR,
    EARTH_ENGINE_INVALID_OUTPUT,
    EARTH_ENGINE_TIMEOUT,
    LIVE_AREA_TOO_LARGE,
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
    loggable,
    refund_live_rating,
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
from app.worlds import LIVE_WORLD_ID
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
    assert live.max_area_ha == 5_000.0 and live.max_concurrent == 1
    assert live.client._max_retries == 0  # type: ignore[attr-defined]  # no retries per request


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
        late: bool = False,
    ) -> None:
        self.fail = fail
        self.delay_s = delay_s
        self.change = change
        self.gate = gate
        self.late = late
        """With `delay_s`, finish the last step after the deadline instead of stopping."""
        self.calls: list[str] = []
        self.running = 0
        self.most_running = 0
        self._lock = threading.Lock()

    def compute(
        self, geojson: Any, *, site_key: str, checkpoint: Callable[[], None]
    ) -> dict[str, Any]:
        self.calls.append(site_key)
        checkpoint()
        with self._lock:
            self.running += 1
            self.most_running = max(self.most_running, self.running)
        try:
            if self.gate is not None:
                self.gate.wait(5)
            if self.delay_s:
                time.sleep(self.delay_s)
                if not self.late:
                    checkpoint()
        finally:
            with self._lock:
                self.running -= 1
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
    c: Connection,
    client: FakeEarthEngine,
    *,
    timeout_s: float = 5.0,
    max_concurrent: int = 1,
    max_area_ha: float | None = None,
) -> LiveEarthObs:
    return LiveEarthObs(
        session_factory=sessions(c),
        client=client,
        timeout_s=timeout_s,
        max_concurrent=max_concurrent,
        max_area_ha=max_area_ha,
    )


def memory_service(client: FakeEarthEngine, **options: Any) -> LiveEarthObs:
    """A live service with an in-memory cache: for tests that run computations on several
    threads, which must not share one test connection."""
    store: dict[str, EarthObsMetrics] = {}
    live = LiveEarthObs(
        session_factory=lambda: pytest.fail("no database"),  # type: ignore[return-value]
        client=client,
        **{"timeout_s": 5.0, **options},
    )
    live.cached = lambda geojson: store.get(geometry_sha256(geojson))  # type: ignore[method-assign]
    live._store = (  # type: ignore[method-assign]
        lambda sha, metrics, _ms: store.__setitem__(sha, metrics)
    )
    return live


POLYGON = square(800)
"""About 64 ha far from every curated site."""


# ----- the live service: cache, timeout, concurrency, errors ------------------------------------


@requires_db
def test_a_polygon_is_computed_once_then_served_from_the_cache(conn: Connection) -> None:
    fake = FakeEarthEngine()
    live = live_service(conn, fake)
    assert live.cached(POLYGON) is None

    first = live.load(POLYGON)
    sha = geometry_sha256(POLYGON)
    assert first.site_key == live_site_key(sha) and first.data_version == LIVE_DATA_VERSION
    assert not is_mock_metrics(first)
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


def test_a_slow_computation_times_out_and_frees_its_slot_once_it_stops() -> None:
    slow = FakeEarthEngine(delay_s=0.6)
    live = memory_service(slow, timeout_s=0.1)
    started = time.monotonic()
    with pytest.raises(LiveMetricsError) as failed:
        live.compute(POLYGON)
    assert failed.value.code == EARTH_ENGINE_TIMEOUT and time.monotonic() - started < 0.5
    time.sleep(0.8)  # the abandoned call reached its next checkpoint and stopped
    assert live.cached(POLYGON) is None  # nothing half-computed is cached
    slow.delay_s = 0.0
    assert live.compute(POLYGON).data_version == LIVE_DATA_VERSION


def test_a_valid_result_that_arrives_late_is_cached_for_the_retry() -> None:
    late = FakeEarthEngine(delay_s=0.4, late=True)
    live = memory_service(late, timeout_s=0.1)
    with pytest.raises(LiveMetricsError) as failed:
        live.compute(POLYGON)
    assert failed.value.code == EARTH_ENGINE_TIMEOUT
    time.sleep(0.7)
    cached = live.cached(POLYGON)
    assert cached is not None and live.load(POLYGON) == cached
    assert len(late.calls) == 1  # the retry was free


def test_runs_wait_for_a_free_slot_and_give_up_as_busy() -> None:
    gate = threading.Event()
    live = memory_service(FakeEarthEngine(gate=gate), timeout_s=0.2)
    errors: list[BaseException] = []

    def first() -> None:
        try:
            live.compute(POLYGON)
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=first)
    thread.start()
    time.sleep(0.05)
    with pytest.raises(LiveMetricsError) as busy:
        live.compute(square(800, lat=LAT + 0.1))
    assert busy.value.code == EARTH_ENGINE_BUSY
    gate.set()
    thread.join(5)
    assert [getattr(e, "code", e) for e in errors] == [EARTH_ENGINE_TIMEOUT]


def test_up_to_max_concurrent_computations_run_at_once() -> None:
    gate = threading.Event()
    fake = FakeEarthEngine(gate=gate)
    live = memory_service(fake, max_concurrent=2)
    results: list[EarthObsMetrics] = []
    polygons = [square(800, lat=LAT + 0.1 * i) for i in range(2)]
    threads = [
        threading.Thread(target=lambda p=p: results.append(live.compute(p))) for p in polygons
    ]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + 2
    while fake.running < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert fake.running == 2  # both inside Earth Engine at once
    gate.set()
    for thread in threads:
        thread.join(5)
    assert len(results) == 2 and fake.most_running == 2


def test_a_failure_to_cache_still_returns_the_metrics(caplog: pytest.LogCaptureFixture) -> None:
    live = memory_service(FakeEarthEngine())

    def broken_store(*_: Any) -> None:
        raise OperationalError("INSERT", {}, Exception("connection lost"))

    live._store = broken_store  # type: ignore[method-assign]
    with caplog.at_level(logging.WARNING):
        metrics = live.compute(POLYGON)
    assert metrics.data_version == LIVE_DATA_VERSION and live.cached(POLYGON) is None
    assert "could not cache live Earth Engine metrics: OperationalError" in caplog.text


def test_polygons_above_the_live_area_cap_are_never_computed() -> None:
    fake = FakeEarthEngine()
    live = memory_service(fake, max_area_ha=50.0)  # POLYGON is about 64 ha
    assert not live.area_allowed(64.0) and live.area_allowed(50.0)
    with pytest.raises(LiveMetricsError) as refused:
        live.compute(POLYGON)
    assert refused.value.code == LIVE_AREA_TOO_LARGE and fake.calls == []


@pytest.mark.parametrize(
    ("fake", "code"),
    [
        (FakeEarthEngine(fail=RuntimeError("User memory limit exceeded.")), EARTH_ENGINE_ERROR),
        (FakeEarthEngine(change=lambda d: {**d, "area_ha": "lots"}), EARTH_ENGINE_INVALID_OUTPUT),
        (
            FakeEarthEngine(change=lambda d: {**d, "data_version": "2020Q1"}),
            EARTH_ENGINE_INVALID_OUTPUT,
        ),
    ],
    ids=["earth-engine-error", "invalid-output", "other-data-version"],
)
def test_failures_have_a_code_and_cache_nothing(fake: FakeEarthEngine, code: str) -> None:
    live = memory_service(fake)
    with pytest.raises(LiveMetricsError) as failed:
        live.compute(POLYGON)
    assert failed.value.code == code
    assert live.cached(POLYGON) is None


# ----- the key never reaches the logs -----------------------------------------------------------

SECRET = "SECRET-private-key-material"


@pytest.mark.parametrize(
    "setting",
    [
        f'{{"type": "service_account", "private_key": "{SECRET}"',  # truncated JSON
        f"/no/such/dir/{SECRET}.json",
        f'"{{"private_key": "{SECRET}"}}"',  # quoted, then no client_email
        f'\ufeff{{"private_key": "{SECRET}"}}',  # byte-order mark
    ],
    ids=["broken-json", "missing-file", "quoted-json", "bom"],
)
def test_a_malformed_key_setting_is_never_logged(
    setting: str, caplog: pytest.LogCaptureFixture
) -> None:
    with pytest.raises(ValueError) as refused:
        eng.service_account_key(setting)
    assert SECRET not in str(refused.value) and refused.value.__cause__ is None
    # No chained error (e.g. an OSError naming the setting) is printed with a traceback.
    assert refused.value.__context__ is None or refused.value.__suppress_context__

    live = memory_service(
        eng.EarthEngineApi(setting, request_timeout_s=1)  # type: ignore[arg-type]
    )
    with caplog.at_level(logging.DEBUG), pytest.raises(LiveMetricsError) as failed:
        live.compute(POLYGON)  # fails in init_ee, before any network call
    assert failed.value.code == EARTH_ENGINE_ERROR
    assert "ValueError" in caplog.text and SECRET not in caplog.text


def test_quoted_and_bom_prefixed_inline_keys_are_read() -> None:
    key = {"type": "service_account", "client_email": "a@b", "project_id": "p"}
    for setting in (f"'{json.dumps(key)}'", f'"{json.dumps(key)}"', f"\ufeff{json.dumps(key)}"):
        assert eng.service_account_key(setting) == (key, None)


def test_only_earth_engine_errors_have_their_message_logged() -> None:
    import ee

    assert loggable(OSError(f"/keys/{SECRET}")) == "OSError"
    assert loggable(ee.EEException("User memory limit exceeded.")) == (
        "EEException: User memory limit exceeded."
    )


# ----- resolving a run's metrics --------------------------------------------------------------


def asset_for(polygon: dict[str, Any], world_id: UUID = LIVE_WORLD_ID) -> AssetInfo:
    check = validate_polygon(polygon)
    return AssetInfo(
        id=uuid4(),
        world_id=world_id,
        name="New",
        site_key=None,
        country="CR",
        centroid_lat=check.centroid_lat,
        centroid_lon=check.centroid_lon,
        total_shares=0,
        area_ha=check.area_ha,
        geojson=polygon,
    )


def test_only_a_live_world_listing_run_computes_and_live_replaces_mocks() -> None:
    fake = FakeEarthEngine()
    live = memory_service(fake)
    asset = asset_for(POLYGON)

    with pytest.raises(ToolFailed) as pending:  # e.g. an API re-rate: never computes
        resolve_metrics(load_cached_metrics, asset, "baseline", True, live)
    assert pending.value.code == LIVE_METRICS_PENDING and fake.calls == []

    demo = asset_for(POLYGON, world_id=uuid4())  # a sandbox never computes: mocks, if on
    mocked = resolve_metrics(load_cached_metrics, demo, "baseline", True, live, compute_live=True)
    assert is_mock_metrics(mocked) and fake.calls == []
    with pytest.raises(ToolFailed) as missing:
        resolve_metrics(load_cached_metrics, demo, "baseline", False, live, compute_live=True)
    assert missing.value.code == "no_cached_metrics" and fake.calls == []

    computed = resolve_metrics(
        load_cached_metrics, asset, "baseline", True, live, compute_live=True
    )
    assert not is_mock_metrics(computed) and len(fake.calls) == 1
    assert resolve_metrics(load_cached_metrics, asset, "baseline", True, live) == computed
    reused = resolve_metrics(load_cached_metrics, demo, "baseline", False, live)
    assert reused == computed  # a sandbox may reuse a computed polygon
    with pytest.raises(ToolFailed) as simulated:  # no Time Machine for new polygons
        resolve_metrics(load_cached_metrics, asset, "restoration", True, live, compute_live=True)
    assert simulated.value.code == "no_cached_metrics"


FOREIGN = [
    pytest.param(lambda d: {**d, "centroid": {"lat": LAT + 1, "lon": LON}}, id="centroid"),
    pytest.param(lambda d: {**d, "area_ha": d["area_ha"] * 1.5}, id="area"),
    pytest.param(lambda d: {**d, "site_key": "wetland_mx"}, id="curated-site-key"),
]


@pytest.mark.parametrize("change", FOREIGN)
def test_live_metrics_that_dont_describe_the_polygon_are_never_cached(
    change: Callable[[dict[str, Any]], dict[str, Any]],
) -> None:
    live = memory_service(FakeEarthEngine(change=change))
    with pytest.raises(ToolFailed) as invalid:
        resolve_metrics(
            load_cached_metrics, asset_for(POLYGON), "baseline", False, live, compute_live=True
        )
    assert invalid.value.code == EARTH_ENGINE_INVALID_OUTPUT
    assert live.cached(POLYGON) is None


@pytest.mark.parametrize("change", [*FOREIGN, pytest.param(lambda d: {"x": 1}, id="unreadable")])
@requires_db
def test_a_cache_row_of_another_place_is_deleted_and_recomputed(
    conn: Connection, change: Callable[[dict[str, Any]], dict[str, Any]]
) -> None:
    """A bad row is a miss, never data for the listing nor a reason to wait forever."""
    fake = FakeEarthEngine()
    live = live_service(conn, fake)
    poisoned = change(
        fake.compute(
            POLYGON, site_key=live_site_key(geometry_sha256(POLYGON)), checkpoint=lambda: None
        )
    )
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
    asset = asset_for(POLYGON)
    with pytest.raises(ToolFailed) as pending:  # the probe sees a miss, not metrics
        resolve_metrics(load_cached_metrics, asset, "baseline", False, live)
    assert pending.value.code == LIVE_METRICS_PENDING
    metrics = resolve_metrics(
        load_cached_metrics, asset, "baseline", False, live, compute_live=True
    )
    assert metrics.centroid.lat == pytest.approx(asset.centroid_lat or 0, abs=1e-3)
    assert live.cached(POLYGON) == metrics


def test_live_failures_fail_the_step_without_a_retry() -> None:
    for error, code in (
        (RuntimeError("Too many concurrent aggregations."), EARTH_ENGINE_ERROR),
        (TimeoutError("read timed out"), EARTH_ENGINE_TIMEOUT),  # a request's own deadline
    ):
        live = memory_service(FakeEarthEngine(fail=error))
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


@requires_db
def test_a_refund_removes_only_its_runs_row(session: Session) -> None:
    now, run_id = datetime(2026, 10, 19, 12, tzinfo=UTC), uuid4()
    reserve_live_rating(session, quota(uuid4()), now, run_id)
    reserve_live_rating(session, quota(uuid4()), now, uuid4())
    assert refund_live_rating(session, run_id) and not refund_live_rating(session, run_id)
    assert len(session.exec(select(LiveRatingRequest)).all()) == 1


# ----- the listing flow, end to end (DB) -------------------------------------------------------


@dataclass
class Live:
    """The live world (real accounts, password sessions) beside the lifecycle's sandbox."""

    w: World_
    community_id: UUID
    owner: User
    steward: User

    def client(self, user: User | None = None) -> TestClient:
        client = TestClient(app)
        session_token = start_session(self.w.session, user or self.steward, SessionKind.PASSWORD)
        client.cookies.set(SESSION_COOKIE, session_token)
        return client

    def draft(self, geometry: dict[str, Any] | None = None, user: User | None = None) -> str:
        body = lifecycle.body(
            self.w, community_id=str(self.community_id), geojson=geometry or square(800)
        )
        response = self.client(user).post("/assets", json=body)
        assert response.status_code == 201, response.text
        return str(response.json()["id"])

    def submit(self, asset_id: str, user: User | None = None) -> Any:
        return self.client(user).post(f"/assets/{asset_id}/submit")

    def run(self, run_id: str) -> dict[str, Any]:
        return dict(self.client().get(f"/runs/{run_id}").json())

    def detail(self, asset_id: str) -> dict[str, Any]:
        return dict(self.client().get(f"/assets/{asset_id}").json())


def go_live(w: World_, fake: FakeEarthEngine, **overrides: Any) -> LiveEarthObs:
    w.runner.settings = lifecycle._settings(use_mocks=False, **overrides)
    w.runner.live_metrics = LiveEarthObs(
        session_factory=w.runner.session_factory,
        client=fake,
        timeout_s=overrides.get("earth_engine_timeout_s", 5.0),
        max_area_ha=overrides.get("earth_engine_live_max_ha", 5_000.0),
    )
    return w.runner.live_metrics


def counted(w: World_) -> int:
    return int(w.session.exec(select(func.count()).select_from(LiveRatingRequest)).one())


@pytest.fixture
def live(world: World_) -> Live:
    world.session.execute(LiveRatingRequest.__table__.delete())  # type: ignore[attr-defined]
    world.session.execute(EarthObsCache.__table__.delete())  # type: ignore[attr-defined]
    owner = lifecycle._person(world.session, LIVE_WORLD_ID, "Live Owner")
    steward = lifecycle._person(world.session, LIVE_WORLD_ID, "Live Steward")
    community = create_community(
        world.session, LIVE_WORLD_ID, f"Live Stewards {uuid4().hex[:8]}", owner.id
    )
    world.session.commit()
    lifecycle._member(world.session, LIVE_WORLD_ID, community.id, steward)
    return Live(world, community.id, owner, steward)


@requires_db
def test_a_new_live_world_listing_is_rated_with_its_own_live_metrics(live: Live) -> None:
    w, fake = live.w, FakeEarthEngine()
    go_live(w, fake)
    asset_id = live.draft()
    run_id = live.submit(asset_id).json()["run_id"]
    assert counted(w) == 1 and fake.calls == []  # counted at submit, computed by the run
    w.executor.run_all()

    assert status_of(w, asset_id) == (AssetStatus.LISTED, None)
    run = live.run(run_id)
    assert run["status"] in {"succeeded", "degraded"}
    earth_obs = next(step for step in run["steps"] if step["step"] == "earth_obs")
    assert earth_obs["status"] == "ok"
    detail = live.detail(asset_id)
    assert detail["mock"] is False and detail["cached_example"] is None
    metrics = w.session.exec(
        select(Metrics)
        .join(Report, col(Report.metrics_id) == col(Metrics.id))
        .where(Report.asset_id == UUID(asset_id))
    ).one()
    assert metrics.data_version == LIVE_DATA_VERSION and len(fake.calls) == 1


@requires_db
def test_a_cached_polygon_is_free_and_a_third_live_rating_a_day_is_refused(live: Live) -> None:
    w = live.w
    service = go_live(w, FakeEarthEngine())
    first = live.draft(square(800))
    second = live.draft(square(800, lat=LAT + 0.05))
    third = live.draft(square(800, lat=LAT + 0.1))
    service.load(square(800, lat=LAT + 0.1))  # e.g. computed for an earlier listing
    assert live.submit(first).status_code == 202
    assert live.submit(second).status_code == 202
    assert counted(w) == 2
    assert live.submit(third).status_code == 202  # cached: not a live rating
    assert counted(w) == 2

    fourth = live.draft(square(800, lat=LAT + 0.15))
    refused = live.submit(fourth)
    assert (refused.status_code, refused.json()["detail"]) == (429, LIVE_RATING_QUOTA)
    assert 1 <= int(refused.headers["retry-after"]) <= 86_400
    assert status_of(w, fourth) == (AssetStatus.DRAFT, None)  # untouched
    other = live.draft(square(800, lat=LAT + 0.2), user=live.owner)
    assert live.submit(other, user=live.owner).status_code == 202  # quotas are per account


@requires_db
def test_the_global_daily_cap_refuses_live_ratings(live: Live) -> None:
    go_live(live.w, FakeEarthEngine(), live_ratings_global_per_day=1)
    assert live.submit(live.draft()).status_code == 202
    late = live.draft(square(800, lat=LAT + 0.1), user=live.owner)
    refused = live.submit(late, user=live.owner)
    assert (refused.status_code, refused.json()["detail"]) == (429, LIVE_RATING_GLOBAL_LIMIT)


@requires_db
def test_a_polygon_too_large_for_live_is_refused_at_submit(live: Live) -> None:
    w = live.w
    go_live(w, FakeEarthEngine(), earth_engine_live_max_ha=50.0)  # the draft is about 64 ha
    asset_id = live.draft()
    refused = live.submit(asset_id)
    assert (refused.status_code, refused.json()["detail"]) == (409, LIVE_AREA_TOO_LARGE)
    assert status_of(w, asset_id) == (AssetStatus.DRAFT, None) and counted(w) == 0


@requires_db
def test_a_failed_live_run_keeps_the_listing_in_rating_and_it_can_retry(live: Live) -> None:
    w, fake = live.w, FakeEarthEngine(fail=RuntimeError("Computation timed out."))
    go_live(w, fake)
    asset_id = live.draft()
    run_id = live.submit(asset_id).json()["run_id"]
    w.executor.run_all()

    run = live.run(run_id)
    assert run["status"] == "failed" and run["error"] == f"earth_obs_failed:{EARTH_ENGINE_ERROR}"
    reason = f"rating_failed:earth_obs_failed:{EARTH_ENGINE_ERROR}"
    assert status_of(w, asset_id) == (AssetStatus.RATING, reason)
    no_report = select(Report).where(Report.asset_id == UUID(asset_id))
    assert w.session.exec(no_report).first() is None
    assert live.detail(asset_id)["cached_example"] is None  # never in the live world
    assert len(fake.calls) == 1 and counted(w) == 1  # no retry inside the run; it computed

    cooling = live.submit(asset_id)
    assert (cooling.status_code, cooling.json()["detail"]) == (429, "resubmit_cooldown")
    age_submission(w, asset_id)
    fake.fail = None
    assert live.submit(asset_id).status_code == 202
    assert counted(w) == 2  # the retry is a live rating too
    w.executor.run_all()
    assert status_of(w, asset_id) == (AssetStatus.LISTED, None)
    assert transitions(w, asset_id) == ["create", "submit", "submit", None, "rated"]


@requires_db
def test_a_run_that_found_earth_engine_busy_gives_its_live_rating_back(live: Live) -> None:
    w = live.w
    service = go_live(w, FakeEarthEngine(), earth_engine_timeout_s=0.1)
    asset_id = live.draft()
    run_id = live.submit(asset_id).json()["run_id"]
    assert counted(w) == 1
    service._slots.acquire()  # another computation holds the only slot
    try:
        w.executor.run_all()
    finally:
        service._slots.release()
    assert live.run(run_id)["error"] == f"earth_obs_failed:{EARTH_ENGINE_BUSY}"
    assert status_of(w, asset_id)[0] is AssetStatus.RATING
    assert counted(w) == 0  # nothing was computed, so nothing is spent


@requires_db
def test_a_listing_waiting_for_metrics_can_retry_once_live_is_on(live: Live) -> None:
    w = live.w
    w.runner.settings = lifecycle._settings(use_mocks=False)  # live off, no mocks
    asset_id = live.draft()
    live.submit(asset_id)
    w.executor.run_all()
    assert status_of(w, asset_id) == (AssetStatus.RATING, NO_SATELLITE_METRICS)
    age_submission(w, asset_id)
    waiting = live.submit(asset_id)
    assert (waiting.status_code, waiting.json()["detail"]) == (409, "metrics_unavailable")

    go_live(w, FakeEarthEngine())
    assert live.submit(asset_id).status_code == 202
    w.executor.run_all()
    assert status_of(w, asset_id) == (AssetStatus.LISTED, None)


@requires_db
def test_a_live_listing_never_shows_another_sites_data(live: Live) -> None:
    w = live.w
    go_live(w, FakeEarthEngine(change=lambda d: {**d, "centroid": {"lat": 19.29, "lon": -99.1}}))
    asset_id = live.draft()
    run_id = live.submit(asset_id).json()["run_id"]
    w.executor.run_all()
    assert live.run(run_id)["error"] == f"earth_obs_failed:{EARTH_ENGINE_INVALID_OUTPUT}"
    assert status_of(w, asset_id)[0] is AssetStatus.RATING
    assert w.session.exec(select(Report).where(Report.asset_id == UUID(asset_id))).first() is None


# ----- demo worlds: never live, the "cached example" ----------------------------------------------


def test_distance_is_great_circle_kilometres() -> None:
    assert distance_km(0, 0, 0, 1) == pytest.approx(111.2, abs=0.1)
    assert distance_km(LAT, LON, LAT, LON) == 0


def test_the_live_world_never_shows_a_cached_example() -> None:
    waiting = Asset(
        world_id=LIVE_WORLD_ID,
        name="New",
        status=AssetStatus.RATING,
        status_reason=f"rating_failed:earth_obs_failed:{EARTH_ENGINE_TIMEOUT}",
        centroid_lat=LAT,
        centroid_lon=LON,
        geojson=POLYGON,
    )
    assert waiting_for_satellite_metrics(waiting)
    assert cached_example(cast(Session, None), waiting) is None  # no query at all


@requires_db
def test_a_demo_world_never_computes_and_shows_the_nearest_cached_example(
    live: Live,
) -> None:
    w, fake = live.w, FakeEarthEngine()
    go_live(w, fake)
    asset = draft(w)  # in the lifecycle's demo sandbox
    assert submit(w, asset["id"]).status_code == 202
    w.executor.run_all()

    assert fake.calls == [] and counted(w) == 0  # no Earth Engine, no quota
    assert status_of(w, asset["id"]) == (AssetStatus.RATING, NO_SATELLITE_METRICS)
    detail = client_as(w, w.steward).get(f"/assets/{asset['id']}").json()
    sites = w.session.exec(
        select(Asset).where(Asset.world_id == w.id, col(Asset.site_key).is_not(None))
    ).all()
    nearest = min(
        sites, key=lambda s: distance_km(LAT, LON, s.centroid_lat or 0, s.centroid_lon or 0)
    )
    example = detail["cached_example"]
    assert example["asset_id"] == str(nearest.id) and example["site_key"] == nearest.site_key
    assert example["notice"].startswith("Cached example:")
    assert "not this land" in example["notice"]
    assert detail["latest_report"] is None and detail["status"] == "rating"  # nothing borrowed
    age_submission(w, asset["id"])
    waiting = submit(w, asset["id"])
    assert (waiting.status_code, waiting.json()["detail"]) == (409, "metrics_unavailable")


@requires_db
def test_a_demo_world_reuses_a_polygon_already_computed(live: Live) -> None:
    w, fake = live.w, FakeEarthEngine()
    service = go_live(w, fake)
    service.load(square(1_200))  # the lifecycle's draft polygon, computed for the live world
    asset = draft(w)
    assert submit(w, asset["id"]).status_code == 202 and counted(w) == 0
    w.executor.run_all()
    assert status_of(w, asset["id"]) == (AssetStatus.LISTED, None) and len(fake.calls) == 1
    listed = client_as(w, w.steward).get(f"/assets/{asset['id']}").json()
    assert listed["cached_example"] is None


@requires_db
def test_a_tied_distance_picks_one_cached_example(world: World_) -> None:
    sites = world.session.exec(
        select(Asset).where(Asset.world_id == world.id, col(Asset.site_key).is_not(None))
    ).all()
    for site in sites:  # every demo site exactly 1 degree east or west of the listing
        site.centroid_lat = LAT
        site.centroid_lon = LON + (1 if site.site_key == sites[0].site_key else -1)
        world.session.add(site)
    world.session.commit()
    waiting = Asset(
        world_id=world.id,
        name="New",
        status=AssetStatus.RATING,
        status_reason=NO_SATELLITE_METRICS,
        centroid_lat=LAT,
        centroid_lon=LON,
        geojson=POLYGON,
    )
    example = cached_example(world.session, waiting)
    assert example is not None and example.site_key in {s.site_key for s in sites}

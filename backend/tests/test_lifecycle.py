"""Listing lifecycle (T58): the pure state machine, the listing service and the API."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from functools import partial
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, delete
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import Session, col, select

from app import events as event_bus
from app.agents.document_check import MockDocumentLLM
from app.auth import SESSION_COOKIE, start_session
from app.communities import create_community
from app.config import Settings, get_settings, validate_mock_settings
from app.db import get_session
from app.ledger import verify
from app.main import app
from app.models import (
    Asset,
    AssetStatus,
    Community,
    CommunityMember,
    CommunityRole,
    Event,
    EventSource,
    FieldPhoto,
    LedgerEntry,
    LedgerKind,
    Report,
    SessionKind,
    StreamEventType,
    User,
    UserKind,
    UserRole,
    WorldEvent,
)
from app.models import World as WorldRow
from app.routers.runs import get_rating_runner
from app.sandbox import _delete_world_rows, create_world, ensure_live_world, reset_world
from app.seed import seed
from app.services import listings
from app.services.document_check import DocumentChecker, get_document_checker
from app.services.ipo import NOT_TRADING
from app.services.lifecycle import (
    EVIDENCE_REQUIRED,
    METRICS_UNAVAILABLE,
    NO_SATELLITE_METRICS,
    GateResult,
    ListingEvent,
    SuspensionReason,
    Transition,
    TransitionRefused,
    cooldown_remaining,
    created,
    gate_from_report,
    gate_outcome,
    is_newer_data_version,
    is_public,
    transition,
)
from app.services.listings import (
    RATING_STALE,
    RESUBMIT_COOLDOWN,
    ListingDetails,
    ListingLimitReached,
    ListingSubmit,
    apply_rating_result,
    create_draft,
    has_new_evidence,
    overlap_candidates,
    suspend,
    update_draft,
)
from app.services.rating_runs import AssetInfo, AssetNotRateable, RatingRunner, news_runner
from app.tools.earth_obs import (
    Centroid,
    DateWindow,
    EarthObsMetrics,
    ScenarioName,
    load_site_metrics,
    mock_listing_metrics,
)
from app.tools.geometry import (
    MAX_VERTICES,
    THUMBNAIL_OUTLINE_MAX_POINTS,
    geometry_bbox,
    geometry_sha256,
)
from app.tools.scoring import GATE_CONFIDENCE_BELOW_70, GATE_FOREST_LOSS, GATE_GRADE_BELOW_C
from app.worlds import LIVE_WORLD_ID
from tests.conftest import alembic_cfg, requires_db
from tests.test_geometry import circle as geometry_circle
from tests.test_geometry import square as geometry_square

S = AssetStatus
E = ListingEvent
PASSED = GateResult(passed=True)
LOW_CONFIDENCE = GateResult(passed=False, reasons=(GATE_CONFIDENCE_BELOW_70,))
LOW_GRADE = GateResult(passed=False, reasons=(GATE_CONFIDENCE_BELOW_70, GATE_GRADE_BELOW_C))
FOREST_LOSS = GateResult(passed=False, reasons=(GATE_FOREST_LOSS,))

# ----- the pure state machine -------------------------------------------------------------------


def test_a_listing_is_created_as_a_draft() -> None:
    assert created() == Transition(E.CREATE, None, S.DRAFT)


@pytest.mark.parametrize(
    ("current", "event", "kwargs", "expected", "reason"),
    [
        (S.DRAFT, E.EDIT, {}, S.DRAFT, None),
        (S.DRAFT, E.SUBMIT, {}, S.RATING, None),
        (S.RATING, E.SUBMIT, {}, S.RATING, None),  # retry after a failed run
        (S.NEEDS_EVIDENCE, E.SUBMIT, {"has_new_evidence": True}, S.RATING, None),
        (S.NEEDS_EVIDENCE, E.SUBMIT, {"has_newer_metrics": True}, S.RATING, None),
        (
            S.RATING,
            E.SUBMIT,
            {"current_reason": NO_SATELLITE_METRICS, "metrics_available": True},
            S.RATING,
            None,
        ),
        (S.NEEDS_EVIDENCE, E.REVISE, {}, S.DRAFT, None),
        (S.RATING, E.REVISE, {}, S.DRAFT, None),
        (S.DRAFT, E.WITHDRAW, {}, S.WITHDRAWN, None),
        (S.RATING, E.WITHDRAW, {}, S.WITHDRAWN, None),
        (S.NEEDS_EVIDENCE, E.WITHDRAW, {}, S.WITHDRAWN, None),
        (S.RATING, E.RATED, {"gate": PASSED}, S.LISTED, None),
        (S.RATING, E.RATED, {"gate": LOW_CONFIDENCE}, S.NEEDS_EVIDENCE, "confidence_below_70"),
        (
            S.RATING,
            E.RATED,
            {"gate": LOW_GRADE},
            S.INELIGIBLE,
            f"{GATE_CONFIDENCE_BELOW_70},{GATE_GRADE_BELOW_C}",
        ),
        (S.RATING, E.RATED, {"gate": FOREST_LOSS}, S.INELIGIBLE, GATE_FOREST_LOSS),
        (
            S.LISTED,
            E.SUSPEND,
            {"suspension": SuspensionReason.MODERATION},
            S.SUSPENDED,
            "moderation",
        ),
        (S.SUSPENDED, E.RESUME, {}, S.LISTED, None),
    ],
)
def test_allowed_transitions(
    current: AssetStatus,
    event: ListingEvent,
    kwargs: dict[str, object],
    expected: AssetStatus,
    reason: str | None,
) -> None:
    assert transition(current, event, **kwargs) == Transition(  # type: ignore[arg-type]
        event, current, expected, reason
    )


ALLOWED = {
    (S.DRAFT, E.EDIT),
    (S.DRAFT, E.SUBMIT),
    (S.RATING, E.SUBMIT),
    (S.NEEDS_EVIDENCE, E.SUBMIT),
    (S.RATING, E.RATED),
    (S.LISTED, E.SUSPEND),
    (S.SUSPENDED, E.RESUME),
    (S.NEEDS_EVIDENCE, E.REVISE),
    (S.RATING, E.REVISE),
    (S.DRAFT, E.WITHDRAW),
    (S.RATING, E.WITHDRAW),
    (S.NEEDS_EVIDENCE, E.WITHDRAW),
}


@pytest.mark.parametrize(
    ("current", "event"),
    [
        (status, event)
        for status in AssetStatus
        for event in ListingEvent
        if event is not E.CREATE and (status, event) not in ALLOWED
    ],
)
def test_every_other_transition_is_refused_with_a_reason(
    current: AssetStatus, event: ListingEvent
) -> None:
    with pytest.raises(TransitionRefused) as exc:
        transition(current, event, gate=PASSED, suspension=SuspensionReason.MODERATION)
    assert exc.value.code == f"cannot_{event.value}_{current.value}"


def test_resubmitting_needs_new_evidence_or_newer_data() -> None:
    with pytest.raises(TransitionRefused) as exc:
        transition(S.NEEDS_EVIDENCE, E.SUBMIT)
    assert exc.value.code == EVIDENCE_REQUIRED


def test_a_retry_waits_for_metrics_that_still_dont_exist() -> None:
    with pytest.raises(TransitionRefused) as exc:
        transition(S.RATING, E.SUBMIT, current_reason=NO_SATELLITE_METRICS, metrics_available=False)
    assert exc.value.code == METRICS_UNAVAILABLE
    # A run that failed for another reason may be retried.
    retry = transition(
        S.RATING, E.SUBMIT, current_reason="rating_failed:x", metrics_available=False
    )
    assert retry.to_status is S.RATING


@pytest.mark.parametrize(
    ("candidate", "current", "newer"),
    [
        ("2026Q4", "2026Q3", True),
        ("2026Q3", "2026Q3", False),
        ("2026Q2", "2026Q3", False),
        ("mock-2026Q4", "mock-2026Q3", True),
        ("mock-2026Q4", "2026Q3", False),
        ("2026Q4", "mock-2026Q3", False),
        ("sim-2", "sim-1", False),
        (None, "2026Q3", False),
        ("2026Q4", None, False),
    ],
)
def test_newer_data_versions(candidate: str | None, current: str | None, newer: bool) -> None:
    assert is_newer_data_version(candidate, current) is newer


def test_cooldown_remaining() -> None:
    now = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
    ten = timedelta(minutes=10)
    assert cooldown_remaining(None, now, ten) == 0
    assert cooldown_remaining(now - timedelta(minutes=4), now, ten) == 360
    assert cooldown_remaining(now - timedelta(minutes=4, seconds=0.5), now, ten) == 360
    assert cooldown_remaining(now - ten, now, ten) == 0


@pytest.mark.parametrize("status", [S.LISTED, S.SUSPENDED])
@pytest.mark.parametrize("gate", [LOW_CONFIDENCE, LOW_GRADE, FOREST_LOSS])
def test_the_gate_applies_at_listing_time_only(status: AssetStatus, gate: GateResult) -> None:
    """A re-rate of a listed asset never delists or suspends it (T13 note under T38)."""
    with pytest.raises(TransitionRefused):
        transition(status, E.RATED, gate=gate)


def test_creation_and_missing_inputs_are_programming_errors() -> None:
    with pytest.raises(ValueError, match="created"):
        transition(S.DRAFT, E.CREATE)
    with pytest.raises(ValueError, match="gate"):
        transition(S.RATING, E.RATED)
    with pytest.raises(ValueError, match="reason"):
        transition(S.LISTED, E.SUSPEND)


def test_gate_outcome_sorts_failures_into_needs_evidence_or_ineligible() -> None:
    assert gate_outcome(PASSED) == (S.LISTED, None)
    assert gate_outcome(LOW_CONFIDENCE) == (S.NEEDS_EVIDENCE, GATE_CONFIDENCE_BELOW_70)
    assert gate_outcome(FOREST_LOSS) == (S.INELIGIBLE, GATE_FOREST_LOSS)


def test_gate_result_is_consistent() -> None:
    with pytest.raises(ValueError):
        GateResult(passed=True, reasons=(GATE_GRADE_BELOW_C,))
    with pytest.raises(ValueError):
        GateResult(passed=False)
    with pytest.raises(ValueError, match="unknown"):
        GateResult(passed=False, reasons=("made_up",))


def test_gate_is_read_from_the_sealed_report_snapshot() -> None:
    snapshot = {"rating": {"score": {"gate": {"passed": False, "reasons": [GATE_GRADE_BELOW_C]}}}}
    assert gate_from_report(snapshot) == GateResult(False, (GATE_GRADE_BELOW_C,))
    for broken in (
        None,
        {},
        {"rating": {"score": {}}},
        {"rating": {"score": {"gate": {"passed": "yes", "reasons": []}}}},
        {"rating": {"score": {"gate": {"passed": False, "reasons": [1]}}}},
        {"rating": {"score": {"gate": {"passed": True, "reasons": ["grade_below_c"]}}}},
    ):
        with pytest.raises(ValueError):
            gate_from_report(broken)


def test_only_listed_and_suspended_assets_are_public() -> None:
    assert {status for status in AssetStatus if is_public(status)} == {S.LISTED, S.SUSPENDED}


# ----- the service and the API (DB) ---------------------------------------------------------------

LAT, LON = 9.9, -84.1  # far from every curated site


@pytest.fixture
def conn() -> Iterator[Connection]:
    """One connection whose outer transaction is rolled back: nothing a test writes persists."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        outer = connection.begin()
        yield connection
        outer.rollback()
    engine.dispose()


def _sessions(conn: Connection) -> Callable[[], Session]:
    return lambda: Session(bind=conn, join_transaction_mode="create_savepoint")


class Deferred(Executor):
    """Keeps run jobs until `run_all`, so a test controls when a run executes."""

    def __init__(self) -> None:
        self.jobs: list[Callable[[], Any]] = []

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        self.jobs.append(partial(fn, *args, **kwargs))
        return Future()

    def run_all(self) -> None:
        jobs, self.jobs = self.jobs, []
        for job in jobs:
            job()


def _settings(**overrides: Any) -> Settings:
    return Settings(_env_file=None, **{"use_mocks": True, **overrides})  # type: ignore[arg-type]


def _runner(session_factory: Callable[[], Session], **overrides: Any) -> RatingRunner:
    cfg = _settings(**overrides)
    return RatingRunner(
        session_factory=session_factory,
        settings=cfg,
        executor=Deferred(),
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: date(2026, 10, 18),
    )


def _checker(session_factory: Callable[[], Session], **overrides: Any) -> DocumentChecker:
    """The AI document check (T71) with the mock model; its jobs wait for `executor.run_all`."""
    return DocumentChecker(
        session_factory=session_factory,
        settings=_settings(**overrides),
        executor=Deferred(),
        llm_factory=MockDocumentLLM,
    )


def _person(
    session: Session, world_id: UUID, name: str, role: UserRole = UserRole.INVESTOR
) -> User:
    user = User(
        world_id=world_id,
        name=name,
        role=role,
        kind=UserKind.PERSON,
        is_admin=role is UserRole.ADMIN,
    )
    session.add(user)
    session.commit()
    return user


def _member(session: Session, world_id: UUID, community_id: UUID, user: User) -> None:
    session.add(
        CommunityMember(
            community_id=community_id,
            user_id=user.id,
            world_id=world_id,
            role=CommunityRole.STEWARD,
        )
    )
    session.commit()


@dataclass
class World_:
    id: UUID
    community_id: UUID
    other_community_id: UUID
    owner: User
    steward: User
    outsider: User
    other_steward: User
    admin: User
    session: Session
    runner: RatingRunner
    executor: Deferred
    checker: DocumentChecker


@pytest.fixture
def world(conn: Connection) -> Iterator[World_]:
    """A sandbox world with a community (owner + steward), a second community with its own
    steward, an outsider and an admin."""
    session = _sessions(conn)()
    seed(session)
    ensure_live_world(session)  # anonymous visitors read the live world (T73)
    sandbox = create_world(session)
    owner = _person(session, sandbox.id, "Owner")
    steward = _person(session, sandbox.id, "Steward")
    outsider = _person(session, sandbox.id, "Outsider")
    other_steward = _person(session, sandbox.id, "Other Steward")
    admin = _person(session, sandbox.id, "Admin", UserRole.ADMIN)
    community = create_community(session, sandbox.id, "Bosque Vivo Stewards", owner.id)
    other = create_community(session, sandbox.id, "Río Claro Keepers", other_steward.id)
    session.commit()
    _member(session, sandbox.id, community.id, steward)
    runner = _runner(_sessions(conn))
    assert isinstance(runner.executor, Deferred)
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_settings] = lambda: _settings()
    app.dependency_overrides[get_rating_runner] = lambda: runner
    checker = _checker(_sessions(conn))
    app.dependency_overrides[get_document_checker] = lambda: checker
    yield World_(
        sandbox.id,
        community.id,
        other.id,
        owner,
        steward,
        outsider,
        other_steward,
        admin,
        session,
        runner,
        runner.executor,
        checker,
    )
    app.dependency_overrides.clear()
    session.close()


def client_as(w: World_, user: User | None) -> TestClient:
    """A client signed in as `user` in the world's sandbox (None: anonymous, so the live
    world)."""
    client = TestClient(app)  # the world comes from the session (T73)
    if user is not None:
        client.cookies.set(SESSION_COOKIE, start_session(w.session, user, SessionKind.DEMO))
    return client


def square(side_m: float, lat: float = LAT, lon: float = LON) -> dict[str, Any]:
    return geometry_square(side_m, lat=lat, lon=lon)


def body(w: World_, **overrides: Any) -> dict[str, Any]:
    return {
        "community_id": str(w.community_id),
        "name": "Bosque Vivo",
        "country": "cr",
        "description": "Cloud forest kept by the community.",
        "geojson": {"type": "Feature", "properties": {"owner": "Ada"}, "geometry": square(1_200)},
        "attestation": True,
        **overrides,
    }


def draft(w: World_, user: User | None = None, **overrides: Any) -> dict[str, Any]:
    response = client_as(w, user or w.steward).post("/assets", json=body(w, **overrides))
    assert response.status_code == 201, response.text
    return dict(response.json())


def listing_entries(w: World_, asset_id: str | UUID) -> list[LedgerEntry]:
    w.session.expire_all()
    return list(
        w.session.exec(
            select(LedgerEntry)
            .where(LedgerEntry.asset_id == UUID(str(asset_id)))
            .order_by(col(LedgerEntry.seq))
        ).all()
    )


def transitions(w: World_, asset_id: str | UUID) -> list[str | None]:
    return [e.payload.get("transition") for e in listing_entries(w, asset_id)]


def listing_events(w: World_, asset_id: str | UUID) -> list[WorldEvent]:
    rows = w.session.exec(
        select(WorldEvent)
        .where(WorldEvent.world_id == w.id, WorldEvent.type == StreamEventType.LISTING_STATUS)
        .order_by(col(WorldEvent.id))
    ).all()
    return [row for row in rows if row.payload["asset_id"] == str(asset_id)]


def status_of(w: World_, asset_id: str | UUID) -> tuple[AssetStatus, str | None]:
    w.session.expire_all()
    asset = w.session.get_one(Asset, UUID(str(asset_id)))
    return asset.status, asset.status_reason


def submit(w: World_, asset_id: str | UUID, user: User | None = None) -> Any:
    return client_as(w, user or w.steward).post(f"/assets/{asset_id}/submit")


def age_submission(w: World_, asset_id: str | UUID) -> None:
    """Move the last submit past the resubmit cooldown."""
    asset = w.session.get_one(Asset, UUID(str(asset_id)))
    assert asset.submitted_at is not None
    asset.submitted_at -= RESUBMIT_COOLDOWN
    w.session.add(asset)
    w.session.commit()


def curated(w: World_, key: str = "wetland_mx") -> Asset:
    return w.session.exec(select(Asset).where(Asset.world_id == w.id, Asset.site_key == key)).one()


def _stale(metrics: EarthObsMetrics) -> EarthObsMetrics:
    """Observed 6 months before the rating date: recency halves, confidence drops below 70."""
    old = DateWindow(start="2021-04-01", end="2026-04-01")
    return metrics.model_copy(update={"date_windows": {**metrics.date_windows, "ndvi": old}})


def _deforested(metrics: EarthObsMetrics) -> EarthObsMetrics:
    return metrics.model_copy(update={"forest_loss_last_12m_ha": 20.0, "forest_loss_ha": 20.0})


def _loader(change: Callable[[EarthObsMetrics], EarthObsMetrics]) -> Any:
    """A metrics loader for new polygons: mock metrics of the asset, then `change`."""

    def load(asset: AssetInfo, _scenario: ScenarioName) -> EarthObsMetrics:
        if asset.area_ha is None or asset.centroid_lat is None or asset.centroid_lon is None:
            raise AssertionError("a listing always has an area and a centroid")
        return change(
            mock_listing_metrics(
                area_ha=asset.area_ha,
                centroid_lat=asset.centroid_lat,
                centroid_lon=asset.centroid_lon,
            )
        )

    return load


def needs_evidence(w: World_) -> dict[str, Any]:
    """A draft submitted and rated into `needs_evidence` (stale data, confidence < 70)."""
    saved = w.runner.metrics_loader
    w.runner.metrics_loader = _loader(_stale)
    asset = draft(w)
    assert submit(w, asset["id"]).status_code == 202
    w.executor.run_all()
    w.runner.metrics_loader = saved
    assert status_of(w, asset["id"]) == (AssetStatus.NEEDS_EVIDENCE, GATE_CONFIDENCE_BELOW_70)
    return asset


# --- create --------------------------------------------------------------------------------------


@requires_db
def test_a_steward_creates_a_private_attested_draft(world: World_) -> None:
    created_at = datetime.now(UTC)
    asset = draft(world)

    assert asset["status"] == "draft" and asset["status_reason"] is None
    assert asset["community_id"] == str(world.community_id)
    assert asset["name"] == "Bosque Vivo" and asset["country"] == "CR"
    assert asset["geojson"] == square(1_200)  # Feature properties dropped
    assert 140 < float(asset["area_ha"]) < 150
    assert asset["latest_report"] is None and asset["price"] is None and asset["mock"] is False
    row = world.session.get_one(Asset, UUID(asset["id"]))
    assert row.attested_at is not None and row.attested_at >= created_at
    assert row.bbox_west == pytest.approx(LON) and row.bbox_south == pytest.approx(LAT)
    community = world.session.get_one(Community, world.community_id)
    assert row.community_user_id == community.treasury_user_id

    [entry] = listing_entries(world, asset["id"])
    assert entry.kind is LedgerKind.LISTING
    assert entry.payload["transition"] == "create" and entry.payload["to"] == "draft"
    assert "geojson" not in entry.payload  # only a commitment until submit
    assert entry.payload["geometry_sha256"] == geometry_sha256(square(1_200))
    assert entry.payload["name"] == "Bosque Vivo"
    assert "description" not in entry.payload and entry.payload["description_sha256"]
    [event] = listing_events(world, asset["id"])
    assert event.audience_community_id == world.community_id
    assert event.payload == {
        "asset_id": asset["id"],
        "community_id": str(world.community_id),
        "transition": "create",
        "from": None,
        "to": "draft",
        "reason": None,
    }


@requires_db
def test_drafts_are_visible_to_their_community_only(world: World_) -> None:
    asset = draft(world)
    path = f"/assets/{asset['id']}"

    for user in (world.owner, world.steward, world.admin):
        client = client_as(world, user)
        assert client.get(path).status_code == 200
        assert client.get(f"{path}/reports").status_code == 200
        assert client.get(f"/ledger/{asset['id']}").status_code == 200
        mine = client.get(f"/communities/{world.community_id}/assets")
        assert [card["id"] for card in mine.json()] == [asset["id"]]
        assert mine.json()[0]["status"] == "draft"
        assert mine.headers["cache-control"] == "private, no-store"
    for user in (world.outsider, world.other_steward, None):
        client = client_as(world, user)
        assert client.get(path).status_code == 404
        assert client.get(f"{path}/prices").status_code == 404
        assert client.get(f"/ledger/{asset['id']}").status_code == 404
        assert client.get(f"/ledger/{asset['id']}/verify").status_code == 404
    assert client_as(world, world.outsider).get(
        f"/communities/{world.community_id}/assets"
    ).json() == {"detail": "members_only"}
    marketplace = client_as(world, world.steward).get("/assets").json()
    assert asset["id"] not in [card["id"] for card in marketplace]
    assert {card["status"] for card in marketplace} == {"listed"}
    world_assets = client_as(world, world.steward).get("/world").json()["assets"]
    assert asset["id"] not in [a["id"] for a in world_assets]


@requires_db
@pytest.mark.parametrize(
    ("who", "status_code", "detail"),
    [
        ("outsider", 403, "members_only"),
        ("other_steward", 403, "members_only"),
        ("admin", 403, "members_only"),
        (None, 401, "auth_required"),
    ],
)
def test_only_owners_and_stewards_create_listings(
    world: World_, who: str | None, status_code: int, detail: str
) -> None:
    user = getattr(world, who) if who else None
    response = client_as(world, user).post("/assets", json=body(world))
    assert (response.status_code, response.json()["detail"]) == (status_code, detail)
    draft(world, world.owner)  # the owner may


@requires_db
def test_a_community_in_another_world_is_not_found(world: World_) -> None:
    live = world.session.exec(select(Community.id).where(Community.world_id == LIVE_WORLD_ID))
    for community in (live.first() or uuid4(), uuid4()):
        response = client_as(world, world.steward).post(
            "/assets", json=body(world, community_id=str(community))
        )
        assert response.status_code == 404


@requires_db
def test_attestation_is_required(world: World_) -> None:
    client = client_as(world, world.steward)
    refused = client.post("/assets", json=body(world, attestation=False))
    assert refused.status_code == 422
    assert "right to list this land" in refused.text
    missing = body(world)
    del missing["attestation"]
    assert client.post("/assets", json=missing).status_code == 422


@requires_db
def test_the_polygon_is_validated_and_every_problem_reported(world: World_) -> None:
    client = client_as(world, world.steward)
    tiny = client.post("/assets", json=body(world, geojson=square(100)))
    assert tiny.status_code == 422
    assert [p["type"] for p in tiny.json()["detail"]] == ["polygon.too_small"]
    assert tiny.json()["detail"][0]["loc"] == ["body", "geojson"]
    ring = [[LON, LAT], [LON + 0.01, LAT + 0.01], [LON + 0.01, LAT], [LON, LAT + 0.01], [LON, LAT]]
    bow_tie = {"type": "Polygon", "coordinates": [ring]}
    crossing = client.post("/assets", json=body(world, geojson=bow_tie))
    assert [p["type"] for p in crossing.json()["detail"]] == ["polygon.self_intersection"]
    assert client.post("/assets", json=body(world, geojson={"type": "Point"})).status_code == 422
    corner = square(1_000)["coordinates"][0]
    huge = {"type": "Polygon", "coordinates": [corner[:1] * (MAX_VERTICES + 1) + corner]}
    too_complex = client.post("/assets", json=body(world, geojson=huge))
    assert too_complex.status_code == 422
    assert [p["type"] for p in too_complex.json()["detail"]] == ["polygon.too_complex"]
    assert not client.get(f"/communities/{world.community_id}/assets").json()


@requires_db
def test_submitted_listings_and_own_drafts_claim_land(world: World_) -> None:
    client = client_as(world, world.steward)
    on_curated = client.post("/assets", json=body(world, geojson=curated(world).geojson))
    assert [p["type"] for p in on_curated.json()["detail"]] == ["polygon.overlap"]
    assert str(curated(world).id) not in on_curated.text  # never names the other listing

    first = draft(world)
    own = client.post("/assets", json=body(world, geojson=square(1_000)))
    assert [p["type"] for p in own.json()["detail"]] == ["polygon.overlap"]

    # Another community's draft claims nothing and stays private.
    theirs = client_as(world, world.other_steward).post(
        "/assets",
        json=body(world, community_id=str(world.other_community_id), geojson=square(1_000)),
    )
    assert theirs.status_code == 201, theirs.text

    # The first one submitted wins.
    assert submit(world, first["id"]).status_code == 202
    late = submit(world, theirs.json()["id"], world.other_steward)
    assert (late.status_code, late.json()["detail"]) == (409, "overlap")
    assert status_of(world, theirs.json()["id"]) == (AssetStatus.DRAFT, None)
    # Now the submitted listing blocks new drafts of any community.
    blocked = client_as(world, world.other_steward).post(
        "/assets",
        json=body(world, community_id=str(world.other_community_id), geojson=square(900)),
    )
    assert [p["type"] for p in blocked.json()["detail"]] == ["polygon.overlap"]


@requires_db
def test_a_community_has_a_limit_of_open_listings(world: World_) -> None:
    ids = [draft(world, geojson=square(400, lat=LAT + i * 0.01))["id"] for i in range(10)]
    over = client_as(world, world.steward).post(
        "/assets", json=body(world, geojson=square(400, lat=LAT + 0.5))
    )
    assert (over.status_code, over.json()["detail"]) == (409, "listing_limit_reached")
    # Withdrawing frees a slot.
    assert client_as(world, world.owner).post(f"/assets/{ids[0]}/withdraw").status_code == 200
    draft(world, geojson=square(400, lat=LAT + 0.5))


# --- edit ----------------------------------------------------------------------------------------


@requires_db
def test_a_draft_can_be_edited_and_each_edit_is_in_the_ledger(world: World_) -> None:
    asset = draft(world)
    client = client_as(world, world.owner)
    edited = client.patch(
        f"/assets/{asset['id']}",
        json={"name": "Bosque Vivo Norte", "description": None, "geojson": square(900)},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["name"] == "Bosque Vivo Norte"
    assert edited.json()["description"] is None
    assert float(edited.json()["area_ha"]) < 100
    # The draft's own old area doesn't count as an overlap.
    moved = client.patch(f"/assets/{asset['id']}", json={"geojson": square(1_000)})
    assert moved.status_code == 200

    entries = listing_entries(world, asset["id"])
    assert [e.payload["transition"] for e in entries] == ["create", "edit", "edit"]
    assert entries[1].payload["name"] == "Bosque Vivo Norte"
    assert entries[1].payload["description_sha256"] is None
    assert entries[2].payload["geometry_sha256"] == geometry_sha256(square(1_000))
    assert all("geojson" not in e.payload for e in entries)

    bad = client.patch(f"/assets/{asset['id']}", json={"geojson": square(50)})
    assert [p["type"] for p in bad.json()["detail"]] == ["polygon.too_small"]
    assert client.patch(f"/assets/{asset['id']}", json={"name": None}).status_code == 422
    assert client.patch(f"/assets/{asset['id']}", json={"total_shares": 5}).status_code == 422
    outsider = client_as(world, world.outsider).patch(
        f"/assets/{asset['id']}", json={"name": "Mine"}
    )
    assert (outsider.status_code, outsider.json()["detail"]) == (404, "not_found")  # hidden (T57)


@requires_db
def test_an_edit_that_changes_nothing_writes_nothing(world: World_) -> None:
    asset = draft(world)
    client = client_as(world, world.steward)
    for change in ({}, {"name": "Bosque Vivo"}, {"geojson": square(1_200), "country": "CR"}):
        response = client.patch(f"/assets/{asset['id']}", json=change)
        assert (response.status_code, response.json()["detail"]) == (400, "no_changes")
    assert transitions(world, asset["id"]) == ["create"]


@requires_db
def test_edits_are_rate_limited_per_listing(world: World_, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(listings, "MAX_EDITS_PER_WINDOW", 2)
    asset = draft(world)
    client = client_as(world, world.steward)
    for name in ("Bosque Uno", "Bosque Dos"):
        assert client.patch(f"/assets/{asset['id']}", json={"name": name}).status_code == 200
    limited = client.patch(f"/assets/{asset['id']}", json={"name": "Bosque Tres"})
    assert (limited.status_code, limited.json()["detail"]) == (429, "edit_rate_limited")
    assert 1 <= int(limited.headers["retry-after"]) <= 3600
    assert transitions(world, asset["id"]) == ["create", "edit", "edit"]


@requires_db
def test_only_drafts_can_be_edited(world: World_) -> None:
    asset = draft(world)
    assert submit(world, asset["id"]).status_code == 202
    refused = client_as(world, world.steward).patch(f"/assets/{asset['id']}", json={"name": "X Y"})
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_edit_rating")


# --- submit and the rating result ----------------------------------------------------------------


@requires_db
def test_submit_rates_the_listing_and_the_gate_lists_it(world: World_) -> None:
    asset = draft(world)
    response = submit(world, asset["id"])

    assert response.status_code == 202, response.text
    run_id = response.json()["run_id"]
    assert response.json() == {"asset_id": asset["id"], "run_id": run_id, "status": "rating"}
    assert response.headers["location"] == f"/runs/{run_id}"
    assert status_of(world, asset["id"]) == (AssetStatus.RATING, None)
    again = submit(world, asset["id"])
    assert (again.status_code, again.json()["detail"]) == (409, "run_in_progress")

    world.executor.run_all()

    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)
    client = client_as(world, world.outsider)
    detail = client.get(f"/assets/{asset['id']}").json()
    report = detail["latest_report"]
    assert report["version"] == 1 and report["run_id"] == run_id
    assert report["data_version"].startswith("mock-")
    assert "mock_metrics" in [flag["type"] for flag in report["flags"]]
    assert detail["mock"] is True
    card = next(c for c in client.get("/assets").json() if c["id"] == asset["id"])
    assert card["mock"] is True
    assert all(not c["mock"] for c in client.get("/assets").json() if c["id"] != asset["id"])
    run = client.get(f"/runs/{run_id}").json()  # public now
    assert run["trigger"] == "listing" and run["status"] in {"succeeded", "degraded"}

    entries = listing_entries(world, asset["id"])
    assert [(e.kind.value, e.payload.get("transition")) for e in entries] == [
        ("listing", "create"),
        ("listing", "submit"),
        ("report", None),
        ("listing", "rated"),
    ]
    rated = entries[-1]
    assert rated.ref_id == UUID(report["id"])
    assert rated.payload["gate"] == {"passed": True, "reasons": []}
    assert rated.payload["run_id"] == run_id and rated.payload["report_version"] == 1
    submitted = entries[1].payload
    assert submitted["geojson"] == square(1_200)  # the full geometry, once, at submit
    assert submitted["geometry_sha256"] == geometry_sha256(square(1_200))
    assert (submitted["from"], submitted["to"], submitted["run_id"]) == ("draft", "rating", run_id)
    assert verify(entries).valid
    events = listing_events(world, asset["id"])
    assert [(e.payload["transition"], e.payload["to"]) for e in events] == [
        ("create", "draft"),
        ("submit", "rating"),
        ("rated", "listed"),
    ]
    scopes = [e.audience_community_id for e in events]
    assert scopes == [world.community_id, world.community_id, None]  # public once listed
    # Listed but no IPO yet (T59): no price, so it can't be traded.
    assert detail["price"] is None
    order = client.post("/orders", json={"asset_id": asset["id"], "side": "buy", "qty": 1})
    assert order.status_code in (401, 409)


@requires_db
def test_without_metrics_for_the_polygon_the_listing_waits_in_rating(world: World_) -> None:
    """The T60 seam: no cached metrics and no mocks → the run fails, nothing borrowed, and a
    retry is refused until metrics exist (and then only after the cooldown)."""
    world.runner.settings = _settings(use_mocks=False)
    asset = draft(world)
    run_id = submit(world, asset["id"]).json()["run_id"]
    world.executor.run_all()

    assert status_of(world, asset["id"]) == (AssetStatus.RATING, NO_SATELLITE_METRICS)
    run = client_as(world, world.steward).get(f"/runs/{run_id}").json()
    assert run["status"] == "failed" and run["error"] == "earth_obs_failed:no_cached_metrics"
    no_report = select(Report).where(Report.asset_id == UUID(asset["id"]))
    assert world.session.exec(no_report).first() is None
    detail = client_as(world, world.owner).get(f"/assets/{asset['id']}").json()
    assert detail["status"] == "rating" and detail["status_reason"] == NO_SATELLITE_METRICS
    assert client_as(world, world.outsider).get(f"/assets/{asset['id']}").status_code == 404
    [*_, failed] = listing_events(world, asset["id"])
    assert failed.payload["transition"] == "rating_failed"
    assert failed.payload["reason"] == NO_SATELLITE_METRICS
    assert failed.audience_community_id == world.community_id

    age_submission(world, asset["id"])
    waiting = submit(world, asset["id"])
    assert (waiting.status_code, waiting.json()["detail"]) == (409, "metrics_unavailable")

    world.runner.settings = _settings()  # metrics exist now (mocks back on)
    world.session.get_one(Asset, UUID(asset["id"])).submitted_at = datetime.now(UTC)
    world.session.commit()
    cooling = submit(world, asset["id"])
    assert (cooling.status_code, cooling.json()["detail"]) == (429, "resubmit_cooldown")
    assert 1 <= int(cooling.headers["retry-after"]) <= 600

    age_submission(world, asset["id"])
    assert submit(world, asset["id"]).status_code == 202
    assert status_of(world, asset["id"]) == (AssetStatus.RATING, None)
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)
    assert transitions(world, asset["id"]) == ["create", "submit", "submit", None, "rated"]


@requires_db
def test_a_listing_whose_run_died_shows_it_is_stuck(world: World_) -> None:
    asset = draft(world)
    row = world.session.get_one(Asset, UUID(asset["id"]))
    row.status = AssetStatus.RATING  # as if its run's worker had crashed with no trace
    world.session.commit()
    detail = client_as(world, world.steward).get(f"/assets/{asset['id']}").json()
    assert detail["status_reason"] == RATING_STALE
    card = client_as(world, world.steward).get(f"/communities/{world.community_id}/assets")
    assert card.json()[0]["status_reason"] == RATING_STALE


@requires_db
@pytest.mark.parametrize(
    "change",
    [
        pytest.param(lambda _m: load_site_metrics("wetland_mx"), id="curated-site"),
        pytest.param(
            lambda m: m.model_copy(update={"centroid": Centroid(lat=LAT + 1, lon=LON)}),
            id="centroid-elsewhere",
        ),
        pytest.param(lambda m: m.model_copy(update={"area_ha": m.area_ha * 1.2}), id="area"),
    ],
)
def test_a_new_listing_is_never_rated_with_another_places_data(
    world: World_, change: Callable[[EarthObsMetrics], EarthObsMetrics]
) -> None:
    world.runner.metrics_loader = _loader(change)
    asset = draft(world)
    run_id = submit(world, asset["id"]).json()["run_id"]
    world.executor.run_all()

    run = client_as(world, world.steward).get(f"/runs/{run_id}").json()
    assert run["error"] == "earth_obs_failed:foreign_metrics"
    assert status_of(world, asset["id"]) == (
        AssetStatus.RATING,
        "rating_failed:earth_obs_failed:foreign_metrics",
    )


@requires_db
def test_metrics_within_tolerance_describe_the_polygon(world: World_) -> None:
    world.runner.metrics_loader = _loader(
        lambda m: m.model_copy(update={"area_ha": m.area_ha * 1.05})
    )
    asset = draft(world)
    submit(world, asset["id"])
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)


@requires_db
def test_low_confidence_needs_evidence_and_new_evidence_allows_a_resubmit(world: World_) -> None:
    asset = needs_evidence(world)
    age_submission(world, asset["id"])
    refused = submit(world, asset["id"])
    assert (refused.status_code, refused.json()["detail"]) == (409, "evidence_required")
    assert transitions(world, asset["id"])[-1] == "rated"
    assert client_as(world, world.outsider).get(f"/assets/{asset['id']}").status_code == 404

    _validated_photo(world, UUID(asset["id"]))
    assert submit(world, asset["id"]).status_code == 202
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)


@requires_db
def test_newer_satellite_data_allows_a_resubmit(world: World_) -> None:
    asset = needs_evidence(world)
    age_submission(world, asset["id"])
    world.runner.metrics_loader = _loader(
        lambda m: m.model_copy(update={"data_version": "mock-2026Q4"})
    )
    assert submit(world, asset["id"]).status_code == 202
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)


def _validated_photo(w: World_, asset_id: UUID) -> FieldPhoto:
    """A validated field photo (T40) with its evidence event, stored as the analyzer would."""
    event = Event(world_id=w.id, asset_id=asset_id, source=EventSource.EVIDENCE, direction=1)
    w.session.add(event)
    w.session.flush()
    photo = FieldPhoto(
        world_id=w.id,
        asset_id=asset_id,
        uploaded_by=w.steward.id,
        size_bytes=1,
        width=1,
        height=1,
        sha256=uuid4().hex * 2,
        gps_check="inside",
        gps_distance_m=0,
        date_check="ok",
        analysis_status="completed",
        validated=True,
        event_id=event.id,
        method_version="test",
    )
    w.session.add(photo)
    w.session.commit()
    return photo


@requires_db
def test_only_validated_evidence_the_latest_report_doesnt_count_is_new(world: World_) -> None:
    asset = needs_evidence(world)
    asset_id = UUID(asset["id"])
    row = world.session.get_one(Asset, asset_id)
    world.session.add(Event(world_id=world.id, asset_id=asset_id, source=EventSource.EVIDENCE))
    world.session.commit()
    assert has_new_evidence(world.session, row) is False, "an event without a validated photo"

    _validated_photo(world, asset_id)
    assert has_new_evidence(world.session, row) is True

    report = world.session.exec(select(Report).where(Report.asset_id == asset_id)).one()
    stored = dict(report.auditor_json or {})
    stored["rating"]["score"]["confidence_components"]["evidence"] = "1.0000"
    report.auditor_json = stored
    flag_modified(report, "auditor_json")
    world.session.add(report)
    world.session.commit()
    assert has_new_evidence(world.session, row) is False, "the report already counts it"


@requires_db
def test_recent_forest_loss_makes_a_listing_ineligible_for_good(world: World_) -> None:
    world.runner.metrics_loader = _loader(_deforested)
    asset = draft(world)
    submit(world, asset["id"])
    world.executor.run_all()

    assert status_of(world, asset["id"]) == (AssetStatus.INELIGIBLE, GATE_FOREST_LOSS)
    refused = submit(world, asset["id"])
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_submit_ineligible")
    for action in ("revise", "withdraw"):
        response = client_as(world, world.steward).post(f"/assets/{asset['id']}/{action}")
        assert response.json()["detail"] == f"cannot_{action}_ineligible"
    # An ineligible listing doesn't block the land.
    assert client_as(world, world.steward).post("/assets", json=body(world)).status_code == 201


@requires_db
def test_only_the_community_submits_and_listed_assets_cant_be_resubmitted(world: World_) -> None:
    asset = draft(world)
    # A draft is hidden from outsiders, so their submit is 404 (T57); an admin sees it but isn't
    # a member.
    for user in (world.outsider, world.other_steward):
        assert submit(world, asset["id"], user).status_code == 404
    assert submit(world, asset["id"], world.admin).json()["detail"] == "members_only"
    assert client_as(world, None).post(f"/assets/{asset['id']}/submit").status_code == 401
    assert submit(world, uuid4()).status_code == 404
    assert status_of(world, asset["id"]) == (AssetStatus.DRAFT, None)
    assert len(listing_events(world, asset["id"])) == 1

    site = curated(world)
    owner = world.session.exec(
        select(CommunityMember.user_id).where(
            CommunityMember.world_id == world.id,
            CommunityMember.community_id == site.community_id,
        )
    ).first()
    assert owner is not None
    refused = submit(world, site.id, world.session.get_one(User, owner))
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_submit_listed")


@requires_db
def test_a_refused_submit_queues_no_run(world: World_) -> None:
    """The status change and the queued run commit together: a capped run changes nothing."""
    asset = draft(world)
    world.runner.settings = _settings(rating_runs_per_world_per_hour=1)
    other = draft(world, geojson=square(800, lat=LAT + 0.2))
    assert submit(world, other["id"]).status_code == 202
    limited = submit(world, asset["id"])
    assert (limited.status_code, limited.json()["detail"]) == (429, "rating_rate_limited")
    assert status_of(world, asset["id"]) == (AssetStatus.DRAFT, None)
    assert transitions(world, asset["id"]) == ["create"]


@requires_db
def test_a_rerate_never_changes_a_listed_assets_status(world: World_) -> None:
    site = curated(world)
    world.runner.start(world.id, site.id, scenario="encroachment")
    world.executor.run_all()

    assert status_of(world, site.id) == (AssetStatus.LISTED, None)
    kinds = [e.kind for e in listing_entries(world, site.id)]
    assert LedgerKind.LISTING not in kinds and kinds.count(LedgerKind.REPORT) == 2
    report = world.session.exec(
        select(Report).where(Report.asset_id == site.id).order_by(col(Report.version).desc())
    ).first()
    assert report is not None
    assert apply_rating_result(world.session, site, report) is None


@requires_db
def test_listings_under_review_are_only_rated_through_submit(world: World_) -> None:
    asset = draft(world)
    with pytest.raises(AssetNotRateable, match="asset_is_draft"):
        world.runner.start(world.id, UUID(asset["id"]))
    submit(world, asset["id"])
    with pytest.raises(AssetNotRateable, match="asset_not_listed"):
        world.runner.start(world.id, UUID(asset["id"]))


# --- revise and withdraw -------------------------------------------------------------------------


@requires_db
def test_a_needs_evidence_listing_can_be_revised_redrawn_and_resubmitted(world: World_) -> None:
    asset = needs_evidence(world)
    client = client_as(world, world.steward)
    revised = client.post(f"/assets/{asset['id']}/revise")
    assert revised.status_code == 200, revised.text
    assert (revised.json()["status"], revised.json()["status_reason"]) == ("draft", None)
    assert (
        client.patch(f"/assets/{asset['id']}", json={"geojson": square(1_100)}).status_code == 200
    )
    age_submission(world, asset["id"])
    assert submit(world, asset["id"]).status_code == 202
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)
    assert transitions(world, asset["id"]) == [
        "create",
        "submit",
        None,
        "rated",
        "revise",
        "edit",
        "submit",
        None,
        "rated",
    ]


@requires_db
def test_a_rating_listing_is_revised_or_withdrawn_only_without_an_active_run(
    world: World_,
) -> None:
    asset = draft(world)
    submit(world, asset["id"])
    client = client_as(world, world.owner)
    for action in ("revise", "withdraw"):
        busy = client.post(f"/assets/{asset['id']}/{action}")
        assert (busy.status_code, busy.json()["detail"]) == (409, "run_in_progress")
    world.runner.settings = _settings(use_mocks=False)
    world.executor.run_all()  # fails: no metrics
    assert client.post(f"/assets/{asset['id']}/revise").json()["status"] == "draft"
    assert client_as(world, world.outsider).post(f"/assets/{asset['id']}/revise").status_code == 404


@requires_db
def test_a_withdrawn_listing_frees_its_land_and_stays_private(world: World_) -> None:
    asset = draft(world)
    withdrawn = client_as(world, world.steward).post(f"/assets/{asset['id']}/withdraw")
    assert withdrawn.json()["status"] == "withdrawn"
    again = submit(world, asset["id"])
    assert (again.status_code, again.json()["detail"]) == (409, "cannot_submit_withdrawn")
    assert client_as(world, world.outsider).get(f"/assets/{asset['id']}").status_code == 404
    assert client_as(world, world.owner).get(f"/assets/{asset['id']}").status_code == 200
    draft(world)  # the same land, again
    assert transitions(world, asset["id"]) == ["create", "withdraw"]


# --- the event stream and runs are scoped (C1) ---------------------------------------------------


@pytest.fixture
def same_session_stream(world: World_, monkeypatch: pytest.MonkeyPatch) -> None:
    @contextmanager
    def scope() -> Iterator[Session]:
        yield world.session

    monkeypatch.setattr(event_bus, "session_scope", scope)
    monkeypatch.setattr(event_bus, "STREAM_MAX_SECONDS", 0.05)
    monkeypatch.setattr(event_bus, "STREAM_POLL_INTERVAL_SECONDS", 0.01)


@requires_db
def test_private_listings_never_reach_outsiders_through_events_or_runs(
    world: World_, same_session_stream: None
) -> None:
    asset = needs_evidence(world)
    run_id = str(
        world.session.exec(select(Report).where(Report.asset_id == UUID(asset["id"])))
        .one()
        .auditor_json["run"]["run_id"]  # type: ignore[index]
    )

    for user in (None, world.outsider, world.other_steward):
        client = client_as(world, user)
        polled = client.get("/events")
        assert polled.status_code == 200
        assert asset["id"] not in polled.text and run_id not in polled.text
        streamed = client.get("/events/stream")
        assert streamed.status_code == 200
        assert asset["id"] not in streamed.text and run_id not in streamed.text
        assert client.get(f"/runs/{run_id}").status_code == 404

    for user in (world.steward, world.owner, world.admin):
        client = client_as(world, user)
        polled = client.get("/events").json()
        mine = [e for e in polled if e["payload"].get("asset_id") == asset["id"]]
        assert {e["type"] for e in mine} == {"listing_status", "rating_progress"}
        assert run_id in client.get("/events/stream").text
        assert client.get(f"/runs/{run_id}").status_code == 200


@requires_db
def test_a_report_diff_needs_both_reports_visible(world: World_) -> None:
    hidden = needs_evidence(world)
    hidden_report = world.session.exec(
        select(Report.id).where(Report.asset_id == UUID(hidden["id"]))
    ).one()
    public_report = world.session.exec(
        select(Report.id).where(Report.asset_id == curated(world).id)
    ).first()
    outsider = client_as(world, world.outsider)
    assert outsider.get(f"/reports/{public_report}").status_code == 200
    assert outsider.get(f"/reports/{hidden_report}").status_code == 404
    for path in (
        f"/reports/{public_report}/diff/{hidden_report}",
        f"/reports/{hidden_report}/diff/{public_report}",
    ):
        assert outsider.get(path).status_code == 404
    assert (
        client_as(world, world.steward)
        .get(f"/reports/{public_report}/diff/{hidden_report}")
        .status_code
        == 400
    )  # visible, but of different assets


# --- suspend and resume --------------------------------------------------------------------------


@requires_db
def test_admins_suspend_and_resume_a_listed_asset(world: World_) -> None:
    site = curated(world)
    path = f"/admin/assets/{site.id}"
    admin = client_as(world, world.admin)

    assert client_as(world, world.outsider).post(
        f"{path}/suspend", json={"reason": "moderation"}
    ).json() == {"detail": "admin_only"}
    assert admin.post(f"{path}/suspend", json={"reason": "verification_revoked"}).status_code == 422
    suspended = admin.post(f"{path}/suspend", json={"reason": "data_dispute"})
    assert suspended.status_code == 200, suspended.text
    assert (suspended.json()["status"], suspended.json()["status_reason"]) == (
        "suspended",
        "data_dispute",
    )
    card = next(c for c in admin.get("/assets").json() if c["id"] == str(site.id))
    assert card["status"] == "suspended"  # still public, shown as suspended
    again = admin.post(f"{path}/suspend", json={"reason": "moderation"})
    assert (again.status_code, again.json()["detail"]) == (409, "cannot_suspend_suspended")

    resumed = admin.post(f"{path}/resume")
    assert resumed.json()["status"] == "listed" and resumed.json()["status_reason"] is None
    assert admin.post(f"{path}/resume").json()["detail"] == "cannot_resume_listed"

    entries = [e for e in listing_entries(world, site.id) if e.kind is LedgerKind.LISTING]
    assert [(e.payload["transition"], e.payload["reason"]) for e in entries] == [
        ("suspend", "data_dispute"),
        ("resume", None),
    ]
    assert verify(listing_entries(world, site.id)).valid
    events = listing_events(world, site.id)
    assert [e.payload["to"] for e in events] == ["suspended", "listed"]
    assert [e.audience_community_id for e in events] == [None, None]


@requires_db
def test_suspending_a_draft_is_refused(world: World_) -> None:
    asset = draft(world)
    refused = client_as(world, world.admin).post(
        f"/admin/assets/{asset['id']}/suspend", json={"reason": "moderation"}
    )
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_suspend_draft")


@requires_db
def test_an_admin_member_cant_moderate_their_own_communitys_asset(world: World_) -> None:
    _member(world.session, world.id, world.community_id, world.admin)
    asset = draft(world, world.admin)
    response = client_as(world, world.admin).post(
        f"/admin/assets/{asset['id']}/suspend", json={"reason": "moderation"}
    )
    assert response.json() == {"detail": "conflict_of_interest"}


@requires_db
def test_world_reset_removes_the_worlds_listings(world: World_) -> None:
    asset = draft(world)
    reset_world(world.session, world.id)
    assert world.session.get(Asset, UUID(asset["id"])) is None


# --- mock metrics are never production data (R6) -------------------------------------------------


def test_production_refuses_mock_metrics() -> None:
    with pytest.raises(RuntimeError, match="USE_MOCKS"):
        validate_mock_settings(_settings(environment="production"))
    validate_mock_settings(_settings(environment="production", use_mocks=False))
    validate_mock_settings(_settings(environment="development"))
    validate_mock_settings(_settings(environment="test"))


# --- concurrency: real transactions on separate connections ---------------------------------------


@dataclass
class Committed:
    engine: Engine
    world_id: UUID
    community_id: UUID
    owner_id: UUID


@pytest.fixture
def committed() -> Iterator[Committed]:
    """A committed sandbox world with a community, deleted afterwards."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as setup:
        seed(setup)
        sandbox = create_world(setup)
        owner = _person(setup, sandbox.id, "Owner")
        community = create_community(setup, sandbox.id, "Concurrent Stewards", owner.id)
        setup.commit()
        ids = (sandbox.id, community.id, owner.id)
    try:
        yield Committed(engine, *ids)
    finally:
        with Session(engine) as cleanup:
            _delete_world_rows(cleanup, ids[0], keep_world=False)
            cleanup.execute(delete(WorldRow).where(col(WorldRow.id) == ids[0]))
            cleanup.commit()
        engine.dispose()


def _committed_draft(c: Committed, lat: float = LAT) -> UUID:
    details = ListingDetails(
        name="Bosque Vivo", country=None, description=None, geojson=square(800, lat=lat)
    )
    with Session(c.engine) as session:
        asset = create_draft(
            session, world_id=c.world_id, community_id=c.community_id, details=details
        )
        session.commit()
        return asset.id


def _slow_publish(
    monkeypatch: pytest.MonkeyPatch, holder: threading.Event, release_after: float = 0.5
) -> None:
    """In the thread named `holder`, pause just before publishing, holding every earlier lock."""
    real = listings.publish

    def publish(*args: Any, **kwargs: Any) -> Any:
        if threading.current_thread().name == "holder":
            holder.set()
            time.sleep(release_after)
        return real(*args, **kwargs)

    monkeypatch.setattr(listings, "publish", publish)


def _race(
    holder_job: Callable[[], Any], submit_job: Callable[[], Any], held: threading.Event
) -> tuple[Any, Any]:
    """Run `holder_job` until it holds its locks, then `submit_job` against it."""
    results: dict[str, Any] = {}

    def run(name: str, job: Callable[[], Any]) -> None:
        try:
            results[name] = job()
        except Exception as exc:  # noqa: BLE001 - the test inspects it
            results[name] = exc

    holder = threading.Thread(target=run, args=("holder", holder_job), name="holder")
    holder.start()
    assert held.wait(timeout=10)
    submitter = threading.Thread(target=run, args=("submitter", submit_job), name="submitter")
    submitter.start()
    holder.join(timeout=20)
    submitter.join(timeout=20)
    return results["holder"], results["submitter"]


@requires_db
def test_an_edit_and_a_submit_of_one_draft_queue_instead_of_deadlocking(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    asset_id = _committed_draft(committed)
    held = threading.Event()
    _slow_publish(monkeypatch, held)
    runner = _runner(lambda: Session(committed.engine))

    def edit() -> UUID:
        with Session(committed.engine) as session:
            update_draft(session, committed.world_id, asset_id, {"name": "Bosque Editado"})
            session.commit()
            return asset_id

    def go() -> UUID:
        hook = ListingSubmit(metrics_version="mock-2026Q3")
        return runner.start(committed.world_id, asset_id, trigger="listing", on_queue=hook)

    edited, submitted = _race(edit, go, held)

    assert edited == asset_id
    assert isinstance(submitted, UUID), submitted
    with Session(committed.engine) as check:
        asset = check.get_one(Asset, asset_id)
        assert (asset.status, asset.name) == (AssetStatus.RATING, "Bosque Editado")
        entries = check.exec(
            select(LedgerEntry)
            .where(LedgerEntry.asset_id == asset_id)
            .order_by(col(LedgerEntry.seq))
        ).all()
        assert [e.payload["transition"] for e in entries] == ["create", "edit", "submit"]


@requires_db
def test_a_suspend_and_a_submit_of_one_asset_queue_instead_of_deadlocking(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    with Session(committed.engine) as session:
        site = session.exec(
            select(Asset.id).where(
                Asset.world_id == committed.world_id, Asset.site_key == "wetland_mx"
            )
        ).one()
    held = threading.Event()
    _slow_publish(monkeypatch, held)
    runner = _runner(lambda: Session(committed.engine))

    def suspend_it() -> AssetStatus:
        with Session(committed.engine) as session:
            asset = suspend(session, committed.world_id, site, SuspensionReason.MODERATION)
            session.commit()
            return asset.status

    def go() -> UUID:
        hook = ListingSubmit(metrics_version="2026Q3")
        return runner.start(committed.world_id, site, trigger="listing", on_queue=hook)

    suspended, submitted = _race(suspend_it, go, held)

    assert suspended is AssetStatus.SUSPENDED
    assert isinstance(submitted, TransitionRefused), submitted
    assert submitted.code == "cannot_submit_suspended"


@requires_db
def test_the_open_listing_cap_holds_under_concurrent_creates(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(listings, "MAX_OPEN_LISTINGS", 2)
    threads = 5
    barrier = threading.Barrier(threads)

    def create_one(n: int) -> str:
        details = ListingDetails(
            name=f"Parcela {n}",
            country=None,
            description=None,
            geojson=square(500, lat=LAT + n * 0.05),
        )
        with Session(committed.engine) as session:
            barrier.wait(timeout=10)
            try:
                create_draft(
                    session,
                    world_id=committed.world_id,
                    community_id=committed.community_id,
                    details=details,
                )
                session.commit()
                return "created"
            except ListingLimitReached:
                session.rollback()
                return "limit"

    with ThreadPoolExecutor(max_workers=threads) as pool:
        outcomes = sorted(pool.map(create_one, range(threads), timeout=30))
    assert outcomes == ["created"] * 2 + ["limit"] * 3


@requires_db
def test_curated_sites_have_a_bounding_box_for_the_overlap_prefilter(world: World_) -> None:
    for site in world.session.exec(select(Asset).where(Asset.world_id == world.id)).all():
        assert None not in (site.bbox_west, site.bbox_south, site.bbox_east, site.bbox_north)
        assert site.bbox_west is not None and site.bbox_east is not None
        assert site.bbox_west < site.bbox_east


@requires_db
def test_overlap_candidates_are_prefiltered_by_bounding_box(world: World_) -> None:
    near = draft(world)
    far = draft(world, geojson=square(800, lat=LAT + 5))
    unknown = draft(world, geojson=square(800, lat=LAT - 5))
    row = world.session.get_one(Asset, UUID(unknown["id"]))
    row.bbox_west = row.bbox_south = row.bbox_east = row.bbox_north = None
    world.session.commit()
    box = geometry_bbox(square(1_000))
    found = {
        str(asset_id)
        for asset_id, _ in overlap_candidates(world.session, world.id, world.community_id, box)
    }
    assert near["id"] in found and unknown["id"] in found  # no stored box: always checked
    assert far["id"] not in found


@requires_db
def test_quotes_and_orders_never_reveal_a_private_listing(world: World_) -> None:
    asset = draft(world)
    quote = f"/assets/{asset['id']}/quote?side=buy&qty=1"
    for user in (None, world.outsider, world.other_steward):
        assert client_as(world, user).get(quote).status_code == 404
    outsider = client_as(world, world.outsider)
    order = outsider.post("/orders", json={"asset_id": asset["id"], "side": "buy", "qty": 1})
    assert order.status_code == 404
    # The community sees its own listing isn't tradable (yet).
    mine = client_as(world, world.steward).get(quote)
    assert (mine.status_code, mine.json()["detail"]) == (409, NOT_TRADING)


# ----- The listing flow's reads (T33) ----------------------------------------------------------


@requires_db
def test_a_listing_under_review_shows_its_latest_run(world: World_) -> None:
    asset = draft(world)
    path = f"/assets/{asset['id']}"
    assert asset["latest_run_id"] is None
    assert client_as(world, world.owner).get(path).json()["latest_run_id"] is None

    run_id = submit(world, asset["id"]).json()["run_id"]
    for user in (world.owner, world.steward, world.admin):
        assert client_as(world, user).get(path).json()["latest_run_id"] == run_id
    for user in (world.outsider, world.other_steward):
        assert client_as(world, user).get(path).status_code == 404

    world.runner.settings = _settings(use_mocks=False)  # no metrics: it stays in rating
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.RATING, "no_satellite_metrics")
    # Once its events are pruned (T29) a failed run has no record left to point to.
    world.session.execute(
        delete(WorldEvent).where(
            col(WorldEvent.world_id) == world.id,
            col(WorldEvent.type) == StreamEventType.RATING_PROGRESS,
        )
    )
    world.session.commit()
    assert client_as(world, world.owner).get(path).json()["latest_run_id"] is None


@requires_db
def test_a_public_asset_never_shows_a_run(world: World_) -> None:
    asset = draft(world)
    run_id = submit(world, asset["id"]).json()["run_id"]
    world.executor.run_all()
    assert status_of(world, asset["id"])[0] is AssetStatus.LISTED
    for user in (world.steward, world.admin, world.outsider):
        detail = client_as(world, user).get(f"/assets/{asset['id']}").json()
        assert detail["latest_run_id"] is None
    assert client_as(world, world.outsider).get(f"/runs/{run_id}").status_code == 200


@requires_db
def test_outlines_show_public_sites_of_the_callers_world_only(
    world: World_, monkeypatch: pytest.MonkeyPatch
) -> None:
    asset = draft(world)
    other = draft(world, name="Bosque Norte", geojson=square(1_200, lat=LAT + 0.05))
    outlines = client_as(world, world.steward).get("/assets/outlines")
    assert outlines.status_code == 200
    assert outlines.headers["cache-control"] == "private, no-store"
    ids = [o["id"] for o in outlines.json()["outlines"]]
    assert asset["id"] not in ids and other["id"] not in ids  # drafts stay private
    assert ids, "the sandbox's curated sites are listed"

    submit(world, asset["id"])
    world.executor.run_all()
    for user in (world.steward, world.outsider):
        body_ = client_as(world, user).get("/assets/outlines").json()
        mine = next(o for o in body_["outlines"] if o["id"] == asset["id"])
        assert mine["name"] == "Bosque Vivo"
        assert len(mine["rings"]) == 1 and len(mine["rings"][0]) == 5
        assert body_["truncated"] is False
    # Another world's sites never show (anonymous visitors read the live world).
    live = client_as(world, None).get("/assets/outlines").json()["outlines"]
    assert asset["id"] not in [o["id"] for o in live]

    monkeypatch.setattr("app.routers.assets.OUTLINES_MAX_SITES", 1)
    capped = client_as(world, world.steward).get("/assets/outlines").json()
    assert len(capped["outlines"]) == 1 and capped["truncated"] is True


def _corners(outline: list[list[list[float]]]) -> int:
    return sum(len(ring) for ring in outline)


@requires_db
def test_a_card_carries_its_stored_boundary_outline(
    world: World_, monkeypatch: pytest.MonkeyPatch
) -> None:
    asset = draft(world)
    ring = asset["geojson"]["coordinates"][0]
    outline = [[[round(lon, 5), round(lat, 5)] for lon, lat in ring]]
    assert asset["outline"] == outline

    def no_simplifying(*_: object, **__: object) -> object:
        raise AssertionError("an outline is simplified once, when its area is saved")

    # Reads serve the stored outline: nothing is simplified per request.
    monkeypatch.setattr("app.services.listings.thumbnail_outline", no_simplifying)
    monkeypatch.setattr("app.tools.geometry.outline_rings", no_simplifying)
    mine = client_as(world, world.steward).get(f"/communities/{world.community_id}/assets")
    assert mine.json()[0]["outline"] == outline
    submit(world, asset["id"])
    world.executor.run_all()
    client = client_as(world, world.outsider)
    cards_ = client.get("/assets").json()
    assert next(c for c in cards_ if c["id"] == asset["id"])["outline"] == outline
    assert client.get(f"/assets/{asset['id']}").json()["outline"] == outline

    curated = [c for c in cards_ if c["site_key"]]
    assert curated and all(c["outline"] == [] for c in curated), "they have thumbnails"
    assert client.get(f"/assets/{curated[0]['id']}").json()["outline"] == []


@requires_db
def test_a_detailed_or_multi_part_boundary_is_stored_simplified(world: World_) -> None:
    circle = geometry_circle(2_000, radius_deg=0.01, lat=LAT, lon=LON)
    detailed = draft(world, geojson={"type": "Feature", "properties": {}, "geometry": circle})
    assert 4 <= _corners(detailed["outline"]) <= THUMBNAIL_OUTLINE_MAX_POINTS

    east = square(1_200, lon=LON + 0.2)["coordinates"]
    west = geometry_circle(500, radius_deg=0.005, lat=LAT + 0.2, lon=LON)["coordinates"]
    parts = draft(
        world,
        name="Bosque Doble",
        geojson={"type": "MultiPolygon", "coordinates": [east, west]},
    )
    assert len(parts["outline"]) == 2
    assert _corners(parts["outline"]) <= THUMBNAIL_OUTLINE_MAX_POINTS

    changed = client_as(world, world.steward).patch(
        f"/assets/{detailed['id']}", json={"geojson": square(900, lat=LAT - 0.2)}
    )
    assert changed.status_code == 200, changed.text
    assert _corners(changed.json()["outline"]) == 5, "an edit stores the new outline"

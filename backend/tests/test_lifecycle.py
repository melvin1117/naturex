"""Listing lifecycle (T58): the pure state machine, the listing service and the API."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import Executor, Future
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import partial
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine
from sqlmodel import Session, col, select

from app.auth import SESSION_COOKIE, start_session
from app.communities import create_community
from app.config import Settings, get_settings
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
from app.routers.assets import MAX_OPEN_LISTINGS
from app.routers.runs import get_rating_runner
from app.sandbox import COOKIE_NAME, create_world, reset_world
from app.seed import seed
from app.services.lifecycle import (
    EVIDENCE_REQUIRED,
    NO_SATELLITE_METRICS,
    GateResult,
    ListingEvent,
    SuspensionReason,
    Transition,
    TransitionRefused,
    created,
    gate_from_report,
    gate_outcome,
    is_public,
    transition,
)
from app.services.listings import apply_rating_result
from app.services.rating_runs import AssetInfo, AssetNotRateable, RatingRunner, news_runner
from app.tools.earth_obs import (
    DateWindow,
    EarthObsMetrics,
    ScenarioName,
    load_site_metrics,
    mock_listing_metrics,
)
from app.tools.scoring import GATE_CONFIDENCE_BELOW_70, GATE_FOREST_LOSS, GATE_GRADE_BELOW_C
from app.worlds import LIVE_WORLD_ID
from tests.conftest import alembic_cfg, requires_db
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


def test_resubmitting_needs_new_evidence() -> None:
    with pytest.raises(TransitionRefused) as exc:
        transition(S.NEEDS_EVIDENCE, E.SUBMIT)
    assert exc.value.code == EVIDENCE_REQUIRED


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


@dataclass
class World_:
    id: UUID
    community_id: UUID
    owner: User
    steward: User
    outsider: User
    admin: User
    session: Session
    conn: Connection
    runner: RatingRunner
    executor: Deferred


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


def _runner(conn: Connection, *, use_mocks: bool = True, loader: Any = None) -> RatingRunner:
    cfg = Settings(_env_file=None, use_mocks=use_mocks)  # type: ignore[call-arg]
    runner = RatingRunner(
        session_factory=_sessions(conn),
        settings=cfg,
        executor=Deferred(),
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: date(2026, 10, 18),
    )
    if loader is not None:
        runner.metrics_loader = loader
    return runner


@pytest.fixture
def world(conn: Connection) -> Iterator[World_]:
    """A sandbox world with a community (owner + steward), an outsider and an admin."""
    session = _sessions(conn)()
    seed(session)
    sandbox = create_world(session)
    owner = _person(session, sandbox.id, "Owner")
    steward = _person(session, sandbox.id, "Steward")
    outsider = _person(session, sandbox.id, "Outsider")
    admin = _person(session, sandbox.id, "Admin", UserRole.ADMIN)
    community = create_community(session, sandbox.id, "Bosque Vivo Stewards", owner.id)
    session.add(
        CommunityMember(
            community_id=community.id,
            user_id=steward.id,
            world_id=sandbox.id,
            role=CommunityRole.STEWARD,
        )
    )
    session.commit()
    runner = _runner(conn)
    assert isinstance(runner.executor, Deferred)
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, use_mocks=True)  # type: ignore[call-arg]
    app.dependency_overrides[get_rating_runner] = lambda: runner
    yield World_(
        sandbox.id,
        community.id,
        owner,
        steward,
        outsider,
        admin,
        session,
        conn,
        runner,
        runner.executor,
    )
    app.dependency_overrides.clear()
    session.close()


def client_as(w: World_, user: User | None) -> TestClient:
    """A client in the world's sandbox, signed in as `user` (None: anonymous)."""
    client = TestClient(app)
    client.cookies.set(COOKIE_NAME, str(w.id))
    if user is not None:
        client.cookies.set(SESSION_COOKIE, start_session(w.session, user, SessionKind.DEMO))
    return client


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


def square(side_m: float, lat: float = LAT, lon: float = LON) -> dict[str, Any]:
    return geometry_square(side_m, lat=lat, lon=lon)


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


def listing_events(w: World_, asset_id: str | UUID) -> list[dict[str, Any]]:
    rows = w.session.exec(
        select(WorldEvent)
        .where(WorldEvent.world_id == w.id, WorldEvent.type == StreamEventType.LISTING_STATUS)
        .order_by(col(WorldEvent.id))
    ).all()
    return [row.payload for row in rows if row.payload["asset_id"] == str(asset_id)]


def status_of(w: World_, asset_id: str | UUID) -> tuple[AssetStatus, str | None]:
    w.session.expire_all()
    asset = w.session.get_one(Asset, UUID(str(asset_id)))
    return asset.status, asset.status_reason


def submit(w: World_, asset_id: str | UUID, user: User | None = None) -> Any:
    return client_as(w, user or w.steward).post(f"/assets/{asset_id}/submit")


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
    assert asset["latest_report"] is None and asset["price"] is None
    row = world.session.get_one(Asset, UUID(asset["id"]))
    assert row.attested_at is not None and row.attested_at >= created_at
    community = world.session.get_one(Community, world.community_id)
    assert row.community_user_id == community.treasury_user_id

    [entry] = listing_entries(world, asset["id"])
    assert entry.kind is LedgerKind.LISTING
    assert entry.payload["transition"] == "create" and entry.payload["to"] == "draft"
    assert entry.payload["geojson"] == square(1_200)
    assert entry.payload["name"] == "Bosque Vivo"
    assert "description" not in entry.payload and entry.payload["description_sha256"]
    [event] = listing_events(world, asset["id"])
    assert event == {
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
    for user in (world.outsider, None):
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
    live_community = (
        world.session.exec(select(Community.id).where(Community.world_id == LIVE_WORLD_ID)).first()
        or uuid4()
    )
    for community in (live_community, uuid4()):
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
    bow_tie = {
        "type": "Polygon",
        "coordinates": [
            [[LON, LAT], [LON + 0.01, LAT + 0.01], [LON + 0.01, LAT], [LON, LAT + 0.01], [LON, LAT]]
        ],
    }
    crossing = client.post("/assets", json=body(world, geojson=bow_tie))
    assert [p["type"] for p in crossing.json()["detail"]] == ["polygon.self_intersection"]
    assert client.post("/assets", json=body(world, geojson={"type": "Point"})).status_code == 422
    assert not client.get(f"/communities/{world.community_id}/assets").json()


@requires_db
def test_listings_cant_overlap_within_a_world(world: World_) -> None:
    client = client_as(world, world.steward)
    curated = world.session.exec(
        select(Asset).where(Asset.world_id == world.id, col(Asset.site_key).is_not(None))
    ).first()
    assert curated is not None
    on_curated = client.post("/assets", json=body(world, geojson=curated.geojson))
    assert [p["type"] for p in on_curated.json()["detail"]] == ["polygon.overlap"]
    assert str(curated.id) not in on_curated.text  # never names the other listing

    first = draft(world)
    on_draft = client.post("/assets", json=body(world, geojson=square(1_000)))
    assert [p["type"] for p in on_draft.json()["detail"]] == ["polygon.overlap"]
    # Another world's listings don't count.
    assert first["geojson"] == square(1_200)


@requires_db
def test_a_community_has_a_limit_of_open_listings(world: World_) -> None:
    for i in range(MAX_OPEN_LISTINGS):
        draft(world, geojson=square(400, lat=LAT + i * 0.01))
    over = client_as(world, world.steward).post(
        "/assets", json=body(world, geojson=square(400, lat=LAT + 0.5))
    )
    assert (over.status_code, over.json()["detail"]) == (409, "listing_limit_reached")


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
    assert (
        client.patch(f"/assets/{asset['id']}", json={"geojson": square(1_000)}).status_code == 200
    )

    entries = listing_entries(world, asset["id"])
    assert [e.payload["transition"] for e in entries] == ["create", "edit", "edit"]
    assert entries[1].payload["name"] == "Bosque Vivo Norte"
    assert entries[1].payload["description_sha256"] is None
    assert entries[2].payload["geojson"] == square(1_000)

    bad = client.patch(f"/assets/{asset['id']}", json={"geojson": square(50)})
    assert [p["type"] for p in bad.json()["detail"]] == ["polygon.too_small"]
    assert client.patch(f"/assets/{asset['id']}", json={"name": None}).status_code == 422
    assert client.patch(f"/assets/{asset['id']}", json={"total_shares": 5}).status_code == 422
    assert (
        client_as(world, world.outsider)
        .patch(f"/assets/{asset['id']}", json={"name": "Mine"})
        .status_code
        == 403
    )


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
    assert asset["id"] in [card["id"] for card in client.get("/assets").json()]
    run = client_as(world, world.steward).get(f"/runs/{run_id}").json()
    assert run["trigger"] == "listing" and run["status"] in {"succeeded", "degraded"}
    earth_obs = next(step for step in run["steps"] if step["step"] == "earth_obs")
    assert earth_obs["status"] == "ok"

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
    assert entries[1].payload == {
        "transition": "submit",
        "from": "draft",
        "to": "rating",
        "reason": None,
        "run_id": run_id,
    }
    assert verify(entries).valid
    assert [(e["transition"], e["to"]) for e in listing_events(world, asset["id"])] == [
        ("create", "draft"),
        ("submit", "rating"),
        ("rated", "listed"),
    ]
    # Listed but no IPO yet (T59): no price, so it can't be traded.
    assert detail["price"] is None
    order = client.post("/orders", json={"asset_id": asset["id"], "side": "buy", "qty": 1})
    assert order.status_code in (401, 409)


@requires_db
def test_without_metrics_for_the_polygon_the_listing_waits_in_rating(world: World_) -> None:
    """The T60 seam: no cached metrics and no mocks → the run fails, nothing borrowed."""
    world.runner.settings = Settings(_env_file=None, use_mocks=False)  # type: ignore[call-arg]
    asset = draft(world)
    run_id = submit(world, asset["id"]).json()["run_id"]
    world.executor.run_all()

    assert status_of(world, asset["id"]) == (AssetStatus.RATING, NO_SATELLITE_METRICS)
    run = client_as(world, world.steward).get(f"/runs/{run_id}").json()
    assert run["status"] == "failed" and run["error"] == "earth_obs_failed:no_cached_metrics"
    assert (
        world.session.exec(select(Report).where(Report.asset_id == UUID(asset["id"]))).first()
        is None
    )
    detail = client_as(world, world.owner).get(f"/assets/{asset['id']}").json()
    assert detail["status"] == "rating" and detail["status_reason"] == NO_SATELLITE_METRICS
    assert client_as(world, world.outsider).get(f"/assets/{asset['id']}").status_code == 404

    # Retry once metrics exist (here: mocks back on).
    world.runner.settings = Settings(_env_file=None, use_mocks=True)  # type: ignore[call-arg]
    retry = submit(world, asset["id"])
    assert retry.status_code == 202
    assert status_of(world, asset["id"]) == (AssetStatus.RATING, None)
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)
    transitions = [e.payload.get("transition") for e in listing_entries(world, asset["id"])]
    assert transitions == ["create", "submit", "submit", None, "rated"]


@requires_db
def test_a_new_listing_is_never_rated_with_a_curated_sites_data(world: World_) -> None:
    def borrowed(_asset: AssetInfo, scenario: ScenarioName) -> EarthObsMetrics:
        return load_site_metrics("wetland_mx", scenario)

    world.runner.metrics_loader = borrowed
    asset = draft(world)
    run_id = submit(world, asset["id"]).json()["run_id"]
    world.executor.run_all()

    run = client_as(world, world.steward).get(f"/runs/{run_id}").json()
    assert run["error"] == "earth_obs_failed:foreign_metrics"
    assert status_of(world, asset["id"]) == (
        AssetStatus.RATING,
        "rating_failed:earth_obs_failed:foreign_metrics",
    )


def _stale(metrics: EarthObsMetrics) -> EarthObsMetrics:
    """Observed 6 months before the rating date: recency halves, confidence drops below 70."""
    old = DateWindow(start="2021-04-01", end="2026-04-01")
    return metrics.model_copy(update={"date_windows": {**metrics.date_windows, "ndvi": old}})


def _deforested(metrics: EarthObsMetrics) -> EarthObsMetrics:
    return metrics.model_copy(update={"forest_loss_last_12m_ha": 20.0, "forest_loss_ha": 20.0})


def _loader(change: Callable[[EarthObsMetrics], EarthObsMetrics]) -> Any:
    def load(asset: AssetInfo, _scenario: ScenarioName) -> EarthObsMetrics:
        assert asset.area_ha is not None and asset.centroid_lat is not None
        assert asset.centroid_lon is not None
        return change(
            mock_listing_metrics(
                area_ha=asset.area_ha,
                centroid_lat=asset.centroid_lat,
                centroid_lon=asset.centroid_lon,
            )
        )

    return load


@requires_db
def test_low_confidence_needs_evidence_and_new_evidence_allows_a_resubmit(world: World_) -> None:
    world.runner.metrics_loader = _loader(_stale)
    asset = draft(world)
    submit(world, asset["id"])
    world.executor.run_all()

    assert status_of(world, asset["id"]) == (AssetStatus.NEEDS_EVIDENCE, "confidence_below_70")
    refused = submit(world, asset["id"])
    assert (refused.status_code, refused.json()["detail"]) == (409, "evidence_required")
    assert listing_entries(world, asset["id"])[-1].payload["transition"] == "rated"
    assert client_as(world, world.outsider).get(f"/assets/{asset['id']}").status_code == 404

    world.session.add(
        Event(world_id=world.id, asset_id=UUID(asset["id"]), source=EventSource.EVIDENCE)
    )
    world.session.commit()
    world.runner.metrics_loader = _loader(lambda metrics: metrics)
    assert submit(world, asset["id"]).status_code == 202
    world.executor.run_all()
    assert status_of(world, asset["id"]) == (AssetStatus.LISTED, None)


@requires_db
def test_recent_forest_loss_makes_a_listing_ineligible_for_good(world: World_) -> None:
    world.runner.metrics_loader = _loader(_deforested)
    asset = draft(world)
    submit(world, asset["id"])
    world.executor.run_all()

    assert status_of(world, asset["id"]) == (AssetStatus.INELIGIBLE, GATE_FOREST_LOSS)
    refused = submit(world, asset["id"])
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_submit_ineligible")
    # An ineligible listing doesn't block the land.
    assert client_as(world, world.steward).post("/assets", json=body(world)).status_code == 201


@requires_db
def test_only_the_community_submits_and_listed_assets_cant_be_resubmitted(world: World_) -> None:
    asset = draft(world)
    for user, code in ((world.outsider, 403), (world.admin, 403)):
        assert submit(world, asset["id"], user).status_code == code
    assert client_as(world, None).post(f"/assets/{asset['id']}/submit").status_code == 401
    assert submit(world, uuid4()).status_code == 404
    assert status_of(world, asset["id"]) == (AssetStatus.DRAFT, None)
    assert not listing_events(world, asset["id"])[1:]

    curated = world.session.exec(
        select(Asset).where(Asset.world_id == world.id, col(Asset.site_key).is_not(None))
    ).first()
    assert curated is not None
    owner = world.session.exec(
        select(CommunityMember.user_id).where(
            CommunityMember.world_id == world.id,
            CommunityMember.community_id == curated.community_id,
        )
    ).first()
    assert owner is not None
    refused = submit(world, curated.id, world.session.get_one(User, owner))
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_submit_listed")


@requires_db
def test_a_refused_submit_queues_no_run(world: World_) -> None:
    """The status change and the queued run commit together: a capped run changes nothing."""
    asset = draft(world)
    world.runner.settings = Settings(  # type: ignore[call-arg]
        _env_file=None, use_mocks=True, rating_runs_per_world_per_hour=1
    )
    other = draft(world, geojson=square(800, lat=LAT + 0.2))
    assert submit(world, other["id"]).status_code == 202
    limited = submit(world, asset["id"])
    assert (limited.status_code, limited.json()["detail"]) == (429, "rating_rate_limited")
    assert status_of(world, asset["id"]) == (AssetStatus.DRAFT, None)
    assert [e.payload["transition"] for e in listing_entries(world, asset["id"])] == ["create"]


@requires_db
def test_a_rerate_never_changes_a_listed_assets_status(world: World_) -> None:
    curated = world.session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.site_key == "wetland_mx")
    ).one()
    world.runner.start(world.id, curated.id, scenario="encroachment")
    world.executor.run_all()

    assert status_of(world, curated.id) == (AssetStatus.LISTED, None)
    kinds = [e.kind for e in listing_entries(world, curated.id)]
    assert LedgerKind.LISTING not in kinds and kinds.count(LedgerKind.REPORT) == 2
    report = world.session.exec(
        select(Report).where(Report.asset_id == curated.id).order_by(col(Report.version).desc())
    ).first()
    assert report is not None
    assert apply_rating_result(world.session, curated, report) is None


@requires_db
def test_listings_under_review_are_only_rated_through_submit(world: World_) -> None:
    asset = draft(world)
    with pytest.raises(AssetNotRateable, match="asset_is_draft"):
        world.runner.start(world.id, UUID(asset["id"]))
    submit(world, asset["id"])
    with pytest.raises(AssetNotRateable, match="asset_not_listed"):
        world.runner.start(world.id, UUID(asset["id"]))


# --- suspend and resume --------------------------------------------------------------------------


@requires_db
def test_admins_suspend_and_resume_a_listed_asset(world: World_) -> None:
    curated = world.session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.site_key == "wetland_mx")
    ).one()
    path = f"/admin/assets/{curated.id}"
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
    card = next(c for c in admin.get("/assets").json() if c["id"] == str(curated.id))
    assert card["status"] == "suspended"  # still public, shown as suspended
    again = admin.post(f"{path}/suspend", json={"reason": "moderation"})
    assert (again.status_code, again.json()["detail"]) == (409, "cannot_suspend_suspended")

    resumed = admin.post(f"{path}/resume")
    assert resumed.json()["status"] == "listed" and resumed.json()["status_reason"] is None
    assert admin.post(f"{path}/resume").json()["detail"] == "cannot_resume_listed"

    entries = [e for e in listing_entries(world, curated.id) if e.kind is LedgerKind.LISTING]
    assert [(e.payload["transition"], e.payload["reason"]) for e in entries] == [
        ("suspend", "data_dispute"),
        ("resume", None),
    ]
    assert verify(listing_entries(world, curated.id)).valid
    assert [e["to"] for e in listing_events(world, curated.id)] == ["suspended", "listed"]


@requires_db
def test_suspending_a_draft_is_refused(world: World_) -> None:
    asset = draft(world)
    refused = client_as(world, world.admin).post(
        f"/admin/assets/{asset['id']}/suspend", json={"reason": "moderation"}
    )
    assert (refused.status_code, refused.json()["detail"]) == (409, "cannot_suspend_draft")


@requires_db
def test_an_admin_member_cant_moderate_their_own_communitys_asset(world: World_) -> None:
    world.session.add(
        CommunityMember(
            community_id=world.community_id,
            user_id=world.admin.id,
            world_id=world.id,
            role=CommunityRole.STEWARD,
        )
    )
    world.session.commit()
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

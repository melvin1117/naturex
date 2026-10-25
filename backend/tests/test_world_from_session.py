"""The world comes from the session, never a client value (T73, ADR-0005 §2).

Anonymous requests and password sessions read the live world; a demo session reads its own
sandbox. Anonymous requests are read-only, and signed-in users trade as themselves.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, col, select

from app.auth import Principal
from app.config import get_settings
from app.db import get_session
from app.deps import world_for
from app.main import app, prepare_live_world
from app.middleware import SAFE_METHODS
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    Order,
    SessionKind,
    User,
    UserKind,
    UserRole,
    UserSession,
    World,
)
from app.routers.admin import get_time_machine_env
from app.routers.runs import get_rating_runner
from app.sandbox import _delete_world_rows, create_world, ensure_live_world, prune_stale_worlds
from app.seed import LIVE_WORLD_ID, seed
from app.seed import WORLD_ID as TEMPLATE_WORLD_ID
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import mock_time_machine_env, sign_in, start_demo

PASSWORD = "correct horse battery"
# Unsafe routes that stay open to anonymous callers: signing in, and signing out (a no-op).
# Session-creating routes anyone may call; `/demo/start` is the no-sign-up demo (T55), limited
# per IP and by the hourly world cap (tests/test_demo_sessions.py).
OPEN_UNSAFE = {"/auth/register", "/auth/login", "/auth/logout", "/demo/start"}


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so nothing persists."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        ensure_live_world(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_time_machine_env] = lambda: mock_time_machine_env(session)
    yield TestClient(app)
    app.dependency_overrides.clear()


def register(client: TestClient, email: str = "rosa@example.org") -> dict[str, Any]:
    res = client.post("/auth/register", json={"email": email, "password": PASSWORD, "name": "R"})
    assert res.status_code == 201, res.text
    body: dict[str, Any] = res.json()
    return body


def live_listed_asset(session: Session) -> Asset:
    ensure_live_world(session)
    return session.exec(
        select(Asset)
        .where(Asset.world_id == LIVE_WORLD_ID, Asset.status == AssetStatus.LISTED)
        .order_by(Asset.site_key)
    ).first() or pytest.fail("the live world has no listed asset")


def unsafe_routes() -> list[tuple[str, str]]:
    """Every unsafe (method, path) in the OpenAPI schema, the API's source of truth."""
    routes = [
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method in operations
        if method.upper() not in SAFE_METHODS and path not in OPEN_UNSAFE
    ]
    assert routes, "no unsafe routes found"
    return routes


# --- Anonymous: the live world, read-only ----------------------------------------------------


@requires_db
def test_anonymous_get_world_is_the_live_world_with_no_cookie(client: TestClient) -> None:
    res = client.get("/world")

    assert res.status_code == 200
    body = res.json()
    assert (UUID(body["id"]), body["label"], body["me"]) == (LIVE_WORLD_ID, "live", None)
    assert {a["site_key"] for a in body["assets"]}, "the curated sites are listed"
    assert "set-cookie" not in res.headers
    assert res.headers["cache-control"] == "no-store"


@requires_db
@pytest.mark.parametrize(("method", "path"), unsafe_routes())
def test_every_unsafe_world_route_is_401_for_anonymous_callers(
    client: TestClient, method: str, path: str
) -> None:
    url = re.sub(r"\{[^}]+\}", str(uuid4()), path)

    res = client.request(method, url, json={})

    assert (res.status_code, res.json()["detail"]) == (401, "auth_required"), url


@requires_db
def test_anonymous_orders_and_portfolio_are_401(session: Session, client: TestClient) -> None:
    asset = live_listed_asset(session)
    before = len(session.exec(select(Order).where(Order.asset_id == asset.id)).all())
    buy = client.post("/orders", json={"asset_id": str(asset.id), "side": "buy", "qty": 1})

    assert (buy.status_code, buy.json()["detail"]) == (401, "auth_required")
    assert client.get("/portfolio").status_code == 401
    assert len(session.exec(select(Order).where(Order.asset_id == asset.id)).all()) == before


# --- Password sessions: the live world, trading as themselves ---------------------------------


@requires_db
def test_register_then_buy_a_live_asset_shows_in_my_portfolio(
    session: Session, client: TestClient
) -> None:
    me = register(client)
    world = client.get("/world").json()
    assert UUID(world["id"]) == LIVE_WORLD_ID
    assert world["me"]["id"] == me["id"]
    asset = live_listed_asset(session)

    buy = client.post("/orders", json={"asset_id": str(asset.id), "side": "buy", "qty": 10})

    assert buy.status_code == 200, buy.text
    order = session.get_one(Order, UUID(buy.json()["id"]))
    assert (order.world_id, order.user_id) == (LIVE_WORLD_ID, UUID(me["id"]))
    portfolio = client.get("/portfolio").json()
    assert [(h["asset_id"], h["shares"]) for h in portfolio["holdings"]] == [(str(asset.id), 10)]
    assert Decimal(portfolio["cash_balance"]) < Decimal("10000.00")
    held = session.exec(select(Holding).where(Holding.user_id == UUID(me["id"]))).one()
    assert (held.asset_id, held.shares) == (asset.id, 10)


@requires_db
def test_two_accounts_each_trade_as_themselves(session: Session, client: TestClient) -> None:
    other = TestClient(app)
    register(client, "a@example.org")
    register(other, "b@example.org")
    asset = live_listed_asset(session)

    assert client.post(
        "/orders", json={"asset_id": str(asset.id), "side": "buy", "qty": 3}
    ).is_success

    assert len(client.get("/portfolio").json()["holdings"]) == 1
    assert other.get("/portfolio").json()["holdings"] == []
    assert Decimal(other.get("/portfolio").json()["cash_balance"]) == Decimal("10000.00")


@requires_db
def test_a_password_session_can_never_reset_the_live_world(
    session: Session, client: TestClient
) -> None:
    register(client)
    before = [a.id for a in session.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID))]

    res = client.post("/world/reset")

    assert (res.status_code, res.json()["detail"]) == (403, "demo_session_only")
    session.expire_all()
    after = [a.id for a in session.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID))]
    assert after == before


@requires_db
def test_a_password_session_outside_the_live_world_is_refused(
    session: Session, client: TestClient
) -> None:
    sandbox = create_world(session)
    stray = User(
        world_id=sandbox.id,
        name="P",
        role=UserRole.INVESTOR,
        kind=UserKind.PERSON,
        email="stray@example.org",
        password_hash="$argon2id$x",
    )
    session.add(stray)
    session.commit()
    sign_in(client, session, stray)

    res = client.get("/world")

    assert (res.status_code, res.json()["detail"]) == (401, "auth_required")


# --- Demo sessions: their own sandbox ---------------------------------------------------------


@requires_db
def test_a_demo_session_trades_as_its_persona_in_its_own_sandbox(
    session: Session, client: TestClient
) -> None:
    sandbox = start_demo(client, session)
    arjun = session.exec(
        select(User).where(User.world_id == sandbox.id, User.persona_key == "arjun")
    ).one()
    asset = session.exec(
        select(Asset).where(Asset.world_id == sandbox.id, Asset.status == AssetStatus.LISTED)
    ).first()
    assert asset is not None

    buy = client.post("/orders", json={"asset_id": str(asset.id), "side": "buy", "qty": 2})
    live_buy = client.post(
        "/orders",
        json={"asset_id": str(live_listed_asset(session).id), "side": "buy", "qty": 2},
    )

    assert buy.status_code == 200
    assert session.get_one(Order, UUID(buy.json()["id"])).user_id == arjun.id
    assert live_buy.status_code == 404, "a demo session never reaches the live world"
    assert UUID(client.get("/world").json()["id"]) == sandbox.id


@requires_db
def test_pruning_stale_sandboxes_never_touches_the_live_world(
    session: Session, client: TestClient
) -> None:
    register(client)
    stale = create_world(session)
    for world in (stale, session.get_one(World, LIVE_WORLD_ID)):
        world.last_seen_at = datetime.now(UTC) - timedelta(days=30)
        session.add(world)
    session.commit()

    assert prune_stale_worlds(session, older_than=timedelta(days=7)) == 1

    assert session.get(World, LIVE_WORLD_ID) is not None
    assert client.get("/me").status_code == 200, "live sessions survive the prune"


# --- Live-world writes that need more than an account (T73 review; T57 adds the role matrix) ---


class RecordingRunner:
    """Stands in for the rating runner: records starts, runs nothing, spends nothing."""

    def __init__(self) -> None:
        self.started: list[tuple[UUID, UUID]] = []

    def start(self, world_id: UUID, asset_id: UUID, **_: object) -> UUID:
        self.started.append((world_id, asset_id))
        return uuid4()


@pytest.fixture
def runner() -> Iterator[RecordingRunner]:
    fake = RecordingRunner()
    app.dependency_overrides[get_rating_runner] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_rating_runner, None)


def live_person(session: Session, *, is_admin: bool) -> User:
    user = User(
        world_id=LIVE_WORLD_ID,
        name="Admin" if is_admin else "Person",
        role=UserRole.ADMIN if is_admin else UserRole.INVESTOR,
        kind=UserKind.PERSON,
        email=f"{uuid4().hex[:8]}@example.org",
        password_hash="$argon2id$x",
        is_admin=is_admin,
    )
    session.add(user)
    session.commit()
    return user


@requires_db
def test_an_account_cannot_rate_simulate_or_tamper_in_the_live_world(
    session: Session, client: TestClient, runner: RecordingRunner
) -> None:
    register(client)
    asset = str(live_listed_asset(session).id)

    rate = client.post(f"/assets/{asset}/rate")
    event = client.post("/admin/simulate/event", json={"asset_id": asset, "preset": "fire"})
    quarter = client.post("/admin/simulate/quarter")
    tamper = client.post("/admin/tamper-demo", json={"asset_id": asset})

    for res in (rate, event, quarter, tamper):  # the tamper demo is for admins too (T57)
        assert (res.status_code, res.json()["detail"]) == (403, "admin_only")
    assert runner.started == []


@requires_db
def test_an_admin_can_rate_in_the_live_world_but_never_tamper(
    session: Session, client: TestClient, runner: RecordingRunner
) -> None:
    sign_in(client, session, live_person(session, is_admin=True))
    asset = live_listed_asset(session).id

    rate = client.post(f"/assets/{asset}/rate")
    tamper = client.post("/admin/tamper-demo", json={"asset_id": str(asset)})

    assert rate.status_code == 202, rate.text
    assert runner.started == [(LIVE_WORLD_ID, asset)]
    assert (tamper.status_code, tamper.json()["detail"]) == (403, "sandbox_only")


@requires_db
def test_the_demo_admin_can_rate_and_simulate_in_its_own_sandbox(
    session: Session, client: TestClient, runner: RecordingRunner
) -> None:
    sandbox = start_demo(client, session, persona_key="admin")
    asset = session.exec(select(Asset).where(Asset.world_id == sandbox.id)).first()
    assert asset is not None

    assert client.post(f"/assets/{asset.id}/rate").status_code == 202
    assert client.post(
        "/admin/simulate/event", json={"asset_id": str(asset.id), "preset": "fire"}
    ).is_success
    assert runner.started == [(sandbox.id, asset.id)]


@requires_db
def test_in_a_sandbox_investors_dont_rate_but_everyone_simulates(
    session: Session, client: TestClient, runner: RecordingRunner
) -> None:
    """A rating run is the operator's or the asset's community's (T57); the Time Machine is the
    sandbox's own demo control, so anyone acting in it injects events (ADR-0008)."""
    sandbox = start_demo(client, session)  # the demo investor
    asset = session.exec(
        select(Asset).where(Asset.world_id == sandbox.id).order_by(Asset.site_key)
    ).first()
    assert asset is not None
    event = {"asset_id": str(asset.id), "preset": "fire"}

    investor_rate = client.post(f"/assets/{asset.id}/rate")
    investor_event = client.post("/admin/simulate/event", json=event)
    start_demo(client, session, sandbox, persona_key="rosa")  # owns every seeded community
    owner_event = client.post("/admin/simulate/event", json={**event, "preset": "restoration"})
    owner_rate = client.post(f"/assets/{asset.id}/rate")

    assert (investor_rate.status_code, investor_rate.json()["detail"]) == (403, "admin_only")
    assert investor_event.status_code == 200, investor_event.text
    assert owner_event.status_code == 200, owner_event.text
    assert owner_rate.status_code == 202, owner_rate.text
    assert runner.started == [(sandbox.id, asset.id)]


@requires_db
def test_outside_a_sandbox_the_time_machine_stays_the_operators(
    session: Session, client: TestClient
) -> None:
    """ADR-0008 opens the Time Machine to everyone only inside a sandbox: a live-world account
    still can't read it, its alerts, or move the world."""
    asset = live_listed_asset(session)
    register(client)

    refused = [
        client.get("/admin/time-machine"),
        client.get("/admin/alerts", params={"ids": [str(uuid4())]}),
        client.post("/admin/simulate/quarter", json={"period": "2026Q4"}),
        client.post("/admin/simulate/event", json={"asset_id": str(asset.id), "preset": "fire"}),
    ]

    for res in refused:
        assert (res.status_code, res.json()["detail"]) == (403, "admin_only"), res.text


# --- Sessions that must never be served --------------------------------------------------------


def principal(world_id: UUID, kind: SessionKind) -> Principal:
    return Principal(
        user_id=uuid4(),
        world_id=world_id,
        session_id=uuid4(),
        session_kind=kind,
        user_kind=UserKind.PERSONA,
        is_admin=False,
    )


@requires_db
def test_a_demo_session_on_the_template_is_refused(session: Session, client: TestClient) -> None:
    start_demo(client, session, session.get_one(World, TEMPLATE_WORLD_ID))

    res = client.get("/world")

    assert (res.status_code, res.json()["detail"]) == (401, "auth_required")


@requires_db
@pytest.mark.parametrize(
    "bound",
    [
        (SessionKind.DEMO, "deleted"),
        (SessionKind.DEMO, "live"),
        (SessionKind.PASSWORD, "sandbox"),
        (cast(SessionKind, "sso"), "live"),
    ],
)
def test_sessions_bound_to_the_wrong_world_or_of_an_unknown_kind_are_refused(
    session: Session, bound: tuple[SessionKind, str]
) -> None:
    kind, where = bound
    world_id = {
        "deleted": uuid4(),
        "live": LIVE_WORLD_ID,
        "sandbox": create_world(session).id,
    }[where]

    with pytest.raises(HTTPException) as refused:
        world_for(session, principal(world_id, kind))

    assert (refused.value.status_code, refused.value.detail) == (401, "auth_required")


@requires_db
def test_a_session_whose_account_was_deleted_reads_the_live_world_anonymously(
    session: Session, client: TestClient
) -> None:
    user = live_person(session, is_admin=False)
    sign_in(client, session, user)
    session.execute(delete(UserSession).where(col(UserSession.user_id) == user.id))
    session.execute(delete(User).where(col(User.id) == user.id))
    session.commit()

    world = client.get("/world")

    assert world.status_code == 200
    assert (UUID(world.json()["id"]), world.json()["me"]) == (LIVE_WORLD_ID, None)
    assert client.get("/portfolio").status_code == 401


# --- The live world is created ahead of requests -----------------------------------------------


@requires_db
def test_reads_get_503_when_the_live_world_is_missing(session: Session, client: TestClient) -> None:
    _delete_world_rows(session, LIVE_WORLD_ID, keep_world=False)
    session.execute(delete(World).where(col(World.id) == LIVE_WORLD_ID))
    session.flush()

    res = client.get("/world")

    assert (res.status_code, res.json()["detail"]) == (503, "world_unavailable")
    assert session.get(World, LIVE_WORLD_ID) is None, "a request never creates the live world"


@requires_db
def test_startup_creates_the_live_world_and_never_fails(session: Session) -> None:
    @contextmanager
    def same_session() -> Iterator[Session]:
        yield session

    assert prepare_live_world(same_session) is True
    assert session.get(World, LIVE_WORLD_ID) is not None

    @contextmanager
    def broken() -> Iterator[Session]:
        raise OperationalError("SELECT 1", {}, Exception("database is down"))
        yield session

    assert prepare_live_world(broken) is False

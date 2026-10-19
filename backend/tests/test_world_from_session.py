"""The world comes from the session, never a client value (T73, ADR-0005 §2).

Anonymous requests and password sessions read the live world; a demo session reads its own
sandbox. Anonymous requests are read-only, and signed-in users trade as themselves.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.main import app
from app.middleware import SAFE_METHODS
from app.models import Asset, AssetStatus, Holding, Order, User, UserKind, UserRole, World
from app.sandbox import create_world, ensure_live_world, prune_stale_worlds
from app.seed import LIVE_WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import sign_in, start_demo

PASSWORD = "correct horse battery"
# Unsafe routes that stay open to anonymous callers: signing in, and signing out (a no-op).
OPEN_UNSAFE = {"/auth/register", "/auth/login", "/auth/logout"}


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so nothing persists."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
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

    assert (res.status_code, res.json()["detail"]) == (403, "demo_only")
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

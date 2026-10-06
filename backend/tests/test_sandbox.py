"""Per-visitor sandbox worlds (T31, demo-plan §3.5): copy, isolate, reset, prune."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session, select

from app.config import get_settings
from app.db import get_session
from app.ledger import append, entries_for, verify
from app.main import app
from app.models import Asset, Holding, LedgerEntry, LedgerKind, Order, OrderSide, Price, User, World
from app.sandbox import (
    COOKIE_NAME,
    create_world,
    prune_stale_worlds,
    reset_world,
)
from app.seed import COMMUNITY_PERSONA, DEMO_SITES, PERSONAS, WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

TEMPLATE_ASSET = DEMO_SITES[0].id


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test worlds never persist."""
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


def users(session: Session, world_id: UUID) -> list[User]:
    return list(session.exec(select(User).where(User.world_id == world_id)).all())


def assets(session: Session, world_id: UUID) -> list[Asset]:
    return list(session.exec(select(Asset).where(Asset.world_id == world_id)).all())


def persona(session: Session, world_id: UUID, key: str) -> User:
    return session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == key)
    ).one()


# --- Creating a world ------------------------------------------------------------------------


@requires_db
def test_new_world_copies_every_persona_and_demo_asset_with_fresh_ids(session: Session) -> None:
    world = create_world(session)

    copied_users = users(session, world.id)
    copied_assets = assets(session, world.id)
    assert {u.persona_key for u in copied_users} == {p.key for p in PERSONAS}
    assert {a.site_key for a in copied_assets} == {s.key for s in DEMO_SITES}
    assert not {u.id for u in copied_users} & {p.id for p in PERSONAS}
    assert not {a.id for a in copied_assets} & {s.id for s in DEMO_SITES}
    assert all(u.cash_balance == Decimal("10000.00") for u in copied_users)


@requires_db
def test_copied_assets_point_at_the_copied_community_persona(session: Session) -> None:
    world = create_world(session)

    rosa = persona(session, world.id, COMMUNITY_PERSONA.key)
    assert {a.community_user_id for a in assets(session, world.id)} == {rosa.id}


@requires_db
def test_template_holdings_prices_and_ledger_are_copied_and_remapped(session: Session) -> None:
    session.add(
        Holding(
            world_id=WORLD_ID,
            user_id=COMMUNITY_PERSONA.id,
            asset_id=TEMPLATE_ASSET,
            shares=510_000,
        )
    )
    session.add(
        Price(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, price=Decimal("7.9200"), reason="ipo")
    )
    append(
        session,
        world_id=WORLD_ID,
        asset_id=TEMPLATE_ASSET,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    append(
        session,
        world_id=WORLD_ID,
        asset_id=TEMPLATE_ASSET,
        kind=LedgerKind.PRICE_ANCHOR,
        payload={"price": "7.9200", "reason": "ipo"},
    )
    session.commit()

    world = create_world(session)

    wetland = session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.site_key == DEMO_SITES[0].key)
    ).one()
    rosa = persona(session, world.id, COMMUNITY_PERSONA.key)
    holding = session.exec(select(Holding).where(Holding.world_id == world.id)).one()
    assert (holding.user_id, holding.asset_id, holding.shares) == (rosa.id, wetland.id, 510_000)
    price = session.exec(select(Price).where(Price.world_id == world.id)).one()
    assert (price.asset_id, price.price, price.reason) == (wetland.id, Decimal("7.9200"), "ipo")
    copied = entries_for(session, wetland.id)
    assert [e.kind for e in copied] == [LedgerKind.LISTING, LedgerKind.PRICE_ANCHOR]
    assert verify(copied).valid, "a copied chain must still verify"


# --- Isolation -------------------------------------------------------------------------------


@requires_db
def test_trading_in_one_world_never_touches_another_or_the_template(session: Session) -> None:
    first, second = create_world(session), create_world(session)
    arjun = persona(session, first.id, "arjun")
    wetland = assets(session, first.id)[0]

    arjun.cash_balance = Decimal("1.00")
    wetland.community_wallet = Decimal("999.00")
    session.add(Holding(world_id=first.id, user_id=arjun.id, asset_id=wetland.id, shares=5))
    session.commit()

    assert persona(session, second.id, "arjun").cash_balance == Decimal("10000.00")
    assert persona(session, WORLD_ID, "arjun").cash_balance == Decimal("10000.00")
    assert all(a.community_wallet == Decimal("0.00") for a in assets(session, second.id))
    assert all(a.community_wallet == Decimal("0.00") for a in assets(session, WORLD_ID))
    assert session.exec(select(Holding).where(Holding.world_id == second.id)).all() == []


# --- Reset -----------------------------------------------------------------------------------


@requires_db
def test_reset_restores_the_template_state_and_keeps_the_world_id(session: Session) -> None:
    world = create_world(session)
    arjun = persona(session, world.id, "arjun")
    wetland = assets(session, world.id)[0]
    arjun.cash_balance = Decimal("42.00")
    session.add(Holding(world_id=world.id, user_id=arjun.id, asset_id=wetland.id, shares=7))
    session.add(
        Order(
            world_id=world.id,
            user_id=arjun.id,
            asset_id=wetland.id,
            side=OrderSide.BUY,
            qty=7,
            fill_price=Decimal("7.9300"),
        )
    )
    append(
        session,
        world_id=world.id,
        asset_id=wetland.id,
        kind=LedgerKind.EVENT,
        payload={"impact_type": "fire"},
    )
    session.commit()

    restored = reset_world(session, world.id)

    assert restored.id == world.id
    assert persona(session, world.id, "arjun").cash_balance == Decimal("10000.00")
    assert session.exec(select(Holding).where(Holding.world_id == world.id)).all() == []
    assert session.exec(select(Order).where(Order.world_id == world.id)).all() == []
    assert session.exec(select(LedgerEntry).where(LedgerEntry.world_id == world.id)).all() == []
    assert len(users(session, world.id)) == len(PERSONAS)
    assert len(assets(session, world.id)) == len(DEMO_SITES)


@requires_db
def test_the_template_world_can_never_be_reset(session: Session) -> None:
    with pytest.raises(ValueError):
        reset_world(session, WORLD_ID)


@requires_db
def test_reset_of_an_unknown_world_fails(session: Session) -> None:
    with pytest.raises(LookupError):
        reset_world(session, uuid4())


# --- Pruning ---------------------------------------------------------------------------------


@requires_db
def test_prune_removes_only_stale_visitor_worlds(session: Session) -> None:
    stale, fresh = create_world(session), create_world(session)
    stale_id, fresh_id = stale.id, fresh.id
    append(
        session,
        world_id=stale.id,
        asset_id=assets(session, stale.id)[0].id,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    long_ago = datetime.now(UTC) - timedelta(days=30)
    stale.last_seen_at = long_ago
    template = session.get(World, WORLD_ID)
    assert template is not None
    template.last_seen_at = long_ago
    session.commit()

    removed = prune_stale_worlds(session, older_than=timedelta(days=7))

    assert removed == 1
    assert session.get(World, stale_id) is None
    assert users(session, stale_id) == []
    assert session.get(World, fresh_id) is not None
    assert session.get(World, WORLD_ID) is not None, "the template is never pruned"


# --- API -------------------------------------------------------------------------------------


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


@requires_db
def test_first_visit_creates_a_world_and_sets_the_cookie(client: TestClient) -> None:
    res = client.get("/world")

    assert res.status_code == 200
    body = res.json()
    assert UUID(body["id"]) != WORLD_ID
    assert client.cookies.get(COOKIE_NAME) == body["id"]
    assert {p["key"] for p in body["personas"]} == {p.key for p in PERSONAS}
    assert {a["site_key"] for a in body["assets"]} == {s.key for s in DEMO_SITES}
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie


@requires_db
def test_returning_visitor_keeps_the_same_world(client: TestClient) -> None:
    first = client.get("/world").json()["id"]

    assert client.get("/world").json()["id"] == first


@pytest.mark.parametrize("cookie", ["not-a-uuid", str(uuid4()), str(WORLD_ID)])
@requires_db
def test_bad_unknown_or_template_cookie_gets_a_fresh_world(client: TestClient, cookie: str) -> None:
    client.cookies.set(COOKIE_NAME, cookie)

    body = client.get("/world").json()

    assert body["id"] != cookie
    assert UUID(body["id"]) != WORLD_ID


@requires_db
def test_reset_endpoint_restores_the_visitors_world(session: Session, client: TestClient) -> None:
    world_id = UUID(client.get("/world").json()["id"])
    persona(session, world_id, "arjun").cash_balance = Decimal("5.00")
    session.commit()

    res = client.post("/world/reset")

    assert res.status_code == 200
    assert UUID(res.json()["id"]) == world_id
    arjun = next(p for p in res.json()["personas"] if p["key"] == "arjun")
    assert Decimal(arjun["cash_balance"]) == Decimal("10000.00")


@requires_db
def test_ledger_of_another_worlds_asset_is_not_visible(client: TestClient) -> None:
    mine = client.get("/world").json()
    other = TestClient(app).get("/world").json()

    assert client.get(f"/ledger/{mine['assets'][0]['id']}").status_code == 200
    assert client.get(f"/ledger/{other['assets'][0]['id']}").status_code == 404

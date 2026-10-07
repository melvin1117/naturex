"""Orders and portfolio API (T17): the real market engine wired to Postgres, per visitor world."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, update
from sqlmodel import Session, col, func, select

from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    Order,
    Price,
    StreamEventType,
    User,
    World,
    WorldEvent,
)
from app.routers import market as market_router
from app.routers.market import place_order
from app.sandbox import _delete_world_rows, create_world, reset_world
from app.schemas import OrderCreate
from app.seed import WORLD_ID, demo_ipo_price, seed
from app.tools.earth_obs import load_site_metrics
from tests.conftest import alembic_cfg, requires_db

D = Decimal


def cents(value: Decimal) -> Decimal:
    """Round like the engine (half-up to cents)."""
    return value.quantize(D("0.01"), rounding=ROUND_HALF_UP)


STARTING_CASH = D("10000.00")
HERO = "wetland_mx"


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test trades never persist."""
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
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _world(client: TestClient) -> dict[str, Any]:
    """Create the visitor's world (sets the cookie) and return its contents."""
    res = client.get("/world")
    assert res.status_code == 200
    body: dict[str, Any] = res.json()
    return body


def _asset_id(world: dict[str, Any], site_key: str = HERO) -> str:
    return str(next(a["id"] for a in world["assets"] if a["site_key"] == site_key))


def _buy(client: TestClient, asset_id: str, qty: int) -> Any:
    return client.post("/orders", json={"asset_id": asset_id, "side": "buy", "qty": qty})


def _investor(session: Session, world_id: UUID) -> User:
    return session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == "arjun")
    ).one()


@requires_db
def test_seed_gives_every_listed_demo_asset_an_ipo_price(session: Session) -> None:
    hero = session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == HERO)
    ).one()
    prices = session.exec(
        select(Price).where(Price.world_id == WORLD_ID, Price.asset_id == hero.id)
    ).all()

    assert [p.reason for p in prices] == ["ipo"]
    assert prices[0].price == demo_ipo_price(load_site_metrics(HERO))


@requires_db
def test_primary_buy_persists_cash_float_wallet_order_price_and_event(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    world_id = UUID(world["id"])
    asset_id = _asset_id(world)
    asset_before = session.exec(select(Asset).where(Asset.id == UUID(asset_id))).one()
    float_before, wallet_before = (
        asset_before.primary_shares_remaining,
        asset_before.community_wallet,
    )
    ipo_price = demo_ipo_price(load_site_metrics(HERO))

    res = _buy(client, asset_id, 100)

    assert res.status_code == 200
    body = res.json()
    fill = D(body["fill_price"])
    cost = cents(fill * 100)
    assert fill > ipo_price
    assert body["is_primary"] is True

    session.expire_all()
    asset = session.exec(select(Asset).where(Asset.id == UUID(asset_id))).one()
    assert asset.primary_shares_remaining == float_before - 100
    assert asset.community_wallet == wallet_before + cost  # C4: IPO proceeds to the community
    assert _investor(session, world_id).cash_balance == STARTING_CASH - cost
    orders = session.exec(select(Order).where(Order.asset_id == asset.id)).all()
    assert [(o.qty, o.is_primary) for o in orders] == [(100, True)]
    latest = session.exec(
        select(Price).where(Price.asset_id == asset.id).order_by(col(Price.ts).desc())
    ).first()
    assert latest is not None and latest.reason == "order" and latest.price > ipo_price
    ticks = session.exec(
        select(WorldEvent).where(
            WorldEvent.world_id == world_id, WorldEvent.type == StreamEventType.PRICE_TICK
        )
    ).all()
    assert [t.payload["asset_id"] for t in ticks] == [asset_id]
    assert D(ticks[0].payload["price"]) == latest.price


@requires_db
def test_sell_fills_below_and_credits_cash_without_touching_the_wallet(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    asset_id = _asset_id(world)
    buy = _buy(client, asset_id, 100).json()
    session.expire_all()
    wallet_after_buy = session.exec(select(Asset).where(Asset.id == UUID(asset_id))).one()
    cash_after_buy = _investor(session, UUID(world["id"])).cash_balance

    res = client.post("/orders", json={"asset_id": asset_id, "side": "sell", "qty": 40})

    assert res.status_code == 200
    fill = D(res.json()["fill_price"])
    assert fill < D(buy["fill_price"])
    session.expire_all()
    asset = session.exec(select(Asset).where(Asset.id == UUID(asset_id))).one()
    assert asset.community_wallet == wallet_after_buy.community_wallet
    assert _investor(session, UUID(world["id"])).cash_balance == cash_after_buy + cents(fill * 40)


@requires_db
def test_buy_across_the_end_of_the_float_writes_primary_and_secondary_rows(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    asset_id = UUID(_asset_id(world))
    session.execute(
        update(Asset).where(col(Asset.id) == asset_id).values(primary_shares_remaining=5)
    )
    session.commit()
    wallet_before = session.exec(select(Asset).where(Asset.id == asset_id)).one().community_wallet

    res = _buy(client, str(asset_id), 20)

    assert res.status_code == 200
    fill = D(res.json()["fill_price"])
    session.expire_all()
    orders = session.exec(select(Order).where(Order.asset_id == asset_id)).all()
    assert sorted((o.qty, o.is_primary) for o in orders) == [(5, True), (15, False)]
    asset = session.exec(select(Asset).where(Asset.id == asset_id)).one()
    assert asset.primary_shares_remaining == 0
    assert asset.community_wallet == wallet_before + cents(fill * 5)


@requires_db
def test_portfolio_reflects_the_holding_after_a_buy(client: TestClient) -> None:
    world = _world(client)
    asset_id = _asset_id(world)
    _buy(client, asset_id, 100)

    res = client.get("/portfolio")

    assert res.status_code == 200
    body = res.json()
    holding = next(h for h in body["holdings"] if h["asset_id"] == asset_id)
    assert holding["shares"] == 100
    assert D(body["cash_balance"]) < STARTING_CASH


@requires_db
def test_insufficient_cash_is_rejected_without_changes(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    mangrove = _asset_id(world, "mangrove_mx")  # IPO ≈ $285/share: 100 shares > $10,000

    res = _buy(client, mangrove, 100)

    assert res.status_code == 400
    session.expire_all()
    assert _investor(session, UUID(world["id"])).cash_balance == STARTING_CASH
    assert session.exec(select(Order).where(Order.asset_id == UUID(mangrove))).all() == []


@requires_db
def test_sell_without_a_holding_is_rejected(client: TestClient) -> None:
    world = _world(client)
    res = client.post("/orders", json={"asset_id": _asset_id(world), "side": "sell", "qty": 1})

    assert res.status_code == 400


@requires_db
def test_order_rejects_a_zero_quantity(client: TestClient) -> None:
    world = _world(client)
    res = _buy(client, _asset_id(world), 0)

    assert res.status_code == 422


@requires_db
def test_unlisted_asset_returns_409(client: TestClient, session: Session) -> None:
    world = _world(client)
    asset_id = UUID(_asset_id(world))
    session.execute(
        update(Asset).where(col(Asset.id) == asset_id).values(status=AssetStatus.RATING)
    )
    session.commit()

    assert _buy(client, str(asset_id), 1).status_code == 409


@requires_db
def test_asset_without_a_price_returns_409(client: TestClient, session: Session) -> None:
    world = _world(client)
    asset_id = UUID(_asset_id(world))
    session.execute(delete(Price).where(col(Price.asset_id) == asset_id))
    session.commit()

    assert _buy(client, str(asset_id), 1).status_code == 409


@requires_db
def test_orders_are_scoped_to_the_visitors_world(client: TestClient, session: Session) -> None:
    _world(client)
    template_asset = session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == HERO)
    ).one()

    assert _buy(client, str(template_asset.id), 1).status_code == 404
    assert _buy(client, "00000000-0000-0000-0000-000000000000", 1).status_code == 404


@requires_db
def test_orders_and_portfolio_need_a_world(session: Session) -> None:
    app.dependency_overrides[get_session] = lambda: session
    try:
        with TestClient(app) as anonymous:
            assert anonymous.get("/portfolio").status_code == 401
            assert _buy(anonymous, "00000000-0000-0000-0000-000000000000", 1).status_code == 401
    finally:
        app.dependency_overrides.clear()


@requires_db
def test_concurrent_buys_conserve_cash_shares_and_the_float() -> None:
    """Regression for the lost-update race: N simultaneous buys on one asset (committed data)."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    threads, qty = 12, 10
    with Session(engine) as setup:
        seed(setup)
        world = create_world(setup)
        world_id = world.id
    try:
        with Session(engine) as db:
            asset = db.exec(
                select(Asset).where(Asset.world_id == world_id, Asset.site_key == HERO)
            ).one()
            asset_id, float_before, wallet_before = (
                asset.id,
                asset.primary_shares_remaining,
                asset.community_wallet,
            )
        barrier = threading.Barrier(threads)

        def buy_once() -> int:
            with Session(engine) as db:
                current = db.get_one(World, world_id)
                barrier.wait(timeout=10)
                try:
                    place_order(OrderCreate(asset_id=asset_id, side="buy", qty=qty), current, db)
                    return 200
                except HTTPException as exc:
                    db.rollback()
                    return exc.status_code

        with ThreadPoolExecutor(max_workers=threads) as pool:
            codes = [f.result(timeout=30) for f in [pool.submit(buy_once) for _ in range(threads)]]

        assert codes == [200] * threads
        with Session(engine) as check:
            orders = check.exec(select(Order).where(Order.asset_id == asset_id)).all()
            investor = _investor(check, world_id)
            holding = check.get_one(Holding, (world_id, investor.id, asset_id))
            asset = check.get_one(Asset, asset_id)
            paid = sum((cents(o.fill_price * o.qty) for o in orders), D("0.00"))
            ticks = check.exec(
                select(func.count()).where(
                    WorldEvent.world_id == world_id, WorldEvent.type == StreamEventType.PRICE_TICK
                )
            ).one()

            assert sum(o.qty for o in orders) == holding.shares == threads * qty
            assert investor.cash_balance == STARTING_CASH - paid
            assert asset.primary_shares_remaining == float_before - threads * qty
            assert asset.community_wallet == wallet_before + paid
            assert ticks == threads
    finally:
        with Session(engine) as cleanup:
            _delete_world_rows(cleanup, world_id, keep_world=False)
            cleanup.execute(delete(World).where(col(World.id) == world_id))
            cleanup.commit()
        engine.dispose()


@requires_db
def test_order_and_reset_on_the_same_world_serialise_without_deadlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An order holding its row locks must make a concurrent reset wait, not deadlock."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as setup:
        seed(setup)
        world = create_world(setup)
        world_id = world.id
    order_has_locks = threading.Event()
    real_execute = market_router.execute

    def slow_execute(*args: Any, **kwargs: Any) -> Any:
        order_has_locks.set()
        threading.Event().wait(0.8)
        return real_execute(*args, **kwargs)

    monkeypatch.setattr(market_router, "execute", slow_execute)
    try:
        with Session(engine) as db:
            hero = db.exec(
                select(Asset).where(Asset.world_id == world_id, Asset.site_key == HERO)
            ).one()
            hero_id = hero.id

        def order() -> str:
            with Session(engine) as db:
                current = db.get_one(World, world_id)
                place_order(OrderCreate(asset_id=hero_id, side="buy", qty=10), current, db)
                return "ok"

        def reset() -> str:
            assert order_has_locks.wait(timeout=10)
            with Session(engine) as db:
                reset_world(db, world_id)
                return "reset"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [f.result(timeout=30) for f in (pool.submit(order), pool.submit(reset))]

        assert results == ["ok", "reset"]
        with Session(engine) as check:
            # The reset ran after the order committed, so the world is back to the template.
            assert _investor(check, world_id).cash_balance == STARTING_CASH
            assert check.exec(select(Order).where(Order.world_id == world_id)).all() == []
    finally:
        with Session(engine) as cleanup:
            _delete_world_rows(cleanup, world_id, keep_world=False)
            cleanup.execute(delete(World).where(col(World.id) == world_id))
            cleanup.commit()
        engine.dispose()

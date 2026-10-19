"""Orders and portfolio API (T17): the real market engine wired to Postgres, per world.

The client trades in a private demo sandbox as the `arjun` persona (tests.worlds.start_demo);
the live world and password accounts are covered in test_world_from_session.py.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, update
from sqlmodel import Session, col, func, select

from app.auth import Principal
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.market.engine import (
    InsufficientCash,
    InsufficientShares,
    InsufficientSupply,
    MarketError,
    OrderTooLarge,
)
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    Order,
    Price,
    SessionKind,
    StreamEventType,
    User,
    World,
    WorldEvent,
)
from app.routers import market as market_router
from app.routers.market import get_quote, place_order
from app.sandbox import _delete_world_rows, create_world, ensure_live_world, reset_world
from app.schemas import OrderCreate
from app.seed import WORLD_ID, demo_ipo_price, seed
from app.tools.earth_obs import load_site_metrics
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import start_demo

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
    """A client signed in to a fresh demo sandbox as the investor persona."""
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app) as test_client:
        start_demo(test_client, session)
        yield test_client
    app.dependency_overrides.clear()


def _world(client: TestClient) -> dict[str, Any]:
    """The client's sandbox world and its contents."""
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


def _as(user: User) -> Principal:
    """The principal of a demo session for `user`, for calling the route function directly."""
    return Principal(
        user_id=user.id,
        world_id=user.world_id,
        session_id=uuid4(),
        session_kind=SessionKind.DEMO,
        user_kind=user.kind,
        is_admin=user.is_admin,
    )


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
    assert (D(body["total"]), body["primary_qty"], D(body["community_amount"])) == (cost, 100, cost)
    assert (D(body["cash_balance"]), body["shares_held"]) == (STARTING_CASH - cost, 100)

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
    assert D(res.json()["total"]) == cents(fill * 40)
    assert (res.json()["primary_qty"], D(res.json()["community_amount"])) == (0, D("0"))
    assert D(res.json()["cash_balance"]) == cash_after_buy + cents(fill * 40)
    assert res.json()["shares_held"] == 60
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

    assert (res.status_code, res.json()["detail"]) == (409, "insufficient_cash")
    session.expire_all()
    assert _investor(session, UUID(world["id"])).cash_balance == STARTING_CASH
    assert session.exec(select(Order).where(Order.asset_id == UUID(mangrove))).all() == []


@requires_db
def test_sell_without_a_holding_is_rejected(client: TestClient) -> None:
    world = _world(client)
    res = client.post("/orders", json={"asset_id": _asset_id(world), "side": "sell", "qty": 1})

    assert (res.status_code, res.json()["detail"]) == (409, "insufficient_shares")


@requires_db
def test_order_above_the_size_cap_is_400_order_too_large(client: TestClient) -> None:
    res = _buy(client, _asset_id(_world(client)), 10_001)

    assert (res.status_code, res.json()["detail"]) == (400, "order_too_large")


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
def test_orders_are_scoped_to_the_sessions_world(client: TestClient, session: Session) -> None:
    _world(client)
    template_asset = session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == HERO)
    ).one()

    assert _buy(client, str(template_asset.id), 1).status_code == 404
    assert _buy(client, "00000000-0000-0000-0000-000000000000", 1).status_code == 404


@requires_db
def test_orders_and_portfolio_need_a_session(session: Session) -> None:
    app.dependency_overrides[get_session] = lambda: session
    try:
        with TestClient(app) as anonymous:
            for res in (
                anonymous.get("/portfolio"),
                _buy(anonymous, "00000000-0000-0000-0000-000000000000", 1),
            ):
                assert (res.status_code, res.json()["detail"]) == (401, "auth_required")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize(
    ("exc", "status_code", "code"),
    [
        (OrderTooLarge("too big"), 400, "order_too_large"),
        (InsufficientCash("cash"), 409, "insufficient_cash"),
        (InsufficientShares("shares"), 409, "insufficient_shares"),
        (InsufficientSupply("supply"), 409, "insufficient_supply"),
    ],
)
def test_engine_rejections_map_to_stable_codes(
    exc: MarketError, status_code: int, code: str
) -> None:
    http = market_router._rejected(exc)

    assert (http.status_code, http.detail) == (status_code, code)


# --- Quotes (T18) ----------------------------------------------------------------------------


def _quote(client: TestClient, asset_id: str, side: str, qty: int) -> Any:
    return client.get(f"/assets/{asset_id}/quote", params={"side": side, "qty": qty})


@requires_db
def test_quote_matches_the_fill_of_the_order_placed_right_after(client: TestClient) -> None:
    asset_id = _asset_id(_world(client))

    quote = _quote(client, asset_id, "buy", 10)
    order = _buy(client, asset_id, 10)

    assert quote.status_code == 200 and order.status_code == 200
    body = quote.json()
    assert D(body["fill_price"]) == D(order.json()["fill_price"])
    assert D(body["fill_price"]) > D(body["price"])
    assert D(body["total"]) == cents(D(body["fill_price"]) * 10)
    assert body["primary_qty"] == 10
    assert D(body["community_amount"]) == D(body["total"])
    assert D(body["slippage_pct"]) > 0
    assert body["max_order_qty"] == 10_000


@requires_db
def test_quote_reports_the_largest_order_the_user_can_place(client: TestClient) -> None:
    asset_id = _asset_id(_world(client), "mangrove_mx")  # ≈ $285/share

    buy = _quote(client, asset_id, "buy", 1).json()
    sell = _quote(client, asset_id, "sell", 1).json()

    assert 0 < buy["max_qty"] < 100
    assert _buy(client, asset_id, buy["max_qty"]).status_code == 200
    assert sell["max_qty"] == 0
    assert _quote(client, asset_id, "sell", 1).json()["max_qty"] == buy["max_qty"]


# --- Price protection (T18) ------------------------------------------------------------------


@requires_db
def test_buy_above_max_total_is_refused_as_price_moved_without_changes(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    asset_id = _asset_id(world)
    quoted = D(_quote(client, asset_id, "buy", 10).json()["total"])

    res = client.post(
        "/orders",
        json={"asset_id": asset_id, "side": "buy", "qty": 10, "max_total": str(quoted - D("0.01"))},
    )

    assert (res.status_code, res.json()["detail"]) == (409, "price_moved")
    session.expire_all()
    assert _investor(session, UUID(world["id"])).cash_balance == STARTING_CASH
    assert session.exec(select(Order).where(Order.asset_id == UUID(asset_id))).all() == []


@requires_db
def test_buy_at_the_quoted_total_fills(client: TestClient) -> None:
    asset_id = _asset_id(_world(client))
    quoted = _quote(client, asset_id, "buy", 10).json()["total"]

    res = client.post(
        "/orders", json={"asset_id": asset_id, "side": "buy", "qty": 10, "max_total": quoted}
    )

    assert res.status_code == 200
    assert res.json()["total"] == quoted


@requires_db
def test_sell_below_min_total_is_refused_as_price_moved(client: TestClient) -> None:
    asset_id = _asset_id(_world(client))
    _buy(client, asset_id, 20)
    quoted = D(_quote(client, asset_id, "sell", 10).json()["total"])

    refused = client.post(
        "/orders",
        json={"asset_id": asset_id, "side": "sell", "qty": 10, "min_total": str(quoted + 1)},
    )
    filled = client.post(
        "/orders",
        json={"asset_id": asset_id, "side": "sell", "qty": 10, "min_total": str(quoted)},
    )

    assert (refused.status_code, refused.json()["detail"]) == (409, "price_moved")
    assert filled.status_code == 200 and filled.json()["shares_held"] == 10


@requires_db
@pytest.mark.parametrize(
    "order",
    [
        {"side": "buy", "qty": 1, "min_total": "1"},
        {"side": "sell", "qty": 1, "max_total": "1"},
        {"side": "buy", "qty": 1, "max_total": "-1"},
    ],
)
def test_price_limits_must_match_the_side(client: TestClient, order: dict[str, Any]) -> None:
    res = client.post("/orders", json={"asset_id": _asset_id(_world(client)), **order})

    assert res.status_code == 422


@requires_db
def test_quote_without_a_session_has_no_max_qty(client: TestClient, session: Session) -> None:
    world = _world(client)
    sandbox = session.get(World, UUID(world["id"]))
    assert sandbox is not None

    quote = get_quote(UUID(_asset_id(world)), sandbox, None, session, side="buy", qty=1)

    assert quote.max_qty is None and quote.fill_price > quote.price


@requires_db
@pytest.mark.parametrize(
    ("params", "status_code"),
    [
        ({"side": "buy", "qty": 0}, 422),
        ({"side": "hold", "qty": 1}, 422),
        ({"side": "buy"}, 422),
        ({"side": "buy", "qty": 10_001}, 400),
    ],
)
def test_quote_validates_side_and_quantity(
    client: TestClient, params: dict[str, Any], status_code: int
) -> None:
    res = client.get(f"/assets/{_asset_id(_world(client))}/quote", params=params)

    assert res.status_code == status_code


@requires_db
def test_quote_refuses_unlisted_unpriced_and_other_worlds_assets(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    wetland, forest = UUID(_asset_id(world)), UUID(_asset_id(world, "restoration_forest"))
    template = session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == HERO)
    ).one()
    session.execute(update(Asset).where(col(Asset.id) == wetland).values(status=AssetStatus.RATING))
    session.execute(delete(Price).where(col(Price.asset_id) == forest))
    session.commit()

    assert _quote(client, str(wetland), "buy", 1).status_code == 409
    assert _quote(client, str(forest), "buy", 1).status_code == 409
    assert _quote(client, str(template.id), "buy", 1).status_code == 404


@requires_db
def test_anonymous_quote_reads_the_live_world_without_max_qty(session: Session) -> None:
    ensure_live_world(session)
    template = session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == HERO)
    ).one()
    app.dependency_overrides[get_session] = lambda: session
    try:
        with TestClient(app) as anonymous:
            live = next(a for a in anonymous.get("/assets").json() if a["price"] is not None)
            res = _quote(anonymous, live["id"], "buy", 1)
            other_world = _quote(anonymous, str(template.id), "buy", 1)
    finally:
        app.dependency_overrides.clear()

    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    assert res.json()["max_qty"] is None
    assert D(res.json()["price"]) == D(live["price"])
    assert other_world.status_code == 404


# --- Portfolio valuation (T18) ---------------------------------------------------------------


@requires_db
def test_portfolio_values_holdings_and_totals_at_the_latest_price(client: TestClient) -> None:
    asset_id = _asset_id(_world(client))
    fill = D(_buy(client, asset_id, 100).json()["fill_price"])

    body = client.get("/portfolio").json()

    holding = next(h for h in body["holdings"] if h["asset_id"] == asset_id)
    mark, avg = D(holding["mark_price"]), D(holding["avg_cost"])
    assert avg == fill
    assert D(holding["market_value"]) == cents(mark * 100)
    assert D(holding["cost_basis"]) == cents(fill * 100)
    assert D(holding["unrealized_pnl"]) == D(holding["market_value"]) - D(holding["cost_basis"])
    pnl_pct = D(holding["unrealized_pnl"]) / D(holding["cost_basis"]) * 100
    assert D(holding["unrealized_pnl_pct"]) == pnl_pct.quantize(D("0.01"), ROUND_HALF_UP)
    assert D(body["holdings_value"]) == D(holding["market_value"])
    assert D(body["total_value"]) == D(body["cash_balance"]) + D(body["holdings_value"])
    assert D(body["unrealized_pnl"]) == D(holding["unrealized_pnl"])
    assert D(body["unrealized_pnl_pct"]) == D(holding["unrealized_pnl_pct"])


@requires_db
def test_partial_sell_keeps_the_average_cost(client: TestClient) -> None:
    asset_id = _asset_id(_world(client))
    fill = D(_buy(client, asset_id, 100).json()["fill_price"])
    client.post("/orders", json={"asset_id": asset_id, "side": "sell", "qty": 40})

    holding = next(
        h for h in client.get("/portfolio").json()["holdings"] if h["asset_id"] == asset_id
    )

    assert holding["shares"] == 60
    assert D(holding["avg_cost"]) == fill
    assert D(holding["cost_basis"]) == cents(fill * 60)


@requires_db
def test_a_holding_without_a_price_is_left_out_of_the_totals(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    wetland, forest = _asset_id(world), _asset_id(world, "restoration_forest")
    _buy(client, wetland, 10)
    _buy(client, forest, 10)
    session.execute(delete(Price).where(col(Price.asset_id) == UUID(forest)))
    session.commit()

    body = client.get("/portfolio").json()

    unpriced = next(h for h in body["holdings"] if h["asset_id"] == forest)
    priced = next(h for h in body["holdings"] if h["asset_id"] == wetland)
    assert unpriced["mark_price"] is None and unpriced["market_value"] is None
    assert unpriced["unrealized_pnl"] is None
    assert D(body["holdings_value"]) == D(priced["market_value"])
    assert D(body["cost_basis"]) == D(priced["cost_basis"])
    assert D(body["total_value"]) == D(body["cash_balance"]) + D(priced["market_value"])


@requires_db
def test_empty_portfolio_totals_are_cash_only(client: TestClient) -> None:
    body = client.get("/portfolio").json()

    assert body["holdings"] == []
    assert D(body["total_value"]) == D(body["cash_balance"]) == STARTING_CASH
    assert D(body["holdings_value"]) == D(body["unrealized_pnl"]) == D("0")
    assert body["unrealized_pnl_pct"] is None
    assert (D(body["starting_cash"]), D(body["since_start"])) == (STARTING_CASH, D("0"))


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
                actor = _as(_investor(db, world_id))
                barrier.wait(timeout=10)
                try:
                    place_order(
                        OrderCreate(asset_id=asset_id, side="buy", qty=qty), current, actor, db
                    )
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
                actor = _as(_investor(db, world_id))
                place_order(OrderCreate(asset_id=hero_id, side="buy", qty=10), current, actor, db)
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

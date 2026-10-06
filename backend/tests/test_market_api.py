"""Orders and portfolio API (T17): the real market engine wired to Postgres."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session

from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import Price
from app.seed import DEMO_SITES, WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

ASSET_ID = DEMO_SITES[0].id
IPO_PRICE = Decimal("10.0000")


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test trades never persist."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        db.add(Price(world_id=WORLD_ID, asset_id=ASSET_ID, price=IPO_PRICE, reason="ipo"))
        db.commit()
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


@requires_db
def test_buy_order_fills_above_the_current_price(client: TestClient) -> None:
    res = client.post("/orders", json={"asset_id": str(ASSET_ID), "side": "buy", "qty": 100})

    assert res.status_code == 200
    body = res.json()
    assert Decimal(body["fill_price"]) > IPO_PRICE
    assert body["is_primary"] is True


@requires_db
def test_sell_order_fills_below_the_current_price(client: TestClient) -> None:
    buy = client.post("/orders", json={"asset_id": str(ASSET_ID), "side": "buy", "qty": 100})

    res = client.post("/orders", json={"asset_id": str(ASSET_ID), "side": "sell", "qty": 40})

    assert res.status_code == 200
    assert Decimal(res.json()["fill_price"]) < Decimal(buy.json()["fill_price"])


@requires_db
def test_portfolio_reflects_the_holding_after_a_buy(client: TestClient) -> None:
    client.post("/orders", json={"asset_id": str(ASSET_ID), "side": "buy", "qty": 100})

    res = client.get("/portfolio")

    assert res.status_code == 200
    body = res.json()
    holding = next(h for h in body["holdings"] if h["asset_id"] == str(ASSET_ID))
    assert holding["shares"] == 100
    assert Decimal(body["cash_balance"]) < Decimal("10000.00")


@requires_db
def test_orders_404_for_an_unknown_asset(client: TestClient) -> None:
    res = client.post(
        "/orders",
        json={"asset_id": "00000000-0000-0000-0000-000000000000", "side": "buy", "qty": 1},
    )

    assert res.status_code == 404


@requires_db
def test_sell_without_a_holding_is_rejected(client: TestClient) -> None:
    res = client.post("/orders", json={"asset_id": str(ASSET_ID), "side": "sell", "qty": 1})

    assert res.status_code == 400


@requires_db
def test_order_rejects_a_zero_quantity(client: TestClient) -> None:
    res = client.post("/orders", json={"asset_id": str(ASSET_ID), "side": "buy", "qty": 0})

    assert res.status_code == 422

"""Orders and portfolio (mock fills)."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, HTTPException

from app import mocks
from app.schemas import OrderCreate, OrderOut, PortfolioOut

router = APIRouter(tags=["market"])


@router.post("/orders", response_model=OrderOut)
def place_order(body: OrderCreate) -> OrderOut:
    asset = mocks.get_asset(body.asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    price = asset.price or Decimal("100.0000")
    slip = Decimal("0.001")
    fill = price * (Decimal("1") + slip) if body.side == "buy" else price * (Decimal("1") - slip)
    return OrderOut(
        id=uuid4(),
        asset_id=body.asset_id,
        side=body.side,
        qty=body.qty,
        fill_price=fill.quantize(Decimal("0.0001")),
        is_primary=body.side == "buy",
        created_at=datetime.now(UTC),
    )


@router.get("/portfolio", response_model=PortfolioOut)
def get_portfolio() -> PortfolioOut:
    return mocks.portfolio()

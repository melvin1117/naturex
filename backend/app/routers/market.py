"""Orders, quotes and portfolio (dev-spec §6, §8): persisted against the real market engine.

Concurrency: every order first takes a KEY SHARE lock on its world row, so it waits behind a
"Reset my demo" (which holds the world row FOR UPDATE) instead of deadlocking with it, while
orders don't block each other. It then locks the asset row and the trader's user row (the same
order as the revenue payout in `market/revenue.py`), so orders and payouts on one asset are
serialised and balances, holdings and the primary float can't lose updates.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func
from sqlmodel import Session, col, select

from app import events
from app.auth import STARTING_CASH, Principal
from app.deps import (
    AUTH_REQUIRED,
    CurrentPrincipal,
    CurrentWorld,
    OptionalPrincipal,
    SessionDep,
)
from app.market.engine import (
    InvalidOrder,
    MarketError,
    MarketState,
    Position,
    TradeResult,
    execute,
    max_fillable_qty,
    max_order_qty,
    preview,
)
from app.market.portfolio import HoldingValue, portfolio_totals, value_holding
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    Order,
    OrderSide,
    Price,
    StreamEventType,
    User,
    World,
)
from app.schemas import (
    HoldingOut,
    ImpactSummary,
    OrderCreate,
    OrderOut,
    PortfolioOut,
    QuoteOut,
)

router = APIRouter(tags=["market"])

NOT_LISTED = "Asset is not listed for trading"
NO_PRICE = "Asset has no price yet"
PRICE_MOVED = "price_moved"
ORDER_ERRORS: dict[int | str, dict[str, str]] = {
    400: {"description": "`order_too_large`: above the per-order size cap"},
    404: {"description": "Asset not in the session's world"},
    409: {
        "description": "Asset not listed or without a price; `insufficient_cash`, "
        "`insufficient_shares`, `insufficient_supply`, or `price_moved` (the total is above "
        "`max_total` or below `min_total`)"
    },
}
QUOTE_ERRORS: dict[int | str, dict[str, str]] = {
    400: {"description": "`order_too_large`: above the per-order size cap"},
    404: {"description": "Asset not in the session's world"},
    409: {"description": "Asset not listed or without a price"},
}


def _rejected(exc: MarketError) -> HTTPException:
    """Engine rejections as stable codes: 400 for the order itself, 409 for the state it meets."""
    code = (
        status.HTTP_400_BAD_REQUEST if isinstance(exc, InvalidOrder) else status.HTTP_409_CONFLICT
    )
    return HTTPException(code, exc.code)


def _actor(session: Session, world_id: UUID, principal: Principal, *, lock: bool = False) -> User:
    """The signed-in user, who trades as themselves (ADR-0005 §3); never a client-supplied ID."""
    stmt = select(User).where(User.world_id == world_id, User.id == principal.user_id)
    if lock:
        stmt = stmt.with_for_update()
    user = session.exec(stmt).first()
    if user is None:  # deleted between resolving the session and now
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, AUTH_REQUIRED)
    return user


def _lock_world(session: Session, world_id: UUID) -> None:
    session.exec(select(World.id).where(World.id == world_id).with_for_update(key_share=True)).one()


def _locked_asset(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id).with_for_update()
    ).first()
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    return asset


def _latest_price(session: Session, asset: Asset) -> Decimal | None:
    stmt = (
        select(col(Price.price))
        .where(Price.world_id == asset.world_id, Price.asset_id == asset.id)
        .order_by(col(Price.ts).desc())
        .limit(1)
    )
    return session.exec(stmt).first()


def _market_maker_shares(session: Session, asset: Asset) -> int:
    """total_shares = primary_shares_remaining + market_maker_shares + sum(holdings)."""
    held = session.exec(
        select(func.coalesce(func.sum(Holding.shares), 0)).where(
            Holding.world_id == asset.world_id, Holding.asset_id == asset.id
        )
    ).one()
    return asset.total_shares - asset.primary_shares_remaining - int(held)


def _tradable_market(session: Session, asset: Asset, *, with_inventory: bool = True) -> MarketState:
    """The asset's market now; 409 if it isn't listed or has no price yet.

    `with_inventory=False` skips summing the holdings for the market maker's inventory (left at
    0): only buys' supply checks need it, and a quote's pricing doesn't.
    """
    if asset.status != AssetStatus.LISTED:
        raise HTTPException(status.HTTP_409_CONFLICT, NOT_LISTED)
    price = _latest_price(session, asset)
    if price is None:
        raise HTTPException(status.HTTP_409_CONFLICT, NO_PRICE)
    return MarketState(
        price=price,
        total_shares=asset.total_shares,
        primary_shares_remaining=asset.primary_shares_remaining,
        market_maker_shares=_market_maker_shares(session, asset) if with_inventory else 0,
        community_wallet=asset.community_wallet,
    )


def _price_moved(body: OrderCreate, total: Decimal) -> bool:
    """The fill is worse than the total the user confirmed (`max_total` / `min_total`)."""
    if body.max_total is not None and total > body.max_total:
        return True
    return body.min_total is not None and total < body.min_total


def _holding(session: Session, world_id: UUID, user_id: UUID, asset_id: UUID) -> Holding:
    holding = session.get(Holding, (world_id, user_id, asset_id))
    if holding is None:
        holding = Holding(world_id=world_id, user_id=user_id, asset_id=asset_id)
    return holding


def _order_rows(
    world_id: UUID, user_id: UUID, asset_id: UUID, side: OrderSide, qty: int, result: TradeResult
) -> list[Order]:
    """One row per source: the primary-float part (pays the community) and the rest."""
    parts = [(result.primary_qty, True), (qty - result.primary_qty, False)]
    return [
        Order(
            world_id=world_id,
            user_id=user_id,
            asset_id=asset_id,
            side=side,
            qty=part_qty,
            fill_price=result.fill_price,
            is_primary=is_primary,
        )
        for part_qty, is_primary in parts
        if part_qty > 0
    ]


@router.post("/orders", response_model=OrderOut, responses=ORDER_ERRORS)
def place_order(
    body: OrderCreate, world: CurrentWorld, principal: CurrentPrincipal, session: SessionDep
) -> OrderOut:
    """Fill a market order for the signed-in user. `is_primary` is true if any shares came from
    the IPO float. With `max_total` (buy) or `min_total` (sell), a fill worse than the quote the
    user confirmed is refused with 409 `price_moved` and nothing changes."""
    _lock_world(session, world.id)
    # After a concurrent reset the world has fresh asset ids, so a stale id is a 404.
    asset = _locked_asset(session, world.id, body.asset_id)
    actor = _actor(session, world.id, principal, lock=True)
    # TODO(T57): re-check TRADE after locking the user (T68 review):
    # `enforce(fresh_actor(session, principal), Action.TRADE, AssetRef(...))`, so a membership
    # committed while this order waited on the lock blocks the buy.
    market = _tradable_market(session, asset)
    holding = _holding(session, world.id, actor.id, asset.id)
    trader = Position(cash=actor.cash_balance, shares=holding.shares, avg_cost=holding.avg_cost)
    side = OrderSide(body.side)

    try:
        result = execute(market, trader, side, body.qty)
    except MarketError as exc:
        raise _rejected(exc) from exc
    if _price_moved(body, result.cash_amount):
        raise HTTPException(status.HTTP_409_CONFLICT, PRICE_MOVED)

    asset.primary_shares_remaining = result.market.primary_shares_remaining
    asset.community_wallet = result.market.community_wallet
    actor.cash_balance = result.trader.cash
    holding.shares = result.trader.shares
    holding.avg_cost = result.trader.avg_cost
    orders = _order_rows(world.id, actor.id, asset.id, side, body.qty, result)
    new_price = Price(
        world_id=world.id,
        asset_id=asset.id,
        price=result.price_change.price,
        reason=result.price_change.reason.value,
    )

    session.add_all([asset, actor, holding, *orders, new_price])
    session.flush()
    events.publish(
        session,
        world.id,
        StreamEventType.PRICE_TICK,
        {
            "asset_id": str(asset.id),
            "price": str(result.price_change.price),
            "reason": result.price_change.reason.value,
        },
    )
    session.commit()

    first = orders[0]
    return OrderOut(
        id=first.id,
        asset_id=asset.id,
        side=body.side,
        qty=body.qty,
        fill_price=result.fill_price,
        total=result.cash_amount,
        primary_qty=result.primary_qty,
        community_amount=result.community_amount,
        is_primary=result.primary_qty > 0,
        created_at=first.created_at,
        cash_balance=result.trader.cash,
        shares_held=result.trader.shares,
    )


@router.get("/assets/{asset_id}/quote", response_model=QuoteOut, responses=QUOTE_ERRORS)
def get_quote(
    asset_id: UUID,
    world: CurrentWorld,
    principal: OptionalPrincipal,
    session: SessionDep,
    side: Literal["buy", "sell"],
    qty: int = Query(gt=0),
) -> QuoteOut:
    """What an order would cost or pay now, slippage included (`engine.preview`), and with a
    session the largest order the user can place. Read-only: nothing is reserved, and the
    order fills at the price when it's placed. Errors match `POST /orders` for the asset and
    the size; cash and holdings are checked when ordering (see `max_qty`)."""
    # TODO(T57): once T68's policy lands, apply the same TRADE authorization as orders here
    # (insider_trading_blocked, admins_cannot_trade), so a quote never invites a refused order.
    asset = session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.id == asset_id)
    ).first()
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    order_side = OrderSide(side)
    # Only a signed-in buyer's max_qty needs the market maker's inventory (the supply).
    buyer = principal is not None and order_side is OrderSide.BUY
    market = _tradable_market(session, asset, with_inventory=buyer)
    try:
        priced = preview(market, order_side, qty)
    except MarketError as exc:
        raise _rejected(exc) from exc

    max_qty: int | None = None
    if principal is not None:
        actor = _actor(session, world.id, principal)
        holding = _holding(session, world.id, actor.id, asset.id)
        trader = Position(cash=actor.cash_balance, shares=holding.shares, avg_cost=holding.avg_cost)
        max_qty = max_fillable_qty(market, trader, order_side)

    return QuoteOut(
        asset_id=asset.id,
        side=side,
        qty=qty,
        price=market.price,
        fill_price=priced.fill_price,
        total=priced.cash_amount,
        slippage_pct=priced.slippage_pct,
        primary_qty=priced.primary_qty,
        community_amount=priced.community_amount,
        max_qty=max_qty,
        max_order_qty=max_order_qty(market.total_shares),
    )


@router.get("/portfolio", response_model=PortfolioOut)
def get_portfolio(
    principal: CurrentPrincipal, world: CurrentWorld, session: SessionDep
) -> PortfolioOut:
    """The signed-in user's cash and holdings."""
    actor = _actor(session, world.id, principal)
    holdings = session.exec(
        select(Holding).where(
            Holding.world_id == world.id,
            Holding.user_id == actor.id,
            col(Holding.shares) > 0,
        )
    ).all()

    out: list[HoldingOut] = []
    values: list[HoldingValue] = []
    for holding in holdings:
        asset = session.exec(
            select(Asset).where(Asset.world_id == world.id, Asset.id == holding.asset_id)
        ).first()
        if asset is None:
            continue
        mark_price = _latest_price(session, asset)
        value = value_holding(
            shares=holding.shares, avg_cost=holding.avg_cost, mark_price=mark_price
        )
        values.append(value)
        out.append(
            HoldingOut(
                asset_id=asset.id,
                asset_name=asset.name,
                shares=holding.shares,
                avg_cost=holding.avg_cost,
                mark_price=mark_price,
                market_value=value.market_value,
                cost_basis=value.cost_basis,
                unrealized_pnl=value.unrealized_pnl,
                unrealized_pnl_pct=value.unrealized_pnl_pct,
            )
        )
    totals = portfolio_totals(actor.cash_balance, values, starting_cash=STARTING_CASH)

    # Pro-rata impact comes from the stored report (T19 + T41 impact_for_holding); zero for now.
    return PortfolioOut(
        cash_balance=actor.cash_balance,
        holdings=out,
        holdings_value=totals.holdings_value,
        total_value=totals.total_value,
        cost_basis=totals.cost_basis,
        unrealized_pnl=totals.unrealized_pnl,
        unrealized_pnl_pct=totals.unrealized_pnl_pct,
        starting_cash=STARTING_CASH,
        since_start=totals.since_start,
        impact=ImpactSummary(
            ha_protected=Decimal("0.00"),
            t_co2_stored=Decimal("0.00"),
            services_usd_yr=Decimal("0.00"),
        ),
    )

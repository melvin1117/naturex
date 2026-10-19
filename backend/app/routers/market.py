"""Orders and portfolio (dev-spec §6, §8): persisted against the real market engine.

Concurrency: every order first takes a KEY SHARE lock on its world row, so it waits behind a
"Reset my demo" (which holds the world row FOR UPDATE) instead of deadlocking with it, while
orders don't block each other. It then locks the asset row and the trader's user row (the same
order as the revenue payout in `market/revenue.py`), so orders and payouts on one asset are
serialised and balances, holdings and the primary float can't lose updates.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func
from sqlmodel import Session, col, select

from app import events
from app.deps import CurrentWorld, SessionDep
from app.market.engine import MarketError, MarketState, Position, TradeResult, execute
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
from app.schemas import HoldingOut, ImpactSummary, OrderCreate, OrderOut, PortfolioOut

router = APIRouter(tags=["market"])

# TODO(T57): trade as the signed-in principal (ADR-0005). Until accounts land, every request
# trades as the demo investor persona of the caller's world.
_ACTOR_PERSONA_KEY = "arjun"


def _actor(session: Session, world_id: UUID, *, lock: bool = False) -> User:
    stmt = select(User).where(User.world_id == world_id, User.persona_key == _ACTOR_PERSONA_KEY)
    if lock:
        stmt = stmt.with_for_update()
    user = session.exec(stmt).first()
    if user is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Demo investor not seeded")
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


@router.post("/orders", response_model=OrderOut)
def place_order(body: OrderCreate, world: CurrentWorld, session: SessionDep) -> OrderOut:
    """Fill a market order instantly. `is_primary` is true if any shares came from the IPO float."""
    _lock_world(session, world.id)
    # After a concurrent reset the world has fresh asset ids, so a stale id is a 404.
    asset = _locked_asset(session, world.id, body.asset_id)
    actor = _actor(session, world.id, lock=True)
    # TODO(T57): re-check TRADE after locking the user (T68 review):
    # `enforce(fresh_actor(session, principal), Action.TRADE, AssetRef(...))`, so a membership
    # committed while this order waited on the lock blocks the buy.
    if asset.status != AssetStatus.LISTED:
        raise HTTPException(status.HTTP_409_CONFLICT, "Asset is not listed for trading")

    price = _latest_price(session, asset)
    if price is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Asset has no price yet")

    market = MarketState(
        price=price,
        total_shares=asset.total_shares,
        primary_shares_remaining=asset.primary_shares_remaining,
        market_maker_shares=_market_maker_shares(session, asset),
        community_wallet=asset.community_wallet,
    )
    holding = _holding(session, world.id, actor.id, asset.id)
    trader = Position(cash=actor.cash_balance, shares=holding.shares, avg_cost=holding.avg_cost)
    side = OrderSide(body.side)

    try:
        result = execute(market, trader, side, body.qty)
    except MarketError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

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
        is_primary=result.primary_qty > 0,
        created_at=first.created_at,
    )


@router.get("/portfolio", response_model=PortfolioOut)
def get_portfolio(world: CurrentWorld, session: SessionDep) -> PortfolioOut:
    actor = _actor(session, world.id)
    holdings = session.exec(
        select(Holding).where(
            Holding.world_id == world.id,
            Holding.user_id == actor.id,
            col(Holding.shares) > 0,
        )
    ).all()

    out: list[HoldingOut] = []
    for holding in holdings:
        asset = session.exec(
            select(Asset).where(Asset.world_id == world.id, Asset.id == holding.asset_id)
        ).first()
        if asset is None:
            continue
        mark_price = _latest_price(session, asset)
        pnl = (
            (mark_price - holding.avg_cost) * holding.shares
            if mark_price is not None and holding.avg_cost is not None
            else None
        )
        out.append(
            HoldingOut(
                asset_id=asset.id,
                asset_name=asset.name,
                shares=holding.shares,
                avg_cost=holding.avg_cost,
                mark_price=mark_price,
                unrealized_pnl=pnl,
            )
        )

    # Pro-rata impact comes from the stored report (T19 + T41 impact_for_holding); zero for now.
    return PortfolioOut(
        cash_balance=actor.cash_balance,
        holdings=out,
        impact=ImpactSummary(
            ha_protected=Decimal("0.00"),
            t_co2_stored=Decimal("0.00"),
            services_usd_yr=Decimal("0.00"),
        ),
    )

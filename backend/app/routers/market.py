"""Orders and portfolio (dev-spec §6, §8): persisted against the real market engine."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.db import get_session
from app.market.engine import MarketError, MarketState, Position, execute
from app.models import Asset, AssetStatus, Holding, Order, OrderSide, Price, User
from app.schemas import HoldingOut, ImpactSummary, OrderCreate, OrderOut, PortfolioOut
from app.seed import WORLD_ID

router = APIRouter(tags=["market"])

SessionDep = Annotated[Session, Depends(get_session)]

# TODO(T31): resolve the visitor's world and persona from the `nx_world` cookie; until
# then every request trades as the demo investor in the single seeded template world.
_ACTOR_PERSONA_KEY = "arjun"


def _actor(session: Session) -> User:
    user = session.exec(
        select(User).where(User.world_id == WORLD_ID, User.persona_key == _ACTOR_PERSONA_KEY)
    ).first()
    if user is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Demo investor not seeded")
    return user


def _asset(session: Session, asset_id: UUID) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.id == asset_id)
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


def _holding(session: Session, user_id: UUID, asset_id: UUID) -> Holding:
    holding = session.exec(
        select(Holding).where(
            Holding.world_id == WORLD_ID,
            Holding.user_id == user_id,
            Holding.asset_id == asset_id,
        )
    ).first()
    if holding is None:
        holding = Holding(world_id=WORLD_ID, user_id=user_id, asset_id=asset_id)
    return holding


@router.post("/orders", response_model=OrderOut)
def place_order(body: OrderCreate, session: SessionDep) -> OrderOut:
    actor = _actor(session)
    asset = _asset(session, body.asset_id)
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
    holding = _holding(session, actor.id, asset.id)
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
    order = Order(
        world_id=WORLD_ID,
        user_id=actor.id,
        asset_id=asset.id,
        side=side,
        qty=body.qty,
        fill_price=result.fill_price,
        is_primary=result.primary_qty > 0,
    )

    session.add(asset)
    session.add(actor)
    session.add(holding)
    session.add(order)
    session.add(
        Price(
            world_id=WORLD_ID,
            asset_id=asset.id,
            price=result.price_change.price,
            reason=result.price_change.reason.value,
        )
    )
    session.commit()

    return OrderOut(
        id=order.id,
        asset_id=order.asset_id,
        side=body.side,
        qty=order.qty,
        fill_price=result.fill_price,
        is_primary=order.is_primary,
        created_at=order.created_at,
    )


@router.get("/portfolio", response_model=PortfolioOut)
def get_portfolio(session: SessionDep) -> PortfolioOut:
    actor = _actor(session)
    holdings = session.exec(
        select(Holding).where(
            Holding.world_id == WORLD_ID,
            Holding.user_id == actor.id,
            col(Holding.shares) > 0,
        )
    ).all()

    out: list[HoldingOut] = []
    for holding in holdings:
        asset = session.get(Asset, holding.asset_id)
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

    # Impact is computed pro-rata from report/metrics data in T41; left at zero here.
    return PortfolioOut(
        cash_balance=actor.cash_balance,
        holdings=out,
        impact=ImpactSummary(
            ha_protected=Decimal("0.00"),
            t_co2_stored=Decimal("0.00"),
            services_usd_yr=Decimal("0.00"),
        ),
    )

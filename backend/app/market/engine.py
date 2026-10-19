"""Sandbox market engine (dev-spec §8). Pure functions over immutable state; no I/O.

Money is `Decimal`: prices have 4 decimal places (`numeric(12,4)`), cash 2 (`numeric(14,2)`).
Callers (the trade API, re-rating jobs) load state, call these functions and persist the
returned state, order and price row in one transaction.

Share accounting for one asset: every share is in exactly one place, so
    total_shares = primary_shares_remaining + market_maker_shares + sum(holdings)
where the community's retained stake counts as a holding.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from typing import ClassVar, Protocol

from app.models import OrderSide

K_SLIPPAGE = Decimal("0.5")
LIQUIDITY_SHARE = Decimal("0.05")
BETA = Decimal("0.5")
ALPHA_RERATE = Decimal("0.35")
ALPHA_TICK = Decimal("0.05")
NOISE_SIGMA = Decimal("0.003")
MAX_NOISE = 3 * NOISE_SIGMA
# Caps slippage per order so a sell can never price at or below zero. At 10% the cap is
# 1% of total shares (10,000 of 1M), far above what a $10,000 sandbox balance can buy.
MAX_SLIPPAGE = Decimal("0.10")
MIN_PRICE = Decimal("0.0001")

_PRICE = Decimal("0.0001")
_CASH = Decimal("0.01")
_HUNDRED = Decimal("100")


class PriceReason(StrEnum):
    """Stored in `prices.reason`; every price change carries one."""

    IPO = "ipo"
    ORDER = "order"
    RERATE = "rerate"
    TICK = "tick"


class MarketError(ValueError):
    """An order the market can't fill; the caller reports it to the user by `code`."""

    code: ClassVar[str] = "order_rejected"


class InvalidOrder(MarketError):
    code = "invalid_order"


class OrderTooLarge(InvalidOrder):
    code = "order_too_large"


class InsufficientCash(MarketError):
    code = "insufficient_cash"


class InsufficientShares(MarketError):
    code = "insufficient_shares"


class InsufficientSupply(MarketError):
    code = "insufficient_supply"


class NoiseSource(Protocol):
    def gauss(self, mu: float, sigma: float) -> float: ...


@dataclass(frozen=True, slots=True)
class MarketState:
    price: Decimal
    total_shares: int
    primary_shares_remaining: int
    market_maker_shares: int
    community_wallet: Decimal


@dataclass(frozen=True, slots=True)
class Position:
    """One user's cash and holding in one asset."""

    cash: Decimal
    shares: int
    avg_cost: Decimal | None


@dataclass(frozen=True, slots=True)
class PriceChange:
    price: Decimal
    reason: PriceReason


@dataclass(frozen=True, slots=True)
class Listing:
    market: MarketState
    retained_shares: int
    price_change: PriceChange


@dataclass(frozen=True, slots=True)
class TradeResult:
    market: MarketState
    trader: Position
    fill_price: Decimal
    cash_amount: Decimal
    """Cash paid (buy) or received (sell): qty × fill_price, rounded to cents."""
    primary_qty: int
    """Shares bought from the primary float (`orders.is_primary`); the rest are secondary."""
    price_change: PriceChange


def _price(value: Decimal) -> Decimal:
    return max(value.quantize(_PRICE, rounding=ROUND_HALF_UP), MIN_PRICE)


def _cash(value: Decimal) -> Decimal:
    return value.quantize(_CASH, rounding=ROUND_HALF_UP)


def _check_score(name: str, value: Decimal) -> None:
    if not 0 <= value <= _HUNDRED:
        raise ValueError(f"{name} must be between 0 and 100, got {value}")


def fair_value_total(*, value_mid: Decimal, health: Decimal, confidence: Decimal) -> Decimal:
    """FV_total = value_mid × 10 × (0.5 + 0.5 × health/100) × (0.7 + 0.3 × confidence/100)."""
    if value_mid < 0:
        raise ValueError(f"value_mid must not be negative, got {value_mid}")
    _check_score("health", health)
    _check_score("confidence", confidence)
    health_factor = Decimal("0.5") + Decimal("0.5") * health / _HUNDRED
    confidence_factor = Decimal("0.7") + Decimal("0.3") * confidence / _HUNDRED
    return _cash(value_mid * 10 * health_factor * confidence_factor)


def fair_value_per_share(
    *, value_mid: Decimal, health: Decimal, confidence: Decimal, total_shares: int
) -> Decimal:
    if total_shares <= 0:
        raise ValueError(f"total_shares must be positive, got {total_shares}")
    total = fair_value_total(value_mid=value_mid, health=health, confidence=confidence)
    return (total / total_shares).quantize(_PRICE, rounding=ROUND_HALF_UP)


def primary_float(*, total_shares: int, retained_pct: Decimal) -> int:
    """Shares offered at IPO; the community keeps the rest."""
    if not 0 <= retained_pct <= _HUNDRED:
        raise ValueError(f"retained_pct must be between 0 and 100, got {retained_pct}")
    return int(total_shares * (_HUNDRED - retained_pct) / _HUNDRED)


def ipo(
    *,
    value_mid: Decimal,
    health: Decimal,
    confidence: Decimal,
    total_shares: int,
    retained_pct: Decimal,
) -> Listing:
    """List an asset at its fair value per share with the whole primary float for sale."""
    price = fair_value_per_share(
        value_mid=value_mid, health=health, confidence=confidence, total_shares=total_shares
    )
    if price <= 0:
        raise ValueError("fair value per share rounds to zero; the asset can't be listed")
    offered = primary_float(total_shares=total_shares, retained_pct=retained_pct)
    state = MarketState(
        price=price,
        total_shares=total_shares,
        primary_shares_remaining=offered,
        market_maker_shares=0,
        community_wallet=Decimal("0.00"),
    )
    return Listing(
        market=state,
        retained_shares=total_shares - offered,
        price_change=PriceChange(price, PriceReason.IPO),
    )


def liquidity(total_shares: int) -> Decimal:
    return total_shares * LIQUIDITY_SHARE


def max_order_qty(total_shares: int) -> int:
    """Largest order whose slippage stays within MAX_SLIPPAGE."""
    return int(MAX_SLIPPAGE * liquidity(total_shares) / K_SLIPPAGE)


def quote(*, price: Decimal, side: OrderSide, qty: int, total_shares: int) -> Decimal:
    """Fill price: price × (1 ± k × qty / liquidity)."""
    slippage = K_SLIPPAGE * qty / liquidity(total_shares)
    sign = 1 if side is OrderSide.BUY else -1
    return _price(price * (1 + sign * slippage))


def execute(market: MarketState, trader: Position, side: OrderSide, qty: int) -> TradeResult:
    """Fill a market order instantly against the primary float or the platform market maker.

    Buys take primary shares first (proceeds go to the community wallet), then the market
    maker's inventory. Sells always go to the market maker. Raises a MarketError subclass
    and leaves nothing changed if the order can't be filled.
    """
    if qty <= 0:
        raise InvalidOrder(f"quantity must be positive, got {qty}")
    limit = max_order_qty(market.total_shares)
    if qty > limit:
        raise OrderTooLarge(f"orders are limited to {limit} shares")

    fill_price = quote(price=market.price, side=side, qty=qty, total_shares=market.total_shares)
    cash_amount = _cash(fill_price * qty)

    if side is OrderSide.BUY:
        if qty > market.primary_shares_remaining + market.market_maker_shares:
            raise InsufficientSupply("not enough shares available to buy")
        if cash_amount > trader.cash:
            raise InsufficientCash(f"order costs {cash_amount}, cash is {trader.cash}")
        primary_qty = min(qty, market.primary_shares_remaining)
        new_shares = trader.shares + qty
        held_cost = (trader.avg_cost or Decimal(0)) * trader.shares
        new_trader = Position(
            cash=trader.cash - cash_amount,
            shares=new_shares,
            avg_cost=_price((held_cost + fill_price * qty) / new_shares),
        )
        new_market = replace(
            market,
            primary_shares_remaining=market.primary_shares_remaining - primary_qty,
            market_maker_shares=market.market_maker_shares - (qty - primary_qty),
            community_wallet=market.community_wallet + _cash(fill_price * primary_qty),
        )
        signed_qty = qty
    else:
        if qty > trader.shares:
            raise InsufficientShares(f"selling {qty} shares, holding {trader.shares}")
        primary_qty = 0
        remaining = trader.shares - qty
        new_trader = Position(
            cash=trader.cash + cash_amount,
            shares=remaining,
            avg_cost=trader.avg_cost if remaining else None,
        )
        new_market = replace(market, market_maker_shares=market.market_maker_shares + qty)
        signed_qty = -qty

    new_price = _price(
        market.price + BETA * market.price * signed_qty / liquidity(market.total_shares)
    )
    return TradeResult(
        market=replace(new_market, price=new_price),
        trader=new_trader,
        fill_price=fill_price,
        cash_amount=cash_amount,
        primary_qty=primary_qty,
        price_change=PriceChange(new_price, PriceReason.ORDER),
    )


@dataclass(frozen=True, slots=True)
class OrderPreview:
    """What `execute` would charge or pay for an order now, without checking cash or holdings."""

    fill_price: Decimal
    cash_amount: Decimal
    """qty × fill_price, rounded to cents: the cost of a buy or the proceeds of a sell."""
    slippage_pct: Decimal
    """Fill price vs the current price, in percent (2 dp); negative for sells."""
    primary_qty: int
    """Shares a buy would take from the primary float; 0 for sells."""
    community_amount: Decimal
    """The part of `cash_amount` paid to the community wallet (primary shares × fill price)."""


def preview(market: MarketState, side: OrderSide, qty: int) -> OrderPreview:
    """Price an order the way `execute` fills it (the quote shown before confirming).

    Raises InvalidOrder for a non-positive quantity or one above the size cap. Cash, holdings
    and supply are the trader's problem at `execute` time; `max_fillable_qty` reports them.
    """
    if qty <= 0:
        raise InvalidOrder(f"quantity must be positive, got {qty}")
    limit = max_order_qty(market.total_shares)
    if qty > limit:
        raise OrderTooLarge(f"orders are limited to {limit} shares")
    fill_price = quote(price=market.price, side=side, qty=qty, total_shares=market.total_shares)
    primary_qty = min(qty, market.primary_shares_remaining) if side is OrderSide.BUY else 0
    slippage = ((fill_price - market.price) / market.price * _HUNDRED).quantize(
        _CASH, rounding=ROUND_HALF_UP
    )
    return OrderPreview(
        fill_price=fill_price,
        cash_amount=_cash(fill_price * qty),
        slippage_pct=slippage,
        primary_qty=primary_qty,
        community_amount=_cash(fill_price * primary_qty),
    )


def max_fillable_qty(market: MarketState, trader: Position, side: OrderSide) -> int:
    """The largest order `execute` would fill for this trader now (0 if none).

    Sells: the holding, up to the size cap. Buys: the most shares the trader's cash pays for
    at the slipped fill price, within the size cap and the shares available to buy.
    """
    limit = max_order_qty(market.total_shares)
    if side is OrderSide.SELL:
        return max(0, min(trader.shares, limit))
    high = min(limit, market.primary_shares_remaining + market.market_maker_shares)
    low = 0
    # The cost of q shares grows with q (more shares, each at a higher fill), so bisect.
    while low < high:
        mid = (low + high + 1) // 2
        fill = quote(price=market.price, side=side, qty=mid, total_shares=market.total_shares)
        if _cash(fill * mid) <= trader.cash:
            low = mid
        else:
            high = mid - 1
    return low


def reanchor(
    price: Decimal, fair_value: Decimal, reason: PriceReason, noise: NoiseSource
) -> PriceChange:
    """Pull the price toward a new fair value per share, plus small noise.

    price ← (price + α × (fair_value − price)) × (1 + ε), with α = 0.35 on a re-rate and
    0.05 per tick, and ε ~ N(0, 0.3%) clamped to ±3σ so one draw can't swing the price.
    """
    alphas = {PriceReason.RERATE: ALPHA_RERATE, PriceReason.TICK: ALPHA_TICK}
    if reason not in alphas:
        raise ValueError(f"re-anchoring needs reason rerate or tick, got {reason}")
    if fair_value < 0:
        raise ValueError(f"fair value must not be negative, got {fair_value}")
    draw = Decimal(str(noise.gauss(0.0, float(NOISE_SIGMA))))
    shock = min(max(draw, -MAX_NOISE), MAX_NOISE)
    anchored = price + alphas[reason] * (fair_value - price)
    return PriceChange(_price(anchored * (1 + shock)), reason)

"""Portfolio valuation (dev-spec §8, T18): pure functions over a user's cash and holdings.

Money is `Decimal` rounded half-up to cents, like the engine's cash. Percentages have 2
decimal places. A holding without a price (or an average cost) has no value or P&L and is
left out of the totals, so the page never shows a number the backend didn't compute.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

_CASH = Decimal("0.01")
_PCT = Decimal("0.01")
_HUNDRED = Decimal("100")


def _cash(value: Decimal) -> Decimal:
    return value.quantize(_CASH, rounding=ROUND_HALF_UP)


def _pct(part: Decimal, whole: Decimal) -> Decimal | None:
    if whole <= 0:
        return None
    return (part / whole * _HUNDRED).quantize(_PCT, rounding=ROUND_HALF_UP)


@dataclass(frozen=True, slots=True)
class HoldingValue:
    market_value: Decimal | None
    """shares × mark price, in cents."""
    cost_basis: Decimal | None
    """shares × average cost, in cents."""
    unrealized_pnl: Decimal | None
    """market_value − cost_basis."""
    unrealized_pnl_pct: Decimal | None
    """unrealized_pnl as a percentage of cost_basis."""


@dataclass(frozen=True, slots=True)
class PortfolioTotals:
    holdings_value: Decimal
    total_value: Decimal
    """cash + holdings_value."""
    cost_basis: Decimal
    unrealized_pnl: Decimal
    unrealized_pnl_pct: Decimal | None
    """null when nothing priced is held (no cost to compare with)."""


def value_holding(
    *, shares: int, avg_cost: Decimal | None, mark_price: Decimal | None
) -> HoldingValue:
    """Value one holding at its latest price."""
    if shares < 0:
        raise ValueError(f"shares must not be negative, got {shares}")
    market_value = _cash(mark_price * shares) if mark_price is not None else None
    cost_basis = _cash(avg_cost * shares) if avg_cost is not None else None
    if market_value is None or cost_basis is None:
        return HoldingValue(market_value, cost_basis, None, None)
    pnl = market_value - cost_basis
    return HoldingValue(market_value, cost_basis, pnl, _pct(pnl, cost_basis))


def portfolio_totals(cash: Decimal, holdings: Iterable[HoldingValue]) -> PortfolioTotals:
    """Sum the priced holdings and add cash. Unpriced holdings count toward nothing."""
    priced = [h for h in holdings if h.market_value is not None and h.cost_basis is not None]
    value = sum((h.market_value for h in priced if h.market_value is not None), Decimal("0.00"))
    cost = sum((h.cost_basis for h in priced if h.cost_basis is not None), Decimal("0.00"))
    pnl = value - cost
    return PortfolioTotals(
        holdings_value=_cash(value),
        total_value=_cash(cash + value),
        cost_basis=_cash(cost),
        unrealized_pnl=_cash(pnl),
        unrealized_pnl_pct=_pct(pnl, cost),
    )

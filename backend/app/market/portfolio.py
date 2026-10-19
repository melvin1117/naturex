"""Portfolio valuation (dev-spec §8, T18): pure functions over a user's cash and holdings.

Money and percentages round like the engine (`round_cash`, `round_pct`). A holding without a
price (or an average cost) has no value or P&L and is left out of the totals, so the page
never shows a number the backend didn't compute.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from app.market.engine import round_cash, round_pct

_HUNDRED = Decimal("100")
_ZERO = Decimal("0.00")


def _pct(part: Decimal, whole: Decimal) -> Decimal | None:
    return round_pct(part / whole * _HUNDRED) if whole > 0 else None


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
    since_start: Decimal
    """total_value − starting cash: realised and unrealised gains plus dividends."""


def value_holding(
    *, shares: int, avg_cost: Decimal | None, mark_price: Decimal | None
) -> HoldingValue:
    """Value one holding at its latest price."""
    if shares < 0:
        raise ValueError(f"shares must not be negative, got {shares}")
    market_value = round_cash(mark_price * shares) if mark_price is not None else None
    cost_basis = round_cash(avg_cost * shares) if avg_cost is not None else None
    if market_value is None or cost_basis is None:
        return HoldingValue(market_value, cost_basis, None, None)
    pnl = market_value - cost_basis
    return HoldingValue(market_value, cost_basis, pnl, _pct(pnl, cost_basis))


def portfolio_totals(
    cash: Decimal, holdings: Iterable[HoldingValue], *, starting_cash: Decimal
) -> PortfolioTotals:
    """Sum the priced holdings and add cash. Unpriced holdings count toward nothing."""
    priced = [h for h in holdings if h.market_value is not None and h.cost_basis is not None]
    value = sum((h.market_value for h in priced if h.market_value is not None), _ZERO)
    cost = sum((h.cost_basis for h in priced if h.cost_basis is not None), _ZERO)
    pnl = value - cost
    total = round_cash(cash + value)
    return PortfolioTotals(
        holdings_value=round_cash(value),
        total_value=total,
        cost_basis=round_cash(cost),
        unrealized_pnl=round_cash(pnl),
        unrealized_pnl_pct=_pct(pnl, cost),
        since_start=total - round_cash(starting_cash),
    )

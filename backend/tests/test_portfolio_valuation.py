"""Portfolio valuation (T18): pure functions, no database."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.market.portfolio import HoldingValue, portfolio_totals, value_holding

D = Decimal


def test_a_holding_is_valued_at_the_latest_price_against_its_average_cost() -> None:
    value = value_holding(shares=100, avg_cost=D("21.4938"), mark_price=D("22.0000"))

    assert value.market_value == D("2200.00")
    assert value.cost_basis == D("2149.38")
    assert value.unrealized_pnl == D("50.62")
    assert value.unrealized_pnl_pct == D("2.36")


def test_a_losing_holding_has_negative_pnl() -> None:
    value = value_holding(shares=10, avg_cost=D("20.0000"), mark_price=D("15.0000"))

    assert (value.unrealized_pnl, value.unrealized_pnl_pct) == (D("-50.00"), D("-25.00"))


def test_money_rounds_half_up_to_cents() -> None:
    value = value_holding(shares=1, avg_cost=D("1.0050"), mark_price=D("1.0150"))

    assert (value.cost_basis, value.market_value) == (D("1.01"), D("1.02"))


def test_a_holding_without_a_price_has_no_value_or_pnl() -> None:
    value = value_holding(shares=5, avg_cost=D("10.0000"), mark_price=None)

    assert value == HoldingValue(None, D("50.00"), None, None)


def test_negative_shares_are_rejected() -> None:
    with pytest.raises(ValueError):
        value_holding(shares=-1, avg_cost=None, mark_price=D("1"))


def test_totals_add_cash_to_the_priced_holdings_only() -> None:
    holdings = [
        value_holding(shares=100, avg_cost=D("20.0000"), mark_price=D("22.0000")),
        value_holding(shares=10, avg_cost=D("50.0000"), mark_price=D("40.0000")),
        value_holding(shares=7, avg_cost=D("10.0000"), mark_price=None),
    ]

    totals = portfolio_totals(D("1000.00"), holdings, starting_cash=D("10000.00"))

    assert totals.holdings_value == D("2600.00")
    assert totals.total_value == D("3600.00")
    assert totals.cost_basis == D("2500.00")
    assert totals.unrealized_pnl == D("100.00")
    assert totals.unrealized_pnl_pct == D("4.00")
    assert totals.since_start == D("-6400.00")


def test_an_empty_portfolio_is_its_cash_with_no_pnl_percentage() -> None:
    totals = portfolio_totals(D("10000.00"), [], starting_cash=D("10000.00"))

    assert totals.total_value == D("10000.00")
    assert totals.holdings_value == totals.unrealized_pnl == D("0.00")
    assert totals.unrealized_pnl_pct is None
    assert totals.since_start == D("0.00")


def test_since_start_counts_realised_gains_and_dividends() -> None:
    # Sold at a profit and got a dividend: more cash than the start, nothing held.
    assert portfolio_totals(D("10123.45"), [], starting_cash=D("10000.00")).since_start == D(
        "123.45"
    )

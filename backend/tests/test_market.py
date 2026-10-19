"""Market engine (dev-spec §8): IPO pricing, instant fills, re-anchoring and invariants."""

from __future__ import annotations

import random
from dataclasses import replace
from decimal import Decimal

import pytest

from app.market.engine import (
    MIN_PRICE,
    InsufficientCash,
    InsufficientShares,
    InsufficientSupply,
    InvalidOrder,
    MarketState,
    Position,
    PriceReason,
    execute,
    fair_value_per_share,
    fair_value_total,
    ipo,
    liquidity,
    max_fillable_qty,
    max_order_qty,
    preview,
    primary_float,
    quote,
    reanchor,
)
from app.models import OrderSide

D = Decimal


class FixedNoise:
    """Noise source that always returns the same draw, so re-anchoring is exact."""

    def __init__(self, value: float) -> None:
        self.value = value

    def gauss(self, mu: float, sigma: float) -> float:
        return self.value


def market(
    price: str = "10.0000",
    primary: int = 490_000,
    market_maker: int = 0,
    wallet: str = "0.00",
) -> MarketState:
    return MarketState(
        price=D(price),
        total_shares=1_000_000,
        primary_shares_remaining=primary,
        market_maker_shares=market_maker,
        community_wallet=D(wallet),
    )


def investor(cash: str = "10000.00", shares: int = 0, avg_cost: str | None = None) -> Position:
    return Position(cash=D(cash), shares=shares, avg_cost=D(avg_cost) if avg_cost else None)


# --- IPO pricing -----------------------------------------------------------------------------


def test_fair_value_total_follows_the_spec_formula() -> None:
    # 1,000,000 × 10 × (0.5 + 0.5 × 0.8) × (0.7 + 0.3 × 0.6) = 7,920,000
    assert fair_value_total(value_mid=D("1000000"), health=D("80"), confidence=D("60")) == D(
        "7920000.00"
    )


def test_fair_value_total_is_ten_years_of_value_for_a_perfect_rating() -> None:
    assert fair_value_total(value_mid=D("250000"), health=D("100"), confidence=D("100")) == D(
        "2500000.00"
    )


def test_fair_value_per_share_divides_by_total_shares() -> None:
    assert fair_value_per_share(
        value_mid=D("1000000"), health=D("80"), confidence=D("60"), total_shares=1_000_000
    ) == D("7.9200")


@pytest.mark.parametrize(("health", "confidence"), [("-1", "50"), ("101", "50"), ("50", "100.5")])
def test_fair_value_rejects_scores_outside_0_to_100(health: str, confidence: str) -> None:
    with pytest.raises(ValueError):
        fair_value_total(value_mid=D("1000"), health=D(health), confidence=D(confidence))


def test_fair_value_rejects_a_negative_value() -> None:
    with pytest.raises(ValueError):
        fair_value_total(value_mid=D("-1"), health=D("50"), confidence=D("50"))


def test_primary_float_is_the_share_not_retained_by_the_community() -> None:
    assert primary_float(total_shares=1_000_000, retained_pct=D("51")) == 490_000


def test_ipo_lists_at_fair_value_with_the_whole_primary_float_for_sale() -> None:
    listing = ipo(
        value_mid=D("1000000"),
        health=D("80"),
        confidence=D("60"),
        total_shares=1_000_000,
        retained_pct=D("51"),
    )

    assert listing.market.price == D("7.9200")
    assert listing.market.primary_shares_remaining == 490_000
    assert listing.market.market_maker_shares == 0
    assert listing.market.community_wallet == D("0.00")
    assert listing.retained_shares == 510_000
    assert listing.price_change.price == D("7.9200")
    assert listing.price_change.reason is PriceReason.IPO


def test_ipo_refuses_an_asset_whose_share_price_would_round_to_zero() -> None:
    with pytest.raises(ValueError):
        ipo(
            value_mid=D("1"),
            health=D("10"),
            confidence=D("10"),
            total_shares=1_000_000,
            retained_pct=D("51"),
        )


# --- Quotes and slippage ---------------------------------------------------------------------


def test_liquidity_is_five_percent_of_total_shares() -> None:
    assert liquidity(1_000_000) == D("50000")


def test_buy_quote_adds_slippage_proportional_to_size() -> None:
    # slippage = 0.5 × 1000 / 50,000 = 1%
    assert quote(price=D("10"), side=OrderSide.BUY, qty=1000, total_shares=1_000_000) == D(
        "10.1000"
    )


def test_sell_quote_subtracts_the_same_slippage() -> None:
    assert quote(price=D("10"), side=OrderSide.SELL, qty=1000, total_shares=1_000_000) == D(
        "9.9000"
    )


def test_max_order_caps_slippage_at_ten_percent() -> None:
    assert max_order_qty(1_000_000) == 10_000
    assert quote(price=D("10"), side=OrderSide.SELL, qty=10_000, total_shares=1_000_000) == D(
        "9.0000"
    )


# --- Buying ----------------------------------------------------------------------------------


def test_buy_from_the_primary_float_pays_the_community_wallet() -> None:
    result = execute(market(), investor(), OrderSide.BUY, 100)

    # fill = 10 × (1 + 0.5 × 100 / 50,000) = 10.01
    assert result.fill_price == D("10.0100")
    assert result.cash_amount == D("1001.00")
    assert result.primary_qty == 100
    assert result.market.primary_shares_remaining == 489_900
    assert result.market.community_wallet == D("1001.00")
    assert result.trader == Position(cash=D("8999.00"), shares=100, avg_cost=D("10.0100"))


def test_buy_moves_the_price_up_with_order_flow() -> None:
    result = execute(market(), investor(), OrderSide.BUY, 100)

    # price + 0.5 × price × 100 / 50,000
    assert result.market.price == D("10.0100")
    assert result.price_change.price == D("10.0100")
    assert result.price_change.reason is PriceReason.ORDER


def test_buy_spanning_the_end_of_the_float_takes_the_rest_from_the_market_maker() -> None:
    result = execute(market(primary=50, market_maker=100), investor(), OrderSide.BUY, 80)

    assert result.primary_qty == 50
    assert result.market.primary_shares_remaining == 0
    assert result.market.market_maker_shares == 70
    # Only the primary leg is credited to the community: 50 × 10.0080
    assert result.fill_price == D("10.0080")
    assert result.market.community_wallet == D("500.40")
    assert result.cash_amount == D("800.64")


def test_buy_after_the_float_sells_out_pays_nothing_to_the_community() -> None:
    result = execute(market(primary=0, market_maker=500), investor(), OrderSide.BUY, 100)

    assert result.primary_qty == 0
    assert result.market.community_wallet == D("0.00")
    assert result.market.market_maker_shares == 400


def test_buy_more_than_available_supply_is_rejected() -> None:
    with pytest.raises(InsufficientSupply):
        execute(market(primary=10, market_maker=5), investor(), OrderSide.BUY, 20)


def test_buy_costing_more_than_cash_is_rejected() -> None:
    with pytest.raises(InsufficientCash):
        execute(market(), investor(cash="1000.00"), OrderSide.BUY, 100)


def test_second_buy_updates_the_weighted_average_cost() -> None:
    result = execute(
        market(price="12.0000"),
        investor(shares=100, avg_cost="10.0000"),
        OrderSide.BUY,
        100,
    )

    # fill 12.012; (100 × 10 + 100 × 12.012) / 200 = 11.006
    assert result.trader.avg_cost == D("11.0060")
    assert result.trader.shares == 200


# --- Selling ---------------------------------------------------------------------------------


def test_sell_goes_to_the_market_maker_and_credits_cash() -> None:
    result = execute(market(), investor(shares=200, avg_cost="9.0000"), OrderSide.SELL, 100)

    assert result.fill_price == D("9.9900")
    assert result.cash_amount == D("999.00")
    assert result.primary_qty == 0
    assert result.market.market_maker_shares == 100
    assert result.market.community_wallet == D("0.00")
    assert result.trader == Position(cash=D("10999.00"), shares=100, avg_cost=D("9.0000"))


def test_sell_moves_the_price_down() -> None:
    result = execute(market(), investor(shares=200, avg_cost="9.0000"), OrderSide.SELL, 100)

    assert result.market.price == D("9.9900")
    assert result.price_change.reason is PriceReason.ORDER


def test_selling_everything_clears_the_average_cost() -> None:
    result = execute(market(), investor(shares=100, avg_cost="9.0000"), OrderSide.SELL, 100)

    assert result.trader.shares == 0
    assert result.trader.avg_cost is None


def test_sell_more_than_held_is_rejected() -> None:
    with pytest.raises(InsufficientShares):
        execute(market(), investor(shares=10, avg_cost="9.0000"), OrderSide.SELL, 11)


# --- Order validation ------------------------------------------------------------------------


@pytest.mark.parametrize("qty", [0, -5])
def test_non_positive_quantity_is_rejected(qty: int) -> None:
    with pytest.raises(InvalidOrder):
        execute(market(), investor(), OrderSide.BUY, qty)


def test_order_above_the_size_cap_is_rejected() -> None:
    with pytest.raises(InvalidOrder):
        execute(market(price="0.0100"), investor(), OrderSide.BUY, 10_001)


def test_rejected_order_leaves_inputs_unchanged() -> None:
    state, trader = market(), investor(cash="5.00")
    with pytest.raises(InsufficientCash):
        execute(state, trader, OrderSide.BUY, 100)

    assert state == market()
    assert trader == investor(cash="5.00")


# --- Quotes before confirming ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("side", "qty", "primary"), [(OrderSide.BUY, 100, 490_000), (OrderSide.BUY, 300, 120)]
)
def test_preview_prices_an_order_exactly_as_execute_fills_it(
    side: OrderSide, qty: int, primary: int
) -> None:
    state = market(primary=primary, market_maker=1_000)
    quoted = preview(state, side, qty)
    filled = execute(state, investor(), side, qty)

    assert quoted.fill_price == filled.fill_price
    assert quoted.cash_amount == filled.cash_amount
    assert quoted.primary_qty == filled.primary_qty
    assert quoted.community_amount == filled.market.community_wallet - state.community_wallet


def test_preview_of_a_sell_matches_execute_and_pays_no_community() -> None:
    state = market(market_maker=0)
    quoted = preview(state, OrderSide.SELL, 50)
    filled = execute(state, investor(shares=80, avg_cost="9.0000"), OrderSide.SELL, 50)

    assert (quoted.fill_price, quoted.cash_amount) == (filled.fill_price, filled.cash_amount)
    assert (quoted.primary_qty, quoted.community_amount) == (0, D("0.00"))


def test_preview_reports_slippage_in_percent() -> None:
    # 1,000 shares on 50,000 of liquidity: 0.5 × 1,000 / 50,000 = 1%.
    assert preview(market(), OrderSide.BUY, 1_000).slippage_pct == D("1.00")
    assert preview(market(), OrderSide.SELL, 1_000).slippage_pct == D("-1.00")


@pytest.mark.parametrize("qty", [0, -1, 10_001])
def test_preview_rejects_what_execute_rejects_for_size(qty: int) -> None:
    with pytest.raises(InvalidOrder):
        preview(market(), OrderSide.BUY, qty)


def test_max_buy_is_the_most_the_cash_pays_for_at_the_slipped_price() -> None:
    state, trader = market(), investor(cash="1000.00")
    most = max_fillable_qty(state, trader, OrderSide.BUY)

    assert execute(state, trader, OrderSide.BUY, most).cash_amount <= trader.cash
    with pytest.raises(InsufficientCash):
        execute(state, trader, OrderSide.BUY, most + 1)


def test_max_buy_is_capped_by_supply_and_order_size() -> None:
    rich = investor(cash="100000000.00")
    assert max_fillable_qty(market(primary=10, market_maker=5), rich, OrderSide.BUY) == 15
    assert max_fillable_qty(market(price="0.0100"), rich, OrderSide.BUY) == max_order_qty(1_000_000)
    assert max_fillable_qty(market(), investor(cash="0.00"), OrderSide.BUY) == 0


def test_max_sell_is_the_holding_up_to_the_size_cap() -> None:
    assert max_fillable_qty(market(), investor(shares=42), OrderSide.SELL) == 42
    assert max_fillable_qty(market(), investor(shares=50_000), OrderSide.SELL) == 10_000
    assert max_fillable_qty(market(), investor(), OrderSide.SELL) == 0


# --- Re-anchoring ----------------------------------------------------------------------------


def test_rerate_moves_the_price_35_percent_toward_fair_value() -> None:
    change = reanchor(D("10"), D("20"), PriceReason.RERATE, FixedNoise(0.0))

    assert change.price == D("13.5000")
    assert change.reason is PriceReason.RERATE


def test_tick_moves_the_price_5_percent_toward_fair_value() -> None:
    change = reanchor(D("10"), D("8"), PriceReason.TICK, FixedNoise(0.0))

    assert change.price == D("9.9000")
    assert change.reason is PriceReason.TICK


def test_noise_is_applied_as_a_relative_shock() -> None:
    change = reanchor(D("10"), D("10"), PriceReason.TICK, FixedNoise(0.003))

    assert change.price == D("10.0300")


def test_noise_is_clamped_to_three_sigma() -> None:
    up = reanchor(D("10"), D("10"), PriceReason.TICK, FixedNoise(5.0))
    down = reanchor(D("10"), D("10"), PriceReason.TICK, FixedNoise(-5.0))

    assert up.price == D("10.0900")
    assert down.price == D("9.9100")


def test_reanchor_never_drops_below_the_minimum_price() -> None:
    change = reanchor(D("0.0001"), D("0"), PriceReason.RERATE, FixedNoise(-5.0))

    assert change.price == MIN_PRICE


@pytest.mark.parametrize("reason", [PriceReason.IPO, PriceReason.ORDER])
def test_reanchor_only_accepts_rerate_or_tick(reason: PriceReason) -> None:
    with pytest.raises(ValueError):
        reanchor(D("10"), D("10"), reason, FixedNoise(0.0))


# --- Invariants under a random session ------------------------------------------------------


def test_invariants_hold_over_a_long_random_session() -> None:
    rng = random.Random(16)
    listing = ipo(
        value_mid=D("2000000"),
        health=D("72"),
        confidence=D("65"),
        total_shares=1_000_000,
        retained_pct=D("51"),
    )
    state = listing.market
    community = Position(cash=D("0.00"), shares=listing.retained_shares, avg_cost=None)
    investors = [investor() for _ in range(6)]
    primary_proceeds = D("0.00")
    reasons = [listing.price_change.reason]

    for step in range(3_000):
        if step % 250 == 249:
            fair_value = state.price * D(str(rng.uniform(0.5, 1.5)))
            reason = PriceReason.RERATE if step % 1000 == 999 else PriceReason.TICK
            change = reanchor(state.price, fair_value, reason, rng)
            state = replace(state, price=change.price)
            reasons.append(change.reason)
            continue

        is_community = rng.random() < 0.05
        who = rng.randrange(len(investors))
        trader = community if is_community else investors[who]
        side = OrderSide.SELL if is_community or rng.random() < 0.4 else OrderSide.BUY
        qty = rng.randint(1, 400)
        try:
            result = execute(state, trader, side, qty)
        except (InsufficientCash, InsufficientShares, InsufficientSupply, InvalidOrder):
            continue

        primary_proceeds += result.market.community_wallet - state.community_wallet
        state = result.market
        reasons.append(result.price_change.reason)
        if is_community:
            community = result.trader
        else:
            investors[who] = result.trader

        holders = [community, *investors]
        assert all(p.cash >= 0 for p in holders), "cash went negative"
        assert all(p.shares >= 0 for p in holders), "holding went negative"
        assert state.primary_shares_remaining >= 0
        assert state.market_maker_shares >= 0
        assert (
            state.primary_shares_remaining
            + state.market_maker_shares
            + sum(p.shares for p in holders)
            == state.total_shares
        ), "shares not conserved"
        assert state.price > 0, "price must stay positive"

    assert state.community_wallet == primary_proceeds
    assert all(isinstance(r, PriceReason) for r in reasons), "every price change needs a reason"
    assert len(reasons) > 1_000, "the session should have produced plenty of fills"

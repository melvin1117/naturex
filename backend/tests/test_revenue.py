"""Quarterly revenue split and portfolio impact (dev-spec §8, stories D4/E3)."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from decimal import Decimal

import pytest
from alembic import command
from sqlalchemy import create_engine
from sqlmodel import Session, select

from app.config import get_settings
from app.ledger import entries_for, verify
from app.market.revenue import (
    CAPTURE_RATE,
    HolderShares,
    ImpactInput,
    PayoutAlreadyApplied,
    calculate_quarterly_payout,
    impact_for_holding,
    pay_quarter,
    portfolio_impact,
    quarterly_revenue,
    split_revenue,
)
from app.models import Asset, Holding, LedgerEntry, LedgerKind, User, UserRole, World
from app.seed import COMMUNITY_PERSONA, DEMO_SITES, PERSONAS, WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

D = Decimal
ASSET_ID = DEMO_SITES[0].id
ARJUN_ID = PERSONAS[1].id
MIA_ID = PERSONAS[2].id


def test_quarterly_revenue_is_two_percent_of_annual_value_divided_by_four() -> None:
    assert D("0.02") == CAPTURE_RATE
    assert quarterly_revenue(D("100000.00")) == D("500.00")


def test_quarterly_revenue_rejects_negative_value() -> None:
    with pytest.raises(ValueError, match="value_mid"):
        quarterly_revenue(D("-0.01"))


def test_split_revenue_is_half_community_fund_and_half_dividend_pool() -> None:
    split = split_revenue(D("500.00"))

    assert split.community_fund == D("250.00")
    assert split.dividend_pool == D("250.00")
    assert split.community_fund + split.dividend_pool == split.revenue


def test_dividends_are_pro_rata_among_all_positive_holdings() -> None:
    payout = calculate_quarterly_payout(
        value_mid=D("100000.00"),
        holders=(
            HolderShares("community", 500),
            HolderShares("arjun", 300),
            HolderShares("mia", 200),
        ),
    )

    assert [(p.key, p.amount) for p in payout.holder_payouts] == [
        ("arjun", D("75.00")),
        ("community", D("125.00")),
        ("mia", D("50.00")),
    ]
    assert payout.dividends_total == D("250.00")
    assert payout.unallocated_dividends == D("0.00")


def test_dividend_allocation_conserves_every_cent_for_awkward_splits() -> None:
    payout = calculate_quarterly_payout(
        value_mid=D("200.00"),
        holders=(HolderShares("b", 1), HolderShares("a", 1), HolderShares("c", 1)),
    )

    assert payout.split.dividend_pool == D("0.50")
    assert [(p.key, p.amount) for p in payout.holder_payouts] == [
        ("a", D("0.17")),
        ("b", D("0.17")),
        ("c", D("0.16")),
    ]
    assert sum((p.amount for p in payout.holder_payouts), start=D("0.00")) == D("0.50")


def test_unheld_shares_do_not_receive_dividends() -> None:
    payout = calculate_quarterly_payout(
        value_mid=D("200.00"),
        holders=(HolderShares("arjun", 100), HolderShares("mia", 100)),
    )

    assert [(p.key, p.amount) for p in payout.holder_payouts] == [
        ("arjun", D("0.25")),
        ("mia", D("0.25")),
    ]


def test_no_positive_holdings_rolls_unallocated_dividends_to_community_wallet() -> None:
    payout = calculate_quarterly_payout(
        value_mid=D("200.00"),
        holders=(HolderShares("community", 0),),
    )

    assert payout.holder_payouts == ()
    assert payout.split.community_fund == D("0.50")
    assert payout.unallocated_dividends == D("0.50")
    assert payout.community_wallet_credit == D("1.00")


def test_impact_for_holding_is_pro_rata_to_total_shares() -> None:
    impact = ImpactInput(
        area_ha=D("100.00"),
        carbon_stock_tco2=D("1000.00"),
        services_usd_year=D("200000.00"),
    )

    result = impact_for_holding("arjun", shares=250, total_shares=1000, impact=impact)

    assert result.area_ha == D("25.0000")
    assert result.carbon_stock_tco2 == D("250.0000")
    assert result.services_usd_year == D("50000.00")


def test_portfolio_impact_aggregates_positions() -> None:
    wetland = impact_for_holding(
        "wetland",
        shares=250,
        total_shares=1000,
        impact=ImpactInput(D("100.00"), D("1000.00"), D("200000.00")),
    )
    forest = impact_for_holding(
        "forest",
        shares=100,
        total_shares=1000,
        impact=ImpactInput(D("50.00"), D("300.00"), D("80000.00")),
    )

    assert portfolio_impact((wetland, forest)) == ImpactInput(
        area_ha=D("30.0000"),
        carbon_stock_tco2=D("280.0000"),
        services_usd_year=D("58000.00"),
    )


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that rolls back every payout test."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


def _add_holdings(session: Session) -> None:
    session.add_all(
        [
            Holding(
                world_id=WORLD_ID,
                user_id=COMMUNITY_PERSONA.id,
                asset_id=ASSET_ID,
                shares=500,
                avg_cost=D("0.0001"),
            ),
            Holding(
                world_id=WORLD_ID,
                user_id=ARJUN_ID,
                asset_id=ASSET_ID,
                shares=300,
                avg_cost=D("10.0000"),
            ),
            Holding(
                world_id=WORLD_ID,
                user_id=MIA_ID,
                asset_id=ASSET_ID,
                shares=200,
                avg_cost=D("10.0000"),
            ),
        ]
    )
    session.flush()


def _world_cash_and_wallets(session: Session) -> Decimal:
    users = session.exec(select(User).where(User.world_id == WORLD_ID)).all()
    assets = session.exec(select(Asset).where(Asset.world_id == WORLD_ID)).all()
    return sum((user.cash_balance for user in users), start=D("0.00")) + sum(
        (asset.community_wallet for asset in assets), start=D("0.00")
    )


@requires_db
def test_pay_quarter_credits_wallets_users_and_appends_a_verifiable_ledger_entry(
    session: Session,
) -> None:
    _add_holdings(session)

    result = pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=D("100000.00"),
        quarter_label="2026-Q4",
    )
    session.flush()
    session.expire_all()

    asset = session.get_one(Asset, ASSET_ID)
    community = session.get_one(User, COMMUNITY_PERSONA.id)
    arjun = session.get_one(User, ARJUN_ID)
    mia = session.get_one(User, MIA_ID)
    entries = entries_for(session, ASSET_ID)

    assert asset.community_wallet == D("250.00")
    assert community.cash_balance == D("10125.00")
    assert arjun.cash_balance == D("10075.00")
    assert mia.cash_balance == D("10050.00")
    assert result.payout.revenue == D("500.00")
    assert len(entries) == 1
    assert entries[0].kind is LedgerKind.PAYOUT
    assert entries[0].payload["quarter_label"] == "2026-Q4"
    assert entries[0].payload["revenue"] == "500.00"
    assert entries[0].payload["community_fund"] == "250.00"
    assert entries[0].payload["dividends_total"] == "250.00"
    assert entries[0].payload["holder_count"] == 3
    assert verify(entries).valid


@requires_db
def test_pay_quarter_is_world_scoped(session: Session) -> None:
    _add_holdings(session)
    other_world_id = uuid.uuid4()
    other_user_id = uuid.uuid4()
    session.add(World(id=other_world_id, label="other"))
    session.flush()
    session.add(
        User(
            id=other_user_id,
            world_id=other_world_id,
            name="Other investor",
            role=UserRole.INVESTOR,
            cash_balance=D("10000.00"),
        )
    )
    session.flush()
    session.add(
        Holding(world_id=other_world_id, user_id=other_user_id, asset_id=ASSET_ID, shares=900)
    )
    session.flush()

    pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=D("100000.00"),
        quarter_label="2026-Q4",
    )
    session.flush()

    assert session.get_one(User, other_user_id).cash_balance == D("10000.00")


@requires_db
def test_pay_quarter_refuses_a_second_payout_for_the_same_asset_and_quarter(
    session: Session,
) -> None:
    _add_holdings(session)

    pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=D("100000.00"),
        quarter_label="2026-Q4",
    )
    with pytest.raises(PayoutAlreadyApplied, match="2026-Q4"):
        pay_quarter(
            session,
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            value_mid=D("100000.00"),
            quarter_label="2026-Q4",
        )

    assert (
        len(
            session.exec(
                select(LedgerEntry).where(
                    LedgerEntry.asset_id == ASSET_ID, LedgerEntry.kind == LedgerKind.PAYOUT
                )
            ).all()
        )
        == 1
    )


@requires_db
def test_pay_quarter_increases_world_cash_and_wallets_by_exactly_the_revenue(
    session: Session,
) -> None:
    _add_holdings(session)
    before = _world_cash_and_wallets(session)

    result = pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=D("100000.00"),
        quarter_label="2026-Q4",
    )
    session.flush()

    assert _world_cash_and_wallets(session) - before == result.payout.revenue


@requires_db
def test_pay_quarter_rejects_an_asset_outside_the_world(session: Session) -> None:
    _add_holdings(session)

    with pytest.raises(LookupError):
        pay_quarter(
            session,
            world_id=uuid.uuid4(),
            asset_id=ASSET_ID,
            value_mid=D("100000.00"),
            quarter_label="2026-Q4",
        )

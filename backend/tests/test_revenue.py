"""Quarterly revenue split and portfolio impact (dev-spec §8, stories D4/E3)."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from alembic import command
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import get_settings
from app.ledger import append, canonical, entries_for, tamper, verify
from app.market.revenue import (
    CAPTURE_RATE,
    NONCE_BYTES,
    PAYOUT_COMMITMENT_METHOD,
    CommunityStakeMissing,
    HolderShares,
    ImpactInput,
    PayoutAlreadyApplied,
    calculate_quarterly_payout,
    erase_payout_lines_for_user,
    impact_for_holding,
    pay_quarter,
    payout_line_leaf,
    payout_lines_commitment,
    portfolio_impact,
    quarterly_revenue,
    split_revenue,
    verify_payout_commitment,
)
from app.models import (
    Asset,
    Holding,
    LedgerEntry,
    LedgerKind,
    PayoutLine,
    User,
    UserRole,
    World,
)
from app.seed import COMMUNITY_PERSONA, DEMO_SITES, PERSONAS, SEED_COMMUNITIES, WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

D = Decimal
ASSET_ID = DEMO_SITES[0].id
ARJUN_ID = PERSONAS[1].id
MIA_ID = PERSONAS[2].id
# The wetland community's treasury holds its retained stake (T56); Rosa is only its owner.
TREASURY_ID = SEED_COMMUNITIES[0].treasury_id
ARJUN_SHARES = 300_000
MIA_SHARES = 190_000


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


def test_impact_rejects_negative_inputs() -> None:
    with pytest.raises(ValueError, match="area_ha"):
        ImpactInput(area_ha=D("-0.01"), carbon_stock_tco2=D("1"), services_usd_year=D("1"))
    with pytest.raises(ValueError, match="carbon_stock_tco2"):
        ImpactInput(area_ha=D("1"), carbon_stock_tco2=D("-0.01"), services_usd_year=D("1"))
    with pytest.raises(ValueError, match="services_usd_year"):
        ImpactInput(area_ha=D("1"), carbon_stock_tco2=D("1"), services_usd_year=D("-0.01"))


def test_impact_rejects_more_shares_than_total_shares() -> None:
    with pytest.raises(ValueError, match="must not exceed"):
        impact_for_holding(
            "arjun",
            shares=1001,
            total_shares=1000,
            impact=ImpactInput(D("100.00"), D("1000.00"), D("200000.00")),
        )


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


def test_portfolio_impact_quantizes_after_summing_equal_thirds() -> None:
    asset_impact = ImpactInput(
        area_ha=D("100.00"),
        carbon_stock_tco2=D("1000.00"),
        services_usd_year=D("200000.00"),
    )
    allocations = tuple(
        impact_for_holding(key, shares=1, total_shares=3, impact=asset_impact)
        for key in ("a", "b", "c")
    )

    assert portfolio_impact(allocations) == ImpactInput(
        area_ha=D("100.0000"),
        carbon_stock_tco2=D("1000.0000"),
        services_usd_year=D("200000.00"),
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
    """Investor holdings on top of the community's retained stake, which seed() creates."""
    asset = session.get_one(Asset, ASSET_ID)
    community = session.get_one(Holding, (WORLD_ID, TREASURY_ID, ASSET_ID))
    assert community.shares == asset.total_shares - asset.primary_shares_remaining
    _add_investor_holdings(session)


def _remove_community_holding(session: Session) -> None:
    session.delete(session.get_one(Holding, (WORLD_ID, TREASURY_ID, ASSET_ID)))
    session.flush()


def _add_investor_holdings(session: Session) -> None:
    asset = session.get_one(Asset, ASSET_ID)
    asset.primary_shares_remaining -= ARJUN_SHARES + MIA_SHARES
    session.add_all(
        [
            Holding(
                world_id=WORLD_ID,
                user_id=ARJUN_ID,
                asset_id=ASSET_ID,
                shares=ARJUN_SHARES,
                avg_cost=D("10.0000"),
            ),
            Holding(
                world_id=WORLD_ID,
                user_id=MIA_ID,
                asset_id=ASSET_ID,
                shares=MIA_SHARES,
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
    treasury = session.get_one(User, TREASURY_ID)
    rosa = session.get_one(User, COMMUNITY_PERSONA.id)
    arjun = session.get_one(User, ARJUN_ID)
    mia = session.get_one(User, MIA_ID)
    entries = entries_for(session, ASSET_ID)

    assert asset.community_wallet == D("250.00")
    assert treasury.cash_balance == D("127.50"), "the retained-stake dividend (from 0.00)"
    assert rosa.cash_balance == D("10000.00"), "the owner is a member, not a holder"
    assert arjun.cash_balance == D("10075.00")
    assert mia.cash_balance == D("10047.50")
    assert result.payout.revenue == D("500.00")
    # The seed's report v1 entry (T19) comes first.
    assert [e.kind for e in entries] == [LedgerKind.REPORT, LedgerKind.PAYOUT]
    payout = entries[-1]
    assert payout.payload["quarter_label"] == "2026-Q4"
    assert payout.payload["revenue"] == "500.00"
    assert payout.payload["community_fund"] == "250.00"
    assert payout.payload["dividends_total"] == "250.00"
    assert payout.payload["holder_count"] == 3
    assert verify(entries).valid


@requires_db
def test_pay_quarter_rejects_missing_community_retained_holding_without_changes(
    session: Session,
) -> None:
    _remove_community_holding(session)
    _add_investor_holdings(session)
    before = _world_cash_and_wallets(session)

    with pytest.raises(
        CommunityStakeMissing,
        match=r"community retained stake is not recorded as a holding; seed it \(T31\)",
    ):
        pay_quarter(
            session,
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            value_mid=D("100000.00"),
            quarter_label="2026-Q4",
        )
    session.flush()

    assert _world_cash_and_wallets(session) == before
    assert [e.kind for e in entries_for(session, ASSET_ID)] == [LedgerKind.REPORT]


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
    # Another world can't hold this world's asset at all (#144), so its holders are never paid.
    with pytest.raises(IntegrityError, match="fk_holdings_asset"), session.begin_nested():
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
    assert len(_lines(session)) == 3


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


# --- Ledger privacy (T67): private payout lines and per-line commitments ------------------

PUBLIC_PAYOUT_KEYS = {
    "quarter_label",
    "value_mid",
    "capture_rate",
    "revenue",
    "community_fund",
    "dividend_pool",
    "dividends_total",
    "unallocated_dividends",
    "community_wallet_credit",
    "holder_count",
    "lines_commitment",
    "commitment_method",
}


def _lines(session: Session) -> list[PayoutLine]:
    return list(
        session.exec(
            select(PayoutLine).where(
                PayoutLine.world_id == WORLD_ID, PayoutLine.asset_id == ASSET_ID
            )
        ).all()
    )


def _line(session: Session, user_id: uuid.UUID) -> PayoutLine:
    return next(line for line in _lines(session) if line.user_id == user_id)


def _pay(session: Session, quarter_label: str = "2026-Q4") -> LedgerEntry:
    _add_holdings(session)
    entry = pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=D("100000.00"),
        quarter_label=quarter_label,
    ).ledger_entry
    session.flush()
    return entry


def test_leaf_binds_the_nonce_and_every_field_and_normalises_cents() -> None:
    nonce, other_nonce = b"\x01" * NONCE_BYTES, b"\x02" * NONCE_BYTES
    a, b = uuid.uuid4(), uuid.uuid4()
    base = payout_line_leaf(nonce, a, 10, D("1.50"))

    assert payout_line_leaf(nonce, a, 10, D("1.5")) == base
    assert payout_line_leaf(other_nonce, a, 10, D("1.50")) != base
    assert payout_line_leaf(nonce, b, 10, D("1.50")) != base
    assert payout_line_leaf(nonce, a, 11, D("1.50")) != base
    assert payout_line_leaf(nonce, a, 10, D("1.51")) != base
    with pytest.raises(ValueError, match="nonce"):
        payout_line_leaf(b"short", a, 10, D("1.50"))


def test_commitment_ignores_leaf_order_but_binds_every_leaf() -> None:
    leaves = ["a" * 64, "b" * 64, "c" * 64]
    base = payout_lines_commitment(leaves)

    assert payout_lines_commitment(reversed(leaves)) == base
    assert payout_lines_commitment(leaves[:2]) != base
    assert payout_lines_commitment([*leaves, "d" * 64]) != base


@requires_db
def test_payout_lines_equal_the_per_holder_allocation_and_sum_to_the_dividends(
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

    lines = _lines(session)
    assert sorted((str(line.user_id), line.shares, line.amount) for line in lines) == sorted(
        (p.key, p.shares, p.amount) for p in result.payout.holder_payouts
    )
    assert {line.user_id: line.amount for line in lines} == {
        TREASURY_ID: D("127.50"),
        ARJUN_ID: D("75.00"),
        MIA_ID: D("47.50"),
    }
    assert sum((line.amount or D("0") for line in lines), start=D("0.00")) == D("250.00")
    assert {line.quarter_label for line in lines} == {"2026-Q4"}
    for line in lines:
        assert line.nonce is not None and len(line.nonce) == NONCE_BYTES
        assert line.user_id is not None and line.shares is not None and line.amount is not None
        assert line.leaf_hash == payout_line_leaf(
            line.nonce, line.user_id, line.shares, line.amount
        )
    assert len({line.nonce for line in lines}) == 3, "a fresh nonce per line"


@requires_db
def test_payout_ledger_payload_holds_aggregates_and_the_commitment_only(
    session: Session,
) -> None:
    entry = _pay(session)
    text_payload = canonical(entry.payload).decode()

    assert set(entry.payload) == PUBLIC_PAYOUT_KEYS
    assert entry.ref_id is None
    assert entry.payload["holder_count"] == 3
    assert entry.payload["dividends_total"] == "250.00"
    assert entry.payload["commitment_method"] == PAYOUT_COMMITMENT_METHOD
    assert entry.payload["lines_commitment"] == payout_lines_commitment(
        line.leaf_hash for line in _lines(session)
    )
    for user in session.exec(select(User).where(User.world_id == WORLD_ID)).all():
        assert str(user.id) not in text_payload
        assert user.name not in text_payload
    for line in _lines(session):
        assert line.leaf_hash not in text_payload, "only the root is public"
        assert line.nonce is not None and line.nonce.hex() not in text_payload


@requires_db
def test_payout_commitment_verifies_against_the_private_lines(session: Session) -> None:
    entry = _pay(session)

    check = verify_payout_commitment(session, entry)

    assert (check.status, check.erased, check.valid) == ("ok", 0, True)
    assert verify(entries_for(session, ASSET_ID)).valid


def _change_amount(session: Session) -> None:
    line = _line(session, ARJUN_ID)
    line.amount = D("75.01")


def _change_shares(session: Session) -> None:
    line = _line(session, ARJUN_ID)
    line.shares = ARJUN_SHARES + 1


def _reassign_holder(session: Session) -> None:
    _line(session, ARJUN_ID).user_id = PERSONAS[3].id


def _change_nonce(session: Session) -> None:
    line = _line(session, ARJUN_ID)
    assert line.nonce is not None
    line.nonce = bytes([line.nonce[0] ^ 1]) + line.nonce[1:]


def _change_tombstone_leaf(session: Session) -> None:
    erase_payout_lines_for_user(session, world_id=WORLD_ID, user_id=ARJUN_ID)
    session.flush()
    tombstone = next(line for line in _lines(session) if line.user_id is None)
    tombstone.leaf_hash = "0" * 64


def _drop_line(session: Session) -> None:
    session.delete(_line(session, MIA_ID))


def _add_line(session: Session) -> None:
    nonce = b"\x07" * NONCE_BYTES
    session.add(
        PayoutLine(
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            quarter_label="2026-Q4",
            user_id=PERSONAS[3].id,
            shares=1,
            amount=D("0.01"),
            nonce=nonce,
            leaf_hash=payout_line_leaf(nonce, PERSONAS[3].id, 1, D("0.01")),
        )
    )


@requires_db
@pytest.mark.parametrize(
    "edit",
    [
        _change_amount,
        _change_shares,
        _reassign_holder,
        _change_nonce,
        _change_tombstone_leaf,
        _drop_line,
        _add_line,
    ],
    ids=lambda edit: edit.__name__.lstrip("_"),
)
def test_payout_commitment_fails_if_any_line_changes(
    session: Session, edit: Callable[[Session], None]
) -> None:
    entry = _pay(session)

    edit(session)
    session.flush()

    assert verify_payout_commitment(session, entry).status == "mismatch"


@requires_db
def test_verify_payout_commitment_rejects_other_kinds_and_flags_legacy_entries(
    session: Session,
) -> None:
    listing = append(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    legacy = append(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        kind=LedgerKind.PAYOUT,
        payload={"quarter_label": "2026-Q3", "dividends_total": "1.00", "holder_count": 1},
    )

    with pytest.raises(ValueError, match="not a payout"):
        verify_payout_commitment(session, listing)
    assert verify_payout_commitment(session, legacy).status == "no_commitment"


@requires_db
def test_erasing_one_holder_leaves_a_tombstone_and_keeps_the_others_verifiable(
    session: Session,
) -> None:
    entry = _pay(session)
    payload_before = dict(entry.payload)
    leaf_before = _line(session, ARJUN_ID).leaf_hash

    erased = erase_payout_lines_for_user(session, world_id=WORLD_ID, user_id=ARJUN_ID)
    session.flush()
    session.expire_all()

    assert erased == 1
    [tombstone] = [line for line in _lines(session) if line.user_id is None]
    assert (tombstone.shares, tombstone.amount, tombstone.nonce) == (None, None, None)
    assert tombstone.leaf_hash == leaf_before, "only the unlinkable leaf hash is kept"
    assert {line.user_id for line in _lines(session)} == {TREASURY_ID, MIA_ID, None}
    check = verify_payout_commitment(session, entry)
    assert (check.status, check.erased, check.valid) == ("ok_with_erasures", 1, True)
    stored_entries = entries_for(session, ASSET_ID)  # the seed's report v1 (T19), then the payout
    [stored] = [e for e in stored_entries if e.kind is LedgerKind.PAYOUT]
    assert stored.payload == payload_before, "the public aggregates are untouched"
    assert verify(stored_entries).valid
    assert session.get_one(User, ARJUN_ID).cash_balance == D("10075.00"), "only lines are erased"


@requires_db
def test_a_tombstone_holds_no_user_id_anywhere(session: Session) -> None:
    _pay(session)
    erase_payout_lines_for_user(session, world_id=WORLD_ID, user_id=ARJUN_ID)
    session.flush()

    row = session.execute(
        text("SELECT to_jsonb(p)::text FROM payout_lines p WHERE user_id IS NULL")
    ).scalar_one()

    assert str(ARJUN_ID) not in row
    assert "75.00" not in row and str(ARJUN_SHARES) not in row


@requires_db
def test_erasing_a_user_without_payout_lines_changes_nothing(session: Session) -> None:
    entry = _pay(session)

    assert erase_payout_lines_for_user(session, world_id=WORLD_ID, user_id=PERSONAS[3].id) == 0
    assert erase_payout_lines_for_user(session, world_id=uuid.uuid4(), user_id=ARJUN_ID) == 0
    assert len(_lines(session)) == 3
    assert verify_payout_commitment(session, entry).status == "ok"


@requires_db
def test_a_second_payout_for_one_quarter_is_also_refused_by_the_database(
    session: Session,
) -> None:
    entry = _pay(session)

    with pytest.raises(IntegrityError, match="uq_ledger_payout_quarter"), session.begin_nested():
        append(
            session,
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            kind=LedgerKind.PAYOUT,
            payload={"quarter_label": entry.payload["quarter_label"], "holder_count": 0},
        )


@requires_db
def test_tamper_demo_still_breaks_a_payout_entry(session: Session) -> None:
    entry = _pay(session)

    result = tamper(entries_for(session, ASSET_ID), entry.seq)

    assert result.field == "capture_rate"
    assert not verify(result.entries).valid


@requires_db
def test_concurrent_pay_quarter_applies_once_for_one_asset_quarter() -> None:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    world_id = uuid.uuid4()
    community_id = uuid.uuid4()
    investor_id = uuid.uuid4()
    asset_id = uuid.uuid4()
    barrier = threading.Barrier(2)

    try:
        with Session(engine) as setup:
            setup.add(World(id=world_id, label="concurrent-payout"))
            setup.flush()
            setup.add_all(
                [
                    User(
                        id=community_id,
                        world_id=world_id,
                        name="Community",
                        role=UserRole.COMMUNITY,
                        cash_balance=D("10000.00"),
                    ),
                    User(
                        id=investor_id,
                        world_id=world_id,
                        name="Investor",
                        role=UserRole.INVESTOR,
                        cash_balance=D("10000.00"),
                    ),
                ]
            )
            setup.flush()
            setup.add(
                Asset(
                    id=asset_id,
                    world_id=world_id,
                    name="Concurrent Reserve",
                    community_user_id=community_id,
                    country="MX",
                    description="Concurrency test asset",
                    geojson={"type": "Point", "coordinates": [0, 0]},
                    area_ha=D("10.00"),
                    total_shares=1_000,
                    retained_pct=D("50.00"),
                    primary_shares_remaining=0,
                    community_wallet=D("0.00"),
                )
            )
            setup.flush()
            setup.add_all(
                [
                    Holding(
                        world_id=world_id,
                        user_id=community_id,
                        asset_id=asset_id,
                        shares=500,
                        avg_cost=D("0.0001"),
                    ),
                    Holding(
                        world_id=world_id,
                        user_id=investor_id,
                        asset_id=asset_id,
                        shares=500,
                        avg_cost=D("1.0000"),
                    ),
                ]
            )
            setup.commit()

        def apply_once() -> str:
            with Session(engine) as db:
                barrier.wait(timeout=5)
                try:
                    pay_quarter(
                        db,
                        world_id=world_id,
                        asset_id=asset_id,
                        value_mid=D("400.00"),
                        quarter_label="2026-Q4",
                    )
                    db.commit()
                    return "ok"
                except PayoutAlreadyApplied:
                    db.rollback()
                    return "duplicate"

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(apply_once) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]

        assert sorted(results) == ["duplicate", "ok"]
        with Session(engine) as check:
            asset = check.get_one(Asset, asset_id)
            community = check.get_one(User, community_id)
            investor = check.get_one(User, investor_id)
            entries = entries_for(check, asset_id)

            assert asset.community_wallet == D("1.00")
            assert community.cash_balance == D("10000.50")
            assert investor.cash_balance == D("10000.50")
            assert len(entries) == 1
            assert entries[0].kind is LedgerKind.PAYOUT
            assert verify(entries).valid
    finally:
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL naturex.allow_ledger_delete = 'on'"))
            params = {"world_id": world_id, "asset_id": asset_id}
            conn.execute(text("DELETE FROM ledger_entries WHERE asset_id = :asset_id"), params)
            conn.execute(text("DELETE FROM payout_lines WHERE world_id = :world_id"), params)
            conn.execute(text("DELETE FROM holdings WHERE world_id = :world_id"), params)
            conn.execute(text("DELETE FROM assets WHERE id = :asset_id"), params)
            conn.execute(text("DELETE FROM users WHERE world_id = :world_id"), params)
            conn.execute(text("DELETE FROM worlds WHERE id = :world_id"), params)
        engine.dispose()

"""Quarterly revenue and impact math (dev-spec §8, stories D4/E3).

Revenue is simulated as `value_mid × 2% / 4`, split into a community-fund half and
a dividend half. All money is rounded to cents. When cents cannot split evenly, the
largest-remainder rule assigns leftover cents by descending fractional remainder, with
ties broken by the stable holder key; the 50/50 split uses the same rule, so the
community fund receives an odd cent before the dividend pool. This creates or loses no
cents.

Only actual positive holdings receive dividends. Primary float and market-maker inventory
are unheld shares, so they receive no dividend share; the holder pool is allocated pro-rata
among held shares. The pure calculator still reports a no-holders case by assigning the
dividend pool to unallocated dividends, but `pay_quarter` rejects database payouts unless the
asset's community retained stake is recorded as a positive holding for `Asset.community_user_id`.

Market mutation lock contract for T17/T38: lock the `Asset` row first, then affected `User`
rows in ascending ID order, then `Holding` rows in ascending user ID order, before computing
or writing the mutation. `pay_quarter` follows that order. Its ledger payload keeps per-holder
payouts for the demo; this is bounded by the small sandbox holder count.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from sqlmodel import Session, col, select

from app.ledger import append
from app.models import Asset, Holding, LedgerEntry, LedgerKind, User

CAPTURE_RATE = Decimal("0.02")
_QUARTERS_PER_YEAR = Decimal("4")
_CENT = Decimal("0.01")
_IMPACT = Decimal("0.0001")


class PayoutAlreadyApplied(ValueError):
    """Raised when a payout ledger entry already exists for an asset quarter."""


class CommunityStakeMissing(ValueError):
    """Raised when the community retained stake has not been seeded as a holding."""


@dataclass(frozen=True, slots=True)
class HolderShares:
    key: str
    shares: int

    def __post_init__(self) -> None:
        if not self.key:
            raise ValueError("holder key must not be empty")
        if self.shares < 0:
            raise ValueError(f"holder shares must not be negative, got {self.shares}")


@dataclass(frozen=True, slots=True)
class HolderPayout:
    key: str
    shares: int
    amount: Decimal


@dataclass(frozen=True, slots=True)
class RevenueSplit:
    revenue: Decimal
    community_fund: Decimal
    dividend_pool: Decimal


@dataclass(frozen=True, slots=True)
class QuarterlyPayout:
    value_mid: Decimal
    capture_rate: Decimal
    split: RevenueSplit
    holder_payouts: tuple[HolderPayout, ...]
    dividends_total: Decimal
    unallocated_dividends: Decimal
    community_wallet_credit: Decimal

    @property
    def revenue(self) -> Decimal:
        return self.split.revenue


@dataclass(frozen=True, slots=True)
class ImpactInput:
    area_ha: Decimal
    carbon_stock_tco2: Decimal
    services_usd_year: Decimal

    def __post_init__(self) -> None:
        if self.area_ha < 0:
            raise ValueError(f"area_ha must not be negative, got {self.area_ha}")
        if self.carbon_stock_tco2 < 0:
            raise ValueError(
                f"carbon_stock_tco2 must not be negative, got {self.carbon_stock_tco2}"
            )
        if self.services_usd_year < 0:
            raise ValueError(
                f"services_usd_year must not be negative, got {self.services_usd_year}"
            )


@dataclass(frozen=True, slots=True)
class ImpactAllocation:
    key: str
    shares: int
    area_ha: Decimal
    carbon_stock_tco2: Decimal
    services_usd_year: Decimal


@dataclass(frozen=True, slots=True)
class AppliedPayout:
    payout: QuarterlyPayout
    ledger_entry: LedgerEntry


def _cash(value: Decimal) -> Decimal:
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def _impact(value: Decimal) -> Decimal:
    return value.quantize(_IMPACT, rounding=ROUND_HALF_UP)


def _cents(value: Decimal) -> int:
    return int((_cash(value) * 100).to_integral_exact())


def _from_cents(cents: int) -> Decimal:
    return (Decimal(cents) / 100).quantize(_CENT)


def quarterly_revenue(value_mid: Decimal, capture_rate: Decimal = CAPTURE_RATE) -> Decimal:
    """`value_mid × capture_rate / 4`, rounded to cents as required by dev-spec §8."""
    if value_mid < 0:
        raise ValueError(f"value_mid must not be negative, got {value_mid}")
    if capture_rate < 0:
        raise ValueError(f"capture_rate must not be negative, got {capture_rate}")
    return _cash(value_mid * capture_rate / _QUARTERS_PER_YEAR)


def split_revenue(revenue: Decimal) -> RevenueSplit:
    """Split revenue 50/50, conserving odd cents by assigning the tie to community."""
    if revenue < 0:
        raise ValueError(f"revenue must not be negative, got {revenue}")
    rounded = _cash(revenue)
    revenue_cents = _cents(rounded)
    community_cents = (revenue_cents + 1) // 2
    community_fund = _from_cents(community_cents)
    dividend_pool = rounded - community_fund
    return RevenueSplit(rounded, community_fund, dividend_pool)


def _allocate_cents(total: Decimal, holders: tuple[HolderShares, ...]) -> tuple[HolderPayout, ...]:
    if total < 0:
        raise ValueError(f"total must not be negative, got {total}")

    positive = tuple(
        sorted((holder for holder in holders if holder.shares > 0), key=lambda h: h.key)
    )
    if len({holder.key for holder in positive}) != len(positive):
        raise ValueError("holder keys must be unique")
    total_cents = _cents(total)
    if not positive or total_cents == 0:
        return ()

    total_shares = sum(holder.shares for holder in positive)
    rows: list[tuple[HolderShares, int, int]] = []
    allocated = 0
    for holder in positive:
        numerator = total_cents * holder.shares
        base_cents = numerator // total_shares
        remainder = numerator % total_shares
        rows.append((holder, base_cents, remainder))
        allocated += base_cents

    extra_indexes = {
        index
        for index, _row in sorted(enumerate(rows), key=lambda item: (-item[1][2], item[1][0].key))[
            : total_cents - allocated
        ]
    }
    payouts: list[HolderPayout] = []
    for index, (holder, base_cents, _remainder) in enumerate(rows):
        cents = base_cents + (1 if index in extra_indexes else 0)
        if cents > 0:
            payouts.append(HolderPayout(holder.key, holder.shares, _from_cents(cents)))
    return tuple(payouts)


def calculate_quarterly_payout(
    *, value_mid: Decimal, holders: tuple[HolderShares, ...]
) -> QuarterlyPayout:
    """Calculate one simulated quarterly payout without touching the database.

    Dividends are allocated only among positive holdings. Unheld primary-float or
    market-maker shares do not receive dividends. If no holder can receive the pool, this
    pure function reports the pool as unallocated; `pay_quarter` rejects that database state
    before applying a payout because the community retained stake must be present.
    """
    revenue = quarterly_revenue(value_mid)
    split = split_revenue(revenue)
    holder_payouts = _allocate_cents(split.dividend_pool, holders)
    dividends_total = sum((payout.amount for payout in holder_payouts), start=Decimal("0.00"))
    unallocated = split.dividend_pool - dividends_total
    return QuarterlyPayout(
        value_mid=_cash(value_mid),
        capture_rate=CAPTURE_RATE,
        split=split,
        holder_payouts=holder_payouts,
        dividends_total=dividends_total,
        unallocated_dividends=unallocated,
        community_wallet_credit=split.community_fund + unallocated,
    )


def impact_for_holding(
    key: str, *, shares: int, total_shares: int, impact: ImpactInput
) -> ImpactAllocation:
    """Return one holder's pro-rata hectares, carbon stock and annual service value."""
    if not key:
        raise ValueError("holder key must not be empty")
    if shares < 0:
        raise ValueError(f"shares must not be negative, got {shares}")
    if total_shares <= 0:
        raise ValueError(f"total_shares must be positive, got {total_shares}")
    if shares > total_shares:
        raise ValueError(f"shares must not exceed total_shares, got {shares} > {total_shares}")
    fraction = Decimal(shares) / Decimal(total_shares)
    return ImpactAllocation(
        key=key,
        shares=shares,
        area_ha=impact.area_ha * fraction,
        carbon_stock_tco2=impact.carbon_stock_tco2 * fraction,
        services_usd_year=impact.services_usd_year * fraction,
    )


def portfolio_impact(allocations: tuple[ImpactAllocation, ...]) -> ImpactInput:
    """Aggregate pro-rata impact metrics across a portfolio, then quantize once."""
    return ImpactInput(
        area_ha=_impact(
            sum((allocation.area_ha for allocation in allocations), start=Decimal("0"))
        ),
        carbon_stock_tco2=_impact(
            sum((allocation.carbon_stock_tco2 for allocation in allocations), start=Decimal("0"))
        ),
        services_usd_year=_cash(
            sum((allocation.services_usd_year for allocation in allocations), start=Decimal("0"))
        ),
    )


def _existing_payout(
    session: Session, *, world_id: UUID, asset_id: UUID, quarter_label: str
) -> LedgerEntry | None:
    entries = session.exec(
        select(LedgerEntry).where(
            LedgerEntry.world_id == world_id,
            LedgerEntry.asset_id == asset_id,
            LedgerEntry.kind == LedgerKind.PAYOUT,
        )
    ).all()
    return next(
        (entry for entry in entries if entry.payload.get("quarter_label") == quarter_label), None
    )


def _locked_asset(session: Session, *, world_id: UUID, asset_id: UUID) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id).with_for_update()
    ).one_or_none()
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in world {world_id}")
    return asset


def _positive_holder_user_ids(session: Session, *, world_id: UUID, asset_id: UUID) -> list[UUID]:
    return list(
        session.exec(
            select(Holding.user_id)
            .where(Holding.world_id == world_id, Holding.asset_id == asset_id, Holding.shares > 0)
            .order_by(col(Holding.user_id))
        ).all()
    )


def _lock_users(session: Session, *, world_id: UUID, user_ids: list[UUID]) -> dict[UUID, User]:
    if not user_ids:
        return {}
    users = session.exec(
        select(User)
        .where(User.world_id == world_id, col(User.id).in_(user_ids))
        .order_by(col(User.id))
        .with_for_update()
    ).all()
    return {user.id: user for user in users}


def _lock_holdings(session: Session, *, world_id: UUID, asset_id: UUID) -> list[Holding]:
    return list(
        session.exec(
            select(Holding)
            .where(Holding.world_id == world_id, Holding.asset_id == asset_id)
            .order_by(col(Holding.user_id))
            .with_for_update()
        ).all()
    )


def _require_community_holding(asset: Asset, holdings: list[Holding]) -> None:
    if asset.community_user_id is None or not any(
        holding.user_id == asset.community_user_id and holding.shares > 0 for holding in holdings
    ):
        raise CommunityStakeMissing(
            "community retained stake is not recorded as a holding; seed it (T31)"
        )


def pay_quarter(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    value_mid: Decimal,
    quarter_label: str,
) -> AppliedPayout:
    """Apply one quarter's payout in the caller's transaction.

    The asset row is locked before checking the payout ledger, so concurrent attempts for
    the same asset queue behind the same `SELECT … FOR UPDATE` and the second transaction
    sees the first transaction's payout entry. The function is intentionally not wired to
    routers while T17 rewrites `routers/market.py`; T38/T44 will call it from jobs/UI flows.
    """
    if not quarter_label:
        raise ValueError("quarter_label must not be empty")

    asset = _locked_asset(session, world_id=world_id, asset_id=asset_id)
    existing = _existing_payout(
        session, world_id=world_id, asset_id=asset_id, quarter_label=quarter_label
    )
    if existing is not None:
        raise PayoutAlreadyApplied(f"payout already applied for {asset_id} {quarter_label}")

    holder_user_ids = _positive_holder_user_ids(session, world_id=world_id, asset_id=asset_id)
    users_by_id = _lock_users(session, world_id=world_id, user_ids=holder_user_ids)
    holdings = _lock_holdings(session, world_id=world_id, asset_id=asset_id)
    _require_community_holding(asset, holdings)
    payout = calculate_quarterly_payout(
        value_mid=value_mid,
        holders=tuple(HolderShares(str(holding.user_id), holding.shares) for holding in holdings),
    )

    for holder_payout in payout.holder_payouts:
        user_id = UUID(holder_payout.key)
        user = users_by_id.get(user_id)
        if user is None:
            raise LookupError(f"holder user {user_id} not found in world {world_id}")
        user.cash_balance = _cash(user.cash_balance + holder_payout.amount)

    asset.community_wallet = _cash(asset.community_wallet + payout.community_wallet_credit)
    ledger_entry = append(
        session,
        world_id=world_id,
        asset_id=asset_id,
        kind=LedgerKind.PAYOUT,
        payload={
            "quarter_label": quarter_label,
            "value_mid": payout.value_mid,
            "capture_rate": payout.capture_rate,
            "revenue": payout.revenue,
            "community_fund": payout.split.community_fund,
            "dividend_pool": payout.split.dividend_pool,
            "dividends_total": payout.dividends_total,
            "unallocated_dividends": payout.unallocated_dividends,
            "community_wallet_credit": payout.community_wallet_credit,
            "holder_count": len(payout.holder_payouts),
            "holder_payouts": [
                {"user_id": p.key, "shares": p.shares, "amount": p.amount}
                for p in payout.holder_payouts
            ],
        },
    )
    return AppliedPayout(payout=payout, ledger_entry=ledger_entry)

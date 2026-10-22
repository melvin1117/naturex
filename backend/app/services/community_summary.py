"""The Steward home's numbers (T63, stories A0/A8/D4): `GET /communities/{id}/summary`.

Everything here is read from stored rows and combined by the pure functions below; nothing is
estimated. Money is in play-money dollars, cents exact.

- **Community wallet** (`assets.community_wallet`, summed over the community's listings): what
  the community has received into its fund. Two things credit it, and only these two:
  - **IPO proceeds**: each primary-float purchase pays `round_cash(qty × fill_price)` to the
    wallet (`market.engine.execute`'s `community_amount`). The order route stores the primary
    part of an order as its own `orders` row (`is_primary`), so the proceeds are the sum of
    `round_cash(qty × fill_price)` over those rows.
  - **Community-fund payouts**: each quarterly payout credits `community_wallet_credit` (the
    community fund plus any dividends nobody could receive), recorded in the public `payout`
    ledger entry (`market.revenue.pay_quarter`).
  So `balance == ipo_proceeds + community_fund_payouts`; the tests hold it to that.
- **Retained-stake dividends**: the treasury holds the retained stake and is paid dividends like
  any holder, into its own cash. They're read from the treasury's private `payout_lines`, which
  only members and same-world admins see (this endpoint's audience).
- **Holders**: investors with a positive holding, the treasury excluded (its stake is shown as
  the retained stake). Supporters are counted and ranked by shares **without names or account
  IDs**: the home doesn't need to know who they are, and members could otherwise watch
  individual investors (T67's privacy rule, applied to this members-only view too).
- **Verification** per listing (#216): its standing (`app.services.verification.standing`, the
  same reading as the IPO gate and the public panel) with the latest decision and the
  reviewer's reason, which only members and same-world admins (this endpoint's audience) read.
- **Next action** per listing, from its status, whether its IPO has launched, whether the
  caller manages it (a member) or may launch it (the owner), and whether verification blocks
  it: `next_action`. The home never offers a step the backend would refuse: while verification
  blocks the opening offer (or a revocation pauses trading), a member's next step is to verify,
  not to launch; a same-world admin, who isn't a member, is only told what it waits for.
- **Manage actions** per listing (#233): what a member may change now, read from the lifecycle's
  own transitions (`manage_actions`): edit a draft, withdraw one never listed while no rating
  run is active. **Last updated** is the listing's newest Nature Ledger entry (every lifecycle
  step, report, verification decision, opening offer and payout appends one), else its creation.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, col, select

from app.market.engine import round_cash, round_pct
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    LedgerEntry,
    LedgerKind,
    Order,
    OrderSide,
    PayoutLine,
    Report,
)
from app.schemas import ListingManageAction, NextAction
from app.services.lifecycle import ListingEvent, TransitionRefused, transition
from app.services.verification import Standing, current_views, standing
from app.worlds import LIVE_WORLD_ID

TOP_HOLDERS = 5
RECENT_PAYOUTS = 12
_ZERO = Decimal("0.00")
_HUNDRED = Decimal("100")


def next_action(
    status: AssetStatus,
    *,
    launched: bool,
    can_manage: bool,
    can_launch: bool,
    verification: Standing,
) -> NextAction:
    """draft → continue listing; rating → rating in progress; needs_evidence → add evidence;
    listed before its IPO → verify it while verification blocks the offer (in review while a
    submission waits), else launch it (the owner) or wait for the owner (stewards, admins);
    listed or suspended with a revocation standing → verify again (trading is paused until an
    approval); listed and launched, or suspended after its IPO (public, trading paused) → view
    on the Exchange; suspended before its IPO, ineligible and withdrawn → none. Only members
    (`can_manage`) verify: a same-world admin reading the home gets `awaiting_verification`."""
    if not can_manage:
        verify = NextAction.AWAITING_VERIFICATION
    elif verification.in_review:
        verify = NextAction.VERIFICATION_IN_REVIEW
    else:
        verify = NextAction.VERIFY
    match status:
        case AssetStatus.DRAFT:
            return NextAction.CONTINUE_LISTING
        case AssetStatus.RATING:
            return NextAction.RATING_IN_PROGRESS
        case AssetStatus.NEEDS_EVIDENCE:
            return NextAction.ADD_EVIDENCE
        case AssetStatus.LISTED if not launched:
            if verification.required:
                return verify
            return NextAction.LAUNCH_IPO if can_launch else NextAction.AWAITING_IPO
        case AssetStatus.LISTED | AssetStatus.SUSPENDED if verification.revoked:
            return verify
        case AssetStatus.LISTED | AssetStatus.SUSPENDED if launched:
            return NextAction.VIEW_ON_EXCHANGE
        case _:
            return NextAction.NONE


_MANAGE_EVENTS = (
    (ListingManageAction.EDIT, ListingEvent.EDIT),
    (ListingManageAction.WITHDRAW, ListingEvent.WITHDRAW),
)


def manage_actions(
    status: AssetStatus, *, can_manage: bool, run_active: bool
) -> tuple[ListingManageAction, ...]:
    """The changes a member may make now, as `transition` allows them: edit a draft; withdraw a
    draft, a needs_evidence listing, or a rating one whose run isn't active (the route refuses
    `run_in_progress` otherwise). Nothing for a non-member (a same-world admin)."""
    if not can_manage:
        return ()
    allowed: list[ListingManageAction] = []
    for action, event in _MANAGE_EVENTS:
        if event is ListingEvent.WITHDRAW and status is AssetStatus.RATING and run_active:
            continue
        try:
            transition(status, event)
        except TransitionRefused:
            continue
        allowed.append(action)
    return tuple(allowed)


@dataclass(frozen=True, slots=True)
class Wallet:
    """One listing's (or the community's) money, in play-money dollars."""

    balance: Decimal
    """`community_wallet`: IPO proceeds plus community-fund payouts."""
    ipo_proceeds: Decimal
    community_fund_payouts: Decimal
    retained_dividends: Decimal
    """Paid to the treasury for its retained stake (not part of the wallet balance)."""

    @property
    def total_received(self) -> Decimal:
        return self.balance + self.retained_dividends


EMPTY_WALLET = Wallet(_ZERO, _ZERO, _ZERO, _ZERO)


def ipo_proceeds(primary_buys: Iterable[tuple[int, Decimal]]) -> Decimal:
    """Σ `round_cash(qty × fill_price)` over primary-float purchases, as the engine credited
    them one order at a time."""
    return sum((round_cash(Decimal(qty) * price) for qty, price in primary_buys), start=_ZERO)


def _money(value: Any) -> Decimal:
    return round_cash(Decimal(str(value)))


def wallet_credit(payload: Mapping[str, Any]) -> Decimal:
    """What one payout entry credited to the community wallet. Entries from before T41's
    `community_wallet_credit` field record only `community_fund`."""
    credit = payload.get("community_wallet_credit", payload.get("community_fund", 0))
    return _money(credit)


def total_wallet(wallets: Iterable[Wallet]) -> Wallet:
    parts = list(wallets)
    return Wallet(
        balance=sum((w.balance for w in parts), start=_ZERO),
        ipo_proceeds=sum((w.ipo_proceeds for w in parts), start=_ZERO),
        community_fund_payouts=sum((w.community_fund_payouts for w in parts), start=_ZERO),
        retained_dividends=sum((w.retained_dividends for w in parts), start=_ZERO),
    )


@dataclass(frozen=True, slots=True)
class TopHolder:
    rank: int
    shares: int
    pct_of_shares: Decimal
    """Of the listing's total shares, 2 dp."""


@dataclass(frozen=True, slots=True)
class Holders:
    count: int
    shares_held: int
    """Shares investors hold (the retained stake excluded)."""
    top: tuple[TopHolder, ...]


NO_HOLDERS = Holders(0, 0, ())


def holder_summary(shares: Iterable[int], total_shares: int, top_n: int = TOP_HOLDERS) -> Holders:
    """Count and rank positive holdings by shares, largest first; no identities."""
    positive = sorted((s for s in shares if s > 0), reverse=True)
    if not positive:
        return NO_HOLDERS
    if total_shares <= 0:
        raise ValueError(f"total_shares must be positive, got {total_shares}")
    top = tuple(
        TopHolder(rank, held, round_pct(Decimal(held) / Decimal(total_shares) * _HUNDRED))
        for rank, held in enumerate(positive[:top_n], start=1)
    )
    return Holders(len(positive), sum(positive), top)


@dataclass(frozen=True, slots=True)
class ShareSplit:
    """A launched listing's shares: offered in the IPO, bought from that float, retained."""

    shares_offered: int
    shares_sold: int
    retained_shares: int


def share_split(*, total_shares: int, retained_shares: int, primary_remaining: int) -> ShareSplit:
    """The treasury's holding is the retained stake (it never trades), so the float offered
    is the rest and what's left of it shows what supporters bought."""
    offered = total_shares - retained_shares
    return ShareSplit(offered, offered - primary_remaining, retained_shares)


@dataclass(frozen=True, slots=True)
class Payout:
    asset_id: UUID
    quarter_label: str
    revenue: Decimal
    community_fund: Decimal
    """Credited to the community wallet (`community_wallet_credit`)."""
    dividends_total: Decimal
    retained_dividend: Decimal
    holder_count: int
    paid_at: datetime


@dataclass(frozen=True, slots=True)
class ListingFacts:
    asset: Asset
    next_action: NextAction
    manage_actions: tuple[ListingManageAction, ...]
    updated_at: datetime
    """The newest ledger entry's time, else the listing's creation."""
    verification: Standing
    wallet: Wallet
    holders: Holders
    shares: ShareSplit | None
    """None before the IPO: no shares exist yet."""
    recommendations: tuple[str, ...]
    report_version: int | None


@dataclass(frozen=True, slots=True)
class CommunitySummary:
    listings: tuple[ListingFacts, ...]
    wallet: Wallet
    holder_count: int
    """Distinct investors holding any of the community's listings."""
    payouts: tuple[Payout, ...]
    """Newest first, at most `RECENT_PAYOUTS`."""
    payouts_count: int


# --- Loading ------------------------------------------------------------------------------------


def _primary_buys(
    session: Session, world_id: UUID, asset_ids: Sequence[UUID]
) -> dict[UUID, list[tuple[int, Decimal]]]:
    rows = session.exec(
        select(Order.asset_id, Order.qty, col(Order.fill_price)).where(
            Order.world_id == world_id,
            col(Order.asset_id).in_(asset_ids),
            col(Order.is_primary).is_(True),
            Order.side == OrderSide.BUY,
            col(Order.fill_price).is_not(None),
        )
    ).all()
    out: dict[UUID, list[tuple[int, Decimal]]] = defaultdict(list)
    for asset_id, qty, price in rows:
        if price is not None:
            out[asset_id].append((qty, price))
    return out


def _payout_entries(
    session: Session, world_id: UUID, asset_ids: Sequence[UUID]
) -> list[LedgerEntry]:
    return list(
        session.exec(
            select(LedgerEntry)
            .where(
                LedgerEntry.world_id == world_id,
                col(LedgerEntry.asset_id).in_(asset_ids),
                LedgerEntry.kind == LedgerKind.PAYOUT,
            )
            .order_by(col(LedgerEntry.created_at).desc(), col(LedgerEntry.id).desc())
        ).all()
    )


def _treasury_lines(
    session: Session, world_id: UUID, treasuries: Mapping[UUID, UUID]
) -> dict[tuple[UUID, str], Decimal]:
    """(asset, quarter) → the treasury's dividend, from its private payout lines."""
    if not treasuries:
        return {}
    rows = session.exec(
        select(
            PayoutLine.asset_id,
            PayoutLine.quarter_label,
            col(PayoutLine.user_id),
            col(PayoutLine.amount),
        ).where(
            PayoutLine.world_id == world_id,
            col(PayoutLine.asset_id).in_(list(treasuries)),
            col(PayoutLine.user_id).in_(set(treasuries.values())),
        )
    ).all()
    return {
        (asset_id, quarter): round_cash(amount)
        for asset_id, quarter, user_id, amount in rows
        if amount is not None and treasuries.get(asset_id) == user_id
    }


def _holdings(
    session: Session, world_id: UUID, asset_ids: Sequence[UUID]
) -> list[tuple[UUID, UUID, int]]:
    return [
        (asset_id, user_id, shares)
        for asset_id, user_id, shares in session.exec(
            select(Holding.asset_id, Holding.user_id, Holding.shares).where(
                Holding.world_id == world_id,
                col(Holding.asset_id).in_(asset_ids),
                col(Holding.shares) > 0,
            )
        ).all()
    ]


def _last_entries(
    session: Session, world_id: UUID, asset_ids: Sequence[UUID]
) -> dict[UUID, datetime]:
    """Each listing's newest ledger entry time (one grouped query)."""
    rows = session.exec(
        select(LedgerEntry.asset_id, func.max(LedgerEntry.created_at))
        .where(LedgerEntry.world_id == world_id, col(LedgerEntry.asset_id).in_(asset_ids))
        .group_by(col(LedgerEntry.asset_id))
    ).all()
    return {asset_id: at for asset_id, at in rows if at is not None}


def summarize(
    session: Session,
    world_id: UUID,
    assets: Sequence[Asset],
    *,
    latest: Mapping[UUID, Report],
    can_manage: bool,
    can_launch: bool,
    active_runs: Collection[UUID] = frozenset(),
) -> CommunitySummary:
    """The home's numbers for these listings (one community's) and their latest reports, both
    loaded by the caller (the reports with the cards', so they're read once). `active_runs`:
    the listings with a rating run still active, which can't be withdrawn yet."""
    ids = [asset.id for asset in assets]
    if not ids:
        return CommunitySummary((), EMPTY_WALLET, 0, (), 0)
    treasuries = {a.id: a.community_user_id for a in assets if a.community_user_id is not None}
    buys = _primary_buys(session, world_id, ids)
    entries = _payout_entries(session, world_id, ids)
    retained = _treasury_lines(session, world_id, treasuries)
    holdings = _holdings(session, world_id, ids)
    runs = current_views(session, world_id, assets)
    last_entries = _last_entries(session, world_id, ids)

    credits: dict[UUID, Decimal] = defaultdict(lambda: _ZERO)
    payouts: list[Payout] = []
    for entry in entries:
        payload = entry.payload
        quarter = str(payload.get("quarter_label", ""))
        credits[entry.asset_id] += wallet_credit(payload)
        payouts.append(
            Payout(
                asset_id=entry.asset_id,
                quarter_label=quarter,
                revenue=_money(payload.get("revenue", 0)),
                community_fund=wallet_credit(payload),
                dividends_total=_money(payload.get("dividends_total", 0)),
                retained_dividend=retained.get((entry.asset_id, quarter), _ZERO),
                holder_count=int(payload.get("holder_count", 0)),
                paid_at=entry.created_at,
            )
        )
    dividends: dict[UUID, Decimal] = defaultdict(lambda: _ZERO)
    for (asset_id, _quarter), amount in retained.items():
        dividends[asset_id] += amount

    investor_shares: dict[UUID, list[int]] = defaultdict(list)
    retained_shares: dict[UUID, int] = {}
    investors: set[UUID] = set()
    for asset_id, user_id, shares in holdings:
        if treasuries.get(asset_id) == user_id:
            retained_shares[asset_id] = shares
        else:
            investor_shares[asset_id].append(shares)
            investors.add(user_id)

    listings: list[ListingFacts] = []
    for asset in assets:
        launched = asset.ipo_at is not None
        report = latest.get(asset.id)
        verification = standing(
            runs.get(asset.id),
            revoked_at=asset.verification_revoked_at,
            live=world_id == LIVE_WORLD_ID,
        )
        listings.append(
            ListingFacts(
                asset=asset,
                next_action=next_action(
                    asset.status,
                    launched=launched,
                    can_manage=can_manage,
                    can_launch=can_launch,
                    verification=verification,
                ),
                manage_actions=manage_actions(
                    asset.status, can_manage=can_manage, run_active=asset.id in active_runs
                ),
                updated_at=max(asset.created_at, last_entries.get(asset.id, asset.created_at)),
                verification=verification,
                wallet=Wallet(
                    balance=round_cash(asset.community_wallet),
                    ipo_proceeds=ipo_proceeds(buys.get(asset.id, ())),
                    community_fund_payouts=credits[asset.id],
                    retained_dividends=dividends[asset.id],
                ),
                holders=(
                    holder_summary(investor_shares[asset.id], asset.total_shares)
                    if launched
                    else NO_HOLDERS
                ),
                shares=(
                    share_split(
                        total_shares=asset.total_shares,
                        retained_shares=retained_shares.get(asset.id, 0),
                        primary_remaining=asset.primary_shares_remaining,
                    )
                    if launched
                    else None
                ),
                recommendations=tuple(str(r) for r in (report.recommendations or []))
                if report
                else (),
                report_version=report.version if report else None,
            )
        )
    return CommunitySummary(
        listings=tuple(listings),
        wallet=total_wallet(listing.wallet for listing in listings),
        holder_count=len(investors),
        payouts=tuple(payouts[:RECENT_PAYOUTS]),
        payouts_count=len(payouts),
    )

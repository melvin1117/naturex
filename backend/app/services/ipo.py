"""IPO launch (T59, dev-spec §8, ADR-0005): price a listed asset and open trading, once.

The IPO price is the asset's fair value per share from its latest sealed report, through the
market engine's pure functions (`ipo_terms` / `ipo`); nothing here re-derives a number. The
owner picks the offering: how many shares to issue (`total_shares`) and the % the community
retains (10–90). The shares offered are the primary float, `total_shares × (1 − retained/100)`
rounded down; the community's treasury keeps the rest as a holding.

`launch` does everything in the caller's transaction (the caller commits):

1. locks the world row `FOR KEY SHARE` (waits behind "Reset my demo", like orders), then the
   asset row `FOR UPDATE` (serializes with orders, payouts, suspend/resume and a second launch);
2. checks the asset is `listed` and not launched yet, passes the launch gate (`check_gate`:
   the T69 verification seam), has no active rating run (under the publisher lock, as T58's
   withdraw: a run started before the launch would seal its report at the old share count),
   and that the price is the one the owner confirmed and one a new account can afford;
3. sets the asset's share terms and `ipo_at`, seeds the treasury's retained holding, writes the
   first `prices` row (`reason='ipo'`) and appends a `price_anchor` ledger entry with every term
   (no account identifiers, T67);
4. publishes a public `price_tick` (`reason: "ipo"`), so the marketplace refreshes.

Lock order: world → asset → publisher, as in `app.services.listings` and the order route.

Share conservation from the IPO on: `total_shares = primary_shares_remaining +
market_maker_shares + Σ holdings`, with the treasury's retained stake as a holding and no
market-maker inventory at launch. Before the IPO no shares exist: no holdings, no float.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, select

from app.auth import STARTING_CASH
from app.events import lock_world_publisher, publish
from app.ledger import append
from app.market.engine import IpoTerms, ipo, ipo_terms
from app.market.offering import Offering
from app.models import Asset, AssetStatus, Holding, LedgerKind, Price, Report, StreamEventType
from app.services.listings import RUN_IN_PROGRESS, lock_asset, lock_world_key_share
from app.services.rating import fair_value_inputs, latest_report
from app.services.rating_runs import run_active
from app.services.verification import Standing, gate_refusal, listing_standing
from app.tools.verification import NOT_VERIFIED as NOT_VERIFIED

ALREADY_LAUNCHED = "ipo_already_launched"
NOT_LISTED = "asset_not_listed"
NO_RATING = "no_rating"
PRICE_CHANGED = "ipo_price_changed"
PRICE_TOO_LOW = "ipo_price_too_low"
PRICE_TOO_HIGH = "ipo_price_too_high"
NOT_TRADING = "not_trading"
MAX_IPO_PRICE = STARTING_CASH
"""A share must be affordable from a new account's starting cash, or nobody could buy one."""


class IpoRefused(Exception):
    """The launch (or its preview) isn't possible now (HTTP 409 `code`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class IpoQuote:
    """The IPO price with every formula term, priced from one sealed report.

    `blocked_reason` says why a launch would be refused now even though the price exists
    (the T69 gate, `run_in_progress`, `ipo_price_too_high`); None when it would go ahead.
    """

    asset_id: UUID
    report_id: UUID
    report_version: int
    terms: IpoTerms
    blocked_reason: str | None = None
    verification: Standing | None = None
    """The listing's verification, read with the gate (previews only, #216)."""

    @property
    def launchable(self) -> bool:
        return self.blocked_reason is None


@dataclass(frozen=True, slots=True)
class Launched:
    quote: IpoQuote
    launched_at: datetime


def is_trading(asset: Asset) -> bool:
    """Orders are open: the asset is listed and its IPO has happened. Suspended, unlaunched and
    unlisted assets are `not_trading`."""
    return asset.status is AssetStatus.LISTED and asset.ipo_at is not None


def quote(asset: Asset, report: Report | None, offering: Offering) -> IpoQuote:
    """Price the offering from the report (pure). Raises IpoRefused: `no_rating`, or
    `ipo_price_too_low` when the price per share would round to zero (fewer shares fixes it).
    A price above `MAX_IPO_PRICE` is quoted with `blocked_reason` `ipo_price_too_high`."""
    inputs = None if report is None else fair_value_inputs(report)
    if report is None or inputs is None:
        raise IpoRefused(NO_RATING)
    try:
        terms = ipo_terms(
            value_mid=inputs.value_mid,
            health=inputs.health,
            confidence=inputs.confidence,
            total_shares=offering.total_shares,
            retained_pct=offering.retained_pct,
        )
    except ValueError as exc:  # scores out of range: the report isn't a usable rating
        raise IpoRefused(NO_RATING) from exc
    if terms.price <= 0:
        raise IpoRefused(PRICE_TOO_LOW)
    blocked = PRICE_TOO_HIGH if terms.price > MAX_IPO_PRICE else None
    return IpoQuote(asset.id, report.id, report.version, terms, blocked)


def check_launchable(asset: Asset) -> None:
    """Status rules for a preview or a launch: not launched yet, and `listed`."""
    if asset.ipo_at is not None:
        raise IpoRefused(ALREADY_LAUNCHED)
    if asset.status is not AssetStatus.LISTED:
        raise IpoRefused(NOT_LISTED)


def check_gate(session: Session, asset: Asset) -> None:
    """The launch gate beyond `listed`, in the preview and inside the launch transaction (with
    the asset locked).

    ADR-0006 "The IPO is gated" (T69): in the live world the current verification run must be
    `verified`, a `review` run with `real` evidence, with an input fingerprint matching the
    listing; a revoked current run blocks the launch in every world. Otherwise
    `IpoRefused("not_verified")`. Sandboxes need no verification until T76's demo mode.
    """
    refusal = gate_refusal(session, asset)
    if refusal is not None:
        raise IpoRefused(refusal)


def preview(session: Session, world_id: UUID, asset_id: UUID, offering: Offering) -> IpoQuote:
    """The IPO price an owner would launch at now, with every term and whether the launch would
    go ahead (`blocked_reason`). Read-only, no locks, so an active run is advisory here.

    Raises LookupError, or IpoRefused (`ipo_already_launched`, `asset_not_listed`,
    `no_rating`, `ipo_price_too_low`)."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one_or_none()
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in world {world_id}")
    check_launchable(asset)
    priced = quote(asset, latest_report(session, world_id, asset_id), offering)
    # Why a launch would be refused now: the gate, then an active run, then the price. Where
    # verification stands is read the gate's way (`Standing.required` is its `not_verified`).
    blocked = priced.blocked_reason
    try:
        check_gate(session, asset)
    except IpoRefused as exc:
        blocked = exc.code
    else:
        if run_active(session, asset.world_id, asset.id):
            blocked = RUN_IN_PROGRESS
    stands = listing_standing(session, asset)
    return IpoQuote(
        priced.asset_id, priced.report_id, priced.report_version, priced.terms, blocked, stands
    )


def _ledger_payload(asset: Asset, q: IpoQuote) -> dict[str, Any]:
    terms = q.terms
    return {
        "reason": "ipo",
        "community_id": str(asset.community_id) if asset.community_id else None,
        "report_version": q.report_version,
        "formula": "value_mid × 10 × (0.5 + 0.5 × health/100) × "
        "(0.7 + 0.3 × confidence/100) / total_shares",
        "value_mid": str(terms.value_mid),
        "health": str(terms.health),
        "confidence": str(terms.confidence),
        "health_factor": str(terms.health_factor),
        "confidence_factor": str(terms.confidence_factor),
        "fair_value_total": str(terms.fair_value_total),
        "total_shares": terms.total_shares,
        "fair_value_per_share": str(terms.fair_value_per_share),
        "price": str(terms.price),
        "retained_pct": str(terms.retained_pct),
        "shares_offered": terms.primary_float,
        "retained_shares": terms.retained_shares,
    }


def launch(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    offering: Offering,
    *,
    expected_price: Decimal,
    now: datetime | None = None,
    require_verification: bool = True,
) -> Launched:
    """Launch the IPO (see the module docstring). The caller authorized `LAUNCH_IPO` and
    commits. `expected_price` is the price the owner confirmed in the preview (any number of
    decimals: 21.47 equals 21.4700). `require_verification=False` skips the verification gate
    for an operator's seed only (`app.jobs.seed_live`): it opens a self-attested listing, like
    the curated sites, which the public panel shows as "Self-attested by the community". No
    route passes it. Raises LookupError, or IpoRefused:
    `ipo_already_launched`, `asset_not_listed`, the gate's code (T69), `run_in_progress`,
    `no_rating`, `ipo_price_too_low`, `ipo_price_changed` or `ipo_price_too_high`."""
    launched_at = now or datetime.now(UTC)
    lock_world_key_share(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    check_launchable(asset)
    if require_verification:
        check_gate(session, asset)
    # Run activity is decided under the publisher lock (see rating_runs), after the asset's.
    lock_world_publisher(session, world_id)
    if run_active(session, world_id, asset_id):
        raise IpoRefused(RUN_IN_PROGRESS)
    q = quote(asset, latest_report(session, world_id, asset_id), offering)
    if expected_price != q.terms.price:
        raise IpoRefused(PRICE_CHANGED)
    if q.blocked_reason is not None:
        raise IpoRefused(q.blocked_reason)
    if asset.community_user_id is None:
        raise RuntimeError(f"asset {asset.id} has no community treasury to hold its stake")
    held = session.exec(
        select(func.count()).where(Holding.world_id == world_id, Holding.asset_id == asset.id)
    ).one()
    if held:
        raise RuntimeError(f"asset {asset.id} has holdings before its IPO")

    terms = q.terms
    listing = ipo(
        value_mid=terms.value_mid,
        health=terms.health,
        confidence=terms.confidence,
        total_shares=terms.total_shares,
        retained_pct=terms.retained_pct,
    )
    asset.total_shares = listing.market.total_shares
    asset.retained_pct = terms.retained_pct
    asset.primary_shares_remaining = listing.market.primary_shares_remaining
    asset.ipo_at = launched_at
    stake = Holding(
        world_id=world_id,
        user_id=asset.community_user_id,
        asset_id=asset.id,
        shares=listing.retained_shares,
    )
    price = Price(
        world_id=world_id,
        asset_id=asset.id,
        ts=launched_at,
        price=listing.price_change.price,
        reason=listing.price_change.reason.value,
    )
    session.add_all([asset, stake, price])
    session.flush()
    append(
        session,
        world_id=world_id,
        asset_id=asset.id,
        kind=LedgerKind.PRICE_ANCHOR,
        payload=_ledger_payload(asset, q),
        ref_id=q.report_id,
    )
    publish(
        session,
        world_id,
        StreamEventType.PRICE_TICK,
        {"asset_id": str(asset.id), "price": str(terms.price), "reason": "ipo"},
    )
    return Launched(q, launched_at)

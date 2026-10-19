"""IPO launch (T59, dev-spec §8, ADR-0005): price a listed asset and open trading, once.

The IPO price is the asset's fair value per share from its latest sealed report, through the
market engine's pure functions (`ipo_terms` / `ipo`); nothing here re-derives a number. The
owner picks the offering: how many shares to issue (`total_shares`) and the % the community
retains (10–90). The shares offered are the primary float, `total_shares × (1 − retained/100)`
rounded down; the community's treasury keeps the rest as a holding.

`launch` does everything in the caller's transaction (the caller commits):

1. locks the world row `FOR KEY SHARE` (waits behind "Reset my demo", like orders), then the
   asset row `FOR UPDATE` (serializes with orders, payouts, suspend/resume and a second launch);
2. checks the asset is `listed`, not launched yet and passes the launch gate (`check_gate`:
   the T69 verification seam);
3. sets the asset's share terms and `ipo_at`, seeds the treasury's retained holding, writes the
   first `prices` row (`reason='ipo'`) and appends a `price_anchor` ledger entry with every term
   (no account identifiers, T67);
4. publishes a public `price_tick` (`reason: "ipo"`) under the world's publisher lock, so the
   marketplace refreshes.

Lock order: world → asset → publisher, as in `app.services.listings` and the order route.

Share conservation from the IPO on: `total_shares = primary_shares_remaining +
market_maker_shares + Σ holdings`, with the treasury's retained stake as a holding and no
market-maker inventory at launch. Before the IPO no shares exist: no holdings, no float.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, select

from app.events import publish
from app.ledger import append
from app.market.engine import IpoTerms, ipo, ipo_terms
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    LedgerKind,
    Price,
    Report,
    StreamEventType,
    World,
)
from app.services.listings import lock_asset
from app.services.rating import latest_report

MIN_RETAINED_PCT = Decimal("10")
MAX_RETAINED_PCT = Decimal("90")
DEFAULT_RETAINED_PCT = Decimal("51.00")
MIN_TOTAL_SHARES = 10_000
"""Below this the order cap (1% of the shares) would be under 100 shares."""
MAX_TOTAL_SHARES = 10_000_000
DEFAULT_TOTAL_SHARES = 1_000_000

ALREADY_LAUNCHED = "ipo_already_launched"
NOT_LISTED = "asset_not_listed"
NO_RATING = "no_rating"
PRICE_CHANGED = "ipo_price_changed"
PRICE_TOO_LOW = "ipo_price_too_low"
NOT_TRADING = "not_trading"


class IpoRefused(Exception):
    """The launch (or its preview) isn't possible now (HTTP 409 `code`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class InvalidOffering(ValueError):
    """Shares issued or retained % out of range (HTTP 422)."""


@dataclass(frozen=True, slots=True)
class Offering:
    """What the owner chooses: the shares issued and the % the community keeps."""

    total_shares: int = DEFAULT_TOTAL_SHARES
    retained_pct: Decimal = DEFAULT_RETAINED_PCT

    def __post_init__(self) -> None:
        if not MIN_TOTAL_SHARES <= self.total_shares <= MAX_TOTAL_SHARES:
            raise InvalidOffering(
                f"total_shares must be between {MIN_TOTAL_SHARES} and {MAX_TOTAL_SHARES}"
            )
        if not MIN_RETAINED_PCT <= self.retained_pct <= MAX_RETAINED_PCT:
            raise InvalidOffering(
                f"retained_pct must be between {MIN_RETAINED_PCT} and {MAX_RETAINED_PCT}"
            )
        if self.retained_pct != self.retained_pct.quantize(Decimal("0.01")):
            raise InvalidOffering("retained_pct has at most 2 decimal places")


@dataclass(frozen=True, slots=True)
class FairValueInputs:
    value_mid: Decimal
    health: Decimal
    confidence: Decimal


@dataclass(frozen=True, slots=True)
class IpoQuote:
    """The IPO price with every formula term, priced from one sealed report."""

    asset_id: UUID
    report_id: UUID
    report_version: int
    terms: IpoTerms


@dataclass(frozen=True, slots=True)
class Launched:
    quote: IpoQuote
    launched_at: datetime


def is_trading(asset: Asset) -> bool:
    """Orders are open: the asset is listed and its IPO has happened. Suspended, unlaunched and
    unlisted assets are `not_trading`."""
    return asset.status is AssetStatus.LISTED and asset.ipo_at is not None


def _decimal(value: Any) -> Decimal | None:
    try:
        return None if value is None else Decimal(str(value))
    except InvalidOperation:
        return None


def fair_value_inputs(report: Report) -> FairValueInputs:
    """The fair value inputs a sealed report was priced from.

    Prefers the exact inputs in the report's rating snapshot (`auditor_json.rating.fair_value`,
    unrounded), so with the report's own share count the IPO price equals the report's
    `fair_value_per_share`; falls back to the stored columns. Raises IpoRefused(`no_rating`)
    if the report has no value, health or confidence.
    """
    snapshot: Mapping[str, Any] = ((report.auditor_json or {}).get("rating") or {}).get(
        "fair_value"
    ) or {}
    value_mid = _decimal(snapshot.get("value_mid")) or report.value_mid
    health = _decimal(snapshot.get("health")) or report.health_score
    confidence = _decimal(snapshot.get("confidence")) or report.confidence
    if value_mid is None or health is None or confidence is None:
        raise IpoRefused(NO_RATING)
    return FairValueInputs(value_mid=value_mid, health=health, confidence=confidence)


def quote(asset: Asset, report: Report | None, offering: Offering) -> IpoQuote:
    """Price the offering from the report (pure). Raises IpoRefused: `no_rating`, or
    `ipo_price_too_low` when the price per share would round to zero (fewer shares fixes it)."""
    if report is None:
        raise IpoRefused(NO_RATING)
    inputs = fair_value_inputs(report)
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
    return IpoQuote(asset.id, report.id, report.version, terms)


def check_launchable(asset: Asset) -> None:
    """Status rules for a preview or a launch: not launched yet, and `listed`."""
    if asset.ipo_at is not None:
        raise IpoRefused(ALREADY_LAUNCHED)
    if asset.status is not AssetStatus.LISTED:
        raise IpoRefused(NOT_LISTED)


def check_gate(session: Session, asset: Asset) -> None:
    """The launch gate beyond `listed`, inside the launch transaction with the asset locked.

    **T69 seam (ADR-0006 §"The IPO is gated"):** in the live world the current verification run
    must be `verified` with an input fingerprint matching the listing (and, in review mode, a
    `review` run with `real` evidence); T69 raises `IpoRefused("verification_required")` here
    otherwise. Until then every listed asset passes.
    """
    _ = (session, asset)


def preview(session: Session, world_id: UUID, asset_id: UUID, offering: Offering) -> IpoQuote:
    """The IPO price an owner would launch at now, with every term. Read-only, no locks.

    Raises LookupError, or IpoRefused (`ipo_already_launched`, `asset_not_listed`,
    `no_rating`, `ipo_price_too_low`)."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one_or_none()
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in world {world_id}")
    check_launchable(asset)
    return quote(asset, latest_report(session, world_id, asset_id), offering)


def _lock_world(session: Session, world_id: UUID) -> None:
    session.exec(
        select(World.id).where(World.id == world_id).with_for_update(read=True, key_share=True)
    ).one()


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
    expected_price: Decimal | None = None,
    now: datetime | None = None,
) -> Launched:
    """Launch the IPO (see the module docstring). The caller authorized `LAUNCH_IPO` and
    commits. Raises LookupError, or IpoRefused: `ipo_already_launched`, `asset_not_listed`,
    `no_rating`, `ipo_price_too_low`, or `ipo_price_changed` when `expected_price` (the price
    the owner confirmed in the preview) differs from the price now."""
    launched_at = now or datetime.now(UTC)
    _lock_world(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    check_launchable(asset)
    check_gate(session, asset)
    q = quote(asset, latest_report(session, world_id, asset_id), offering)
    if expected_price is not None and expected_price != q.terms.price:
        raise IpoRefused(PRICE_CHANGED)
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

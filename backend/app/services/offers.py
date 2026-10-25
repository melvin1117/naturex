"""Opening offers sent for review (ADR-0008 §5).

A community doesn't launch its opening offer itself: it sends the terms (how many units, the share
it keeps) once the site is rated, and the Reviewer's approval launches the offer at the price the
rating sets then. Until the approval the listing stays off the Marketplace.

- **Send** (`send`): the asset must be launchable (`listed`, not launched) and its quote not
  blocked by the price; the price the community saw must still be the one the rating sets
  (`ipo_price_changed` otherwise). The terms go on the asset (`total_shares`, `retained_pct`, the
  columns the launch reads) with `offer_sent_at`; sending again replaces them and clears an earlier
  note from the Reviewer.
- **Approve** (`approve`): launches the offer through `app.services.ipo.launch` with the stored
  terms, at the price the latest report sets now, so every gate the launch has (verification in
  the live world, a revoked verification anywhere, a rating run in progress) still applies.
- **Send back** (`send_back`): clears `offer_sent_at` and keeps the Reviewer's note for the
  community, which can change the terms and send again.

Every number is the market engine's (`app.market`); nothing here prices anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlmodel import Session, col, select

from app.market.offering import Offering
from app.models import Asset, AssetStatus
from app.services.ipo import (
    IpoQuote,
    IpoRefused,
    Launched,
    check_launchable,
    launch,
    quote,
)
from app.services.listings import lock_asset, lock_world_key_share
from app.services.rating import latest_report

NOT_SENT = "offer_not_sent"


@dataclass(frozen=True, slots=True)
class Pending:
    """An offer waiting for the Reviewer, priced the way its approval would launch it now."""

    asset: Asset
    quote: IpoQuote


def send(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    offering: Offering,
    *,
    expected_price: Decimal,
    now: datetime | None = None,
) -> IpoQuote:
    """Send (or send again) the community's opening offer for review. The caller authorized
    `LAUNCH_IPO` and commits. Raises LookupError, or IpoRefused: `ipo_already_launched`,
    `asset_not_listed`, `no_rating`, `ipo_price_too_low`, `ipo_price_too_high` or
    `ipo_price_changed`."""
    lock_world_key_share(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    check_launchable(asset)
    q = quote(asset, latest_report(session, world_id, asset_id), offering)
    if expected_price != q.terms.price:
        raise IpoRefused("ipo_price_changed")
    if q.blocked_reason is not None:
        raise IpoRefused(q.blocked_reason)
    asset.total_shares = offering.total_shares
    asset.retained_pct = offering.retained_pct
    asset.offer_sent_at = now or datetime.now(UTC)
    asset.offer_review_note = None
    session.add(asset)
    return q


def pending(session: Session, world_id: UUID) -> list[Pending]:
    """The world's offers waiting for the Reviewer, oldest first, each with today's quote."""
    assets = session.exec(
        select(Asset)
        .where(
            Asset.world_id == world_id,
            Asset.status == AssetStatus.LISTED,
            col(Asset.ipo_at).is_(None),
            col(Asset.offer_sent_at).is_not(None),
        )
        .order_by(col(Asset.offer_sent_at), col(Asset.id))
    ).all()
    out: list[Pending] = []
    for asset in assets:
        offering = Offering(asset.total_shares, asset.retained_pct)
        try:
            q = quote(asset, latest_report(session, world_id, asset.id), offering)
        except IpoRefused:
            continue
        out.append(Pending(asset, q))
    return out


def approve(
    session: Session, world_id: UUID, asset_id: UUID, *, now: datetime | None = None
) -> Launched:
    """Launch the offer the community sent, with its terms, at the price the latest report sets
    now. The caller authorized `REVIEW_LISTING` and commits. Raises LookupError, IpoRefused
    (`offer_not_sent`, or any refusal of `app.services.ipo.launch`)."""
    asset = _sent(session, world_id, asset_id)
    offering = Offering(asset.total_shares, asset.retained_pct)
    q = quote(asset, latest_report(session, world_id, asset_id), offering)
    done = launch(session, world_id, asset_id, offering, expected_price=q.terms.price, now=now)
    # The launch locked and updated the same row (one identity per session).
    asset.offer_sent_at = None
    session.add(asset)
    return done


def send_back(session: Session, world_id: UUID, asset_id: UUID, *, note: str) -> Asset:
    """Return the offer to its community with the Reviewer's note. The caller authorized
    `REVIEW_LISTING` and commits. Raises LookupError, or IpoRefused (`offer_not_sent`,
    `ipo_already_launched`, `asset_not_listed`)."""
    lock_world_key_share(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    check_launchable(asset)
    if asset.offer_sent_at is None:
        raise IpoRefused(NOT_SENT)
    asset.offer_sent_at = None
    asset.offer_review_note = note
    session.add(asset)
    return asset


def _sent(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one_or_none()
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in world {world_id}")
    check_launchable(asset)
    if asset.offer_sent_at is None:
        raise IpoRefused(NOT_SENT)
    return asset

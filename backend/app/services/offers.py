"""Opening offers sent for review (ADR-0008 §5).

A community doesn't launch its opening offer itself: it sends the terms (how many units, the share
it keeps) once the site is rated, and the Reviewer's approval launches the offer at the price the
rating sets then. Until the approval the listing stays off the Marketplace.

- **Send** (`send`): the asset must be launchable (`listed`, not launched, past the launch's
  verification gate) and its quote not blocked by the price; the price the community saw must
  still be the one the rating sets (`ipo_price_changed` otherwise). The terms go on the asset
  (`total_shares`, `retained_pct`, the columns the launch reads) with `offer_sent_at`; sending
  again replaces them and clears an earlier note from the Reviewer.
- **Approve** (`approve`): launches the offer through `app.services.ipo.launch` with the stored
  terms, at the price the latest report sets now, so every gate the launch has (verification in
  the live world, a revoked verification anywhere, a rating run in progress) still applies.
- **Send back** (`send_back`): clears `offer_sent_at` and keeps the Reviewer's note for the
  community, which can change the terms and send again.

Both decisions name the offer they decide by its `sent_at`, read under the asset's lock: an offer
sent again (new terms) or already decided since the Reviewer read it is refused `offer_changed`,
so an approval never launches terms the Reviewer didn't see.

Every number is the market engine's (`app.market`); nothing here prices anything.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import or_
from sqlmodel import Session, col, select

from app.market.offering import Offering
from app.models import Asset, AssetStatus, Report
from app.schemas import ListingOfferOut
from app.services.ipo import (
    IpoQuote,
    IpoRefused,
    Launched,
    check_gate,
    check_launchable,
    launch,
    quote,
)
from app.services.listings import lock_asset, lock_world_key_share
from app.services.rating import latest_report
from app.services.verification import gate_refusal

NOT_SENT = "offer_not_sent"
CHANGED = "offer_changed"


@dataclass(frozen=True, slots=True)
class Sent:
    quote: IpoQuote
    sent_at: datetime


@dataclass(frozen=True, slots=True)
class Pending:
    """An offer waiting for the Reviewer, priced the way its approval would launch it now.
    `quote` is None when it can't be priced; `blocked_reason` is why approving it now would be
    refused (the launch's code), so the Reviewer sends it back instead."""

    asset: Asset
    report: Report | None
    quote: IpoQuote | None
    blocked_reason: str | None


def send(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    offering: Offering,
    *,
    expected_price: Decimal,
    now: datetime | None = None,
) -> Sent:
    """Send (or send again) the community's opening offer for review. The caller authorized
    `LAUNCH_IPO` and commits. Raises LookupError, or IpoRefused: `ipo_already_launched`,
    `asset_not_listed`, the verification gate's code, `no_rating`, `ipo_price_too_low`,
    `ipo_price_too_high` or `ipo_price_changed`."""
    lock_world_key_share(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    check_launchable(asset)
    check_gate(session, asset)
    q = quote(asset, latest_report(session, world_id, asset_id), offering)
    if expected_price != q.terms.price:
        raise IpoRefused("ipo_price_changed")
    if q.blocked_reason is not None:
        raise IpoRefused(q.blocked_reason)
    asset.total_shares = offering.total_shares
    asset.retained_pct = offering.retained_pct
    sent_at = now or datetime.now(UTC)
    asset.offer_sent_at = sent_at
    asset.offer_review_note = None
    session.add(asset)
    return Sent(q, sent_at)


def pending(
    session: Session, world_id: UUID, exclude_communities: Collection[UUID] = ()
) -> list[Pending]:
    """The world's offers waiting for the Reviewer, oldest first, each with today's quote, except
    those of `exclude_communities` (the Reviewer's own: a conflict of interest). An offer that
    can't be priced or launched now stays, with why, so it can be sent back."""
    query = select(Asset).where(
        Asset.world_id == world_id,
        Asset.status == AssetStatus.LISTED,
        col(Asset.ipo_at).is_(None),
        col(Asset.offer_sent_at).is_not(None),
    )
    if exclude_communities:
        query = query.where(
            or_(
                col(Asset.community_id).is_(None),
                col(Asset.community_id).not_in(list(exclude_communities)),
            )
        )
    assets = session.exec(query.order_by(col(Asset.offer_sent_at), col(Asset.id))).all()
    out: list[Pending] = []
    for asset in assets:
        report = latest_report(session, world_id, asset.id)
        q: IpoQuote | None
        try:
            q = quote(asset, report, Offering(asset.total_shares, asset.retained_pct))
            blocked = q.blocked_reason
        except IpoRefused as exc:
            q, blocked = None, exc.code
        out.append(Pending(asset, report, q, blocked or gate_refusal(session, asset)))
    return out


def approve(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    *,
    sent_at: datetime,
    now: datetime | None = None,
) -> Launched:
    """Launch the offer sent at `sent_at`, with its terms, at the price the latest report sets
    now. The caller authorized `REVIEW_LISTING` and commits. Raises LookupError, IpoRefused
    (`offer_not_sent`, `offer_changed`, or any refusal of `app.services.ipo.launch`)."""
    asset = _locked_offer(session, world_id, asset_id, sent_at)
    offering = Offering(asset.total_shares, asset.retained_pct)
    q = quote(asset, latest_report(session, world_id, asset_id), offering)
    done = launch(session, world_id, asset_id, offering, expected_price=q.terms.price, now=now)
    # The launch locked and updated the same row (one identity per session).
    asset.offer_sent_at = None
    session.add(asset)
    return done


def send_back(
    session: Session, world_id: UUID, asset_id: UUID, *, sent_at: datetime, note: str
) -> Asset:
    """Return the offer sent at `sent_at` to its community with the Reviewer's note. The caller
    authorized `REVIEW_LISTING` and commits. Raises LookupError, or IpoRefused
    (`offer_not_sent`, `offer_changed`, `ipo_already_launched`, `asset_not_listed`)."""
    asset = _locked_offer(session, world_id, asset_id, sent_at)
    asset.offer_sent_at = None
    asset.offer_review_note = note
    session.add(asset)
    return asset


def offer_out(asset: Asset) -> ListingOfferOut | None:
    """A not-yet-launched listing's offer as its community sees it: sent, or sent back with a
    note; None before it's sent or once launched. Callers decide who may read it."""
    if asset.ipo_at is not None:
        return None
    if asset.offer_sent_at is None and asset.offer_review_note is None:
        return None
    return ListingOfferOut(
        total_shares=asset.total_shares,
        retained_pct=asset.retained_pct,
        sent_at=asset.offer_sent_at,
        review_note=asset.offer_review_note,
    )


def _locked_offer(session: Session, world_id: UUID, asset_id: UUID, sent_at: datetime) -> Asset:
    """The asset, locked, if the offer the Reviewer read (`sent_at`) still waits."""
    lock_world_key_share(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    check_launchable(asset)
    if asset.offer_sent_at is None:
        raise IpoRefused(NOT_SENT)
    if asset.offer_sent_at != sent_at:
        raise IpoRefused(CHANGED)
    return asset

"""Listing lifecycle persistence (T58): drafts, transitions, and their ledger entries and events.

The rules live in `app.services.lifecycle` (pure); this module loads state, applies a
transition and records it. Every transition, in the caller's transaction:

1. sets `assets.status` and `assets.status_reason`;
2. appends a `listing` ledger entry (`transition`, `from`, `to`, `reason` and the business
   values the step covers: the listing's details on create and edit, the rating on `rated`).
   Payloads never hold account identifiers or free text a person wrote about themselves (T67):
   the description is committed by hash and GeoJSON properties are dropped;
3. publishes a `listing_status` event with IDs and statuses only.

Lock order, as for orders (T17): the world row (`FOR NO KEY UPDATE`), then the asset row, then
the world's event publisher lock (inside `publish`). The submit transition runs inside the rating
runner's enqueue transaction instead (`submit_transition`), which holds the publisher lock first;
it never takes the world lock, and the runner refuses it while a run is active, so it can't meet
a run storing a report for the same asset.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

from sqlmodel import Session, col, select

from app.authz import Action, Actor, Allow, AssetRef, authorize
from app.events import publish
from app.ledger import append
from app.models import (
    Asset,
    AssetStatus,
    Community,
    Event,
    EventSource,
    LedgerKind,
    Report,
    StreamEventType,
    World,
)
from app.services.lifecycle import (
    NO_SATELLITE_METRICS,
    RATING_FAILED_PREFIX,
    ListingEvent,
    SuspensionReason,
    Transition,
    created,
    gate_from_report,
    is_public,
    transition,
)
from app.tools.geometry import Problem, bare_geometry, validate_polygon

STATUS_REASON_MAX = 200
_HA = Decimal("0.01")


class PolygonRejected(ValueError):
    """The drawn area failed T36's checks; every problem is reported at once."""

    def __init__(self, problems: Sequence[Problem]) -> None:
        super().__init__(", ".join(problem.code for problem in problems))
        self.problems = list(problems)


@dataclass(frozen=True, slots=True)
class ListingDetails:
    """What a community writes about a listing (already validated and normalized)."""

    name: str
    country: str | None
    description: str | None
    geojson: Mapping[str, Any]


def visible_to(actor: Actor | None, asset: Asset) -> bool:
    """Listed and suspended assets are public; any other status only to the listing's community
    members and same-world admins (`VIEW_COMMUNITY_DATA`). Routes answer 404 otherwise."""
    if is_public(asset.status):
        return True
    ref = AssetRef(asset.world_id, asset.id, asset.community_id)
    return isinstance(authorize(actor, Action.VIEW_COMMUNITY_DATA, ref), Allow)


def lock_world(session: Session, world_id: UUID) -> None:
    """The world row, as orders and community writes take it, so a reset can't race a write."""
    session.exec(select(World.id).where(World.id == world_id).with_for_update(key_share=True)).one()


def lock_asset(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    # populate_existing: the row as of the lock, not an earlier read in this session.
    asset = session.exec(
        select(Asset)
        .where(Asset.world_id == world_id, Asset.id == asset_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one_or_none()
    if asset is None:
        raise LookupError(f"asset {asset_id} not found in world {world_id}")
    return asset


def overlap_candidates(
    session: Session, world_id: UUID, *, exclude: UUID | None = None
) -> list[tuple[UUID, Mapping[str, Any]]]:
    """Every other listing in the world a new area must not overlap: any status but
    `ineligible` (drafts included, so two communities can't claim the same land at once)."""
    query = select(Asset.id, Asset.geojson).where(
        Asset.world_id == world_id, Asset.status != AssetStatus.INELIGIBLE
    )
    if exclude is not None:
        query = query.where(Asset.id != exclude)
    return [(asset_id, geojson) for asset_id, geojson in session.exec(query).all()]


def _checked_area(
    session: Session, world_id: UUID, geojson: Mapping[str, Any], *, exclude: UUID | None = None
) -> tuple[dict[str, Any], Decimal, float, float]:
    check = validate_polygon(geojson, overlap_candidates(session, world_id, exclude=exclude))
    if not check.ok or check.area_ha is None:
        raise PolygonRejected(check.problems)
    if check.centroid_lat is None or check.centroid_lon is None:  # pragma: no cover - ok ⇒ set
        raise PolygonRejected(check.problems)
    area = Decimal(repr(check.area_ha)).quantize(_HA, rounding=ROUND_HALF_UP)
    return bare_geometry(geojson), area, check.centroid_lat, check.centroid_lon


def _details_payload(asset: Asset) -> dict[str, Any]:
    description = asset.description
    return {
        "community_id": str(asset.community_id) if asset.community_id else None,
        "name": asset.name,
        "country": asset.country,
        "description_sha256": (
            hashlib.sha256(description.encode()).hexdigest() if description else None
        ),
        "area_ha": str(asset.area_ha),
        "centroid": {"lat": asset.centroid_lat, "lon": asset.centroid_lon},
        "geojson": asset.geojson,
        "attested_at": asset.attested_at.isoformat() if asset.attested_at else None,
    }


def record(
    session: Session,
    asset: Asset,
    step: Transition,
    *,
    ref_id: UUID | None = None,
    payload: Mapping[str, Any] | None = None,
    event: Mapping[str, Any] | None = None,
) -> None:
    """Apply `step` to the (locked) asset, append its ledger entry and publish its event."""
    asset.status = step.to_status
    asset.status_reason = step.reason
    session.add(asset)
    session.flush()
    common = {
        "transition": step.event.value,
        "from": step.from_status.value if step.from_status else None,
        "to": step.to_status.value,
        "reason": step.reason,
    }
    append(
        session,
        world_id=asset.world_id,
        asset_id=asset.id,
        kind=LedgerKind.LISTING,
        payload={**common, **(payload or {})},
        ref_id=ref_id,
    )
    publish(
        session,
        asset.world_id,
        StreamEventType.LISTING_STATUS,
        {
            "asset_id": str(asset.id),
            "community_id": str(asset.community_id) if asset.community_id else None,
            **common,
            **(event or {}),
        },
    )


def create_draft(
    session: Session,
    *,
    world_id: UUID,
    community_id: UUID,
    details: ListingDetails,
    now: datetime | None = None,
) -> Asset:
    """A new draft in the community, attested now; raises PolygonRejected or LookupError.

    The caller has authorized `MANAGE_LISTING` for the community and commits.
    """
    lock_world(session, world_id)
    community = session.exec(
        select(Community).where(Community.world_id == world_id, Community.id == community_id)
    ).one_or_none()
    if community is None:
        raise LookupError(f"community {community_id} not found in world {world_id}")
    geometry, area, lat, lon = _checked_area(session, world_id, details.geojson)
    asset = Asset(
        world_id=world_id,
        name=details.name,
        community_id=community.id,
        community_user_id=community.treasury_user_id,
        country=details.country,
        description=details.description,
        geojson=geometry,
        area_ha=area,
        centroid_lat=lat,
        centroid_lon=lon,
        status=AssetStatus.DRAFT,
        attested_at=now or datetime.now(UTC),
        primary_shares_remaining=0,  # set below from the defaults; T59 sets the IPO's terms
    )
    asset.primary_shares_remaining = int(
        Decimal(asset.total_shares) * (Decimal(100) - asset.retained_pct) / Decimal(100)
    )
    session.add(asset)
    session.flush()
    record(session, asset, created(), payload=_details_payload(asset))
    return asset


def update_draft(
    session: Session, world_id: UUID, asset_id: UUID, changes: Mapping[str, Any]
) -> Asset:
    """Edit a draft's name, country, description or area (only the keys in `changes`).

    Raises TransitionRefused unless the listing is a draft, PolygonRejected for a bad area.
    """
    lock_world(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    step = transition(asset.status, ListingEvent.EDIT)
    if "geojson" in changes:
        geometry, area, lat, lon = _checked_area(
            session, world_id, changes["geojson"], exclude=asset.id
        )
        asset.geojson, asset.area_ha = geometry, area
        asset.centroid_lat, asset.centroid_lon = lat, lon
    for field in ("name", "country", "description"):
        if field in changes:
            setattr(asset, field, changes[field])
    record(session, asset, step, payload=_details_payload(asset))
    return asset


def has_new_evidence(session: Session, asset: Asset) -> bool:
    """Field evidence (T40) recorded since the report that sent the listing to
    `needs_evidence`. Until T40 stores evidence, no listing can leave that status."""
    since = session.exec(
        select(Report.created_at)
        .where(Report.world_id == asset.world_id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()
    query = select(Event.id).where(
        Event.world_id == asset.world_id,
        Event.asset_id == asset.id,
        Event.source == EventSource.EVIDENCE,
    )
    if since is not None:
        query = query.where(col(Event.created_at) > since)
    return session.exec(query.limit(1)).first() is not None


def submit_transition(session: Session, asset: Asset, run_id: UUID) -> None:
    """`submit`, inside the rating runner's enqueue transaction (`RatingRunner.start`'s
    `on_queue`), so the status change, its ledger entry and the queued run commit together
    or not at all. Raises TransitionRefused."""
    locked = lock_asset(session, asset.world_id, asset.id)
    evidence = locked.status is AssetStatus.NEEDS_EVIDENCE and has_new_evidence(session, locked)
    step = transition(locked.status, ListingEvent.SUBMIT, has_new_evidence=evidence)
    record(session, locked, step, payload={"run_id": str(run_id)}, event={"run_id": str(run_id)})


def apply_rating_result(session: Session, asset: Asset, report: Report) -> Transition | None:
    """The `rated` transition for a listing in `rating`, from the gate of the report its run
    just sealed (same transaction). None for any other status: a re-rate of a listed or
    suspended asset never changes its status. Raises ValueError if the report has no gate."""
    if asset.status is not AssetStatus.RATING:
        return None
    gate = gate_from_report(report.auditor_json)
    step = transition(AssetStatus.RATING, ListingEvent.RATED, gate=gate)
    run = (report.auditor_json or {}).get("run") or {}
    record(
        session,
        asset,
        step,
        ref_id=report.id,
        payload={
            "report_version": report.version,
            "run_id": run.get("run_id"),
            "grade": report.grade,
            "health_score": str(report.health_score),
            "confidence": str(report.confidence),
            "gate": {"passed": gate.passed, "reasons": list(gate.reasons)},
        },
        event={"run_id": run.get("run_id"), "report_id": str(report.id)},
    )
    return step


def failure_reason(error: str) -> str:
    """`status_reason` for a listing whose rating run failed (it stays in `rating`)."""
    if error.endswith("no_cached_metrics"):
        return NO_SATELLITE_METRICS
    return f"{RATING_FAILED_PREFIX}{error}"[:STATUS_REASON_MAX]


def note_rating_failure(session: Session, world_id: UUID, asset_id: UUID, error: str) -> bool:
    """Record why a listing's run failed, if it is still `rating` (not a transition: the
    listing stays in `rating` and can be submitted again). Returns whether it changed."""
    try:
        asset = lock_asset(session, world_id, asset_id)
    except LookupError:
        return False
    if asset.status is not AssetStatus.RATING:
        return False
    asset.status_reason = failure_reason(error)
    session.add(asset)
    return True


def suspend(session: Session, world_id: UUID, asset_id: UUID, reason: SuspensionReason) -> Asset:
    """listed → suspended (admin moderation; T69's revocation). Raises TransitionRefused."""
    lock_world(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    record(session, asset, transition(asset.status, ListingEvent.SUSPEND, suspension=reason))
    return asset


def resume(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    """suspended → listed (admin). Raises TransitionRefused."""
    lock_world(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    record(session, asset, transition(asset.status, ListingEvent.RESUME))
    return asset

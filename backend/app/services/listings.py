"""Listing lifecycle persistence (T58): drafts, transitions, and their ledger entries and events.

The rules live in `app.services.lifecycle` (pure); this module loads state, applies a
transition and records it. Every transition, in the caller's transaction:

1. sets `assets.status` and `assets.status_reason`;
2. appends a `listing` ledger entry (`transition`, `from`, `to`, `reason` and the business
   values the step covers). Create and edit commit to the geometry by hash
   (`geometry_sha256`); the full geometry goes into the ledger once, when the draft is
   submitted, so edits can't grow the public ledger with polygons. Payloads never hold account
   identifiers or free text a person wrote (T67): the description is committed by hash and
   GeoJSON properties are dropped;
3. publishes a `listing_status` event with IDs and statuses only, scoped to the listing's
   community (and same-world admins) unless the listing ends up public.

**Locks**, in one order on every path: the world row (`FOR KEY SHARE`: waits behind a "Reset my
demo", which locks it `FOR UPDATE`, without serializing orders) → the world's listing lock (a
transaction advisory lock: overlap checks and the open-listing cap) → the asset row → the
world's event publisher lock (inside `publish`). Submit runs inside the rating runner's
enqueue transaction, which takes its global run lock first and then calls
`ListingSubmit.lock` before the publisher lock, so it follows the same order. Rating runs
storing a report take the world row (`FOR NO KEY UPDATE`) → the asset → the publisher lock.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, and_, func, or_, text
from sqlmodel import Session, col, select

from app.authz import Actor, asset_ref_of, can_see
from app.events import ADMINS_ONLY, lock_world_publisher, publish
from app.ledger import append
from app.models import (
    Asset,
    AssetStatus,
    Community,
    LedgerEntry,
    LedgerKind,
    Metrics,
    Report,
    StreamEventType,
    World,
)
from app.services.earth_obs_live import LiveQuota, LiveQuotaExceeded, reserve_live_rating
from app.services.field_evidence import has_uncounted_evidence
from app.services.lifecycle import (
    NO_SATELLITE_METRICS,
    OPEN_STATUSES,
    RATING_FAILED_PREFIX,
    SUBMITTED_STATUSES,
    ListingEvent,
    SuspensionReason,
    Transition,
    TransitionRefused,
    cooldown_remaining,
    created,
    gate_from_report,
    is_newer_data_version,
    is_public,
    transition,
)
from app.tools.geometry import (
    OVERLAP_PROBLEM,
    BBox,
    Problem,
    bare_geometry,
    check_shape,
    geometry_bbox,
    geometry_sha256,
    overlapping,
    thumbnail_outline,
)
from app.tools.verification import NOT_VERIFIED

log = logging.getLogger(__name__)

STATUS_REASON_MAX = 200
MAX_OPEN_LISTINGS = 10
"""Listings a community may have in progress (draft, rating, needs_evidence) at once."""
RESUBMIT_COOLDOWN = timedelta(minutes=10)
MAX_EDITS_PER_WINDOW = 20
EDIT_WINDOW = timedelta(hours=1)
OVERLAP = "overlap"
RATING_STALE = "rating_stale"
"""Shown (not stored) for a listing in `rating` whose run died without a result."""
RUN_IN_PROGRESS = "run_in_progress"
_HA = Decimal("0.01")
_DETAIL_FIELDS = ("name", "country", "description")


class PolygonRejected(ValueError):
    """The drawn area failed T36's checks; every problem is reported at once."""

    def __init__(self, problems: Sequence[Problem]) -> None:
        super().__init__(", ".join(problem.code for problem in problems))
        self.problems = list(problems)


class ListingLimitReached(Exception):
    """The community already has `MAX_OPEN_LISTINGS` listings in progress (HTTP 409)."""


class NoChanges(ValueError):
    """An edit that changes nothing (HTTP 400 `no_changes`)."""


class TooSoon(Exception):
    """A rate-limited listing action (HTTP 429 `code`, Retry-After `retry_after_s`)."""

    def __init__(self, code: str, retry_after_s: int) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after_s = max(1, retry_after_s)


@dataclass(frozen=True, slots=True)
class ListingDetails:
    """What a community writes about a listing (already validated and normalized)."""

    name: str
    country: str | None
    description: str | None
    geojson: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class _Area:
    geometry: dict[str, Any]
    area_ha: Decimal
    centroid_lat: float
    centroid_lon: float
    bbox: BBox


# ----- visibility and audience ------------------------------------------------------------------


def visible_to(actor: Actor | None, asset: Asset) -> bool:
    """Public assets (`lifecycle.is_public`) to anyone; any other only to the listing's
    community members and same-world admins. The rule is the policy's
    (`authz.can_see`), which already answers 404 to anyone else for every action on the asset;
    handlers re-check with this."""
    return can_see(actor, asset_ref_of(asset))


def audience(asset: Asset) -> UUID | None:
    """Who may receive live events about the asset: everyone for a public asset, else its
    community's members and same-world admins."""
    if is_public(asset.status, asset.ipo_at):
        return None
    return asset.community_id or ADMINS_ONLY


# ----- locks ------------------------------------------------------------------------------------


def lock_world_key_share(session: Session, world_id: UUID) -> None:
    """The world row `FOR KEY SHARE`: waits behind a "Reset my demo" (which locks it `FOR
    UPDATE`) without blocking other writers in the world. First in every lock order. Raises
    LookupError if the world is gone."""
    found = session.exec(
        select(World.id).where(World.id == world_id).with_for_update(read=True, key_share=True)
    ).one_or_none()
    if found is None:
        raise LookupError(f"world {world_id} not found")


def lock_listings(session: Session, world_id: UUID) -> None:
    """The world row `FOR KEY SHARE`, then the world's listing advisory lock (see the module
    docstring for the order)."""
    lock_world_key_share(session, world_id)
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"listings:{world_id}"},
    )


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


# ----- areas and overlaps -----------------------------------------------------------------------


def _checked_shape(geojson: Mapping[str, Any]) -> _Area:
    """T36's shape and area checks, before any lock; raises PolygonRejected."""
    check = check_shape(geojson)
    bbox = geometry_bbox(geojson)
    if (
        not check.ok
        or check.area_ha is None
        or check.centroid_lat is None
        or check.centroid_lon is None
        or bbox is None
    ):
        raise PolygonRejected(check.problems)
    return _Area(
        geometry=bare_geometry(geojson),
        area_ha=Decimal(repr(check.area_ha)).quantize(_HA, rounding=ROUND_HALF_UP),
        centroid_lat=check.centroid_lat,
        centroid_lon=check.centroid_lon,
        bbox=bbox,
    )


def overlap_candidates(
    session: Session,
    world_id: UUID,
    community_id: UUID | None,
    bbox: BBox | None,
    *,
    exclude: UUID | None = None,
) -> list[tuple[UUID, Mapping[str, Any]]]:
    """Listings a new or edited area must not overlap, prefiltered by bounding box (rows with no
    stored box are always included):

    - every submitted listing (rating, needs_evidence, listed, suspended) of any community:
      the first listing submitted claims the land;
    - the same community's drafts (other communities' drafts claim nothing and stay private).

    Ineligible and withdrawn listings free their land.
    """
    claims: ColumnElement[bool] = col(Asset.status).in_(SUBMITTED_STATUSES)
    if community_id is not None:
        claims = or_(
            claims,
            and_(col(Asset.status) == AssetStatus.DRAFT, col(Asset.community_id) == community_id),
        )
    query = select(Asset.id, Asset.geojson).where(Asset.world_id == world_id, claims)
    if bbox is not None:
        west, south, east, north = bbox
        query = query.where(
            or_(
                col(Asset.bbox_west).is_(None),
                and_(
                    col(Asset.bbox_west) <= east,
                    col(Asset.bbox_east) >= west,
                    col(Asset.bbox_south) <= north,
                    col(Asset.bbox_north) >= south,
                ),
            )
        )
    if exclude is not None:
        query = query.where(Asset.id != exclude)
    return [(asset_id, geojson) for asset_id, geojson in session.exec(query).all()]


def _overlaps(
    session: Session,
    world_id: UUID,
    community_id: UUID | None,
    geojson: Mapping[str, Any],
    bbox: BBox | None,
    *,
    exclude: UUID | None = None,
) -> bool:
    candidates = overlap_candidates(session, world_id, community_id, bbox, exclude=exclude)
    return bool(candidates and overlapping(geojson, candidates))


def _set_area(asset: Asset, area: _Area) -> None:
    asset.geojson, asset.area_ha = area.geometry, area.area_ha
    asset.centroid_lat, asset.centroid_lon = area.centroid_lat, area.centroid_lon
    asset.bbox_west, asset.bbox_south, asset.bbox_east, asset.bbox_north = area.bbox
    asset.outline = thumbnail_outline(area.geometry)


# ----- recording a transition -------------------------------------------------------------------


def _details_payload(asset: Asset, *, full_geometry: bool = False) -> dict[str, Any]:
    description = asset.description
    payload: dict[str, Any] = {
        "community_id": str(asset.community_id) if asset.community_id else None,
        "name": asset.name,
        "country": asset.country,
        "description_sha256": (
            hashlib.sha256(description.encode()).hexdigest() if description else None
        ),
        "area_ha": str(asset.area_ha),
        "centroid": {"lat": asset.centroid_lat, "lon": asset.centroid_lon},
        "geometry_sha256": geometry_sha256(asset.geojson),
        "attested_at": asset.attested_at.isoformat() if asset.attested_at else None,
    }
    if full_geometry:
        payload["geojson"] = asset.geojson
    return payload


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
    publish_listing_status(session, asset, {**common, **(event or {})})


def publish_listing_status(session: Session, asset: Asset, fields: Mapping[str, Any]) -> None:
    """A `listing_status` event, scoped by the asset's (new) status."""
    publish(
        session,
        asset.world_id,
        StreamEventType.LISTING_STATUS,
        {
            "asset_id": str(asset.id),
            "community_id": str(asset.community_id) if asset.community_id else None,
            **fields,
        },
        audience=audience(asset),
    )


# ----- create and edit --------------------------------------------------------------------------


def create_draft(
    session: Session,
    *,
    world_id: UUID,
    community_id: UUID,
    details: ListingDetails,
    now: datetime | None = None,
) -> Asset:
    """A new draft in the community, attested now. Raises PolygonRejected, LookupError (no such
    community in the world) or ListingLimitReached. The caller has authorized
    `MANAGE_LISTING` for the community and commits."""
    area = _checked_shape(details.geojson)  # before any lock
    community = session.exec(
        select(Community).where(Community.world_id == world_id, Community.id == community_id)
    ).one_or_none()
    if community is None:
        raise LookupError(f"community {community_id} not found in world {world_id}")
    lock_listings(session, world_id)
    open_listings = session.exec(
        select(func.count()).where(
            Asset.world_id == world_id,
            Asset.community_id == community.id,
            col(Asset.status).in_(OPEN_STATUSES),
        )
    ).one()
    if open_listings >= MAX_OPEN_LISTINGS:
        raise ListingLimitReached(community.id)
    if _overlaps(session, world_id, community.id, details.geojson, area.bbox):
        raise PolygonRejected([OVERLAP_PROBLEM])
    asset = Asset(
        world_id=world_id,
        name=details.name,
        community_id=community.id,
        community_user_id=community.treasury_user_id,
        country=details.country,
        description=details.description,
        geojson=area.geometry,
        area_ha=area.area_ha,
        status=AssetStatus.DRAFT,
        attested_at=now or datetime.now(UTC),
        primary_shares_remaining=0,  # no shares exist before the IPO (T59 sets the terms)
    )
    _set_area(asset, area)
    session.add(asset)
    session.flush()
    record(session, asset, created(), payload=_details_payload(asset))
    return asset


def _edits_in_window(session: Session, asset: Asset, now: datetime) -> list[datetime]:
    rows = session.exec(
        select(LedgerEntry.created_at)
        .where(
            LedgerEntry.asset_id == asset.id,
            LedgerEntry.kind == LedgerKind.LISTING,
            col(LedgerEntry.payload)["transition"].astext == ListingEvent.EDIT.value,
            col(LedgerEntry.created_at) > now - EDIT_WINDOW,
        )
        .order_by(col(LedgerEntry.created_at))
    ).all()
    return list(rows)


def update_draft(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    changes: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> Asset:
    """Edit a draft's name, country, description or area (only the keys in `changes`).

    Raises NoChanges if nothing would change, TransitionRefused unless the listing is a draft,
    TooSoon (`edit_rate_limited`) after `MAX_EDITS_PER_WINDOW` edits in `EDIT_WINDOW`, and
    PolygonRejected for a bad or overlapping area.
    """
    now = now or datetime.now(UTC)
    area = _checked_shape(changes["geojson"]) if "geojson" in changes else None  # before locks
    lock_listings(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    step = transition(asset.status, ListingEvent.EDIT)
    updates = {name: changes[name] for name in _DETAIL_FIELDS if name in changes}
    differs = any(getattr(asset, name) != value for name, value in updates.items())
    if not differs and (area is None or area.geometry == asset.geojson):
        raise NoChanges(asset.id)
    edits = _edits_in_window(session, asset, now)
    if len(edits) >= MAX_EDITS_PER_WINDOW:
        retry = edits[len(edits) - MAX_EDITS_PER_WINDOW] + EDIT_WINDOW - now
        raise TooSoon("edit_rate_limited", int(retry.total_seconds()) + 1)
    if area is not None and area.geometry != asset.geojson:
        if _overlaps(
            session, world_id, asset.community_id, area.geometry, area.bbox, exclude=asset.id
        ):
            raise PolygonRejected([OVERLAP_PROBLEM])
        _set_area(asset, area)
    for name, value in updates.items():
        setattr(asset, name, value)
    record(session, asset, step, payload=_details_payload(asset))
    return asset


# ----- submit and the rating result -------------------------------------------------------------


def has_new_evidence(session: Session, asset: Asset) -> bool:
    """Field evidence (T40) the latest report doesn't count yet: a validated photo that's still
    there, while that report's confidence evidence term is below validated. A deleted photo no
    longer counts, and deleting and re-uploading one the report counted adds nothing."""
    return has_uncounted_evidence(session, asset.world_id, asset.id)


def report_data_version(session: Session, asset: Asset) -> str | None:
    """The Earth observation data version of the asset's latest report."""
    return session.exec(
        select(Metrics.data_version)
        .join(Report, col(Report.metrics_id) == col(Metrics.id))
        .where(Report.world_id == asset.world_id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()


class ListingSubmit:
    """The `submit` transition, run by `RatingRunner.start(…, on_queue=ListingSubmit(…))`
    inside the run's enqueue transaction, so the status change, its ledger entry and the queued
    run commit together or not at all.

    `metrics_version` is the data version the run's metrics loader has for the listing right
    now (None: nothing), probed by the caller before any lock. `live_quota` is set when the run
    would compute the metrics live on Earth Engine (T60): the submit then counts one live rating
    under the runner's global run lock (`reserve_live_rating`). Spent, that is a 429 in the live
    world; in a sandbox it is a hidden guardrail: nothing is counted and the run falls back as if
    sandboxes never computed, rated with `fallback_version` (mocks, or None).
    """

    def __init__(
        self,
        metrics_version: str | None,
        now: datetime | None = None,
        *,
        live_quota: LiveQuota | None = None,
        fallback_version: str | None = None,
    ) -> None:
        self.metrics_version = metrics_version
        self.now = now
        self.live_quota = live_quota
        self.fallback_version = fallback_version

    def lock(self, session: Session, world_id: UUID, asset_id: UUID) -> None:
        """Called before the runner's publisher lock, keeping the module's lock order."""
        lock_listings(session, world_id)
        lock_asset(session, world_id, asset_id)

    def __call__(self, session: Session, asset: Asset, run_id: UUID) -> bool:
        """Returns whether the run may compute live metrics (its live rating was counted).
        Raises TransitionRefused (incl. `overlap`) or TooSoon (`resubmit_cooldown`, and in the
        live world `live_rating_quota` or `live_rating_global_limit`)."""
        now = self.now or datetime.now(UTC)
        locked = lock_asset(session, asset.world_id, asset.id)  # already held: no wait
        quota, refused = self.live_quota, None
        if quota is not None:  # counted first: a refusal changes a sandbox's metrics version
            try:
                reserve_live_rating(session, quota, now, run_id)
            except LiveQuotaExceeded as exc:
                refused = exc
        fall_back = refused is not None and quota is not None and quota.policy.sandbox
        version = self.fallback_version if fall_back else self.metrics_version
        needs_evidence = locked.status is AssetStatus.NEEDS_EVIDENCE
        step = transition(
            locked.status,
            ListingEvent.SUBMIT,
            has_new_evidence=needs_evidence and has_new_evidence(session, locked),
            has_newer_metrics=needs_evidence
            and is_newer_data_version(version, report_data_version(session, locked)),
            current_reason=locked.status_reason,
            metrics_available=version is not None,
        )
        wait = cooldown_remaining(locked.submitted_at, now, RESUBMIT_COOLDOWN)
        if wait:
            raise TooSoon("resubmit_cooldown", wait)
        from_draft = step.from_status is AssetStatus.DRAFT
        if from_draft and _overlaps(
            session,
            locked.world_id,
            locked.community_id,
            locked.geojson,
            geometry_bbox(locked.geojson),
            exclude=locked.id,
        ):
            raise TransitionRefused(OVERLAP)
        if refused is not None and not fall_back:
            raise TooSoon(refused.code, refused.retry_after_s) from refused
        if refused is not None:
            log.info("sandbox live rating not counted (%s): the run falls back", refused.code)
        locked.submitted_at = now
        payload = _details_payload(locked, full_geometry=True) if from_draft else {}
        record(
            session,
            locked,
            step,
            payload={**payload, "run_id": str(run_id)},
            event={"run_id": str(run_id)},
        )
        return quota is not None and refused is None


def apply_rating_result(session: Session, asset: Asset, report: Report) -> Transition | None:
    """The `rated` transition for a listing in `rating`, from the gate of the report its run
    just sealed (same transaction; the caller holds the asset lock). None for any other status:
    a re-rate of a listed or suspended asset never changes its status. Raises ValueError if the
    report has no gate."""
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
    """Record why a listing's run failed (or went stale), if it is still `rating`, and tell its
    community with a scoped `listing_status` event (`transition: rating_failed`). Not a
    transition: the listing stays in `rating` and can be submitted again, revised or withdrawn.
    Returns whether it changed anything; the caller commits."""
    try:
        asset = lock_asset(session, world_id, asset_id)
    except LookupError:
        return False
    if asset.status is not AssetStatus.RATING:
        return False
    asset.status_reason = failure_reason(error)
    session.add(asset)
    session.flush()
    publish_listing_status(
        session,
        asset,
        {
            "transition": "rating_failed",
            "from": AssetStatus.RATING.value,
            "to": AssetStatus.RATING.value,
            "reason": asset.status_reason,
        },
    )
    return True


# ----- revise, withdraw, suspend, resume --------------------------------------------------------

RunActive = Callable[[Session, UUID, UUID], bool]
"""`(session, world_id, asset_id)`: whether a rating run for the asset is still active."""


def _leave_review(
    session: Session, world_id: UUID, asset_id: UUID, event: ListingEvent, run_active: RunActive
) -> Asset:
    lock_listings(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    step = transition(asset.status, event)
    if asset.status is AssetStatus.RATING:
        # Run activity is decided under the publisher lock (see rating_runs).
        lock_world_publisher(session, world_id)
        if run_active(session, world_id, asset_id):
            raise TransitionRefused(RUN_IN_PROGRESS)
    record(session, asset, step)
    return asset


def revise(session: Session, world_id: UUID, asset_id: UUID, *, run_active: RunActive) -> Asset:
    """needs_evidence | rating (no active run) → draft, so the community can redraw and
    resubmit. Raises TransitionRefused (`run_in_progress` while a run is active)."""
    return _leave_review(session, world_id, asset_id, ListingEvent.REVISE, run_active)


def withdraw(session: Session, world_id: UUID, asset_id: UUID, *, run_active: RunActive) -> Asset:
    """draft | needs_evidence | rating (no active run) → withdrawn (terminal): the land and the
    community's open-listing slot are free again. Raises TransitionRefused."""
    return _leave_review(session, world_id, asset_id, ListingEvent.WITHDRAW, run_active)


def suspend(session: Session, world_id: UUID, asset_id: UUID, reason: SuspensionReason) -> Asset:
    """listed → suspended (admin moderation). T69's revocation suspends through
    `app.services.verification.revoke`, in the same transaction as the revoked run. Raises
    TransitionRefused."""
    lock_listings(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    record(session, asset, transition(asset.status, ListingEvent.SUSPEND, suspension=reason))
    return asset


def resume(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    """suspended → listed (admin). Raises TransitionRefused, `not_verified` while a verification
    revocation stands (`assets.verification_revoked_at`, T69): only an admin's approval of a new
    run clears it, and resumes the asset itself."""
    lock_listings(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    step = transition(asset.status, ListingEvent.RESUME)
    if asset.verification_revoked_at is not None:
        raise TransitionRefused(NOT_VERIFIED)
    record(session, asset, step)
    return asset

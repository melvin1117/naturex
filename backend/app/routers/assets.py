"""Asset routes: the marketplace, asset pages (T19) and the listing lifecycle (T58).

**Visibility (T58).** `listed` and `suspended` assets are public within their world: the
marketplace, asset pages, reports, prices and the ledger. A listing in any other status (draft,
rating, needs_evidence, ineligible) belongs to its community: only its members and same-world
admins see it (`VIEW_COMMUNITY_DATA`); everyone else gets 404, as if it didn't exist. A community
lists its own listings, at every status, with `GET /communities/{id}/assets`.

**Lifecycle (T58, `app.services.lifecycle`).** `POST /assets` creates a draft in a community the
caller owns or stewards (`MANAGE_LISTING`), with an attestation and a polygon checked by T36;
`PATCH /assets/{id}` edits a draft; `POST /assets/{id}/submit` starts a rating run whose sealed
report decides `listed`, `needs_evidence` or `ineligible`; `POST /admin/assets/{id}/suspend` and
`…/resume` are admin moderation (`OPERATE`). Lifecycle writes act in the session's world, read
from the principal, and refused transitions are 409 with a reason code.

`POST /assets/{id}/evidence` still answers with a stub until the field-evidence agent (T40).
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.authz import (
    Action,
    Actor,
    AssetRef,
    CommunityRef,
    Deny,
    DenyReason,
    Granted,
    OptionalActor,
    asset_ref,
    community_ref,
    deny_error,
    enforce,
    require,
)
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.models import Asset, AssetStatus, Community, Price, Report
from app.routers.reports import present_report, recent_events
from app.routers.runs import RunnerDep
from app.schemas import (
    AssetCard,
    AssetCreate,
    AssetDetail,
    AssetStatusOut,
    AssetSubmitted,
    AssetUpdate,
    EventOut,
    EvidenceResponse,
    PricePoint,
    ReportOut,
    SuspendRequest,
)
from app.services.lifecycle import PUBLIC_STATUSES, SuspensionReason, TransitionRefused
from app.services.listings import (
    ListingDetails,
    PolygonRejected,
    create_draft,
    lock_world,
    resume,
    submit_transition,
    suspend,
    update_draft,
    visible_to,
)
from app.services.rating_runs import (
    AssetNotRateable,
    RunInProgress,
    RunnerBusy,
    RunRateLimited,
)

router = APIRouter(tags=["assets"])

# Listings a community may have in progress (draft, rating, needs_evidence) at once.
MAX_OPEN_LISTINGS = 10
LISTING_LIMIT_REACHED = "listing_limit_reached"
_OPEN_STATUSES = (AssetStatus.DRAFT, AssetStatus.RATING, AssetStatus.NEEDS_EVIDENCE)
NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"

Responses = dict[int | str, dict[str, Any]]
_AUTH: Responses = {401: {"description": "auth_required"}}
_DENIED: Responses = {403: {"description": "A reason code, e.g. members_only or admin_only"}}
_MISSING: Responses = {404: {"description": "Not found in the caller's world"}}
_POLYGON: Responses = {
    422: {
        "description": "Invalid body, or the polygon fails T36's checks: each problem is an "
        "item with `type` `polygon.<code>` (invalid_geojson, too_complex, self_intersection, "
        "too_small, too_large, overlap) at `loc` [body, geojson]"
    }
}
ListingAccess = Annotated[Granted, require(Action.MANAGE_LISTING, asset_ref)]
OperateAsset = Annotated[Granted, require(Action.OPERATE, asset_ref)]
CommunityData = Annotated[Granted, require(Action.VIEW_COMMUNITY_DATA, community_ref)]


_HUNDRED = Decimal(100)
# Marketplace sparkline length: the latest prices per card, oldest first.
SPARKLINE_POINTS = 30


def world_asset(
    session: Session, world_id: UUID, asset_id: UUID, actor: Actor | None = None
) -> Asset:
    """The asset if it's in this world and `actor` may see it (T58); 404 otherwise: another
    world's, the template's, or a listing that isn't public and isn't the actor's community's."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).first()
    if asset is None or not visible_to(actor, asset):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")
    return asset


def _price_per_asset(session: Session, world_id: UUID, *, latest: bool) -> dict[UUID, Decimal]:
    """The latest (or first, i.e. IPO) price of every asset in the world."""
    ts = col(Price.ts).desc() if latest else col(Price.ts).asc()
    rows = session.exec(
        select(col(Price.asset_id), col(Price.price))
        .where(Price.world_id == world_id)
        .order_by(col(Price.asset_id), ts)
        .distinct(col(Price.asset_id))
    ).all()
    return {asset_id: price for asset_id, price in rows}


def _sparklines(session: Session, world_id: UUID) -> dict[UUID, list[Decimal]]:
    """The last `SPARKLINE_POINTS` prices of every asset in the world, oldest first (one query)."""
    ranked = (
        select(
            col(Price.asset_id).label("asset_id"),
            col(Price.price).label("price"),
            col(Price.ts).label("ts"),
            func.row_number()
            .over(partition_by=col(Price.asset_id), order_by=col(Price.ts).desc())
            .label("rank"),
        )
        .where(Price.world_id == world_id)
        .subquery()
    )
    rows = session.exec(
        select(ranked.c.asset_id, ranked.c.price)
        .where(ranked.c.rank <= SPARKLINE_POINTS)
        .order_by(ranked.c.asset_id, ranked.c.ts)
    ).all()
    out: dict[UUID, list[Decimal]] = {}
    for asset_id, price in rows:
        out.setdefault(asset_id, []).append(price)
    return out


def _latest_two_reports(session: Session, world_id: UUID) -> dict[UUID, list[Report]]:
    """Each asset's latest report and the one before it (for the trend)."""
    rows = session.exec(
        select(Report)
        .where(Report.world_id == world_id)
        .order_by(col(Report.asset_id), col(Report.version).desc())
    ).all()
    out: dict[UUID, list[Report]] = {}
    for report in rows:
        latest = out.setdefault(report.asset_id, [])
        if len(latest) < 2:
            latest.append(report)
    return out


def _trend(headlines: list[Report]) -> str | None:
    if len(headlines) < 2:
        return None
    current, previous = headlines[0].health_score, headlines[1].health_score
    if current is None or previous is None:
        return None
    if current > previous:
        return "improving"
    return "declining" if current < previous else "stable"


def _change_pct(latest: Decimal | None, ipo: Decimal | None) -> float | None:
    if latest is None or ipo is None or ipo <= 0:
        return None
    return float(((latest - ipo) / ipo * _HUNDRED).quantize(Decimal("0.01")))


def _asset_price(session: Session, asset: Asset, *, latest: bool) -> Decimal | None:
    """The asset's latest (or first, i.e. IPO) price."""
    ts = col(Price.ts).desc() if latest else col(Price.ts).asc()
    return session.exec(
        select(col(Price.price))
        .where(Price.world_id == asset.world_id, Price.asset_id == asset.id)
        .order_by(ts)
        .limit(1)
    ).first()


@router.get("/assets", response_model=list[AssetCard])
def list_assets(world: CurrentWorld, session: SessionDep) -> list[AssetCard]:
    """Marketplace cards for the world's public assets: listed and suspended (T58)."""
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == world.id, col(Asset.status).in_(PUBLIC_STATUSES))
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    return _cards(session, world.id, assets)


def _cards(session: Session, world_id: UUID, assets: Sequence[Asset]) -> list[AssetCard]:
    reports = _latest_two_reports(session, world_id)
    latest_prices = _price_per_asset(session, world_id, latest=True)
    ipo_prices = _price_per_asset(session, world_id, latest=False)
    sparklines = _sparklines(session, world_id)
    cards: list[AssetCard] = []
    for asset in assets:
        headlines = reports.get(asset.id, [])
        latest = headlines[0] if headlines else None
        price = latest_prices.get(asset.id)
        cards.append(
            AssetCard(
                id=asset.id,
                name=asset.name,
                country=asset.country,
                status=AssetStatusOut(asset.status.value),
                status_reason=asset.status_reason,
                area_ha=asset.area_ha,
                price=price,
                price_change_pct=_change_pct(price, ipo_prices.get(asset.id)),
                grade=latest.grade if latest else None,
                trend=_trend(headlines),
                confidence=latest.confidence if latest else None,
                health_score=latest.health_score if latest else None,
                value_low=latest.value_low if latest else None,
                value_mid=latest.value_mid if latest else None,
                value_high=latest.value_high if latest else None,
                cover_image_url=asset.cover_image_url,
                site_key=asset.site_key,
                sparkline=sparklines.get(asset.id, []),
            )
        )
    return cards


@router.get(
    "/communities/{community_id}/assets",
    response_model=list[AssetCard],
    responses={**_AUTH, **_DENIED, **_MISSING},
)
def list_community_assets(
    granted: CommunityData, session: SessionDep, response: Response
) -> list[AssetCard]:
    """The community's listings at every status, drafts included (its members and same-world
    admins only): the Steward app's listing flow."""
    ref = granted.resource
    if not isinstance(ref, CommunityRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == ref.world_id, Asset.community_id == ref.community_id)
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return _cards(session, ref.world_id, assets)


def asset_detail(session: Session, asset: Asset, settings: SettingsDep) -> AssetDetail:
    report = session.exec(
        select(Report)
        .where(Report.world_id == asset.world_id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()
    price = _asset_price(session, asset, latest=True)
    return AssetDetail(
        id=asset.id,
        name=asset.name,
        country=asset.country,
        description=asset.description,
        community_id=asset.community_id,
        status=AssetStatusOut(asset.status.value),
        status_reason=asset.status_reason,
        area_ha=asset.area_ha,
        centroid_lat=asset.centroid_lat,
        centroid_lon=asset.centroid_lon,
        geojson=asset.geojson,
        total_shares=asset.total_shares,
        retained_pct=asset.retained_pct,
        primary_shares_remaining=asset.primary_shares_remaining,
        community_wallet=asset.community_wallet,
        site_key=asset.site_key,
        latest_report=present_report(session, report, asset, settings) if report else None,
        recent_events=recent_events(session, asset),
        price=price,
        price_change_pct=_change_pct(price, _asset_price(session, asset, latest=False)),
    )


def _polygon_error(exc: PolygonRejected) -> HTTPException:
    """422 in FastAPI's validation-error shape, one item per problem (T36 reports them all)."""
    detail = [
        {"type": f"polygon.{problem.code}", "loc": ["body", "geojson"], "msg": problem.message}
        for problem in exc.problems
    ]
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _refused(exc: TransitionRefused) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, exc.code, headers={"Cache-Control": NO_STORE})


def _listing(session: Session, granted: Granted) -> Asset:
    ref = granted.resource
    if not isinstance(ref, AssetRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    return session.exec(
        select(Asset).where(Asset.world_id == ref.world_id, Asset.id == ref.asset_id)
    ).one()


@router.post(
    "/assets",
    response_model=AssetDetail,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_AUTH,
        **_DENIED,
        404: {"description": "The community isn't in the caller's world"},
        409: {"description": LISTING_LIMIT_REACHED},
        **_POLYGON,
    },
)
def create_listing(
    body: AssetCreate,
    actor: OptionalActor,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    """Create a **draft** listing in a community the caller owns or stewards, in the session's
    world. Needs `attestation: true`; the polygon must pass T36's checks and not overlap any
    other listing in the world (ineligible ones excepted). Nothing is public until it's listed."""
    if actor is None:
        raise deny_error(Deny(DenyReason.AUTH_REQUIRED))
    community = session.exec(
        select(Community.id).where(
            Community.world_id == actor.world_id, Community.id == body.community_id
        )
    ).first()
    if community is None:
        raise deny_error(Deny(DenyReason.NOT_FOUND))
    # The resource is the listing about to exist in that community.
    enforce(actor, Action.MANAGE_LISTING, AssetRef(actor.world_id, uuid4(), community))
    details = ListingDetails(
        name=body.name, country=body.country, description=body.description, geojson=body.geojson
    )
    # Under the world lock (create_draft takes it again), so concurrent creates can't both pass.
    lock_world(session, actor.world_id)
    open_listings = session.exec(
        select(func.count()).where(
            Asset.world_id == actor.world_id,
            Asset.community_id == community,
            col(Asset.status).in_(_OPEN_STATUSES),
        )
    ).one()
    if open_listings >= MAX_OPEN_LISTINGS:
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, LISTING_LIMIT_REACHED)
    try:
        asset = create_draft(
            session, world_id=actor.world_id, community_id=community, details=details
        )
    except PolygonRejected as exc:
        session.rollback()
        raise _polygon_error(exc) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.patch(
    "/assets/{asset_id}",
    response_model=AssetDetail,
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "`cannot_edit_<status>`: only drafts can be edited"},
        **_POLYGON,
    },
)
def edit_listing(
    body: AssetUpdate,
    granted: ListingAccess,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    """Edit a draft (its community's owner or stewards). Only the fields sent change."""
    ref = _listing(session, granted)
    changes: dict[str, Any] = body.model_dump(include=body.model_fields_set)
    try:
        asset = update_draft(session, ref.world_id, ref.id, changes)
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc) from None
    except PolygonRejected as exc:
        session.rollback()
        raise _polygon_error(exc) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.post(
    "/assets/{asset_id}/submit",
    response_model=AssetSubmitted,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {
            "description": "`cannot_submit_<status>`, `evidence_required` (needs_evidence with "
            "no new field evidence) or `run_in_progress` (Location: the active run)"
        },
        429: {"description": "`rating_rate_limited` or `rating_global_limit`; see Retry-After"},
        503: {"description": "`rating_busy`; see Retry-After"},
    },
)
def submit_listing(
    granted: ListingAccess, session: SessionDep, runner: RunnerDep, response: Response
) -> AssetSubmitted:
    """Submit a draft for rating (or resubmit: a `needs_evidence` listing with new evidence,
    or a `rating` listing whose run failed). The move to `rating`, its ledger entry and the
    queued run commit together; the run's sealed report then sets `listed`, `needs_evidence`
    or `ineligible`. Follow it with `GET /runs/{run_id}` or `listing_status` events."""
    ref = granted.resource
    if not isinstance(ref, AssetRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    # End the read transaction: the runner uses its own session and waits on run locks.
    session.commit()
    try:
        run_id = runner.start(
            ref.world_id, ref.asset_id, trigger="listing", on_queue=submit_transition
        )
    except TransitionRefused as exc:
        raise _refused(exc) from None
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found") from exc
    except AssetNotRateable as exc:  # pragma: no cover - on_queue moves drafts first
        raise HTTPException(status.HTTP_409_CONFLICT, exc.code) from exc
    except RunInProgress as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "run_in_progress",
            headers={"Location": f"/runs/{exc.run_id}"},
        ) from exc
    except RunRateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            exc.code,
            headers={"Retry-After": str(exc.retry_after_s)},
        ) from exc
    except RunnerBusy as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "rating_busy",
            headers={"Retry-After": str(exc.retry_after_s)},
        ) from exc
    response.headers["Location"] = f"/runs/{run_id}"
    response.headers["Cache-Control"] = NO_STORE
    return AssetSubmitted(asset_id=ref.asset_id, run_id=run_id, status=AssetStatusOut.RATING)


@router.post(
    "/admin/assets/{asset_id}/suspend",
    response_model=AssetDetail,
    tags=["admin"],
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "`cannot_suspend_<status>`: only listed assets"},
    },
)
def suspend_listing(
    body: SuspendRequest,
    granted: OperateAsset,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    """Suspend trading on a listed asset (admins, never on their own community's asset)."""
    ref = _listing(session, granted)
    try:
        asset = suspend(session, ref.world_id, ref.id, SuspensionReason(body.reason))
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.post(
    "/admin/assets/{asset_id}/resume",
    response_model=AssetDetail,
    tags=["admin"],
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "`cannot_resume_<status>`: only suspended assets"},
    },
)
def resume_listing(
    granted: OperateAsset, session: SessionDep, settings: SettingsDep, response: Response
) -> AssetDetail:
    """Resume trading on a suspended asset (admins, never on their own community's asset)."""
    ref = _listing(session, granted)
    try:
        asset = resume(session, ref.world_id, ref.id)
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.get("/assets/{asset_id}", response_model=AssetDetail, responses=_MISSING)
def get_asset(
    asset_id: UUID,
    world: CurrentWorld,
    actor: OptionalActor,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    asset = world_asset(session, world.id, asset_id, actor)
    if asset.status not in PUBLIC_STATUSES:
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return asset_detail(session, asset, settings)


@router.post("/assets/{asset_id}/evidence", response_model=EvidenceResponse)
def upload_evidence(
    asset_id: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep
) -> EvidenceResponse:
    world_asset(session, world.id, asset_id, actor)
    event = EventOut(
        id=uuid4(),
        asset_id=asset_id,
        source="evidence",
        title="Field photo evidence (mock)",
        url=None,
        published_at=None,
        impact_type="other",
        direction=1,
        severity=2,
        summary="Mock geotagged photo analysis: healthy flooded vegetation observed.",
        created_at=datetime.now(UTC),
    )
    return EvidenceResponse(event=event, message="Evidence accepted (mock); confidence updated.")


@router.get("/assets/{asset_id}/reports", response_model=list[ReportOut])
def list_reports(
    asset_id: UUID,
    world: CurrentWorld,
    actor: OptionalActor,
    session: SessionDep,
    settings: SettingsDep,
) -> list[ReportOut]:
    """Every report of the asset, newest first. Versions leave out `ndvi_series` (the chart
    is for the latest report: `GET /assets/{id}` or `GET /reports/{id}`)."""
    asset = world_asset(session, world.id, asset_id, actor)
    reports = session.exec(
        select(Report)
        .where(Report.world_id == world.id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
    ).all()
    return [present_report(session, report, asset, settings, with_ndvi=False) for report in reports]


@router.get("/assets/{asset_id}/prices", response_model=list[PricePoint])
def list_prices(
    asset_id: UUID,
    world: CurrentWorld,
    actor: OptionalActor,
    session: SessionDep,
    range: str = "90d",
) -> list[PricePoint]:
    """Price history, oldest first. `range` is accepted but not applied yet (T43)."""
    _ = range  # TODO(T43): apply the range filter (7d, 30d, 90d, all).
    asset = world_asset(session, world.id, asset_id, actor)
    prices = session.exec(
        select(Price)
        .where(Price.world_id == world.id, Price.asset_id == asset.id)
        .order_by(col(Price.ts))
    ).all()
    return [PricePoint(ts=p.ts, price=p.price, reason=p.reason) for p in prices]

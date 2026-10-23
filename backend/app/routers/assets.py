"""Asset reads: the marketplace and asset pages (T19), with T58's visibility rules.

**Visibility (T58).** `listed` and `suspended` assets are public within their world: the
marketplace, asset pages, reports, prices and the ledger. A listing in any other status (draft,
rating, needs_evidence, ineligible, withdrawn) belongs to its community: only its members and
same-world admins see it (`VIEW_COMMUNITY_DATA`); everyone else gets 404, as if it didn't exist.
The lifecycle's writes are in `app.routers.listings`.

Field evidence (T40) is in `app.routers.evidence`. A live-rated listing's land-cover overlay
(#231) is `GET /assets/{asset_id}/overlay.png`, with its metadata in the detail's
`land_cover_overlay`; the demo sites' precomputed one is in `app.routers.media`.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import asdict
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from sqlmodel import Session, col, select

from app.authz import Action, Actor, OptionalActor, asset_ref, require
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.models import Asset, AssetOverlay, AssetStatus, Price, Report
from app.routers.reports import present_report, recent_events
from app.schemas import (
    AssetCard,
    AssetDetail,
    AssetOutline,
    AssetOutlines,
    AssetStatusOut,
    CachedExample,
    LandCoverOverlay,
    OverlayBounds,
    PricePoint,
    ReportOut,
)
from app.services.asset_cards import (
    cards,
    change_pct,
    is_mock_report,
    shown_status_reason,
    thumbnail_outline_of,
)
from app.services.cached_example import cached_example
from app.services.ipo import is_trading
from app.services.land_cover_overlays import current_overlay
from app.services.lifecycle import is_public
from app.services.listings import visible_to
from app.services.rating_runs import assets_with_active_runs, latest_run_id
from app.services.visibility import public_assets
from app.tools.earth_obs import DateWindow
from app.tools.geometry import outline_rings
from app.tools.site_images import OVERLAY_ATTRIBUTIONS, OVERLAY_DATASET_ID, OVERLAY_METHOD

router = APIRouter(tags=["assets"])

PRIVATE_NO_STORE = "private, no-store"
Responses = dict[int | str, dict[str, Any]]
_MISSING: Responses = {404: {"description": "Not found in the caller's world"}}
# Every route authorizes through `app.authz.require` (T57); reads load the asset by
# `(world_id, id)` first, so another world's asset is a 404.
BROWSE_WORLD = require(Action.BROWSE)
BROWSE_ASSET = require(Action.BROWSE, asset_ref)


def world_asset(
    session: Session, world_id: UUID, asset_id: UUID, actor: Actor | None = None
) -> Asset:
    """The asset if it's in this world and `actor` may see it (T58); 404 otherwise: another
    world's, the template's, or a listing that isn't public and isn't the actor's community's."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).first()
    if asset is None or not visible_to(actor, asset):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return asset


def _asset_price(session: Session, asset: Asset, *, latest: bool) -> Decimal | None:
    """The asset's latest (or first, i.e. IPO) price."""
    ts = col(Price.ts).desc() if latest else col(Price.ts).asc()
    return session.exec(
        select(col(Price.price))
        .where(Price.world_id == asset.world_id, Price.asset_id == asset.id)
        .order_by(ts)
        .limit(1)
    ).first()


@router.get("/assets", response_model=list[AssetCard], dependencies=[BROWSE_WORLD])
def list_assets(world: CurrentWorld, session: SessionDep) -> list[AssetCard]:
    """Marketplace cards for the world's public assets: listed or suspended, and launched."""
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == world.id, public_assets())
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    return cards(session, world.id, assets)


OUTLINES_MAX_SITES = 300
"""Sites per `GET /assets/outlines` answer (oldest first); `truncated` says if there are more."""


@router.get("/assets/outlines", response_model=AssetOutlines, dependencies=[BROWSE_WORLD])
def list_outlines(world: CurrentWorld, session: SessionDep, response: Response) -> AssetOutlines:
    """The boundaries of the world's public sites (listed or suspended, and launched),
    simplified on the server to at most 200 corners each, for the listing map's outlines and
    overlap hint (T33). Only a hint: T36's overlap check on create and submit is what decides,
    and it also counts private listings (under review, or not launched yet)."""
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == world.id, public_assets())
        .order_by(col(Asset.created_at), col(Asset.id))
        .limit(OUTLINES_MAX_SITES + 1)
    ).all()
    outlines = [
        AssetOutline(id=asset.id, name=asset.name, rings=outline_rings(asset.geojson))
        for asset in assets[:OUTLINES_MAX_SITES]
    ]
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return AssetOutlines(outlines=outlines, truncated=len(assets) > OUTLINES_MAX_SITES)


def asset_detail(
    session: Session, asset: Asset, settings: SettingsDep, actor: Actor | None = None
) -> AssetDetail:
    """The asset page's data; `actor` decides whether `latest_run_id` is shown."""
    report = session.exec(
        select(Report)
        .where(Report.world_id == asset.world_id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()
    price = _asset_price(session, asset, latest=True)
    reviewing = asset.status is AssetStatus.RATING
    active = assets_with_active_runs(session, asset.world_id) if reviewing else set()
    return AssetDetail(
        id=asset.id,
        name=asset.name,
        country=asset.country,
        description=asset.description,
        community_id=asset.community_id,
        status=AssetStatusOut(asset.status.value),
        status_reason=shown_status_reason(asset, active),
        area_ha=asset.area_ha,
        centroid_lat=asset.centroid_lat,
        centroid_lon=asset.centroid_lon,
        geojson=asset.geojson,
        # Shares exist from the IPO on; until then the column is only the rating's reference.
        total_shares=asset.total_shares if asset.ipo_at else None,
        retained_pct=asset.retained_pct if asset.ipo_at else None,
        primary_shares_remaining=asset.primary_shares_remaining,
        community_wallet=asset.community_wallet,
        cover_image_url=asset.cover_image_url,
        site_key=asset.site_key,
        outline=thumbnail_outline_of(asset),
        mock=is_mock_report(report),
        latest_report=present_report(session, report, asset, settings) if report else None,
        recent_events=recent_events(session, asset),
        price=price,
        price_change_pct=change_pct(price, _asset_price(session, asset, latest=False)),
        trading=is_trading(asset),
        ipo_at=asset.ipo_at,
        cached_example=_cached_example(session, asset, active),
        land_cover_overlay=_land_cover_overlay(session, asset),
        # Only for a private listing (under review, or not launched yet), which only its
        # community and admins can load (so public reads never need the caller's roles: T57).
        latest_run_id=(
            latest_run_id(session, asset.world_id, asset.id)
            if not is_public(asset.status, asset.ipo_at) and visible_to(actor, asset)
            else None
        ),
    )


def _overlay_version(overlay: AssetOverlay) -> str:
    return f"{overlay.geometry_sha256[:12]}-{int(overlay.created_at.timestamp())}"


def _land_cover_overlay(session: Session, asset: Asset) -> LandCoverOverlay | None:
    overlay = current_overlay(session, asset.world_id, asset.id, asset.geojson, with_png=False)
    if overlay is None:
        return None
    return LandCoverOverlay(
        version=_overlay_version(overlay),
        width=overlay.width,
        height=overlay.height,
        bounds=OverlayBounds(
            south=overlay.south, west=overlay.west, north=overlay.north, east=overlay.east
        ),
        dataset_id=OVERLAY_DATASET_ID,
        method=OVERLAY_METHOD,
        date_window=DateWindow(
            start=overlay.date_start.isoformat(), end=overlay.date_end.isoformat()
        ),
        attributions=list(OVERLAY_ATTRIBUTIONS),
    )


def _cached_example(
    session: Session, asset: Asset, active: Collection[UUID]
) -> CachedExample | None:
    if asset.id in active:  # a retry is running
        return None
    example = cached_example(session, asset)
    return None if example is None else CachedExample(**asdict(example))


@router.get(
    "/assets/{asset_id}",
    response_model=AssetDetail,
    responses=_MISSING,
    dependencies=[BROWSE_ASSET],
)
def get_asset(
    asset_id: UUID,
    world: CurrentWorld,
    actor: OptionalActor,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    asset = world_asset(session, world.id, asset_id, actor)
    if not is_public(asset.status, asset.ipo_at):
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return asset_detail(session, asset, settings, actor)


@router.get(
    "/assets/{asset_id}/reports", response_model=list[ReportOut], dependencies=[BROWSE_ASSET]
)
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


@router.get(
    "/assets/{asset_id}/prices", response_model=list[PricePoint], dependencies=[BROWSE_ASSET]
)
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


# Versioned URLs (`?v=`, the detail's `land_cover_overlay.version`) change on re-render.
OVERLAY_PUBLIC_CACHE = "public, max-age=86400"


@router.get(
    "/assets/{asset_id}/overlay.png",
    response_class=Response,
    responses={
        200: {
            "description": "Land-cover overlay PNG",
            "content": {"image/png": {"schema": {"type": "string", "format": "binary"}}},
        },
        404: {"description": "Not found in the caller's world, or no overlay (yet)"},
    },
    dependencies=[BROWSE_ASSET],
)
def get_land_cover_overlay(
    asset_id: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep
) -> Response:
    """The listing's Dynamic World land-cover overlay from its live satellite rating (#231):
    an indexed PNG, transparent outside the boundary, spanning `land_cover_overlay.bounds`.
    404 `overlay_not_found` before a live rating rendered one for the current boundary."""
    asset = world_asset(session, world.id, asset_id, actor)
    overlay = current_overlay(session, world.id, asset.id, asset.geojson)
    if overlay is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "overlay_not_found")
    public = is_public(asset.status, asset.ipo_at)
    return Response(
        content=overlay.png,
        media_type="image/png",
        headers={
            "Cache-Control": OVERLAY_PUBLIC_CACHE if public else PRIVATE_NO_STORE,
            "X-Content-Type-Options": "nosniff",
        },
    )

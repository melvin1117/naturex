"""Asset reads: the marketplace and asset pages (T19), with T58's visibility rules.

**Visibility (T58).** `listed` and `suspended` assets are public within their world: the
marketplace, asset pages, reports, prices and the ledger. A listing in any other status (draft,
rating, needs_evidence, ineligible, withdrawn) belongs to its community: only its members and
same-world admins see it (`VIEW_COMMUNITY_DATA`); everyone else gets 404, as if it didn't exist.
The lifecycle's writes are in `app.routers.listings`.

`POST /assets/{id}/evidence` still answers with a stub until the field-evidence agent (T40).
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.authz import Action, Actor, DenyReason, OptionalActor, asset_ref, denied, require
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.models import Asset, AssetStatus, Price, Report
from app.routers.reports import present_report, recent_events
from app.schemas import (
    AssetCard,
    AssetDetail,
    AssetStatusOut,
    EventOut,
    EvidenceResponse,
    PricePoint,
    ReportOut,
)
from app.services.ipo import is_trading
from app.services.lifecycle import PUBLIC_STATUSES
from app.services.listings import RATING_STALE, visible_to
from app.services.rating_runs import assets_with_active_runs
from app.tools.earth_obs import MOCK_FLAG

router = APIRouter(tags=["assets"])

PRIVATE_NO_STORE = "private, no-store"
Responses = dict[int | str, dict[str, Any]]
_MISSING: Responses = {404: {"description": "Not found in the caller's world"}}
# Every route authorizes through `app.authz.require` (T57); reads load the asset by
# `(world_id, id)` first, so another world's asset is a 404.
BROWSE_WORLD = require(Action.BROWSE)
BROWSE_ASSET = require(Action.BROWSE, asset_ref)


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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return asset


def _price_per_asset(
    session: Session, world_id: UUID, asset_ids: Collection[UUID], *, latest: bool
) -> dict[UUID, Decimal]:
    """The latest (or first, i.e. IPO) price of each of these assets."""
    ts = col(Price.ts).desc() if latest else col(Price.ts).asc()
    rows = session.exec(
        select(col(Price.asset_id), col(Price.price))
        .where(Price.world_id == world_id, col(Price.asset_id).in_(asset_ids))
        .order_by(col(Price.asset_id), ts)
        .distinct(col(Price.asset_id))
    ).all()
    return {asset_id: price for asset_id, price in rows}


def _sparklines(
    session: Session, world_id: UUID, asset_ids: Collection[UUID]
) -> dict[UUID, list[Decimal]]:
    """The last `SPARKLINE_POINTS` prices of each of these assets, oldest first (one query)."""
    ranked = (
        select(
            col(Price.asset_id).label("asset_id"),
            col(Price.price).label("price"),
            col(Price.ts).label("ts"),
            func.row_number()
            .over(partition_by=col(Price.asset_id), order_by=col(Price.ts).desc())
            .label("rank"),
        )
        .where(Price.world_id == world_id, col(Price.asset_id).in_(asset_ids))
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


def _latest_two_reports(
    session: Session, world_id: UUID, asset_ids: Collection[UUID]
) -> dict[UUID, list[Report]]:
    """Each asset's latest report and the one before it (for the trend)."""
    rows = session.exec(
        select(Report)
        .where(Report.world_id == world_id, col(Report.asset_id).in_(asset_ids))
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


def is_mock_report(report: Report | None) -> bool:
    """A report rated from `USE_MOCKS` placeholder metrics (T58), never observed data."""
    return report is not None and any(
        isinstance(flag, dict) and flag.get("type") == MOCK_FLAG for flag in report.flags or []
    )


def shown_status_reason(asset: Asset, active: Collection[UUID]) -> str | None:
    """The stored reason, or `rating_stale` for a listing in `rating` whose run died (a
    worker crash leaves no failure to record)."""
    if asset.status is AssetStatus.RATING and asset.status_reason is None:
        return None if asset.id in active else RATING_STALE
    return asset.status_reason


@router.get("/assets", response_model=list[AssetCard], dependencies=[BROWSE_WORLD])
def list_assets(world: CurrentWorld, session: SessionDep) -> list[AssetCard]:
    """Marketplace cards for the world's public assets: listed and suspended (T58)."""
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == world.id, col(Asset.status).in_(PUBLIC_STATUSES))
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    return cards(session, world.id, assets)


def cards(session: Session, world_id: UUID, assets: Sequence[Asset]) -> list[AssetCard]:
    """Marketplace cards for these assets (reports and prices loaded for them only)."""
    ids = [asset.id for asset in assets]
    reports = _latest_two_reports(session, world_id, ids)
    latest_prices = _price_per_asset(session, world_id, ids, latest=True)
    ipo_prices = _price_per_asset(session, world_id, ids, latest=False)
    reviewing = any(asset.status is AssetStatus.RATING for asset in assets)
    active = assets_with_active_runs(session, world_id) if reviewing else set()
    sparklines = _sparklines(session, world_id, ids)
    out: list[AssetCard] = []
    for asset in assets:
        headlines = reports.get(asset.id, [])
        latest = headlines[0] if headlines else None
        price = latest_prices.get(asset.id)
        out.append(
            AssetCard(
                id=asset.id,
                name=asset.name,
                country=asset.country,
                status=AssetStatusOut(asset.status.value),
                status_reason=shown_status_reason(asset, active),
                area_ha=asset.area_ha,
                price=price,
                price_change_pct=_change_pct(price, ipo_prices.get(asset.id)),
                mock=is_mock_report(latest),
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
                trading=is_trading(asset),
            )
        )
    return out


def asset_detail(session: Session, asset: Asset, settings: SettingsDep) -> AssetDetail:
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
        site_key=asset.site_key,
        mock=is_mock_report(report),
        latest_report=present_report(session, report, asset, settings) if report else None,
        recent_events=recent_events(session, asset),
        price=price,
        price_change_pct=_change_pct(price, _asset_price(session, asset, latest=False)),
        trading=is_trading(asset),
        ipo_at=asset.ipo_at,
    )


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
    if asset.status not in PUBLIC_STATUSES:
        response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return asset_detail(session, asset, settings)


@router.post(
    "/assets/{asset_id}/evidence",
    response_model=EvidenceResponse,
    dependencies=[require(Action.MANAGE_LISTING, asset_ref)],
    responses=denied(DenyReason.MEMBERS_ONLY),
)
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

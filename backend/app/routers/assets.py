"""Asset listing and marketplace routes, read from the caller's world (T19).

`POST /assets` and `POST /assets/{id}/evidence` still answer with stubs until T58 and the
field-evidence agent land.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, col, select

from app.deps import CurrentWorld, SessionDep, SettingsDep, current_principal
from app.models import Asset, AssetStatus, Price, Report
from app.routers.reports import present_report, recent_events
from app.schemas import (
    AssetCard,
    AssetCreate,
    AssetCreateResponse,
    AssetDetail,
    AssetStatusOut,
    EventOut,
    EvidenceResponse,
    PricePoint,
    ReportOut,
)

router = APIRouter(tags=["assets"])


_HUNDRED = Decimal(100)


def world_asset(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    """The asset if it's in this world; 404 otherwise (another world's or the template's)."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).first()
    if asset is None:
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


def _latest_price(session: Session, asset: Asset) -> Decimal | None:
    return session.exec(
        select(col(Price.price))
        .where(Price.world_id == asset.world_id, Price.asset_id == asset.id)
        .order_by(col(Price.ts).desc())
        .limit(1)
    ).first()


@router.get("/assets", response_model=list[AssetCard])
def list_assets(world: CurrentWorld, session: SessionDep) -> list[AssetCard]:
    """Marketplace cards for every asset in the world except drafts."""
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == world.id, Asset.status != AssetStatus.DRAFT)
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    reports = _latest_two_reports(session, world.id)
    latest_prices = _price_per_asset(session, world.id, latest=True)
    ipo_prices = _price_per_asset(session, world.id, latest=False)
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
            )
        )
    return cards


@router.post(
    "/assets",
    response_model=AssetCreateResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(current_principal)],
)
def create_asset(body: AssetCreate) -> AssetCreateResponse:
    asset_id = uuid4()
    run_id = uuid4()
    total = body.total_shares
    primary = int(total * (Decimal("100") - body.retained_pct) / Decimal("100"))
    detail = AssetDetail(
        id=asset_id,
        name=body.name,
        country=body.country,
        description=body.description,
        status=AssetStatusOut.RATING,
        area_ha=Decimal("100.00"),
        centroid_lat=None,
        centroid_lon=None,
        geojson=body.geojson,
        total_shares=total,
        retained_pct=body.retained_pct,
        primary_shares_remaining=primary,
        community_wallet=Decimal("0.00"),
        site_key=None,
        latest_report=None,
        recent_events=[],
        price=None,
    )
    return AssetCreateResponse(asset=detail, run_id=run_id)


@router.get("/assets/{asset_id}", response_model=AssetDetail)
def get_asset(
    asset_id: UUID, world: CurrentWorld, session: SessionDep, settings: SettingsDep
) -> AssetDetail:
    asset = world_asset(session, world.id, asset_id)
    report = session.exec(
        select(Report)
        .where(Report.world_id == world.id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()
    return AssetDetail(
        id=asset.id,
        name=asset.name,
        country=asset.country,
        description=asset.description,
        status=AssetStatusOut(asset.status.value),
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
        price=_latest_price(session, asset),
    )


@router.post("/assets/{asset_id}/evidence", response_model=EvidenceResponse)
def upload_evidence(asset_id: UUID, world: CurrentWorld, session: SessionDep) -> EvidenceResponse:
    world_asset(session, world.id, asset_id)
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
    asset_id: UUID, world: CurrentWorld, session: SessionDep, settings: SettingsDep
) -> list[ReportOut]:
    """Every report of the asset, newest first."""
    asset = world_asset(session, world.id, asset_id)
    reports = session.exec(
        select(Report)
        .where(Report.world_id == world.id, Report.asset_id == asset.id)
        .order_by(col(Report.version).desc())
    ).all()
    return [present_report(session, report, asset, settings) for report in reports]


@router.get("/assets/{asset_id}/prices", response_model=list[PricePoint])
def list_prices(
    asset_id: UUID, world: CurrentWorld, session: SessionDep, range: str = "90d"
) -> list[PricePoint]:
    """Price history, oldest first. `range` is accepted but not applied yet (T43)."""
    _ = range  # TODO(T43): apply the range filter (7d, 30d, 90d, all).
    asset = world_asset(session, world.id, asset_id)
    prices = session.exec(
        select(Price)
        .where(Price.world_id == world.id, Price.asset_id == asset.id)
        .order_by(col(Price.ts))
    ).all()
    return [PricePoint(ts=p.ts, price=p.price, reason=p.reason) for p in prices]

"""Asset listing and marketplace routes."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status

from app import mocks
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


@router.get("/assets", response_model=list[AssetCard])
def list_assets() -> list[AssetCard]:
    return mocks.list_assets()


@router.post("/assets", response_model=AssetCreateResponse, status_code=status.HTTP_202_ACCEPTED)
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
def get_asset(asset_id: UUID) -> AssetDetail:
    asset = mocks.get_asset(asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.post("/assets/{asset_id}/evidence", response_model=EvidenceResponse)
def upload_evidence(asset_id: UUID) -> EvidenceResponse:
    if mocks.get_asset(asset_id) is None:
        raise HTTPException(status_code=404, detail="Asset not found")
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
def list_reports(asset_id: UUID) -> list[ReportOut]:
    asset = mocks.get_asset(asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.latest_report is None:
        return []
    return [asset.latest_report]


@router.get("/assets/{asset_id}/prices", response_model=list[PricePoint])
def list_prices(asset_id: UUID, range: str = "90d") -> list[PricePoint]:
    _ = range
    if mocks.get_asset(asset_id) is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    return mocks.price_history(asset_id)

"""Marketplace cards (`AssetCard`) for a set of assets: the latest report's headline, prices,
sparkline and trend, each loaded once for all of them. Shared by `GET /assets`, a community's
listings (T58) and the Steward home (T63)."""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, col, select

from app.models import Asset, AssetStatus, Price, Report
from app.schemas import AssetCard, AssetStatusOut
from app.services.ipo import is_trading
from app.services.listings import RATING_STALE
from app.services.rating_runs import assets_with_active_runs
from app.tools.earth_obs import MOCK_FLAG

_HUNDRED = Decimal(100)
# Marketplace sparkline length: the latest prices per card, oldest first.
SPARKLINE_POINTS = 30


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


def latest_reports(
    session: Session, world_id: UUID, asset_ids: Collection[UUID], *, per_asset: int = 2
) -> dict[UUID, list[Report]]:
    """Each asset's latest `per_asset` reports, newest first, in one query: only those rows
    are loaded, never every version (a window over `(asset_id, version)`)."""
    if not asset_ids:
        return {}
    ranked = (
        select(
            col(Report.id).label("id"),
            func.row_number()
            .over(partition_by=col(Report.asset_id), order_by=col(Report.version).desc())
            .label("rank"),
        )
        .where(Report.world_id == world_id, col(Report.asset_id).in_(asset_ids))
        .subquery()
    )
    rows = session.exec(
        select(Report)
        .join(ranked, col(Report.id) == ranked.c.id)
        .where(ranked.c.rank <= per_asset)
        .order_by(col(Report.asset_id), col(Report.version).desc())
    ).all()
    out: dict[UUID, list[Report]] = {}
    for report in rows:
        out.setdefault(report.asset_id, []).append(report)
    return out


def trend(headlines: list[Report]) -> str | None:
    if len(headlines) < 2:
        return None
    current, previous = headlines[0].health_score, headlines[1].health_score
    if current is None or previous is None:
        return None
    if current > previous:
        return "improving"
    return "declining" if current < previous else "stable"


def change_pct(latest: Decimal | None, ipo: Decimal | None) -> float | None:
    if latest is None or ipo is None or ipo <= 0:
        return None
    return float(((latest - ipo) / ipo * _HUNDRED).quantize(Decimal("0.01")))


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


def cards(
    session: Session,
    world_id: UUID,
    assets: Sequence[Asset],
    *,
    reports: Mapping[UUID, list[Report]] | None = None,
) -> list[AssetCard]:
    """Marketplace cards for these assets (reports and prices loaded for them only). Pass
    `reports` (`latest_reports(…, per_asset=2)`) if the caller already loaded them."""
    ids = [asset.id for asset in assets]
    if reports is None:
        reports = latest_reports(session, world_id, ids)
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
                price_change_pct=change_pct(price, ipo_prices.get(asset.id)),
                mock=is_mock_report(latest),
                grade=latest.grade if latest else None,
                trend=trend(headlines),
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

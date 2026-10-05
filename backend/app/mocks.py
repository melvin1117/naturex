"""In-memory mock data for USE_MOCKS=true (T08 walking skeleton)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from app.schemas import (
    AssetCard,
    AssetDetail,
    AssetStatusOut,
    AuditorFlag,
    AuditorOutput,
    EventOut,
    HoldingOut,
    ImpactSummary,
    NewsScoutItem,
    PortfolioOut,
    PricePoint,
    ReportOut,
    TraceStep,
)
from app.seed import DEMO_SITES, DemoSite

_NOW = datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC)

WETLAND_ID = UUID("33333333-3333-3333-3333-333333333301")
MANGROVE_ID = UUID("33333333-3333-3333-3333-333333333302")
FOREST_ID = UUID("33333333-3333-3333-3333-333333333303")

REPORT_WETLAND = UUID("44444444-4444-4444-4444-444444444401")
EVENT_ENCROACH = UUID("55555555-5555-5555-5555-555555555501")


def _auditor() -> AuditorOutput:
    return AuditorOutput(
        auditor_adjustment=-2,
        adjustment_reason=(
            "Two credible reports of illegal dumping in the NE sector "
            "not yet visible in satellite data."
        ),
        agreement=0.8,
        flags=[
            AuditorFlag(
                type="data_gap",
                detail="No cloud-free scenes in Jul–Aug (rainy season)",
                citation="metrics.cloud_free_obs",
            )
        ],
        greenwashing_risk="low",
        key_changes=[
            "Flooded vegetation −3.1 pp vs last quarter",
            "New encroachment news (severity 4)",
        ],
        recommendations=[
            "Install boundary markers along the NE industrial edge",
            "Schedule quarterly water-quality sampling",
        ],
        summary_md=(
            "## Ecological Performance Report — Q3 2026\n\n"
            "This 500 ha inland wetland scores **Health 77.6 (grade A)** with "
            "estimated ecosystem services of **$11.7M/yr** ($4.7M–$17.5M). "
            "Confidence is 87%. Satellite data shows stable natural cover; "
            "local news indicates industrial encroachment pressure "
            f"(event `{EVENT_ENCROACH}`)."
        ),
        citations=[f"event:{EVENT_ENCROACH}", "metrics.landcover", "metrics.ndvi_trend"],
    )


def news_scout_fixture() -> list[NewsScoutItem]:
    return [
        NewsScoutItem(
            relevant=True,
            impact_type="encroachment",
            direction=-1,
            severity=4,
            summary=("State approved a 40-ha industrial park expansion bordering the wetland."),
            published_at=date(2026, 9, 12),
            title="Industrial park expansion cleared near Xochimilco wetlands",
            url="https://example.com/news/encroachment-demo",
        )
    ]


def wetland_report() -> ReportOut:
    return ReportOut(
        id=REPORT_WETLAND,
        asset_id=WETLAND_ID,
        version=1,
        health_score=Decimal("77.60"),
        grade="A",
        confidence=Decimal("87.00"),
        value_low=Decimal("4700000.00"),
        value_mid=Decimal("11700000.00"),
        value_high=Decimal("17500000.00"),
        value_breakdown={
            "water": 4095000,
            "flood": 3510000,
            "habitat": 2340000,
            "carbon": 1170000,
            "recreation": 585000,
        },
        fair_value_per_share=Decimal("99.7000"),
        flags=[{"type": "data_gap", "detail": "Rainy-season cloud gap"}],
        summary_md=_auditor().summary_md,
        recommendations=_auditor().recommendations,
        auditor=_auditor(),
        created_at=_NOW,
    )


def _event() -> EventOut:
    item = news_scout_fixture()[0]
    return EventOut(
        id=EVENT_ENCROACH,
        asset_id=WETLAND_ID,
        source="tavily",
        title=item.title,
        url=item.url,
        published_at=item.published_at,
        impact_type=item.impact_type,
        direction=item.direction,
        severity=item.severity,
        summary=item.summary,
        created_at=_NOW,
    )


def _geo(site: DemoSite) -> dict[str, object]:
    lon = site.centroid_lon
    lat = site.centroid_lat
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [lon - 0.02, lat - 0.02],
                [lon + 0.02, lat - 0.02],
                [lon + 0.02, lat + 0.02],
                [lon - 0.02, lat + 0.02],
                [lon - 0.02, lat - 0.02],
            ]
        ],
    }


_GRADES = {
    "wetland_mx": ("A", Decimal("87.00"), Decimal("99.7000"), "stable"),
    "mangrove_mx": ("AA", Decimal("91.00"), Decimal("142.5000"), "stable"),
    "restoration_forest": ("BBB", Decimal("74.00"), Decimal("38.2000"), "improving"),
}


def list_assets() -> list[AssetCard]:
    cards: list[AssetCard] = []
    for site in DEMO_SITES:
        grade, conf, price, trend = _GRADES[site.key]
        cards.append(
            AssetCard(
                id=site.id,
                name=site.name,
                country=site.country,
                status=AssetStatusOut.LISTED,
                area_ha=site.area_ha,
                price=price,
                price_change_pct=1.2 if site.key == "restoration_forest" else -0.8,
                grade=grade,
                trend=trend,
                confidence=conf,
                site_key=site.key,
            )
        )
    return cards


def get_asset(asset_id: UUID) -> AssetDetail | None:
    site = next((s for s in DEMO_SITES if s.id == asset_id), None)
    if site is None:
        return None
    grade, conf, price, _trend = _GRADES[site.key]
    report = wetland_report() if asset_id == WETLAND_ID else None
    if report is None:
        report = ReportOut(
            id=uuid4(),
            asset_id=asset_id,
            version=1,
            health_score=Decimal("80.00") if grade == "AA" else Decimal("62.00"),
            grade=grade,
            confidence=conf,
            value_low=Decimal("2000000.00"),
            value_mid=Decimal("5000000.00"),
            value_high=Decimal("8000000.00"),
            value_breakdown={"habitat": 2500000, "carbon": 2500000},
            fair_value_per_share=price,
            flags=[],
            summary_md=f"Mock report for {site.name}.",
            recommendations=["Continue monitoring."],
            auditor=None,
            created_at=_NOW,
        )
    events = [_event()] if asset_id == WETLAND_ID else []
    total = 1_000_000
    retained = Decimal("51.00")
    primary = int(total * (Decimal("100") - retained) / Decimal("100"))
    return AssetDetail(
        id=asset_id,
        name=site.name,
        country=site.country,
        description=site.description,
        status=AssetStatusOut.LISTED,
        area_ha=site.area_ha,
        centroid_lat=site.centroid_lat,
        centroid_lon=site.centroid_lon,
        geojson=_geo(site),
        total_shares=total,
        retained_pct=retained,
        primary_shares_remaining=primary,
        community_wallet=Decimal("0.00"),
        site_key=site.key,
        latest_report=report,
        recent_events=events,
        price=price,
    )


def get_report(report_id: UUID) -> ReportOut | None:
    if report_id == REPORT_WETLAND:
        return wetland_report()
    return None


def price_history(asset_id: UUID) -> list[PricePoint]:
    base = Decimal("99.7000") if asset_id == WETLAND_ID else Decimal("50.0000")
    return [
        PricePoint(ts=_NOW.replace(day=1), price=base * Decimal("0.98"), reason="ipo"),
        PricePoint(ts=_NOW.replace(day=15), price=base, reason="order"),
        PricePoint(ts=_NOW, price=base * Decimal("0.99"), reason="rerate"),
    ]


def portfolio() -> PortfolioOut:
    return PortfolioOut(
        cash_balance=Decimal("10000.00"),
        holdings=[
            HoldingOut(
                asset_id=WETLAND_ID,
                asset_name="Xochimilco Wetland",
                shares=0,
                avg_cost=None,
                mark_price=Decimal("99.7000"),
                unrealized_pnl=Decimal("0.00"),
            )
        ],
        impact=ImpactSummary(
            ha_protected=Decimal("0.00"),
            t_co2_stored=Decimal("0.00"),
            services_usd_yr=Decimal("0.00"),
        ),
    )


def trace_steps(asset_id: UUID | None) -> list[TraceStep]:
    _ = asset_id
    return [
        TraceStep(
            agent="orchestrator",
            model="nemotron-3-super-mock",
            prompt_tokens=1200,
            completion_tokens=340,
            latency_ms=1800,
            created_at=_NOW,
        ),
        TraceStep(
            agent="news_scout",
            model="nemotron-nano-mock",
            prompt_tokens=800,
            completion_tokens=120,
            latency_ms=600,
            created_at=_NOW,
        ),
        TraceStep(
            agent="auditor",
            model="nemotron-3-ultra-mock",
            prompt_tokens=4000,
            completion_tokens=900,
            latency_ms=4200,
            created_at=_NOW,
        ),
    ]

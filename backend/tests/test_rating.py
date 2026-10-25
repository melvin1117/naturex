"""Deterministic rating service and seeded report v1 (T19)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from alembic import command
from sqlalchemy import create_engine, delete, text
from sqlmodel import Session, col, select

from app.config import get_settings
from app.ledger import entries_for, verify
from app.market.revenue import site_impact
from app.models import Asset, LedgerEntry, LedgerKind, Metrics, Price, Report, World
from app.sandbox import create_world
from app.seed import DEMO_SITES, TOTAL_SHARES, WORLD_ID, demo_ipo_price, demo_rating, seed
from app.services.rating import (
    RATING_METHOD_VERSION,
    ReportImpact,
    SiteRating,
    latest_report,
    latest_report_impacts,
    observed_until,
    rate_asset,
    rate_site,
    report_carbon_stock,
)
from app.tools.earth_obs import ScenarioName, load_site_metrics
from app.tools.scoring import Grade, grade_at_least
from tests.conftest import alembic_cfg, requires_db

HERO = "wetland_mx"
WINDOW_END = date(2026, 10, 1)

# site → (health, grade, confidence, value low, value mid = high, fair value per share)
EXPECTED = {
    "wetland_mx": ("76.2", "A", "71.0", 2_121_067, 2_669_511, "21.4723"),
    "mangrove_mx": ("84.8", "AA", "71.0", 2_466_117, 33_801_307, "285.1519"),
    "restoration_forest": ("76.6", "A", "71.0", 1_295_918, 2_424_480, "19.5456"),
}


def _rate(site: str, scenario: ScenarioName = "baseline", as_of: date = WINDOW_END) -> SiteRating:
    baseline = load_site_metrics(site)
    return rate_site(
        load_site_metrics(site, scenario),
        is_wetland=demo_rating(baseline).is_wetland,
        as_of=as_of,
        total_shares=TOTAL_SHARES,
    )


# --- Pure rating -----------------------------------------------------------------------------


def test_hero_report_matches_the_t14_and_t15_worked_examples() -> None:
    rating = demo_rating(load_site_metrics(HERO))

    assert rating.as_of == WINDOW_END and rating.data_age_days == 0
    assert rating.is_wetland
    assert rating.score.base_health == Decimal("76.2")
    assert rating.score.health == Decimal("76.2")
    assert rating.score.grade is Grade.A
    assert rating.score.confidence == Decimal("71.0")
    assert rating.score.gate.passed
    assert (rating.valuation.value_low, rating.valuation.value_mid) == (2_121_067, 2_669_511)
    assert rating.valuation.value_high == 2_669_511
    assert rating.value_breakdown == {
        "food_and_materials": 119_266,
        "water_supply": 461_645,
        "climate_regulation": 78_398,
        "flood_and_hazard_regulation": 548_143,
        "pollution_and_soil": 186_468,
        "habitat_and_biodiversity": 112_589,
        "recreation_and_culture": 554_083,
        "existence_and_bequest": 608_919,
    }
    # 2,669,511 × 10 × (0.5 + 0.5 × 0.762) × (0.7 + 0.3 × 0.71) / 1,000,000
    assert rating.fair_value_total == Decimal("21472291.81")
    assert rating.fair_value_per_share == Decimal("21.4723")
    assert [f["type"] for f in rating.flags()] == [
        "low_bound_fallback:shrubland",
        "auditor_pending",
    ]


@pytest.mark.parametrize("site", sorted(EXPECTED))
def test_every_demo_site_rates_to_its_documented_numbers(site: str) -> None:
    health, grade, confidence, low, mid, fair_value = EXPECTED[site]

    rating = demo_rating(load_site_metrics(site))

    assert rating.score.health == Decimal(health)
    assert rating.score.grade.value == grade
    assert rating.score.confidence == Decimal(confidence)
    assert (rating.valuation.value_low, rating.valuation.value_mid) == (low, mid)
    assert rating.valuation.value_high == mid
    assert sum(rating.value_breakdown.values()) == mid
    assert rating.fair_value_per_share == Decimal(fair_value)
    assert demo_ipo_price(load_site_metrics(site)) == Decimal(fair_value)


@pytest.mark.parametrize("site", sorted(EXPECTED))
def test_restoration_lifts_and_encroachment_lowers_the_rating(site: str) -> None:
    baseline, restored, encroached = (
        _rate(site, scenario) for scenario in ("baseline", "restoration", "encroachment")
    )

    assert restored.score.health > baseline.score.health > encroached.score.health
    assert grade_at_least(restored.score.grade, baseline.score.grade)
    assert not grade_at_least(encroached.score.grade, baseline.score.grade)
    assert restored.fair_value_per_share > baseline.fair_value_per_share
    assert encroached.fair_value_per_share < baseline.fair_value_per_share


def test_scenario_reports_are_flagged_simulated_and_never_observed() -> None:
    rating = rate_site(
        load_site_metrics(HERO, "restoration"),
        is_wetland=True,
        as_of=WINDOW_END,
        total_shares=TOTAL_SHARES,
    )

    assert rating.score.grade is Grade.AA
    flag = rating.flags()[0]
    assert (flag["type"], flag["source"]) == ("simulated", "data")
    assert "sim-1" in flag["detail"] and "2026Q4" in flag["detail"]
    assert rating.period == "2026Q4"
    snapshot = rating.snapshot()
    assert snapshot["metrics"]["simulated"] is True
    assert snapshot["metrics"]["observed_data_version"] == "2026Q3"
    assert "Simulated scenario (restoration)" in rating.summary_md("Xochimilco Wetland", 2)
    observed = demo_rating(load_site_metrics(HERO))
    assert "Simulated" not in observed.summary_md("Xochimilco Wetland", 1)


def test_last_12m_forest_loss_feeds_the_listing_gate() -> None:
    forest = load_site_metrics("restoration_forest")
    assert forest.forest_loss_last_12m_ha == pytest.approx(0.8566)
    without = forest.model_copy(update={"forest_loss_last_12m_ha": None})

    wired = demo_rating(forest)
    proxy = demo_rating(without)

    # 0.8566 ha in the last year is under the 1% limit (4.0 ha); the 26.8 ha 5-year proxy isn't.
    assert wired.score.gate.forest_loss_basis == "last_12m"
    assert wired.score.gate.forest_loss_used_ha == Decimal("0.8566")
    assert wired.score.gate.passed
    assert not proxy.score.gate.passed
    assert "listing_gate:forest_loss_last_12m_at_least_1pct_of_area" in {
        f["type"] for f in proxy.flags()
    }
    assert "forest_loss_last_12m_missing" in {f["type"] for f in proxy.flags()}
    encroached = _rate("mangrove_mx", "encroachment")
    assert "listing_gate:forest_loss_last_12m_at_least_1pct_of_area" in {
        f["type"] for f in encroached.flags()
    }


def test_recency_comes_from_the_explicit_rating_date() -> None:
    metrics = load_site_metrics(HERO)

    fresh = rate_site(metrics, is_wetland=True, as_of=date(2026, 10, 7), total_shares=TOTAL_SHARES)
    stale = rate_site(
        metrics, is_wetland=True, as_of=WINDOW_END + timedelta(days=90), total_shares=TOTAL_SHARES
    )

    assert (fresh.data_age_days, fresh.score.confidence) == (6, Decimal("71.0"))
    assert (stale.data_age_days, stale.score.confidence) == (90, Decimal("66.0"))
    assert "data_stale" in {f["type"] for f in stale.flags()}
    with pytest.raises(ValueError, match="before the data window end"):
        rate_site(metrics, is_wetland=True, as_of=date(2026, 9, 30), total_shares=TOTAL_SHARES)


# --- Stored reports --------------------------------------------------------------------------


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test reports never persist."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


def _template_asset(session: Session, site_key: str = HERO) -> Asset:
    return session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site_key)
    ).one()


def _reports(session: Session, asset_id: UUID) -> list[Report]:
    return list(
        session.exec(
            select(Report).where(Report.asset_id == asset_id).order_by(col(Report.version))
        ).all()
    )


def _carbon_report(stock: object) -> Report:
    return Report(
        world_id=WORLD_ID,
        asset_id=UUID(int=1),
        version=1,
        auditor_json={"rating": {"valuation": {"carbon": {"total_stock_tco2": stock}}}},
    )


@pytest.mark.parametrize(
    ("stock", "expected"),
    [(3400.25, Decimal("3400.25")), ("12", Decimal("12")), (7, Decimal("7"))],
)
def test_report_carbon_stock_reads_the_valuation_snapshot(stock: object, expected: Decimal) -> None:
    assert report_carbon_stock(_carbon_report(stock)) == expected


@pytest.mark.parametrize("stock", [None, True, False, "n/a", "", [1], {"t": 1}])
def test_report_carbon_stock_ignores_a_missing_or_non_numeric_value(stock: object) -> None:
    assert report_carbon_stock(_carbon_report(stock)) is None


@pytest.mark.parametrize(
    "auditor_json",
    [None, {}, {"rating": None}, {"rating": {"valuation": []}}, {"rating": {"valuation": {}}}],
)
def test_report_carbon_stock_is_none_without_a_carbon_snapshot(
    auditor_json: dict[str, object] | None,
) -> None:
    report = Report(world_id=WORLD_ID, asset_id=UUID(int=1), version=1, auditor_json=auditor_json)
    assert report_carbon_stock(report) is None


@pytest.mark.parametrize("stock", [-5, "-0.5", "NaN", float("nan"), "Infinity"])
def test_a_negative_or_non_finite_carbon_stock_counts_as_zero_impact(stock: object) -> None:
    impact = site_impact(
        area_ha=Decimal("1"),
        carbon_stock_tco2=report_carbon_stock(_carbon_report(stock)),
        services_usd_year=None,
    )
    assert impact.carbon_stock_tco2 == 0


@requires_db
@pytest.mark.parametrize("site", sorted(EXPECTED))
def test_seed_stores_report_v1_with_its_metrics_and_ledger_entry(
    session: Session, site: str
) -> None:
    health, grade, confidence, low, mid, fair_value = EXPECTED[site]
    asset = _template_asset(session, site)

    [report] = _reports(session, asset.id)
    metrics = session.get_one(Metrics, report.metrics_id)
    [entry] = entries_for(session, asset.id)

    assert report.version == 1
    assert (report.health_score, report.grade, report.confidence) == (
        Decimal(health),
        grade,
        Decimal(confidence),
    )
    assert (report.value_low, report.value_mid, report.value_high) == (low, mid, mid)
    assert report.fair_value_per_share == Decimal(fair_value)
    assert report.recommendations == []
    assert report.summary_md is not None and "rating report v1 (2026Q3)" in report.summary_md
    assert report.auditor_json is not None
    rating = report.auditor_json["rating"]
    assert rating["method_version"] == RATING_METHOD_VERSION
    assert rating["as_of"] == "2026-10-01"
    assert rating["fair_value"]["fair_value_per_share"] == fair_value
    assert rating["score"]["grade"] == grade
    assert rating["valuation"]["value_mid"] == mid
    assert (metrics.world_id, metrics.asset_id, metrics.data_version) == (
        WORLD_ID,
        asset.id,
        "2026Q3",
    )
    assert metrics.cloud_free_obs == load_site_metrics(site).cloud_free_obs
    assert (entry.seq, entry.kind, entry.ref_id) == (0, LedgerKind.REPORT, report.id)
    assert entry.payload["health_score"] == health
    assert entry.payload["fair_value_per_share"] == fair_value
    assert entry.payload["simulated"] is False
    assert verify([entry]).valid


@requires_db
def test_seed_ipo_price_is_the_stored_reports_fair_value(session: Session) -> None:
    for site in DEMO_SITES:
        asset = _template_asset(session, site.key)
        report = latest_report(session, WORLD_ID, asset.id)
        [price] = session.exec(
            select(Price).where(Price.world_id == WORLD_ID, Price.asset_id == asset.id)
        ).all()

        assert report is not None
        assert price.reason == "ipo"
        assert price.price == report.fair_value_per_share
        assert price.price == demo_ipo_price(load_site_metrics(site.key))


@requires_db
def test_seed_is_idempotent_for_reports(session: Session) -> None:
    seed(session)
    seed(session)

    for site in DEMO_SITES:
        asset = _template_asset(session, site.key)
        assert [r.version for r in _reports(session, asset.id)] == [1]
        assert len(entries_for(session, asset.id)) == 1
        assert len(session.exec(select(Price).where(Price.asset_id == asset.id)).all()) == 1, (
            "one IPO price"
        )


@requires_db
def test_seed_upgrades_a_database_seeded_before_t19(session: Session) -> None:
    """An older template has IPO prices but no reports: `make seed` adds report v1 only."""
    session.execute(text("SET LOCAL wildworth.allow_ledger_delete = 'on'"))
    session.execute(delete(LedgerEntry).where(col(LedgerEntry.world_id) == WORLD_ID))
    session.execute(delete(Report).where(col(Report.world_id) == WORLD_ID))
    session.execute(delete(Metrics).where(col(Metrics.world_id) == WORLD_ID))
    session.execute(text("SET LOCAL wildworth.allow_ledger_delete = 'off'"))
    session.commit()

    seed(session)

    for site in DEMO_SITES:
        asset = _template_asset(session, site.key)
        [report] = _reports(session, asset.id)
        [price] = session.exec(select(Price).where(Price.asset_id == asset.id)).all()
        assert price.price == report.fair_value_per_share
        assert [e.kind for e in entries_for(session, asset.id)] == [LedgerKind.REPORT]


@requires_db
def test_a_second_rating_is_version_two_on_the_same_chain(session: Session) -> None:
    asset = _template_asset(session)
    first = latest_report(session, WORLD_ID, asset.id)
    metrics = load_site_metrics(HERO, "restoration")

    second = rate_asset(
        session,
        WORLD_ID,
        asset,
        metrics=metrics,
        as_of=observed_until(metrics),
        previous_report=first,
    )
    session.commit()

    assert second.version == 2
    assert (second.grade, second.health_score) == ("AA", Decimal("87.1"))
    assert second.flags is not None and second.flags[0]["type"] == "simulated"
    assert session.get_one(Metrics, second.metrics_id).data_version == "sim-1"
    chain = entries_for(session, asset.id)
    assert [(e.seq, e.ref_id) for e in chain] == [(0, first.id if first else None), (1, second.id)]
    assert chain[1].payload["simulated"] is True
    assert chain[1].payload["data_version"] == "sim-1"
    assert verify(chain).valid
    with pytest.raises(ValueError, match="latest report"):
        rate_asset(
            session, WORLD_ID, asset, metrics=metrics, as_of=WINDOW_END, previous_report=first
        )


@requires_db
def test_wetland_status_comes_from_the_baseline_not_the_version_rated(session: Session) -> None:
    asset = _template_asset(session)
    drained = load_site_metrics(HERO, "encroachment").model_copy(
        update={"landcover": {"water": 0.05, "flooded_vegetation": 0.05, "built": 0.9}}
    )

    report = rate_asset(session, WORLD_ID, asset, metrics=drained, as_of=WINDOW_END)

    assert report.auditor_json is not None
    rating = report.auditor_json["rating"]
    assert rating["is_wetland"] is True
    assert Decimal(rating["score"]["components"]["water_stability"]) < 1


@requires_db
def test_an_unlisted_asset_takes_wetland_status_from_its_first_observed_metrics(
    session: Session,
) -> None:
    asset = Asset(
        world_id=WORLD_ID,
        name="New parcel",
        geojson={"type": "Polygon", "coordinates": []},
        area_ha=Decimal("206.70"),
        primary_shares_remaining=490_000,
    )
    session.add(asset)
    session.flush()
    simulated = load_site_metrics(HERO, "restoration")

    with pytest.raises(ValueError, match="no observed baseline"):
        rate_asset(session, WORLD_ID, asset, metrics=simulated, as_of=WINDOW_END)
    first = rate_asset(session, WORLD_ID, asset, metrics=load_site_metrics(HERO), as_of=WINDOW_END)
    second = rate_asset(session, WORLD_ID, asset, metrics=simulated, as_of=WINDOW_END)

    assert (first.version, second.version) == (1, 2)
    assert second.auditor_json is not None and second.auditor_json["rating"]["is_wetland"]


@requires_db
def test_rate_asset_refuses_other_worlds_and_other_sites(session: Session) -> None:
    asset = _template_asset(session)
    metrics = load_site_metrics(HERO)

    with pytest.raises(ValueError, match="not in world"):
        rate_asset(session, UUID(int=0), asset, metrics=metrics, as_of=WINDOW_END)
    with pytest.raises(ValueError, match="can't rate"):
        rate_asset(
            session, WORLD_ID, asset, metrics=load_site_metrics("mangrove_mx"), as_of=WINDOW_END
        )


@requires_db
def test_visitor_worlds_copy_reports_with_remapped_metrics_and_ledger(session: Session) -> None:
    world: World = create_world(session)

    for site in DEMO_SITES:
        template = latest_report(session, WORLD_ID, _template_asset(session, site.key).id)
        asset = session.exec(
            select(Asset).where(Asset.world_id == world.id, Asset.site_key == site.key)
        ).one()
        copy = latest_report(session, world.id, asset.id)
        assert template is not None and copy is not None
        assert copy.id != template.id
        metrics = session.get_one(Metrics, copy.metrics_id)
        assert (metrics.world_id, metrics.asset_id) == (world.id, asset.id)
        assert (copy.health_score, copy.fair_value_per_share) == (
            template.health_score,
            template.fair_value_per_share,
        )
        [entry] = entries_for(session, asset.id)
        assert entry.ref_id == copy.id
        assert verify([entry]).valid


@requires_db
def test_latest_report_impacts_match_each_assets_latest_report(session: Session) -> None:
    assets = [_template_asset(session, site) for site in sorted(EXPECTED)]
    hero = assets[0]
    previous = latest_report(session, WORLD_ID, hero.id)
    assert previous is not None
    session.add(
        Report(
            world_id=WORLD_ID,
            asset_id=hero.id,
            version=previous.version + 1,
            value_mid=Decimal("10.00"),
            auditor_json={"rating": {"valuation": {"carbon": {"total_stock_tco2": 4.5}}}},
        )
    )
    session.flush()

    impacts = latest_report_impacts(session, WORLD_ID, [a.id for a in assets] + [UUID(int=7)])

    assert impacts[hero.id] == ReportImpact(
        value_mid=Decimal("10.00"), carbon_stock_tco2=Decimal("4.5")
    )
    for asset in assets:
        report = latest_report(session, WORLD_ID, asset.id)
        assert report is not None
        assert impacts[asset.id] == ReportImpact(
            value_mid=report.value_mid, carbon_stock_tco2=report_carbon_stock(report)
        )
        assert impacts[asset.id].carbon_stock_tco2 is not None
    assert UUID(int=7) not in impacts
    assert latest_report_impacts(session, WORLD_ID, []) == {}

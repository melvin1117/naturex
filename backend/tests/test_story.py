"""The judge story's data (`GET /story`): every number from the product's own tested code."""

from __future__ import annotations

from decimal import Decimal

from fastapi.testclient import TestClient

from app.ledger import GENESIS_HASH, entry_hash
from app.main import app
from app.models import LedgerKind
from app.services.rating import rate_site
from app.services.story import STORY_AS_OF, build_story
from app.tools.earth_obs import load_site_metrics
from app.tools.scoring import is_wetland_from_landcover


def test_the_story_is_public_cacheable_and_needs_no_database() -> None:
    response = TestClient(app).get("/story")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=3600"
    body = response.json()
    assert body["site"]["name"] == "Xochimilco Wetland"
    assert body["images"]["after"]["url"] == "/media/demo-sites/wetland_mx/thumbnail.webp"


def test_each_rating_is_the_formulas_own_for_that_version_of_the_land() -> None:
    story = build_story()
    wetland = is_wetland_from_landcover(load_site_metrics("wetland_mx").landcover)

    for shown in story.ratings:
        metrics = load_site_metrics("wetland_mx", shown.scenario)
        rated = rate_site(metrics, is_wetland=wetland, as_of=STORY_AS_OF, total_shares=1_000_000)
        assert (shown.health, shown.grade) == (rated.score.health, rated.score.grade.value)
        assert shown.fair_value_per_unit == rated.fair_value_per_share
        assert shown.simulated is (shown.scenario != "baseline")
    # The story's arc: healthy, damaged, then better than before.
    baseline, damaged, restored = story.ratings
    assert (baseline.scenario, damaged.scenario, restored.scenario) == (
        "baseline",
        "encroachment",
        "restoration",
    )
    assert damaged.health < baseline.health < restored.health
    assert damaged.landcover["built"] > baseline.landcover["built"]


def test_the_money_follows_the_land() -> None:
    market = build_story().market
    baseline = build_story().ratings[0]

    # Opened at the rating's fair price; the community keeps 51%.
    assert market.opening_price == baseline.fair_value_per_unit
    assert market.offered_units == 490_000
    # A first supporter's units all come from the offer, so all of it reaches the community.
    assert market.backing.to_community == market.backing.paid > 0
    assert market.backing.fill_price > market.opening_price  # slippage, never a discount
    assert market.price_after_downgrade < market.opening_price < market.price_after_restoration


def test_the_record_is_a_real_chain_and_an_edit_breaks_it() -> None:
    ledger = build_story().ledger

    assert ledger.verified and ledger.head == ledger.entries[-1].hash
    first = ledger.entries[0]
    assert first.hash == entry_hash(
        {"transition": "listed", "site": "wetland_mx"}, LedgerKind.LISTING, 0, GENESIS_HASH
    )
    assert (ledger.tampered_from, ledger.tampered_to) == ("BBB", "AA")
    assert ledger.tampered_verified is False
    assert ledger.broken_at == ledger.tampered_seq == 3


def test_the_land_is_measured_not_invented() -> None:
    story = build_story()
    metrics = load_site_metrics("wetland_mx")

    assert [p.ndvi for p in story.land.ndvi] == [
        p.ndvi for p in metrics.ndvi_series if p.ndvi is not None
    ]
    assert story.site.area_ha == Decimal("206.70")
    assert story.site.boundary[0] == story.site.boundary[-1]  # a closed ring of [lat, lon]
    assert any("Dynamic World" in a for a in story.images.attributions)

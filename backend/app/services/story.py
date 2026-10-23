"""The judge story's numbers (`GET /story`): one demo site told end to end, all from tested code.

The story at `/judge` walks a visitor through why NatureX exists on the hero wetland: measure it,
fund it, watch it, trust the record. Everything it shows comes from committed data and the same
pure functions the product uses, never typed into the page:

- **The land:** the boundary, its Dynamic World land cover, five years of monthly NDVI and the
  precomputed overlay and true-colour views (`tools.earth_obs`, `tools.site_images`).
- **The ratings:** `services.rating.rate_site` on the cached baseline, then the site's simulated
  `encroachment` and `restoration` scenarios (the Time Machine's), each labelled simulated.
- **The money:** the opening offer (`market.engine.ipo`), one supporter's 100 units
  (`preview`: fill price, slippage and the part paid to the community) and the price re-anchored
  on each re-rating (`anchor_price` with no noise, so the story is the same for everyone).
- **The record:** a five-entry Nature Ledger chained with `ledger.entry_hash`, verified, then the
  same chain with the downgrade quietly edited, verified again (`ledger.verify`).

It reads no database and calls no model, so it is free, identical everywhere and cacheable.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal
from functools import cache

from app.ledger import GENESIS_HASH, ChainEntry, entry_hash, verify
from app.market.engine import PriceReason, anchor_price, ipo, preview
from app.models import LedgerKind, OrderSide
from app.schemas import (
    OverlayBounds,
    StoryBacking,
    StoryImage,
    StoryImages,
    StoryLand,
    StoryLedger,
    StoryLedgerEntry,
    StoryMarket,
    StoryOut,
    StoryRating,
    StorySite,
)
from app.seed import DEMO_SITES, RETAINED_PCT, TOTAL_SHARES
from app.services.rating import rate_site
from app.tools.earth_obs import EarthObsMetrics, ScenarioName, load_site_metrics
from app.tools.scoring import is_wetland_from_landcover
from app.tools.site_images import (
    DW_CLASSES,
    DW_LABELS,
    DW_PALETTE,
    load_site_geojson,
    load_site_images,
    polygon_ring,
)

STORY_SITE = "wetland_mx"
STORY_AS_OF = date(2026, 10, 22)
"""The rating date the story uses, so the recency term is the same on every visit."""
BACKING_UNITS = 100
LANDCOVER_SHOWN = ("trees", "water", "grass", "shrub_and_scrub", "flooded_vegetation", "built")


def _media(site_key: str, file: str) -> str:
    return f"/media/demo-sites/{site_key}/{file}"


def _bounds(b: tuple[tuple[float, float], tuple[float, float]]) -> OverlayBounds:
    (south, west), (north, east) = b
    return OverlayBounds(south=south, west=west, north=north, east=east)


def _rating(metrics: EarthObsMetrics, *, wetland: bool, scenario: ScenarioName) -> StoryRating:
    rated = rate_site(metrics, is_wetland=wetland, as_of=STORY_AS_OF, total_shares=TOTAL_SHARES)
    return StoryRating(
        scenario=scenario,
        simulated=metrics.simulated,
        health=rated.score.health,
        grade=rated.score.grade.value,
        confidence=rated.score.confidence,
        value_low=rated.valuation.value_low,
        value_mid=rated.valuation.value_mid,
        value_high=rated.valuation.value_high,
        fair_value_per_unit=rated.fair_value_per_share,
        landcover={k: round(metrics.landcover.get(k, 0.0), 4) for k in LANDCOVER_SHOWN},
        natural_fraction=round(metrics.natural_fraction, 4),
    )


def _ledger(
    baseline: StoryRating, down: StoryRating, up: StoryRating, price: Decimal
) -> StoryLedger:
    """Five entries chained exactly as the Nature Ledger chains them, then the downgrade edited
    to read like a better grade without re-hashing, as someone editing the database would."""
    payloads: list[tuple[LedgerKind, str, dict[str, object]]] = [
        (
            LedgerKind.LISTING,
            "Listed by its community",
            {"transition": "listed", "site": STORY_SITE},
        ),
        (
            LedgerKind.REPORT,
            f"Rated {baseline.grade} · {baseline.health}",
            {"version": 1, "grade": baseline.grade, "health": str(baseline.health)},
        ),
        (LedgerKind.PRICE_ANCHOR, "Opened to supporters", {"reason": "ipo", "price": str(price)}),
        (
            LedgerKind.REPORT,
            f"Downgraded to {down.grade} · {down.health}",
            {"version": 2, "grade": down.grade, "health": str(down.health)},
        ),
        (
            LedgerKind.REPORT,
            f"Upgraded to {up.grade} · {up.health}",
            {"version": 3, "grade": up.grade, "health": str(up.health)},
        ),
    ]
    chain: list[ChainEntry] = []
    prev = GENESIS_HASH
    for seq, (kind, _label, payload) in enumerate(payloads):
        digest = entry_hash(payload, kind, seq, prev)
        chain.append(ChainEntry(seq, kind, payload, prev, digest))
        prev = digest
    target = 3
    forged_grade = up.grade
    edited = dict(chain[target].payload) | {"grade": forged_grade}
    forged = [*chain[:target], replace(chain[target], payload=edited), *chain[target + 1 :]]
    honest, tampered = verify(chain), verify(forged)
    return StoryLedger(
        entries=[
            StoryLedgerEntry(seq=e.seq, kind=e.kind.value, label=label, hash=e.hash)
            for e, (_kind, label, _payload) in zip(chain, payloads, strict=True)
        ],
        verified=honest.valid,
        head=honest.head,
        tampered_seq=target,
        tampered_field="grade",
        tampered_from=down.grade,
        tampered_to=forged_grade,
        tampered_verified=tampered.valid,
        broken_at=tampered.broken_at,
    )


@cache
def build_story() -> StoryOut:
    site = next(s for s in DEMO_SITES if s.key == STORY_SITE)
    geojson = load_site_geojson(STORY_SITE)
    images = load_site_images(STORY_SITE)
    baseline_metrics = load_site_metrics(STORY_SITE)
    wetland = is_wetland_from_landcover(baseline_metrics.landcover)
    baseline = _rating(baseline_metrics, wetland=wetland, scenario="baseline")
    down = _rating(
        load_site_metrics(STORY_SITE, "encroachment"), wetland=wetland, scenario="encroachment"
    )
    up = _rating(
        load_site_metrics(STORY_SITE, "restoration"), wetland=wetland, scenario="restoration"
    )

    listing = ipo(
        value_mid=Decimal(baseline.value_mid),
        health=baseline.health,
        confidence=baseline.confidence,
        total_shares=TOTAL_SHARES,
        retained_pct=RETAINED_PCT,
    )
    opening = listing.market.price
    order = preview(listing.market, OrderSide.BUY, BACKING_UNITS)
    after_down = anchor_price(
        opening, down.fair_value_per_unit, PriceReason.RERATE, Decimal(0)
    ).price
    after_up = anchor_price(
        after_down, up.fair_value_per_unit, PriceReason.RERATE, Decimal(0)
    ).price

    overlay, thumb = images.overlay, images.thumbnail
    return StoryOut(
        site=StorySite(
            key=STORY_SITE,
            name=site.name,
            place="Mexico City",
            community=f"{site.name} Community",
            area_ha=site.area_ha,
            boundary=[[lat, lon] for lon, lat in polygon_ring(geojson)],
        ),
        images=StoryImages(
            overlay=StoryImage(
                url=_media(STORY_SITE, "overlay.png"), bounds=_bounds(overlay.bounds)
            ),
            before=StoryImage(url=_media(STORY_SITE, "before.webp"), bounds=_bounds(thumb.bounds)),
            after=StoryImage(
                url=_media(STORY_SITE, "thumbnail.webp"), bounds=_bounds(thumb.bounds)
            ),
            legend={
                key: {"label": label, "color": color}
                for key, label, color in zip(DW_CLASSES, DW_LABELS, DW_PALETTE, strict=True)
                if key in LANDCOVER_SHOWN
            },
            attributions=[*overlay.attributions, *thumb.attributions],
        ),
        land=StoryLand(
            ndvi=[p for p in baseline_metrics.ndvi_series if p.ndvi is not None],
            water_change=round(baseline_metrics.water_change, 2),
            ndvi_window=baseline_metrics.date_windows["ndvi"],
            attributions=list(baseline_metrics.attributions),
        ),
        ratings=[baseline, down, up],
        market=StoryMarket(
            total_units=TOTAL_SHARES,
            retained_pct=RETAINED_PCT,
            opening_price=opening,
            offered_units=listing.terms.primary_float,
            backing=StoryBacking(
                units=BACKING_UNITS,
                fill_price=order.fill_price,
                paid=order.cash_amount,
                to_community=order.community_amount,
            ),
            price_after_downgrade=after_down,
            price_after_restoration=after_up,
        ),
        ledger=_ledger(baseline, down, up, opening),
    )

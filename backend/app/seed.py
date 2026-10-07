"""Idempotent seed: one template world, 4 personas, 3 demo assets and the community's stake."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast
from uuid import UUID

from sqlalchemy import update
from sqlmodel import Session, col, select

from app.db import engine
from app.market.engine import ipo
from app.models import Asset, AssetStatus, Holding, Price, User, UserRole, World
from app.tools.earth_obs import DATA_DIR, EarthObsMetrics, load_site_metrics
from app.tools.scoring import is_wetland_from_landcover, score_metrics
from app.tools.valuation import value_metrics

# Stable IDs so re-running seed is a no-op.
WORLD_ID = UUID("11111111-1111-1111-1111-111111111111")
# The one persistent world for real accounts (ADR-0005 §2); built by app.sandbox.ensure_live_world.
LIVE_WORLD_ID = UUID("44444444-4444-4444-4444-444444444444")
LIVE_LABEL = "live"

TOTAL_SHARES = 1_000_000
RETAINED_PCT = Decimal("51.00")
STARTING_CASH = Decimal("10000.00")


@dataclass(frozen=True)
class Persona:
    id: UUID
    key: str
    name: str
    role: UserRole


@dataclass(frozen=True)
class DemoSite:
    id: UUID
    key: str
    name: str
    country: str
    description: str
    area_ha: Decimal
    centroid_lat: float
    centroid_lon: float
    status: AssetStatus = AssetStatus.LISTED


PERSONAS: tuple[Persona, ...] = (
    Persona(UUID("22222222-2222-2222-2222-222222222201"), "rosa", "Rosa", UserRole.COMMUNITY),
    Persona(UUID("22222222-2222-2222-2222-222222222202"), "arjun", "Arjun", UserRole.INVESTOR),
    Persona(UUID("22222222-2222-2222-2222-222222222203"), "mia", "Mia", UserRole.INVESTOR),
    Persona(UUID("22222222-2222-2222-2222-222222222204"), "admin", "Demo Admin", UserRole.ADMIN),
)
COMMUNITY_PERSONA = PERSONAS[0]


def _decimal_ha(value: float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def _load_demo_geojson(site_key: str) -> dict[str, Any]:
    path = DATA_DIR / f"{site_key}.geojson"
    return cast(dict[str, Any], json.loads(path.read_text()))


def _demo_site(id_: UUID, key: str, name: str, description: str) -> DemoSite:
    """A demo site whose area and centroid come from its committed boundary (T11/T13)."""
    metrics = load_site_metrics(key)
    return DemoSite(
        id=id_,
        key=key,
        name=name,
        country="MX",
        description=description,
        area_ha=_decimal_ha(metrics.area_ha),
        centroid_lat=metrics.centroid.lat,
        centroid_lon=metrics.centroid.lon,
    )


DEMO_SITES: tuple[DemoSite, ...] = (
    _demo_site(
        UUID("33333333-3333-3333-3333-333333333301"),
        "wetland_mx",
        "Xochimilco Wetland",
        "Hero inland wetland near Mexico City (demo).",
    ),
    _demo_site(
        UUID("33333333-3333-3333-3333-333333333302"),
        "mangrove_mx",
        "Ría Celestún Mangrove",
        "Blue-carbon mangrove in the Ría Celestún Biosphere Reserve, Yucatán (demo).",
    ),
    _demo_site(
        UUID("33333333-3333-3333-3333-333333333303"),
        "restoration_forest",
        "Sumidero Canyon Restoration Forest",
        "Tropical forest recovering from 2021–2025 loss on the edge of Cañón del Sumidero "
        "National Park, Chiapas (demo).",
    ),
)

DEMO_GEOJSON: dict[str, dict[str, Any]] = {
    site.key: _load_demo_geojson(site.key) for site in DEMO_SITES
}


def _upgrade_demo_site_content(session: Session) -> None:
    """Refresh demo-site content in every world, visitor copies included.

    Name, description and boundary are template content, not visitor state, so databases
    seeded with the old placeholder squares (before T11/T13) get the real boundaries on the
    next ``make seed``. Shares, cash, the community wallet and status are never touched.
    """
    for site in DEMO_SITES:
        session.execute(
            update(Asset)
            .where(col(Asset.site_key) == site.key)
            .values(
                name=site.name,
                description=site.description,
                geojson=DEMO_GEOJSON[site.key],
                area_ha=site.area_ha,
                centroid_lat=site.centroid_lat,
                centroid_lon=site.centroid_lon,
            )
        )
    session.commit()


def demo_ipo_price(metrics: EarthObsMetrics) -> Decimal:
    """IPO price of a curated demo site from its deterministic rating (dev-spec §8).

    Fair value uses the T14 valuation and the T15 score of the cached metrics, rated on the day
    the freshest data window ends, with no Auditor or field evidence yet. T19 stores the matching
    report; T59 replaces this for listings launched by their owner.
    """
    valuation = value_metrics(metrics)
    score = score_metrics(
        metrics,
        is_wetland=is_wetland_from_landcover(metrics.landcover),
        data_age_days=0,
        forest_loss_last_12m_ha=metrics.forest_loss_last_12m_ha,
    )
    listing = ipo(
        value_mid=Decimal(valuation.value_mid),
        health=score.health,
        confidence=score.confidence,
        total_shares=TOTAL_SHARES,
        retained_pct=RETAINED_PCT,
    )
    return listing.price_change.price


def _seed_ipo_prices(session: Session) -> None:
    """One `ipo` price per listed demo asset without a price, so trading works after `make seed`."""
    for site in DEMO_SITES:
        asset = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
        ).one()
        has_price = session.exec(
            select(Price.asset_id).where(Price.world_id == WORLD_ID, Price.asset_id == asset.id)
        ).first()
        if asset.status == AssetStatus.LISTED and has_price is None:
            session.add(
                Price(
                    world_id=WORLD_ID,
                    asset_id=asset.id,
                    price=demo_ipo_price(load_site_metrics(site.key)),
                    reason="ipo",
                )
            )
    session.commit()


def seed(session: Session) -> None:
    """Insert template world, personas and demo assets if missing."""
    if session.get(World, WORLD_ID) is None:
        session.add(World(id=WORLD_ID, label="template"))
        session.commit()

    for persona in PERSONAS:
        existing_user = session.exec(
            select(User).where(User.world_id == WORLD_ID, User.persona_key == persona.key)
        ).first()
        if existing_user is None:
            session.add(
                User(
                    id=persona.id,
                    world_id=WORLD_ID,
                    name=persona.name,
                    role=persona.role,
                    cash_balance=STARTING_CASH,
                    persona_key=persona.key,
                )
            )
    session.commit()

    primary_shares = int(TOTAL_SHARES * (Decimal("100") - RETAINED_PCT) / Decimal("100"))
    for site in DEMO_SITES:
        existing_asset = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
        ).first()
        if existing_asset is None:
            session.add(
                Asset(
                    id=site.id,
                    world_id=WORLD_ID,
                    name=site.name,
                    community_user_id=COMMUNITY_PERSONA.id,
                    country=site.country,
                    description=site.description,
                    geojson=DEMO_GEOJSON[site.key],
                    area_ha=site.area_ha,
                    centroid_lat=site.centroid_lat,
                    centroid_lon=site.centroid_lon,
                    total_shares=TOTAL_SHARES,
                    retained_pct=RETAINED_PCT,
                    primary_shares_remaining=primary_shares,
                    community_wallet=Decimal("0.00"),
                    status=site.status,
                    site_key=site.key,
                )
            )
    session.commit()
    _upgrade_demo_site_content(session)

    # The community keeps its retained stake as a holding, so shares are conserved:
    # total_shares = primary_shares_remaining + market_maker_shares + sum(holdings) (dev-spec §8).
    retained = TOTAL_SHARES - primary_shares
    for site in DEMO_SITES:
        asset = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
        ).one()
        holding = session.get(Holding, (WORLD_ID, COMMUNITY_PERSONA.id, asset.id))
        if holding is None:
            session.add(
                Holding(
                    world_id=WORLD_ID,
                    user_id=COMMUNITY_PERSONA.id,
                    asset_id=asset.id,
                    shares=retained,
                )
            )
    session.commit()

    _seed_ipo_prices(session)


def main() -> None:
    # Imported here: app.sandbox imports this module.
    from app.sandbox import ensure_live_world

    with Session(engine) as session:
        seed(session)
        ensure_live_world(session)
    print(
        "Seed complete: template world, 4 personas, 3 demo assets, community holdings, IPO prices;"
        " live world with the 3 curated sites."
    )


if __name__ == "__main__":
    main()

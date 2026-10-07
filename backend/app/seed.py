"""Idempotent seed: one template world, 4 personas, 3 demo assets and the community's stake."""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast
from uuid import UUID

from sqlmodel import Session, select

from app.db import engine
from app.models import Asset, AssetStatus, Holding, User, UserRole, World
from app.tools.earth_obs import DATA_DIR, load_site_metrics

# Stable IDs so re-running seed is a no-op.
WORLD_ID = UUID("11111111-1111-1111-1111-111111111111")

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
        else:
            # Upgrade databases seeded with the old placeholder boundaries; never touches
            # shares, cash or the community wallet.
            existing_asset.name = site.name
            existing_asset.description = site.description
            existing_asset.geojson = DEMO_GEOJSON[site.key]
            existing_asset.area_ha = site.area_ha
            existing_asset.centroid_lat = site.centroid_lat
            existing_asset.centroid_lon = site.centroid_lon
    session.commit()

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


def main() -> None:
    with Session(engine) as session:
        seed(session)
    print("Seed complete: template world, 4 personas, 3 demo assets, community holdings.")


if __name__ == "__main__":
    main()

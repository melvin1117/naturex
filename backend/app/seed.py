"""Idempotent seed: one template world, 4 personas, 3 demo assets."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlmodel import Session, select

from app.db import engine
from app.models import Asset, AssetStatus, User, UserRole, World

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

DEMO_SITES: tuple[DemoSite, ...] = (
    DemoSite(
        id=UUID("33333333-3333-3333-3333-333333333301"),
        key="wetland_mx",
        name="Xochimilco Wetland",
        country="MX",
        description="Hero inland wetland near Mexico City (demo).",
        area_ha=Decimal("500.00"),
        centroid_lat=19.26,
        centroid_lon=-99.09,
    ),
    DemoSite(
        id=UUID("33333333-3333-3333-3333-333333333302"),
        key="mangrove_mx",
        name="Coastal Mangrove Reserve",
        country="MX",
        description="Blue-carbon mangrove site (demo).",
        area_ha=Decimal("320.00"),
        centroid_lat=21.50,
        centroid_lon=-87.50,
    ),
    DemoSite(
        id=UUID("33333333-3333-3333-3333-333333333303"),
        key="restoration_forest",
        name="Restoration Forest Parcel",
        country="MX",
        description="Degraded forest under restoration (demo).",
        area_ha=Decimal("450.00"),
        centroid_lat=16.75,
        centroid_lon=-93.10,
    ),
)

# Placeholder polygon, replaced by real GeoJSON in T11/T13. It's mostly built-up town;
# the real wetland is ~3 km north-east (ADR-0004).
_PLACEHOLDER_POLY: dict[str, Any] = {
    "type": "Polygon",
    "coordinates": [
        [
            [-99.10, 19.25],
            [-99.08, 19.25],
            [-99.08, 19.27],
            [-99.10, 19.27],
            [-99.10, 19.25],
        ]
    ],
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
                    geojson=_PLACEHOLDER_POLY,
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


def main() -> None:
    with Session(engine) as session:
        seed(session)
    print("Seed complete: template world, 4 personas, 3 demo assets.")


if __name__ == "__main__":
    main()

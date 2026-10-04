"""Idempotent seed: one template world, 4 personas, 3 demo assets."""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from sqlmodel import Session, select

from app.db import engine
from app.models import Asset, AssetStatus, User, UserRole, World

# Stable IDs so re-running seed is a no-op.
WORLD_ID = UUID("11111111-1111-1111-1111-111111111111")

PERSONAS: list[dict[str, object]] = [
    {
        "id": UUID("22222222-2222-2222-2222-222222222201"),
        "persona_key": "rosa",
        "name": "Rosa",
        "role": UserRole.COMMUNITY,
        "cash_balance": Decimal("10000.00"),
    },
    {
        "id": UUID("22222222-2222-2222-2222-222222222202"),
        "persona_key": "arjun",
        "name": "Arjun",
        "role": UserRole.INVESTOR,
        "cash_balance": Decimal("10000.00"),
    },
    {
        "id": UUID("22222222-2222-2222-2222-222222222203"),
        "persona_key": "mia",
        "name": "Mia",
        "role": UserRole.INVESTOR,
        "cash_balance": Decimal("10000.00"),
    },
    {
        "id": UUID("22222222-2222-2222-2222-222222222204"),
        "persona_key": "admin",
        "name": "Demo Admin",
        "role": UserRole.ADMIN,
        "cash_balance": Decimal("10000.00"),
    },
]

# Placeholder polygons — replaced by real GeoJSON in T11/T13.
_PLACEHOLDER_POLY = {
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

DEMO_SITES: list[dict[str, object]] = [
    {
        "id": UUID("33333333-3333-3333-3333-333333333301"),
        "site_key": "wetland_mx",
        "name": "Xochimilco Wetland",
        "country": "MX",
        "description": "Hero inland wetland near Mexico City (demo).",
        "area_ha": Decimal("500.00"),
        "centroid_lat": 19.26,
        "centroid_lon": -99.09,
        "status": AssetStatus.LISTED,
    },
    {
        "id": UUID("33333333-3333-3333-3333-333333333302"),
        "site_key": "mangrove_mx",
        "name": "Coastal Mangrove Reserve",
        "country": "MX",
        "description": "Blue-carbon mangrove site (demo).",
        "area_ha": Decimal("320.00"),
        "centroid_lat": 21.50,
        "centroid_lon": -87.50,
        "status": AssetStatus.LISTED,
    },
    {
        "id": UUID("33333333-3333-3333-3333-333333333303"),
        "site_key": "restoration_forest",
        "name": "Restoration Forest Parcel",
        "country": "MX",
        "description": "Degraded forest under restoration (demo).",
        "area_ha": Decimal("450.00"),
        "centroid_lat": 16.75,
        "centroid_lon": -93.10,
        "status": AssetStatus.LISTED,
    },
]


def seed(session: Session) -> None:
    """Insert template world, personas and demo assets if missing."""
    world = session.get(World, WORLD_ID)
    if world is None:
        session.add(World(id=WORLD_ID, label="template"))
        session.commit()

    rosa_id = UUID("22222222-2222-2222-2222-222222222201")
    for persona in PERSONAS:
        existing_user = session.exec(
            select(User).where(
                User.world_id == WORLD_ID,
                User.persona_key == persona["persona_key"],
            )
        ).first()
        if existing_user is None:
            session.add(
                User(
                    id=persona["id"],  # type: ignore[arg-type]
                    world_id=WORLD_ID,
                    name=str(persona["name"]),
                    role=persona["role"],  # type: ignore[arg-type]
                    cash_balance=persona["cash_balance"],  # type: ignore[arg-type]
                    persona_key=str(persona["persona_key"]),
                )
            )
    session.commit()

    for site in DEMO_SITES:
        existing_asset = session.exec(
            select(Asset).where(
                Asset.world_id == WORLD_ID,
                Asset.site_key == site["site_key"],
            )
        ).first()
        if existing_asset is None:
            total = 1_000_000
            retained = Decimal("51.00")
            primary = int(total * (Decimal("100") - retained) / Decimal("100"))
            session.add(
                Asset(
                    id=site["id"],  # type: ignore[arg-type]
                    world_id=WORLD_ID,
                    name=str(site["name"]),
                    community_user_id=rosa_id,
                    country=str(site["country"]),
                    description=str(site["description"]),
                    geojson=_PLACEHOLDER_POLY,
                    area_ha=site["area_ha"],  # type: ignore[arg-type]
                    centroid_lat=float(site["centroid_lat"]),  # type: ignore[arg-type]
                    centroid_lon=float(site["centroid_lon"]),  # type: ignore[arg-type]
                    total_shares=total,
                    retained_pct=retained,
                    primary_shares_remaining=primary,
                    community_wallet=Decimal("0.00"),
                    status=site["status"],  # type: ignore[arg-type]
                    site_key=str(site["site_key"]),
                )
            )
    session.commit()


def main() -> None:
    with Session(engine) as session:
        seed(session)
    print("Seed complete: template world, 4 personas, 3 demo assets.")


if __name__ == "__main__":
    main()

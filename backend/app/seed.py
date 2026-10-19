"""Idempotent seed: one template world, 4 personas, 3 demo assets, their communities and stakes.

Each curated site has its own community (ADR-0005 §3, T56): Rosa is the owner of all three, and
each community's treasury account holds the site's retained stake and receives its dividends.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast
from uuid import UUID

from sqlalchemy import update
from sqlmodel import Session, col, select

from app.communities import add_member, create_community, get_member
from app.db import engine
from app.models import (
    Asset,
    AssetStatus,
    Community,
    CommunityRole,
    Holding,
    Price,
    User,
    UserRole,
    World,
)
from app.services.rating import (
    SiteRating,
    latest_report,
    observed_until,
    rate_asset,
    rate_site,
)
from app.tools.earth_obs import DATA_DIR, EarthObsMetrics, load_site_metrics
from app.tools.scoring import is_wetland_from_landcover

# Re-exported: many callers import the fixed worlds from here.
from app.worlds import LIVE_LABEL as LIVE_LABEL
from app.worlds import LIVE_WORLD_ID as LIVE_WORLD_ID
from app.worlds import WORLD_ID as WORLD_ID

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
# Owner of every seeded community (a member, not a holder: the treasuries hold the stakes).
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


@dataclass(frozen=True)
class SeedCommunity:
    """A curated site's community and its treasury. Migration 0009 uses the same IDs."""

    id: UUID
    treasury_id: UUID
    site: DemoSite

    @property
    def name(self) -> str:
        return f"{self.site.name} Community"


SEED_COMMUNITIES: tuple[SeedCommunity, ...] = tuple(
    SeedCommunity(
        id=UUID(f"55555555-5555-5555-5555-5555555555{n:02d}"),
        treasury_id=UUID(f"66666666-6666-6666-6666-6666666666{n:02d}"),
        site=site,
    )
    for n, site in enumerate(DEMO_SITES, start=1)
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


def demo_rating(metrics: EarthObsMetrics) -> SiteRating:
    """Deterministic rating of a curated demo site's cached metrics (T14 + T15 + dev-spec §8).

    Rated on the day the freshest data window ends, with no Auditor or field evidence yet, so
    the numbers never drift with the wall clock. Wetland status comes from these metrics,
    which for the seed are the site's baseline.
    """
    return rate_site(
        metrics,
        is_wetland=is_wetland_from_landcover(metrics.landcover),
        as_of=observed_until(metrics),
        total_shares=TOTAL_SHARES,
    )


def demo_ipo_price(metrics: EarthObsMetrics) -> Decimal:
    """IPO price of a curated demo site: its report v1's fair value per share (dev-spec §8).

    Shares `rate_site` with the stored report (`_seed_reports`), so the two can't disagree.
    T59 replaces this for listings launched by their owner.
    """
    return demo_rating(metrics).fair_value_per_share


def _template_asset(session: Session, site: DemoSite) -> Asset:
    return session.exec(
        select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
    ).one()


def _seed_reports(session: Session) -> None:
    """Report v1 for every curated demo site in the template that has none yet (T19).

    Each is stored through the rating service (metrics row, report, `report` ledger entry) in
    one transaction. Visitor worlds copy them on creation or reset.
    """
    for site in DEMO_SITES:
        asset = _template_asset(session, site)
        if latest_report(session, WORLD_ID, asset.id) is not None:
            continue
        metrics = load_site_metrics(site.key)
        rate_asset(session, WORLD_ID, asset, metrics=metrics, as_of=observed_until(metrics))
        session.commit()


def _seed_ipo_prices(session: Session) -> None:
    """One `ipo` price per listed demo asset without a price, at its stored report's fair value
    per share, so trading works after `make seed`."""
    for site in DEMO_SITES:
        asset = _template_asset(session, site)
        has_price = session.exec(
            select(Price.asset_id).where(Price.world_id == WORLD_ID, Price.asset_id == asset.id)
        ).first()
        report = latest_report(session, WORLD_ID, asset.id)
        if asset.status != AssetStatus.LISTED or has_price is not None or report is None:
            continue
        if report.fair_value_per_share is None or report.fair_value_per_share <= 0:
            raise RuntimeError(f"report {report.id} has no positive fair value per share")
        session.add(
            Price(
                world_id=WORLD_ID,
                asset_id=asset.id,
                price=report.fair_value_per_share,
                reason="ipo",
            )
        )
    session.commit()


def _seed_communities(session: Session) -> None:
    """Each curated site's community, its treasury and Rosa as owner, if missing.

    Existing databases got them from migration 0009 with these same IDs, so this is a no-op
    there.
    """
    for community in SEED_COMMUNITIES:
        existing = session.get(Community, community.id)
        if existing is None:
            create_community(
                session,
                WORLD_ID,
                community.name,
                COMMUNITY_PERSONA.id,
                country=community.site.country,
                community_id=community.id,
                treasury_id=community.treasury_id,
            )
        elif get_member(session, existing, COMMUNITY_PERSONA.id) is None:
            add_member(session, existing, COMMUNITY_PERSONA.id, CommunityRole.OWNER)
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

    _seed_communities(session)

    primary_shares = int(TOTAL_SHARES * (Decimal("100") - RETAINED_PCT) / Decimal("100"))
    for community in SEED_COMMUNITIES:
        site = community.site
        existing_asset = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
        ).first()
        if existing_asset is None:
            session.add(
                Asset(
                    id=site.id,
                    world_id=WORLD_ID,
                    name=site.name,
                    community_id=community.id,
                    community_user_id=community.treasury_id,
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

    # The treasury keeps the community's retained stake as a holding, so shares are conserved:
    # total_shares = primary_shares_remaining + market_maker_shares + sum(holdings) (dev-spec §8).
    retained = TOTAL_SHARES - primary_shares
    for site in DEMO_SITES:
        asset = _template_asset(session, site)
        if asset.community_user_id is None:
            raise RuntimeError(f"template asset {site.key} has no treasury")
        if session.get(Holding, (WORLD_ID, asset.community_user_id, asset.id)) is None:
            session.add(
                Holding(
                    world_id=WORLD_ID,
                    user_id=asset.community_user_id,
                    asset_id=asset.id,
                    shares=retained,
                )
            )
    session.commit()

    _seed_reports(session)
    _seed_ipo_prices(session)


def main() -> None:
    # Imported here: app.sandbox imports this module.
    from app.sandbox import ensure_live_world

    with Session(engine) as session:
        seed(session)
        ensure_live_world(session)
    print(
        "Seed complete: template world, 4 personas, 3 demo assets with their communities, "
        "treasuries and retained stakes, report v1 and IPO prices; live world with the 3 "
        "curated sites."
    )


if __name__ == "__main__":
    main()

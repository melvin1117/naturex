"""Schema / seed tests (dev-spec §5 + world_id)."""

from __future__ import annotations

from decimal import Decimal

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import DBAPIError
from sqlmodel import Session, select

from app.config import get_settings
from app.models import Asset, LedgerEntry, LedgerKind, User, World
from app.seed import DEMO_GEOJSON, DEMO_SITES, PERSONAS, WORLD_ID, DemoSite, seed
from app.tools.geometry import validate_polygon
from tests.conftest import alembic_cfg, requires_db

EXPECTED_TABLES = {
    "worlds",
    "users",
    "assets",
    "metrics",
    "events",
    "reports",
    "prices",
    "holdings",
    "orders",
    "alerts",
    "doc_chunks",
    "ledger_entries",
    "llm_calls",
    "sessions",
    "payout_lines",
}


@requires_db
def test_migration_up_creates_tables() -> None:
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    tables = set(inspect(engine).get_table_names())
    engine.dispose()
    assert EXPECTED_TABLES.issubset(tables)


@requires_db
def test_migration_down_and_up() -> None:
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        # pgvector extension remains after downgrade; tables must exist again
        count = conn.execute(
            text("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
        ).scalar()
    engine.dispose()
    assert count is not None and count >= len(EXPECTED_TABLES)


@requires_db
def test_seed_is_idempotent() -> None:
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        seed(session)
        seed(session)

        worlds = session.exec(select(World).where(World.id == WORLD_ID)).all()
        users = session.exec(select(User).where(User.world_id == WORLD_ID)).all()
        assets = session.exec(select(Asset).where(Asset.world_id == WORLD_ID)).all()

    engine.dispose()
    assert len(worlds) == 1
    assert len(users) == 4
    assert len(assets) == 3
    assert {u.persona_key for u in users} == {"rosa", "arjun", "mia", "admin"}
    assert {a.site_key for a in assets} == {
        "wetland_mx",
        "mangrove_mx",
        "restoration_forest",
    }


# Square the seed used before T11/T13 replaced the placeholders with real boundaries.
_OLD_PLACEHOLDER_POLY = {
    "type": "Polygon",
    "coordinates": [
        [[-99.10, 19.25], [-99.08, 19.25], [-99.08, 19.27], [-99.10, 19.27], [-99.10, 19.25]]
    ],
}


@requires_db
@pytest.mark.parametrize("site", DEMO_SITES, ids=lambda site: site.key)
def test_seed_upgrades_existing_geometry_without_touching_accounting(site: DemoSite) -> None:
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        seed(session)
        asset = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
        ).one()
        asset.name = "Old placeholder name"
        asset.geojson = _OLD_PLACEHOLDER_POLY
        asset.area_ha = Decimal("500.00")
        asset.centroid_lat = 19.26
        asset.centroid_lon = -99.09
        asset.primary_shares_remaining = 123
        asset.community_wallet = Decimal("42.00")
        session.add(asset)
        session.commit()

        seed(session)
        upgraded = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == site.key)
        ).one()

    engine.dispose()
    assert upgraded.geojson == DEMO_GEOJSON[site.key]
    assert upgraded.name == site.name
    assert upgraded.area_ha == site.area_ha
    assert upgraded.centroid_lat == site.centroid_lat
    assert upgraded.centroid_lon == site.centroid_lon
    assert upgraded.primary_shares_remaining == 123
    assert upgraded.community_wallet == Decimal("42.00")


def test_demo_sites_use_their_committed_boundaries() -> None:
    for site in DEMO_SITES:
        check = validate_polygon(DEMO_GEOJSON[site.key])
        assert check.ok, site.key
        assert check.area_ha is not None
        assert float(site.area_ha) == pytest.approx(check.area_ha, abs=0.01)
        assert site.centroid_lat == pytest.approx(check.centroid_lat, abs=1e-4)
        assert site.centroid_lon == pytest.approx(check.centroid_lon, abs=1e-4)


@requires_db
def test_models_match_migrations() -> None:
    """Models and Alembic migrations must describe the same schema (no autogenerate drift)."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlmodel import SQLModel

    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        diffs = compare_metadata(MigrationContext.configure(conn), SQLModel.metadata)
    engine.dispose()
    assert diffs == [], f"models and migrations differ: {diffs}"


@requires_db
def test_ledger_is_append_only() -> None:
    """dev-spec §5/§17: no UPDATE, DELETE or TRUNCATE unless a sandbox reset opts in."""
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        seed(session)  # stores each demo site's report v1 entry at seq 0 (T19)
        session.add(
            LedgerEntry(
                world_id=WORLD_ID,
                asset_id=DEMO_SITES[0].id,
                seq=1,
                kind=LedgerKind.LISTING,
                payload={"area_ha": "500.00"},
                prev_hash="0" * 64,
                hash="a" * 64,
            )
        )
        session.commit()

    for statement in (
        "UPDATE ledger_entries SET hash = repeat('b', 64)",
        "DELETE FROM ledger_entries",
        "TRUNCATE ledger_entries",
    ):
        with engine.connect() as conn, pytest.raises(DBAPIError, match="append-only"):
            conn.execute(text(statement))

    with engine.begin() as conn:
        conn.execute(text("SET LOCAL naturex.allow_ledger_delete = 'on'"))
        deleted = conn.execute(text("DELETE FROM ledger_entries")).rowcount
    engine.dispose()
    assert deleted == len(DEMO_SITES) + 1
    # The template's report v1 entries are gone now; start later tests from an empty schema.
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")


def test_world_id_present_on_mutable_models() -> None:
    """Sandbox columns required by demo-plan §3.5 / T07."""
    from app import models as m

    for name in (
        "User",
        "Asset",
        "Metrics",
        "Event",
        "Report",
        "Price",
        "Holding",
        "Order",
        "Alert",
        "DocChunk",
        "LedgerEntry",
        "LlmCall",
    ):
        cls = getattr(m, name)
        assert "world_id" in cls.model_fields, f"{name} missing world_id"


@requires_db
def test_payout_lines_migration_downgrades_and_upgrades() -> None:
    """T67 (0008): payout lines, the assets (world_id, id) key and the one-payout-per-quarter
    ledger index come and go."""
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0007")
    engine = create_engine(get_settings().database_url)
    try:
        inspector = inspect(engine)
        assert "payout_lines" not in inspector.get_table_names()
        assert "auth_attempts" in inspector.get_table_names(), "0008 leaves T66 alone"
        assert "uq_assets_world_id_id" not in {
            c["name"] for c in inspector.get_unique_constraints("assets")
        }
        assert "uq_ledger_payout_quarter" not in {
            i["name"] for i in inspector.get_indexes("ledger_entries")
        }
        command.upgrade(cfg, "head")
        inspector = inspect(engine)
        assert "payout_lines" in inspector.get_table_names()
        assert "uq_assets_world_id_id" in {
            c["name"] for c in inspector.get_unique_constraints("assets")
        }
        assert "uq_ledger_payout_quarter" in {
            i["name"] for i in inspector.get_indexes("ledger_entries")
        }
        assert {fk["name"] for fk in inspector.get_foreign_keys("payout_lines")} == {
            "fk_payout_lines_asset",
            "fk_payout_lines_user",
        }
    finally:
        engine.dispose()


_LINE_INSERT = text(
    "INSERT INTO payout_lines (world_id, asset_id, quarter_label, user_id, shares, amount, "
    "nonce, leaf_hash) VALUES (:w, :a, 'q', :u, :shares, :amount, :nonce, :leaf)"
)


@requires_db
@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        ({"nonce": b"short"}, "ck_payout_lines_nonce_len"),
        ({"leaf": "not-a-hash"}, "ck_payout_lines_leaf_hash"),
        ({"u": None}, "ck_payout_lines_erased_together"),
        ({"nonce": None, "shares": None}, "ck_payout_lines_erased_together"),
    ],
    ids=["short-nonce", "bad-leaf", "half-erased", "half-erased-2"],
)
def test_payout_line_constraints(overrides: dict[str, object], constraint: str) -> None:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    params: dict[str, object] = {
        "w": WORLD_ID,
        "a": DEMO_SITES[0].id,
        "u": PERSONAS[1].id,
        "shares": 1,
        "amount": Decimal("0.01"),
        "nonce": b"\x00" * 32,
        "leaf": "0" * 64,
    } | overrides
    with engine.connect() as conn, conn.begin(), pytest.raises(DBAPIError, match=constraint):
        conn.execute(_LINE_INSERT, params)
    engine.dispose()

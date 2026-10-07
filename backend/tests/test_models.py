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
from app.seed import _PLACEHOLDER_POLY, DEMO_SITES, WORLD_ID, seed
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


@requires_db
def test_seed_upgrades_existing_wetland_geometry_without_touching_accounting() -> None:
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        seed(session)
        wetland = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == "wetland_mx")
        ).one()
        wetland.geojson = _PLACEHOLDER_POLY
        wetland.area_ha = Decimal("500.00")
        wetland.centroid_lat = 19.26
        wetland.centroid_lon = -99.09
        wetland.primary_shares_remaining = 123
        wetland.community_wallet = Decimal("42.00")
        session.add(wetland)
        session.commit()

        seed(session)
        upgraded = session.exec(
            select(Asset).where(Asset.world_id == WORLD_ID, Asset.site_key == "wetland_mx")
        ).one()

    engine.dispose()
    assert upgraded.geojson != _PLACEHOLDER_POLY
    assert upgraded.area_ha == DEMO_SITES[0].area_ha
    assert upgraded.centroid_lat == DEMO_SITES[0].centroid_lat
    assert upgraded.centroid_lon == DEMO_SITES[0].centroid_lon
    assert upgraded.primary_shares_remaining == 123
    assert upgraded.community_wallet == Decimal("42.00")


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
        seed(session)
        session.add(
            LedgerEntry(
                world_id=WORLD_ID,
                asset_id=DEMO_SITES[0].id,
                seq=0,
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
    assert deleted == 1


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

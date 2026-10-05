"""Schema / seed tests (dev-spec §5 + world_id)."""

from __future__ import annotations

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlmodel import Session, select

from app.config import get_settings
from app.models import Asset, User, World
from app.seed import WORLD_ID, seed
from tests.conftest import requires_db

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


def _alembic_cfg() -> Config:
    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url.replace("%", "%%"))
    return cfg


@requires_db
def test_migration_up_creates_tables() -> None:
    cfg = _alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")

    engine = create_engine(get_settings().database_url)
    tables = set(inspect(engine).get_table_names())
    engine.dispose()
    assert EXPECTED_TABLES.issubset(tables)


@requires_db
def test_migration_down_and_up() -> None:
    cfg = _alembic_cfg()
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
    cfg = _alembic_cfg()
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
def test_models_match_migrations() -> None:
    """Models and Alembic migrations must describe the same schema (no autogenerate drift)."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlmodel import SQLModel

    command.upgrade(_alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        diffs = compare_metadata(MigrationContext.configure(conn), SQLModel.metadata)
    engine.dispose()
    assert diffs == [], f"models and migrations differ: {diffs}"


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

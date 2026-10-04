"""Initial schema with world_id sandbox columns.

Revision ID: 0001
Revises:
Create Date: 2026-10-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')

    op.create_table(
        "worlds",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_worlds_label", "worlds", ["label"])

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("cash_balance", sa.Numeric(14, 2), nullable=False),
        sa.Column("persona_key", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("role IN ('community','investor','admin')", name="ck_users_role"),
    )
    op.create_index("ix_users_world_id", "users", ["world_id"])
    op.create_index("ix_users_persona_key", "users", ["persona_key"])

    op.create_table(
        "assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("community_user_id", sa.Uuid(), nullable=True),
        sa.Column("country", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("cover_image_url", sa.String(), nullable=True),
        sa.Column("geojson", postgresql.JSONB(), nullable=False),
        sa.Column("area_ha", sa.Numeric(12, 2), nullable=False),
        sa.Column("centroid_lat", sa.Float(), nullable=True),
        sa.Column("centroid_lon", sa.Float(), nullable=True),
        sa.Column("total_shares", sa.BigInteger(), nullable=False),
        sa.Column("retained_pct", sa.Numeric(5, 2), nullable=False),
        sa.Column("primary_shares_remaining", sa.BigInteger(), nullable=False),
        sa.Column("community_wallet", sa.Numeric(14, 2), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("site_key", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["community_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "status IN ('draft','rating','needs_evidence','ineligible','listed','suspended')",
            name="ck_assets_status",
        ),
    )
    op.create_index("ix_assets_world_id", "assets", ["world_id"])
    op.create_index("ix_assets_site_key", "assets", ["site_key"])

    op.create_table(
        "metrics",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("data_version", sa.String(), nullable=False),
        sa.Column("landcover", postgresql.JSONB(), nullable=False),
        sa.Column("ndvi_series", postgresql.JSONB(), nullable=True),
        sa.Column("ndvi_trend", sa.Numeric(12, 6), nullable=True),
        sa.Column("water_change", sa.Numeric(12, 4), nullable=True),
        sa.Column("forest_loss_ha", sa.Numeric(12, 2), nullable=True),
        sa.Column("biomass_t_ha", sa.Numeric(12, 2), nullable=True),
        sa.Column("cloud_free_obs", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_metrics_world_id", "metrics", ["world_id"])
    op.create_index("ix_metrics_asset_id", "metrics", ["asset_id"])

    op.create_table(
        "events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=True),
        sa.Column("url", sa.String(), nullable=True),
        sa.Column("published_at", sa.Date(), nullable=True),
        sa.Column("impact_type", sa.String(), nullable=True),
        sa.Column("direction", sa.SmallInteger(), nullable=True),
        sa.Column("severity", sa.SmallInteger(), nullable=True),
        sa.Column("summary", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("source IN ('tavily','admin','evidence')", name="ck_events_source"),
        sa.CheckConstraint("direction IN (-1, 0, 1)", name="ck_events_direction"),
        sa.CheckConstraint("severity BETWEEN 1 AND 5", name="ck_events_severity"),
    )
    op.create_index("ix_events_world_id", "events", ["world_id"])
    op.create_index("ix_events_asset_id", "events", ["asset_id"])

    op.create_table(
        "reports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("metrics_id", sa.Uuid(), nullable=True),
        sa.Column("health_score", sa.Numeric(5, 2), nullable=True),
        sa.Column("grade", sa.String(), nullable=True),
        sa.Column("confidence", sa.Numeric(5, 2), nullable=True),
        sa.Column("value_low", sa.Numeric(16, 2), nullable=True),
        sa.Column("value_mid", sa.Numeric(16, 2), nullable=True),
        sa.Column("value_high", sa.Numeric(16, 2), nullable=True),
        sa.Column("value_breakdown", postgresql.JSONB(), nullable=True),
        sa.Column("fair_value_per_share", sa.Numeric(12, 4), nullable=True),
        sa.Column("flags", postgresql.JSONB(), nullable=True),
        sa.Column("summary_md", sa.String(), nullable=True),
        sa.Column("recommendations", postgresql.JSONB(), nullable=True),
        sa.Column("auditor_json", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.ForeignKeyConstraint(["metrics_id"], ["metrics.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("asset_id", "version", name="uq_reports_asset_version"),
    )
    op.create_index("ix_reports_world_id", "reports", ["world_id"])
    op.create_index("ix_reports_asset_id", "reports", ["asset_id"])

    op.create_table(
        "prices",
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("ts", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("price", sa.Numeric(12, 4), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("world_id", "asset_id", "ts"),
    )

    op.create_table(
        "holdings",
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("shares", sa.BigInteger(), nullable=False),
        sa.Column("avg_cost", sa.Numeric(12, 4), nullable=True),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("world_id", "user_id", "asset_id"),
    )

    op.create_table(
        "orders",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("side", sa.String(), nullable=False),
        sa.Column("qty", sa.BigInteger(), nullable=False),
        sa.Column("fill_price", sa.Numeric(12, 4), nullable=True),
        sa.Column("is_primary", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("side IN ('buy','sell')", name="ck_orders_side"),
    )
    op.create_index("ix_orders_world_id", "orders", ["world_id"])
    op.create_index("ix_orders_user_id", "orders", ["user_id"])
    op.create_index("ix_orders_asset_id", "orders", ["asset_id"])

    op.create_table(
        "alerts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(), nullable=True),
        sa.Column("message", sa.String(), nullable=True),
        sa.Column("severity", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_alerts_world_id", "alerts", ["world_id"])
    op.create_index("ix_alerts_asset_id", "alerts", ["asset_id"])

    op.create_table(
        "doc_chunks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=True),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("embedding", Vector(1024), nullable=True),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.ForeignKeyConstraint(["report_id"], ["reports.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_doc_chunks_world_id", "doc_chunks", ["world_id"])
    op.create_index("ix_doc_chunks_asset_id", "doc_chunks", ["asset_id"])

    op.create_table(
        "ledger_entries",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("ref_id", sa.Uuid(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("prev_hash", sa.String(length=64), nullable=False),
        sa.Column("hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("asset_id", "seq", name="uq_ledger_asset_seq"),
        sa.CheckConstraint(
            "kind IN ('listing','report','event','price_anchor','payout')",
            name="ck_ledger_kind",
        ),
    )
    op.create_index("ix_ledger_entries_world_id", "ledger_entries", ["world_id"])
    op.create_index("ix_ledger_entries_asset_id", "ledger_entries", ["asset_id"])

    op.create_table(
        "llm_calls",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=True),
        sa.Column("agent", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("asset_id", sa.Uuid(), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("completion_tokens", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.ForeignKeyConstraint(["asset_id"], ["assets.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_llm_calls_world_id", "llm_calls", ["world_id"])


def downgrade() -> None:
    op.drop_table("llm_calls")
    op.drop_table("ledger_entries")
    op.drop_table("doc_chunks")
    op.drop_table("alerts")
    op.drop_table("orders")
    op.drop_table("holdings")
    op.drop_table("prices")
    op.drop_table("reports")
    op.drop_table("events")
    op.drop_table("metrics")
    op.drop_table("assets")
    op.drop_table("users")
    op.drop_table("worlds")

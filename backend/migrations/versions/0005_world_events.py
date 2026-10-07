"""Add persisted world-scoped live events for SSE and polling (T29).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "world_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "type IN ('rating_progress','price_tick','alert','heartbeat')",
            name="ck_world_events_type",
        ),
    )
    op.create_index("ix_world_events_world_id", "world_events", ["world_id"])
    op.create_index("ix_world_events_world_id_id", "world_events", ["world_id", "id"])


def downgrade() -> None:
    op.drop_index("ix_world_events_world_id_id", table_name="world_events")
    op.drop_index("ix_world_events_world_id", table_name="world_events")
    op.drop_table("world_events")

"""Async Time Machine quarters (#201): `quarter_jobs`.

- `quarter_jobs`: one "Next quarter" running in the background. `POST /admin/simulate/quarter`
  moves the world and inserts the job (`queued`); a worker runs it (`running`) and appends each
  settled asset's result to `assets`, then ends it `done`, `stopped` (a budget or rate-limit
  stop) or `failed`. `uq_quarter_jobs_active_world` allows one queued or running job per world.
  `lease` and `heartbeat_at` let a poll take over a job whose process died and resume it.

Revision ID: 0025
Revises: 0023
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0025"
down_revision: str | Sequence[str] | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _now(name: str) -> sa.Column[sa.DateTime]:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "quarter_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("period", sa.String(), nullable=False),
        sa.Column("step", sa.SmallInteger(), nullable=False),
        sa.Column("replayed", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("stopped", sa.String(), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("planned", JSONB(), nullable=True),
        sa.Column("assets", JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("lease", sa.Uuid(), nullable=True),
        _now("heartbeat_at"),
        _now("created_at"),
        _now("updated_at"),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('queued','running','done','stopped','failed')",
            name="ck_quarter_jobs_status",
        ),
        sa.CheckConstraint("step >= 1", name="ck_quarter_jobs_step"),
        sa.ForeignKeyConstraint(["world_id"], ["worlds.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_quarter_jobs_active_world",
        "quarter_jobs",
        ["world_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )
    op.create_index(
        "ix_quarter_jobs_world_id_created_at", "quarter_jobs", ["world_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_quarter_jobs_world_id_created_at", table_name="quarter_jobs")
    op.drop_index("uq_quarter_jobs_active_world", table_name="quarter_jobs")
    op.drop_table("quarter_jobs")

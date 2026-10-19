"""Add `earth_obs_cache` and `live_rating_requests` for live ratings of new listings (T60).

`earth_obs_cache` holds the live Earth Engine metrics of a polygon, keyed by the SHA-256 of its
bare geometry and the data version, so a polygon is computed once per data version.
`live_rating_requests` counts live ratings per account per day and globally. Neither table is
world-scoped: sandbox resets and prunes keep them, so they never free quota.

Revision ID: 0015
Revises: 0013
Create Date: 2026-10-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015"
# T69 adds 0014 in parallel; whichever merges second renumbers and re-points this.
down_revision: str | Sequence[str] | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "earth_obs_cache",
        sa.Column("geometry_sha256", sa.String(length=64), nullable=False),
        sa.Column("data_version", sa.String(), nullable=False),
        sa.Column("metrics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("geometry_sha256", "data_version"),
        sa.CheckConstraint(
            "length(geometry_sha256) = 64", name="ck_earth_obs_cache_geometry_sha256_len"
        ),
    )
    op.create_table(
        "live_rating_requests",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("geometry_sha256", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "length(geometry_sha256) = 64", name="ck_live_rating_requests_geometry_sha256_len"
        ),
    )
    op.create_index(
        "ix_live_rating_requests_user_id_created_at",
        "live_rating_requests",
        ["user_id", "created_at"],
    )
    op.create_index("ix_live_rating_requests_created_at", "live_rating_requests", ["created_at"])
    op.create_index("ix_live_rating_requests_run_id", "live_rating_requests", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_live_rating_requests_run_id", table_name="live_rating_requests")
    op.drop_index("ix_live_rating_requests_created_at", table_name="live_rating_requests")
    op.drop_index("ix_live_rating_requests_user_id_created_at", table_name="live_rating_requests")
    op.drop_table("live_rating_requests")
    op.drop_table("earth_obs_cache")

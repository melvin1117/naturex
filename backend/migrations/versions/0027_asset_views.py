"""Live before/after views: `asset_views`.

- `asset_views`: a live-rated listing's two Sentinel-2 true-colour views five years apart (the
  demo sites' precomputed `before.webp` and `thumbnail.webp`, rendered by the rating run), with
  the grid's bounds, pixel size and both date windows. One per asset (the primary key), replaced
  on a re-rating for a new boundary or data version (`geometry_sha256`, `data_version`) and
  deleted with its asset (the `(world_id, asset_id)` foreign key cascades). Checks bound each
  image (300 KB, 1024 px) and keep the bounds and windows well-formed and in order;
  `ix_asset_views_world_id` serves a world's prune.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0027"
down_revision: str | Sequence[str] | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "asset_views",
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("geometry_sha256", sa.String(64), nullable=False),
        sa.Column("data_version", sa.String(), nullable=False),
        sa.Column("before_webp", sa.LargeBinary(), nullable=False),
        sa.Column("after_webp", sa.LargeBinary(), nullable=False),
        sa.Column("width", sa.SmallInteger(), nullable=False),
        sa.Column("height", sa.SmallInteger(), nullable=False),
        sa.Column("south", sa.Float(), nullable=False),
        sa.Column("west", sa.Float(), nullable=False),
        sa.Column("north", sa.Float(), nullable=False),
        sa.Column("east", sa.Float(), nullable=False),
        sa.Column("before_start", sa.Date(), nullable=False),
        sa.Column("before_end", sa.Date(), nullable=False),
        sa.Column("after_start", sa.Date(), nullable=False),
        sa.Column("after_end", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(geometry_sha256) = 64", name="ck_asset_views_geometry_sha256_len"
        ),
        sa.CheckConstraint(
            "octet_length(before_webp) BETWEEN 1 AND 300000"
            " AND octet_length(after_webp) BETWEEN 1 AND 300000",
            name="ck_asset_views_image_size",
        ),
        sa.CheckConstraint(
            "width BETWEEN 1 AND 1024 AND height BETWEEN 1 AND 1024",
            name="ck_asset_views_dimensions",
        ),
        sa.CheckConstraint("south < north AND west < east", name="ck_asset_views_bounds"),
        sa.CheckConstraint(
            "before_start < before_end AND before_end <= after_start AND after_start < after_end",
            name="ck_asset_views_date_windows",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_asset_views_asset",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("asset_id"),
    )
    op.create_index("ix_asset_views_world_id", "asset_views", ["world_id"])


def downgrade() -> None:
    op.drop_index("ix_asset_views_world_id", table_name="asset_views")
    op.drop_table("asset_views")

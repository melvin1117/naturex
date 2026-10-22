"""Live land-cover overlays (#231): `asset_overlays`.

- `asset_overlays`: a live-rated listing's Dynamic World land-cover overlay PNG (the demo
  sites' precomputed `overlay.png`, rendered by the rating run), with its bounds, pixel size
  and date window. One per asset (the primary key), replaced on a re-rating for a new
  boundary or data version (`geometry_sha256`, `data_version`) and deleted with its asset
  (the `(world_id, asset_id)` foreign key cascades). Checks bound the PNG (300 KB, 1024 px)
  and keep the bounds and window well-formed; `ix_asset_overlays_world_id` serves a world's
  prune.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | Sequence[str] | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "asset_overlays",
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("geometry_sha256", sa.String(64), nullable=False),
        sa.Column("data_version", sa.String(), nullable=False),
        sa.Column("png", sa.LargeBinary(), nullable=False),
        sa.Column("width", sa.SmallInteger(), nullable=False),
        sa.Column("height", sa.SmallInteger(), nullable=False),
        sa.Column("south", sa.Float(), nullable=False),
        sa.Column("west", sa.Float(), nullable=False),
        sa.Column("north", sa.Float(), nullable=False),
        sa.Column("east", sa.Float(), nullable=False),
        sa.Column("date_start", sa.Date(), nullable=False),
        sa.Column("date_end", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(geometry_sha256) = 64", name="ck_asset_overlays_geometry_sha256_len"
        ),
        sa.CheckConstraint(
            "octet_length(png) BETWEEN 1 AND 300000", name="ck_asset_overlays_png_size"
        ),
        sa.CheckConstraint(
            "width BETWEEN 1 AND 1024 AND height BETWEEN 1 AND 1024",
            name="ck_asset_overlays_dimensions",
        ),
        sa.CheckConstraint("south < north AND west < east", name="ck_asset_overlays_bounds"),
        sa.CheckConstraint("date_start < date_end", name="ck_asset_overlays_date_window"),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_asset_overlays_asset",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("asset_id"),
    )
    op.create_index("ix_asset_overlays_world_id", "asset_overlays", ["world_id"])


def downgrade() -> None:
    op.drop_index("ix_asset_overlays_world_id", table_name="asset_overlays")
    op.drop_table("asset_overlays")

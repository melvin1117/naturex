"""IPO launch (T59): when an asset's IPO opened trading, and one IPO price per asset.

- `assets.ipo_at` (nullable TIMESTAMPTZ): when the IPO opened trading. NULL means no shares
  are issued yet, so orders are refused (409 `not_trading`). Backfilled from each asset's first
  price: the curated sites' seeded `ipo` prices in the template, live and visitor worlds.
- `uq_prices_ipo`: a unique partial index on `prices (world_id, asset_id) WHERE reason = 'ipo'`,
  so an asset can't be launched twice even if the service's check under the asset lock were
  bypassed. The upgrade fails, naming the count, if an asset already has two `ipo` prices.

Downgrading drops both. Launched listings keep their `ipo` price, which the older order route
treats as "trading".

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | Sequence[str] | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    duplicates = bind.execute(
        sa.text(
            "SELECT count(*) FROM (SELECT 1 FROM prices WHERE reason = 'ipo' "
            "GROUP BY world_id, asset_id HAVING count(*) > 1) AS twice"
        )
    ).scalar_one()
    if duplicates:
        raise RuntimeError(f"{duplicates} assets have more than one 'ipo' price; keep one each")

    op.add_column("assets", sa.Column("ipo_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        "UPDATE assets SET ipo_at = first.ts "
        "FROM (SELECT world_id, asset_id, min(ts) AS ts FROM prices "
        "GROUP BY world_id, asset_id) AS first "
        "WHERE assets.world_id = first.world_id AND assets.id = first.asset_id"
    )
    op.create_index(
        "uq_prices_ipo",
        "prices",
        ["world_id", "asset_id"],
        unique=True,
        postgresql_where=sa.text("reason = 'ipo'"),
    )


def downgrade() -> None:
    op.drop_index("uq_prices_ipo", table_name="prices")
    op.drop_column("assets", "ipo_at")

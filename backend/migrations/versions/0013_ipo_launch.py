"""IPO launch (T59): when an asset's IPO opened trading, and one IPO price per asset.

- `assets.ipo_at` (nullable TIMESTAMPTZ): when the IPO opened trading. NULL means no shares
  are issued yet, so orders are refused (409 `not_trading`). Backfilled from each asset's first
  price: the curated sites' seeded `ipo` prices in the template, live and visitor worlds.
- Unlaunched assets (`ipo_at` still NULL) have no shares issued: `primary_shares_remaining` is
  set to 0 where they have no holdings (T58 drafts were created with a default float). An
  unlaunched asset that has holdings is left alone and named in a warning: zeroing its float
  would break share conservation, so fix it by hand (or `make seed`, which launches curated
  sites).
- `uq_prices_ipo`: a unique partial index on `prices (world_id, asset_id) WHERE reason = 'ipo'`,
  so an asset can't be launched twice even if the service's check under the asset lock were
  bypassed. The upgrade fails, naming the count, if an asset already has two `ipo` prices.

Downgrading drops both. Launched listings keep their `ipo` price, which the older order route
treats as "trading"; unlaunched assets keep a float of 0 (the older code never trades them, as
they have no price).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-18
"""

import logging
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | Sequence[str] | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")
_UNLAUNCHED_HELD = (
    "FROM assets WHERE ipo_at IS NULL AND EXISTS (SELECT 1 FROM holdings h "
    "WHERE h.world_id = assets.world_id AND h.asset_id = assets.id)"
)


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
    held = bind.execute(sa.text(f"SELECT world_id, id {_UNLAUNCHED_HELD}")).all()
    if held:
        names = ", ".join(f"{world_id}/{asset_id}" for world_id, asset_id in held)
        log.warning(
            "0013: %d unlaunched assets have holdings; their primary float is left as is: %s",
            len(held),
            names,
        )
    op.execute(
        "UPDATE assets SET primary_shares_remaining = 0 WHERE ipo_at IS NULL "
        "AND primary_shares_remaining <> 0 AND NOT EXISTS (SELECT 1 FROM holdings h "
        "WHERE h.world_id = assets.world_id AND h.asset_id = assets.id)"
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

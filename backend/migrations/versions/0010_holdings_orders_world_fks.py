"""Holdings and orders reference their user and asset within their own world (#144).

Both tables already carry `world_id NOT NULL` (with a foreign key to `worlds`), but their user
and asset foreign keys were plain single-column ones, so only application code stopped a row
from naming another world's user or asset. They become composite foreign keys onto the unique
`(world_id, id)` keys of `users` (`uq_users_world_id_id`) and `assets` (`uq_assets_world_id_id`),
as T56 did for sessions, members and payout lines. `ON DELETE` stays the default (`NO ACTION`),
like every other foreign key here, so sandbox cleanup still deletes children first.

`ix_holdings_world_id_asset_id` backs the new asset key (the primary key already covers
`(world_id, user_id)`); the existing `orders` indexes are kept.

Upgrading fails, naming the offending rows' count, if any holding or order already crosses
worlds; there is no safe way to guess which side is right.

Downgrading restores the plain foreign keys under their original names.

The keys are added in one step, which locks and scans both tables; that is fine for the demo's
small tables. On a busy hosted database (after T20), add them `NOT VALID` under a short
`lock_timeout` and `VALIDATE CONSTRAINT` them in a later transaction instead.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, column, parent table, composite foreign key name)
_REFERENCES = (
    ("holdings", "user_id", "users", "fk_holdings_user"),
    ("holdings", "asset_id", "assets", "fk_holdings_asset"),
    ("orders", "user_id", "users", "fk_orders_user"),
    ("orders", "asset_id", "assets", "fk_orders_asset"),
)


def _reject_cross_world_rows(bind: sa.Connection) -> None:
    for table, column, parent, _ in _REFERENCES:
        crossing = bind.execute(
            sa.text(
                f"SELECT count(*) FROM {table} t JOIN {parent} p ON p.id = t.{column} "
                "WHERE p.world_id <> t.world_id"
            )
        ).scalar_one()
        if crossing:
            raise RuntimeError(
                f"{crossing} {table} row(s) reference {parent} in another world; "
                "fix or delete them before upgrading"
            )


def upgrade() -> None:
    _reject_cross_world_rows(op.get_bind())
    for table, column, parent, name in _REFERENCES:
        op.drop_constraint(f"{table}_{column}_fkey", table, type_="foreignkey")
        op.create_foreign_key(name, table, parent, ["world_id", column], ["world_id", "id"])
    op.create_index("ix_holdings_world_id_asset_id", "holdings", ["world_id", "asset_id"])


def downgrade() -> None:
    op.drop_index("ix_holdings_world_id_asset_id", table_name="holdings")
    for table, column, parent, name in _REFERENCES:
        op.drop_constraint(name, table, type_="foreignkey")
        op.create_foreign_key(f"{table}_{column}_fkey", table, parent, [column], ["id"])

"""Community names are unique per world, case-insensitively (T68 review).

A unique index on `communities (world_id, lower(name))`, so two communities in one world can't
share a name in any letter case; the API returns 409 `community_name_taken`. Names are
NFKC-normalized by the API before they reach it. Seeded names (`<site name> Community`) are
already distinct, and every sandbox copies them into its own world.

Upgrading fails, naming the count, if a world already has duplicate names; rename one first.

Downgrading drops the index.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "uq_communities_world_lower_name"


def upgrade() -> None:
    duplicates = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT count(*) FROM (SELECT 1 FROM communities "
                "GROUP BY world_id, lower(name) HAVING count(*) > 1) AS d"
            )
        )
        .scalar_one()
    )
    if duplicates:
        raise RuntimeError(
            f"{duplicates} community names repeat within a world (any case); rename them first"
        )
    op.create_index(INDEX, "communities", ["world_id", sa.text("lower(name)")], unique=True)


def downgrade() -> None:
    op.drop_index(INDEX, table_name="communities")

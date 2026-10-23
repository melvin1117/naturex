"""Live ratings in demo sandboxes: `live_rating_requests.world_id`.

Sandboxes now compute new polygons live too, against their own daily allowance
(`SANDBOX_LIVE_RATINGS_PER_DAY`, every sandbox together), so the live world's
(`LIVE_RATINGS_GLOBAL_PER_DAY`) counts only its own rows. Each row records the submitter's world,
with no foreign key: rows outlive pruned sandboxes, so a prune never frees quota. Until now only
the live world counted live ratings, so existing rows are backfilled with its ID.

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0029"
down_revision: str | Sequence[str] | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LIVE_WORLD_ID = "44444444-4444-4444-4444-444444444444"  # app.worlds.LIVE_WORLD_ID, frozen


def upgrade() -> None:
    op.add_column(
        "live_rating_requests",
        sa.Column(
            "world_id", sa.Uuid(), nullable=False, server_default=sa.text(f"'{_LIVE_WORLD_ID}'")
        ),
    )
    op.alter_column("live_rating_requests", "world_id", server_default=None)


def downgrade() -> None:
    # Before 0029 every row counted against the live world's allowance: drop the sandboxes'.
    op.execute(f"DELETE FROM live_rating_requests WHERE world_id <> '{_LIVE_WORLD_ID}'")
    op.drop_column("live_rating_requests", "world_id")

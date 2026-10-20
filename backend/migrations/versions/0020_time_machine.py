"""Time Machine (T38): the world's simulated quarter and each rating's full metrics.

- `worlds.time_machine_step`: how many Time Machine quarters the world has advanced (0 = the
  observed baseline, the first entry of `data/demo_sites/scenarios.json`'s timeline). "Next
  quarter" raises it by one; a sandbox reset puts it back to 0.
- `metrics.provenance`: the full Earth observation document a rating used (scenario labels,
  deltas, NDVI series…; dev-spec §7.4 "As built (T19)" deferred it to T38), so an event preset
  can apply its deltas to an asset's current state. NULL on rows written before this revision:
  curated sites then fall back to their committed versions.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0020"
down_revision: str | Sequence[str] | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "worlds",
        sa.Column(
            "time_machine_step", sa.SmallInteger(), server_default=sa.text("0"), nullable=False
        ),
    )
    op.create_check_constraint("ck_worlds_time_machine_step", "worlds", "time_machine_step >= 0")
    op.add_column("metrics", sa.Column("provenance", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("metrics", "provenance")
    op.drop_constraint("ck_worlds_time_machine_step", "worlds", type_="check")
    op.drop_column("worlds", "time_machine_step")

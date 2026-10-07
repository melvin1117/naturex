"""Private payout lines and commitment salts (ADR-0005 §6; T67).

Adds a unique `(world_id, id)` on assets for composite foreign keys, the private, erasable
`payout_lines` table (one row per holder per payout) and `payout_salts` (the random salt of
each payout's public line commitment, one per asset quarter). The public ledger keeps only
aggregates and the commitment.

Payout entries written before T67 still list per-holder payouts in their (immutable) ledger
payload; there were no real accounts then, only sandbox personas. Downgrading drops the lines
and salts, so commitments written since can no longer be verified.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_unique_constraint("uq_assets_world_id_id", "assets", ["world_id", "id"])

    op.create_table(
        "payout_lines",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("quarter_label", sa.String(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("shares", sa.BigInteger(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_payout_lines_asset",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "user_id"], ["users.world_id", "users.id"], name="fk_payout_lines_user"
        ),
        sa.UniqueConstraint(
            "world_id", "asset_id", "quarter_label", "user_id", name="uq_payout_lines_holder"
        ),
        sa.CheckConstraint("shares > 0", name="ck_payout_lines_shares_positive"),
        sa.CheckConstraint("amount > 0", name="ck_payout_lines_amount_positive"),
    )
    op.create_index("ix_payout_lines_world_id_user_id", "payout_lines", ["world_id", "user_id"])

    op.create_table(
        "payout_salts",
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("quarter_label", sa.String(), nullable=False),
        sa.Column("salt", sa.LargeBinary(), nullable=False),
        sa.PrimaryKeyConstraint("world_id", "asset_id", "quarter_label"),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_payout_salts_asset",
        ),
        sa.CheckConstraint("octet_length(salt) = 32", name="ck_payout_salts_salt_len"),
    )


def downgrade() -> None:
    op.drop_table("payout_salts")
    op.drop_index("ix_payout_lines_world_id_user_id", table_name="payout_lines")
    op.drop_table("payout_lines")
    op.drop_constraint("uq_assets_world_id_id", "assets", type_="unique")

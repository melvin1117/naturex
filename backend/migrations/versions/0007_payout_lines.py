"""Private payout lines with per-line commitments (ADR-0005 §6; T67).

Adds a unique `(world_id, id)` on assets for composite foreign keys, the private, erasable
`payout_lines` table (one row per holder per payout, each with its own random nonce and leaf
hash) and a partial unique index allowing one `payout` ledger entry per asset quarter. The
public ledger keeps only aggregates and a commitment over the sorted leaf hashes.

An erased line keeps only its leaf hash (a tombstone): user, shares, amount and nonce are all
cleared together, which `ck_payout_lines_erased_together` enforces.

Payout entries written before T67 still list per-holder payouts in their (immutable) ledger
payload; there were no real accounts then, only sandbox personas. Downgrading drops the lines,
so commitments written since can no longer be verified.

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
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("shares", sa.BigInteger(), nullable=True),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("nonce", sa.LargeBinary(), nullable=True),
        sa.Column("leaf_hash", sa.String(length=64), nullable=False),
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
        sa.CheckConstraint(
            "num_nulls(user_id, shares, amount, nonce) IN (0, 4)",
            name="ck_payout_lines_erased_together",
        ),
        sa.CheckConstraint("shares > 0", name="ck_payout_lines_shares_positive"),
        sa.CheckConstraint("amount > 0", name="ck_payout_lines_amount_positive"),
        sa.CheckConstraint("octet_length(nonce) = 32", name="ck_payout_lines_nonce_len"),
        sa.CheckConstraint("leaf_hash ~ '^[0-9a-f]{64}$'", name="ck_payout_lines_leaf_hash"),
    )
    op.create_index("ix_payout_lines_world_id_user_id", "payout_lines", ["world_id", "user_id"])
    op.create_index(
        "uq_ledger_payout_quarter",
        "ledger_entries",
        ["asset_id", sa.text("(payload ->> 'quarter_label')")],
        unique=True,
        postgresql_where=sa.text("kind = 'payout'"),
    )


def downgrade() -> None:
    op.drop_index("uq_ledger_payout_quarter", table_name="ledger_entries")
    op.drop_index("ix_payout_lines_world_id_user_id", table_name="payout_lines")
    op.drop_table("payout_lines")
    op.drop_constraint("uq_assets_world_id_id", "assets", type_="unique")

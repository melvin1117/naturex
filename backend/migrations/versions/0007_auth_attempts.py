"""Add `auth_attempts`, the Postgres-backed rate-limit counters (ADR-0005 section 1, T66).

Each row is one counted sign-in or registration attempt in one bucket. Only an HMAC of the IP
address or of the normalised email is stored, so neither can be read back from the table. Rows
older than 24 hours are pruned together with expired sessions.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "auth_attempts",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("bucket", sa.String(), nullable=False),
        sa.Column("key_hmac", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("bucket IN ('ip','account')", name="ck_auth_attempts_bucket"),
        sa.CheckConstraint("kind IN ('login','register')", name="ck_auth_attempts_kind"),
        sa.CheckConstraint("length(key_hmac) = 64", name="ck_auth_attempts_key_hmac_len"),
    )
    op.create_index(
        "ix_auth_attempts_bucket_key_hmac_created_at",
        "auth_attempts",
        ["bucket", "key_hmac", "created_at"],
    )
    op.create_index("ix_auth_attempts_created_at", "auth_attempts", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_auth_attempts_created_at", table_name="auth_attempts")
    op.drop_index("ix_auth_attempts_bucket_key_hmac_created_at", table_name="auth_attempts")
    op.drop_table("auth_attempts")

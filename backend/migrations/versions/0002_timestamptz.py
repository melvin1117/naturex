"""Align schema with dev-spec §5: timestamptz columns and worlds.last_seen_at.

Revision 0001 created these columns as TIMESTAMP WITHOUT TIME ZONE while the models
write timezone-aware UTC datetimes. Existing values are interpreted as UTC.
worlds.last_seen_at lets the sandbox (T31) prune stale visitor worlds.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TIMESTAMP_COLUMNS: list[tuple[str, str]] = [
    ("worlds", "created_at"),
    ("assets", "created_at"),
    ("metrics", "created_at"),
    ("events", "created_at"),
    ("reports", "created_at"),
    ("prices", "ts"),
    ("orders", "created_at"),
    ("alerts", "created_at"),
    ("ledger_entries", "created_at"),
    ("llm_calls", "created_at"),
]


def upgrade() -> None:
    op.add_column(
        "worlds",
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    for table, column in TIMESTAMP_COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.DateTime(timezone=True),
            existing_type=sa.DateTime(),
            existing_nullable=False,
            existing_server_default=sa.text("now()"),
            postgresql_using=f"{column} AT TIME ZONE 'UTC'",
        )


def downgrade() -> None:
    op.drop_column("worlds", "last_seen_at")
    for table, column in TIMESTAMP_COLUMNS:
        op.alter_column(
            table,
            column,
            type_=sa.DateTime(),
            existing_type=sa.DateTime(timezone=True),
            existing_nullable=False,
            existing_server_default=sa.text("now()"),
            postgresql_using=f"{column} AT TIME ZONE 'UTC'",
        )

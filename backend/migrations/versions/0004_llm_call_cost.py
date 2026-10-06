"""Add cost, tier and status to llm_calls so the LLM client can enforce LLM_BUDGET_USD (T09).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "llm_calls",
        sa.Column("cost_usd", sa.Numeric(12, 6), server_default="0", nullable=False),
    )
    op.add_column("llm_calls", sa.Column("tier", sa.String(), nullable=True))
    op.add_column(
        "llm_calls",
        sa.Column("status", sa.String(), server_default="ok", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("llm_calls", "status")
    op.drop_column("llm_calls", "tier")
    op.drop_column("llm_calls", "cost_usd")

"""A community sends its opening offer for review; the Reviewer's approval launches it (ADR-0008).

`assets.offer_sent_at` is when the community last sent its offer (the terms are the asset's
`total_shares` and `retained_pct`, which the launch reads); NULL when nothing waits for review.
`assets.offer_review_note` is the Reviewer's reason when they send an offer back.

Revision ID: 0031
Revises: 0030
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031"
down_revision: str | Sequence[str] | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("assets", sa.Column("offer_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("assets", sa.Column("offer_review_note", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("assets", "offer_review_note")
    op.drop_column("assets", "offer_sent_at")

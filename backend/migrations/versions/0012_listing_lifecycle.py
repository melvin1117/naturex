"""Listing lifecycle (T58): why a listing is in its status, its attestation, and its events.

- `assets.status_reason` (nullable, ≤ 200 characters): a stable code explaining the status, e.g.
  the listing gate's failure codes for `needs_evidence` / `ineligible`, a suspension reason, or
  `no_satellite_metrics` while a new polygon waits for live Earth observation data (T60).
- `assets.attested_at` (nullable TIMESTAMPTZ): when the community attested, on creating the
  draft, that it may list this land. Curated (seeded) sites predate attestation and keep NULL.
- `world_events.type` also accepts `listing_status`, the event every lifecycle transition
  publishes.

Existing rows need no backfill: seeded curated sites are already `listed` with no reason.

Downgrading deletes `listing_status` events (they are pruned after 24 h anyway), restores the
old event type check and drops both columns.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EVENT_TYPES_BEFORE = "'rating_progress','price_tick','alert','heartbeat'"
_EVENT_TYPES_AFTER = f"{_EVENT_TYPES_BEFORE},'listing_status'"


def upgrade() -> None:
    op.add_column("assets", sa.Column("status_reason", sa.String(length=200), nullable=True))
    op.add_column("assets", sa.Column("attested_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_constraint("ck_world_events_type", "world_events", type_="check")
    op.create_check_constraint(
        "ck_world_events_type", "world_events", f"type IN ({_EVENT_TYPES_AFTER})"
    )


def downgrade() -> None:
    op.execute("DELETE FROM world_events WHERE type = 'listing_status'")
    op.drop_constraint("ck_world_events_type", "world_events", type_="check")
    op.create_check_constraint(
        "ck_world_events_type", "world_events", f"type IN ({_EVENT_TYPES_BEFORE})"
    )
    op.drop_column("assets", "attested_at")
    op.drop_column("assets", "status_reason")

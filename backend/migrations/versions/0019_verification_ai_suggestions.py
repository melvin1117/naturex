"""AI document check results (T71, ADR-0006 §2): `verification_ai_suggestions`.

One row per verification run: the untrusted AI heuristic shown to the reviewer, kept apart
from `verification_runs` so it can never change a run's checklist or level. A composite
`(world_id, asset_id, run_id)` foreign key ties it to a run of its own asset.

Rows are written once: the existing `verification_immutable()` trigger refuses UPDATE and
DELETE except under the whole-world delete opt-in (sandbox reset and prune), and TRUNCATE.

Revision ID: 0019
Revises: 0016
Create Date: 2026-10-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0019"
down_revision: str | Sequence[str] | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "verification_ai_suggestions"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("run_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), sa.ForeignKey("worlds.id"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("suggestion", sa.String(), nullable=True),
        sa.Column("result", JSONB(), nullable=False),
        sa.Column("method_version", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id", "run_id"],
            ["verification_runs.world_id", "verification_runs.asset_id", "verification_runs.id"],
            name="fk_verification_ai_suggestions_run",
        ),
        sa.CheckConstraint(
            "status IN ('completed','failed')", name="ck_verification_ai_suggestions_status"
        ),
        sa.CheckConstraint(
            "suggestion IS NULL OR suggestion IN ('consistent','inconsistent','unreadable')",
            name="ck_verification_ai_suggestions_suggestion",
        ),
        sa.CheckConstraint(
            "(status = 'completed') = (suggestion IS NOT NULL)",
            name="ck_verification_ai_suggestions_completed",
        ),
    )
    op.create_index("ix_verification_ai_suggestions_world_id", _TABLE, ["world_id"])
    op.execute(
        f"CREATE TRIGGER {_TABLE}_immutable BEFORE UPDATE OR DELETE "
        f"ON {_TABLE} FOR EACH ROW EXECUTE FUNCTION verification_immutable()"
    )
    op.execute(
        f"CREATE TRIGGER {_TABLE}_no_truncate BEFORE TRUNCATE ON {_TABLE} "
        "FOR EACH STATEMENT EXECUTE FUNCTION verification_immutable()"
    )


def downgrade() -> None:
    op.drop_table(_TABLE)

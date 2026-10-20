"""Monitoring loop and alerts (T75).

- `alerts` gains `title`, `dedupe_key` (unique per world: one alert per cause, so a re-run job
  never alerts twice), `report_id` (the re-rate that raised it) and `url` (a news source), plus
  `unique (world_id, id)` for the recipients' composite foreign key.
- `alert_recipients`: who an alert was delivered to (the asset's holders and its community's
  members when it was raised) and each one's read state (`read_at`).
- `monitor_runs`: a job's claim on one asset for one period (`rerate_all` per quarter,
  `news_sweep` per day); the primary key makes both jobs idempotent.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | Sequence[str] | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alerts", sa.Column("title", sa.String(), nullable=True))
    op.add_column("alerts", sa.Column("dedupe_key", sa.String(), nullable=True))
    op.add_column("alerts", sa.Column("report_id", sa.Uuid(), nullable=True))
    op.add_column("alerts", sa.Column("url", sa.String(), nullable=True))
    op.create_foreign_key("alerts_report_id_fkey", "alerts", "reports", ["report_id"], ["id"])
    op.create_unique_constraint("uq_alerts_world_id_id", "alerts", ["world_id", "id"])
    op.create_unique_constraint(
        "uq_alerts_world_id_dedupe_key", "alerts", ["world_id", "dedupe_key"]
    )

    op.create_table(
        "alert_recipients",
        sa.Column("alert_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "alert_id"],
            ["alerts.world_id", "alerts.id"],
            name="fk_alert_recipients_alert",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "user_id"],
            ["users.world_id", "users.id"],
            name="fk_alert_recipients_user",
        ),
        sa.PrimaryKeyConstraint("alert_id", "user_id"),
    )
    op.create_index(
        "ix_alert_recipients_world_id_user_id", "alert_recipients", ["world_id", "user_id"]
    )

    op.create_table(
        "monitor_runs",
        sa.Column("job", sa.String(), nullable=False),
        sa.Column("period", sa.String(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("detail", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_monitor_runs_asset",
        ),
        sa.CheckConstraint(
            "job IN ('rerate_all','news_sweep','payout')", name="ck_monitor_runs_job"
        ),
        sa.CheckConstraint(
            "status IN ('running','done','failed','skipped')", name="ck_monitor_runs_status"
        ),
        sa.PrimaryKeyConstraint("job", "period", "asset_id"),
    )
    op.create_index("ix_monitor_runs_world_id", "monitor_runs", ["world_id"])


def downgrade() -> None:
    op.drop_index("ix_monitor_runs_world_id", table_name="monitor_runs")
    op.drop_table("monitor_runs")
    op.drop_index("ix_alert_recipients_world_id_user_id", table_name="alert_recipients")
    op.drop_table("alert_recipients")
    op.drop_constraint("uq_alerts_world_id_dedupe_key", "alerts", type_="unique")
    op.drop_constraint("uq_alerts_world_id_id", "alerts", type_="unique")
    op.drop_constraint("alerts_report_id_fkey", "alerts", type_="foreignkey")
    op.drop_column("alerts", "url")
    op.drop_column("alerts", "report_id")
    op.drop_column("alerts", "dedupe_key")
    op.drop_column("alerts", "title")

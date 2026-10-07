"""Accounts and server-side sessions (ADR-0005 §1, §3; T54).

Adds `users.kind`, `email`, `password_hash` and `is_admin`, a unique `(world_id, id)` on users
for composite foreign keys, the per-world case-insensitive email index and the `sessions`
table. Every existing user is a seeded or copied persona, so the `kind` default backfills them.

Downgrading drops the sessions and every account's email, password hash, kind and admin flag;
upgrading again turns former `person` rows into credential-less personas, so nobody can sign in
as them. That data loss is accepted for the hackathon (T54 review).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("kind", sa.String(), server_default="persona", nullable=False),
    )
    op.add_column("users", sa.Column("email", sa.String(), nullable=True))
    op.add_column("users", sa.Column("password_hash", sa.String(), nullable=True))
    op.add_column(
        "users",
        sa.Column("is_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    # Explicit backfill, so the intent survives a later change of the column default.
    op.execute("UPDATE users SET kind = 'persona' WHERE persona_key IS NOT NULL")
    op.create_check_constraint("ck_users_kind", "users", "kind IN ('person','persona','treasury')")
    # Personas and treasuries can never hold credentials, so nobody can sign in as them.
    op.create_check_constraint(
        "ck_users_credentials_person_only",
        "users",
        "kind = 'person' OR (email IS NULL AND password_hash IS NULL)",
    )
    op.create_unique_constraint("uq_users_world_id_id", "users", ["world_id", "id"])
    op.create_index(
        "users_world_email",
        "users",
        ["world_id", sa.text("lower(email)")],
        unique=True,
        postgresql_where=sa.text("email IS NOT NULL"),
    )

    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("world_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["world_id", "user_id"], ["users.world_id", "users.id"], name="fk_sessions_user"
        ),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        sa.CheckConstraint("kind IN ('password','demo')", name="ck_sessions_kind"),
        sa.CheckConstraint("length(token_hash) = 64", name="ck_sessions_token_hash_len"),
    )
    op.create_index("ix_sessions_world_id_user_id", "sessions", ["world_id", "user_id"])
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_sessions_expires_at", table_name="sessions")
    op.drop_index("ix_sessions_world_id_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_index("users_world_email", table_name="users")
    op.drop_constraint("uq_users_world_id_id", "users", type_="unique")
    op.drop_constraint("ck_users_credentials_person_only", "users", type_="check")
    op.drop_constraint("ck_users_kind", "users", type_="check")
    op.drop_column("users", "is_admin")
    op.drop_column("users", "password_hash")
    op.drop_column("users", "email")
    op.drop_column("users", "kind")

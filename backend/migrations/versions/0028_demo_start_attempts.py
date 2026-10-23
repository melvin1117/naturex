"""No-sign-up demo sessions: `auth_attempts.kind` also accepts `demo_start`.

`POST /demo/start` counts each new demo sandbox against the caller's IP (one bucket, as login and
register do), so one client can't create sandboxes without limit; the hourly world cap
(`SANDBOX_MAX_NEW_WORLDS_PER_HOUR`) still bounds everyone together.

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-22
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0028"
down_revision: str | Sequence[str] | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_BEFORE = "'login','register','document_upload'"
_AFTER = f"{_BEFORE},'demo_start'"


def _replace_check(condition: str) -> None:
    op.drop_constraint("ck_auth_attempts_kind", "auth_attempts", type_="check")
    op.execute(
        f"ALTER TABLE auth_attempts ADD CONSTRAINT ck_auth_attempts_kind CHECK ({condition}) "
        "NOT VALID"
    )
    op.execute("ALTER TABLE auth_attempts VALIDATE CONSTRAINT ck_auth_attempts_kind")


def upgrade() -> None:
    _replace_check(f"kind IN ({_AFTER})")


def downgrade() -> None:
    op.execute("DELETE FROM auth_attempts WHERE kind = 'demo_start'")
    _replace_check(f"kind IN ({_BEFORE})")

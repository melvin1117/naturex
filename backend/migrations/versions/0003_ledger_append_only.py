"""Make ledger_entries append-only at the database level (dev-spec §5, §17).

UPDATE and TRUNCATE are always rejected. DELETE is rejected unless the transaction opts in
with `SET LOCAL naturex.allow_ledger_delete = 'on'`, which only the sandbox reset (T31) does
when it removes a whole demo world.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-04
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION ledger_entries_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE'
               AND current_setting('naturex.allow_ledger_delete', true) = 'on' THEN
                RETURN OLD;
            END IF;
            RAISE EXCEPTION 'ledger_entries is append-only: % is not allowed', TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only()
        """
    )
    op.execute(
        """
        CREATE TRIGGER ledger_entries_no_truncate
        BEFORE TRUNCATE ON ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_entries_append_only()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries")
    op.execute("DROP TRIGGER IF EXISTS ledger_entries_no_update_delete ON ledger_entries")
    op.execute("DROP FUNCTION IF EXISTS ledger_entries_append_only()")

"""The ledger-delete opt-in setting takes the product's name: `wildworth.allow_ledger_delete`.

Five trigger functions (from 0003, 0016 and 0022) read the old name, `naturex.allow_ledger_delete`,
which only the sandbox reset and prune switch on (`SET LOCAL`). Each one is rewritten from its
own current definition (`pg_get_functiondef`) with just the setting's name changed, so whatever
an earlier migration left in the function body stays as it is. The app sets the new name from
this release, so run `alembic upgrade head` before starting it: an old database would refuse the
reset's deletes (it fails closed, never open).

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-24
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0030"
down_revision: str | Sequence[str] | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD = "naturex.allow_ledger_delete"
_NEW = "wildworth.allow_ledger_delete"


def _rename(old: str, new: str) -> None:
    # Literals, not bind parameters: a DO block takes none. Both names are the constants above.
    op.execute(
        f"""
        DO $rename$
        DECLARE f oid;
        BEGIN
          FOR f IN
            SELECT p.oid FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema() AND p.prosrc LIKE '%{old}%'
          LOOP
            EXECUTE replace(pg_get_functiondef(f), '{old}', '{new}');
          END LOOP;
        END
        $rename$;
        """
    )


def upgrade() -> None:
    _rename(_OLD, _NEW)


def downgrade() -> None:
    _rename(_NEW, _OLD)

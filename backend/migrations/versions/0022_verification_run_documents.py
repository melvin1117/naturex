"""A verification run links its documents through a table, so a run can carry earlier ones (#210).

Before, `listing_documents.run_id` tied each document to ONE run, so a steward who added a
document while their run was waiting got a new run over the new document only, and the reviewer
saw only that. Now `verification_run_documents` links a run to each of its documents (composite
foreign keys keep both on the same asset and world): a new submission while a run is still
waiting links the waiting run's documents as well as the new ones, and the superseded run keeps
its own links, so history reads as it was.

- `verification_run_documents` is immutable (`verification_immutable()`: no UPDATE or DELETE
  without the whole-world delete opt-in, no TRUNCATE).
- `verification_run_documents_complete` now counts links: at commit every run has exactly
  `document_count` linked documents, so nothing can be linked to (or unlinked from) a run after
  the transaction that submitted it (ADR-0006 §6). The constraint trigger moves from
  `listing_documents` to the link table.
- `listing_documents.run_id` (with its foreign key and indexes) is dropped after its links are
  copied, and `listing_documents_write_once` no longer mentions it.
- `ix_verification_runs_decided` (#211): the decided listings' order, latest decision first
  (`coalesce(revoked_at, decided_at)`, then `id`), on current decided runs only.

Downgrading fails, naming the count, if any document is linked to more than one run (one
`run_id` can't hold it); otherwise it restores `run_id` from the links.

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0022"
down_revision: str | Sequence[str] | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LINKS = "verification_run_documents"
_DECIDED = "is_current AND level IN ('verified','rejected','revoked')"
_WORLD_DELETE = "current_setting('naturex.allow_ledger_delete', true) = 'on'"


def _documents_write_once(with_run_id: bool) -> str:
    run_rule = (
        "OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)"
        if with_run_id
        else ""
    )
    message = (
        "a listing document is write-once (run_id is set once)"
        if with_run_id
        else "a listing document is write-once"
    )
    return f"""
        CREATE OR REPLACE FUNCTION listing_documents_write_once() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF {_WORLD_DELETE} THEN
                    RETURN OLD;
                END IF;
                RAISE EXCEPTION 'listing_documents stay with their listing: no DELETE'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF NEW.id IS DISTINCT FROM OLD.id
               OR NEW.world_id IS DISTINCT FROM OLD.world_id
               OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
               OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
               OR NEW.media_type IS DISTINCT FROM OLD.media_type
               OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
               OR NEW.page_count IS DISTINCT FROM OLD.page_count
               OR NEW.width IS DISTINCT FROM OLD.width
               OR NEW.height IS DISTINCT FROM OLD.height
               OR NEW.has_preview IS DISTINCT FROM OLD.has_preview
               OR NEW.private_fingerprint IS DISTINCT FROM OLD.private_fingerprint
               OR NEW.commitment IS DISTINCT FROM OLD.commitment
               OR NEW.is_sample IS DISTINCT FROM OLD.is_sample
               OR NEW.created_at IS DISTINCT FROM OLD.created_at
               {run_rule}
               OR (NEW.commitment_nonce IS DISTINCT FROM OLD.commitment_nonce
                   AND NEW.commitment_nonce IS NOT NULL)
               OR (NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
                   AND NEW.uploaded_by IS NOT NULL) THEN
                RAISE EXCEPTION '{message}'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN NEW;
        END;
        $$
        """


def _complete(source: str) -> str:
    """The deferred completeness check, counting a run's documents in `source`."""
    count = (
        f"SELECT count(*) INTO linked FROM {_LINKS} l WHERE l.run_id = target;"
        if source == _LINKS
        else "SELECT count(*) INTO linked FROM listing_documents d WHERE d.run_id = target;"
    )
    return f"""
        CREATE OR REPLACE FUNCTION verification_run_documents_complete() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE
            target uuid;
            expected smallint;
            linked integer;
        BEGIN
            IF TG_TABLE_NAME = 'verification_runs' THEN
                target := NEW.id;
            ELSE
                target := NEW.run_id;
            END IF;
            IF target IS NULL THEN
                RETURN NULL;
            END IF;
            SELECT document_count INTO expected FROM verification_runs WHERE id = target;
            IF NOT FOUND THEN
                RETURN NULL;
            END IF;
            {count}
            IF linked <> expected THEN
                RAISE EXCEPTION 'verification run % has % documents, not %',
                    target, linked, expected
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NULL;
        END;
        $$
        """


def upgrade() -> None:
    op.create_table(
        _LINKS,
        sa.Column("run_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("document_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), sa.ForeignKey("worlds.id"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id", "run_id"],
            ["verification_runs.world_id", "verification_runs.asset_id", "verification_runs.id"],
            name="fk_verification_run_documents_run",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id", "document_id"],
            ["listing_documents.world_id", "listing_documents.asset_id", "listing_documents.id"],
            name="fk_verification_run_documents_document",
        ),
    )
    op.create_index(
        "ix_verification_run_documents_document",
        _LINKS,
        ["world_id", "asset_id", "document_id"],
    )
    op.execute(
        f"INSERT INTO {_LINKS} (run_id, document_id, world_id, asset_id) "
        "SELECT run_id, id, world_id, asset_id FROM listing_documents WHERE run_id IS NOT NULL"
    )
    op.execute(
        f"CREATE TRIGGER {_LINKS}_immutable BEFORE UPDATE OR DELETE "
        f"ON {_LINKS} FOR EACH ROW EXECUTE FUNCTION verification_immutable()"
    )
    op.execute(
        f"CREATE TRIGGER {_LINKS}_no_truncate BEFORE TRUNCATE ON {_LINKS} "
        "FOR EACH STATEMENT EXECUTE FUNCTION verification_immutable()"
    )
    op.execute("DROP TRIGGER listing_documents_run_complete ON listing_documents")
    op.execute(_complete(_LINKS))
    op.execute(
        f"CREATE CONSTRAINT TRIGGER {_LINKS}_complete "
        f"AFTER INSERT ON {_LINKS} DEFERRABLE INITIALLY DEFERRED "
        "FOR EACH ROW EXECUTE FUNCTION verification_run_documents_complete()"
    )
    op.execute(_documents_write_once(with_run_id=False))
    op.drop_index("ix_listing_documents_run_id", table_name="listing_documents")
    op.drop_index("ix_listing_documents_world_id_asset_id_run_id", table_name="listing_documents")
    op.drop_constraint("fk_listing_documents_run", "listing_documents", type_="foreignkey")
    op.drop_column("listing_documents", "run_id")
    op.create_index(
        "ix_verification_runs_decided",
        "verification_runs",
        ["world_id", sa.text("coalesce(revoked_at, decided_at) DESC"), "id"],
        postgresql_where=sa.text(_DECIDED),
    )


def downgrade() -> None:
    bind = op.get_bind()
    shared = bind.execute(
        sa.text(
            f"SELECT count(*) FROM (SELECT document_id FROM {_LINKS} "
            "GROUP BY document_id HAVING count(*) > 1) shared"
        )
    ).scalar_one()
    if shared:
        documents = "document is" if shared == 1 else "documents are"
        raise RuntimeError(
            f"{shared} {documents} linked to more than one verification run; "
            "listing_documents.run_id can hold only one"
        )
    op.drop_index("ix_verification_runs_decided", table_name="verification_runs")
    op.add_column("listing_documents", sa.Column("run_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_listing_documents_run",
        "listing_documents",
        "verification_runs",
        ["world_id", "asset_id", "run_id"],
        ["world_id", "asset_id", "id"],
    )
    op.create_index(
        "ix_listing_documents_world_id_asset_id_run_id",
        "listing_documents",
        ["world_id", "asset_id", "run_id"],
    )
    op.create_index(
        "ix_listing_documents_run_id",
        "listing_documents",
        ["run_id"],
        postgresql_where=sa.text("run_id IS NOT NULL"),
    )
    op.execute(_documents_write_once(with_run_id=True))
    op.execute(
        f"UPDATE listing_documents d SET run_id = l.run_id FROM {_LINKS} l "
        "WHERE l.document_id = d.id"
    )
    op.execute(_complete("listing_documents"))
    op.execute(
        "CREATE CONSTRAINT TRIGGER listing_documents_run_complete "
        "AFTER INSERT OR UPDATE OF run_id ON listing_documents DEFERRABLE INITIALLY DEFERRED "
        "FOR EACH ROW EXECUTE FUNCTION verification_run_documents_complete()"
    )
    op.drop_table(_LINKS)

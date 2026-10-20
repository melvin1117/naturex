"""Listing verification (T69, ADR-0006): write-once runs, private documents, the ledger kind.

- `verification_runs`: one row per run. `level` starts `documents_submitted`; the decision
  (verified | rejected) and a revocation (verified → revoked) are written once. One current
  run per asset (`uq_verification_runs_current`, partial unique). `mode` and `evidence_kind`
  exist for T76's demo mode; T69 writes `review` / `real` only.
- `document_fingerprints`: binds a document's private per-world fingerprint to one asset, so
  the same file can't back two listings (the same listing may upload it again). One binding per
  fingerprint is `active` (partial unique index); a binding to a withdrawn or ineligible listing
  may be retired so another listing of the same community can take the file.
- `listing_documents`: document metadata, linked once, at submission, to a run of its own asset
  (composite foreign key). `listing_document_blobs`: the bytes and the sanitised preview
  (`bytea`; no files on disk).
- `ledger_entries.kind` also accepts `verification`; `auth_attempts.kind` also accepts
  `document_upload` (the per-account upload rate limit).
- `assets.verification_revoked_at`: set by a revocation, cleared only by an admin's approval of
  a new run; while set, the asset can't resume trading or launch its IPO.
- `verification_runs.reason_salt`: a private random salt for the ledger's commitments to the
  reviewer's reasons.

Triggers:

- `verification_runs_write_once` rejects any change to a run's inputs (fingerprint, checklist,
  method version, mode, evidence kind, document count), any level move other than
  documents_submitted → verified | rejected or verified → revoked (current runs only), a
  rewrite of the decision or revocation once written, and `is_current` false → true. Account
  references may only be cleared (account deletion anonymises, K5).
- `listing_documents_write_once`: a document's content fields never change; `run_id` is set
  once; the nonce and uploader may only be cleared.
- `listing_document_blobs` never change; a `document_fingerprints` row may only be retired
  (`active` true → false).
- Rows of all four tables are deleted only with the whole-world delete opt-in the ledger
  already uses (`SET LOCAL naturex.allow_ledger_delete = 'on'`: sandbox reset and prune).
- `verification_run_documents_complete` (a deferred constraint trigger): at commit, every run
  has exactly `document_count` linked documents, so documents can't be linked to a run after
  the transaction that submitted it.

Downgrading fails, naming the count, if any `verification` ledger entry exists (the ledger is
append-only); otherwise it drops the tables, functions, triggers and columns, deletes
`document_upload` attempts and restores both kind checks.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0016"
down_revision: str | Sequence[str] | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KINDS_BEFORE = "'listing','report','event','price_anchor','payout'"
_KINDS_AFTER = f"{_KINDS_BEFORE},'verification'"
_ATTEMPTS_BEFORE = "'login','register'"
_ATTEMPTS_AFTER = f"{_ATTEMPTS_BEFORE},'document_upload'"
_LEVELS = "'unverified','documents_submitted','verified','rejected','revoked'"
_DOC_TYPES = "'title','agrarian_certificate','assembly_minutes','entity_registration','other'"
_MEDIA_TYPES = "'application/pdf','image/jpeg','image/png'"
_MAX_BYTES = 5 * 1024 * 1024
_WORLD_DELETE = "current_setting('naturex.allow_ledger_delete', true) = 'on'"


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID")
    op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")


def _user_fk(table: str, column: str, name: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(["world_id", column], ["users.world_id", "users.id"], name=name)


def upgrade() -> None:
    op.add_column(
        "assets", sa.Column("verification_revoked_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "verification_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), sa.ForeignKey("worlds.id"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("level", sa.String(), nullable=False),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("input_fingerprint", sa.String(64), nullable=False),
        sa.Column("checklist", JSONB(), nullable=False),
        sa.Column("method_version", sa.String(), nullable=False),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("evidence_kind", sa.String(), nullable=False),
        sa.Column("document_count", sa.SmallInteger(), nullable=False),
        sa.Column("reason_salt", sa.LargeBinary(), nullable=True),
        sa.Column("submitted_by", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("reviewer_role", sa.String(), nullable=True),
        sa.Column("reviewer_user_id", UUID(as_uuid=True), nullable=True),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by", UUID(as_uuid=True), nullable=True),
        sa.Column("revoke_reason", sa.String(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "world_id", "asset_id", "id", name="uq_verification_runs_world_asset_id"
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_verification_runs_asset",
        ),
        _user_fk("verification_runs", "submitted_by", "fk_verification_runs_submitted_by"),
        _user_fk("verification_runs", "reviewer_user_id", "fk_verification_runs_reviewer"),
        _user_fk("verification_runs", "revoked_by", "fk_verification_runs_revoked_by"),
        sa.CheckConstraint(f"level IN ({_LEVELS})", name="ck_verification_runs_level"),
        sa.CheckConstraint("mode IN ('review','demo')", name="ck_verification_runs_mode"),
        sa.CheckConstraint(
            "evidence_kind IN ('real','sample')", name="ck_verification_runs_evidence_kind"
        ),
        sa.CheckConstraint(
            "reviewer_role IS NULL OR reviewer_role IN ('platform_admin','partner_reviewer')",
            name="ck_verification_runs_reviewer_role",
        ),
        sa.CheckConstraint(
            "document_count BETWEEN 1 AND 3", name="ck_verification_runs_document_count"
        ),
        sa.CheckConstraint(
            "reason_salt IS NULL OR octet_length(reason_salt) = 32",
            name="ck_verification_runs_reason_salt",
        ),
        sa.CheckConstraint(
            "input_fingerprint ~ '^[0-9a-f]{64}$'", name="ck_verification_runs_fingerprint"
        ),
        sa.CheckConstraint(
            "jsonb_typeof(checklist) = 'array'", name="ck_verification_runs_checklist"
        ),
        # A decided run names its reviewer role and time; a rejection has a reason.
        sa.CheckConstraint(
            "(level IN ('documents_submitted','unverified')) = (decided_at IS NULL) "
            "AND (decided_at IS NULL) = (reviewer_role IS NULL) "
            "AND (level <> 'rejected' OR reason IS NOT NULL)",
            name="ck_verification_runs_decision",
        ),
        # Revoked exactly when the revocation is written, with its reason.
        sa.CheckConstraint(
            "(level = 'revoked') = (revoked_at IS NOT NULL) "
            "AND (revoked_at IS NULL) = (revoke_reason IS NULL)",
            name="ck_verification_runs_revocation",
        ),
    )
    op.create_index(
        "uq_verification_runs_current",
        "verification_runs",
        ["world_id", "asset_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )
    op.create_index(
        "ix_verification_runs_queue",
        "verification_runs",
        ["world_id", "created_at"],
        postgresql_where=sa.text("is_current AND level = 'documents_submitted'"),
    )

    op.create_table(
        "document_fingerprints",
        sa.Column("world_id", UUID(as_uuid=True), sa.ForeignKey("worlds.id"), primary_key=True),
        sa.Column("private_fingerprint", sa.String(64), primary_key=True),
        sa.Column("asset_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_document_fingerprints_asset",
        ),
    )
    op.create_index(
        "uq_document_fingerprints_active",
        "document_fingerprints",
        ["world_id", "private_fingerprint"],
        unique=True,
        postgresql_where=sa.text("active"),
    )
    op.create_index(
        "ix_document_fingerprints_world_id_asset_id",
        "document_fingerprints",
        ["world_id", "asset_id"],
    )

    op.create_table(
        "listing_documents",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), sa.ForeignKey("worlds.id"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", UUID(as_uuid=True), nullable=True),
        sa.Column("doc_type", sa.String(), nullable=False),
        sa.Column("media_type", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("has_preview", sa.Boolean(), nullable=False),
        sa.Column("private_fingerprint", sa.String(64), nullable=False),
        sa.Column("commitment", sa.String(64), nullable=False),
        sa.Column("commitment_nonce", sa.LargeBinary(), nullable=True),
        sa.Column("is_sample", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("uploaded_by", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "world_id", "asset_id", "id", name="uq_listing_documents_world_asset_id"
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_listing_documents_asset",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id", "run_id"],
            ["verification_runs.world_id", "verification_runs.asset_id", "verification_runs.id"],
            name="fk_listing_documents_run",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "private_fingerprint", "asset_id"],
            [
                "document_fingerprints.world_id",
                "document_fingerprints.private_fingerprint",
                "document_fingerprints.asset_id",
            ],
            name="fk_listing_documents_fingerprint",
        ),
        _user_fk("listing_documents", "uploaded_by", "fk_listing_documents_uploaded_by"),
        sa.CheckConstraint(f"doc_type IN ({_DOC_TYPES})", name="ck_listing_documents_doc_type"),
        sa.CheckConstraint(
            f"media_type IN ({_MEDIA_TYPES})", name="ck_listing_documents_media_type"
        ),
        sa.CheckConstraint(
            f"size_bytes BETWEEN 1 AND {_MAX_BYTES}", name="ck_listing_documents_size"
        ),
        sa.CheckConstraint(
            "commitment ~ '^[0-9a-f]{64}$' AND private_fingerprint ~ '^[0-9a-f]{64}$'",
            name="ck_listing_documents_hashes",
        ),
        sa.CheckConstraint(
            "commitment_nonce IS NULL OR octet_length(commitment_nonce) = 32",
            name="ck_listing_documents_nonce",
        ),
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

    op.create_table(
        "listing_document_blobs",
        sa.Column("document_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("preview_png", sa.LargeBinary(), nullable=True),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id", "document_id"],
            ["listing_documents.world_id", "listing_documents.asset_id", "listing_documents.id"],
            name="fk_listing_document_blobs_document",
        ),
        sa.CheckConstraint(
            f"octet_length(content) BETWEEN 1 AND {_MAX_BYTES}",
            name="ck_listing_document_blobs_size",
        ),
    )
    op.create_index("ix_listing_document_blobs_world_id", "listing_document_blobs", ["world_id"])

    op.execute(
        f"""
        CREATE FUNCTION verification_runs_write_once() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF {_WORLD_DELETE} THEN
                    RETURN OLD;
                END IF;
                RAISE EXCEPTION 'verification_runs are write-once: DELETE is not allowed'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF TG_OP = 'INSERT' THEN
                IF NEW.level <> 'documents_submitted' OR NOT NEW.is_current
                   OR NEW.revoked_by IS NOT NULL OR NEW.reviewer_user_id IS NOT NULL THEN
                    RAISE EXCEPTION 'a verification run starts current and documents_submitted'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END IF;
            IF NEW.id IS DISTINCT FROM OLD.id
               OR NEW.world_id IS DISTINCT FROM OLD.world_id
               OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
               OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
               OR NEW.checklist IS DISTINCT FROM OLD.checklist
               OR NEW.method_version IS DISTINCT FROM OLD.method_version
               OR NEW.mode IS DISTINCT FROM OLD.mode
               OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
               OR NEW.document_count IS DISTINCT FROM OLD.document_count
               OR NEW.created_at IS DISTINCT FROM OLD.created_at
               OR (NEW.reason_salt IS DISTINCT FROM OLD.reason_salt
                   AND NEW.reason_salt IS NOT NULL) THEN
                RAISE EXCEPTION 'a verification run''s inputs are write-once'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            -- Account references: set once, or cleared (anonymised); never repointed.
            IF (NEW.submitted_by IS DISTINCT FROM OLD.submitted_by AND NEW.submitted_by IS NOT NULL)
               OR (NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id
                   AND NEW.reviewer_user_id IS NOT NULL AND OLD.reviewer_user_id IS NOT NULL)
               OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
                   AND NEW.revoked_by IS NOT NULL AND OLD.revoked_by IS NOT NULL) THEN
                RAISE EXCEPTION 'a verification run''s accounts can only be cleared'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF NEW.is_current AND NOT OLD.is_current THEN
                RAISE EXCEPTION 'a superseded verification run never becomes current again'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF OLD.decided_at IS NOT NULL AND (
                   NEW.decided_at IS DISTINCT FROM OLD.decided_at
                   OR NEW.reviewer_role IS DISTINCT FROM OLD.reviewer_role
                   OR NEW.reason IS DISTINCT FROM OLD.reason) THEN
                RAISE EXCEPTION 'a verification decision is written once'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF OLD.revoked_at IS NOT NULL AND (
                   NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
                   OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
                RAISE EXCEPTION 'a verification revocation is written once'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF NEW.level IS DISTINCT FROM OLD.level THEN
                IF NOT OLD.is_current OR NOT (
                       (OLD.level = 'documents_submitted' AND NEW.level IN ('verified','rejected'))
                       OR (OLD.level = 'verified' AND NEW.level = 'revoked')) THEN
                    RAISE EXCEPTION 'verification level % → % is not allowed', OLD.level, NEW.level
                        USING ERRCODE = 'insufficient_privilege';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER verification_runs_write_once BEFORE INSERT OR UPDATE OR DELETE "
        "ON verification_runs FOR EACH ROW EXECUTE FUNCTION verification_runs_write_once()"
    )

    op.execute(
        f"""
        CREATE FUNCTION listing_documents_write_once() RETURNS trigger
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
               OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
               OR (NEW.commitment_nonce IS DISTINCT FROM OLD.commitment_nonce
                   AND NEW.commitment_nonce IS NOT NULL)
               OR (NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
                   AND NEW.uploaded_by IS NOT NULL) THEN
                RAISE EXCEPTION 'a listing document is write-once (run_id is set once)'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER listing_documents_write_once BEFORE UPDATE OR DELETE "
        "ON listing_documents FOR EACH ROW EXECUTE FUNCTION listing_documents_write_once()"
    )

    op.execute(
        f"""
        CREATE FUNCTION verification_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' AND {_WORLD_DELETE} THEN
                RETURN OLD;
            END IF;
            RAISE EXCEPTION '% is immutable: % is not allowed', TG_TABLE_NAME, TG_OP
                USING ERRCODE = 'insufficient_privilege';
        END;
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER listing_document_blobs_immutable BEFORE UPDATE OR DELETE "
        "ON listing_document_blobs FOR EACH ROW EXECUTE FUNCTION verification_immutable()"
    )
    op.execute(
        f"""
        CREATE FUNCTION document_fingerprints_retire_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF {_WORLD_DELETE} THEN
                    RETURN OLD;
                END IF;
                RAISE EXCEPTION 'document_fingerprints is immutable: DELETE is not allowed'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF NEW.world_id IS DISTINCT FROM OLD.world_id
               OR NEW.private_fingerprint IS DISTINCT FROM OLD.private_fingerprint
               OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
               OR (NEW.active AND NOT OLD.active) THEN
                RAISE EXCEPTION 'document_fingerprints is immutable: a binding may only be retired'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER document_fingerprints_immutable BEFORE UPDATE OR DELETE "
        "ON document_fingerprints FOR EACH ROW EXECUTE FUNCTION document_fingerprints_retire_only()"
    )
    for table in (
        "verification_runs",
        "listing_documents",
        "listing_document_blobs",
        "document_fingerprints",
    ):
        op.execute(
            f"CREATE TRIGGER {table}_no_truncate BEFORE TRUNCATE ON {table} "
            "FOR EACH STATEMENT EXECUTE FUNCTION verification_immutable()"
        )

    op.execute(
        """
        CREATE FUNCTION verification_run_documents_complete() RETURNS trigger
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
            SELECT count(*) INTO linked FROM listing_documents d WHERE d.run_id = target;
            IF linked <> expected THEN
                RAISE EXCEPTION 'verification run % has % documents, not %',
                    target, linked, expected
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NULL;
        END;
        $$
        """
    )
    op.execute(
        "CREATE CONSTRAINT TRIGGER verification_runs_documents_complete "
        "AFTER INSERT ON verification_runs DEFERRABLE INITIALLY DEFERRED "
        "FOR EACH ROW EXECUTE FUNCTION verification_run_documents_complete()"
    )
    op.execute(
        "CREATE CONSTRAINT TRIGGER listing_documents_run_complete "
        "AFTER INSERT OR UPDATE OF run_id ON listing_documents DEFERRABLE INITIALLY DEFERRED "
        "FOR EACH ROW EXECUTE FUNCTION verification_run_documents_complete()"
    )

    _replace_check("ledger_entries", "ck_ledger_kind", f"kind IN ({_KINDS_AFTER})")
    _replace_check("auth_attempts", "ck_auth_attempts_kind", f"kind IN ({_ATTEMPTS_AFTER})")


def downgrade() -> None:
    bind = op.get_bind()
    entries = bind.execute(
        sa.text("SELECT count(*) FROM ledger_entries WHERE kind = 'verification'")
    ).scalar_one()
    if entries:
        raise RuntimeError(
            f"{entries} verification ledger entries exist; the ledger is append-only"
        )
    _replace_check("ledger_entries", "ck_ledger_kind", f"kind IN ({_KINDS_BEFORE})")
    op.execute("DELETE FROM auth_attempts WHERE kind = 'document_upload'")
    _replace_check("auth_attempts", "ck_auth_attempts_kind", f"kind IN ({_ATTEMPTS_BEFORE})")
    op.drop_table("listing_document_blobs")
    op.drop_table("listing_documents")
    op.drop_table("document_fingerprints")
    op.drop_table("verification_runs")
    for function in (
        "verification_run_documents_complete",
        "verification_immutable",
        "document_fingerprints_retire_only",
        "listing_documents_write_once",
        "verification_runs_write_once",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {function}()")
    op.drop_column("assets", "verification_revoked_at")

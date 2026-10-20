"""Copilot RAG chunks (T39): `doc_chunks` holds report and news-event pieces with their vectors.

- `source_kind` (`report` | `event`) and `event_id`: a chunk belongs to exactly one report or
  one event (`ck_doc_chunks_one_source`); `seq` orders a source's pieces, unique per source.
- `content_sha256` + `embed_model`: the indexer is idempotent (a source whose pieces' hashes
  and model are unchanged is skipped) and reuses a vector already computed for the same text
  and model in any world, so sandbox copies cost no embedding calls.
- No ANN (HNSW/IVFFlat) index on purpose: every query is filtered to one world and the caller's
  visible assets first (`ix_doc_chunks_world_id`), leaving tens to hundreds of rows to rank
  exactly. A post-filtered ANN scan could return fewer rows than asked for.

Nothing wrote `doc_chunks` before this revision; any rows are dropped, since they have no
source kind, hash or model and the indexer rebuilds them on demand.

Revision ID: 0018
Revises: 0016
Create Date: 2026-10-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | Sequence[str] | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DELETE FROM doc_chunks")
    op.add_column("doc_chunks", sa.Column("source_kind", sa.String(), nullable=False))
    op.add_column("doc_chunks", sa.Column("event_id", sa.Uuid(), nullable=True))
    op.add_column("doc_chunks", sa.Column("seq", sa.Integer(), nullable=False, server_default="0"))
    op.alter_column("doc_chunks", "seq", server_default=None)
    op.add_column("doc_chunks", sa.Column("content_sha256", sa.String(length=64), nullable=False))
    op.add_column("doc_chunks", sa.Column("embed_model", sa.String(), nullable=False))
    op.add_column(
        "doc_chunks",
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_foreign_key("doc_chunks_event_id_fkey", "doc_chunks", "events", ["event_id"], ["id"])
    op.create_check_constraint(
        "ck_doc_chunks_source_kind", "doc_chunks", "source_kind IN ('report', 'event')"
    )
    op.create_check_constraint(
        "ck_doc_chunks_one_source",
        "doc_chunks",
        "(source_kind = 'report' AND report_id IS NOT NULL AND event_id IS NULL)"
        " OR (source_kind = 'event' AND event_id IS NOT NULL AND report_id IS NULL)",
    )
    op.create_index(
        "uq_doc_chunks_report_seq",
        "doc_chunks",
        ["report_id", "seq"],
        unique=True,
        postgresql_where=sa.text("report_id IS NOT NULL"),
    )
    op.create_index(
        "uq_doc_chunks_event_seq",
        "doc_chunks",
        ["event_id", "seq"],
        unique=True,
        postgresql_where=sa.text("event_id IS NOT NULL"),
    )
    op.create_index("ix_doc_chunks_content_sha256", "doc_chunks", ["content_sha256", "embed_model"])


def downgrade() -> None:
    op.execute("DELETE FROM doc_chunks")
    op.drop_index("ix_doc_chunks_content_sha256", table_name="doc_chunks")
    op.drop_index("uq_doc_chunks_event_seq", table_name="doc_chunks")
    op.drop_index("uq_doc_chunks_report_seq", table_name="doc_chunks")
    op.drop_constraint("ck_doc_chunks_one_source", "doc_chunks", type_="check")
    op.drop_constraint("ck_doc_chunks_source_kind", "doc_chunks", type_="check")
    op.drop_constraint("doc_chunks_event_id_fkey", "doc_chunks", type_="foreignkey")
    for column in ("created_at", "embed_model", "content_sha256", "seq", "event_id", "source_kind"):
        op.drop_column("doc_chunks", column)

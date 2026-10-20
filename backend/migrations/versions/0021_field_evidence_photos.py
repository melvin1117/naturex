"""Field evidence photos (T40, dev-spec §7.6): `field_evidence_photos` and their blobs.

- `field_evidence_photos`: one steward photo per row with its deterministic checks (EXIF GPS
  inside the listing or how far outside, the date taken), the perception model's validated
  labels and, once validated by code's rules, its evidence event. The EXIF position and the
  original file are never stored. Composite `(world_id, asset_id)` and `(world_id, uploaded_by)`
  foreign keys keep it in its world (ADR-0005); the same file is accepted once per listing.
- `field_evidence_photo_blobs`: the re-encoded JPEG (no metadata), deleted with its photo.

Revision ID: 0021
Revises: 0019
Create Date: 2026-10-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0021"
down_revision: str | Sequence[str] | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PHOTOS = "field_evidence_photos"
_BLOBS = "field_evidence_photo_blobs"


def upgrade() -> None:
    op.create_table(
        _PHOTOS,
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), sa.ForeignKey("worlds.id"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("uploaded_by", UUID(as_uuid=True), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("gps_check", sa.String(), nullable=False),
        sa.Column("gps_distance_m", sa.Integer(), nullable=True),
        sa.Column("date_check", sa.String(), nullable=False),
        sa.Column("taken_on", sa.Date(), nullable=True),
        sa.Column("analysis_status", sa.String(), nullable=False),
        sa.Column("observation", JSONB(), nullable=True),
        sa.Column("reasons", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("validated", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("event_id", UUID(as_uuid=True), sa.ForeignKey("events.id"), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("method_version", sa.String(), nullable=False),
        sa.Column("analysed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint(
            "world_id", "asset_id", "id", name="uq_field_evidence_photos_world_asset_id"
        ),
        sa.UniqueConstraint(
            "world_id", "asset_id", "sha256", name="uq_field_evidence_photos_sha256"
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id"],
            ["assets.world_id", "assets.id"],
            name="fk_field_evidence_photos_asset",
        ),
        sa.ForeignKeyConstraint(
            ["world_id", "uploaded_by"],
            ["users.world_id", "users.id"],
            name="fk_field_evidence_photos_uploaded_by",
        ),
        sa.CheckConstraint(
            "gps_check IN ('inside','near','outside','missing')",
            name="ck_field_evidence_photos_gps_check",
        ),
        sa.CheckConstraint(
            "date_check IN ('ok','missing','future','too_old')",
            name="ck_field_evidence_photos_date_check",
        ),
        sa.CheckConstraint(
            "analysis_status IN ('pending','completed','failed','not_run')",
            name="ck_field_evidence_photos_analysis_status",
        ),
        sa.CheckConstraint(
            "NOT validated OR (analysis_status = 'completed' AND gps_check IN ('inside','near')"
            " AND date_check = 'ok' AND event_id IS NOT NULL)",
            name="ck_field_evidence_photos_validated",
        ),
    )
    op.create_index("ix_field_evidence_photos_world_id_asset_id", _PHOTOS, ["world_id", "asset_id"])
    op.create_table(
        _BLOBS,
        sa.Column("photo_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("world_id", UUID(as_uuid=True), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(
            ["world_id", "asset_id", "photo_id"],
            [f"{_PHOTOS}.world_id", f"{_PHOTOS}.asset_id", f"{_PHOTOS}.id"],
            name="fk_field_evidence_photo_blobs_photo",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_field_evidence_photo_blobs_world_id", _BLOBS, ["world_id"])


def downgrade() -> None:
    op.drop_table(_BLOBS)
    op.drop_table(_PHOTOS)

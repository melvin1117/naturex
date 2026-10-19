"""Listing lifecycle (T58): status reasons, attestation, submission, bounding boxes, a terminal
`withdrawn` status, and scoped live events.

- `assets.status_reason` (nullable, ≤ 200 characters): a stable code explaining the status, e.g.
  the listing gate's failure codes for `needs_evidence` / `ineligible`, a suspension reason, or
  `no_satellite_metrics` while a new polygon waits for live Earth observation data (T60).
- `assets.attested_at` (nullable TIMESTAMPTZ): when the community attested, on creating the
  draft, that it may list this land. Curated (seeded) sites predate attestation and keep NULL.
- `assets.submitted_at` (nullable TIMESTAMPTZ): the last submit, for the resubmit cooldown.
- `assets.bbox_west/south/east/north` (nullable double precision): the polygon's bounding box,
  so the overlap check only parses nearby listings. Backfilled here from `geojson`; NULL means
  "unknown" and is always checked.
- `assets.status` also accepts `withdrawn` (terminal; the community withdrew the listing).
- `world_events.audience_community_id` (nullable UUID): NULL events are public to the world;
  otherwise only that community's members and same-world admins receive them (listings under
  review). The nil UUID means admins only.
- `world_events.type` also accepts `listing_status`.

Both CHECK constraints are re-created `NOT VALID` and then validated, so the table scan doesn't
hold the strong lock that adding a constraint takes.

Downgrading fails, naming the count, if any listing is `withdrawn`; it deletes `listing_status`
events (they are pruned after 24 h anyway), restores both checks and drops the columns.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-18
"""

import json
from collections.abc import Iterator, Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EVENT_TYPES_BEFORE = "'rating_progress','price_tick','alert','heartbeat'"
_EVENT_TYPES_AFTER = f"{_EVENT_TYPES_BEFORE},'listing_status'"
_STATUSES_BEFORE = "'draft','rating','needs_evidence','ineligible','listed','suspended'"
_STATUSES_AFTER = f"{_STATUSES_BEFORE},'withdrawn'"
_BBOX = ("bbox_west", "bbox_south", "bbox_east", "bbox_north")


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID")
    op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")


def _positions(coordinates: Any) -> Iterator[tuple[float, float]]:
    stack = [coordinates]
    while stack:
        item = stack.pop()
        if isinstance(item, list) and item and isinstance(item[0], int | float):
            yield float(item[0]), float(item[1])
        elif isinstance(item, list):
            stack.extend(item)


def _bbox(geojson: Any) -> tuple[float, float, float, float] | None:
    if isinstance(geojson, str):
        geojson = json.loads(geojson)
    if not isinstance(geojson, dict):
        return None
    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    if not isinstance(geometry, dict):
        return None
    points = list(_positions(geometry.get("coordinates")))
    if not points:
        return None
    lons, lats = zip(*points, strict=True)
    return min(lons), min(lats), max(lons), max(lats)


def upgrade() -> None:
    op.add_column("assets", sa.Column("status_reason", sa.String(length=200), nullable=True))
    op.add_column("assets", sa.Column("attested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("assets", sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True))
    for column in _BBOX:
        op.add_column("assets", sa.Column(column, sa.Float(), nullable=True))
    op.add_column(
        "world_events", sa.Column("audience_community_id", UUID(as_uuid=True), nullable=True)
    )
    _replace_check("assets", "ck_assets_status", f"status IN ({_STATUSES_AFTER})")
    _replace_check("world_events", "ck_world_events_type", f"type IN ({_EVENT_TYPES_AFTER})")

    bind = op.get_bind()
    for asset_id, geojson in bind.execute(sa.text("SELECT id, geojson FROM assets")).all():
        box = _bbox(geojson)
        if box is not None:
            bind.execute(
                sa.text(
                    "UPDATE assets SET bbox_west = :w, bbox_south = :s, bbox_east = :e, "
                    "bbox_north = :n WHERE id = :id"
                ),
                {"w": box[0], "s": box[1], "e": box[2], "n": box[3], "id": asset_id},
            )


def downgrade() -> None:
    withdrawn = (
        op.get_bind()
        .execute(sa.text("SELECT count(*) FROM assets WHERE status = 'withdrawn'"))
        .scalar_one()
    )
    if withdrawn:
        raise RuntimeError(f"{withdrawn} listings are withdrawn; that status has no older form")
    op.execute("DELETE FROM world_events WHERE type = 'listing_status'")
    _replace_check("world_events", "ck_world_events_type", f"type IN ({_EVENT_TYPES_BEFORE})")
    _replace_check("assets", "ck_assets_status", f"status IN ({_STATUSES_BEFORE})")
    op.drop_column("world_events", "audience_community_id")
    for column in reversed(_BBOX):
        op.drop_column("assets", column)
    op.drop_column("assets", "submitted_at")
    op.drop_column("assets", "attested_at")
    op.drop_column("assets", "status_reason")

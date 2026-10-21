"""Thumbnail outlines (#212): `assets.outline`, the boundary simplified for card and hero maps.

- `assets.outline` (nullable JSONB): each part's exterior ring, [lon, lat] rounded to ~1 m,
  simplified to at most 64 corners in all; written with the area (`_set_area`), so cards never
  simplify a boundary per request. Backfilled here for listings (not curated sites, which have
  precomputed thumbnails and keep NULL). The backfill's simplification is frozen here, not
  imported from the app.

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-21
"""

import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from shapely.geometry import MultiPolygon, Polygon, box, shape
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0022"
down_revision: str | Sequence[str] | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_MAX_POINTS = 64
_TOLERANCES = (0.0, 0.00001, 0.00003, 0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1)


def _outline(geojson: Any) -> list[list[list[float]]]:
    if isinstance(geojson, str):
        geojson = json.loads(geojson)
    if not isinstance(geojson, dict):
        return []
    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    try:
        area = shape(geometry)
    except Exception:  # noqa: BLE001 - an unreadable area has no outline
        return []
    if isinstance(area, MultiPolygon):
        parts = list(area.geoms)
    elif isinstance(area, Polygon):
        parts = [area]
    else:
        return []
    if not parts or any(part.is_empty for part in parts):
        return []

    def simplified(part: Polygon, tolerance: float) -> Polygon:
        out = part.simplify(tolerance, preserve_topology=True)
        return out if isinstance(out, Polygon) and not out.is_empty else part

    rings: list[list[tuple[float, ...]]] = []
    for tolerance in _TOLERANCES:
        rings = [list(simplified(part, tolerance).exterior.coords) for part in parts]
        if sum(len(ring) for ring in rings) <= _MAX_POINTS:
            break
    else:
        largest = sorted(parts, key=lambda part: part.area, reverse=True)
        rings = [list(box(*part.bounds).exterior.coords) for part in largest[: _MAX_POINTS // 5]]
    return [[[round(float(x), 5), round(float(y), 5)] for x, y, *_ in ring] for ring in rings]


def upgrade() -> None:
    op.add_column("assets", sa.Column("outline", JSONB(), nullable=True))
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, geojson FROM assets WHERE site_key IS NULL")).all()
    for asset_id, geojson in rows:
        bind.execute(
            sa.text("UPDATE assets SET outline = CAST(:outline AS jsonb) WHERE id = :id"),
            {"outline": json.dumps(_outline(geojson)), "id": asset_id},
        )


def downgrade() -> None:
    op.drop_column("assets", "outline")

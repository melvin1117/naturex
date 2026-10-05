"""Validate a listing polygon (pm-spec A1): shape, size and overlap with existing listings.

Pure functions over GeoJSON (WGS84 lon/lat). Areas are computed in a Lambert azimuthal
equal-area projection centred on the polygon, so hectares stay accurate at any latitude
(Web Mercator would inflate them). Polygons crossing the antimeridian aren't supported.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from pyproj import CRS, Transformer
from shapely import make_valid
from shapely.errors import GEOSException
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform
from shapely.validation import explain_validity

MIN_AREA_HA = 10
MAX_AREA_HA = 50_000
# Shared borders drawn by hand rarely line up exactly; ignore overlaps smaller than this.
OVERLAP_TOLERANCE_HA = 1
M2_PER_HA = 10_000

ProblemCode = Literal["invalid_geojson", "self_intersection", "too_small", "too_large", "overlap"]
Area = Polygon | MultiPolygon


@dataclass(frozen=True, slots=True)
class Problem:
    code: ProblemCode
    message: str


@dataclass(frozen=True, slots=True)
class PolygonCheck:
    problems: list[Problem]
    area_ha: float | None = None
    """None when the geometry can't be measured (malformed or self-intersecting)."""
    centroid_lat: float | None = None
    centroid_lon: float | None = None
    overlaps: list[UUID] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


class _InvalidGeoJSON(ValueError):
    pass


def _parse(geojson: Mapping[str, Any]) -> Area:
    """GeoJSON Polygon / MultiPolygon, or a Feature wrapping one, as a shapely geometry."""
    if geojson.get("type") == "Feature":
        geometry = geojson.get("geometry")
        if not isinstance(geometry, Mapping):
            raise _InvalidGeoJSON("The feature has no geometry.")
        geojson = geometry
    if geojson.get("type") not in ("Polygon", "MultiPolygon"):
        raise _InvalidGeoJSON("Draw an area (a GeoJSON Polygon or MultiPolygon).")
    try:
        geom = shape(dict(geojson))
    except (GEOSException, ValueError, TypeError, IndexError, AttributeError) as exc:
        raise _InvalidGeoJSON(f"The shape couldn't be read: {exc}") from exc
    if not isinstance(geom, Polygon | MultiPolygon) or geom.is_empty:
        raise _InvalidGeoJSON("The shape is empty.")
    min_lon, min_lat, max_lon, max_lat = geom.bounds
    if not (-180 <= min_lon <= max_lon <= 180 and -90 <= min_lat <= max_lat <= 90):
        raise _InvalidGeoJSON("Coordinates must be longitude/latitude in degrees (WGS84).")
    return geom


def _area_ha(geom: BaseGeometry, centre: tuple[float, float]) -> float:
    lon, lat = centre
    laea = CRS.from_proj4(f"+proj=laea +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m")
    to_laea = Transformer.from_crs("EPSG:4326", laea, always_xy=True)
    return float(transform(to_laea.transform, geom).area) / M2_PER_HA


def validate_polygon(
    geojson: Mapping[str, Any],
    existing: Sequence[tuple[UUID, Mapping[str, Any]]] = (),
) -> PolygonCheck:
    """Check a drawn listing area; report every problem at once so the UI can show them all.

    `existing` holds (asset_id, geojson) for listings it must not overlap. Unreadable
    existing geometries are skipped: one bad stored row shouldn't block every new listing.
    """
    try:
        geom = _parse(geojson)
    except _InvalidGeoJSON as exc:
        return PolygonCheck(problems=[Problem("invalid_geojson", str(exc))])
    if not geom.is_valid:
        reason = explain_validity(geom)
        return PolygonCheck(
            problems=[
                Problem(
                    "self_intersection",
                    f"The boundary crosses itself or is malformed ({reason}). Redraw it.",
                )
            ]
        )

    centroid = geom.centroid
    centre = (float(centroid.x), float(centroid.y))
    area = _area_ha(geom, centre)
    problems: list[Problem] = []
    if area < MIN_AREA_HA:
        problems.append(
            Problem("too_small", f"The area is {area:,.1f} ha; the minimum is {MIN_AREA_HA} ha.")
        )
    elif area > MAX_AREA_HA:
        problems.append(
            Problem("too_large", f"The area is {area:,.0f} ha; the maximum is {MAX_AREA_HA:,} ha.")
        )

    overlaps: list[UUID] = []
    for asset_id, other_geojson in existing:
        try:
            other: BaseGeometry = _parse(other_geojson)
        except _InvalidGeoJSON:
            continue
        if not other.is_valid:
            other = make_valid(other)
        if geom.intersects(other) and (
            _area_ha(geom.intersection(other), centre) > OVERLAP_TOLERANCE_HA
        ):
            overlaps.append(asset_id)
    if overlaps:
        problems.append(
            Problem("overlap", "This area overlaps land that is already listed. Redraw around it.")
        )

    return PolygonCheck(
        problems=problems,
        area_ha=area,
        centroid_lat=centre[1],
        centroid_lon=centre[0],
        overlaps=overlaps,
    )

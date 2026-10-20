"""Validate a listing polygon (pm-spec A1): shape, size and overlap with existing listings.

Pure functions over GeoJSON (WGS84 lon/lat). Areas are computed in a Lambert azimuthal
equal-area projection centred on the polygon, so hectares stay accurate at any latitude
(Web Mercator would inflate them). Polygons crossing the antimeridian aren't supported.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from pyproj import CRS, Transformer
from shapely import make_valid
from shapely.errors import GEOSException
from shapely.geometry import MultiPolygon, Point, Polygon, box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import transform
from shapely.validation import explain_validity

MIN_AREA_HA = 10
MAX_AREA_HA = 50_000
# Shared borders drawn by hand rarely line up exactly; ignore overlaps smaller than this.
OVERLAP_TOLERANCE_HA = 1
M2_PER_HA = 10_000
# A hand-drawn or imported boundary needs far fewer; this bounds the work one request can cause.
MAX_VERTICES = 10_000

ProblemCode = Literal[
    "invalid_geojson", "too_complex", "self_intersection", "too_small", "too_large", "overlap"
]
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


def _vertex_count(coordinates: Any, limit: int) -> int:
    """Positions in a GeoJSON coordinates array, counting no further than just past `limit`."""
    count, stack = 0, [coordinates]
    while stack and count <= limit:
        item = stack.pop()
        if isinstance(item, list | tuple) and item and isinstance(item[0], list | tuple):
            stack.extend(item)
        else:
            count += 1
    return count


def bare_geometry(geojson: Mapping[str, Any]) -> dict[str, Any]:
    """The Polygon or MultiPolygon of a validated listing area, without a Feature's properties
    (free text that would otherwise reach the public ledger)."""
    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    if not isinstance(geometry, Mapping):
        raise ValueError("not a GeoJSON geometry")
    return {"type": geometry["type"], "coordinates": geometry["coordinates"]}


def _area_ha(geom: BaseGeometry, centre: tuple[float, float]) -> float:
    lon, lat = centre
    laea = CRS.from_proj4(f"+proj=laea +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m")
    to_laea = Transformer.from_crs("EPSG:4326", laea, always_xy=True)
    return float(transform(to_laea.transform, geom).area) / M2_PER_HA


def _measure(geojson: Mapping[str, Any]) -> tuple[PolygonCheck, Area | None]:
    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    coordinates = geometry.get("coordinates") if isinstance(geometry, Mapping) else None
    if _vertex_count(coordinates, MAX_VERTICES) > MAX_VERTICES:
        too_many = f"The boundary has more than {MAX_VERTICES:,} points. Simplify it."
        return PolygonCheck(problems=[Problem("too_complex", too_many)]), None
    try:
        geom = _parse(geojson)
    except _InvalidGeoJSON as exc:
        return PolygonCheck(problems=[Problem("invalid_geojson", str(exc))]), None
    if not geom.is_valid:
        reason = explain_validity(geom)
        crossing = f"The boundary crosses itself or is malformed ({reason}). Redraw it."
        return PolygonCheck(problems=[Problem("self_intersection", crossing)]), None

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
    check = PolygonCheck(
        problems=problems, area_ha=area, centroid_lat=centre[1], centroid_lon=centre[0]
    )
    return check, geom


def check_shape(geojson: Mapping[str, Any]) -> PolygonCheck:
    """Every check but overlap: readable GeoJSON, at most `MAX_VERTICES` points, no
    self-intersection, 10–50,000 ha (equal-area). Cheap enough to run before taking locks."""
    return _measure(geojson)[0]


def overlapping(
    geojson: Mapping[str, Any], existing: Sequence[tuple[UUID, Mapping[str, Any]]]
) -> list[UUID]:
    """The IDs in `existing` whose area overlaps this one by more than the tolerance.

    Unreadable existing geometries are skipped: one bad stored row shouldn't block every new
    listing. Returns [] for an area that can't be measured (check_shape reports it).
    """
    check, geom = _measure(geojson)
    if geom is None or check.centroid_lat is None or check.centroid_lon is None:
        return []
    centre = (check.centroid_lon, check.centroid_lat)
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
    return overlaps


OVERLAP_PROBLEM = Problem("overlap", "This area overlaps another listing. Redraw around it.")


def validate_polygon(
    geojson: Mapping[str, Any],
    existing: Sequence[tuple[UUID, Mapping[str, Any]]] = (),
) -> PolygonCheck:
    """Check a drawn listing area; report every problem at once so the UI can show them all.

    `existing` holds (asset_id, geojson) for listings it must not overlap.
    """
    check, geom = _measure(geojson)
    if geom is None:
        return check
    overlaps = overlapping(geojson, existing)
    return PolygonCheck(
        problems=[*check.problems, OVERLAP_PROBLEM] if overlaps else check.problems,
        area_ha=check.area_ha,
        centroid_lat=check.centroid_lat,
        centroid_lon=check.centroid_lon,
        overlaps=overlaps,
    )


BBox = tuple[float, float, float, float]
"""(west, south, east, north) in degrees."""


def geometry_bbox(geojson: Mapping[str, Any]) -> BBox | None:
    """The area's bounding box, or None if it can't be read."""
    try:
        west, south, east, north = _parse(geojson).bounds
    except _InvalidGeoJSON:
        return None
    return float(west), float(south), float(east), float(north)


OUTLINE_MAX_POINTS = 200
"""Corners per outline (all parts together) in `GET /assets/outlines`: enough for a map hint."""
_OUTLINE_DIGITS = 5  # ~1 m
_OUTLINE_TOLERANCES = (0.0, 0.00001, 0.00003, 0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03, 0.1)


def outline_rings(
    geojson: Mapping[str, Any], max_points: int = OUTLINE_MAX_POINTS
) -> list[list[list[float]]]:
    """The exterior ring of each part, [lon, lat] rounded to ~1 m and simplified until every
    ring together has at most `max_points` corners (holes dropped): an outline to draw and to
    hint at overlaps with, never a check. A part that won't simplify enough becomes its bounding
    box; an unreadable area has no outline."""
    try:
        area = _parse(geojson)
    except _InvalidGeoJSON:
        return []
    parts: list[Polygon] = list(area.geoms) if isinstance(area, MultiPolygon) else [area]

    def simplified(part: Polygon, tolerance: float) -> Polygon:
        out = part.simplify(tolerance, preserve_topology=True)
        return out if isinstance(out, Polygon) and not out.is_empty else part

    rings: list[list[tuple[float, ...]]] = []
    for tolerance in _OUTLINE_TOLERANCES:
        rings = [list(simplified(part, tolerance).exterior.coords) for part in parts]
        if sum(len(ring) for ring in rings) <= max_points:
            break
    else:
        largest = sorted(parts, key=lambda part: part.area, reverse=True)
        rings = [list(box(*part.bounds).exterior.coords) for part in largest[: max_points // 5]]
    return [
        [[round(float(x), _OUTLINE_DIGITS), round(float(y), _OUTLINE_DIGITS)] for x, y, *_ in ring]
        for ring in rings
    ]


def geometry_sha256(geojson: Mapping[str, Any]) -> str:
    """A commitment to the bare geometry (canonical JSON), for ledger entries of drafts."""
    canonical = json.dumps(bare_geometry(geojson), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


METRICS_AREA_TOLERANCE = 0.10


def metrics_match_polygon(
    geojson: Mapping[str, Any],
    *,
    area_ha: float,
    metrics_area_ha: float,
    metrics_lat: float,
    metrics_lon: float,
) -> bool:
    """Whether Earth observation metrics plausibly describe this polygon: their centroid lies in
    its convex hull (a concave polygon's centroid can fall outside the polygon itself, never
    outside its hull) and their area is within ±10 % of the listing's."""
    try:
        hull = _parse(geojson).convex_hull
    except _InvalidGeoJSON:
        return False
    if area_ha <= 0 or abs(metrics_area_ha - area_ha) > METRICS_AREA_TOLERANCE * area_ha:
        return False
    return bool(hull.covers(Point(metrics_lon, metrics_lat)))

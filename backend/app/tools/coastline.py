"""Distance to the nearest sea coast, for the valuation engine's coastal check (dev-spec §7.3).

A site is *coastal* when its centroid lies within 5 km of the Natural Earth 1:10m
coastline (v5.1.2, public domain), bundled in ``data/coastline/``. Distances are
geodesic: candidate coastline segments come from an STRtree query over a lon/lat box that
is guaranteed to contain the search disc, and are then measured in an azimuthal
equidistant projection centred on the point (exact distance to every vertex; between
vertices the error is far below the 5 km threshold's precision needs). The index loads
lazily, once per process, behind a lock.
"""

from __future__ import annotations

import gzip
import json
import math
import threading
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import shapely
from numpy.typing import NDArray
from pyproj import Transformer
from shapely.geometry import LineString, Point, box

COASTAL_THRESHOLD_KM = 5.0
COASTLINE_SOURCE = "Natural Earth 1:10m coastline v5.1.2 (public domain)"
COASTLINE_PATH = (
    Path(__file__).resolve().parents[2] / "data" / "coastline" / "ne_10m_coastline.geojson.gz"
)
# Long coastlines are cut into pieces so each STRtree envelope stays tight.
_MAX_VERTICES_PER_PIECE = 256
# Smallest radius of curvature of the WGS84 ellipsoid (meridional, at the equator), less a
# margin, so the lon/lat search box always contains the whole geodesic search disc.
_R_MIN_KM = 6_300.0
_HALF_CIRCUMFERENCE_KM = 20_040.0
_FIRST_SEARCH_RADIUS_KM = 10.0


@dataclass(frozen=True, slots=True)
class CoastalCheck:
    is_coastal: bool
    distance_km: float
    """Geodesic distance from the point to the nearest coastline, in km."""
    threshold_km: float
    source: str = COASTLINE_SOURCE


def _split(coords: Sequence[Sequence[float]]) -> Iterable[LineString]:
    step = _MAX_VERTICES_PER_PIECE - 1
    for start in range(0, max(len(coords) - 1, 1), step):
        piece = coords[start : start + _MAX_VERTICES_PER_PIECE]
        if len(piece) >= 2:
            yield LineString(piece)


def _search_boxes(lat: float, lon: float, radius_km: float) -> list[shapely.Polygon]:
    """Lon/lat boxes (split at the antimeridian) that contain the geodesic disc."""
    angle = radius_km / _R_MIN_KM
    dlat = math.degrees(angle)
    south, north = max(lat - dlat, -90.0), min(lat + dlat, 90.0)
    far_lat = math.radians(max(abs(south), abs(north)))
    if angle >= math.pi / 2 or north >= 90.0 or south <= -90.0:
        return [box(-180.0, south, 180.0, north)]
    ratio = math.sin(angle) / math.cos(far_lat)
    if ratio >= 1.0:
        return [box(-180.0, south, 180.0, north)]
    dlon = math.degrees(math.asin(ratio))
    west, east = lon - dlon, lon + dlon
    boxes = [box(max(west, -180.0), south, min(east, 180.0), north)]
    if west < -180.0:
        boxes.append(box(west + 360.0, south, 180.0, north))
    if east > 180.0:
        boxes.append(box(-180.0, south, east - 360.0, north))
    return boxes


class CoastlineIndex:
    """Spatial index over coastline polylines (WGS84 lon/lat)."""

    def __init__(self, lines: Sequence[LineString]) -> None:
        if not lines:
            raise ValueError("A coastline index needs at least one line.")
        self._lines = list(lines)
        self._tree = shapely.STRtree(self._lines)

    @classmethod
    def from_geojson_gz(cls, path: Path = COASTLINE_PATH) -> CoastlineIndex:
        collection = json.loads(gzip.decompress(path.read_bytes()))
        lines: list[LineString] = []
        for feature in collection["features"]:
            geometry = feature["geometry"]
            parts = (
                [geometry["coordinates"]]
                if geometry["type"] == "LineString"
                else geometry["coordinates"]
            )
            for part in parts:
                lines.extend(_split(part))
        return cls(lines)

    @property
    def lines(self) -> Sequence[LineString]:
        return self._lines

    def _candidates(self, lat: float, lon: float, radius_km: float) -> list[int]:
        found: set[int] = set()
        for search_box in _search_boxes(lat, lon, radius_km):
            found.update(int(i) for i in self._tree.query(search_box))
        return sorted(found)

    def distance_km(self, lat: float, lon: float) -> float:
        """Geodesic distance from (lat, lon) to the nearest coastline, in km."""
        if not (math.isfinite(lat) and math.isfinite(lon)):
            raise ValueError("Latitude and longitude must be finite numbers.")
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise ValueError("Latitude must be in [-90, 90] and longitude in [-180, 180].")
        to_aeqd = Transformer.from_crs(
            "EPSG:4326",
            f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m",
            always_xy=True,
        )

        def project(coords: NDArray[np.float64]) -> NDArray[np.float64]:
            x, y = to_aeqd.transform(coords[:, 0], coords[:, 1])
            return np.column_stack([x, y])

        origin = Point(0.0, 0.0)
        radius = _FIRST_SEARCH_RADIUS_KM
        while True:
            candidates = self._candidates(lat, lon, radius)
            if candidates:
                best_m = min(
                    origin.distance(shapely.transform(self._lines[i], project)) for i in candidates
                )
                best_km = best_m / 1000.0
                # Any line outside the boxes is farther than `radius`, so this is the minimum.
                if best_km <= radius or radius >= _HALF_CIRCUMFERENCE_KM:
                    return best_km
            elif radius >= _HALF_CIRCUMFERENCE_KM:
                raise ValueError("No coastline found.")
            radius = min(radius * 2.0, _HALF_CIRCUMFERENCE_KM)

    def check(
        self, lat: float, lon: float, threshold_km: float = COASTAL_THRESHOLD_KM
    ) -> CoastalCheck:
        distance = self.distance_km(lat, lon)
        return CoastalCheck(
            is_coastal=distance <= threshold_km, distance_km=distance, threshold_km=threshold_km
        )


_default_index: CoastlineIndex | None = None
_default_lock = threading.Lock()


def default_coastline() -> CoastlineIndex:
    """The bundled Natural Earth index, loaded on first use and shared across threads."""
    global _default_index
    if _default_index is None:
        with _default_lock:
            if _default_index is None:
                _default_index = CoastlineIndex.from_geojson_gz()
    return _default_index


def coastal_check(
    lat: float, lon: float, threshold_km: float = COASTAL_THRESHOLD_KM
) -> CoastalCheck:
    """Is (lat, lon) within ``threshold_km`` of the sea coast? (dev-spec §7.3)."""
    return default_coastline().check(lat, lon, threshold_km)

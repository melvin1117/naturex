"""Coastal check against the bundled Natural Earth 1:10m coastline (dev-spec §7.3)."""

from __future__ import annotations

import gzip
import hashlib
import threading

import numpy as np
import pytest
import shapely
from pyproj import Geod
from shapely.geometry import LineString, box

from app.tools.coastline import (
    COASTAL_THRESHOLD_KM,
    COASTLINE_PATH,
    CoastlineIndex,
    coastal_check,
    default_coastline,
)

GEOD = Geod(ellps="WGS84")
UPSTREAM_SHA256 = "6f75ae0e0de157b14946e2255eb1f5486d9a13819032e26d4610852d296788f6"


def test_bundled_file_is_the_pinned_natural_earth_release() -> None:
    raw = gzip.decompress(COASTLINE_PATH.read_bytes())
    assert hashlib.sha256(raw).hexdigest() == UPSTREAM_SHA256
    assert COASTLINE_PATH.stat().st_size < 5_000_000


def test_hero_wetland_xochimilco_is_inland() -> None:
    check = coastal_check(19.2873, -99.0976)
    assert not check.is_coastal
    assert check.distance_km == pytest.approx(253.354, abs=0.01)
    assert check.threshold_km == COASTAL_THRESHOLD_KM == 5.0


def test_yucatan_mangrove_site_is_coastal() -> None:
    check = coastal_check(21.50, -87.50)
    assert check.is_coastal
    assert check.distance_km < 1


def _easternmost_vertex_of_easter_island() -> tuple[float, float]:
    island = box(-109.6, -27.3, -109.1, -26.9)
    vertices = [
        xy
        for line in default_coastline().lines
        if line.intersects(island)
        for xy in line.coords
        if island.contains(shapely.Point(xy))
    ]
    lon, lat = max(vertices, key=lambda xy: xy[0])
    return lon, lat


@pytest.mark.parametrize(("metres", "coastal"), [(4_900, True), (5_100, False)])
def test_threshold_around_a_known_vertex(metres: int, coastal: bool) -> None:
    # Due east of the island's easternmost vertex, that vertex is the nearest coast
    # (the next land is ~400 km away), so the distance is the geodesic offset itself.
    lon, lat = _easternmost_vertex_of_easter_island()
    p_lon, p_lat, _ = GEOD.fwd(lon, lat, 90.0, metres)
    check = coastal_check(p_lat, p_lon)
    assert check.distance_km == pytest.approx(metres / 1000, abs=0.001)
    assert check.is_coastal is coastal


def test_distance_matches_brute_force_geodesic_minimum() -> None:
    # Distance to a polyline is never more than to its nearest vertex, and only slightly
    # less where the nearest point falls between vertices.
    coords = np.concatenate([np.asarray(line.coords) for line in default_coastline().lines])
    for lat, lon in [(19.2873, -99.0976), (0.0, -140.0), (-45.0, 170.5), (60.0, -30.0)]:
        _, _, d = GEOD.inv(
            np.full(len(coords), lon), np.full(len(coords), lat), coords[:, 0], coords[:, 1]
        )
        vertex_km = float(d.min()) / 1000
        got = default_coastline().distance_km(lat, lon)
        assert vertex_km - 0.5 <= got <= vertex_km + 1e-6


def test_search_handles_the_antimeridian_and_poles() -> None:
    line = LineString([(179.9, -16.0), (179.9, -17.0)])
    index = CoastlineIndex([line])
    assert index.distance_km(-16.5, -179.95) == pytest.approx(15.97, abs=0.05)
    assert default_coastline().distance_km(89.9, 0.0) > 500


@pytest.mark.parametrize(
    ("lat", "lon"), [(float("nan"), 0.0), (0.0, float("inf")), (91.0, 0.0), (0.0, 181.0)]
)
def test_rejects_invalid_coordinates(lat: float, lon: float) -> None:
    with pytest.raises(ValueError):
        default_coastline().distance_km(lat, lon)


def test_empty_index_is_rejected() -> None:
    with pytest.raises(ValueError):
        CoastlineIndex([])


def test_default_index_loads_once_across_threads() -> None:
    seen: list[CoastlineIndex] = []
    threads = [threading.Thread(target=lambda: seen.append(default_coastline())) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len({id(index) for index in seen}) == 1

"""Polygon validation for listings (pm-spec A1, dev-spec §6 POST /assets)."""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from pyproj import Geod

from app.tools.geometry import (
    MAX_AREA_HA,
    MAX_VERTICES,
    MIN_AREA_HA,
    OUTLINE_MAX_POINTS,
    OVERLAP_TOLERANCE_HA,
    Problem,
    bare_geometry,
    outline_rings,
    thumbnail_outline,
    validate_polygon,
)

LAT, LON = 19.26, -99.09  # near the Xochimilco demo wetland
M_PER_DEG_LAT = 110_574.0


def square(side_m: float, lat: float = LAT, lon: float = LON) -> dict[str, Any]:
    """GeoJSON Polygon, roughly side_m × side_m metres, with its south-west corner at lat/lon."""
    dlat = side_m / M_PER_DEG_LAT
    dlon = side_m / (111_320.0 * math.cos(math.radians(lat)))
    ring = [[lon, lat], [lon + dlon, lat], [lon + dlon, lat + dlat], [lon, lat + dlat], [lon, lat]]
    return {"type": "Polygon", "coordinates": [ring]}


def geodesic_ha(geojson: dict[str, Any]) -> float:
    lons, lats = zip(*geojson["coordinates"][0], strict=True)
    area_m2, _ = Geod(ellps="WGS84").polygon_area_perimeter(lons, lats)
    return abs(area_m2) / 10_000


def codes(problems: list[Problem]) -> set[str]:
    return {p.code for p in problems}


# --- Area -----------------------------------------------------------------------------------


def test_one_square_kilometre_is_about_100_hectares() -> None:
    check = validate_polygon(square(1_000))

    assert check.ok
    assert check.problems == []
    assert check.area_ha == pytest.approx(100, rel=0.01)


def test_equal_area_projection_matches_the_geodesic_area() -> None:
    polygon = square(5_000, lat=60.0, lon=25.0)  # high latitude, where Web Mercator inflates

    check = validate_polygon(polygon)

    assert check.area_ha == pytest.approx(geodesic_ha(polygon), rel=0.001)


def test_centroid_is_returned_in_lat_lon() -> None:
    check = validate_polygon(square(2_000))

    assert check.centroid_lat == pytest.approx(LAT + 1_000 / M_PER_DEG_LAT, abs=1e-4)
    assert check.centroid_lon > LON


def test_land_under_10_hectares_is_rejected() -> None:
    check = validate_polygon(square(300))  # ~9 ha

    assert not check.ok
    assert codes(check.problems) == {"too_small"}
    assert check.area_ha == pytest.approx(9, rel=0.02)


def test_land_over_50000_hectares_is_rejected() -> None:
    check = validate_polygon(square(25_000))  # ~62,500 ha

    assert codes(check.problems) == {"too_large"}


def test_area_limits_follow_the_spec() -> None:
    assert (MIN_AREA_HA, MAX_AREA_HA) == (10, 50_000)


def test_holes_are_subtracted_from_the_area() -> None:
    outer = square(2_000)["coordinates"][0]
    hole = square(1_000, lat=LAT + 0.002, lon=LON + 0.002)["coordinates"][0]

    check = validate_polygon({"type": "Polygon", "coordinates": [outer, hole]})

    assert check.ok
    assert check.area_ha == pytest.approx(300, rel=0.01)


def test_multipolygons_are_accepted_and_summed() -> None:
    a = square(1_000)["coordinates"]
    b = square(1_000, lon=LON + 0.05)["coordinates"]

    check = validate_polygon({"type": "MultiPolygon", "coordinates": [a, b]})

    assert check.ok
    assert check.area_ha == pytest.approx(200, rel=0.01)


def test_a_geojson_feature_is_unwrapped() -> None:
    check = validate_polygon({"type": "Feature", "properties": {}, "geometry": square(1_000)})

    assert check.ok


def test_bare_geometry_drops_feature_properties() -> None:
    feature = {"type": "Feature", "properties": {"owner": "Ada"}, "geometry": square(1_000)}

    assert bare_geometry(feature) == square(1_000)
    assert bare_geometry(square(1_000)) == square(1_000)


# --- Shape ----------------------------------------------------------------------------------


def test_a_boundary_with_too_many_points_is_rejected_before_parsing() -> None:
    ring = square(1_000)["coordinates"][0]
    many = ring[:1] * (MAX_VERTICES + 5) + ring
    check = validate_polygon({"type": "Polygon", "coordinates": [many]})

    assert codes(check.problems) == {"too_complex"}
    assert check.area_ha is None
    at_limit = ring[:1] * (MAX_VERTICES - len(ring)) + ring
    assert "too_complex" not in codes(
        validate_polygon({"type": "Polygon", "coordinates": [at_limit]}).problems
    )


def test_self_intersecting_bow_tie_is_rejected() -> None:
    bow_tie = {
        "type": "Polygon",
        "coordinates": [
            [[LON, LAT], [LON + 0.02, LAT + 0.02], [LON + 0.02, LAT], [LON, LAT + 0.02], [LON, LAT]]
        ],
    }

    check = validate_polygon(bow_tie)

    assert not check.ok
    assert codes(check.problems) == {"self_intersection"}
    assert check.area_ha is None


@pytest.mark.parametrize(
    "geojson",
    [
        {"type": "Point", "coordinates": [LON, LAT]},
        {"type": "Polygon", "coordinates": []},
        {"type": "Polygon", "coordinates": [[[LON, LAT], [LON + 0.01, LAT]]]},
        {"type": "Polygon", "coordinates": "nope"},
        {"coordinates": [[[LON, LAT]]]},
        {"type": "Feature", "geometry": None},
    ],
    ids=["point", "no-rings", "two-points", "bad-coordinates", "no-type", "empty-feature"],
)
def test_malformed_geojson_is_rejected(geojson: dict[str, Any]) -> None:
    check = validate_polygon(geojson)

    assert not check.ok
    assert codes(check.problems) == {"invalid_geojson"}


def test_coordinates_outside_lon_lat_range_are_rejected() -> None:
    check = validate_polygon(square(1_000, lat=LAT, lon=181.0))

    assert codes(check.problems) == {"invalid_geojson"}


# --- Overlap with existing listings ---------------------------------------------------------

EXISTING_ID = UUID("33333333-3333-3333-3333-333333333301")


def test_overlap_with_an_existing_listing_is_rejected() -> None:
    existing = square(2_000)
    shifted = square(2_000, lon=LON + 1_000 / (111_320.0 * math.cos(math.radians(LAT))))

    check = validate_polygon(shifted, existing=[(EXISTING_ID, existing)])

    assert not check.ok
    assert codes(check.problems) == {"overlap"}
    assert check.overlaps == [EXISTING_ID]
    assert check.area_ha == pytest.approx(400, rel=0.01), "area is still reported for the UI"


def test_land_sharing_only_a_border_is_accepted() -> None:
    existing = square(1_000)
    neighbour_lon = existing["coordinates"][0][1][0]

    check = validate_polygon(square(1_000, lon=neighbour_lon), existing=[(EXISTING_ID, existing)])

    assert check.ok
    assert check.overlaps == []


def test_digitising_slivers_below_the_tolerance_are_ignored() -> None:
    existing = square(1_000)
    sliver_m = 5  # 5 m × 1 km = 0.5 ha of overlap
    lon = existing["coordinates"][0][1][0] - sliver_m / (111_320.0 * math.cos(math.radians(LAT)))

    check = validate_polygon(square(1_000, lon=lon), existing=[(EXISTING_ID, existing)])

    assert OVERLAP_TOLERANCE_HA == 1
    assert check.ok


def test_invalid_existing_geometry_is_skipped_not_fatal() -> None:
    broken = {"type": "Polygon", "coordinates": "nope"}

    check = validate_polygon(square(1_000), existing=[(EXISTING_ID, broken)])

    assert check.ok


def test_every_problem_is_reported_at_once() -> None:
    existing = square(300)

    check = validate_polygon(square(300), existing=[(EXISTING_ID, existing)])

    assert codes(check.problems) == {"too_small", "overlap"}
    assert all(p.message for p in check.problems)


# --- Outlines for the listing map (T33) ---------------------------------------------------------


def circle(
    points: int, radius_deg: float = 0.05, lat: float = LAT, lon: float = LON
) -> dict[str, Any]:
    """GeoJSON Polygon: a circle of `points` corners around lat/lon."""
    ring = [
        [
            lon + radius_deg * math.cos(2 * math.pi * i / points),
            lat + radius_deg * math.sin(2 * math.pi * i / points),
        ]
        for i in range(points)
    ]
    return {"type": "Polygon", "coordinates": [[*ring, ring[0]]]}


def test_an_outline_keeps_a_simple_ring_rounded_to_a_metre() -> None:
    rings = outline_rings(square(1_200))
    assert len(rings) == 1 and len(rings[0]) == 5
    assert rings[0][0] == [round(LON, 5), round(LAT, 5)]


def test_an_outline_is_simplified_under_the_cap() -> None:
    rings = outline_rings(circle(5_000))
    assert 4 <= sum(len(ring) for ring in rings) <= OUTLINE_MAX_POINTS
    assert len(outline_rings(circle(5_000), max_points=20)[0]) <= 20


def test_an_outline_has_each_parts_exterior_and_no_holes() -> None:
    a, b = square(1_200), square(1_200, lon=LON + 0.1)
    multi = {"type": "MultiPolygon", "coordinates": [a["coordinates"], b["coordinates"]]}
    assert len(outline_rings(multi)) == 2
    hole = square(400, lat=LAT + 0.002, lon=LON + 0.002)["coordinates"][0]
    holed = {"type": "Polygon", "coordinates": [square(1_200)["coordinates"][0], hole]}
    assert len(outline_rings(holed)) == 1


def test_a_thumbnail_outline_has_at_most_64_corners_over_every_part() -> None:
    assert sum(len(ring) for ring in thumbnail_outline(circle(5_000))) <= 64
    far = circle(3_000, lat=LAT + 0.3)["coordinates"]
    multi = {"type": "MultiPolygon", "coordinates": [circle(3_000)["coordinates"], far]}
    rings = thumbnail_outline(multi)
    assert len(rings) == 2 and sum(len(ring) for ring in rings) <= 64


def test_the_outline_migration_backfills_like_the_app() -> None:
    """0022 freezes its own copy of the simplification; today it matches the app's."""
    path = Path(__file__).parents[1] / "migrations/versions/0023_asset_outline.py"
    spec = importlib.util.spec_from_file_location("migration_0022", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    multi = {
        "type": "MultiPolygon",
        "coordinates": [circle(3_000)["coordinates"], circle(400, lat=LAT + 0.3)["coordinates"]],
    }
    for geojson in (square(1_200), circle(5_000), multi, {"type": "Point", "coordinates": [0, 0]}):
        assert migration._outline(geojson) == thumbnail_outline(geojson)
        feature = {"type": "Feature", "properties": {}, "geometry": geojson}
        assert migration._outline(json.dumps(feature)) == thumbnail_outline(geojson)


def test_an_unreadable_area_has_no_outline() -> None:
    assert outline_rings({"type": "Point", "coordinates": [0, 0]}) == []

"""Cached Earth observation metrics for demo sites."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.tools.earth_obs import load_site_metrics
from app.tools.geometry import validate_polygon

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "demo_sites"


def test_loads_committed_wetland_metrics() -> None:
    metrics = load_site_metrics("wetland_mx")

    assert metrics.site_key == "wetland_mx"
    assert metrics.area_ha > 150
    assert metrics.area_ha < 600
    assert metrics.natural_fraction >= 0.65
    assert 0 <= metrics.ndvi_trend.mann_kendall_p_value <= 1
    assert metrics.cloud_free_observations_last_12m > 0


def test_land_cover_fractions_are_complete_and_normalized() -> None:
    metrics = load_site_metrics("wetland_mx")

    assert set(metrics.land_cover_fractions) == {
        "water",
        "trees",
        "grass",
        "flooded_vegetation",
        "crops",
        "shrub_and_scrub",
        "built",
        "bare",
        "snow_and_ice",
    }
    assert sum(metrics.land_cover_fractions.values()) == pytest.approx(1.0, abs=0.0002)


def test_area_matches_committed_geojson() -> None:
    geojson = json.loads((DATA_DIR / "wetland_mx.geojson").read_text())
    metrics = load_site_metrics("wetland_mx")
    check = validate_polygon(geojson)

    assert check.ok
    assert check.area_ha is not None
    assert metrics.area_ha == pytest.approx(check.area_ha, rel=0.005)


def test_attributions_cover_every_dataset_used() -> None:
    metrics = load_site_metrics("wetland_mx")

    for dataset in metrics.datasets:
        assert dataset.attribution
        assert dataset.attribution in metrics.attributions


def test_unknown_site_raises_clear_error() -> None:
    with pytest.raises(ValueError, match="No cached Earth observation metrics for site"):
        load_site_metrics("missing_site")

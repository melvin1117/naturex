"""Cached Earth observation metrics for demo sites."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.models import Metrics
from app.tools.earth_obs import load_site_metrics
from app.tools.geometry import validate_polygon

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "demo_sites"


def test_loads_committed_wetland_metrics() -> None:
    metrics = load_site_metrics("wetland_mx")

    assert metrics.site_key == "wetland_mx"
    assert metrics.area_ha > 150
    assert metrics.area_ha < 600
    assert metrics.natural_fraction >= 0.65
    assert 0 <= metrics.ndvi_trend_details.mann_kendall_p_value <= 1
    assert metrics.cloud_free_obs > 0


def test_land_cover_fractions_are_complete_and_normalized() -> None:
    metrics = load_site_metrics("wetland_mx")

    assert set(metrics.landcover) == {
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
    assert sum(metrics.landcover.values()) == pytest.approx(1.0, abs=0.0002)


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


def test_canonical_metric_inputs_are_exposed() -> None:
    metrics = load_site_metrics("wetland_mx")

    for name in (
        "landcover",
        "ndvi_series",
        "ndvi_trend",
        "water_change",
        "forest_loss_ha",
        "biomass_t_ha",
        "cloud_free_obs",
    ):
        assert hasattr(metrics, name)
    for old_name in (
        "land_cover_fractions",
        "water_change_mean_abs",
        "forest_loss_last_5y_ha",
        "biomass_mean_t_ha",
        "cloud_free_observations_last_12m",
    ):
        assert not hasattr(metrics, old_name)

    assert 0 <= metrics.ndvi_mean <= 1
    assert -1 <= metrics.ndvi_trend <= 1
    assert metrics.forest_loss_ha >= 0
    assert metrics.biomass_t_ha >= 0


def test_metrics_cache_maps_to_database_model() -> None:
    metrics = load_site_metrics("wetland_mx")

    row = Metrics(
        world_id=uuid4(),
        asset_id=uuid4(),
        data_version=metrics.data_version,
        landcover=metrics.landcover,
        ndvi_series=[point.model_dump() for point in metrics.ndvi_series],
        ndvi_trend=metrics.ndvi_trend,
        water_change=metrics.water_change,
        forest_loss_ha=metrics.forest_loss_ha,
        biomass_t_ha=metrics.biomass_t_ha,
        cloud_free_obs=metrics.cloud_free_obs,
    )

    assert row.landcover == metrics.landcover
    assert row.cloud_free_obs == metrics.cloud_free_obs


def test_committed_hero_polygon_is_not_the_old_placeholder() -> None:
    geojson = json.loads((DATA_DIR / "wetland_mx.geojson").read_text())
    metrics = load_site_metrics("wetland_mx")
    ring = geojson["geometry"]["coordinates"][0]
    check = validate_polygon(geojson)

    assert len(ring) - 1 != 4
    assert check.centroid_lat == pytest.approx(19.2873, abs=0.009)
    assert check.centroid_lon == pytest.approx(-99.0976, abs=0.009)
    assert metrics.natural_fraction >= 0.65

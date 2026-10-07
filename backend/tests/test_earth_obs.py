"""Cached Earth observation metrics for demo sites."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from app.models import Metrics
from app.tools.earth_obs import EarthObsMetrics, load_site_metrics
from app.tools.geometry import validate_polygon

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "demo_sites"
SITE_KEYS = ("wetland_mx", "mangrove_mx", "restoration_forest")


def test_loads_committed_wetland_metrics() -> None:
    metrics = load_site_metrics("wetland_mx")

    assert metrics.site_key == "wetland_mx"
    assert metrics.area_ha > 150
    assert metrics.area_ha < 600
    assert metrics.natural_fraction >= 0.65
    assert 0 <= metrics.ndvi_trend_details.mann_kendall_p_value <= 1
    assert metrics.cloud_free_obs > 0


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_land_cover_fractions_are_complete_and_normalized(site_key: str) -> None:
    metrics = load_site_metrics(site_key)

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


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_area_matches_committed_geojson(site_key: str) -> None:
    geojson = json.loads((DATA_DIR / f"{site_key}.geojson").read_text())
    metrics = load_site_metrics(site_key)
    check = validate_polygon(geojson)

    assert check.ok
    assert check.area_ha is not None
    assert 150 <= metrics.area_ha <= 600
    assert metrics.area_ha == pytest.approx(check.area_ha, rel=0.005)
    assert len(geojson["geometry"]["coordinates"][0]) - 1 > 4  # hand-drawn, not a box


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_attributions_cover_every_dataset_used(site_key: str) -> None:
    metrics = load_site_metrics(site_key)

    assert len(metrics.attributions) == len(metrics.datasets)
    for dataset in metrics.datasets:
        assert dataset.attribution
        assert dataset.attribution in metrics.attributions
    keys = {dataset.key for dataset in metrics.datasets}
    assert metrics.biomass_source == "esa_cci_biomass"
    assert "esa_cci_biomass" in keys
    # GEDI is a cross-check, listed only where it returned a value.
    assert ("gedi_l4b" in keys) == (metrics.biomass_gedi_t_ha is not None)
    assert any(
        "Global Mangrove Watch" in text and "Bunting" in text for text in metrics.attributions
    )
    assert {"dynamic_world", "hansen_global_forest_change", "soilgrids_ocs"} <= keys
    assert any("CC BY 4.0" in text and "ISRIC" in text for text in metrics.attributions)


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_t13_metrics_are_present_for_every_site(site_key: str) -> None:
    metrics = load_site_metrics(site_key)

    assert metrics.soc_t_c_ha is not None
    assert 0 < metrics.soc_t_c_ha < 500
    assert metrics.forest_loss_last_12m_ha is not None
    assert 0 <= metrics.forest_loss_last_12m_ha <= metrics.forest_loss_ha
    assert metrics.thresholds["hansen_forest_loss_last_12m_year"] == "2025"
    assert metrics.thresholds["soilgrids_soc_depth_cm"] == "0-30"
    assert metrics.simulated is False
    assert metrics.scenario == "baseline"


def test_demo_sites_tell_their_stories() -> None:
    mangrove = load_site_metrics("mangrove_mx")
    forest = load_site_metrics("restoration_forest")

    # Mangrove: coastal wetland, almost all mangrove (trees + flooded vegetation) and water.
    mangrove_cover = mangrove.landcover
    assert mangrove_cover["trees"] + mangrove_cover["flooded_vegetation"] >= 0.85
    assert mangrove_cover["water"] + mangrove_cover["flooded_vegetation"] >= 0.20
    assert mangrove.natural_fraction >= 0.95
    assert mangrove.mangrove_fraction is not None and mangrove.mangrove_fraction >= 0.85
    assert forest.mangrove_fraction == 0.0
    assert load_site_metrics("wetland_mx").mangrove_fraction == 0.0
    # Forest: tree-dominated, damaged in 2021-2025, and still listable (< 1% loss last year).
    assert max(forest.landcover, key=lambda name: forest.landcover[name]) == "trees"
    assert forest.forest_loss_ha >= 0.05 * forest.area_ha
    assert forest.forest_loss_last_12m_ha is not None
    assert forest.forest_loss_last_12m_ha < 0.01 * forest.area_ha


def test_old_json_without_t13_fields_still_loads() -> None:
    data = json.loads((DATA_DIR / "wetland_mx.json").read_text())
    for key in (
        "soc_t_c_ha",
        "forest_loss_last_12m_ha",
        "biomass_source",
        "biomass_gedi_t_ha",
        "mangrove_fraction",
    ):
        data.pop(key)

    metrics = EarthObsMetrics.model_validate(data)

    assert metrics.soc_t_c_ha is None
    assert metrics.forest_loss_last_12m_ha is None
    assert metrics.biomass_source is None
    assert metrics.mangrove_fraction is None


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

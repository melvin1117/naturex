"""The Earth Engine methods shared by the precompute and live ratings (T11/T13, T60), on
fixtures: nothing here calls Earth Engine."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.tools import earth_engine as eng
from app.tools.earth_obs import DATA_DIR

# ----- the shared methods, on fixtures (no Earth Engine) ------------------------------------------

HISTOGRAM = {"0": 10.0, "1": 50.0, "2": 15.0, "5": 20.0, "6": 5.0}
LAND_COVER = eng.land_cover_shares(HISTOGRAM)


def ndvi_fixture(months: int = 60, *, tau: float = 0.2, slope: float = 0.01) -> dict[str, Any]:
    """What `earth_engine.ndvi` fetches in its one round trip, newest month first."""
    rows = [
        {
            "properties": {
                "month": f"{2021 + (9 + i) // 12}-{(9 + i) % 12 + 1:02d}",
                "t": i / 12,
                "ndvi": 0.6 + 0.001 * i,
                "cloud_free_observations": 3,
            }
        }
        for i in range(months)
    ]
    return {
        "rows": list(reversed(rows)),
        "sens": {"slope": slope},
        "kendall": {"tau": tau},
        "cloud_free_observations_last_12m": 40,
    }


def test_land_cover_shares_are_pixel_shares_of_every_class() -> None:
    assert LAND_COVER["water"] == pytest.approx(0.1)
    assert LAND_COVER["trees"] == pytest.approx(0.5)
    assert LAND_COVER["snow_and_ice"] == 0.0
    assert list(LAND_COVER) == eng.CLASSES and sum(LAND_COVER.values()) == pytest.approx(1)
    assert eng.natural_fraction(LAND_COVER) == pytest.approx(0.95)  # all but built
    for empty in ({}, None):
        with pytest.raises(RuntimeError, match="no land-cover pixels"):
            eng.land_cover_shares(empty)


def test_mann_kendall_matches_a_committed_site() -> None:
    wetland = json.loads((DATA_DIR / "wetland_mx.json").read_text())["ndvi_trend_details"]
    p = eng.mann_kendall(wetland["mann_kendall_tau"], 60)["mann_kendall_p_value"]
    assert p == pytest.approx(wetland["mann_kendall_p_value"], abs=2e-3)
    assert eng.mann_kendall(0.0, 60)["mann_kendall_p_value"] == 1.0


def test_ndvi_summary_sorts_months_and_tests_the_trend() -> None:
    summary = eng.ndvi_summary(ndvi_fixture())
    months = [row["month"] for row in summary["ndvi_series"]]
    assert months == sorted(months) and months[0] == "2021-10" and len(months) == 60
    assert summary["ndvi_mean"] == pytest.approx(0.6 + 0.001 * 53.5)  # the latest 12 months
    assert summary["ndvi_trend"] == 0.01 and summary["cloud_free_obs"] == 40
    assert summary["cloud_free_months_5y"] == 60
    assert summary["ndvi_trend_details"]["significant_05"] is True  # tau 0.2 over 60 months
    weak = eng.ndvi_summary(ndvi_fixture(tau=0.05))
    assert weak["ndvi_trend_details"]["significant_05"] is False
    with pytest.raises(RuntimeError, match="need at least 12"):
        eng.ndvi_summary(ndvi_fixture(months=11))


def test_reduction_results_become_metrics() -> None:
    assert eng.forest_loss_areas({"loss_5y": 25_000.0, "loss_12m": None}) == (2.5, 0.0)
    assert eng.biomass_values({"cci": 80.5, "gedi": None}) == (80.5, None)
    with pytest.raises(RuntimeError, match="ESA CCI"):
        eng.biomass_values({"cci": None, "gedi": 10.0})
    assert eng.mangrove_share({"mangrove": 30.0, "all": 120.0}) == 0.25
    assert eng.mangrove_share({"mangrove": None, "all": 120.0}) == 0.0
    with pytest.raises(RuntimeError, match="no area"):
        eng.mangrove_share({"mangrove": 0.0, "all": 0})
    assert eng.water_change_value({"change_abs": -3.5}) == -3.5
    assert eng.soc_value({"ocs_0-30cm_mean": 61.0}) == 61.0
    for missing in (eng.water_change_value, eng.soc_value):
        with pytest.raises(RuntimeError):
            missing({})
    with pytest.raises(ValueError, match="NaN"):
        eng.round_metrics({"x": [float("nan")]})


@pytest.mark.parametrize("site_key", ["wetland_mx", "mangrove_mx", "restoration_forest"])
def test_assembly_reproduces_the_committed_demo_sites(site_key: str) -> None:
    """The live path writes exactly the precompute's JSON (same code, T11/T13)."""
    committed = json.loads((DATA_DIR / f"{site_key}.json").read_text())
    rebuilt = eng.assemble_metrics(
        site_key=site_key,
        computed_at_utc=committed["computed_at_utc"],
        area_ha=committed["area_ha"],
        centroid_lat=committed["centroid"]["lat"],
        centroid_lon=committed["centroid"]["lon"],
        land_cover=committed["landcover"],
        ndvi={
            key: committed[key]
            for key in (
                "ndvi_series",
                "ndvi_mean",
                "ndvi_trend",
                "ndvi_trend_details",
                "cloud_free_obs",
                "cloud_free_months_5y",
            )
        },
        water_change=committed["water_change"],
        forest_loss=(committed["forest_loss_ha"], committed["forest_loss_last_12m_ha"]),
        biomass=(committed["biomass_t_ha"], committed["biomass_gedi_t_ha"]),
        mangrove_fraction=committed["mangrove_fraction"],
        soc_t_c_ha=committed["soc_t_c_ha"],
    )
    # natural_fraction is recomputed from rounded shares, so it may move in the last digit.
    assert rebuilt.pop("natural_fraction") == pytest.approx(
        committed.pop("natural_fraction"), abs=5e-4
    )
    assert rebuilt == committed


FAKE_KEY = Path(__file__).parent / "fixtures" / "earth_engine" / "fake_service_account.json"


def test_service_account_keys_are_a_path_or_inline_json() -> None:
    key = json.loads(FAKE_KEY.read_text())
    assert eng.service_account_key(str(FAKE_KEY)) == (key, str(FAKE_KEY))
    assert eng.service_account_key(json.dumps(key)) == (key, None)
    with pytest.raises(ValueError, match="not set"):
        eng.service_account_key("  ")


def test_the_current_observation_window_is_the_constants() -> None:
    window = eng.CURRENT_WINDOW
    assert (window.start_12m, window.start_5y, window.end) == (
        eng.START_12M,
        eng.START_5Y,
        eng.END_DATE,
    )
    assert f"{window.loss_first_year}-{window.loss_last_year}" == eng.FOREST_LOSS_YEARS
    assert window.data_version == eng.DATA_VERSION


def test_an_earlier_window_observes_its_own_quarter_and_complete_loss_years() -> None:
    from datetime import date

    april = eng.ObservationWindow.ending(date(2026, 4, 1))
    assert (april.start_12m, april.start_5y, april.data_version) == (
        "2025-04-01",
        "2021-04-01",
        "2026Q1",
    )
    assert (april.loss_first_year, april.loss_last_year) == (2021, 2025)
    october = eng.ObservationWindow.ending(date(2025, 10, 1))
    assert (october.loss_first_year, october.loss_last_year, october.data_version) == (
        2020,
        2024,
        "2025Q3",
    )

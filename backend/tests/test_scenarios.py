"""Time Machine scenario versions (T13): scripted deltas, regenerated offline."""

from __future__ import annotations

import json

import pytest

from app.tools import earth_obs
from app.tools.earth_obs import (
    EarthObsMetrics,
    LandcoverTransfer,
    ScenarioDeltas,
    load_site_metrics,
    scenario_path,
)
from app.tools.scenarios import (
    LANDCOVER_CLASSES,
    NATURAL_CLASSES,
    ScenarioSpec,
    ScenarioVersion,
    apply_landcover_transfers,
    apply_scenario,
    build_site_scenarios,
    load_scenario_spec,
    ndvi_trend,
    round_fractions,
    scale_mangrove_fraction,
    scenario_document,
)

SITE_KEYS = ("wetland_mx", "mangrove_mx", "restoration_forest")
SIMULATED = ("restoration", "encroachment")
# T15 treats a site as a wetland (W counts) when water + flooded vegetation >= 20%.
WETLAND_MIN_WATER_FRACTION = 0.20


def _json_text(document: dict[str, object]) -> str:
    return json.dumps(document, indent=2, sort_keys=True) + "\n"


@pytest.fixture(scope="module")
def spec() -> ScenarioSpec:
    return load_scenario_spec()


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_committed_scenarios_regenerate_byte_for_byte(site_key: str, spec: ScenarioSpec) -> None:
    versions = build_site_scenarios(load_site_metrics(site_key), spec)

    for scenario in SIMULATED:
        committed = scenario_path(site_key, scenario).read_text()
        assert _json_text(scenario_document(versions[scenario])) == committed


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_generation_is_deterministic(site_key: str, spec: ScenarioSpec) -> None:
    baseline = load_site_metrics(site_key)

    first = build_site_scenarios(baseline, spec)
    second = build_site_scenarios(baseline, spec)

    assert first == second


@pytest.mark.parametrize("site_key", SITE_KEYS)
@pytest.mark.parametrize("scenario", SIMULATED)
def test_scenario_land_cover_is_valid(site_key: str, scenario: str) -> None:
    metrics = load_site_metrics(site_key, scenario)  # type: ignore[arg-type]

    assert set(metrics.landcover) == set(LANDCOVER_CLASSES)
    assert all(0 <= share <= 1 for share in metrics.landcover.values())
    assert sum(metrics.landcover.values()) == pytest.approx(1.0, abs=1e-9)
    natural = sum(metrics.landcover[name] for name in NATURAL_CLASSES)
    assert metrics.natural_fraction == pytest.approx(natural, abs=1e-9)


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_scenarios_are_labelled_simulated_with_provenance(site_key: str) -> None:
    baseline = load_site_metrics(site_key)
    restoration = load_site_metrics(site_key, "restoration")
    encroachment = load_site_metrics(site_key, "encroachment")

    assert (baseline.simulated, baseline.scenario, baseline.data_version) == (
        False,
        "baseline",
        "2026Q3",
    )
    assert (restoration.data_version, restoration.based_on, restoration.period) == (
        "sim-1",
        baseline.data_version,
        "2026Q4",
    )
    assert (encroachment.data_version, encroachment.based_on, encroachment.period) == (
        "sim-2",
        "sim-1",
        "2027Q1",
    )
    for version in (restoration, encroachment):
        assert version.simulated is True
        assert version.scenario_deltas is not None
        assert version.scenario_deltas.description
        # Provenance and unchanged observations are carried over from the observed baseline.
        assert version.datasets == baseline.datasets
        assert version.attributions == baseline.attributions
        assert version.date_windows == baseline.date_windows
        assert version.observed_data_version == baseline.data_version
        assert version.provenance_note is not None
        assert "Not an observation" in version.provenance_note
        assert version.area_ha == baseline.area_ha
        assert version.soc_t_c_ha == baseline.soc_t_c_ha
        assert version.cloud_free_obs == baseline.cloud_free_obs
        assert [p.month for p in version.ndvi_series] == [p.month for p in baseline.ndvi_series]


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_scenarios_move_in_the_story_direction(site_key: str) -> None:
    baseline = load_site_metrics(site_key)
    restoration = load_site_metrics(site_key, "restoration")
    encroachment = load_site_metrics(site_key, "encroachment")

    assert restoration.ndvi_mean > baseline.ndvi_mean
    assert restoration.natural_fraction >= baseline.natural_fraction
    assert restoration.forest_loss_ha == baseline.forest_loss_ha
    assert restoration.biomass_t_ha >= baseline.biomass_t_ha

    assert encroachment.ndvi_mean < restoration.ndvi_mean
    assert encroachment.natural_fraction < restoration.natural_fraction
    assert encroachment.forest_loss_ha > restoration.forest_loss_ha
    assert encroachment.biomass_t_ha < restoration.biomass_t_ha


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_scenarios_keep_the_wetland_classification(site_key: str) -> None:
    def is_wetland(scenario: str) -> bool:
        cover = load_site_metrics(site_key, scenario).landcover  # type: ignore[arg-type]
        return cover["water"] + cover["flooded_vegetation"] >= WETLAND_MIN_WATER_FRACTION

    assert is_wetland("restoration") == is_wetland("baseline")
    assert is_wetland("encroachment") == is_wetland("baseline")


@pytest.mark.parametrize("site_key", SITE_KEYS)
def test_pure_ndvi_trend_matches_earth_engine_baseline(site_key: str) -> None:
    baseline = load_site_metrics(site_key)

    trend = ndvi_trend(baseline.ndvi_series)

    # Earth Engine saw unrounded monthly NDVI; the committed series is rounded to 4 dp, which
    # can create a few ties, so allow a small difference.
    expected = baseline.ndvi_trend_details
    assert trend.sens_slope_per_year == pytest.approx(expected.sens_slope_per_year, abs=2e-4)
    assert trend.mann_kendall_tau == pytest.approx(expected.mann_kendall_tau, abs=1e-3)
    assert trend.mann_kendall_p_value == pytest.approx(expected.mann_kendall_p_value, abs=2e-3)
    assert trend.mean_last_12_months == pytest.approx(baseline.ndvi_mean, abs=1e-4)


def test_transfers_take_proportionally_and_count_tree_loss() -> None:
    cover = {name: 0.0 for name in LANDCOVER_CLASSES} | {"trees": 0.6, "grass": 0.2, "built": 0.2}
    deltas = ScenarioDeltas(
        description="clearing",
        landcover_transfers=(
            LandcoverTransfer.model_validate({"from": ["trees", "grass"], "to": "crops", "pp": 8}),
        ),
    )

    result = apply_landcover_transfers(cover, deltas)

    assert result.landcover["trees"] == pytest.approx(0.54)
    assert result.landcover["grass"] == pytest.approx(0.18)
    assert result.landcover["crops"] == pytest.approx(0.08)
    assert result.trees_removed == pytest.approx(0.06)
    assert result.mangrove_retained == pytest.approx(0.9)  # 6 of 60 pp of host cover cleared


def test_transfer_larger_than_its_sources_is_rejected() -> None:
    cover = {name: 0.0 for name in LANDCOVER_CLASSES} | {"trees": 0.97, "built": 0.03}
    deltas = ScenarioDeltas(
        description="too much",
        landcover_transfers=(
            LandcoverTransfer.model_validate({"from": ["built"], "to": "trees", "pp": 5}),
        ),
    )

    with pytest.raises(ValueError, match="exceeds"):
        apply_landcover_transfers(cover, deltas)


def test_round_fractions_sums_to_exactly_one() -> None:
    shares = round_fractions({"a": 1 / 3, "b": 1 / 3, "c": 1 / 3})

    assert sum(round(value * 10_000) for value in shares.values()) == 10_000
    assert sorted(shares.values()) == [0.3333, 0.3333, 0.3334]


def test_cleared_trees_become_forest_loss_in_both_windows() -> None:
    baseline = load_site_metrics("restoration_forest")
    deltas = ScenarioDeltas(
        description="clear 5 pp of trees",
        landcover_transfers=(
            LandcoverTransfer.model_validate({"from": ["trees"], "to": "bare", "pp": 5}),
        ),
        extra_forest_loss_ha=1.0,
    )
    version = ScenarioVersion(
        scenario="encroachment", period="2026Q4", data_version="sim-9", based_on="baseline"
    )

    result = apply_scenario(baseline, deltas, version)

    added = 0.05 * baseline.area_ha + 1.0
    assert baseline.forest_loss_last_12m_ha is not None
    assert result.forest_loss_ha == pytest.approx(baseline.forest_loss_ha + added, abs=1e-3)
    assert result.forest_loss_last_12m_ha == pytest.approx(
        baseline.forest_loss_last_12m_ha + added, abs=1e-3
    )
    assert result.data_version == "sim-9"
    assert result.simulated is True


def test_spec_rejects_a_site_without_every_scenario(spec: ScenarioSpec) -> None:
    data = json.loads(spec.model_dump_json(by_alias=True))
    del data["sites"]["wetland_mx"]["encroachment"]

    with pytest.raises(ValueError, match="must define deltas"):
        ScenarioSpec.model_validate(data)


def test_spec_rejects_a_timeline_not_starting_at_baseline(spec: ScenarioSpec) -> None:
    data = json.loads(spec.model_dump_json(by_alias=True))
    data["timeline"] = data["timeline"][1:]

    with pytest.raises(ValueError, match="start with the observed baseline"):
        ScenarioSpec.model_validate(data)


def test_unknown_scenario_file_raises_clear_error() -> None:
    with pytest.raises(ValueError, match="No cached Earth observation metrics"):
        load_site_metrics("missing_site", "restoration")
    with pytest.raises(ValueError, match="Invalid site key"):
        load_site_metrics("../wetland_mx")


# --- Mangrove fraction (GMW) ---


@pytest.mark.parametrize("site_key", SITE_KEYS)
@pytest.mark.parametrize("scenario", SIMULATED)
def test_scenario_mangrove_never_exceeds_trees_plus_flooded_vegetation(
    site_key: str, scenario: str
) -> None:
    metrics = load_site_metrics(site_key, scenario)  # type: ignore[arg-type]

    host = metrics.landcover["trees"] + metrics.landcover["flooded_vegetation"]
    assert metrics.mangrove_fraction is not None
    assert 0 <= metrics.mangrove_fraction <= host + 1e-9


def test_mangrove_encroachment_scales_the_mangrove_fraction() -> None:
    restoration = load_site_metrics("mangrove_mx", "restoration")
    encroachment = load_site_metrics("mangrove_mx", "encroachment")

    def host(cover: dict[str, float]) -> float:
        return cover["trees"] + cover["flooded_vegetation"]

    assert restoration.mangrove_fraction is not None
    assert encroachment.mangrove_fraction is not None
    expected = (
        restoration.mangrove_fraction * host(encroachment.landcover) / host(restoration.landcover)
    )
    assert encroachment.mangrove_fraction == pytest.approx(expected, abs=2e-4)
    assert encroachment.mangrove_fraction < restoration.mangrove_fraction


def test_mangrove_fraction_is_capped_and_never_grows() -> None:
    cover = {name: 0.0 for name in LANDCOVER_CLASSES} | {
        "trees": 0.5,
        "flooded_vegetation": 0.3,
        "grass": 0.2,
    }

    gain = apply_landcover_transfers(
        cover,
        ScenarioDeltas(
            description="replanting",
            landcover_transfers=(
                LandcoverTransfer.model_validate(
                    {"from": ["grass"], "to": "flooded_vegetation", "pp": 10}
                ),
            ),
        ),
    )
    loss = apply_landcover_transfers(
        cover,
        ScenarioDeltas(
            description="clearing",
            landcover_transfers=(
                LandcoverTransfer.model_validate(
                    {"from": ["trees", "flooded_vegetation"], "to": "bare", "pp": 40}
                ),
            ),
        ),
    )

    assert gain.mangrove_retained == 1.0
    assert scale_mangrove_fraction(0.8, gain.mangrove_retained, gain.landcover) == 0.8
    assert loss.mangrove_retained == pytest.approx(0.5)
    assert scale_mangrove_fraction(0.8, loss.mangrove_retained, loss.landcover) == (
        pytest.approx(0.4)
    )
    # An observed GMW share above the Dynamic World host cover is capped once deltas apply.
    assert scale_mangrove_fraction(0.95, 1.0, cover) == pytest.approx(0.8)
    assert scale_mangrove_fraction(None, 0.5, cover) is None


# --- Simulated-label guards ---


def test_simulated_flag_must_match_the_scenario() -> None:
    data = load_site_metrics("wetland_mx", "restoration").model_dump(mode="json", by_alias=True)

    with pytest.raises(ValueError, match="simulated must be true"):
        EarthObsMetrics.model_validate(data | {"simulated": False})
    with pytest.raises(ValueError, match="based_on"):
        EarthObsMetrics.model_validate(data | {"based_on": None})


def test_observed_metrics_cannot_carry_simulation_fields() -> None:
    data = load_site_metrics("wetland_mx").model_dump(mode="json")

    with pytest.raises(ValueError, match="simulated must be true"):
        EarthObsMetrics.model_validate(data | {"simulated": True})
    with pytest.raises(ValueError, match="can't carry simulation fields"):
        EarthObsMetrics.model_validate(data | {"based_on": "2026Q2"})


def test_loader_rejects_a_file_for_another_scenario(monkeypatch: pytest.MonkeyPatch) -> None:
    real_path = earth_obs.scenario_path
    monkeypatch.setattr(
        earth_obs, "scenario_path", lambda site_key, _scenario: real_path(site_key, "restoration")
    )

    with pytest.raises(ValueError, match="not 'wetland_mx'/'encroachment'"):
        earth_obs.load_site_metrics("wetland_mx", "encroachment")

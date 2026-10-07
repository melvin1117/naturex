"""Valuation engine (T14, dev-spec §7.3): cited tables, class mapping, money and carbon."""

from __future__ import annotations

import csv
import io
import random
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.tools.earth_obs import load_site_metrics
from app.tools.valuation import (
    CARBON_FRACTION,
    DW_CLASSES,
    METHODS_VERSION,
    PRICE_BASIS,
    SERVICE_GROUPS,
    SOURCES,
    CoefficientTableError,
    ValuationInputs,
    ValuationResult,
    biome_for,
    default_coefficient_table,
    inputs_from_metrics,
    largest_remainder,
    parse_coefficient_table,
    value_metrics,
    value_site,
)

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
TABLE = default_coefficient_table()
CO2 = CARBON_FRACTION * Decimal(44) / Decimal(12)


def _csv(name: str) -> str:
    return (DATA_DIR / name).read_text(encoding="utf-8")


def _rows(name: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(_csv(name))))


def site(
    landcover: dict[str, Any],
    *,
    area_ha: Any = 100,
    lat: Any = 0,
    coast_km: Any = 100,
    biomass: Any = 0,
    soc: Any = None,
    **extra: Any,
) -> ValuationInputs:
    return ValuationInputs.model_validate(
        {
            "area_ha": area_ha,
            "lat": lat,
            "lon": 0,
            "landcover": landcover,
            "biomass_t_ha": biomass,
            "coast_distance_km": coast_km,
            "soc_t_c_ha": soc,
            **extra,
        }
    )


def run(inputs: ValuationInputs) -> ValuationResult:
    return value_site(inputs, TABLE)


# --- The cited tables ---------------------------------------------------------------------

BRANDER_TABLE_1_SUM = {
    "tidal_marsh_mangrove": 77_928,  # column "Mangroves"
    "swamp_floodplain": 34_018,  # "Inland wetlands"
    "lake_river": 33_447,  # "Rivers and lakes"
    "tropical_forest": 8_166,  # "Tropical & sub-tropical forests"
    "temperate_forest": 15_570,  # "Temperate forest and woodland"
    "grassland": 5_934,  # "Rangeland, natural grasslands & savannas"
    "shrubland": 728,  # "Shrubland and shrubby woodland"
    "not_valued": 0,
}


def test_mid_coefficients_are_brander_2024_table_1_totals() -> None:
    assert {b: int(c.mid) for b, c in TABLE.biomes.items()} == BRANDER_TABLE_1_SUM


@pytest.mark.parametrize("row", _rows("coefficients.csv"), ids=lambda r: r["biome_id"])
def test_coefficient_rows_are_ordered_cited_and_in_one_price_basis(row: dict[str, str]) -> None:
    low, mid, high = (Decimal(row[f"value_{k}"]) for k in ("low", "mid", "high"))
    assert 0 <= low <= mid <= high
    assert row["price_basis"] == PRICE_BASIS
    if mid > 0:
        assert row["value_source_id"] == "brander2024"
        assert "Table 1" in row["value_ref"]
        assert row["spread_source_id"] == "costanza2014"
        assert "Table 4" in row["spread_ref"]
        # low = mid × published median/mean; high mirrors it (mid ± the median–mean spread).
        ratio = Decimal(row["median_mean_ratio_num"]) / Decimal(row["median_mean_ratio_den"])
        assert low == (mid * ratio).quantize(Decimal(1), ROUND_HALF_EVEN)
        assert high == 2 * mid - low


def test_only_shrubland_uses_a_fallback_spread() -> None:
    fallback = {b for b, c in TABLE.biomes.items() if not c.spread_verified}
    assert fallback == {"shrubland"}
    assert all(c.value_verified for c in TABLE.biomes.values())


def test_every_csv_row_shares_one_price_basis() -> None:
    for name in ("coefficients.csv", "service_values.csv"):
        assert {r["price_basis"] for r in _rows(name)} == {PRICE_BASIS}


@pytest.mark.parametrize("biome_id", [b for b, v in BRANDER_TABLE_1_SUM.items() if v])
def test_service_shares_sum_to_one_and_match_the_published_total(biome_id: str) -> None:
    services = TABLE.services[biome_id]
    total = sum(s.value for s in services)
    assert abs(total - TABLE.biomes[biome_id].mid) < 1
    shares = sum(s.value / total for s in services)
    assert abs(shares - 1) < Decimal("1e-20")
    assert {s.group for s in services} <= set(SERVICE_GROUPS)
    assert all(s.ref.startswith("Brander et al. 2024") for s in services)


def test_carbon_factor_rows_cover_every_class_zone_and_coast_once() -> None:
    for dw_class in DW_CLASSES:
        for zone in ("tropical", "extratropical"):
            for coastal in (True, False):
                TABLE.carbon_factor(dw_class, zone, coastal)  # raises unless exactly one
    for row in _rows("carbon_factors.csv"):
        if Decimal(row["root_shoot_ratio"]) > 0:
            assert row["r_source_id"] in SOURCES and "Table" in row["r_ref"]
        if Decimal(row["agb_growth_t_dm_ha_yr"]) > 0:
            assert row["growth_source_id"] in SOURCES and "Table" in row["growth_ref"]


def _broken(name: str, old: str, new: str) -> dict[str, str]:
    texts = {
        "coefficients": _csv("coefficients.csv"),
        "services": _csv("service_values.csv"),
        "carbon": _csv("carbon_factors.csv"),
    }
    assert old in texts[name]
    texts[name] = texts[name].replace(old, new, 1)
    return texts


@pytest.mark.parametrize(
    ("name", "old", "new"),
    [
        ("coefficients", "4890,77928,150966", "80000,77928,150966"),  # low > mid
        ("coefficients", "4890,77928,150966,Int$2020/ha/yr", "4890,77928,150966,US$2007/ha/yr"),
        ("coefficients", "brander2024", "esvd_raw"),  # unknown source
        (
            "services",
            "source_id,ref\n",
            "source_id,ref\nmangrove_x,Food,food_and_materials,1,1,Int$2020/ha/yr,brander2024,x\n",
        ),
        ("services", ",food_and_materials,", ",bogus_group,"),
        ("services", "Int$2020/ha/yr", "Int$2007/ha/yr"),
        ("carbon", "trees,tropical,any,0.20", "trees,tropical,any,-0.20"),
        ("carbon", "water,any,any", "water,tropical,any"),  # leaves a gap
        ("carbon", "ipcc2006_v4", "made_up"),
    ],
)
def test_invalid_tables_are_rejected(name: str, old: str, new: str) -> None:
    with pytest.raises((CoefficientTableError, ValueError)):
        parse_coefficient_table(**_broken(name, old, new))


def test_service_totals_must_match_the_biome_total() -> None:
    texts = _broken("services", ",food_and_materials,6791,", ",food_and_materials,9791,")
    with pytest.raises(CoefficientTableError, match="service means sum"):
        parse_coefficient_table(**texts)


# --- Class → biome mapping ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("dw_class", "lat", "coastal", "biome"),
    [
        ("flooded_vegetation", "19.3", False, "swamp_floodplain"),
        ("flooded_vegetation", "21.5", True, "tidal_marsh_mangrove"),
        ("flooded_vegetation", "50", True, "tidal_marsh_mangrove"),
        ("water", "0", True, "lake_river"),
        ("trees", "0", False, "tropical_forest"),
        ("trees", "23.49", False, "tropical_forest"),
        ("trees", "-23.49", False, "tropical_forest"),
        ("trees", "23.5", False, "temperate_forest"),
        ("trees", "-45", False, "temperate_forest"),
        ("grass", "0", False, "grassland"),
        ("shrub_and_scrub", "0", False, "shrubland"),
        ("crops", "0", False, "not_valued"),
        ("built", "0", False, "not_valued"),
        ("bare", "0", False, "not_valued"),
        ("snow_and_ice", "0", False, "not_valued"),
    ],
)
def test_class_to_biome(dw_class: Any, lat: str, coastal: bool, biome: str) -> None:
    assert biome_for(dw_class, Decimal(lat), coastal) == biome


@pytest.mark.parametrize(
    ("km", "biome"), [("4.999", "tidal_marsh_mangrove"), ("5.001", "swamp_floodplain")]
)
def test_coastal_threshold_switches_wetland_biome(km: str, biome: str) -> None:
    result = run(site({"flooded_vegetation": 1}, coast_km=km))
    wetland = next(c for c in result.classes if c.dw_class == "flooded_vegetation")
    assert wetland.biome_id == biome
    assert result.coastal.is_coastal is (biome == "tidal_marsh_mangrove")
    assert result.coastal.distance_km == Decimal(km)


@pytest.mark.parametrize("dw_class", ["crops", "built", "bare", "snow_and_ice"])
def test_zero_value_classes_contribute_nothing(dw_class: str) -> None:
    result = run(site({dw_class: 1}, biomass=50))
    assert (result.value_low, result.value_mid, result.value_high) == (0, 0, 0)
    assert all(s.value_mid == 0 for s in result.services)
    assert all(c.value_mid == 0 for c in result.classes)


# --- Money --------------------------------------------------------------------------------


@pytest.mark.parametrize(("dw_class", "coeff"), [("water", 33_447), ("grass", 5_934)])
def test_single_class_site_is_area_times_coefficient(dw_class: str, coeff: int) -> None:
    result = run(site({dw_class: 1}, area_ha=100))
    assert result.value_mid == 100 * coeff


@pytest.mark.parametrize("factor", [2, 3, 10])
def test_value_scales_linearly_with_area(factor: int) -> None:
    landcover = {"water": "0.25", "trees": "0.5", "grass": "0.25"}
    one = run(site(landcover, area_ha=40))
    many = run(site(landcover, area_ha=40 * factor))
    for level in ("value_low", "value_mid", "value_high"):
        assert getattr(many, level) == factor * getattr(one, level)


def test_context_multiplier_defaults_to_one_and_scales_values() -> None:
    inputs = site({"water": 1}, area_ha=10)
    assert inputs.context_multiplier == 1
    assert run(inputs).context_multiplier == 1
    doubled = run(site({"water": 1}, area_ha=10, context_multiplier="2"))
    assert doubled.value_mid == 2 * run(inputs).value_mid
    with pytest.raises(ValidationError):
        site({"water": 1}, context_multiplier=0)


def test_fractions_within_tolerance_are_renormalised_and_flagged() -> None:
    result = run(site({"water": "0.5", "grass": "0.495"}, area_ha=100))
    assert result.landcover_renormalised
    assert "landcover_renormalised" in result.flags
    assert result.landcover_sum == Decimal("0.995")
    expected = 100 * (Decimal("0.5") * 33_447 + Decimal("0.495") * 5_934) / Decimal("0.995")
    assert result.value_mid == int(expected.quantize(Decimal(1), ROUND_HALF_EVEN))


@pytest.mark.parametrize("grass", ["0.48", "0.52", "0"])
def test_fractions_far_from_one_are_rejected(grass: str) -> None:
    with pytest.raises(ValidationError, match="sum to"):
        site({"water": "0.5", "grass": grass})


def test_missing_classes_count_as_zero_and_unknown_classes_are_rejected() -> None:
    assert run(site({"water": 1})).classes[0].share == 1
    with pytest.raises(ValidationError):
        site({"water": "0.5", "forest": "0.5"})


@pytest.mark.parametrize(
    "bad",
    [
        {"area_ha": -1},
        {"area_ha": 0},
        {"area_ha": float("nan")},
        {"area_ha": float("inf")},
        {"lat": 91},
        {"lat": float("nan")},
        {"biomass": -1},
        {"biomass": float("nan")},
        {"soc": -5},
        {"soc": float("nan")},
        {"coast_km": -0.1},
        {"landcover": {"water": "1.1", "grass": "-0.1"}},
        {"landcover": {"water": float("nan")}},
    ],
)
def test_negative_or_nan_inputs_are_rejected(bad: dict[str, Any]) -> None:
    landcover = bad.pop("landcover", {"water": 1})
    with pytest.raises(ValidationError):
        site(landcover, **bad)


SEEDED_SITES = []
for seed in range(40):
    rng = random.Random(seed)
    weights = [rng.random() ** 2 for _ in DW_CLASSES]
    total = sum(weights)
    fractions = {c: round(w / total, 4) for c, w in zip(DW_CLASSES, weights, strict=True)}
    SEEDED_SITES.append(
        site(
            fractions,
            area_ha=round(rng.uniform(5, 50_000), 4),
            lat=round(rng.uniform(-60, 60), 4),
            coast_km=round(rng.uniform(0, 20), 3),
            biomass=round(rng.uniform(0, 300), 2),
        )
    )


@pytest.mark.parametrize("inputs", SEEDED_SITES)
def test_breakdowns_sum_exactly_to_the_totals(inputs: ValuationInputs) -> None:
    result = run(inputs)
    assert sum(s.value_mid for s in result.services) == result.value_mid
    assert [s.group for s in result.services] == list(SERVICE_GROUPS)
    for level in ("value_low", "value_mid", "value_high"):
        assert sum(getattr(c, level) for c in result.classes) == getattr(result, level)
    assert result.value_low <= result.value_mid <= result.value_high
    assert all(s.value_mid >= 0 for s in result.services)


def test_largest_remainder_is_exact_and_breaks_ties_by_name() -> None:
    parts = {"b": Decimal("0.5"), "a": Decimal("0.5"), "c": Decimal("0.5")}
    assert largest_remainder(parts, 2) == {"a": 1, "b": 1, "c": 0}
    parts = {"x": Decimal("10.2"), "y": Decimal("5.7"), "z": Decimal("0.1")}
    assert largest_remainder(parts, 16) == {"x": 10, "y": 6, "z": 0}
    with pytest.raises(ValueError):
        largest_remainder(parts, 30)


def test_carbon_is_never_in_the_dollar_total() -> None:
    base = run(site({"trees": 1}, biomass=0))
    heavy = run(site({"trees": 1}, biomass=400))
    assert heavy.carbon.total_stock_tco2 > 0
    assert (heavy.value_low, heavy.value_mid, heavy.value_high) == (
        base.value_low,
        base.value_mid,
        base.value_high,
    )
    assert heavy.carbon_included_in_value is False
    # Climate regulation stays inside the ESV as its Brander share, no more: 748 of the
    # 8,166.09 Int$/ha/yr that Table 1's tropical-forest cells add up to.
    climate = next(s for s in heavy.services if s.group == "climate_regulation")
    assert climate.value_mid == _whole(Decimal(100 * 8_166 * 748) / Decimal("8166.09"))


def test_wetland_soc_does_not_change_the_dollar_total() -> None:
    without = run(site({"flooded_vegetation": 1}, soc=None))
    with_soc = run(site({"flooded_vegetation": 1}, soc=80))
    assert with_soc.value_mid == without.value_mid
    assert with_soc.carbon.soc_stock_tco2 and with_soc.carbon.soc_stock_tco2 > 0


# --- Carbon -------------------------------------------------------------------------------


def _whole(value: Decimal) -> int:
    return int(value.quantize(Decimal(1), ROUND_HALF_EVEN))


def test_carbon_formula_tropical_forest_by_hand() -> None:
    # 100 ha of tropical trees, AGB 100 t/ha. R = 0.20 (IPCC 2006 T4.4), G = 2.0 (T4.9).
    result = run(site({"trees": 1}, area_ha=100, biomass=100))
    assert result.carbon.root_shoot_ratio == Decimal("0.2000")
    assert result.carbon.biomass_stock_tco2 == _whole(Decimal(100 * Decimal("1.2") * 100) * CO2)
    assert result.carbon.biomass_stock_tco2 == 20_680  # 12,000 t d.m. × 0.47 × 44/12
    assert result.carbon.sequestration_tco2_yr == 414  # 100 × 2.0 × 1.2 × 0.47 × 44/12 = 413.6
    assert result.carbon.soc_stock_tco2 == 0
    assert result.carbon.total_stock_tco2 == 20_680


def test_carbon_formula_temperate_forest_by_hand() -> None:
    # R = 0.29 (T4.4), G = 4.0 (T4.9): 50 × 80 × 1.29 × 1.72333 = 8,892.4; 50 × 4 × 1.29 × ...
    result = run(site({"trees": 1}, area_ha=50, lat=45, biomass=80))
    assert result.carbon.biomass_stock_tco2 == 8_892
    assert result.carbon.sequestration_tco2_yr == 445  # 444.6


def test_carbon_inland_wetland_adds_soc_separately() -> None:
    # Inland flooded vegetation: no Tier 1 R, so roots are excluded; SOC = 50 t C/ha.
    result = run(site({"flooded_vegetation": 1}, area_ha=10, biomass=10, soc=50))
    assert result.carbon.biomass_stock_tco2 == 172  # 10 × 10 × 0.47 × 44/12 = 172.3
    assert result.carbon.soc_stock_tco2 == 1_833  # 50 × 10 × 44/12 = 1,833.3
    assert result.carbon.total_stock_tco2 == 2_005
    assert result.carbon.soc_included
    assert result.carbon.sequestration_tco2_yr == 0
    assert "soilgrids" in result.source_ids


def test_carbon_coastal_mangrove_and_missing_soc_flag() -> None:
    # Coastal tropical: R = 0.492 (WS 2013 T4.5), G = 9.9 (T4.4), Tropical Wet.
    result = run(site({"flooded_vegetation": 1}, area_ha=10, lat="21.5", coast_km=1, biomass=100))
    assert result.carbon.biomass_stock_tco2 == 2_571  # 100 × 1.492 × 10 × 1.72333 = 2,571.2
    assert result.carbon.sequestration_tco2_yr == 255  # 10 × 9.9 × 1.492 × 1.72333 = 254.6
    assert result.carbon.soc_stock_tco2 is None
    assert not result.carbon.soc_included
    assert result.carbon.total_stock_tco2 == 2_571
    assert "soc_missing" in result.flags
    assert "ipcc2013_wetlands" in result.source_ids


def test_effective_root_shoot_ratio_is_vegetated_area_weighted() -> None:
    # 50% tropical trees (R 0.20) + 25% tropical grass (R 1.6) + 25% water (not vegetated).
    result = run(site({"trees": "0.5", "grass": "0.25", "water": "0.25"}, biomass=10))
    assert result.carbon.root_shoot_ratio == Decimal("0.6667")  # (0.5×0.2 + 0.25×1.6) / 0.75


def test_soc_is_not_needed_without_wetland() -> None:
    result = run(site({"trees": 1}, biomass=10, soc=None))
    assert "soc_missing" not in result.flags
    assert result.carbon.soc_stock_tco2 == 0


# --- Worked example: the hero wetland (dev-spec §7.3) -------------------------------------


def test_worked_example_hero_wetland() -> None:
    metrics = load_site_metrics("wetland_mx")
    inputs = inputs_from_metrics(metrics)
    assert inputs.area_ha == Decimal("206.6995")
    assert inputs.biomass_t_ha == Decimal("9.4681")
    assert inputs.soc_t_c_ha is None
    result = value_site(inputs, TABLE)

    assert not result.coastal.is_coastal
    assert result.coastal.distance_km == Decimal("253.354")
    assert (result.value_low, result.value_mid, result.value_high) == (
        2_121_067,
        2_669_511,
        3_217_955,
    )
    by_class = {
        c.dw_class: (c.biome_id, c.value_low, c.value_mid, c.value_high) for c in result.classes
    }
    assert by_class == {
        "water": ("lake_river", 1_584_891, 1_717_308, 1_849_724),
        "trees": ("tropical_forest", 269_863, 603_258, 936_653),
        "grass": ("grassland", 118_022, 125_599, 133_177),
        "flooded_vegetation": ("swamp_floodplain", 133_997, 208_133, 282_268),
        "crops": ("not_valued", 0, 0, 0),
        "shrub_and_scrub": ("shrubland", 14_294, 15_213, 16_133),
        "built": ("not_valued", 0, 0, 0),
        "bare": ("not_valued", 0, 0, 0),
        "snow_and_ice": ("not_valued", 0, 0, 0),
    }
    assert {s.group: s.value_mid for s in result.services} == {
        "food_and_materials": 119_266,
        "water_supply": 461_645,
        "climate_regulation": 78_398,
        "flood_and_hazard_regulation": 548_143,
        "pollution_and_soil": 186_468,
        "habitat_and_biodiversity": 112_589,
        "recreation_and_culture": 554_083,
        "existence_and_bequest": 608_919,
    }
    assert result.carbon.root_shoot_ratio == Decimal("0.8779")
    assert result.carbon.biomass_stock_tco2 == 6_334
    assert result.carbon.soc_stock_tco2 is None
    assert result.carbon.total_stock_tco2 == 6_334
    assert result.carbon.sequestration_tco2_yr == 306
    assert result.carbon.wetland_area_ha == Decimal("6.1183")
    assert result.flags == ("soc_missing", "spread_fallback:shrubland")
    assert result.source_ids == ("brander2024", "costanza2014", "ipcc2006_v4", "naturalearth_10m")
    assert result.unit == "Int$2020/yr"
    assert result.methods_version == METHODS_VERSION

    # The mid total, re-derived by hand: Σ area × share × Brander mean.
    area = Decimal("206.6995")
    hand = area * (
        Decimal("0.2484") * 33_447
        + Decimal("0.3574") * 8_166
        + Decimal("0.1024") * 5_934
        + Decimal("0.0296") * 34_018
        + Decimal("0.1011") * 728
    )
    assert result.value_mid == _whole(hand)


def test_worked_example_with_illustrative_soc() -> None:
    # Illustrative only: 50 t C/ha is NOT a SoilGrids value for this site (T13 adds it).
    result = value_metrics(load_site_metrics("wetland_mx"), soc_t_c_ha=50.0)
    assert result.carbon.soc_stock_tco2 == 1_122  # 50 × 6.1183 ha × 44/12 = 1,121.7
    assert result.carbon.total_stock_tco2 == 6_334 + 1_122
    assert "soc_missing" not in result.flags
    assert result.value_mid == 2_669_511


# --- Determinism --------------------------------------------------------------------------


def test_valuation_is_deterministic() -> None:
    metrics = load_site_metrics("wetland_mx")
    first = value_metrics(metrics)
    second = value_metrics(metrics)
    assert first == second
    assert first.model_dump_json() == second.model_dump_json()

    landcover = dict(metrics.landcover)
    shuffled = dict(reversed(list(landcover.items())))
    inputs = inputs_from_metrics(metrics)
    reordered = inputs.model_copy(update={"landcover": {k: inputs.landcover[k] for k in shuffled}})
    assert value_site(reordered, TABLE) == first

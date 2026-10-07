"""Precompute Earth Engine metrics for committed demo-site GeoJSON files.

Run from the repository root with:

    cd backend && PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api \
      python ../scripts/precompute_sites.py

Use ``--check`` to recompute and compare against committed JSON without rewriting it.
Earth Engine is intentionally used only by this offline script; the runtime app loads
the cached JSON through ``app.tools.earth_obs``.

After the observed sites, the script regenerates the Time Machine scenario variants
(``backend/data/demo_sites/scenarios/``) from the committed baselines and
``scenarios.json`` with the pure functions in ``app.tools.scenarios`` (T13). Add
``--scenarios-only`` to skip Earth Engine and only regenerate (or ``--check``) those.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.tools.earth_obs import SCENARIO_DIR, EarthObsMetrics, scenario_path
from app.tools.geometry import validate_polygon
from app.tools.scenarios import build_site_scenarios, load_scenario_spec, scenario_document

ee: Any

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "backend" / "data" / "demo_sites"

DATA_VERSION = "2026Q3"
END_DATE = "2026-10-01"
START_12M = "2025-10-01"
START_5Y = "2021-10-01"
FOREST_LOSS_YEARS = "2021-2025"
FOREST_LOSS_LAST_12M_YEAR = "2025"
ESA_CCI_BIOMASS_YEAR_START = "2022-01-01"
ESA_CCI_BIOMASS_YEAR_END = "2023-01-01"
BIOMASS_WINDOWS = {
    "gedi_l4b": ("gedi_l4b_biomass", {"start": "2019-04-18", "end": "2021-08-04"}),
    "esa_cci_biomass": ("esa_cci_biomass", {"start": "2022-01-01", "end": "2022-12-31"}),
}
BIOMASS_SCALES = {
    "gedi_l4b": ("gedi_biomass_scale_m", 1000),
    "esa_cci_biomass": ("esa_cci_biomass_scale_m", 100),
}
CLOUD_SCORE_THRESHOLD = 0.60
CLOUD_FREE_MIN_CLEAR_FRACTION = 0.50
HANSEN_TREE_COVER_MIN_PERCENT = 30

CLASSES = [
    "water",
    "trees",
    "grass",
    "flooded_vegetation",
    "crops",
    "shrub_and_scrub",
    "built",
    "bare",
    "snow_and_ice",
]
NATURAL_CLASSES = {"water", "trees", "grass", "flooded_vegetation", "shrub_and_scrub"}

ATTRIBUTIONS = {
    "dynamic_world": (
        "Dynamic World: This dataset is produced for the Dynamic World Project by Google "
        "in partnership with National Geographic Society and the World Resources Institute."
    ),
    "sentinel_2": "Contains modified Copernicus Sentinel data 2021-2026.",
    "cloud_score_plus": (
        "Cloud Score+: Pasquarella, V. J., Brown, C. F., Czerwinski, W., & Rucklidge, "
        "W. J. (2023). Comprehensive quality assessment of optical satellite imagery "
        "using weakly supervised video learning."
    ),
    "jrc": (
        "JRC Global Surface Water: EC JRC/Google; Pekel et al. (2016), High-resolution "
        "mapping of global surface water and its long-term changes, Nature."
    ),
    "hansen": (
        "Hansen Global Forest Change: Hansen et al. (2013), High-Resolution Global Maps "
        "of 21st-Century Forest Cover Change, Science."
    ),
    "gedi": (
        "GEDI L4B: Dubayah et al. (2022), GEDI L4B Gridded Aboveground Biomass Density, "
        "Version 2, ORNL DAAC."
    ),
    "esa_cci_biomass": (
        "ESA CCI Biomass: Santoro, M.; Cartus, O. (2025), ESA Biomass Climate Change "
        "Initiative (Biomass_cci): Global datasets of forest above-ground biomass, v6.0, "
        "NERC EDS Centre for Environmental Data Analysis, "
        "doi:10.5285/95913ffb6467447ca72c4e9d8cf30501."
    ),
    "soilgrids": (
        "SoilGrids 2.0 (CC BY 4.0): ISRIC - World Soil Information; Poggio et al. (2021), "
        "SoilGrids 2.0: producing soil information for the globe with quantified spatial "
        "uncertainty, SOIL 7, 217-240."
    ),
}

DATASETS = [
    {
        "key": "dynamic_world",
        "dataset_id": "GOOGLE/DYNAMICWORLD/V1",
        "version": "V1",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1",
        "bands": ["label"],
        "attribution": ATTRIBUTIONS["dynamic_world"],
    },
    {
        "key": "sentinel_2_sr",
        "dataset_id": "COPERNICUS/S2_SR_HARMONIZED",
        "version": "HARMONIZED",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED",
        "bands": ["B8", "B4"],
        "attribution": ATTRIBUTIONS["sentinel_2"],
    },
    {
        "key": "cloud_score_plus",
        "dataset_id": "GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED",
        "version": "V1",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_CLOUD_SCORE_PLUS_V1_S2_HARMONIZED",
        "bands": ["cs_cdf"],
        "attribution": ATTRIBUTIONS["cloud_score_plus"],
    },
    {
        "key": "jrc_global_surface_water",
        "dataset_id": "JRC/GSW1_4/GlobalSurfaceWater",
        "version": "v1.4",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater",
        "bands": ["change_abs"],
        "attribution": ATTRIBUTIONS["jrc"],
    },
    {
        "key": "hansen_global_forest_change",
        "dataset_id": "UMD/hansen/global_forest_change_2025_v1_13",
        "version": "2025 v1.13",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/UMD_hansen_global_forest_change_2025_v1_13",
        "bands": ["lossyear", "treecover2000"],
        "attribution": ATTRIBUTIONS["hansen"],
    },
    {
        "key": "gedi_l4b",
        "dataset_id": "LARSE/GEDI/GEDI04_B_002",
        "version": "Version 2",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/LARSE_GEDI_GEDI04_B_002",
        "bands": ["MU"],
        "attribution": ATTRIBUTIONS["gedi"],
    },
    {
        "key": "esa_cci_biomass",
        "dataset_id": "ESA/CCI/Above_Ground_Biomass/V6_0",
        "version": "v6.0 (2022 map)",
        "catalog_url": "https://developers.google.com/earth-engine/datasets/catalog/ESA_CCI_Above_Ground_Biomass_V6_0",
        "bands": ["agb"],
        "attribution": ATTRIBUTIONS["esa_cci_biomass"],
    },
    {
        "key": "soilgrids_ocs",
        "dataset_id": "projects/soilgrids-isric/ocs_mean",
        "version": "SoilGrids 2.0 (published 2020-05-04)",
        "catalog_url": "https://gee-community-catalog.org/projects/isric/",
        "bands": ["ocs_0-30cm_mean"],
        "attribution": ATTRIBUTIONS["soilgrids"],
    },
]


def _init_ee() -> None:
    global ee
    import ee as earth_engine

    ee = earth_engine
    settings = get_settings()
    key_path = Path(settings.ee_service_account_json).expanduser()
    key = json.loads(key_path.read_text())
    credentials = ee.ServiceAccountCredentials(key["client_email"], str(key_path))
    ee.Initialize(credentials, project=key["project_id"])


def _geometry_from_feature(geojson: Mapping[str, Any]) -> Mapping[str, Any]:
    if geojson.get("type") == "Feature":
        geometry = geojson.get("geometry")
        if not isinstance(geometry, Mapping):
            raise ValueError("GeoJSON Feature has no geometry object.")
        return geometry
    return geojson


def _load_existing_timestamp(site_key: str) -> str | None:
    path = DATA_DIR / f"{site_key}.json"
    if not path.exists():
        return None
    existing = json.loads(path.read_text())
    timestamp = existing.get("computed_at_utc")
    return timestamp if isinstance(timestamp, str) else None


def _round(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value):
            raise ValueError("Unexpected NaN in output.")
        return round(value, 4)
    if isinstance(value, list):
        return [_round(item) for item in value]
    if isinstance(value, dict):
        return {key: _round(value[key]) for key in sorted(value)}
    return value


def _dw_mode(aoi: ee.Geometry, start: ee.Date, end: ee.Date) -> ee.Image:
    # Official catalog: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1
    return (
        ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
        .filterBounds(aoi)
        .filterDate(start, end)
        .select("label")
        .mode()
    )


def _land_cover(aoi: ee.Geometry, start_12m: ee.Date, end: ee.Date) -> dict[str, float]:
    hist = (
        _dw_mode(aoi, start_12m, end)
        .reduceRegion(ee.Reducer.frequencyHistogram(), aoi, scale=10, maxPixels=1e9)
        .get("label")
        .getInfo()
    )
    if not isinstance(hist, dict) or not hist:
        raise RuntimeError("Dynamic World returned no land-cover pixels.")
    total = sum(float(value) for value in hist.values())
    return {
        class_name: float(hist.get(str(index), 0.0)) / total
        for index, class_name in enumerate(CLASSES)
    }


def _mann_kendall(tau: float, n: int) -> dict[str, float]:
    s = tau * n * (n - 1) / 2
    if s:
        variance = n * (n - 1) * (2 * n + 5) / 18
        z = (s - math.copysign(1, s)) / math.sqrt(variance)
    else:
        z = 0.0
    return {"mann_kendall_tau": tau, "mann_kendall_p_value": math.erfc(abs(z) / math.sqrt(2))}


def _usable_s2_collection(
    aoi: ee.Geometry, start_5y: ee.Date, end: ee.Date, non_water: ee.Image
) -> ee.ImageCollection:
    # Cloud Score+ official catalog documents cs_cdf as a 0..1 clear-pixel likelihood:
    # https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_CLOUD_SCORE_PLUS_V1_S2_HARMONIZED
    cs_plus = ee.ImageCollection("GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED")
    raw = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(aoi)
        .filterDate(start_5y, end)
        .linkCollection(cs_plus, ["cs_cdf"])
    )

    total_non_water = (
        ee.Image.constant(1)
        .updateMask(non_water)
        .reduceRegion(ee.Reducer.sum(), aoi, scale=60, maxPixels=1e9)
        .get("constant")
    )

    def with_clear_fraction(image: ee.Image) -> ee.Image:
        clear_non_water = image.select("cs_cdf").gte(CLOUD_SCORE_THRESHOLD).And(non_water)
        clear_pixels = (
            ee.Image.constant(1)
            .updateMask(clear_non_water)
            .reduceRegion(ee.Reducer.sum(), aoi, scale=60, maxPixels=1e9)
            .get("constant")
        )
        clear_fraction = ee.Number(clear_pixels).divide(ee.Number(total_non_water))
        return image.set("clear_fraction", clear_fraction)

    return raw.map(with_clear_fraction).filter(
        ee.Filter.gte("clear_fraction", CLOUD_FREE_MIN_CLEAR_FRACTION)
    )


def _ndvi(aoi: ee.Geometry, start_12m: ee.Date, start_5y: ee.Date, end: ee.Date) -> dict[str, Any]:
    non_water = _dw_mode(aoi, start_12m, end).eq(0).Not()
    usable = _usable_s2_collection(aoi, start_5y, end, non_water)

    def to_ndvi(image: ee.Image) -> ee.Image:
        masked = image.updateMask(image.select("cs_cdf").gte(CLOUD_SCORE_THRESHOLD))
        masked = masked.updateMask(non_water)
        return (
            masked.normalizedDifference(["B8", "B4"])
            .rename("ndvi")
            .copyProperties(image, ["system:time_start"])
        )

    s2 = usable.map(to_ndvi)

    def monthly(index: ee.Number) -> ee.Feature:
        start = start_5y.advance(index, "month")
        month = s2.filterDate(start, start.advance(1, "month"))
        # A month with no usable scenes has a band-less median; return null so the
        # notNull filter below drops it instead of failing on a missing key.
        mean = ee.Algorithms.If(
            month.size().gt(0),
            month.median()
            .reduceRegion(ee.Reducer.mean(), aoi, scale=10, maxPixels=1e9)
            .get("ndvi"),
            None,
        )
        return ee.Feature(
            None,
            {
                "month": start.format("YYYY-MM"),
                "t": start.difference(start_5y, "year"),
                "ndvi": mean,
                "cloud_free_observations": month.size(),
            },
        )

    series = (
        ee.FeatureCollection(ee.List.sequence(0, 59).map(monthly))
        .filter(ee.Filter.notNull(["ndvi"]))
        .sort("t")
    )
    out = ee.Dictionary(
        {
            "rows": series.toList(60),
            "sens": series.reduceColumns(ee.Reducer.sensSlope(), ["t", "ndvi"]),
            "kendall": series.reduceColumns(ee.Reducer.kendallsCorrelation(2), ["t", "ndvi"]),
            "cloud_free_observations_last_12m": usable.filterDate(start_12m, end).size(),
        }
    ).getInfo()

    rows = sorted((feature["properties"] for feature in out["rows"]), key=lambda row: row["t"])
    if len(rows) < 12:
        raise RuntimeError(f"Only {len(rows)} NDVI months returned; need at least 12.")
    last12 = rows[-12:]
    mean_last_12 = sum(float(row["ndvi"]) for row in last12) / len(last12)
    tau = float(out["kendall"]["tau"])
    trend = {
        "mean_last_12_months": mean_last_12,
        "sens_slope_per_year": float(out["sens"]["slope"]),
        **_mann_kendall(tau, len(rows)),
    }
    trend["significant_05"] = trend["mann_kendall_p_value"] < 0.05
    return {
        "ndvi_series": [
            {
                "month": str(row["month"]),
                "ndvi": float(row["ndvi"]),
                "cloud_free_obs": int(row["cloud_free_observations"]),
            }
            for row in rows
        ],
        "ndvi_mean": mean_last_12,
        "ndvi_trend": trend["sens_slope_per_year"],
        "ndvi_trend_details": trend,
        "cloud_free_obs": int(out["cloud_free_observations_last_12m"]),
        "cloud_free_months_5y": len(rows),
    }


def _water_change(aoi: ee.Geometry) -> float:
    # JRC catalog band: change_abs, absolute occurrence change intensity.
    image = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("change_abs").unmask(0)
    value = (
        image.reduceRegion(ee.Reducer.mean(), aoi, scale=30, maxPixels=1e9)
        .getInfo()
        .get("change_abs")
    )
    if value is None:
        raise RuntimeError("JRC Global Surface Water returned no change_abs value.")
    return float(value)


def _forest_loss(aoi: ee.Geometry) -> tuple[float, float]:
    """Hansen loss (ha) in the latest five complete years and in the latest year only."""
    # Hansen v1.13 lossyear encodes 1..25 for 2001..2025. We use the latest five complete
    # years available in the dataset: 2021..2025 -> lossyear 21..25; the "last 12 months"
    # metric for the listing gate is the latest complete year, 2025 -> lossyear 25.
    hansen = ee.Image("UMD/hansen/global_forest_change_2025_v1_13")
    loss_year = hansen.select("lossyear")
    forest_2000 = hansen.select("treecover2000").gte(HANSEN_TREE_COVER_MIN_PERCENT)
    latest_five_years = loss_year.gte(21).And(loss_year.lte(25))
    latest_year = loss_year.eq(25)
    pixel_area = ee.Image.pixelArea()
    areas = ee.Image.cat(
        [
            pixel_area.updateMask(latest_five_years.And(forest_2000)).rename("loss_5y"),
            pixel_area.updateMask(latest_year.And(forest_2000)).rename("loss_12m"),
        ]
    )
    values = areas.reduceRegion(ee.Reducer.sum(), aoi, scale=30, maxPixels=1e9).getInfo()
    five_years, last_year = values.get("loss_5y"), values.get("loss_12m")
    return (
        0.0 if five_years is None else float(five_years) / 10_000,
        0.0 if last_year is None else float(last_year) / 10_000,
    )


def _biomass(aoi: ee.Geometry) -> tuple[float, str]:
    """Mean above-ground biomass (t/ha) and the dataset key it came from."""
    # GEDI L4B v2 is gridded mean above-ground biomass density; MU is mean AGBD in Mg/ha.
    image = ee.Image("LARSE/GEDI/GEDI04_B_002").select("MU")
    value = (
        image.reduceRegion(ee.Reducer.mean(), aoi, scale=1000, maxPixels=1e9).getInfo().get("MU")
    )
    if value is not None:
        return float(value), "gedi_l4b"
    # GEDI L4B leaves 1 km cells empty where too few quality footprints pass (e.g. the steep
    # Sumidero Canyon slopes). Fall back to the ESA CCI Biomass v6.0 map for the latest year
    # (2022, 100 m, band agb in Mg/ha; EE catalog record ESA_CCI_Above_Ground_Biomass_V6_0).
    cci = (
        ee.ImageCollection("ESA/CCI/Above_Ground_Biomass/V6_0")
        .filterDate(ESA_CCI_BIOMASS_YEAR_START, ESA_CCI_BIOMASS_YEAR_END)
        .first()
        .select("agb")
    )
    value = cci.reduceRegion(ee.Reducer.mean(), aoi, scale=100, maxPixels=1e9).getInfo().get("agb")
    if value is None:
        raise RuntimeError("Neither GEDI L4B nor ESA CCI Biomass covers this polygon.")
    return float(value), "esa_cci_biomass"


def _soil_organic_carbon(aoi: ee.Geometry) -> float:
    # SoilGrids 2.0 organic carbon stock 0-30 cm (ISRIC, CC BY 4.0). Mapped units are t/ha
    # (conversion factor 10 to kg/m2), so the polygon mean is already t C/ha:
    # https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html
    image = ee.Image("projects/soilgrids-isric/ocs_mean").select("ocs_0-30cm_mean")
    value = (
        image.reduceRegion(ee.Reducer.mean(), aoi, scale=250, maxPixels=1e9)
        .getInfo()
        .get("ocs_0-30cm_mean")
    )
    if value is None:
        raise RuntimeError("SoilGrids returned no organic carbon stock for this polygon.")
    return float(value)


def compute_site(site_key: str, computed_at_utc: str | None = None) -> dict[str, Any]:
    path = DATA_DIR / f"{site_key}.geojson"
    geojson = json.loads(path.read_text())
    check = validate_polygon(geojson)
    if (
        not check.ok
        or check.area_ha is None
        or check.centroid_lat is None
        or check.centroid_lon is None
    ):
        problems = "; ".join(problem.message for problem in check.problems)
        raise ValueError(f"{path} failed polygon validation: {problems}")

    start_12m = ee.Date(START_12M)
    start_5y = ee.Date(START_5Y)
    end = ee.Date(END_DATE)
    aoi = ee.Geometry(_geometry_from_feature(geojson))

    land_cover = _land_cover(aoi, start_12m, end)
    natural_fraction = sum(land_cover[class_name] for class_name in NATURAL_CLASSES)
    ndvi = _ndvi(aoi, start_12m, start_5y, end)
    forest_loss_5y, forest_loss_12m = _forest_loss(aoi)
    biomass, biomass_source = _biomass(aoi)
    unused_biomass = {"gedi_l4b", "esa_cci_biomass"} - {biomass_source}
    datasets = [dataset for dataset in DATASETS if dataset["key"] not in unused_biomass]
    biomass_window_key, biomass_window = BIOMASS_WINDOWS[biomass_source]
    biomass_scale_key, biomass_scale = BIOMASS_SCALES[biomass_source]

    out: dict[str, Any] = {
        "site_key": site_key,
        "data_version": DATA_VERSION,
        "computed_at_utc": computed_at_utc
        or datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "area_ha": check.area_ha,
        "centroid": {"lat": check.centroid_lat, "lon": check.centroid_lon},
        "landcover": land_cover,
        "natural_fraction": natural_fraction,
        **ndvi,
        "water_change": _water_change(aoi),
        "forest_loss_ha": forest_loss_5y,
        "forest_loss_last_12m_ha": forest_loss_12m,
        "biomass_t_ha": biomass,
        "biomass_source": biomass_source,
        "soc_t_c_ha": _soil_organic_carbon(aoi),
        "date_windows": {
            "land_cover": {"start": START_12M, "end": END_DATE},
            "ndvi": {"start": START_5Y, "end": END_DATE},
            "cloud_free_obs": {"start": START_12M, "end": END_DATE},
            "jrc_water_change": {"start": "1984-03-16", "end": "2021-12-31"},
            "hansen_forest_loss": {"start": "2021-01-01", "end": "2025-12-31"},
            "hansen_forest_loss_last_12m": {"start": "2025-01-01", "end": "2025-12-31"},
            biomass_window_key: biomass_window,
        },
        "thresholds": {
            "cloud_score_plus_cs_cdf": CLOUD_SCORE_THRESHOLD,
            "cloud_free_scene_min_clear_fraction": CLOUD_FREE_MIN_CLEAR_FRACTION,
            "dynamic_world_mode_scale_m": 10,
            "sentinel2_ndvi_scale_m": 10,
            "jrc_water_change_scale_m": 30,
            "hansen_forest_loss_scale_m": 30,
            "hansen_forest_loss_years": FOREST_LOSS_YEARS,
            "hansen_forest_loss_last_12m_year": FOREST_LOSS_LAST_12M_YEAR,
            "hansen_treecover2000_min_percent": HANSEN_TREE_COVER_MIN_PERCENT,
            biomass_scale_key: biomass_scale,
            "soilgrids_soc_scale_m": 250,
            "soilgrids_soc_depth_cm": "0-30",
        },
        "datasets": datasets,
        "attributions": [dataset["attribution"] for dataset in datasets],
    }
    return _round(out)


def _json_text(data: Mapping[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def compare_cached_metrics(expected: Any, actual: Any, path: str = "$") -> list[str]:
    if isinstance(expected, dict) and isinstance(actual, dict):
        messages: list[str] = []
        if set(expected) != set(actual):
            return [f"{path}: keys differ {sorted(expected)} != {sorted(actual)}"]
        for key in sorted(expected):
            messages.extend(compare_cached_metrics(expected[key], actual[key], f"{path}.{key}"))
        return messages
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{path}: lengths differ {len(expected)} != {len(actual)}"]
        messages = []
        for index, (left, right) in enumerate(zip(expected, actual, strict=True)):
            messages.extend(compare_cached_metrics(left, right, f"{path}[{index}]"))
        return messages
    if isinstance(expected, float | int) and isinstance(actual, float | int):
        if math.isclose(float(expected), float(actual), rel_tol=1e-4, abs_tol=1e-4):
            return []
        return [f"{path}: {expected!r} != {actual!r}"]
    if expected == actual:
        return []
    return [f"{path}: {expected!r} != {actual!r}"]


def _site_keys(selected: str | None) -> list[str]:
    if selected:
        return [selected]
    return sorted(path.stem for path in DATA_DIR.glob("*.geojson"))


def expected_scenario_documents(site_keys: list[str]) -> dict[Path, dict[str, Any]]:
    """Scenario JSON that the committed baselines and ``scenarios.json`` produce (no EE)."""
    spec = load_scenario_spec()
    documents: dict[Path, dict[str, Any]] = {}
    for site_key in site_keys:
        baseline = EarthObsMetrics.model_validate_json(
            scenario_path(site_key, "baseline").read_text()
        )
        for scenario, metrics in build_site_scenarios(baseline, spec).items():
            if scenario != "baseline":
                documents[scenario_path(site_key, scenario)] = scenario_document(metrics)
    return documents


def scenario_failures(site_keys: list[str], *, write: bool) -> list[str]:
    """Regenerate (``write``) or compare the scenario files; return mismatches."""
    failures: list[str] = []
    expected = expected_scenario_documents(site_keys)
    if write:
        SCENARIO_DIR.mkdir(exist_ok=True)
        for path, document in expected.items():
            path.write_text(_json_text(document))
            print(f"Wrote {path.relative_to(ROOT)}")
        return failures
    for path, document in expected.items():
        if not path.exists():
            failures.append(f"{path} does not exist.")
            continue
        committed = json.loads(path.read_text())
        failures.extend(compare_cached_metrics(committed, document, path=path.name))
    if not failures:
        known, all_sites = set(expected), set(_site_keys(None))
        stray = [
            path
            for path in SCENARIO_DIR.glob("*.json")
            if path not in known
            and (path.name.split(".")[0] in site_keys or path.name.split(".")[0] not in all_sites)
        ]
        failures.extend(f"{path} is not produced by scenarios.json." for path in stray)
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="Only compute one site key.")
    parser.add_argument("--check", action="store_true", help="Compare with committed JSON.")
    parser.add_argument(
        "--scenarios-only",
        action="store_true",
        help="Skip Earth Engine; only regenerate or check the scenario variants.",
    )
    args = parser.parse_args()

    started = time.perf_counter()
    failures: list[str] = []
    site_keys = _site_keys(args.site)
    if args.scenarios_only:
        failures.extend(scenario_failures(site_keys, write=not args.check))
        return _report(failures, started, args.check, f"{len(site_keys)} site(s) scenarios")
    _init_ee()
    for site_key in site_keys:
        output_path = DATA_DIR / f"{site_key}.json"
        existing_timestamp = _load_existing_timestamp(site_key)
        print(f"Computing {site_key}...")
        data = compute_site(site_key, computed_at_utc=existing_timestamp)
        if args.check:
            if not output_path.exists():
                failures.append(f"{output_path} does not exist.")
                continue
            existing = json.loads(output_path.read_text())
            failures.extend(compare_cached_metrics(existing, data, path=site_key))
        else:
            output_path.write_text(_json_text(data))
            print(f"Wrote {output_path.relative_to(ROOT)}")

    # Scenarios derive from the committed baselines, so only check them once those match.
    if not failures:
        failures.extend(scenario_failures(site_keys, write=not args.check))
    return _report(failures, started, args.check, f"{len(site_keys)} site(s) and scenarios")


def _report(failures: list[str], started: float, check: bool, what: str) -> int:
    elapsed = time.perf_counter() - started
    if failures:
        print("\n".join(failures), file=sys.stderr)
        print(f"FAILED in {elapsed:.1f}s", file=sys.stderr)
        return 1
    verb = "Checked" if check else "Computed"
    print(f"{verb} {what} in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

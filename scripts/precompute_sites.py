"""Precompute Earth Engine metrics for committed demo-site GeoJSON files.

Run from the repository root with:

    cd backend && PATH=$HOME/.local/bin:$PATH uv run --with earthengine-api \
      python ../scripts/precompute_sites.py

Use ``--check`` to recompute and compare against committed JSON without rewriting it.
Earth Engine is intentionally used only by this offline script; the runtime app loads
the cached JSON through ``app.tools.earth_obs``.
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
from app.tools.geometry import validate_polygon

ee: Any

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "backend" / "data" / "demo_sites"

DATA_VERSION = "2026Q3"
END_DATE = "2026-10-01"
START_12M = "2025-10-01"
START_5Y = "2021-10-01"
FOREST_LOSS_YEARS = "2021-2025"
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
        mean = (
            month.median().reduceRegion(ee.Reducer.mean(), aoi, scale=10, maxPixels=1e9).get("ndvi")
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


def _forest_loss(aoi: ee.Geometry) -> float:
    # Hansen v1.13 lossyear encodes 1..25 for 2001..2025. We use the latest five complete
    # years available in the dataset: 2021..2025 -> lossyear 21..25.
    hansen = ee.Image("UMD/hansen/global_forest_change_2025_v1_13")
    loss_year = hansen.select("lossyear")
    forest_2000 = hansen.select("treecover2000").gte(HANSEN_TREE_COVER_MIN_PERCENT)
    latest_five_years = loss_year.gte(21).And(loss_year.lte(25))
    area = ee.Image.pixelArea().updateMask(latest_five_years.And(forest_2000))
    value = area.reduceRegion(ee.Reducer.sum(), aoi, scale=30, maxPixels=1e9).getInfo().get("area")
    return 0.0 if value is None else float(value) / 10_000


def _biomass(aoi: ee.Geometry) -> float:
    # GEDI L4B v2 is gridded mean above-ground biomass density; MU is mean AGBD in Mg/ha.
    image = ee.Image("LARSE/GEDI/GEDI04_B_002").select("MU")
    value = (
        image.reduceRegion(ee.Reducer.mean(), aoi, scale=1000, maxPixels=1e9).getInfo().get("MU")
    )
    if value is None:
        raise RuntimeError("GEDI L4B returned no MU biomass value for this polygon.")
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
        "forest_loss_ha": _forest_loss(aoi),
        "biomass_t_ha": _biomass(aoi),
        "date_windows": {
            "land_cover": {"start": START_12M, "end": END_DATE},
            "ndvi": {"start": START_5Y, "end": END_DATE},
            "cloud_free_obs": {"start": START_12M, "end": END_DATE},
            "jrc_water_change": {"start": "1984-03-16", "end": "2021-12-31"},
            "hansen_forest_loss": {"start": "2021-01-01", "end": "2025-12-31"},
            "gedi_l4b_biomass": {"start": "2019-04-18", "end": "2021-08-04"},
        },
        "thresholds": {
            "cloud_score_plus_cs_cdf": CLOUD_SCORE_THRESHOLD,
            "cloud_free_scene_min_clear_fraction": CLOUD_FREE_MIN_CLEAR_FRACTION,
            "dynamic_world_mode_scale_m": 10,
            "sentinel2_ndvi_scale_m": 10,
            "jrc_water_change_scale_m": 30,
            "hansen_forest_loss_scale_m": 30,
            "hansen_forest_loss_years": FOREST_LOSS_YEARS,
            "hansen_treecover2000_min_percent": HANSEN_TREE_COVER_MIN_PERCENT,
            "gedi_biomass_scale_m": 1000,
        },
        "datasets": DATASETS,
        "attributions": list(ATTRIBUTIONS.values()),
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="Only compute one site key.")
    parser.add_argument("--check", action="store_true", help="Compare with committed JSON.")
    args = parser.parse_args()

    started = time.perf_counter()
    _init_ee()
    failures: list[str] = []
    for site_key in _site_keys(args.site):
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

    elapsed = time.perf_counter() - started
    if failures:
        print("\n".join(failures), file=sys.stderr)
        print(f"FAILED in {elapsed:.1f}s", file=sys.stderr)
        return 1
    verb = "Checked" if args.check else "Computed"
    print(f"{verb} {len(_site_keys(args.site))} site(s) in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

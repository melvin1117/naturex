"""Earth Engine methods for one polygon (T11/T13 methods, ADR-0004), shared by the offline
precompute (`scripts/precompute_sites.py`) and live ratings of new listings (T60).

Every number comes from the same code on both paths: `compute_polygon_metrics` runs the
Earth Engine reductions, and the pure helpers below (`land_cover_shares`, `ndvi_summary`,
`forest_loss_areas`, `biomass_values`, `mangrove_share`, `assemble_metrics`, `round_metrics`)
turn their `getInfo()` results into the cached-metrics JSON. `land_cover_labels` renders the
land-cover overlay (the same Dynamic World mode as the metric) for the precompute's demo-site
images (T35) and live-rated listings (#231). The pure helpers are unit-tested
on fixtures; nothing in the test suite calls Earth Engine.

Importing this module imports the Earth Engine client library (no network); the API imports it
lazily, only when live Earth Engine is on (`EARTH_ENGINE_LIVE=true`).
"""

from __future__ import annotations

import io
import json
import math
import threading
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import ee

from app.tools.geometry import validate_polygon
from app.tools.site_images import (
    DW_NO_DATA,
    DYNAMIC_WORLD_ATTRIBUTION,
    LandCoverLabels,
    PixelGrid,
    overlay_png_from_labels,
)

DATA_VERSION = "2026Q3"
END_DATE = "2026-10-01"
START_12M = "2025-10-01"
START_5Y = "2021-10-01"
FOREST_LOSS_YEARS = "2021-2025"
FOREST_LOSS_LAST_12M_YEAR = "2025"
ESA_CCI_BIOMASS_YEAR_START = "2022-01-01"
ESA_CCI_BIOMASS_YEAR_END = "2023-01-01"
GMW_EPOCH = "2020"
GMW_SCALE_M = 10
CLOUD_SCORE_THRESHOLD = 0.60
CLOUD_FREE_MIN_CLEAR_FRACTION = 0.50
HANSEN_TREE_COVER_MIN_PERCENT = 30
MIN_NDVI_MONTHS = 12
MAX_PIXELS: Any = 1e9

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
    "dynamic_world": DYNAMIC_WORLD_ATTRIBUTION,
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
    "gmw": (
        "Global Mangrove Watch v3.0 (CC BY 4.0): Bunting et al. (2022), Global Mangrove "
        "Extent Change 1996-2020: Global Mangrove Watch Version 3.0, Remote Sensing 14(15), "
        "3657; dataset doi:10.5281/zenodo.6894273."
    ),
    "soilgrids": (
        "SoilGrids 2.0 (CC BY 4.0): ISRIC - World Soil Information; Poggio et al. (2021), "
        "SoilGrids 2.0: producing soil information for the globe with quantified spatial "
        "uncertainty, SOIL 7, 217-240."
    ),
}

DATASETS: list[dict[str, Any]] = [
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
        "key": "global_mangrove_watch",
        "dataset_id": "projects/sat-io/open-datasets/GMW/extent/GMW_V3",
        "version": "v3.0 (2020 epoch)",
        "catalog_url": "https://gee-community-catalog.org/projects/mangrove/",
        "bands": ["b1"],
        "attribution": ATTRIBUTIONS["gmw"],
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

Checkpoint = Callable[[], None]
"""Called before each Earth Engine step; raises to stop a computation (e.g. its deadline)."""


def _no_checkpoint() -> None:
    return None


# ----- set-up -----------------------------------------------------------------------------------


def service_account_key(setting: str) -> tuple[dict[str, Any], str | None]:
    """The key of `EE_SERVICE_ACCOUNT_JSON` (a file path or inline JSON) and its file path.

    Surrounding quotes and a byte-order mark are stripped, so a quoted inline key is never
    mistaken for a path. Errors never contain the setting or the file's content.
    """
    value = setting.strip().lstrip("\ufeff").strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1].strip()
    if not value:
        raise ValueError("EE_SERVICE_ACCOUNT_JSON is not set")
    path: Path | None = None
    if value.startswith("{"):
        text = value
    else:
        path = Path(value).expanduser()
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            raise ValueError("EE_SERVICE_ACCOUNT_JSON is not a readable key file") from None
    try:
        key = json.loads(text)
    except json.JSONDecodeError:
        raise ValueError("EE_SERVICE_ACCOUNT_JSON does not hold valid JSON") from None
    if not isinstance(key, dict) or not key.get("client_email") or not key.get("project_id"):
        raise ValueError("EE_SERVICE_ACCOUNT_JSON lacks client_email or project_id")
    return key, None if path is None else str(path)


def init_ee(setting: str) -> None:
    """`ee.Initialize` with the service account (ADR-0004). Never logs the key."""
    key, path = service_account_key(setting)
    if path is None:
        credentials = ee.ServiceAccountCredentials(key["client_email"], key_data=json.dumps(key))
    else:
        credentials = ee.ServiceAccountCredentials(key["client_email"], path)
    ee.Initialize(credentials, project=key["project_id"])


def geometry_from_feature(geojson: Mapping[str, Any]) -> Mapping[str, Any]:
    if geojson.get("type") == "Feature":
        geometry = geojson.get("geometry")
        if not isinstance(geometry, Mapping):
            raise ValueError("GeoJSON Feature has no geometry object.")
        return geometry
    return geojson


# ----- pure helpers (no Earth Engine) -------------------------------------------------------------


def round_metrics(value: Any) -> Any:
    """Round every float to 4 decimals and sort dict keys; NaN is an error."""
    if isinstance(value, float):
        if math.isnan(value):
            raise ValueError("Unexpected NaN in output.")
        return round(value, 4)
    if isinstance(value, list):
        return [round_metrics(item) for item in value]
    if isinstance(value, dict):
        return {key: round_metrics(value[key]) for key in sorted(value)}
    return value


def land_cover_shares(histogram: Any) -> dict[str, float]:
    """Each Dynamic World class's pixel share from a `frequencyHistogram` of the label mode."""
    if not isinstance(histogram, dict) or not histogram:
        raise RuntimeError("Dynamic World returned no land-cover pixels.")
    total = sum(float(value) for value in histogram.values())
    return {
        class_name: float(histogram.get(str(index), 0.0)) / total
        for index, class_name in enumerate(CLASSES)
    }


def natural_fraction(land_cover: Mapping[str, float]) -> float:
    return sum(land_cover[class_name] for class_name in NATURAL_CLASSES)


def mann_kendall(tau: float, n: int) -> dict[str, float]:
    """Kendall's tau → Mann-Kendall p-value (normal approximation; ADR-0004)."""
    s = tau * n * (n - 1) / 2
    if s:
        variance = n * (n - 1) * (2 * n + 5) / 18
        z = (s - math.copysign(1, s)) / math.sqrt(variance)
    else:
        z = 0.0
    return {"mann_kendall_tau": tau, "mann_kendall_p_value": math.erfc(abs(z) / math.sqrt(2))}


def ndvi_summary(out: Mapping[str, Any]) -> dict[str, Any]:
    """The NDVI metrics from the one-round-trip dictionary `ndvi()` fetches: monthly rows,
    Sen's slope, Kendall's tau and the cloud-free scene count of the last 12 months."""
    rows = sorted((feature["properties"] for feature in out["rows"]), key=lambda row: row["t"])
    if len(rows) < MIN_NDVI_MONTHS:
        raise RuntimeError(f"Only {len(rows)} NDVI months returned; need at least 12.")
    last12 = rows[-12:]
    mean_last_12 = sum(float(row["ndvi"]) for row in last12) / len(last12)
    tau = float(out["kendall"]["tau"])
    trend: dict[str, Any] = {
        "mean_last_12_months": mean_last_12,
        "sens_slope_per_year": float(out["sens"]["slope"]),
        **mann_kendall(tau, len(rows)),
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


def water_change_value(values: Mapping[str, Any]) -> float:
    value = values.get("change_abs")
    if value is None:
        raise RuntimeError("JRC Global Surface Water returned no change_abs value.")
    return float(value)


def forest_loss_areas(values: Mapping[str, Any]) -> tuple[float, float]:
    """Hansen loss (ha) in the latest five complete years and in the latest year, from m²."""
    five_years, last_year = values.get("loss_5y"), values.get("loss_12m")
    return (
        0.0 if five_years is None else float(five_years) / 10_000,
        0.0 if last_year is None else float(last_year) / 10_000,
    )


def biomass_values(values: Mapping[str, Any]) -> tuple[float, float | None]:
    """ESA CCI mean AGB (required) and the GEDI L4B cross-check (None where GEDI is empty)."""
    if values.get("cci") is None:
        raise RuntimeError("ESA CCI Biomass returned no agb value for this polygon.")
    gedi_value = values.get("gedi")
    return float(values["cci"]), None if gedi_value is None else float(gedi_value)


def mangrove_share(sums: Mapping[str, Any]) -> float:
    total = sums.get("all")
    if not total:
        raise RuntimeError("Polygon has no area at the GMW sampling scale.")
    return float(sums.get("mangrove") or 0.0) / float(total)


def soc_value(values: Mapping[str, Any]) -> float:
    value = values.get("ocs_0-30cm_mean")
    if value is None:
        raise RuntimeError("SoilGrids returned no organic carbon stock for this polygon.")
    return float(value)


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def assemble_metrics(
    *,
    site_key: str,
    computed_at_utc: str,
    area_ha: float,
    centroid_lat: float,
    centroid_lon: float,
    land_cover: Mapping[str, float],
    ndvi: Mapping[str, Any],
    water_change: float,
    forest_loss: tuple[float, float],
    biomass: tuple[float, float | None],
    mangrove_fraction: float,
    soc_t_c_ha: float,
) -> dict[str, Any]:
    """The cached-metrics JSON (`EarthObsMetrics`), rounded, with provenance and attributions."""
    forest_loss_5y, forest_loss_12m = forest_loss
    biomass_cci, biomass_gedi = biomass
    # List only datasets that contributed a value, each with its attribution.
    datasets = [
        dataset for dataset in DATASETS if biomass_gedi is not None or dataset["key"] != "gedi_l4b"
    ]
    gedi_window = {"gedi_l4b_biomass": {"start": "2019-04-18", "end": "2021-08-04"}}
    gedi_scale = {"gedi_biomass_scale_m": 1000}
    out: dict[str, Any] = {
        "site_key": site_key,
        "data_version": DATA_VERSION,
        "computed_at_utc": computed_at_utc,
        "area_ha": area_ha,
        "centroid": {"lat": centroid_lat, "lon": centroid_lon},
        "landcover": dict(land_cover),
        "natural_fraction": natural_fraction(land_cover),
        **ndvi,
        "water_change": water_change,
        "forest_loss_ha": forest_loss_5y,
        "forest_loss_last_12m_ha": forest_loss_12m,
        "biomass_t_ha": biomass_cci,
        "biomass_source": "esa_cci_biomass",
        "biomass_gedi_t_ha": biomass_gedi,
        "mangrove_fraction": mangrove_fraction,
        "soc_t_c_ha": soc_t_c_ha,
        "date_windows": {
            "land_cover": {"start": START_12M, "end": END_DATE},
            "ndvi": {"start": START_5Y, "end": END_DATE},
            "cloud_free_obs": {"start": START_12M, "end": END_DATE},
            "jrc_water_change": {"start": "1984-03-16", "end": "2021-12-31"},
            "hansen_forest_loss": {"start": "2021-01-01", "end": "2025-12-31"},
            "hansen_forest_loss_last_12m": {"start": "2025-01-01", "end": "2025-12-31"},
            "esa_cci_biomass": {"start": "2022-01-01", "end": "2022-12-31"},
            **(gedi_window if biomass_gedi is not None else {}),
            "gmw_mangrove_extent": {"start": f"{GMW_EPOCH}-01-01", "end": f"{GMW_EPOCH}-12-31"},
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
            "esa_cci_biomass_scale_m": 100,
            **(gedi_scale if biomass_gedi is not None else {}),
            "gmw_mangrove_epoch": GMW_EPOCH,
            "gmw_mangrove_scale_m": GMW_SCALE_M,
            "soilgrids_soc_scale_m": 250,
            "soilgrids_soc_depth_cm": "0-30",
        },
        "datasets": datasets,
        "attributions": [dataset["attribution"] for dataset in datasets],
    }
    rounded: dict[str, Any] = round_metrics(out)
    return rounded


# ----- Earth Engine reductions ----------------------------------------------------------------


def dw_mode(aoi: ee.Geometry, start: ee.Date, end: ee.Date) -> ee.Image:
    # Official catalog: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1
    mode: ee.Image = (
        ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
        .filterBounds(aoi)
        .filterDate(start, end)
        .select("label")
        .mode()
    )
    return mode


def land_cover(aoi: ee.Geometry, start_12m: ee.Date, end: ee.Date) -> dict[str, float]:
    hist = (
        dw_mode(aoi, start_12m, end)
        .reduceRegion(ee.Reducer.frequencyHistogram(), aoi, scale=10, maxPixels=MAX_PIXELS)
        .get("label")
        .getInfo()
    )
    return land_cover_shares(hist)


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
        .reduceRegion(ee.Reducer.sum(), aoi, scale=60, maxPixels=MAX_PIXELS)
        .get("constant")
    )

    def with_clear_fraction(image: ee.Image) -> ee.Image:
        clear_non_water = image.select("cs_cdf").gte(CLOUD_SCORE_THRESHOLD).And(non_water)
        clear_pixels = (
            ee.Image.constant(1)
            .updateMask(clear_non_water)
            .reduceRegion(ee.Reducer.sum(), aoi, scale=60, maxPixels=MAX_PIXELS)
            .get("constant")
        )
        clear_fraction = ee.Number(clear_pixels).divide(ee.Number(total_non_water))
        return cast(ee.Image, image.set("clear_fraction", clear_fraction))

    usable: ee.ImageCollection = raw.map(with_clear_fraction).filter(
        ee.Filter.gte("clear_fraction", CLOUD_FREE_MIN_CLEAR_FRACTION)
    )
    return usable


def ndvi(aoi: ee.Geometry, start_12m: ee.Date, start_5y: ee.Date, end: ee.Date) -> dict[str, Any]:
    non_water = dw_mode(aoi, start_12m, end).eq(0).Not()
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
            .reduceRegion(ee.Reducer.mean(), aoi, scale=10, maxPixels=MAX_PIXELS)
            .get("ndvi"),
            None,
        )
        feature: ee.Feature = ee.Feature(
            None,
            {
                "month": start.format("YYYY-MM"),
                "t": start.difference(start_5y, "year"),
                "ndvi": mean,
                "cloud_free_observations": month.size(),
            },
        )
        return feature

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
    return ndvi_summary(cast(dict[str, Any], out))


def water_change(aoi: ee.Geometry) -> float:
    # JRC catalog band: change_abs, absolute occurrence change intensity.
    image = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("change_abs").unmask(0)
    return water_change_value(
        image.reduceRegion(ee.Reducer.mean(), aoi, scale=30, maxPixels=MAX_PIXELS).getInfo()
    )


def forest_loss(aoi: ee.Geometry) -> tuple[float, float]:
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
    return forest_loss_areas(
        areas.reduceRegion(ee.Reducer.sum(), aoi, scale=30, maxPixels=MAX_PIXELS).getInfo()
    )


def biomass(aoi: ee.Geometry) -> tuple[float, float | None]:
    """Mean above-ground biomass (t/ha): ESA CCI (primary) and GEDI L4B (cross-check)."""
    # ESA CCI Biomass v6.0, latest map (2022), 100 m, band agb in Mg/ha; EE catalog record
    # ESA_CCI_Above_Ground_Biomass_V6_0. Primary per docs/research.md: finer than GEDI L4B.
    cci = (
        ee.ImageCollection("ESA/CCI/Above_Ground_Biomass/V6_0")
        .filterDate(ESA_CCI_BIOMASS_YEAR_START, ESA_CCI_BIOMASS_YEAR_END)
        .first()
        .select("agb")
    )
    # GEDI L4B v2 is gridded mean AGBD (MU, Mg/ha) at 1 km; cells are empty where too few
    # quality footprints pass (e.g. the steep Sumidero Canyon slopes), hence optional.
    gedi = ee.Image("LARSE/GEDI/GEDI04_B_002").select("MU")
    values = ee.Dictionary(
        {
            "cci": cci.reduceRegion(ee.Reducer.mean(), aoi, scale=100, maxPixels=MAX_PIXELS).get(
                "agb"
            ),
            "gedi": gedi.reduceRegion(ee.Reducer.mean(), aoi, scale=1000, maxPixels=MAX_PIXELS).get(
                "MU"
            ),
        }
    ).getInfo()
    return biomass_values(cast(dict[str, Any], values))


def mangrove_fraction(aoi: ee.Geometry) -> float:
    """Area-weighted share of the polygon in Global Mangrove Watch v3.0 (2020 epoch)."""
    # GMW v3 extent rasters (~25 m) hold 1 for mangrove and are masked elsewhere.
    gmw = (
        ee.ImageCollection("projects/sat-io/open-datasets/GMW/extent/GMW_V3")
        .filterDate(f"{GMW_EPOCH}-01-01", f"{int(GMW_EPOCH) + 1}-01-01")
        .first()
        .select("b1")
    )
    mangrove = gmw.eq(1).unmask(0)
    pixel_area = ee.Image.pixelArea()
    sums = (
        ee.Image.cat([pixel_area.multiply(mangrove).rename("mangrove"), pixel_area.rename("all")])
        .reduceRegion(ee.Reducer.sum(), aoi, scale=GMW_SCALE_M, maxPixels=MAX_PIXELS)
        .getInfo()
    )
    return mangrove_share(sums)


def soil_organic_carbon(aoi: ee.Geometry) -> float:
    # SoilGrids 2.0 organic carbon stock 0-30 cm (ISRIC, CC BY 4.0). Mapped units are t/ha
    # (conversion factor 10 to kg/m2), so the polygon mean is already t C/ha:
    # https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html
    image = ee.Image("projects/soilgrids-isric/ocs_mean").select("ocs_0-30cm_mean")
    return soc_value(
        image.reduceRegion(ee.Reducer.mean(), aoi, scale=250, maxPixels=MAX_PIXELS).getInfo()
    )


def compute_polygon_metrics(
    geojson: Mapping[str, Any],
    *,
    site_key: str,
    computed_at_utc: str | None = None,
    checkpoint: Checkpoint = _no_checkpoint,
) -> dict[str, Any]:
    """Every T11/T13 metric for one polygon, as the cached-metrics JSON (`EarthObsMetrics`).

    Area and centroid come from T36's equal-area check (`validate_polygon`), never from
    Earth Engine. `checkpoint` runs before each Earth Engine step, so a caller with a deadline
    stops between round trips instead of after all of them.
    """
    check = validate_polygon(geojson)
    if (
        not check.ok
        or check.area_ha is None
        or check.centroid_lat is None
        or check.centroid_lon is None
    ):
        problems = "; ".join(problem.message for problem in check.problems)
        raise ValueError(f"failed polygon validation: {problems}")

    start_12m = ee.Date(START_12M)
    start_5y = ee.Date(START_5Y)
    end = ee.Date(END_DATE)
    aoi = ee.Geometry(geometry_from_feature(geojson))

    checkpoint()
    shares = land_cover(aoi, start_12m, end)
    checkpoint()
    ndvi_metrics = ndvi(aoi, start_12m, start_5y, end)
    checkpoint()
    loss = forest_loss(aoi)
    checkpoint()
    agb = biomass(aoi)
    checkpoint()
    water = water_change(aoi)
    checkpoint()
    mangrove = mangrove_fraction(aoi)
    checkpoint()
    soc = soil_organic_carbon(aoi)
    return assemble_metrics(
        site_key=site_key,
        computed_at_utc=computed_at_utc or utc_now_iso(),
        area_ha=check.area_ha,
        centroid_lat=check.centroid_lat,
        centroid_lon=check.centroid_lon,
        land_cover=shares,
        ndvi=ndvi_metrics,
        water_change=water,
        forest_loss=loss,
        biomass=agb,
        mangrove_fraction=mangrove,
        soc_t_c_ha=soc,
    )


# ----- the land-cover overlay (T35 demo sites, #231 live listings) ----------------------------


def compute_png(image: ee.Image, grid: PixelGrid) -> bytes:
    """One `computePixels` round trip: ``image`` on ``grid`` as PNG bytes."""
    data = ee.data.computePixels({"expression": image, "fileFormat": "PNG", "grid": grid.ee_grid()})
    if not isinstance(data, bytes):
        raise RuntimeError("computePixels did not return PNG bytes.")
    return data


def land_cover_labels(aoi: ee.Geometry, grid: PixelGrid) -> LandCoverLabels:
    """The Dynamic World mode over the land-cover metric's window (`dw_mode`, `START_12M` to
    `END_DATE`), clipped to ``aoi``, on ``grid``: one byte per pixel, `DW_NO_DATA` outside."""
    from PIL import Image

    labels = (
        dw_mode(aoi, ee.Date(START_12M), ee.Date(END_DATE))
        .clip(aoi)
        .unmask(DW_NO_DATA, False)
        .toUint8()
    )
    with Image.open(io.BytesIO(compute_png(labels, grid))) as image:
        if image.size != (grid.width, grid.height):
            raise RuntimeError(f"Overlay is {image.size}, expected {grid.width}x{grid.height}.")
        raw = image.getchannel(0).tobytes()
    return LandCoverLabels(raw, grid.width, grid.height, START_12M, END_DATE)


def dw_overlay_png(aoi: ee.Geometry, grid: PixelGrid) -> bytes:
    """The land-cover overlay PNG (indexed, transparent outside the polygon)."""
    grid_labels = land_cover_labels(aoi, grid)
    return overlay_png_from_labels(grid_labels.labels, grid_labels.width, grid_labels.height)


# ----- the live client (T60) ------------------------------------------------------------------


class EarthEngineApi:
    """Live Earth Engine for the API (T60): initialised once per process, on first use, with a
    per-request deadline and no retries, so a stuck request can't hold a slot for long."""

    def __init__(self, key_setting: str, *, request_timeout_s: float, max_retries: int = 0):
        self._key_setting = key_setting
        self._request_timeout_ms = int(request_timeout_s * 1000)
        self._max_retries = max_retries
        self._ready = False
        self._lock = threading.Lock()

    def _ensure_initialised(self) -> None:
        with self._lock:
            if self._ready:
                return
            init_ee(self._key_setting)
            ee.data.setDeadline(self._request_timeout_ms)
            ee.data.setMaxRetries(self._max_retries)
            self._ready = True

    def compute(
        self, geojson: Mapping[str, Any], *, site_key: str, checkpoint: Checkpoint
    ) -> dict[str, Any]:
        self._ensure_initialised()
        return compute_polygon_metrics(geojson, site_key=site_key, checkpoint=checkpoint)

    def land_cover_labels(self, geojson: Mapping[str, Any], grid: PixelGrid) -> LandCoverLabels:
        """A listing's land-cover overlay labels (#231), with the same per-request deadline."""
        self._ensure_initialised()
        return land_cover_labels(ee.Geometry(geometry_from_feature(geojson)), grid)

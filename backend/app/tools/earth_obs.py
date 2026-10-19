"""Load precomputed Earth observation metrics for demo sites.

This loader never imports Earth Engine. ``scripts/precompute_sites.py`` computes the observed
(baseline) JSON offline (T11, T13) and derives the Time Machine scenario variants from it with
the pure functions in ``app.tools.scenarios``; this loader is safe to call on the judging path.
New listings' polygons are computed live with the same methods (``app.tools.earth_engine``,
T60) only when ``EARTH_ENGINE_LIVE=true``.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class DateWindow(BaseModel):
    model_config = ConfigDict(frozen=True)

    start: str
    end: str


class DatasetUse(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: str
    dataset_id: str
    version: str
    catalog_url: str
    bands: tuple[str, ...]
    attribution: str


class NdviPoint(BaseModel):
    """One month of cloud-masked Sentinel-2 NDVI (monthly median); also served on reports."""

    model_config = ConfigDict(frozen=True)

    month: str = Field(description="Calendar month, YYYY-MM.")
    ndvi: float
    cloud_free_obs: int


class NdviTrendDetails(BaseModel):
    model_config = ConfigDict(frozen=True)

    sens_slope_per_year: float
    mann_kendall_tau: float
    mann_kendall_p_value: float
    significant_05: bool
    mean_last_12_months: float | None = None


class Centroid(BaseModel):
    model_config = ConfigDict(frozen=True)

    lat: float
    lon: float


LandcoverClass = Literal[
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
ScenarioName = Literal["baseline", "restoration", "encroachment"]


class LandcoverTransfer(BaseModel):
    """Move ``pp`` percentage points of land cover from ``from`` classes into ``to``.

    The points are taken from the source classes in proportion to their current shares.
    """

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    from_classes: tuple[LandcoverClass, ...] = Field(alias="from", min_length=1)
    to: LandcoverClass
    pp: float = Field(gt=0, le=100)


class ScenarioDeltas(BaseModel):
    """Scripted, deterministic changes applied to a parent version's metrics (T13)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    description: str = Field(min_length=1)
    landcover_transfers: tuple[LandcoverTransfer, ...] = ()
    ndvi_step_last_12m: float = Field(default=0.0, ge=-0.5, le=0.5)
    """Added to each of the latest 12 monthly NDVI values; mean, Sen's slope and the
    Mann-Kendall test are then recomputed from the shifted series."""
    water_change_delta: float = 0.0
    biomass_pct_change: float = Field(default=0.0, ge=-100)
    extra_forest_loss_ha: float = Field(default=0.0, ge=0)
    """Forest loss on top of the tree cover removed by ``landcover_transfers``."""


class EarthObsMetrics(BaseModel):
    model_config = ConfigDict(frozen=True)

    site_key: str
    data_version: str
    computed_at_utc: str
    area_ha: float
    centroid: Centroid
    landcover: dict[str, float]
    natural_fraction: float
    ndvi_series: tuple[NdviPoint, ...]
    ndvi_mean: float
    ndvi_trend: float
    ndvi_trend_details: NdviTrendDetails
    water_change: float
    forest_loss_ha: float
    biomass_t_ha: float
    """Mean above-ground biomass (t/ha); ESA CCI Biomass v6.0, 2022 map, since T13 review."""
    biomass_source: str | None = None
    """Dataset key of ``biomass_t_ha`` (``esa_cci_biomass``; T11 files said ``gedi_l4b``)."""
    biomass_gedi_t_ha: float | None = None
    """GEDI L4B mean AGB cross-check (t/ha); ``None`` where GEDI has no 1 km cell."""
    mangrove_fraction: float | None = None
    """Area share of the polygon mapped as mangrove by Global Mangrove Watch v3 (2020).
    T14 values ``min(mangrove_fraction, trees + flooded_vegetation)`` as mangrove."""
    soc_t_c_ha: float | None = None
    """SoilGrids 2.0 soil organic carbon stock, 0-30 cm, polygon mean (t C/ha)."""
    forest_loss_last_12m_ha: float | None = None
    """Hansen loss in the latest complete dataset year only (T15 listing gate)."""
    cloud_free_obs: int
    cloud_free_months_5y: int
    date_windows: dict[str, DateWindow]
    thresholds: dict[str, float | int | str]
    datasets: tuple[DatasetUse, ...]
    attributions: tuple[str, ...] = Field(min_length=1)
    scenario: ScenarioName = "baseline"
    simulated: bool = False
    """True for Time Machine variants: scripted deltas, never observed data."""
    based_on: str | None = None
    """``data_version`` of the version the deltas were applied to."""
    period: str | None = None
    """Quarter the Time Machine shows this version as (e.g. ``2026Q4``)."""
    scenario_deltas: ScenarioDeltas | None = None
    observed_data_version: str | None = None
    """For simulated versions: the observed ``data_version`` the delta chain starts from."""
    provenance_note: str | None = None
    """For simulated versions: ``date_windows``, ``datasets`` and ``thresholds`` describe
    that observed data, not this version; never show them as observation periods."""

    @model_validator(mode="after")
    def _check_simulation_labels(self) -> EarthObsMetrics:
        if self.simulated != (self.scenario != "baseline"):
            raise ValueError("simulated must be true exactly when scenario is not 'baseline'.")
        sim_fields = {
            "based_on": self.based_on,
            "period": self.period,
            "scenario_deltas": self.scenario_deltas,
            "observed_data_version": self.observed_data_version,
            "provenance_note": self.provenance_note,
        }
        if self.simulated:
            missing = [name for name, value in sim_fields.items() if value is None]
            if missing:
                raise ValueError(f"Simulated metrics need {missing}.")
        else:
            present = [name for name, value in sim_fields.items() if value is not None]
            if present:
                raise ValueError(f"Observed metrics can't carry simulation fields {present}.")
        return self


DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "demo_sites"
SCENARIO_DIR = DATA_DIR / "scenarios"
_KEY_RE = re.compile(r"^[a-z0-9_]+$")


def scenario_path(site_key: str, scenario: ScenarioName) -> Path:
    """Committed JSON path for a site's scenario version (baseline = observed metrics)."""
    if not _KEY_RE.fullmatch(site_key):
        raise ValueError(f"Invalid site key {site_key!r}.")
    if scenario == "baseline":
        return DATA_DIR / f"{site_key}.json"
    return SCENARIO_DIR / f"{site_key}.{scenario}.json"


def load_site_metrics(site_key: str, scenario: ScenarioName = "baseline") -> EarthObsMetrics:
    """Return cached Earth observation metrics for a demo site key and scenario version."""
    path = scenario_path(site_key, scenario)
    if not path.exists():
        raise ValueError(
            f"No cached Earth observation metrics for site {site_key!r} (scenario {scenario!r})."
        )
    metrics = EarthObsMetrics.model_validate_json(path.read_text())
    if metrics.scenario != scenario or metrics.site_key != site_key:
        raise ValueError(
            f"{path.name} holds {metrics.site_key!r}/{metrics.scenario!r}, "
            f"not {site_key!r}/{scenario!r}."
        )
    return metrics


def is_curated_site(site_key: str) -> bool:
    """True for a committed demo site (T11/T13). A new listing must never be rated with one."""
    return bool(_KEY_RE.fullmatch(site_key)) and (DATA_DIR / f"{site_key}.json").exists()


# ----- mock metrics for new polygons (USE_MOCKS=true only; T58) --------------------------------

MOCK_SITE_KEY = "mock_listing"
MOCK_DATA_VERSION_PREFIX = "mock-"
MOCK_FLAG = "mock_metrics"
"""Report flag type for a rating made from mock metrics."""
MOCK_ATTRIBUTION = (
    "Mock metrics (USE_MOCKS=true): deterministic placeholders for a new polygon, not observed "
    "data. Live Earth Engine metrics for new listings arrive with T60."
)
_MOCK_OBSERVED_UNTIL = "2026-10-01"
_MOCK_LANDCOVER = {
    "water": 0.08,
    "trees": 0.55,
    "grass": 0.12,
    "flooded_vegetation": 0.05,
    "crops": 0.06,
    "shrub_and_scrub": 0.10,
    "built": 0.03,
    "bare": 0.01,
    "snow_and_ice": 0.0,
}
_MOCK_NATURAL = ("water", "trees", "grass", "flooded_vegetation", "shrub_and_scrub")


def is_mock_metrics(metrics: EarthObsMetrics) -> bool:
    return metrics.data_version.startswith(MOCK_DATA_VERSION_PREFIX)


def mock_listing_metrics(
    *, area_ha: float, centroid_lat: float, centroid_lon: float
) -> EarthObsMetrics:
    """Deterministic, clearly labelled stand-in metrics for any polygon (tests and E2E).

    Only the area and centroid come from the polygon; every other number is a fixed healthy
    profile, so the result never borrows a real site's observations. The data version starts
    with `mock-` and the attribution says it is mock data, so reports carry a `mock_metrics`
    flag. Never used unless `USE_MOCKS=true`.
    """
    months = [f"{2021 + (9 + i) // 12}-{(9 + i) % 12 + 1:02d}" for i in range(60)]
    series = tuple(
        NdviPoint(
            month=month, ndvi=round(0.68 + 0.04 * ((i % 12) - 5.5) / 5.5, 4), cloud_free_obs=6
        )
        for i, month in enumerate(months)
    )
    last_12 = [point.ndvi for point in series[-12:]]
    window = DateWindow(start="2025-10-01", end=_MOCK_OBSERVED_UNTIL)
    return EarthObsMetrics(
        site_key=MOCK_SITE_KEY,
        data_version=f"{MOCK_DATA_VERSION_PREFIX}2026Q3",
        computed_at_utc=f"{_MOCK_OBSERVED_UNTIL}T00:00:00Z",
        area_ha=area_ha,
        centroid=Centroid(lat=centroid_lat, lon=centroid_lon),
        landcover=dict(_MOCK_LANDCOVER),
        natural_fraction=round(sum(_MOCK_LANDCOVER[key] for key in _MOCK_NATURAL), 4),
        ndvi_series=series,
        ndvi_mean=round(sum(last_12) / len(last_12), 4),
        ndvi_trend=0.004,
        ndvi_trend_details=NdviTrendDetails(
            sens_slope_per_year=0.004,
            mann_kendall_tau=0.05,
            mann_kendall_p_value=0.5,
            significant_05=False,
            mean_last_12_months=round(sum(last_12) / len(last_12), 4),
        ),
        water_change=0.0,
        forest_loss_ha=0.0,
        forest_loss_last_12m_ha=0.0,
        biomass_t_ha=120.0,
        biomass_source="mock",
        mangrove_fraction=0.0,
        soc_t_c_ha=60.0,
        cloud_free_obs=72,
        cloud_free_months_5y=60,
        date_windows={
            "cloud_free_obs": window,
            "land_cover": window,
            "ndvi": DateWindow(start="2021-10-01", end=_MOCK_OBSERVED_UNTIL),
            "hansen_forest_loss": DateWindow(start="2021-01-01", end="2025-12-31"),
            "hansen_forest_loss_last_12m": DateWindow(start="2025-01-01", end="2025-12-31"),
        },
        thresholds={"mock": "USE_MOCKS=true"},
        datasets=(),
        attributions=(MOCK_ATTRIBUTION,),
    )

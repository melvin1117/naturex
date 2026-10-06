"""Load precomputed Earth observation metrics for demo sites.

The runtime app deliberately does not import Earth Engine. T11 computes these JSON files
offline with ``scripts/precompute_sites.py``; T13/T15 can safely call this loader on the
judging path.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


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
    model_config = ConfigDict(frozen=True)

    month: str
    ndvi: float
    cloud_free_observations: int


class NdviTrend(BaseModel):
    model_config = ConfigDict(frozen=True)

    mean_last_12_months: float
    sens_slope_per_year: float
    mann_kendall_tau: float
    mann_kendall_p_value: float
    significant_05: bool


class Centroid(BaseModel):
    model_config = ConfigDict(frozen=True)

    lat: float
    lon: float


class EarthObsMetrics(BaseModel):
    model_config = ConfigDict(frozen=True)

    site_key: str
    data_version: str
    computed_at_utc: str
    area_ha: float
    centroid: Centroid
    land_cover_fractions: dict[str, float]
    natural_fraction: float
    ndvi_series: tuple[NdviPoint, ...]
    ndvi_trend: NdviTrend
    water_change_mean_abs: float
    forest_loss_last_5y_ha: float
    biomass_mean_t_ha: float
    cloud_free_observations_last_12m: int
    cloud_free_months_5y: int
    date_windows: dict[str, DateWindow]
    thresholds: dict[str, float | int | str]
    datasets: tuple[DatasetUse, ...]
    attributions: tuple[str, ...] = Field(min_length=1)


DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "demo_sites"


def load_site_metrics(site_key: str) -> EarthObsMetrics:
    """Return cached Earth observation metrics for a demo site key."""
    path = DATA_DIR / f"{site_key}.json"
    if not path.exists():
        raise ValueError(f"No cached Earth observation metrics for site {site_key!r}.")
    return EarthObsMetrics.model_validate_json(path.read_text())

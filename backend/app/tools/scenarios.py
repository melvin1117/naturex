"""Time Machine scenario versions of the demo-site metrics (dev-spec §7.2, T13).

Each simulated version is the parent version's metrics with scripted, deterministic deltas
applied (``data/demo_sites/scenarios.json``). No Earth Engine call and no model is involved,
so the committed variants can be regenerated and checked offline. Every variant carries
``simulated=True``, its ``scenario``, ``based_on`` and the deltas it was built from, so a
simulated number is never shown as an observation.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from statistics import median
from typing import Any, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.tools.earth_obs import (
    DATA_DIR,
    EarthObsMetrics,
    LandcoverClass,
    NdviPoint,
    NdviTrendDetails,
    ScenarioDeltas,
    ScenarioName,
)

SCENARIO_SPEC_PATH = DATA_DIR / "scenarios.json"
LANDCOVER_CLASSES: tuple[str, ...] = get_args(LandcoverClass)
NATURAL_CLASSES = frozenset(
    {"water", "trees", "grass", "flooded_vegetation", "shrub_and_scrub"}
)  # dev-spec §7.4 N
NDVI_WINDOW_MONTHS = 12
DECIMALS = 4
_UNIT = 10**DECIMALS


class ScenarioVersion(BaseModel):
    """One step of the Time Machine timeline."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    scenario: ScenarioName
    period: str = Field(pattern=r"^\d{4}Q[1-4]$")
    data_version: str | None = Field(default=None, pattern=r"^sim-\d+$")
    """``None`` for the observed baseline, which keeps its own ``data_version``."""
    based_on: ScenarioName | None = None


class ScenarioSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    doc: str = ""
    timeline: tuple[ScenarioVersion, ...] = Field(min_length=1)
    sites: dict[str, dict[ScenarioName, ScenarioDeltas]]

    @model_validator(mode="after")
    def _check_timeline(self) -> ScenarioSpec:
        if self.timeline[0].scenario != "baseline" or self.timeline[0].based_on is not None:
            raise ValueError("The timeline must start with the observed baseline.")
        seen: set[str] = set()
        for version in self.timeline:
            if version.scenario in seen:
                raise ValueError(f"Scenario {version.scenario!r} appears twice in the timeline.")
            if version.scenario != "baseline" and (
                version.data_version is None or version.based_on not in seen
            ):
                raise ValueError(
                    f"Scenario {version.scenario!r} needs a sim-N data_version and an "
                    "earlier based_on version."
                )
            seen.add(version.scenario)
        simulated = seen - {"baseline"}
        for site_key, deltas in self.sites.items():
            if set(deltas) != simulated:
                raise ValueError(f"Site {site_key!r} must define deltas for {sorted(simulated)}.")
        return self


def load_scenario_spec(path: Path = SCENARIO_SPEC_PATH) -> ScenarioSpec:
    return ScenarioSpec.model_validate_json(path.read_text())


# --- NDVI trend statistics (same definitions as the Earth Engine reducers in ADR-0004) ---


def _month_index(month: str) -> int:
    year, mon = month.split("-")
    return int(year) * 12 + int(mon) - 1


def sens_slope(t: Sequence[float], y: Sequence[float]) -> float:
    """Median of pairwise slopes (``ee.Reducer.sensSlope``)."""
    slopes = [
        (y[j] - y[i]) / (t[j] - t[i])
        for i in range(len(y))
        for j in range(i + 1, len(y))
        if t[j] != t[i]
    ]
    if not slopes:
        raise ValueError("Sen's slope needs at least two distinct time points.")
    return float(median(slopes))


def kendall_tau(t: Sequence[float], y: Sequence[float]) -> float:
    """Kendall's tau-b between time and value (``ee.Reducer.kendallsCorrelation``)."""
    n = len(y)
    concordant = discordant = ties_t = ties_y = 0
    for i in range(n):
        for j in range(i + 1, n):
            dt = t[j] - t[i]
            dy = y[j] - y[i]
            if dt == 0 and dy == 0:
                continue
            if dt == 0:
                ties_t += 1
            elif dy == 0:
                ties_y += 1
            elif (dt > 0) == (dy > 0):
                concordant += 1
            else:
                discordant += 1
    denominator = math.sqrt((concordant + discordant + ties_t) * (concordant + discordant + ties_y))
    return 0.0 if denominator == 0 else (concordant - discordant) / denominator


def mann_kendall_p_value(tau: float, n: int) -> float:
    """Two-sided p-value from tau with the normal approximation (ADR-0004)."""
    s = tau * n * (n - 1) / 2
    if not s:
        return 1.0
    variance = n * (n - 1) * (2 * n + 5) / 18
    z = (s - math.copysign(1, s)) / math.sqrt(variance)
    return math.erfc(abs(z) / math.sqrt(2))


def ndvi_trend(series: Sequence[NdviPoint]) -> NdviTrendDetails:
    """Last-12-month mean, Sen's slope per year and Mann-Kendall test of a monthly series."""
    if len(series) < NDVI_WINDOW_MONTHS:
        raise ValueError(f"Need at least {NDVI_WINDOW_MONTHS} NDVI months.")
    first = _month_index(series[0].month)
    t = [(_month_index(point.month) - first) / 12 for point in series]
    y = [point.ndvi for point in series]
    tau = kendall_tau(t, y)
    p_value = mann_kendall_p_value(tau, len(y))
    return NdviTrendDetails(
        sens_slope_per_year=sens_slope(t, y),
        mann_kendall_tau=tau,
        mann_kendall_p_value=p_value,
        significant_05=p_value < 0.05,
        mean_last_12_months=sum(y[-NDVI_WINDOW_MONTHS:]) / NDVI_WINDOW_MONTHS,
    )


# --- Land cover ---


def round_fractions(fractions: Mapping[str, float]) -> dict[str, float]:
    """Round shares to 4 dp so they sum to exactly 1 (largest remainder)."""
    total = sum(fractions.values())
    if total <= 0:
        raise ValueError("Land cover has no area.")
    scaled = {key: value / total * _UNIT for key, value in fractions.items()}
    units = {key: math.floor(value) for key, value in scaled.items()}
    remainder = _UNIT - sum(units.values())
    by_remainder = sorted(scaled, key=lambda key: (-(scaled[key] - units[key]), key))
    for key in by_remainder[:remainder]:
        units[key] += 1
    return {key: units[key] / _UNIT for key in sorted(units)}


def apply_landcover_transfers(
    landcover: Mapping[str, float], deltas: ScenarioDeltas
) -> tuple[dict[str, float], float]:
    """Apply the transfers in order; return the new shares and the tree share removed.

    Raises ``ValueError`` if a transfer asks for more than its source classes hold, so a
    spec can never produce negative land cover.
    """
    shares = {name: float(landcover.get(name, 0.0)) for name in LANDCOVER_CLASSES}
    trees_removed = 0.0
    for transfer in deltas.landcover_transfers:
        sources = [name for name in transfer.from_classes if name != transfer.to]
        available = sum(shares[name] for name in sources)
        amount = transfer.pp / 100
        if amount > available + 1e-9:
            raise ValueError(
                f"Transfer of {transfer.pp} pp to {transfer.to!r} exceeds the "
                f"{available * 100:.2f} pp held by {sources}."
            )
        for name in sources:
            taken = amount * shares[name] / available
            shares[name] = max(shares[name] - taken, 0.0)
            if name == "trees":
                trees_removed += taken
        shares[transfer.to] += amount
    return round_fractions(shares), trees_removed


def natural_fraction(landcover: Mapping[str, float]) -> float:
    return sum(value for name, value in landcover.items() if name in NATURAL_CLASSES)


# --- Scenario application ---


def _shift_ndvi(series: Sequence[NdviPoint], step: float) -> tuple[NdviPoint, ...]:
    cutoff = len(series) - NDVI_WINDOW_MONTHS
    return tuple(
        point.model_copy(
            update={"ndvi": min(max(point.ndvi + step, -1.0), 1.0) if i >= cutoff else point.ndvi}
        )
        for i, point in enumerate(series)
    )


def round_floats(value: Any) -> Any:
    if isinstance(value, float):
        if math.isnan(value):
            raise ValueError("Unexpected NaN in output.")
        return round(value, DECIMALS) + 0.0  # normalise -0.0
    if isinstance(value, list):
        return [round_floats(item) for item in value]
    if isinstance(value, dict):
        return {key: round_floats(value[key]) for key in sorted(value)}
    return value


def apply_scenario(
    parent: EarthObsMetrics, deltas: ScenarioDeltas, version: ScenarioVersion
) -> EarthObsMetrics:
    """Return ``parent`` with ``deltas`` applied, labelled as a simulated version."""
    if version.data_version is None or version.scenario == "baseline":
        raise ValueError("Only simulated versions can be produced from deltas.")
    landcover, trees_removed = apply_landcover_transfers(parent.landcover, deltas)
    added_loss = trees_removed * parent.area_ha + deltas.extra_forest_loss_ha
    series = _shift_ndvi(parent.ndvi_series, deltas.ndvi_step_last_12m)
    trend = ndvi_trend(series)
    assert trend.mean_last_12_months is not None
    update: dict[str, Any] = {
        "data_version": version.data_version,
        "scenario": version.scenario,
        "simulated": True,
        "based_on": parent.data_version,
        "period": version.period,
        "scenario_deltas": deltas,
        "landcover": landcover,
        "natural_fraction": natural_fraction(landcover),
        "ndvi_series": series,
        "ndvi_mean": trend.mean_last_12_months,
        "ndvi_trend": trend.sens_slope_per_year,
        "ndvi_trend_details": trend,
        "water_change": parent.water_change + deltas.water_change_delta,
        "forest_loss_ha": parent.forest_loss_ha + added_loss,
        "forest_loss_last_12m_ha": (parent.forest_loss_last_12m_ha or 0.0) + added_loss,
        "biomass_t_ha": parent.biomass_t_ha * (1 + deltas.biomass_pct_change / 100),
    }
    # Round like the precompute output so a regenerated file is byte-identical.
    data = round_floats(parent.model_copy(update=update).model_dump(mode="json"))
    return EarthObsMetrics.model_validate(data)


def build_site_scenarios(
    baseline: EarthObsMetrics, spec: ScenarioSpec
) -> dict[ScenarioName, EarthObsMetrics]:
    """Every timeline version for one site, chained through ``based_on``."""
    if baseline.simulated:
        raise ValueError("Scenarios must be built from observed metrics.")
    site_deltas = spec.sites.get(baseline.site_key)
    if site_deltas is None:
        raise ValueError(f"No scenario deltas for site {baseline.site_key!r}.")
    versions: dict[ScenarioName, EarthObsMetrics] = {"baseline": baseline}
    for version in spec.timeline[1:]:
        assert version.based_on is not None
        versions[version.scenario] = apply_scenario(
            versions[version.based_on], site_deltas[version.scenario], version
        )
    return versions


def scenario_document(metrics: EarthObsMetrics) -> dict[str, Any]:
    """Committed JSON form of a simulated version (sorted keys, 4 dp)."""
    return dict(round_floats(metrics.model_dump(mode="json", by_alias=True)))

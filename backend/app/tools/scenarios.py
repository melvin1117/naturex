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
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Literal, get_args

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
    data_version: str | None = Field(default=None, pattern=r"^sim-\d+(-[a-z]+)?$")
    """``None`` for the observed baseline, which keeps its own ``data_version``; ``sim-N`` for a
    timeline quarter, ``sim-N-<preset>`` for an event preset injected at step N (T38)."""
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


MANGROVE_HOST_CLASSES = ("trees", "flooded_vegetation")


@dataclass(frozen=True, slots=True)
class TransferResult:
    landcover: dict[str, float]
    """New shares, rounded to 4 dp and summing to exactly 1."""
    trees_removed: float
    """Tree share moved to other classes (becomes forest loss)."""
    mangrove_retained: float
    """Share of the trees + flooded vegetation that survived every transfer (0..1)."""


def apply_landcover_transfers(
    landcover: Mapping[str, float], deltas: ScenarioDeltas
) -> TransferResult:
    """Apply the transfers in order.

    Raises ``ValueError`` if a transfer asks for more than its source classes hold, so a
    spec can never produce negative land cover.
    """
    shares = {name: float(landcover.get(name, 0.0)) for name in LANDCOVER_CLASSES}
    trees_removed = 0.0
    mangrove_retained = 1.0
    for transfer in deltas.landcover_transfers:
        sources = [name for name in transfer.from_classes if name != transfer.to]
        available = sum(shares[name] for name in sources)
        amount = transfer.pp / 100
        if amount > available + 1e-9:
            raise ValueError(
                f"Transfer of {transfer.pp} pp to {transfer.to!r} exceeds the "
                f"{available * 100:.2f} pp held by {sources}."
            )
        host_before = sum(shares[name] for name in MANGROVE_HOST_CLASSES)
        host_removed = 0.0
        for name in sources:
            taken = amount * shares[name] / available
            shares[name] = max(shares[name] - taken, 0.0)
            if name == "trees":
                trees_removed += taken
            if name in MANGROVE_HOST_CLASSES and transfer.to not in MANGROVE_HOST_CLASSES:
                host_removed += taken
        shares[transfer.to] += amount
        if host_before > 0:
            mangrove_retained *= max(1.0 - host_removed / host_before, 0.0)
    return TransferResult(round_fractions(shares), trees_removed, mangrove_retained)


def scale_mangrove_fraction(
    mangrove_fraction: float | None, retained: float, landcover: Mapping[str, float]
) -> float | None:
    """Mangrove lost in proportion to the trees + flooded vegetation cleared.

    Assumes mapped mangrove is spread evenly over those host classes; gains don't add
    mangrove (replanted seedlings aren't mapped yet). Never exceeds trees + flooded
    vegetation in the new land cover.
    """
    if mangrove_fraction is None:
        return None
    host = sum(landcover.get(name, 0.0) for name in MANGROVE_HOST_CLASSES)
    return min(mangrove_fraction * retained, host)


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
    transfers = apply_landcover_transfers(parent.landcover, deltas)
    landcover = transfers.landcover
    added_loss = transfers.trees_removed * parent.area_ha + deltas.extra_forest_loss_ha
    observed = parent.observed_data_version or parent.data_version
    biomass_factor = 1 + deltas.biomass_pct_change / 100
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
        "observed_data_version": observed,
        "provenance_note": (
            f"Simulated '{version.scenario}' version for the Time Machine: scripted deltas "
            f"applied to {parent.data_version}, starting from observed data {observed}. Not an "
            "observation; date_windows, datasets and thresholds describe the observed data."
        ),
        "landcover": landcover,
        "mangrove_fraction": scale_mangrove_fraction(
            parent.mangrove_fraction, transfers.mangrove_retained, landcover
        ),
        "natural_fraction": natural_fraction(landcover),
        "ndvi_series": series,
        "ndvi_mean": trend.mean_last_12_months,
        "ndvi_trend": trend.sens_slope_per_year,
        "ndvi_trend_details": trend,
        "water_change": parent.water_change + deltas.water_change_delta,
        "forest_loss_ha": parent.forest_loss_ha + added_loss,
        "forest_loss_last_12m_ha": (parent.forest_loss_last_12m_ha or 0.0) + added_loss,
        "biomass_t_ha": parent.biomass_t_ha * biomass_factor,
        "biomass_gedi_t_ha": (
            None if parent.biomass_gedi_t_ha is None else parent.biomass_gedi_t_ha * biomass_factor
        ),
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


# --- Time Machine: quarters and event presets (T38) ---

PresetName = Literal["fire", "encroachment", "drought", "restoration", "protection"]
PRESET_NAMES: tuple[PresetName, ...] = get_args(PresetName)


@dataclass(frozen=True, slots=True)
class EventPreset:
    """An event the admin can inject: what the event says and its deterministic effect."""

    name: PresetName
    label: str
    impact_type: str
    """News Scout's impact type (`events.impact_type`)."""
    direction: Literal[-1, 1]
    severity: int
    """1-5; 4 or more alerts the asset's holders and community like a news item (T75)."""
    deltas: ScenarioDeltas
    """The effect on any site; curated sites use their own scripted encroachment and
    restoration (`scenarios.json`) instead."""


def _transfer(sources: tuple[str, ...], to: str, pp: float) -> dict[str, Any]:
    return {"from": sources, "to": to, "pp": pp}


EVENT_PRESETS: dict[PresetName, EventPreset] = {
    "fire": EventPreset(
        name="fire",
        label="Fire",
        impact_type="fire",
        direction=-1,
        severity=4,
        deltas=ScenarioDeltas.model_validate(
            {
                "description": "A wildfire burns part of the site: 6 pp of trees, scrub and "
                "grass become bare ground, the last 12 months brown and biomass drops 12%.",
                "landcover_transfers": [
                    _transfer(("trees", "shrub_and_scrub", "grass"), "bare", 6)
                ],
                "ndvi_step_last_12m": -0.10,
                "biomass_pct_change": -12,
            }
        ),
    ),
    "encroachment": EventPreset(
        name="encroachment",
        label="Encroachment",
        impact_type="encroachment",
        direction=-1,
        severity=4,
        deltas=ScenarioDeltas.model_validate(
            {
                "description": "Encroachment clears part of the site: 5 pp of trees, scrub, "
                "grass and flooded vegetation become built land and 3 pp crops, the last 12 "
                "months brown and biomass drops 6%.",
                "landcover_transfers": [
                    _transfer(
                        ("trees", "shrub_and_scrub", "grass", "flooded_vegetation"), "built", 5
                    ),
                    _transfer(
                        ("trees", "shrub_and_scrub", "grass", "flooded_vegetation"), "crops", 3
                    ),
                ],
                "ndvi_step_last_12m": -0.06,
                "biomass_pct_change": -6,
            }
        ),
    ),
    "drought": EventPreset(
        name="drought",
        label="Drought",
        impact_type="drought",
        direction=-1,
        severity=4,
        deltas=ScenarioDeltas.model_validate(
            {
                "description": "A severe drought: 4 pp of open water and flooded vegetation "
                "dry out to bare ground, the last 12 months brown, surface water falls and "
                "biomass drops 3%.",
                "landcover_transfers": [_transfer(("water", "flooded_vegetation"), "bare", 4)],
                "ndvi_step_last_12m": -0.06,
                "water_change_delta": -20,
                "biomass_pct_change": -3,
            }
        ),
    ),
    "restoration": EventPreset(
        name="restoration",
        label="Restoration",
        impact_type="restoration",
        direction=1,
        severity=2,
        deltas=ScenarioDeltas.model_validate(
            {
                "description": "A restoration project succeeds: 4 pp of bare, built and "
                "cropped land is replanted with trees, the last 12 months are greener and "
                "biomass grows 3%.",
                "landcover_transfers": [_transfer(("bare", "built", "crops"), "trees", 4)],
                "ndvi_step_last_12m": 0.03,
                "biomass_pct_change": 3,
            }
        ),
    ),
    "protection": EventPreset(
        name="protection",
        label="Protection",
        impact_type="protection",
        direction=1,
        severity=2,
        deltas=ScenarioDeltas.model_validate(
            {
                "description": "A new protection law halts clearing: 1 pp of bare, built and "
                "cropped land starts to regrow as scrub, the last 12 months are slightly "
                "greener and biomass grows 1%.",
                "landcover_transfers": [
                    _transfer(("bare", "built", "crops"), "shrub_and_scrub", 1)
                ],
                "ndvi_step_last_12m": 0.01,
                "biomass_pct_change": 1,
            }
        ),
    ),
}


def fit_deltas(deltas: ScenarioDeltas, landcover: Mapping[str, float]) -> ScenarioDeltas:
    """``deltas`` with each land-cover transfer capped at what its source classes hold then
    (4 dp, rounded down); a transfer with nothing left to move is dropped.

    Returns ``deltas`` itself when every transfer fits, so a quarter applied to a committed
    version gives exactly the committed next version. A site already damaged by a preset
    can't then make `apply_landcover_transfers` refuse the quarter.
    """
    shares = {name: float(landcover.get(name, 0.0)) for name in LANDCOVER_CLASSES}
    fitted: list[Any] = []
    changed = False
    for transfer in deltas.landcover_transfers:
        sources = [name for name in transfer.from_classes if name != transfer.to]
        available = sum(shares[name] for name in sources)
        pp = min(transfer.pp, math.floor(available * 100 * _UNIT) / _UNIT)
        if pp < transfer.pp:
            changed = True
        if pp <= 0:
            continue
        fitted.append(transfer if pp == transfer.pp else transfer.model_copy(update={"pp": pp}))
        amount = pp / 100
        for name in sources:
            shares[name] = max(shares[name] - amount * shares[name] / available, 0.0)
        shares[transfer.to] += amount
    if not changed:
        return deltas
    return deltas.model_copy(update={"landcover_transfers": tuple(fitted)})


def preset_deltas(preset: PresetName, site_key: str | None, spec: ScenarioSpec) -> ScenarioDeltas:
    """A curated site's own scripted encroachment or restoration (T13 notes), else the
    preset's generic effect."""
    site = spec.sites.get(site_key or "")
    if site is not None and preset in site:
        return site[preset]
    return EVENT_PRESETS[preset].deltas


def timeline_version(spec: ScenarioSpec, step: int) -> ScenarioVersion:
    """The timeline entry a world at `step` stands at (0 = the observed baseline)."""
    if not 0 <= step < len(spec.timeline):
        raise ValueError(f"step {step} is outside the {len(spec.timeline)}-entry timeline")
    return spec.timeline[step]


def preset_version(preset: PresetName, step: int, period: str) -> ScenarioVersion:
    """The labels of a preset injected while the world stands at `step` (shown as `period`)."""
    return ScenarioVersion(scenario=preset, period=period, data_version=f"sim-{step}-{preset}")


def advance(
    current: EarthObsMetrics, deltas: ScenarioDeltas, version: ScenarioVersion
) -> EarthObsMetrics:
    """The asset's next simulated version: `deltas` (fitted to its land cover) applied to its
    current metrics, labelled `version`. Pure and deterministic; raises ValueError only for a
    version that can't be simulated (the baseline)."""
    return apply_scenario(current, fit_deltas(deltas, current.landcover), version)

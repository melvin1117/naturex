"""Deterministic ecosystem-service valuation and carbon stock for a site (dev-spec §7.3).

Every number here comes from cited tables in ``data/`` and plain arithmetic; no model is
involved. The flow is:

1. Map each Dynamic World class to a biome. Coastal ``flooded_vegetation`` (centroid
   within 5 km of the Natural Earth coastline) is mangrove when |lat| < 30°, else coastal
   systems (tidal / salt marsh); inland it is swamps / floodplains. ``trees`` is tropical
   forest when |lat| < 23.5°.
2. ``value_c = area_ha × share_c × coeff_c × context_multiplier`` for low, mid and high.
   Coefficients (``data/coefficients.csv``) are Brander et al. 2024 Table 1 biome means
   in Int$ at 2020 price levels. Mid = high = that mean (Brander publishes no biome-level
   dispersion). Low is an indicative median-equivalent: the mean × the median/mean ratio
   published in Costanza et al. 2014 Table 4.
3. Split each class's mid value across services in proportion to Brander 2024 Table 1's
   per-service means for its biome (``data/service_values.csv``), grouped into eight
   service groups.
4. Carbon stock and annual sequestration use IPCC Tier 1 factors
   (``data/carbon_factors.csv``) and are reported in tCO₂ only. They are **never** added
   to the dollar value, which already includes climate regulation (no double counting).

Money and tonnes are computed with ``Decimal`` at 50 significant digits and rounded only
at the output boundary: totals to whole units with round-half-even, and per-class and
per-service splits with the largest-remainder method (ties broken by name), so they sum
exactly to the rounded totals.

Land-cover policy: fractions must be finite and in [0, 1]; they're renormalised to sum
to 1 when their sum is within ±0.01 of 1 (rounding in the cached metrics), and rejected
otherwise. Missing classes count as 0; unknown class names are rejected.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import ROUND_FLOOR, ROUND_HALF_EVEN, Context, Decimal, localcontext
from functools import lru_cache
from pathlib import Path
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.tools.coastline import (
    COASTAL_THRESHOLD_KM,
    COASTLINE_SOURCE,
    CoastlineIndex,
    default_coastline,
)
from app.tools.earth_obs import EarthObsMetrics

METHODS_VERSION = "naturex-valuation/1.1.0 (T14)"
PRICE_BASIS = "Int$2020/ha/yr"
"""Brander 2024's basis: international dollars at 2020 price levels. One Int$ buys what one
US$ buys in the United States, so Int$2020 equals US$2020 at US prices. Only this basis
is used; Costanza 2014 contributes dimensionless median/mean ratios, never dollar values."""
VALUE_UNIT = "Int$2020/yr"
TROPICS_MAX_ABS_LAT = Decimal("23.5")
MANGROVE_MAX_ABS_LAT = Decimal("30")
"""Mangroves grow "largely between 30° N and 30° S latitude" (Giri 2021, Remote Sensing
13:563, doi:10.3390/rs13040563). Coastal wetland beyond that is valued as coastal systems."""
RANGE_BASIS = (
    "mid = high = Brander et al. 2024 Table 1 biome mean; low = indicative "
    "median-equivalent (mean x median/mean ratio from Costanza et al. 2014 Table 4)"
)
CARBON_FRACTION = Decimal("0.47")
"""IPCC 2006 Vol 4 Ch 4 Table 4.3 default carbon fraction of dry matter."""
LANDCOVER_SUM_TOLERANCE = Decimal("0.01")
SHARE_QUANTUM = Decimal("0.000001")
DATA_DIR = Path(__file__).resolve().parents[2] / "data"

DWClass = Literal[
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
DW_CLASSES: tuple[DWClass, ...] = get_args(DWClass)
GMW_SOURCE = (
    "Global Mangrove Watch v3 (Bunting, P. et al. 2022, Remote Sensing 14:3657, "
    "doi:10.3390/rs14153657, CC BY 4.0)"
)
Zone = Literal["tropical", "extratropical"]

SERVICE_GROUPS: tuple[str, ...] = (
    "food_and_materials",
    "water_supply",
    "climate_regulation",
    "flood_and_hazard_regulation",
    "pollution_and_soil",
    "habitat_and_biodiversity",
    "recreation_and_culture",
    "existence_and_bequest",
)

SOURCES: Mapping[str, str] = {
    "brander2024": (
        "Brander, L.M. et al. (2024) Economic values for ecosystem services: a global "
        "synthesis and way forward. Ecosystem Services 66:101606. "
        "doi:10.1016/j.ecoser.2024.101606 (CC BY 4.0)"
    ),
    "costanza2014": (
        "Costanza, R. et al. (2014) Changes in the global value of ecosystem services. "
        "Global Environmental Change 26:152-158. doi:10.1016/j.gloenvcha.2014.04.002"
    ),
    "ipcc2006_v4": (
        "IPCC (2006) 2006 IPCC Guidelines for National Greenhouse Gas Inventories, Vol. 4 "
        "AFOLU, Ch. 4 Forest Land and Ch. 6 Grassland"
    ),
    "ipcc2013_wetlands": (
        "IPCC (2014) 2013 Supplement to the 2006 IPCC Guidelines for National Greenhouse "
        "Gas Inventories: Wetlands, Ch. 4 Coastal Wetlands"
    ),
    "naturalearth_10m": COASTLINE_SOURCE,
    "soilgrids": "ISRIC SoilGrids soil organic carbon stock, 0-30 cm (site input)",
    "naturex_policy": "NatureX dev-spec §7.3: class not valued as natural capital",
    "giri2021": (
        "Giri, C. (2021) Recent advancement in mangrove forests mapping and monitoring of the "
        "world using Earth observation satellite data. Remote Sensing 13:563. "
        "doi:10.3390/rs13040563 (mangrove latitudinal range)"
    ),
    "gmw_v3": GMW_SOURCE,
    "esvd2020": (
        "de Groot, R., Brander, L. & Solomonides, S. (2020) Update of global ecosystem "
        "service valuation database (ESVD). FSD report 2020-06, Appendix 6 (biome classes)"
    ),
}

_CTX = Context(prec=50, rounding=ROUND_HALF_EVEN)
_ONE = Decimal(1)
_CO2_PER_C = _CTX.divide(Decimal(44), Decimal(12))


class CoefficientTableError(ValueError):
    """A data file in ``data/`` breaks the schema or its own invariants."""


@dataclass(frozen=True, slots=True)
class BiomeCoefficient:
    biome_id: str
    label: str
    low: Decimal
    mid: Decimal
    high: Decimal
    """Int$2020/ha/yr."""
    value_source_id: str
    value_ref: str
    value_verified: bool
    low_basis: str
    low_source_id: str
    low_ref: str
    low_verified: bool


@dataclass(frozen=True, slots=True)
class ServiceMean:
    service: str
    group: str
    value: Decimal
    """Brander 2024 Table 1 mean, Int$2020/ha/yr."""
    n_estimates: int
    ref: str


@dataclass(frozen=True, slots=True)
class CarbonFactor:
    """IPCC Tier 1 factors for a biome, so carbon follows the same mapping as the money."""

    biome_id: str
    zone: str
    root_shoot_ratio: Decimal
    agb_growth_t_dm_ha_yr: Decimal
    r_source_id: str
    growth_source_id: str


@dataclass(frozen=True, slots=True)
class CoefficientTable:
    price_basis: str
    biomes: Mapping[str, BiomeCoefficient]
    services: Mapping[str, tuple[ServiceMean, ...]]
    carbon: tuple[CarbonFactor, ...]

    def carbon_factor(self, biome_id: str, zone: Zone) -> CarbonFactor:
        found = [f for f in self.carbon if f.biome_id == biome_id and f.zone in ("any", zone)]
        if len(found) != 1:
            raise CoefficientTableError(
                f"Expected one carbon factor for {biome_id}/{zone}, found {len(found)}."
            )
        return found[0]


def biome_for(dw_class: DWClass, lat: Decimal, is_coastal: bool) -> str:
    """Dynamic World class → biome ID in ``coefficients.csv`` (dev-spec §7.3)."""
    if dw_class == "flooded_vegetation":
        if not is_coastal:
            return "swamp_floodplain"
        return "mangrove" if abs(lat) < MANGROVE_MAX_ABS_LAT else "coastal_systems"
    if dw_class == "water":
        return "lake_river"
    if dw_class == "trees":
        return "tropical_forest" if zone_for(lat) == "tropical" else "temperate_forest"
    if dw_class == "grass":
        return "grassland"
    if dw_class == "shrub_and_scrub":
        return "shrubland"
    return "not_valued"


def zone_for(lat: Decimal) -> Zone:
    return "tropical" if abs(lat) < TROPICS_MAX_ABS_LAT else "extratropical"


# --- Loading the cited tables -------------------------------------------------------------


def _read_csv(text: str, name: str, required: Iterable[str]) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text, newline=""))
    missing = set(required) - set(reader.fieldnames or ())
    if missing:
        raise CoefficientTableError(f"{name} is missing columns {sorted(missing)}.")
    return list(reader)


def _decimal(raw: str, what: str) -> Decimal:
    try:
        value = Decimal(raw)
    except ArithmeticError as exc:
        raise CoefficientTableError(f"{what}: {raw!r} is not a number.") from exc
    if not value.is_finite() or value < 0:
        raise CoefficientTableError(f"{what}: {raw!r} must be a finite number ≥ 0.")
    return value


def _check_source(source_id: str, ref: str, what: str) -> None:
    if source_id not in SOURCES or not ref.strip():
        raise CoefficientTableError(f"{what} needs a known source ID and a table reference.")


def _load_biomes(text: str) -> dict[str, BiomeCoefficient]:
    rows = _read_csv(
        text,
        "coefficients.csv",
        (
            "biome_id",
            "biome_label",
            "value_low",
            "value_mid",
            "value_high",
            "price_basis",
            "value_source_id",
            "value_ref",
            "value_verified",
            "low_basis",
            "low_source_id",
            "low_ref",
            "low_verified",
            "high_basis",
        ),
    )
    biomes: dict[str, BiomeCoefficient] = {}
    for row in rows:
        biome_id = row["biome_id"]
        if row["price_basis"] != PRICE_BASIS:
            raise CoefficientTableError(f"{biome_id}: price basis must be {PRICE_BASIS}.")
        low, mid, high = (
            _decimal(row[f"value_{k}"], f"{biome_id} {k}") for k in ("low", "mid", "high")
        )
        if not low <= mid <= high:
            raise CoefficientTableError(f"{biome_id}: needs low ≤ mid ≤ high.")
        if high > 0:
            _check_source(row["value_source_id"], row["value_ref"], f"{biome_id} value")
            _check_source(row["low_source_id"], row["low_ref"], f"{biome_id} low")
            if row["high_basis"] != "brander_mean" or high != mid:
                raise CoefficientTableError(
                    f"{biome_id}: high must be the Brander mean (no published biome dispersion)."
                )
        if biome_id in biomes:
            raise CoefficientTableError(f"Duplicate biome {biome_id}.")
        biomes[biome_id] = BiomeCoefficient(
            biome_id=biome_id,
            label=row["biome_label"],
            low=low,
            mid=mid,
            high=high,
            value_source_id=row["value_source_id"],
            value_ref=row["value_ref"],
            value_verified=row["value_verified"] == "true",
            low_basis=row["low_basis"],
            low_source_id=row["low_source_id"],
            low_ref=row["low_ref"],
            low_verified=row["low_verified"] == "true",
        )
    return biomes


def _load_services(
    text: str, biomes: Mapping[str, BiomeCoefficient]
) -> dict[str, tuple[ServiceMean, ...]]:
    rows = _read_csv(
        text,
        "service_values.csv",
        (
            "biome_id",
            "service",
            "service_group",
            "value_mean",
            "n_estimates",
            "price_basis",
            "source_id",
            "ref",
        ),
    )
    grouped: dict[str, list[ServiceMean]] = {}
    for row in rows:
        biome_id = row["biome_id"]
        if biome_id not in biomes:
            raise CoefficientTableError(f"Service row for unknown biome {biome_id}.")
        if row["price_basis"] != PRICE_BASIS:
            raise CoefficientTableError(f"{biome_id}/{row['service']}: wrong price basis.")
        if row["service_group"] not in SERVICE_GROUPS:
            raise CoefficientTableError(f"Unknown service group {row['service_group']!r}.")
        _check_source(row["source_id"], row["ref"], f"{biome_id}/{row['service']}")
        grouped.setdefault(biome_id, []).append(
            ServiceMean(
                service=row["service"],
                group=row["service_group"],
                value=_decimal(row["value_mean"], f"{biome_id}/{row['service']}"),
                n_estimates=int(row["n_estimates"]),
                ref=row["ref"],
            )
        )
    for biome in biomes.values():
        services = grouped.get(biome.biome_id, [])
        if biome.mid == 0:
            if services:
                raise CoefficientTableError(f"{biome.biome_id} has no value but has services.")
            continue
        total = sum((s.value for s in services), Decimal(0))
        # Brander's per-service cells are rounded, so their sum may differ from the
        # published biome total by less than one Int$.
        if total <= 0 or abs(total - biome.mid) >= 1:
            raise CoefficientTableError(
                f"{biome.biome_id}: service means sum to {total}, published total {biome.mid}."
            )
    return {k: tuple(v) for k, v in grouped.items()}


def _load_carbon(text: str, biomes: Mapping[str, BiomeCoefficient]) -> tuple[CarbonFactor, ...]:
    rows = _read_csv(
        text,
        "carbon_factors.csv",
        (
            "biome_id",
            "zone",
            "root_shoot_ratio",
            "r_source_id",
            "r_ref",
            "agb_growth_t_dm_ha_yr",
            "growth_source_id",
            "growth_ref",
        ),
    )
    factors: list[CarbonFactor] = []
    for row in rows:
        biome_id = row["biome_id"]
        if biome_id not in biomes:
            raise CoefficientTableError(f"Carbon factor for unknown biome {biome_id!r}.")
        if row["zone"] not in ("any", "tropical", "extratropical"):
            raise CoefficientTableError(f"{biome_id}: bad zone {row['zone']!r}.")
        ratio = _decimal(row["root_shoot_ratio"], f"{biome_id} R")
        growth = _decimal(row["agb_growth_t_dm_ha_yr"], f"{biome_id} growth")
        if ratio > 0:
            _check_source(row["r_source_id"], row["r_ref"], f"{biome_id} R")
        if growth > 0:
            _check_source(row["growth_source_id"], row["growth_ref"], f"{biome_id} growth")
        factors.append(
            CarbonFactor(
                biome_id=biome_id,
                zone=row["zone"],
                root_shoot_ratio=ratio,
                agb_growth_t_dm_ha_yr=growth,
                r_source_id=row["r_source_id"],
                growth_source_id=row["growth_source_id"],
            )
        )
    return tuple(factors)


def load_coefficient_table(data_dir: Path = DATA_DIR) -> CoefficientTable:
    """Read and validate ``coefficients.csv``, ``service_values.csv`` and ``carbon_factors.csv``."""
    return parse_coefficient_table(
        coefficients=(data_dir / "coefficients.csv").read_text(encoding="utf-8"),
        services=(data_dir / "service_values.csv").read_text(encoding="utf-8"),
        carbon=(data_dir / "carbon_factors.csv").read_text(encoding="utf-8"),
    )


def parse_coefficient_table(*, coefficients: str, services: str, carbon: str) -> CoefficientTable:
    """Validate the three tables given as CSV text (see :func:`load_coefficient_table`)."""
    biomes = _load_biomes(coefficients)
    table = CoefficientTable(
        price_basis=PRICE_BASIS,
        biomes=biomes,
        services=_load_services(services, biomes),
        carbon=_load_carbon(carbon, biomes),
    )
    needed = {"mangrove"} | {
        biome_for(c, Decimal(lat), coastal)
        for c in DW_CLASSES
        for lat in (0, 25, 45)
        for coastal in (True, False)
    }
    for biome_id in sorted(needed):
        if biome_id not in biomes:
            raise CoefficientTableError(f"coefficients.csv has no row for {biome_id}.")
    for biome_id in biomes:
        for zone in get_args(Zone):
            table.carbon_factor(biome_id, zone)
    return table


@lru_cache(maxsize=1)
def default_coefficient_table() -> CoefficientTable:
    return load_coefficient_table()


# --- Inputs and outputs -------------------------------------------------------------------

CoverUnit = Literal[
    "water",
    "trees",
    "grass",
    "flooded_vegetation",
    "crops",
    "shrub_and_scrub",
    "built",
    "bare",
    "snow_and_ice",
    "gmw_mangrove",
]
"""A Dynamic World class, or the share reassigned to mangrove from Global Mangrove Watch."""
COVER_UNITS: tuple[CoverUnit, ...] = get_args(CoverUnit)
WOODY_UNITS: tuple[CoverUnit, ...] = ("trees", "gmw_mangrove")
VEGETATED_UNITS: tuple[CoverUnit, ...] = (
    "trees",
    "grass",
    "flooded_vegetation",
    "shrub_and_scrub",
    "gmw_mangrove",
)
WETLAND_UNITS: tuple[CoverUnit, ...] = ("flooded_vegetation", "gmw_mangrove")


class ValuationInputs(BaseModel):
    """Everything the valuation needs about one site. Decimals; floats are taken by repr."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    area_ha: Decimal = Field(gt=0)
    lat: Decimal = Field(ge=-90, le=90)
    lon: Decimal = Field(ge=-180, le=180)
    landcover: dict[DWClass, Decimal]
    """Area-weighted Dynamic World fractions (``EarthObsMetrics.landcover``)."""
    biomass_t_ha: Decimal = Field(ge=0)
    """Mean above-ground biomass, Mg (t) dry matter per ha."""
    coast_distance_km: Decimal = Field(ge=0)
    """Geodesic distance from the centroid to the nearest coastline."""
    soc_t_c_ha: Decimal | None = Field(default=None, ge=0)
    """SoilGrids soil organic carbon, t C/ha, 0–30 cm. None when not yet available."""
    mangrove_fraction: Decimal | None = Field(default=None, ge=0, le=1)
    """Share of the site mapped as mangrove by Global Mangrove Watch v3. None = not known."""
    context_multiplier: Decimal = Field(default=Decimal(1), gt=0)
    """Site-level value adjustment, reserved for later use (dev-spec §7.3)."""

    @field_validator("landcover")
    @classmethod
    def _fractions_are_valid(cls, value: dict[DWClass, Decimal]) -> dict[DWClass, Decimal]:
        for name, fraction in value.items():
            if not fraction.is_finite() or not 0 <= fraction <= 1:
                raise ValueError(f"Land-cover fraction for {name} must be in [0, 1].")
        total = sum(value.values(), Decimal(0))
        if abs(total - 1) > LANDCOVER_SUM_TOLERANCE:
            raise ValueError(
                f"Land-cover fractions sum to {total}; they must sum to 1 "
                f"(±{LANDCOVER_SUM_TOLERANCE})."
            )
        return value


class ClassValue(BaseModel):
    model_config = ConfigDict(frozen=True)

    dw_class: CoverUnit
    """A Dynamic World class, or ``gmw_mangrove`` for the share reassigned from GMW."""
    share: Decimal
    """Fraction of the site area after renormalisation and mangrove reassignment, 6 dp."""
    biome_id: str
    biome_label: str
    coeff_low: Decimal
    coeff_mid: Decimal
    coeff_high: Decimal
    """Int$2020/ha/yr."""
    value_low: int
    value_mid: int
    value_high: int
    """Int$2020/yr; largest-remainder split of the site totals."""


class ServiceGroupValue(BaseModel):
    model_config = ConfigDict(frozen=True)

    group: str
    value_mid: int
    """Int$2020/yr; the groups sum exactly to ``ValuationResult.value_mid``."""


class CoastalInfo(BaseModel):
    model_config = ConfigDict(frozen=True)

    is_coastal: bool
    distance_km: Decimal
    """Rounded to the metre; the decision uses the unrounded distance."""
    threshold_km: Decimal
    source: str


class MangroveInfo(BaseModel):
    """How much of the site was revalued as mangrove from Global Mangrove Watch."""

    model_config = ConfigDict(frozen=True)

    mangrove_fraction: Decimal
    """The GMW input."""
    applied: Decimal
    """min(mangrove_fraction, trees + flooded_vegetation), after renormalisation."""
    from_flooded_vegetation: Decimal
    from_trees: Decimal
    capped: bool
    source: str = GMW_SOURCE


class CarbonEstimate(BaseModel):
    """IPCC Tier 1 carbon, in tCO₂. Never added to the dollar value."""

    model_config = ConfigDict(frozen=True)

    biomass_stock_tco2: int
    """AGB × (1 + R) × area × 0.47 × 44/12."""
    soc_stock_tco2: int | None
    """SOC × wetland area × 44/12; None when a wetland's SOC input is missing."""
    total_stock_tco2: int
    sequestration_tco2_yr: int
    """Gross Tier 1 biomass gain, Σ area_u × G_u × (1 + R_u) × 0.47 × 44/12."""
    root_shoot_ratio: Decimal
    """R applied to the site's AGB (see ``root_shoot_ratio_basis``)."""
    root_shoot_ratio_basis: str
    """``woody`` (trees / mangrove share-weighted), ``dominant:<unit>`` or ``none``."""
    carbon_fraction: Decimal
    wetland_area_ha: Decimal
    """Flooded vegetation plus GMW mangrove, where SOC is counted."""
    soc_included: bool


class ValuationResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    value_low: int
    value_mid: int
    value_high: int
    unit: str
    """Int$ at 2020 price levels per year (= US$2020 at US prices)."""
    range_basis: str
    """Low is an indicative median-equivalent; mid and high are the Brander mean."""
    classes: tuple[ClassValue, ...]
    services: tuple[ServiceGroupValue, ...]
    coastal: CoastalInfo
    mangrove: MangroveInfo | None
    carbon: CarbonEstimate
    carbon_included_in_value: Literal[False] = False
    landcover_sum: Decimal
    landcover_renormalised: bool
    context_multiplier: Decimal
    price_basis: str
    source_ids: tuple[str, ...]
    methods_version: str
    flags: tuple[str, ...]


# --- The valuation ------------------------------------------------------------------------


def _round(value: Decimal) -> int:
    return int(value.quantize(_ONE, rounding=ROUND_HALF_EVEN, context=_CTX))


def largest_remainder(parts: Mapping[str, Decimal], target: int) -> dict[str, int]:
    """Round non-negative ``parts`` to integers summing exactly to ``target``.

    Floors first, then +1 to the parts with the largest fractional remainders; ties go to
    the alphabetically first key, so the result is deterministic.
    """
    floors = {k: int(v.to_integral_value(rounding=ROUND_FLOOR)) for k, v in parts.items()}
    missing = target - sum(floors.values())
    if not 0 <= missing <= len(parts):
        raise ValueError(f"Can't distribute {missing} units over {len(parts)} parts.")
    order = sorted(parts, key=lambda k: (-(parts[k] - floors[k]), k))
    for key in order[:missing]:
        floors[key] += 1
    return floors


def _cover_shares(
    inputs: ValuationInputs, total_share: Decimal
) -> tuple[dict[CoverUnit, Decimal], MangroveInfo | None]:
    """Renormalised class shares, with the GMW mangrove share carved out of
    flooded vegetation first, then trees (Dynamic World labels mangrove canopy as trees)."""
    shares: dict[CoverUnit, Decimal] = {
        c: inputs.landcover.get(c, Decimal(0)) / total_share for c in DW_CLASSES
    }
    shares["gmw_mangrove"] = Decimal(0)
    if inputs.mangrove_fraction is None:
        return shares, None
    available = shares["flooded_vegetation"] + shares["trees"]
    applied = min(inputs.mangrove_fraction, available)
    from_flooded = min(applied, shares["flooded_vegetation"])
    from_trees = applied - from_flooded
    shares["flooded_vegetation"] -= from_flooded
    shares["trees"] -= from_trees
    shares["gmw_mangrove"] = applied
    return shares, MangroveInfo(
        mangrove_fraction=inputs.mangrove_fraction,
        applied=applied.quantize(SHARE_QUANTUM, ROUND_HALF_EVEN),
        from_flooded_vegetation=from_flooded.quantize(SHARE_QUANTUM, ROUND_HALF_EVEN),
        from_trees=from_trees.quantize(SHARE_QUANTUM, ROUND_HALF_EVEN),
        capped=inputs.mangrove_fraction > available,
    )


def _biome_of_unit(unit: CoverUnit, lat: Decimal, is_coastal: bool) -> str:
    return "mangrove" if unit == "gmw_mangrove" else biome_for(unit, lat, is_coastal)


def value_site(inputs: ValuationInputs, table: CoefficientTable) -> ValuationResult:
    """Value one site. Pure: same inputs and table, same result."""
    with localcontext(_CTX):
        total_share = sum(inputs.landcover.values(), Decimal(0))
        shares, mangrove = _cover_shares(inputs, total_share)
        is_coastal = inputs.coast_distance_km <= Decimal(str(COASTAL_THRESHOLD_KM))
        k = inputs.context_multiplier
        flags: list[str] = []
        source_ids: set[str] = {"naturalearth_10m"}

        exact: dict[str, dict[str, Decimal]] = {"low": {}, "mid": {}, "high": {}}
        groups = dict.fromkeys(SERVICE_GROUPS, Decimal(0))
        biome_of: dict[CoverUnit, BiomeCoefficient] = {}
        for unit in COVER_UNITS:
            biome = table.biomes[_biome_of_unit(unit, inputs.lat, is_coastal)]
            biome_of[unit] = biome
            area = inputs.area_ha * shares[unit]
            exact["low"][unit] = area * biome.low * k
            exact["mid"][unit] = area * biome.mid * k
            exact["high"][unit] = area * biome.high * k
            mid = exact["mid"][unit]
            if mid == 0:
                continue
            source_ids.update({biome.value_source_id, biome.low_source_id})
            if biome.biome_id in ("mangrove", "coastal_systems") and unit != "gmw_mangrove":
                source_ids.add("giri2021")
            if biome.biome_id == "coastal_systems":
                source_ids.add("esvd2020")
            if not biome.value_verified:
                flags.append(f"unverified_coefficient:{biome.biome_id}")
            if not biome.low_verified:
                flags.append(f"low_bound_fallback:{biome.biome_id}")
            services = table.services[biome.biome_id]
            service_total = sum((s.value for s in services), Decimal(0))
            for service in services:
                groups[service.group] += mid * service.value / service_total

        totals = {level: _round(sum(v.values(), Decimal(0))) for level, v in exact.items()}
        split = {level: largest_remainder(exact[level], totals[level]) for level in exact}
        service_split = largest_remainder(groups, totals["mid"])

        carbon = _carbon(inputs, table, shares, biome_of, flags, source_ids)

        renormalised = total_share != 1
        if renormalised:
            flags.append("landcover_renormalised")
        if is_coastal and shares["water"] > 0:
            flags.append("coastal_water_as_lakes")
        if mangrove is not None:
            source_ids.add("gmw_v3")
            if mangrove.capped:
                flags.append("mangrove_fraction_capped")

    units = [u for u in COVER_UNITS if u != "gmw_mangrove" or mangrove is not None]
    return ValuationResult(
        value_low=totals["low"],
        value_mid=totals["mid"],
        value_high=totals["high"],
        unit=VALUE_UNIT,
        range_basis=RANGE_BASIS,
        classes=tuple(
            ClassValue(
                dw_class=u,
                share=shares[u].quantize(SHARE_QUANTUM, ROUND_HALF_EVEN),
                biome_id=biome_of[u].biome_id,
                biome_label=biome_of[u].label,
                coeff_low=biome_of[u].low,
                coeff_mid=biome_of[u].mid,
                coeff_high=biome_of[u].high,
                value_low=split["low"][u],
                value_mid=split["mid"][u],
                value_high=split["high"][u],
            )
            for u in units
        ),
        services=tuple(
            ServiceGroupValue(group=g, value_mid=service_split[g]) for g in SERVICE_GROUPS
        ),
        coastal=CoastalInfo(
            is_coastal=is_coastal,
            distance_km=inputs.coast_distance_km.quantize(Decimal("0.001"), ROUND_HALF_EVEN),
            threshold_km=Decimal(str(COASTAL_THRESHOLD_KM)),
            source=COASTLINE_SOURCE,
        ),
        mangrove=mangrove,
        carbon=carbon,
        landcover_sum=total_share,
        landcover_renormalised=renormalised,
        context_multiplier=k,
        price_basis=table.price_basis,
        source_ids=tuple(sorted(source_ids - {""})),
        methods_version=METHODS_VERSION,
        flags=tuple(sorted(set(flags))),
    )


def _root_shoot_ratio(
    shares: Mapping[CoverUnit, Decimal], factors: Mapping[CoverUnit, CarbonFactor]
) -> tuple[Decimal, str]:
    """R for the site's AGB. GEDI/CCI AGB is mostly woody, so trees and mangrove set R when
    present (share-weighted); otherwise the dominant vegetated unit does (ties by name)."""
    woody = sum((shares[u] for u in WOODY_UNITS), Decimal(0))
    if woody > 0:
        weighted = sum((shares[u] * factors[u].root_shoot_ratio for u in WOODY_UNITS), Decimal(0))
        return weighted / woody, "woody"
    vegetated = [u for u in VEGETATED_UNITS if shares[u] > 0]
    if not vegetated:
        return Decimal(0), "none"
    dominant = min(vegetated, key=lambda u: (-shares[u], u))
    return factors[dominant].root_shoot_ratio, f"dominant:{dominant}"


def _carbon(
    inputs: ValuationInputs,
    table: CoefficientTable,
    shares: Mapping[CoverUnit, Decimal],
    biome_of: Mapping[CoverUnit, BiomeCoefficient],
    flags: list[str],
    source_ids: set[str],
) -> CarbonEstimate:
    zone = zone_for(inputs.lat)
    factors = {u: table.carbon_factor(biome_of[u].biome_id, zone) for u in COVER_UNITS}
    ratio, ratio_basis = _root_shoot_ratio(shares, factors)
    to_co2 = CARBON_FRACTION * _CO2_PER_C
    biomass = inputs.biomass_t_ha * (1 + ratio) * inputs.area_ha * to_co2
    sequestration = (
        sum(
            (
                inputs.area_ha * shares[u] * f.agb_growth_t_dm_ha_yr * (1 + f.root_shoot_ratio)
                for u, f in factors.items()
            ),
            Decimal(0),
        )
        * to_co2
    )
    for u in VEGETATED_UNITS:
        if shares[u] > 0:
            if factors[u].root_shoot_ratio > 0:
                source_ids.add(factors[u].r_source_id)
            if factors[u].agb_growth_t_dm_ha_yr > 0:
                source_ids.add(factors[u].growth_source_id)

    wetland_area = inputs.area_ha * sum((shares[u] for u in WETLAND_UNITS), Decimal(0))
    soc: Decimal | None = Decimal(0)
    if wetland_area > 0:
        if inputs.soc_t_c_ha is None:
            soc = None
            flags.append("soc_missing")
        else:
            soc = inputs.soc_t_c_ha * wetland_area * _CO2_PER_C
            source_ids.add("soilgrids")
    biomass_t = _round(biomass)
    soc_t = None if soc is None else _round(soc)
    return CarbonEstimate(
        biomass_stock_tco2=biomass_t,
        soc_stock_tco2=soc_t,
        total_stock_tco2=biomass_t + (soc_t or 0),
        sequestration_tco2_yr=_round(sequestration),
        root_shoot_ratio=ratio.quantize(Decimal("0.0001"), ROUND_HALF_EVEN),
        root_shoot_ratio_basis=ratio_basis,
        carbon_fraction=CARBON_FRACTION,
        wetland_area_ha=wetland_area.quantize(Decimal("0.0001"), ROUND_HALF_EVEN),
        soc_included=soc is not None and wetland_area > 0,
    )


def _optional_decimal(value: float | None) -> Decimal | None:
    return None if value is None else Decimal(repr(value))


def inputs_from_metrics(
    metrics: EarthObsMetrics,
    *,
    soc_t_c_ha: float | None = None,
    mangrove_fraction: float | None = None,
    coastline: CoastlineIndex | None = None,
    context_multiplier: Decimal = _ONE,
) -> ValuationInputs:
    """Build valuation inputs from cached Earth observation metrics (runs the coastal check).

    ``soc_t_c_ha`` and ``mangrove_fraction`` default to the precomputed metrics (T13).
    """
    if soc_t_c_ha is None:
        soc_t_c_ha = metrics.soc_t_c_ha
    if mangrove_fraction is None:
        mangrove_fraction = metrics.mangrove_fraction
    index = coastline or default_coastline()
    lat, lon = metrics.centroid.lat, metrics.centroid.lon
    return ValuationInputs.model_validate(
        {
            "area_ha": Decimal(repr(metrics.area_ha)),
            "lat": Decimal(repr(lat)),
            "lon": Decimal(repr(lon)),
            "landcover": {c: Decimal(repr(v)) for c, v in metrics.landcover.items()},
            "biomass_t_ha": Decimal(repr(metrics.biomass_t_ha)),
            "coast_distance_km": Decimal(repr(index.distance_km(lat, lon))),
            "soc_t_c_ha": _optional_decimal(soc_t_c_ha),
            "mangrove_fraction": _optional_decimal(mangrove_fraction),
            "context_multiplier": context_multiplier,
        }
    )


def value_metrics(
    metrics: EarthObsMetrics,
    *,
    soc_t_c_ha: float | None = None,
    mangrove_fraction: float | None = None,
    table: CoefficientTable | None = None,
) -> ValuationResult:
    """Convenience: value a site straight from its cached metrics."""
    inputs = inputs_from_metrics(
        metrics, soc_t_c_ha=soc_t_c_ha, mangrove_fraction=mangrove_fraction
    )
    return value_site(inputs, table or default_coefficient_table())

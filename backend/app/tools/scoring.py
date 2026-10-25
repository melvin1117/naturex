"""Deterministic health score, grade, confidence and listing gate (dev-spec §7.4).

Every number an investor sees comes from here; the LLM Auditor (T26) can only shift health
by an integer in [−10, +10] with a reason. All arithmetic is `Decimal`, so results are exact
and reproducible:

- Float inputs are converted through their shortest repr (``0.6008`` → ``Decimal("0.6008")``);
  NaN, ±inf and out-of-domain values raise ``ValueError``.
- Components (V, N, L, W, T) and confidence terms keep full precision; weighted sums use them
  unrounded. Only the stored/displayed snapshot rounds them to 4 decimal places.
- ``base_health``, ``health`` and ``confidence`` are rounded once, at the end, to 1 decimal place
  half-up, and the grade and listing gate are decided on those rounded values. The number shown is
  the number graded, so a displayed 90.0 is always AAA and never AA.
- ``health = clamp(weighted_health + auditor_adjustment, 0, 100)``, then rounded.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from typing import Literal, Protocol

from app.tools.earth_obs import EarthObsMetrics

SCORING_METHOD_VERSION = "wildworth-scoring/1.0 (dev-spec §7.4)"

_ZERO = Decimal(0)
_ONE = Decimal(1)
_HALF = Decimal("0.5")
_HUNDRED = Decimal(100)
COMPONENT_PLACES = Decimal("0.0001")
SCORE_PLACES = Decimal("0.1")

# V: vegetation vigour
NDVI_TREND_FULL_SCALE = Decimal("0.02")  # NDVI/yr that moves the trend term from 0.5 to 1
NDVI_MEAN_FULL_SCALE = Decimal("0.8")
# L: 5-year forest loss that drives L to 0, as a share of the polygon area
HABITAT_LOSS_FULL_SCALE = Decimal("0.1")
# W: a site is a wetland when water + flooded vegetation cover at least this share
WETLAND_MIN_WATER_FRACTION = Decimal("0.20")
# T: summed severity of negative events that drives T to 0
THREAT_SEVERITY_FULL_SCALE = 15
MAX_AUDITOR_ADJUSTMENT = 10

COVERAGE_FULL_OBS = 24
DEFAULT_AGREEMENT = Decimal("0.5")
EVIDENCE_VALIDATED = Decimal("1.0000")
EVIDENCE_NONE = Decimal("0.3000")
RECENCY_FRESH_MAX_DAYS = 90  # fresh when data_age_days < 90
RECENCY_FRESH = Decimal("1.0000")
RECENCY_STALE = Decimal("0.5000")

GATE_MIN_CONFIDENCE = Decimal(70)
GATE_MAX_RECENT_LOSS_FRACTION = Decimal("0.01")

GATE_CONFIDENCE_BELOW_70 = "confidence_below_70"
GATE_GRADE_BELOW_C = "grade_below_c"
GATE_FOREST_LOSS = "forest_loss_last_12m_at_least_1pct_of_area"

Number = int | float | Decimal
AgreementSource = Literal["auditor", "default"]
ForestLossBasis = Literal["last_12m", "5y_total_proxy"]


class Grade(StrEnum):
    AAA = "AAA"
    AA = "AA"
    A = "A"
    BBB = "BBB"
    BB = "BB"
    B = "B"
    C = "C"
    D = "D"


# Lower bound (inclusive) of each band, best first; anything below 30 is D.
GRADE_FLOORS: tuple[tuple[Decimal, Grade], ...] = (
    (Decimal(90), Grade.AAA),
    (Decimal(80), Grade.AA),
    (Decimal(70), Grade.A),
    (Decimal(60), Grade.BBB),
    (Decimal(50), Grade.BB),
    (Decimal(40), Grade.B),
    (Decimal(30), Grade.C),
)
_GRADE_RANK = {grade: rank for rank, grade in enumerate(Grade)}  # 0 = AAA (best)


class ThreatEvent(Protocol):
    """Anything with a News Scout style direction and severity (e.g. `NewsScoutItem`)."""

    @property
    def direction(self) -> int: ...

    @property
    def severity(self) -> int: ...


# Events may also carry `relevant` (as `NewsScoutItem` does); `relevant=False` ones are ignored.


@dataclass(frozen=True, slots=True)
class HealthComponents:
    """The five health components, each in [0, 1] where 1 is best. Names are stable keys."""

    vegetation_vigor: Decimal  # V
    natural_cover: Decimal  # N
    habitat_loss: Decimal  # L: 1 = no forest loss
    water_stability: Decimal  # W
    threat_pressure: Decimal  # T: 1 = no negative events

    def rounded(self) -> HealthComponents:
        """Copy rounded to 4 decimal places, half-up, for display and storage."""
        return HealthComponents(*(_round4(getattr(self, f.name)) for f in fields(self)))


HEALTH_WEIGHTS = HealthComponents(
    vegetation_vigor=Decimal("0.30"),
    natural_cover=Decimal("0.25"),
    habitat_loss=Decimal("0.20"),
    water_stability=Decimal("0.15"),
    threat_pressure=Decimal("0.10"),
)


@dataclass(frozen=True, slots=True)
class ConfidenceComponents:
    coverage: Decimal
    agreement: Decimal
    evidence: Decimal
    recency: Decimal

    def rounded(self) -> ConfidenceComponents:
        """Copy rounded to 4 decimal places, half-up, for display and storage."""
        return ConfidenceComponents(*(_round4(getattr(self, f.name)) for f in fields(self)))


CONFIDENCE_WEIGHTS = ConfidenceComponents(
    coverage=Decimal("0.4"),
    agreement=Decimal("0.3"),
    evidence=Decimal("0.2"),
    recency=Decimal("0.1"),
)


@dataclass(frozen=True, slots=True)
class ConfidenceResult:
    confidence: Decimal
    components: ConfidenceComponents
    agreement_source: AgreementSource


@dataclass(frozen=True, slots=True)
class ListingGate:
    passed: bool
    reasons: tuple[str, ...]
    """Failure codes, in a fixed order: confidence, grade, forest loss. Empty when passed."""
    forest_loss_used_ha: Decimal
    forest_loss_basis: ForestLossBasis
    forest_loss_limit_ha: Decimal


@dataclass(frozen=True, slots=True)
class ScoreResult:
    method_version: str
    components: HealthComponents
    """Full precision; `to_json_dict` stores them rounded to 4 decimal places."""
    weights: HealthComponents
    ndvi_trend_used: Decimal
    """The trend fed into V: the Sen's slope when significant, else 0."""
    is_wetland: bool
    negative_severity_sum: int
    base_health: Decimal
    auditor_adjustment: int
    adjustment_reason: str | None
    health: Decimal
    grade: Grade
    confidence: Decimal
    confidence_components: ConfidenceComponents
    confidence_weights: ConfidenceComponents
    agreement_source: AgreementSource
    gate: ListingGate

    def to_json_dict(self) -> dict[str, object]:
        """JSON-safe snapshot (Decimals as strings) for storing with the report."""
        return {
            "method_version": self.method_version,
            "components": _decimals_to_str(self.components.rounded()),
            "weights": _decimals_to_str(self.weights),
            "ndvi_trend_used": str(self.ndvi_trend_used),
            "is_wetland": self.is_wetland,
            "negative_severity_sum": self.negative_severity_sum,
            "base_health": str(self.base_health),
            "auditor_adjustment": self.auditor_adjustment,
            "adjustment_reason": self.adjustment_reason,
            "health": str(self.health),
            "grade": self.grade.value,
            "confidence": str(self.confidence),
            "confidence_components": _decimals_to_str(self.confidence_components.rounded()),
            "confidence_weights": _decimals_to_str(self.confidence_weights),
            "agreement_source": self.agreement_source,
            "gate": {
                "passed": self.gate.passed,
                "reasons": list(self.gate.reasons),
                "forest_loss_used_ha": str(self.gate.forest_loss_used_ha),
                "forest_loss_basis": self.gate.forest_loss_basis,
                "forest_loss_limit_ha": str(self.gate.forest_loss_limit_ha),
            },
        }


def _decimals_to_str(obj: HealthComponents | ConfidenceComponents) -> dict[str, str]:
    return {f.name: str(getattr(obj, f.name)) for f in fields(obj)}


# ----- input checks and rounding -----


def _dec(name: str, value: Number) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        raise ValueError(f"{name} must be a number, got {value!r}")
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, int):
        result = Decimal(int(value))
    else:
        # float() first: subclasses such as numpy.float64 have a non-numeric repr.
        result = Decimal(repr(float(value)))
    if not result.is_finite():
        raise ValueError(f"{name} must be finite, got {value!r}")
    return result


def _in_range(name: str, value: Number, low: Decimal, high: Decimal) -> Decimal:
    result = _dec(name, value)
    if not low <= result <= high:
        raise ValueError(f"{name} must be between {low} and {high}, got {value!r}")
    return result


def _non_negative_int(name: str, value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer, got {value!r}")
    return value


def _clamp(value: Decimal, low: Decimal = _ZERO, high: Decimal = _ONE) -> Decimal:
    return min(max(value, low), high)


def _round4(value: Decimal) -> Decimal:
    return value.quantize(COMPONENT_PLACES, rounding=ROUND_HALF_UP)


def _score(value: Decimal) -> Decimal:
    return value.quantize(SCORE_PLACES, rounding=ROUND_HALF_UP)


# ----- health components -----


def vegetation_vigor(*, ndvi_mean: Number, ndvi_trend: Number, trend_significant: bool) -> Decimal:
    """V = clamp(0.5 + trend/0.02) × 0.5 + clamp(ndvi_mean/0.8) × 0.5.

    The Sen's slope counts only when its Mann-Kendall test is significant at 5%; otherwise the
    trend is treated as 0 ("no significant change"), per ADR-0004 finding 2.
    """
    mean = _in_range("ndvi_mean", ndvi_mean, -_ONE, _ONE)
    trend = ndvi_trend_used(ndvi_trend, trend_significant=trend_significant)
    trend_term = _clamp(_HALF + trend / NDVI_TREND_FULL_SCALE)
    vigor_term = _clamp(mean / NDVI_MEAN_FULL_SCALE)
    return _clamp(trend_term * _HALF + vigor_term * _HALF)


def ndvi_trend_used(ndvi_trend: Number, *, trend_significant: bool) -> Decimal:
    trend = _dec("ndvi_trend", ndvi_trend)
    return trend if trend_significant else _ZERO


def natural_cover(natural_fraction: Number) -> Decimal:
    """N = natural_fraction (trees + water + flooded_vegetation + grass + shrub_and_scrub)."""
    return _in_range("natural_fraction", natural_fraction, _ZERO, _ONE)


def habitat_loss(*, forest_loss_ha: Number, area_ha: Number) -> Decimal:
    """L = 1 − clamp(forest_loss_ha / (0.1 × area_ha)); forest_loss_ha is the 5-year loss."""
    loss = _non_negative("forest_loss_ha", forest_loss_ha)
    area = _positive("area_ha", area_ha)
    return _ONE - _clamp(loss / (HABITAT_LOSS_FULL_SCALE * area))


def water_stability(*, water_change: Number, is_wetland: bool) -> Decimal:
    """W = clamp(0.5 + water_change/100) for wetlands, else 1. water_change is in [−100, 100]."""
    change = _in_range("water_change", water_change, -_HUNDRED, _HUNDRED)
    if not is_wetland:
        return _ONE
    return _clamp(_HALF + change / _HUNDRED)


def is_wetland_from_landcover(landcover: Mapping[str, float]) -> bool:
    """A site is a wetland when water + flooded_vegetation ≥ 20% of its land cover.

    Apply this once, to the asset's **baseline** metrics, and keep the result with the asset.
    Re-deriving it per data version would let a drained wetland drop out of W and gain health.
    """
    water = _in_range("landcover.water", landcover.get("water", 0.0), _ZERO, _ONE)
    flooded = _in_range(
        "landcover.flooded_vegetation", landcover.get("flooded_vegetation", 0.0), _ZERO, _ONE
    )
    return water + flooded >= WETLAND_MIN_WATER_FRACTION


def negative_severity_sum(events: Iterable[ThreatEvent]) -> int:
    """Σ severity of events with direction −1, skipping any with `relevant=False`."""
    total = 0
    for event in events:
        if not getattr(event, "relevant", True):
            continue
        severity = event.severity
        direction = event.direction
        if isinstance(severity, bool) or not isinstance(severity, int) or not 1 <= severity <= 5:
            raise ValueError(f"event severity must be an integer 1-5, got {severity!r}")
        if isinstance(direction, bool) or direction not in (-1, 0, 1):
            raise ValueError(f"event direction must be -1, 0 or 1, got {direction!r}")
        if direction == -1:
            total += severity
    return total


def threat_pressure(events: Iterable[ThreatEvent]) -> Decimal:
    """T = 1 − clamp(Σ severity of negative events / 15); other directions don't count."""
    total = Decimal(negative_severity_sum(events))
    return _ONE - _clamp(total / THREAT_SEVERITY_FULL_SCALE)


def _non_negative(name: str, value: Number) -> Decimal:
    result = _dec(name, value)
    if result < 0:
        raise ValueError(f"{name} must not be negative, got {value!r}")
    return result


def _positive(name: str, value: Number) -> Decimal:
    result = _dec(name, value)
    if result <= 0:
        raise ValueError(f"{name} must be positive, got {value!r}")
    return result


# ----- health and grade -----


def weighted_health(components: HealthComponents) -> Decimal:
    """100 × (0.30V + 0.25N + 0.20L + 0.15W + 0.10T) at full precision."""
    total = _ZERO
    for f in fields(HealthComponents):
        value = getattr(components, f.name)
        if not isinstance(value, Decimal) or not _ZERO <= value <= _ONE:
            raise ValueError(f"component {f.name} must be a Decimal in [0, 1], got {value!r}")
        total += getattr(HEALTH_WEIGHTS, f.name) * value
    return _HUNDRED * total


def base_health(components: HealthComponents) -> Decimal:
    """`weighted_health` rounded to 1 decimal place, half-up (health before the Auditor)."""
    return _score(weighted_health(components))


def check_auditor_adjustment(adjustment: int, reason: str | None) -> None:
    """Reject (never clamp) an adjustment outside [−10, +10] or a non-zero one without a reason."""
    if isinstance(adjustment, bool) or not isinstance(adjustment, int):
        raise ValueError(f"auditor_adjustment must be an integer, got {adjustment!r}")
    if not -MAX_AUDITOR_ADJUSTMENT <= adjustment <= MAX_AUDITOR_ADJUSTMENT:
        raise ValueError(
            f"auditor_adjustment must be between -{MAX_AUDITOR_ADJUSTMENT} and "
            f"+{MAX_AUDITOR_ADJUSTMENT}, got {adjustment}"
        )
    if adjustment != 0 and not (reason and reason.strip()):
        raise ValueError("a non-zero auditor_adjustment needs a non-empty adjustment_reason")


def adjusted_health(base: Decimal, adjustment: int, reason: str | None) -> Decimal:
    """health = clamp(base + auditor_adjustment, 0, 100), rounded to 1 decimal place, half-up.

    Pass the full-precision `weighted_health`; with an integer adjustment the result equals
    rounding first, so health − base_health is exactly the adjustment unless health is clamped.
    """
    check_auditor_adjustment(adjustment, reason)
    base = _in_range("base_health", base, _ZERO, _HUNDRED)
    return _score(_clamp(base + adjustment, _ZERO, _HUNDRED))


def grade_for(health: Decimal) -> Grade:
    """AAA ≥ 90 · AA ≥ 80 · A ≥ 70 · BBB ≥ 60 · BB ≥ 50 · B ≥ 40 · C ≥ 30 · D < 30 (exact)."""
    value = _in_range("health", health, _ZERO, _HUNDRED)
    for floor, grade in GRADE_FLOORS:
        if value >= floor:
            return grade
    return Grade.D


def grade_at_least(grade: Grade, minimum: Grade) -> bool:
    return _GRADE_RANK[grade] <= _GRADE_RANK[minimum]


# ----- confidence -----


def data_age_days(*, observed_until: date, as_of: date) -> int:
    """Days from the end of the freshest observation window to the rating date."""
    if as_of < observed_until:
        raise ValueError(f"as_of {as_of} is before the data window end {observed_until}")
    return (as_of - observed_until).days


def confidence(
    *,
    cloud_free_obs: int,
    agreement: Number | None,
    has_validated_field_evidence: bool,
    data_age_days: int,
) -> ConfidenceResult:
    """100 × (0.4·coverage + 0.3·agreement + 0.2·evidence + 0.1·recency), 1 decimal place.

    ``agreement=None`` means the Auditor hasn't run yet: it defaults to 0.5 (neutral) and the
    result records ``agreement_source="default"``.
    """
    obs = _non_negative_int("cloud_free_obs", cloud_free_obs)
    age = _non_negative_int("data_age_days", data_age_days)
    source: AgreementSource
    if agreement is None:
        agreement_value, source = DEFAULT_AGREEMENT, "default"
    else:
        agreement_value = _in_range("agreement", agreement, _ZERO, _ONE)
        source = "auditor"
    components = ConfidenceComponents(
        coverage=_clamp(Decimal(obs) / COVERAGE_FULL_OBS),
        agreement=agreement_value,
        evidence=EVIDENCE_VALIDATED if has_validated_field_evidence else EVIDENCE_NONE,
        recency=RECENCY_FRESH if age < RECENCY_FRESH_MAX_DAYS else RECENCY_STALE,
    )
    total = sum(
        (
            getattr(CONFIDENCE_WEIGHTS, f.name) * getattr(components, f.name)
            for f in fields(ConfidenceComponents)
        ),
        start=_ZERO,
    )
    return ConfidenceResult(
        confidence=_score(_HUNDRED * total),
        components=components,
        agreement_source=source,
    )


# ----- listing gate -----


def listing_gate(
    *,
    confidence: Decimal,
    grade: Grade,
    area_ha: Number,
    forest_loss_5y_ha: Number,
    forest_loss_last_12m_ha: Number | None = None,
) -> ListingGate:
    """confidence ≥ 70 AND grade ≥ C AND forest_loss_last_12m < 1% of area.

    Without a last-12-month loss figure the full 5-year Hansen loss is used as a conservative
    upper bound (it can't be smaller than any single year's loss inside the window).
    """
    conf = _in_range("confidence", confidence, _ZERO, _HUNDRED)
    area = _positive("area_ha", area_ha)
    loss_5y = _non_negative("forest_loss_5y_ha", forest_loss_5y_ha)
    basis: ForestLossBasis
    if forest_loss_last_12m_ha is None:
        loss, basis = loss_5y, "5y_total_proxy"
    else:
        loss, basis = _non_negative("forest_loss_last_12m_ha", forest_loss_last_12m_ha), "last_12m"
    limit = GATE_MAX_RECENT_LOSS_FRACTION * area

    reasons: list[str] = []
    if conf < GATE_MIN_CONFIDENCE:
        reasons.append(GATE_CONFIDENCE_BELOW_70)
    if not grade_at_least(grade, Grade.C):
        reasons.append(GATE_GRADE_BELOW_C)
    if loss >= limit:
        reasons.append(GATE_FOREST_LOSS)
    return ListingGate(
        passed=not reasons,
        reasons=tuple(reasons),
        forest_loss_used_ha=loss,
        forest_loss_basis=basis,
        forest_loss_limit_ha=limit,
    )


# ----- full score -----


def score(
    *,
    ndvi_mean: Number,
    ndvi_trend: Number,
    ndvi_trend_significant: bool,
    natural_fraction: Number,
    forest_loss_ha: Number,
    area_ha: Number,
    water_change: Number,
    is_wetland: bool,
    events: Iterable[ThreatEvent],
    cloud_free_obs: int,
    data_age_days: int,
    agreement: Number | None = None,
    has_validated_field_evidence: bool = False,
    auditor_adjustment: int = 0,
    adjustment_reason: str | None = None,
    forest_loss_last_12m_ha: Number | None = None,
) -> ScoreResult:
    """Compute every §7.4 number for one rating. ``forest_loss_ha`` is the 5-year loss."""
    event_list = list(events)
    components = HealthComponents(
        vegetation_vigor=vegetation_vigor(
            ndvi_mean=ndvi_mean, ndvi_trend=ndvi_trend, trend_significant=ndvi_trend_significant
        ),
        natural_cover=natural_cover(natural_fraction),
        habitat_loss=habitat_loss(forest_loss_ha=forest_loss_ha, area_ha=area_ha),
        water_stability=water_stability(water_change=water_change, is_wetland=is_wetland),
        threat_pressure=threat_pressure(event_list),
    )
    exact = weighted_health(components)
    base = _score(exact)
    health = adjusted_health(exact, auditor_adjustment, adjustment_reason)
    grade = grade_for(health)
    conf = confidence(
        cloud_free_obs=cloud_free_obs,
        agreement=agreement,
        has_validated_field_evidence=has_validated_field_evidence,
        data_age_days=data_age_days,
    )
    gate = listing_gate(
        confidence=conf.confidence,
        grade=grade,
        area_ha=area_ha,
        forest_loss_5y_ha=forest_loss_ha,
        forest_loss_last_12m_ha=forest_loss_last_12m_ha,
    )
    return ScoreResult(
        method_version=SCORING_METHOD_VERSION,
        components=components,
        weights=HEALTH_WEIGHTS,
        ndvi_trend_used=ndvi_trend_used(ndvi_trend, trend_significant=ndvi_trend_significant),
        is_wetland=is_wetland,
        negative_severity_sum=negative_severity_sum(event_list),
        base_health=base,
        auditor_adjustment=auditor_adjustment,
        adjustment_reason=adjustment_reason.strip() if adjustment_reason else None,
        health=health,
        grade=grade,
        confidence=conf.confidence,
        confidence_components=conf.components,
        confidence_weights=CONFIDENCE_WEIGHTS,
        agreement_source=conf.agreement_source,
        gate=gate,
    )


def score_metrics(
    metrics: EarthObsMetrics,
    *,
    is_wetland: bool,
    data_age_days: int,
    events: Iterable[ThreatEvent] = (),
    agreement: Number | None = None,
    has_validated_field_evidence: bool = False,
    auditor_adjustment: int = 0,
    adjustment_reason: str | None = None,
    forest_loss_last_12m_ha: Number | None = None,
) -> ScoreResult:
    """`score` fed from cached Earth observation metrics.

    ``is_wetland`` is the asset's fixed wetland status: its declared ecosystem type, or
    `is_wetland_from_landcover` applied once to its baseline metrics. It is never re-derived
    from the version being scored.
    """
    return score(
        ndvi_mean=metrics.ndvi_mean,
        ndvi_trend=metrics.ndvi_trend,
        ndvi_trend_significant=metrics.ndvi_trend_details.significant_05,
        natural_fraction=metrics.natural_fraction,
        forest_loss_ha=metrics.forest_loss_ha,
        area_ha=metrics.area_ha,
        water_change=metrics.water_change,
        is_wetland=is_wetland,
        events=events,
        cloud_free_obs=metrics.cloud_free_obs,
        data_age_days=data_age_days,
        agreement=agreement,
        has_validated_field_evidence=has_validated_field_evidence,
        auditor_adjustment=auditor_adjustment,
        adjustment_reason=adjustment_reason,
        forest_loss_last_12m_ha=forest_loss_last_12m_ha,
    )


def metrics_data_age_days(metrics: EarthObsMetrics, *, as_of: date) -> int:
    """Age of the freshest Sentinel-2 window (the NDVI window end), for the recency term."""
    return data_age_days(
        observed_until=date.fromisoformat(metrics.date_windows["ndvi"].end), as_of=as_of
    )

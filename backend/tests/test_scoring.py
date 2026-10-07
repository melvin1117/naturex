"""Health score, grade, confidence and listing gate (dev-spec §7.4, story B5)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

import pytest

from app.mocks import news_scout_fixture
from app.tools.earth_obs import load_site_metrics
from app.tools.scoring import (
    CONFIDENCE_WEIGHTS,
    GATE_CONFIDENCE_BELOW_70,
    GATE_FOREST_LOSS,
    GATE_GRADE_BELOW_C,
    HEALTH_WEIGHTS,
    SCORING_METHOD_VERSION,
    Grade,
    HealthComponents,
    adjusted_health,
    base_health,
    confidence,
    data_age_days,
    grade_for,
    habitat_loss,
    is_wetland_from_landcover,
    listing_gate,
    metrics_data_age_days,
    natural_cover,
    score,
    score_metrics,
    threat_pressure,
    vegetation_vigor,
    water_stability,
    weighted_health,
)

D = Decimal
HERO_AREA = 206.6995
RATED_ON = date(2026, 10, 7)


@dataclass(frozen=True)
class Ev:
    severity: int
    direction: int


def hero_inputs(**overrides: Any) -> dict[str, Any]:
    """Hero wetland inputs from wetland_mx.json, as keyword arguments to `score`."""
    inputs: dict[str, Any] = {
        "ndvi_mean": 0.6008,
        "ndvi_trend": 0.0097,
        "ndvi_trend_significant": False,
        "natural_fraction": 0.8389,
        "forest_loss_ha": 0.0,
        "area_ha": HERO_AREA,
        "water_change": -6.6021,
        "is_wetland": True,
        "events": [],
        "cloud_free_obs": 73,
        "data_age_days": 6,
    }
    inputs.update(overrides)
    return inputs


def components(value: str) -> HealthComponents:
    v = D(value)
    return HealthComponents(v, v, v, v, v)


def in_unit_interval(value: Decimal) -> bool:
    return D(0) <= value <= D(1)


# ----- worked example (dev-spec §7.4) -----


def test_worked_example_hero_wetland_without_events() -> None:
    metrics = load_site_metrics("wetland_mx")
    age = metrics_data_age_days(metrics, as_of=RATED_ON)

    is_wetland = is_wetland_from_landcover(metrics.landcover)  # baseline: 0.2484 + 0.0296

    result = score_metrics(metrics, is_wetland=is_wetland, data_age_days=age)

    assert age == 6
    assert result.components == HealthComponents(
        vegetation_vigor=D("0.6255"),
        natural_cover=D("0.8389"),
        habitat_loss=D("1"),
        water_stability=D("0.433979"),
        threat_pressure=D("1"),
    )
    assert result.components.rounded().water_stability == D("0.4340")
    assert weighted_health(result.components) == D("76.247185")
    assert result.ndvi_trend_used == 0  # p = 0.0986: not significant, so the slope isn't used
    assert result.is_wetland is True
    assert result.base_health == D("76.2")
    assert result.health == D("76.2")
    assert result.grade is Grade.A
    assert result.confidence == D("71.0")
    assert result.confidence_components.coverage == D("1.0000")
    assert result.confidence_components.agreement == D("0.5000")
    assert result.confidence_components.evidence == D("0.3000")
    assert result.confidence_components.recency == D("1.0000")
    assert result.agreement_source == "default"
    assert result.gate.passed is True
    assert result.gate.reasons == ()
    assert result.gate.forest_loss_basis == "5y_total_proxy"
    assert result.gate.forest_loss_limit_ha == D("2.066995")
    assert result.method_version == SCORING_METHOD_VERSION


def test_worked_example_hero_wetland_with_mock_encroachment_event() -> None:
    metrics = load_site_metrics("wetland_mx")

    result = score_metrics(metrics, is_wetland=True, data_age_days=6, events=news_scout_fixture())

    assert result.negative_severity_sum == 4
    assert result.components.threat_pressure == 1 - D(4) / D(15)
    assert result.components.rounded().threat_pressure == D("0.7333")
    assert weighted_health(result.components).quantize(D("0.000001")) == D("73.580518")
    assert result.base_health == D("73.6")
    assert result.health == D("73.6")
    assert result.grade is Grade.A
    assert result.confidence == D("71.0")
    assert result.gate.passed is True


def test_score_metrics_matches_explicit_inputs() -> None:
    from_metrics = score_metrics(load_site_metrics("wetland_mx"), is_wetland=True, data_age_days=6)

    assert from_metrics == score(**hero_inputs())


def test_gate_example_low_coverage_fails_confidence_only() -> None:
    result = score(**hero_inputs(cloud_free_obs=10))

    assert result.confidence_components.rounded().coverage == D("0.4167")
    assert result.confidence == D("47.7")  # exactly 47.6666…
    assert result.gate.reasons == (GATE_CONFIDENCE_BELOW_70,)


def test_gate_example_recent_forest_loss_fails_loss_only() -> None:
    result = score(**hero_inputs(forest_loss_last_12m_ha=2.1))

    assert result.grade is Grade.A
    assert result.gate.forest_loss_basis == "last_12m"
    assert result.gate.reasons == (GATE_FOREST_LOSS,)


def test_gate_example_degraded_site_fails_grade_only() -> None:
    result = score(
        ndvi_mean=0.2,
        ndvi_trend=0.0,
        ndvi_trend_significant=False,
        natural_fraction=0.05,
        forest_loss_ha=30.0,
        forest_loss_last_12m_ha=0.0,
        area_ha=HERO_AREA,
        water_change=0.0,
        is_wetland=False,
        events=[Ev(5, -1), Ev(5, -1), Ev(5, -1)],
        cloud_free_obs=73,
        data_age_days=6,
    )

    assert result.components == HealthComponents(D("0.375"), D("0.05"), D(0), D(1), D(0))
    assert result.base_health == D("27.5")
    assert result.grade is Grade.D
    assert result.gate.reasons == (GATE_GRADE_BELOW_C,)


def test_gate_combination_reports_every_failure_in_order() -> None:
    result = score(
        **hero_inputs(
            ndvi_mean=0.1,
            ndvi_trend=-0.02,
            ndvi_trend_significant=True,
            natural_fraction=0.1,
            forest_loss_ha=30.0,
            water_change=-60.0,
            events=[Ev(5, -1)] * 3,
            cloud_free_obs=0,
        )
    )

    assert result.base_health == D("4.4")
    assert result.gate.passed is False
    assert result.gate.reasons == (GATE_CONFIDENCE_BELOW_70, GATE_GRADE_BELOW_C, GATE_FOREST_LOSS)


# ----- components -----


@pytest.mark.parametrize("ndvi_mean", [-1.0, -0.5, 0.0, 0.8, 1.0])
@pytest.mark.parametrize("trend", [-1e9, -0.02, 0.0, 0.02, 1e9])
def test_vegetation_vigor_stays_in_unit_interval(ndvi_mean: float, trend: float) -> None:
    value = vegetation_vigor(ndvi_mean=ndvi_mean, ndvi_trend=trend, trend_significant=True)

    assert in_unit_interval(value)


def test_vegetation_vigor_extremes() -> None:
    assert vegetation_vigor(ndvi_mean=1.0, ndvi_trend=1e9, trend_significant=True) == 1
    assert vegetation_vigor(ndvi_mean=-1.0, ndvi_trend=-1e9, trend_significant=True) == 0


def test_vegetation_vigor_ignores_a_non_significant_trend() -> None:
    significant = vegetation_vigor(ndvi_mean=0.6008, ndvi_trend=0.0097, trend_significant=True)
    ignored = vegetation_vigor(ndvi_mean=0.6008, ndvi_trend=0.0097, trend_significant=False)

    assert significant == D("0.868")  # 0.985 × 0.5 + 0.751 × 0.5
    assert ignored == D("0.6255")  # 0.5 × 0.5 + 0.751 × 0.5


@pytest.mark.parametrize("ndvi_mean", [-1.01, 1.01])
def test_vegetation_vigor_rejects_ndvi_outside_range(ndvi_mean: float) -> None:
    with pytest.raises(ValueError, match="ndvi_mean"):
        vegetation_vigor(ndvi_mean=ndvi_mean, ndvi_trend=0.0, trend_significant=False)


def test_natural_cover_is_the_natural_fraction() -> None:
    assert natural_cover(0.8389) == D("0.8389")
    assert natural_cover(0) == 0
    assert natural_cover(1) == 1


@pytest.mark.parametrize("fraction", [-0.01, 1.01])
def test_natural_cover_rejects_fraction_outside_unit_interval(fraction: float) -> None:
    with pytest.raises(ValueError, match="natural_fraction"):
        natural_cover(fraction)


@pytest.mark.parametrize(
    ("loss", "expected"),
    [(0.0, "1.0000"), (10.0, "0.5000"), (20.0, "0.0000"), (100.0, "0.0000"), (1e9, "0.0000")],
)
def test_habitat_loss_scales_to_ten_percent_of_area_and_clamps(loss: float, expected: str) -> None:
    assert habitat_loss(forest_loss_ha=loss, area_ha=200.0) == D(expected)


def test_habitat_loss_rejects_negative_loss_and_non_positive_area() -> None:
    with pytest.raises(ValueError, match="forest_loss_ha"):
        habitat_loss(forest_loss_ha=-1.0, area_ha=200.0)
    with pytest.raises(ValueError, match="area_ha"):
        habitat_loss(forest_loss_ha=0.0, area_ha=0.0)


@pytest.mark.parametrize(
    ("change", "expected"),
    [(-100.0, "0"), (-50.0, "0"), (-6.6021, "0.433979"), (0.0, "0.5"), (100.0, "1")],
)
def test_water_stability_for_wetlands(change: float, expected: str) -> None:
    assert water_stability(water_change=change, is_wetland=True) == D(expected)


@pytest.mark.parametrize("change", [-100.0, 0.0, 100.0])
def test_water_stability_is_one_for_non_wetlands(change: float) -> None:
    assert water_stability(water_change=change, is_wetland=False) == 1


@pytest.mark.parametrize("change", [-100.01, 100.01])
def test_water_stability_rejects_change_outside_range(change: float) -> None:
    with pytest.raises(ValueError, match="water_change"):
        water_stability(water_change=change, is_wetland=True)


def test_is_wetland_threshold_is_twenty_percent_water_plus_flooded_vegetation() -> None:
    assert is_wetland_from_landcover(load_site_metrics("wetland_mx").landcover) is True
    assert is_wetland_from_landcover({"water": 0.15, "flooded_vegetation": 0.05}) is True
    assert is_wetland_from_landcover({"water": 0.15, "flooded_vegetation": 0.0499}) is False
    assert is_wetland_from_landcover({"trees": 0.9}) is False


def test_threat_pressure_counts_negative_events_only() -> None:
    events = [Ev(4, -1), Ev(5, 0), Ev(5, 1), Ev(2, -1)]

    assert threat_pressure(events) == D("0.6000")  # 1 − 6/15
    assert threat_pressure([]) == 1


def test_threat_pressure_clamps_above_fifteen() -> None:
    assert threat_pressure([Ev(5, -1)] * 3) == 0
    assert threat_pressure([Ev(5, -1)] * 10) == 0


@pytest.mark.parametrize("event", [Ev(0, -1), Ev(6, -1), Ev(3, 2), Ev(3, -2)])
def test_threat_pressure_rejects_invalid_events(event: Ev) -> None:
    with pytest.raises(ValueError, match="event"):
        threat_pressure([event])


def test_threat_pressure_accepts_news_scout_items() -> None:
    assert threat_pressure(news_scout_fixture()) == 1 - D(4) / D(15)


def test_threat_pressure_ignores_irrelevant_news() -> None:
    irrelevant = news_scout_fixture()[0].model_copy(update={"relevant": False})

    assert threat_pressure([irrelevant]) == 1
    assert threat_pressure([*news_scout_fixture(), irrelevant]) == 1 - D(4) / D(15)


def test_all_components_stay_in_unit_interval_for_extreme_inputs() -> None:
    for extreme in [
        hero_inputs(ndvi_mean=-1.0, ndvi_trend=-1e6, ndvi_trend_significant=True),
        hero_inputs(ndvi_mean=1.0, ndvi_trend=1e6, ndvi_trend_significant=True),
        hero_inputs(forest_loss_ha=HERO_AREA * 5, water_change=-100.0),
        hero_inputs(water_change=100.0, events=[Ev(5, -1)] * 20),
    ]:
        result = score(**extreme)
        c = result.components
        for value in (
            c.vegetation_vigor,
            c.natural_cover,
            c.habitat_loss,
            c.water_stability,
            c.threat_pressure,
        ):
            assert in_unit_interval(value)
        assert D(0) <= result.health <= D(100)
        assert D(0) <= result.confidence <= D(100)


@pytest.mark.parametrize(
    "field",
    ["ndvi_mean", "ndvi_trend", "natural_fraction", "forest_loss_ha", "area_ha", "water_change"],
)
@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_score_rejects_nan_and_infinity(field: str, bad: float) -> None:
    with pytest.raises(ValueError, match=field):
        score(**hero_inputs(**{field: bad}))


def test_numpy_floats_are_accepted_and_numpy_nan_raises_value_error() -> None:
    np = pytest.importorskip("numpy")

    assert natural_cover(np.float64(0.8389)) == D("0.8389")
    assert score(**hero_inputs(ndvi_mean=np.float64(0.6008))) == score(**hero_inputs())
    with pytest.raises(ValueError, match="ndvi_mean"):
        score(**hero_inputs(ndvi_mean=np.float64("nan")))
    with pytest.raises(ValueError, match="water_change"):
        score(**hero_inputs(water_change=np.float32("inf")))


def test_score_rejects_nan_agreement_and_recent_loss() -> None:
    with pytest.raises(ValueError, match="agreement"):
        score(**hero_inputs(agreement=math.nan))
    with pytest.raises(ValueError, match="forest_loss_last_12m_ha"):
        score(**hero_inputs(forest_loss_last_12m_ha=math.inf))
    with pytest.raises(ValueError, match="ndvi_mean"):
        score(**hero_inputs(ndvi_mean=D("NaN")))


# ----- health, rounding and grade -----


def test_weights_sum_to_one() -> None:
    total = sum(
        (
            HEALTH_WEIGHTS.vegetation_vigor,
            HEALTH_WEIGHTS.natural_cover,
            HEALTH_WEIGHTS.habitat_loss,
            HEALTH_WEIGHTS.water_stability,
            HEALTH_WEIGHTS.threat_pressure,
        ),
        start=D(0),
    )
    assert total == 1
    assert sum(
        (
            CONFIDENCE_WEIGHTS.coverage,
            CONFIDENCE_WEIGHTS.agreement,
            CONFIDENCE_WEIGHTS.evidence,
            CONFIDENCE_WEIGHTS.recency,
        ),
        start=D(0),
    ) == D(1)


def test_base_health_bounds() -> None:
    assert base_health(components("0")) == D("0.0")
    assert base_health(components("1")) == D("100.0")


def test_base_health_rejects_component_outside_unit_interval() -> None:
    with pytest.raises(ValueError, match="component"):
        base_health(components("1.0001"))


def test_base_health_rounds_half_up_to_one_decimal() -> None:
    assert base_health(components("0.8995")) == D("90.0")  # exactly 89.95
    assert base_health(components("0.8994")) == D("89.9")  # exactly 89.94


@pytest.mark.parametrize(
    ("floor", "grade", "below"),
    [
        ("90", Grade.AAA, Grade.AA),
        ("80", Grade.AA, Grade.A),
        ("70", Grade.A, Grade.BBB),
        ("60", Grade.BBB, Grade.BB),
        ("50", Grade.BB, Grade.B),
        ("40", Grade.B, Grade.C),
        ("30", Grade.C, Grade.D),
    ],
)
def test_grade_band_edges_are_exact(floor: str, grade: Grade, below: Grade) -> None:
    assert grade_for(D(floor)) is grade
    assert grade_for(D(floor) - D("0.1")) is below
    assert grade_for(D(floor) - D("0.000000001")) is below


def test_grade_extremes() -> None:
    assert grade_for(D("100")) is Grade.AAA
    assert grade_for(D("0")) is Grade.D
    with pytest.raises(ValueError, match="health"):
        grade_for(D("100.1"))
    with pytest.raises(ValueError, match="health"):
        grade_for(D("NaN"))


def test_health_uses_full_precision_components_before_rounding() -> None:
    # Rounding components first would give 69.95 → 70.0 (A); the exact sum is 69.949685.
    result = score(**hero_inputs(natural_fraction=0.587))

    assert weighted_health(result.components) == D("69.949685")
    assert weighted_health(result.components.rounded()) == D("69.95")
    assert result.base_health == D("69.9")
    assert result.health == D("69.9")
    assert result.grade is Grade.BBB


def test_displayed_health_and_grade_never_disagree() -> None:
    health = adjusted_health(base_health(components("0.8995")), 0, None)

    assert str(health) == "90.0"
    assert grade_for(health) is Grade.AAA


def test_adjustment_is_applied_and_health_clamps() -> None:
    assert adjusted_health(D("76.2"), -2, "Illegal dumping reported") == D("74.2")
    assert adjusted_health(D("95.0"), 10, "Restoration verified on site") == D("100.0")
    assert adjusted_health(D("5.0"), -10, "Fire scar after the satellite window") == D("0.0")


def test_score_applies_adjustment_and_grades_the_adjusted_health() -> None:
    result = score(**hero_inputs(auditor_adjustment=-7, adjustment_reason="  Dumping in NE  "))

    assert result.base_health == D("76.2")
    assert result.health == D("69.2")
    assert result.grade is Grade.BBB
    assert result.adjustment_reason == "Dumping in NE"


@pytest.mark.parametrize("adjustment", [10, -10])
def test_adjustment_limits_are_inclusive(adjustment: int) -> None:
    assert adjusted_health(D("50.0"), adjustment, "reason") == D(50 + adjustment)


@pytest.mark.parametrize("adjustment", [11, -11, 100])
def test_adjustment_outside_limits_is_rejected_not_clamped(adjustment: int) -> None:
    with pytest.raises(ValueError, match="between -10 and \\+10"):
        adjusted_health(D("50.0"), adjustment, "reason")


@pytest.mark.parametrize("reason", [None, "", "   "])
def test_non_zero_adjustment_needs_a_reason(reason: str | None) -> None:
    with pytest.raises(ValueError, match="adjustment_reason"):
        adjusted_health(D("50.0"), 3, reason)


def test_zero_adjustment_needs_no_reason() -> None:
    assert adjusted_health(D("50.0"), 0, None) == D("50.0")


@pytest.mark.parametrize("adjustment", [2.5, True, D("2")])
def test_adjustment_must_be_an_integer(adjustment: Any) -> None:
    with pytest.raises(ValueError, match="integer"):
        adjusted_health(D("50.0"), adjustment, "reason")


# ----- confidence -----


def test_confidence_formula() -> None:
    result = confidence(
        cloud_free_obs=12, agreement=0.8, has_validated_field_evidence=True, data_age_days=10
    )

    assert result.confidence == D("74.0")  # 100 × (0.4·0.5 + 0.3·0.8 + 0.2·1 + 0.1·1)
    assert result.agreement_source == "auditor"


def test_confidence_bounds() -> None:
    best = confidence(
        cloud_free_obs=1000, agreement=1, has_validated_field_evidence=True, data_age_days=0
    )
    worst = confidence(
        cloud_free_obs=0, agreement=0, has_validated_field_evidence=False, data_age_days=10_000
    )

    assert best.confidence == D("100.0")
    assert worst.confidence == D("11.0")  # evidence floor 0.3 and stale recency 0.5 remain


def test_confidence_defaults_agreement_when_auditor_has_not_run() -> None:
    result = confidence(
        cloud_free_obs=24, agreement=None, has_validated_field_evidence=False, data_age_days=0
    )

    assert result.components.agreement == D("0.5000")
    assert result.agreement_source == "default"
    assert result.confidence == D("71.0")


def test_recency_switches_at_ninety_days() -> None:
    def recency(age: int) -> Decimal:
        return confidence(
            cloud_free_obs=24, agreement=1, has_validated_field_evidence=True, data_age_days=age
        ).components.recency

    assert recency(89) == 1
    assert recency(90) == D("0.5")


@pytest.mark.parametrize(
    "kwargs",
    [
        {"cloud_free_obs": -1},
        {"data_age_days": -1},
        {"agreement": 1.01},
        {"agreement": -0.01},
        {"cloud_free_obs": True},
    ],
)
def test_confidence_rejects_invalid_inputs(kwargs: dict[str, Any]) -> None:
    args: dict[str, Any] = {
        "cloud_free_obs": 24,
        "agreement": 0.5,
        "has_validated_field_evidence": False,
        "data_age_days": 0,
    }
    with pytest.raises(ValueError):
        confidence(**(args | kwargs))


def test_data_age_days() -> None:
    assert data_age_days(observed_until=date(2026, 10, 1), as_of=date(2026, 10, 7)) == 6
    with pytest.raises(ValueError, match="before"):
        data_age_days(observed_until=date(2026, 10, 1), as_of=date(2026, 9, 30))


# ----- listing gate -----


def gate(**overrides: Any) -> Any:
    args: dict[str, Any] = {
        "confidence": D("70.0"),
        "grade": Grade.C,
        "area_ha": 200.0,
        "forest_loss_5y_ha": 0.0,
    }
    return listing_gate(**(args | overrides))


def test_gate_passes_exactly_at_its_thresholds() -> None:
    result = gate(forest_loss_last_12m_ha=1.99)

    assert result.passed is True
    assert result.reasons == ()


def test_gate_confidence_just_below_70_fails() -> None:
    assert gate(confidence=D("69.9")).reasons == (GATE_CONFIDENCE_BELOW_70,)


def test_gate_grade_d_fails() -> None:
    assert gate(grade=Grade.D).reasons == (GATE_GRADE_BELOW_C,)


def test_gate_recent_loss_of_one_percent_fails() -> None:
    result = gate(forest_loss_last_12m_ha=2.0)

    assert result.reasons == (GATE_FOREST_LOSS,)
    assert result.forest_loss_limit_ha == D("2.00")


def test_gate_uses_five_year_loss_as_a_conservative_proxy() -> None:
    proxy = gate(forest_loss_5y_ha=5.0)
    measured = gate(forest_loss_5y_ha=5.0, forest_loss_last_12m_ha=0.5)

    assert proxy.forest_loss_basis == "5y_total_proxy"
    assert proxy.reasons == (GATE_FOREST_LOSS,)
    assert measured.forest_loss_basis == "last_12m"
    assert measured.passed is True


def test_gate_combination() -> None:
    result = gate(confidence=D("50"), grade=Grade.D, forest_loss_last_12m_ha=50.0)

    assert result.reasons == (GATE_CONFIDENCE_BELOW_70, GATE_GRADE_BELOW_C, GATE_FOREST_LOSS)


# ----- wetland status is fixed per asset -----


def test_draining_a_wetland_never_raises_health() -> None:
    baseline = load_site_metrics("wetland_mx")
    is_wetland = is_wetland_from_landcover(baseline.landcover)
    drained_cover = baseline.landcover | {"water": 0.17, "built": 0.2072}
    drained = baseline.model_copy(
        update={"landcover": drained_cover, "natural_fraction": 0.7605, "data_version": "sim-1"}
    )

    before = score_metrics(baseline, is_wetland=is_wetland, data_age_days=6)
    after = score_metrics(drained, is_wetland=is_wetland, data_age_days=6)

    assert is_wetland_from_landcover(drained.landcover) is False  # why it isn't re-derived
    assert after.is_wetland is True
    assert after.components.water_stability == before.components.water_stability
    assert after.health <= before.health


# ----- hero confidence margin (T26/T38: the hero only just clears the gate) -----


def test_hero_confidence_margin_at_default_agreement() -> None:
    assert score(**hero_inputs()).confidence == D("71.0")


@pytest.mark.parametrize(
    ("overrides", "expected", "passes"),
    [
        ({"agreement": D("0.465")}, "70.0", True),  # exactly 69.95, rounds up
        ({"agreement": D("0.4649")}, "69.9", False),
        ({"cloud_free_obs": 24}, "71.0", True),
        ({"cloud_free_obs": 23}, "69.3", False),
        ({"data_age_days": 89}, "71.0", True),
        ({"data_age_days": 90}, "66.0", False),
    ],
)
def test_hero_confidence_gate_edges(overrides: dict[str, Any], expected: str, passes: bool) -> None:
    result = score(**hero_inputs(**overrides))

    assert result.confidence == D(expected)
    assert result.gate.passed is passes
    assert result.gate.reasons == (() if passes else (GATE_CONFIDENCE_BELOW_70,))


# ----- monotonicity and determinism -----


def test_more_forest_loss_never_raises_health() -> None:
    losses = [0.0, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 20.67, 40.0, 1000.0]
    healths = [score(**hero_inputs(forest_loss_ha=loss)).health for loss in losses]

    assert healths == sorted(healths, reverse=True)
    assert healths[0] > healths[-1]


def test_more_negative_events_never_raise_health() -> None:
    healths = [score(**hero_inputs(events=[Ev(3, -1)] * n)).health for n in range(8)]

    assert healths == sorted(healths, reverse=True)
    assert healths[0] > healths[-1]


def test_more_cloud_free_observations_never_lower_confidence() -> None:
    values = [score(**hero_inputs(cloud_free_obs=n)).confidence for n in range(0, 40)]

    assert values == sorted(values)
    assert values[0] < values[-1]


def test_score_is_deterministic() -> None:
    events = [Ev(4, -1), Ev(2, 1)]
    first = score(**hero_inputs(events=events, agreement=0.73))
    second = score(**hero_inputs(events=list(events), agreement=0.73))

    assert first == second
    assert first.to_json_dict() == second.to_json_dict()


def test_json_snapshot_uses_stable_keys() -> None:
    snapshot = score(**hero_inputs()).to_json_dict()

    assert snapshot["components"] == {
        "vegetation_vigor": "0.6255",
        "natural_cover": "0.8389",
        "habitat_loss": "1.0000",
        "water_stability": "0.4340",
        "threat_pressure": "1.0000",
    }
    assert snapshot["health"] == "76.2"
    assert snapshot["grade"] == "A"
    assert snapshot["gate"] == {
        "passed": True,
        "reasons": [],
        "forest_loss_used_ha": "0.0",
        "forest_loss_basis": "5y_total_proxy",
        "forest_loss_limit_ha": "2.066995",
    }

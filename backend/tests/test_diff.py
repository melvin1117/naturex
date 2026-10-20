"""Report diffs (T37): the pure diff of two stored report versions."""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest

from app.models import Report
from app.services.diff import diff_reports

ASSET = uuid4()
WORLD = uuid4()
D = Decimal
EVENT = "event:news-1a2b"


def rating(**overrides: Any) -> dict[str, Any]:
    """A minimal stored rating snapshot (`auditor_json["rating"]`)."""
    snapshot: dict[str, Any] = {
        "metrics": {
            "data_version": "2026-09",
            "area_ha": 120.0,
            "natural_fraction": 0.8,
            "ndvi_mean": 0.61,
            "ndvi_trend": 0.004,
            "water_change": 2.0,
            "forest_loss_ha": 1.5,
            "biomass_t_ha": 80.0,
            "cloud_free_obs": 40,
            "landcover": {"trees": 0.5, "water": 0.3, "built": 0.2},
            "simulated": False,
            "scenario": "baseline",
        },
        "score": {
            "base_health": "76.2",
            "auditor_adjustment": 0,
            "components": {
                "vegetation_vigor": "0.8",
                "natural_cover": "0.8",
                "habitat_loss": "0.9",
                "water_stability": "0.7",
                "threat_pressure": "1",
            },
            "negative_severity_sum": 0,
            "confidence_components": {
                "coverage": "0.9",
                "agreement": "0.5",
                "evidence": "0.5",
                "recency": "1",
            },
            "gate": {"passed": True, "reasons": []},
        },
        "valuation": {"carbon": {"total_stock_tco2": 1000, "sequestration_tco2_yr": 50}},
        "fair_value": {"fair_value_total": "1000000.00"},
        "events": [],
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(snapshot.get(key), dict):
            snapshot[key] = {**snapshot[key], **value}
        else:
            snapshot[key] = value
    return snapshot


def report(
    version: int,
    *,
    health: str = "76.20",
    grade: str = "A",
    confidence: str = "70.00",
    value_mid: str = "2000000.00",
    breakdown: dict[str, int] | None = None,
    flags: list[dict[str, str]] | None = None,
    snapshot: dict[str, Any] | None = None,
    auditor: dict[str, Any] | None = None,
    asset_id: UUID = ASSET,
) -> Report:
    stored: dict[str, Any] = {"rating": snapshot if snapshot is not None else rating()}
    if auditor is not None:
        stored["auditor"] = auditor
    return Report(
        world_id=WORLD,
        asset_id=asset_id,
        version=version,
        health_score=D(health),
        grade=grade,
        confidence=D(confidence),
        value_low=D("1000000.00"),
        value_mid=D(value_mid),
        value_high=D("3000000.00"),
        value_breakdown=breakdown
        if breakdown is not None
        else {"water": 1500000, "habitat": 500000},
        fair_value_per_share=D("1.0000"),
        flags=flags or [],
        auditor_json=stored,
    )


def auditor(adjustment: int = -2, key_changes: list[str] | None = None) -> dict[str, Any]:
    return {
        "auditor_adjustment": adjustment,
        "adjustment_reason": f"Encroachment news [{EVENT}] is not yet visible "
        "in land cover [metric:landcover.built].",
        "agreement": 0.8,
        "flags": [],
        "greenwashing_risk": "low",
        "key_changes": key_changes
        if key_changes is not None
        else ["Surface water is shrinking [metric:water_change]."],
        "recommendations": [],
        "summary_md": "Summary [score:base_health].",
        "citations": ["metric:water_change"],
    }


def by_id(diff: Any) -> dict[str, Any]:
    return {metric.id: metric for metric in diff.metrics}


def test_identical_reports_have_no_metric_changes_or_reasons() -> None:
    older, newer = report(1), report(2)

    diff = diff_reports(older, newer)

    assert (diff.from_version, diff.to_version) == (1, 2)
    assert diff.metrics == [] and diff.reasons == [] and diff.grade_change is None
    assert diff.changes[0] == "health_score unchanged: 76.20"


def test_changed_metrics_have_old_new_and_exact_delta_and_unchanged_ones_are_omitted() -> None:
    older = report(1)
    newer = report(
        2,
        health="87.10",
        snapshot=rating(
            metrics={"ndvi_mean": 0.68, "water_change": -4.6},
            score={"components": {**rating()["score"]["components"], "vegetation_vigor": "0.9"}},
        ),
    )

    metrics = by_id(diff_reports(older, newer))

    health = metrics["score:health"]
    assert (health.old, health.new, health.delta) == (D("76.20"), D("87.10"), D("10.90"))
    assert health.change == "changed" and health.group == "headline"
    ndvi = metrics["metric:ndvi_mean"]
    assert (ndvi.old, ndvi.new, ndvi.delta) == (D("0.61"), D("0.68"), D("0.07"))
    assert metrics["metric:water_change"].delta == D("-6.6")
    assert metrics["score:vegetation_vigor"].delta == D("0.1")
    assert set(metrics) == {
        "score:health",
        "metric:ndvi_mean",
        "metric:water_change",
        "score:vegetation_vigor",
    }


def test_added_and_removed_metrics_have_no_delta() -> None:
    older = report(1, breakdown={"water": 1500000, "habitat": 500000})
    newer = report(
        2,
        breakdown={"water": 1500000, "habitat": 400000, "flood": 100000},
        snapshot=rating(
            metrics={
                "landcover": {"trees": 0.5, "water": 0.3, "flooded_vegetation": 0.2},
                "soc_t_c_ha": 55.5,
            }
        ),
    )

    metrics = by_id(diff_reports(older, newer))

    added = metrics["metric:landcover.flooded_vegetation"]
    assert (added.change, added.old, added.new, added.delta) == ("added", None, D("0.2"), None)
    removed = metrics["metric:landcover.built"]
    assert (removed.change, removed.old, removed.new, removed.delta) == (
        "removed",
        D("0.2"),
        None,
        None,
    )
    assert metrics["metric:soc_t_c_ha"].change == "added"
    assert metrics["valuation:service.flood"].change == "added"
    assert metrics["valuation:service.habitat"].delta == D("-100000")
    assert "metric:landcover.trees" not in metrics and "valuation:service.water" not in metrics


@pytest.mark.parametrize(
    ("old", "new", "direction"),
    [("A", "AA", "up"), ("AA", "BBB", "down"), ("A", "X", None)],
)
def test_grade_change_has_a_direction(old: str, new: str, direction: str | None) -> None:
    diff = diff_reports(report(1, grade=old), report(2, grade=new))

    assert diff.grade_change is not None
    assert (diff.grade_change.old, diff.grade_change.new) == (old, new)
    assert diff.grade_change.direction == direction
    assert diff.changes[1] == f"grade: {old} → {new}"


def test_auditor_key_changes_and_adjustment_are_reasons_linked_to_the_metrics_they_cite() -> None:
    older = report(1)
    newer = report(
        2,
        health="74.20",
        snapshot=rating(
            metrics={
                "water_change": -4.6,
                "landcover": {"trees": 0.5, "water": 0.25, "built": 0.25},
            },
            score={"auditor_adjustment": -2},
        ),
        auditor=auditor(),
    )

    diff = diff_reports(older, newer, [newer])

    texts = [(r.source, r.code, r.text) for r in diff.reasons]
    assert texts == [
        ("auditor", "key_change", "Surface water is shrinking [metric:water_change]."),
        ("auditor", "adjustment", newer.auditor_json["auditor"]["adjustment_reason"]),  # type: ignore[index]
    ]
    assert diff.reasons[0].citations == ["metric:water_change"]
    assert diff.reasons[1].citations == [
        EVENT,
        "metric:landcover.built",
        "score:auditor_adjustment",
    ]
    metrics = by_id(diff)
    assert metrics["metric:water_change"].reason_refs == [0]
    assert metrics["metric:landcover.built"].reason_refs == [1]
    assert metrics["score:auditor_adjustment"].reason_refs == [1]
    assert metrics["score:health"].reason_refs == []


def test_key_changes_come_from_every_version_in_range_oldest_first() -> None:
    v1 = report(1)
    v2 = report(2, auditor=auditor(0, ["Step two [metric:ndvi_mean]."]))
    v3 = report(3, auditor=auditor(0, ["Step three [report:previous.health_change]."]))
    v4 = report(4, auditor=auditor(0, ["Outside the range [metric:ndvi_mean]."]))

    diff = diff_reports(v1, v3, [v3, v4, v2, v1])

    assert [(r.version, r.text) for r in diff.reasons] == [
        (2, "Step two [metric:ndvi_mean]."),
        (3, "Step three [report:previous.health_change]."),
    ]


def test_an_unchanged_adjustment_is_not_a_reason() -> None:
    older = report(1, snapshot=rating(score={"auditor_adjustment": -2}))
    newer = report(2, snapshot=rating(score={"auditor_adjustment": -2}), auditor=auditor(-2, []))

    assert diff_reports(older, newer, [newer]).reasons == []


def test_new_relevant_events_and_flags_and_data_versions_are_reasons() -> None:
    event = {
        "id": EVENT,
        "relevant": True,
        "direction": -1,
        "impact_type": "encroachment",
        "severity": 4,
        "title": "Industrial park approved next to the wetland",
    }
    ignored = {**event, "id": "event:other", "relevant": False}
    older = report(1, flags=[{"type": "mock_data", "source": "data", "detail": "Mock."}])
    newer = report(
        2,
        flags=[{"type": "listing_gate:forest_loss", "source": "scoring", "detail": "Too much."}],
        snapshot=rating(
            metrics={
                "data_version": "sim-1",
                "simulated": True,
                "scenario": "encroachment",
                "scenario_deltas": {"description": "Built-up land spreads into the marsh."},
            },
            events=[event, ignored],
        ),
    )

    reasons = [(r.source, r.code, r.text, r.citations) for r in diff_reports(older, newer).reasons]

    assert reasons == [
        ("data", "data_version", "Satellite data version 2026-09 → sim-1.", []),
        (
            "scenario",
            "encroachment",
            "Simulated scenario, not an observation: Built-up land spreads into the marsh.",
            [],
        ),
        (
            "event",
            "encroachment",
            "Industrial park approved next to the wetland",
            [EVENT, "score:threat_pressure"],
        ),
        ("flag", "listing_gate:forest_loss", "Too much.", []),
        ("flag", "mock_data", "No longer flagged: Mock.", []),
    ]


def test_an_event_no_longer_counted_is_a_reason() -> None:
    event = {"id": EVENT, "relevant": True, "direction": 1, "title": "Restoration grant"}
    older = report(1, snapshot=rating(events=[event]))

    [reason] = diff_reports(older, report(2)).reasons

    assert (reason.text, reason.citations) == ("No longer counted: Restoration grant", [EVENT])


def test_fair_value_compares_the_total_not_per_share() -> None:
    older = report(1)
    newer = report(2, snapshot=rating(fair_value={"fair_value_total": "1200000.00"}))
    newer.fair_value_per_share = D("0.0012")  # the share count changed at the IPO

    metrics = by_id(diff_reports(older, newer))

    assert metrics["fair_value:total"].delta == D("200000.00")
    assert not any("per_share" in key for key in metrics)


def test_reports_without_a_rating_snapshot_diff_their_columns() -> None:
    older, newer = report(1, health="50.00"), report(2, health="55.00")
    older.auditor_json = newer.auditor_json = None

    diff = diff_reports(older, newer)

    assert {m.id for m in diff.metrics} == {"score:health", "fair_value:total"}
    assert diff.reasons == []


def test_diff_refuses_other_assets_and_reversed_versions() -> None:
    with pytest.raises(ValueError, match="different assets"):
        diff_reports(report(1), report(2, asset_id=uuid4()))
    with pytest.raises(ValueError, match="later version"):
        diff_reports(report(2), report(1))

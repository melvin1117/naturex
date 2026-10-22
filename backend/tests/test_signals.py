"""Dated signals from the 5-year satellite history (tools.signals)."""

from __future__ import annotations

import math

from app.tools.earth_obs import EarthObsMetrics, NdviPoint, load_site_metrics
from app.tools.signals import find_signals

BASE = load_site_metrics("wetland_mx", "baseline")


def seasonal(month: int, year: int) -> float:
    """A smooth wet/dry cycle with a tiny year-to-year wobble (no real change)."""
    wobble = 0.004 * ((year * 7 + month * 3) % 5 - 2)
    return round(0.6 + 0.15 * math.sin((month - 3) / 12 * 2 * math.pi) + wobble, 4)


def series(
    changes: dict[str, float] | None = None,
    *,
    drop_months: set[str] | None = None,
    last_year_step: float = 0.0,
) -> tuple[NdviPoint, ...]:
    points = []
    months = [(2021 + (m - 1 + 9) // 12, (m - 1 + 9) % 12 + 1) for m in range(1, 61)]
    for index, (year, month) in enumerate(months):
        label = f"{year:04d}-{month:02d}"
        if drop_months and label in drop_months:
            continue
        value = seasonal(month, year) + (changes or {}).get(label, 0.0)
        if index >= 48:
            value += last_year_step
        points.append(NdviPoint(month=label, ndvi=round(value, 4), cloud_free_obs=5))
    return tuple(points)


def metrics(points: tuple[NdviPoint, ...], *, simulated: bool = False) -> EarthObsMetrics:
    return BASE.model_copy(update={"ndvi_series": points, "simulated": simulated})


def test_a_purely_seasonal_history_has_no_anomaly() -> None:
    found = find_signals(metrics(series()))

    assert [s.kind for s in found] == ["greenness_last_12m"]
    assert found[0].direction == 0 and found[0].strength == "weak"


def test_an_unusual_month_is_dated_and_citable() -> None:
    found = find_signals(metrics(series({"2025-03": -0.15})))

    anomaly = next(s for s in found if s.kind == "greenness_anomaly")
    assert anomaly.id == "signal:greenness_2025_03"
    assert (anomaly.direction, anomaly.start, anomaly.end, anomaly.months) == (
        -1,
        "2025-03",
        "2025-03",
        1,
    )
    assert anomaly.pct is not None and anomaly.pct < -8
    assert (
        anomaly.text.startswith("greenness ") and "below a normal March (2025-03)" in anomaly.text
    )
    assert not anomaly.priced


def test_consecutive_months_form_one_episode() -> None:
    drop = {"2026-01": -0.12, "2026-02": -0.14, "2026-03": -0.13}
    found = [s for s in find_signals(metrics(series(drop))) if s.kind == "greenness_anomaly"]

    assert len(found) == 1
    assert (found[0].start, found[0].end, found[0].months) == ("2026-01", "2026-03", 3)
    assert "for 3 months (2026-01 to 2026-03)" in found[0].text


def test_old_changes_outside_the_recent_window_are_not_signals() -> None:
    found = find_signals(metrics(series({"2022-03": -0.2})))

    assert all(s.kind != "greenness_anomaly" for s in found)


def test_a_browner_latest_year_is_a_priced_negative_shift() -> None:
    found = find_signals(metrics(series(last_year_step=-0.08), simulated=True))

    shift = next(s for s in found if s.kind == "greenness_last_12m")
    assert shift.direction == -1 and shift.strength == "strong"
    assert shift.priced and shift.simulated
    assert "below the same months in earlier years" in shift.text


def test_missing_recent_months_are_a_cloud_gap() -> None:
    gaps = {"2025-11", "2025-12", "2026-01", "2026-02"}
    found = find_signals(metrics(series(drop_months=gaps)))

    gap = next(s for s in found if s.kind == "cloud_gap")
    assert (gap.start, gap.end, gap.months, gap.direction) == ("2025-11", "2026-02", 4, 0)


def test_demo_sites_give_few_signals_and_stable_ids() -> None:
    for site in ("wetland_mx", "mangrove_mx", "restoration_forest"):
        found = find_signals(load_site_metrics(site, "baseline"))
        anomalies = [s for s in found if s.kind == "greenness_anomaly"]
        assert len(anomalies) <= 3
        assert len({s.id for s in found}) == len(found)
        assert all(s.id.startswith("signal:") for s in found)

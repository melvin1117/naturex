"""Dated signals from a site's 5-year satellite history (deterministic, no model).

The rating's score already uses 5-year means and trends. What it can't say is **when** something
changed. This module compares every recent month with the same calendar month in the other
years (median and a robust spread), so a normal dry season is not a signal but an unusual March
is, and dates it:

- `greenness_anomaly`: consecutive recent months well above or below their seasonal normal;
- `greenness_last_12m`: the latest year against the same months in earlier years;
- `cloud_gap`: recent months with no cloud-free view (a data gap, not a change).

Every signal has a citable `signal:` ID and a sentence whose numbers come from here, so the
Auditor can cite it and the Agent Trace and report timeline can draw it.
"""

from __future__ import annotations

import calendar
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from app.tools.earth_obs import EarthObsMetrics, NdviPoint

SignalKind = Literal["greenness_anomaly", "greenness_last_12m", "cloud_gap"]

RECENT_MONTHS = 24
ANOMALY_Z = 2.5
ANOMALY_MIN_PCT = 8.0
MIN_SPREAD = 0.03
"""NDVI spread floor, so a very regular month doesn't make tiny differences look extreme."""
MAD_TO_SIGMA = 1.4826
MIN_OTHER_YEARS = 2
MAX_ANOMALIES = 3
SHIFT_MODERATE_PCT = 3.0
SHIFT_STRONG_PCT = 8.0
CLOUD_GAP_MIN_MONTHS = 3
# Signals whose information the score already prices (the latest year moves `ndvi_mean`).
PRICED_KINDS: frozenset[SignalKind] = frozenset({"greenness_last_12m"})
PRICED_SIGNAL_IDS = frozenset({"signal:greenness_last_12m"})


@dataclass(frozen=True, slots=True)
class Signal:
    id: str
    kind: SignalKind
    direction: Literal[-1, 0, 1]
    start: str
    """First month, YYYY-MM."""
    end: str
    text: str
    """Plain sentence; every number in it is computed here."""
    strength: Literal["weak", "moderate", "strong"]
    pct: float | None = None
    z: float | None = None
    months: int = 1
    simulated: bool = False

    @property
    def priced(self) -> bool:
        return self.kind in PRICED_KINDS

    def to_json(self) -> dict[str, object]:
        return {
            "id": self.id,
            "kind": self.kind,
            "direction": self.direction,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "strength": self.strength,
            "pct": self.pct,
            "z": self.z,
            "months": self.months,
            "simulated": self.simulated,
        }


@dataclass(frozen=True, slots=True)
class _Deviation:
    month: str
    ndvi: float
    normal: float
    z: float
    pct: float


def _month_index(month: str) -> int:
    year, mon = month.split("-")
    return int(year) * 12 + int(mon) - 1


def _month_label(index: int) -> str:
    return f"{index // 12:04d}-{index % 12 + 1:02d}"


def _deviation(point: NdviPoint, series: Sequence[NdviPoint]) -> _Deviation | None:
    """This month against the same calendar month in the other years (leave-one-out)."""
    calendar_month = point.month[5:7]
    others = [p.ndvi for p in series if p.month[5:7] == calendar_month and p.month != point.month]
    if len(others) < MIN_OTHER_YEARS:
        return None
    normal = statistics.median(others)
    mad = statistics.median(abs(value - normal) for value in others)
    spread = max(MAD_TO_SIGMA * mad, MIN_SPREAD)
    if normal <= 0.05:
        return None
    return _Deviation(
        month=point.month,
        ndvi=point.ndvi,
        normal=normal,
        z=(point.ndvi - normal) / spread,
        pct=(point.ndvi - normal) / normal * 100,
    )


def _recent(series: Sequence[NdviPoint], months: int) -> list[NdviPoint]:
    if not series:
        return []
    last = _month_index(series[-1].month)
    return [p for p in series if last - _month_index(p.month) < months]


def _anomalies(series: Sequence[NdviPoint], simulated: bool) -> list[Signal]:
    flagged = [
        d
        for p in _recent(series, RECENT_MONTHS)
        if (d := _deviation(p, series)) is not None
        and abs(d.z) >= ANOMALY_Z
        and abs(d.pct) >= ANOMALY_MIN_PCT
    ]
    episodes: list[list[_Deviation]] = []
    for d in flagged:
        current = episodes[-1] if episodes else None
        if (
            current is not None
            and _month_index(d.month) - _month_index(current[-1].month) == 1
            and (d.z > 0) == (current[-1].z > 0)
        ):
            current.append(d)
        else:
            episodes.append([d])
    strongest = sorted(episodes, key=lambda e: -max(abs(d.z) for d in e))[:MAX_ANOMALIES]
    signals = []
    for episode in sorted(strongest, key=lambda e: e[0].month):
        peak = max(episode, key=lambda d: abs(d.z))
        direction: Literal[-1, 1] = 1 if peak.z > 0 else -1
        start, end = episode[0].month, episode[-1].month
        month_name = calendar.month_name[int(peak.month[5:7])]
        word = "above" if direction > 0 else "below"
        size = f"{round(abs(peak.pct))}% {word} a normal {month_name}"
        if start == end:
            text = f"greenness {size} ({start})"
        else:
            extreme = "highest" if direction > 0 else "lowest"
            text = (
                f"greenness {word} its seasonal normal for {len(episode)} months "
                f"({start} to {end}), {size} at its {extreme}"
            )
        signals.append(
            Signal(
                id=f"signal:greenness_{start.replace('-', '_')}",
                kind="greenness_anomaly",
                direction=direction,
                start=start,
                end=end,
                text=text,
                strength="strong" if abs(peak.z) >= 3.5 else "moderate",
                pct=round(peak.pct, 1),
                z=round(peak.z, 1),
                months=len(episode),
                simulated=simulated,
            )
        )
    return signals


def _last_year(series: Sequence[NdviPoint], simulated: bool) -> Signal | None:
    deviations = [d for p in _recent(series, 12) if (d := _deviation(p, series)) is not None]
    if len(deviations) < 6:
        return None
    normal = statistics.fmean(d.normal for d in deviations)
    pct = statistics.fmean(d.ndvi - d.normal for d in deviations) / normal * 100
    size = abs(pct)
    direction: Literal[-1, 0, 1] = 0 if size < SHIFT_MODERATE_PCT else (1 if pct > 0 else -1)
    shown = round(size)
    if direction == 0:
        text = "the latest 12 months' greenness is in line with the same months in earlier years"
    else:
        word = "above" if direction > 0 else "below"
        text = (
            f"the latest 12 months' greenness is {shown}% {word} the same months in earlier years"
        )
    return Signal(
        id="signal:greenness_last_12m",
        kind="greenness_last_12m",
        direction=direction,
        start=deviations[0].month,
        end=deviations[-1].month,
        text=text,
        strength="strong" if size >= SHIFT_STRONG_PCT else ("moderate" if direction else "weak"),
        pct=round(pct, 1),
        months=len(deviations),
        simulated=simulated,
    )


def _cloud_gap(series: Sequence[NdviPoint]) -> Signal | None:
    if not series:
        return None
    last = _month_index(series[-1].month)
    first = last - RECENT_MONTHS + 1
    seen = {_month_index(p.month) for p in series if p.cloud_free_obs > 0}
    missing = [m for m in range(first, last + 1) if m not in seen]
    if len(missing) < CLOUD_GAP_MIN_MONTHS:
        return None
    return Signal(
        id="signal:cloud_gap",
        kind="cloud_gap",
        direction=0,
        start=_month_label(missing[0]),
        end=_month_label(missing[-1]),
        text=f"{len(missing)} of the latest {RECENT_MONTHS} months have no cloud-free view",
        strength="moderate",
        months=len(missing),
    )


def find_signals(metrics: EarthObsMetrics) -> list[Signal]:
    """Dated signals, oldest first, then the latest-year comparison and any data gap."""
    series = sorted(metrics.ndvi_series, key=lambda p: p.month)
    found: list[Signal] = _anomalies(series, metrics.simulated)
    last_year = _last_year(series, metrics.simulated)
    if last_year is not None:
        found.append(last_year)
    gap = _cloud_gap(series)
    if gap is not None:
        found.append(gap)
    return found

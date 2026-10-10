"""Live Nemotron prose for report summaries, guarded by deterministic facts."""

from __future__ import annotations

import hashlib
import re
import time
from calendar import month_abbr
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy.exc import SQLAlchemyError

from app.agents.guards import uses_only_fact_numbers
from app.config import Settings
from app.llm import LLMClient, LLMError, Tier
from app.schemas import EventOut, ReportOut, ReportSummarySource

AGENT_NAME = "report_summary"
_REPORT_PERIOD = "Q3 2026"
_QUARTER = re.compile(r"^(?P<year>\d{4})Q(?P<quarter>[1-4])$")
_FALLBACK_CACHE_SECONDS = 300.0


class ReportSummaryDraft(BaseModel):
    summary_md: str = Field(
        max_length=1600,
        description="Markdown summary for non-experts. Use only numbers supplied in facts.",
    )


@dataclass(frozen=True, slots=True)
class SummaryResult:
    summary_md: str
    source: ReportSummarySource


@dataclass(frozen=True, slots=True)
class SummaryContext:
    """Facts about the rated asset that aren't on the report itself."""

    asset_name: str
    area_ha: Decimal
    country: str | None = None
    event: EventOut | None = None
    """The asset's most recent event, if any."""


@dataclass(frozen=True, slots=True)
class CachedSummary:
    result: SummaryResult
    expires_at: float | None


_CACHE: dict[str, CachedSummary] = {}
"""Keyed by a hash of the facts the summary is written from, not by report ID: every visitor
world copies the template's reports under fresh IDs, and they all share one summary (and one
LLM call). A new event or any changed number gives new facts, so a new key."""


def clear_summary_cache() -> None:
    _CACHE.clear()


def summary_cache_key(facts: list[str]) -> str:
    return hashlib.sha256("\n".join(facts).encode()).hexdigest()


def generate_report_summary(
    report: ReportOut,
    settings: Settings,
    llm_client_factory: Callable[[], LLMClient | None] | None,
    log_asset_id_factory: Callable[[], UUID | None] | None = None,
    clock: Callable[[], float] = time.monotonic,
    context: SummaryContext | None = None,
) -> SummaryResult:
    """Live Nemotron prose for a report, or the deterministic fallback.

    Simulated (Time Machine) reports always get the fallback, which states in code that the
    figures are a scenario, not an observation: a model reply could drop that warning.
    """
    facts = _facts(report, context)
    key = summary_cache_key(facts)
    cached = _cached(key, clock())
    if cached is not None:
        return cached

    def fallback() -> SummaryResult:
        return _cache_result(key, _fallback_summary(facts), ReportSummarySource.FALLBACK, clock())

    if settings.use_mocks or llm_client_factory is None or report.simulated:
        return fallback()

    try:
        llm_client = llm_client_factory()
        if llm_client is None:
            return fallback()
        result = llm_client.structured(
            agent=AGENT_NAME,
            tier=Tier.FAST,
            messages=[{"role": "user", "content": _prompt(facts)}],
            schema=ReportSummaryDraft,
            max_tokens=400,
            asset_id=log_asset_id_factory() if log_asset_id_factory else None,
        )
    except (LLMError, SQLAlchemyError):
        return fallback()

    summary = result.value.summary_md.strip()
    if not uses_only_fact_numbers(summary, facts):
        return fallback()
    return _cache_result(key, summary, ReportSummarySource.LIVE, clock())


def _cached(key: str, now: float) -> SummaryResult | None:
    cached = _CACHE.get(key)
    if cached is None:
        return None
    if cached.expires_at is not None and cached.expires_at <= now:
        _CACHE.pop(key, None)
        return None
    return cached.result


def _cache_result(
    key: str, summary_md: str, source: ReportSummarySource, now: float
) -> SummaryResult:
    result = SummaryResult(summary_md, source)
    expires_at = None if source is ReportSummarySource.LIVE else now + _FALLBACK_CACHE_SECONDS
    _CACHE[key] = CachedSummary(result, expires_at)
    return result


def _report_period(report: ReportOut) -> str:
    match = _QUARTER.match(report.period or "")
    if match is None:
        return _REPORT_PERIOD
    return f"Q{match['quarter']} {match['year']}"


def _facts(report: ReportOut, context: SummaryContext | None) -> list[str]:
    event = context.event if context else None
    data_status = (
        "simulated Time Machine scenario (scripted changes to observed data), not an observation"
        if report.simulated
        else "observed satellite data"
    )
    lines = [
        f"report_period: {_report_period(report)}",
        f"data_status: {data_status}",
        "health_score_scale: 100",
        f"health_score: {_decimal(report.health_score, places=1)}",
        f"grade: {report.grade or 'unknown'}",
        f"confidence: {_whole(report.confidence)}%",
        (
            "value_range: "
            f"{_compact_money(report.value_low)}-{_compact_money(report.value_high)} /yr"
        ),
        f"value_mid: {_compact_money(report.value_mid)}",
        f"value_low_usd: {_decimal(report.value_low, places=2)}",
        f"value_mid_usd: {_decimal(report.value_mid, places=2)}",
        f"value_high_usd: {_decimal(report.value_high, places=2)}",
        f"sandbox_price_per_unit: {_decimal(report.fair_value_per_share, places=4)}",
    ]
    if context is not None:
        lines.extend(
            [
                f"asset_name: {context.asset_name}",
                f"asset_area: {_whole(context.area_ha)} ha",
                f"asset_country: {context.country or 'unknown'}",
            ]
        )
    if report.value_breakdown:
        for key, value in sorted(report.value_breakdown.items()):
            lines.append(f"value_breakdown_{key}: {_compact_money(Decimal(str(value)))}")
    if event is not None:
        event_date = _display_date(event.published_at) if event.published_at else "unknown"
        lines.extend(
            [
                f"event_title: {event.title or 'Untitled event'}",
                f"event_date: {event_date}",
                f"event_impact_type: {event.impact_type or 'other'}",
                f"event_direction: {event.direction}",
                f"event_severity: {event.severity}",
                f"event_summary: {event.summary or ''}",
            ]
        )
    if report.recommendations:
        lines.append("recommendations: " + "; ".join(report.recommendations))
    return lines


def _prompt(facts: list[str]) -> str:
    return (
        "Write a sober NatureX rating-agency summary for the report below.\n"
        "Use Markdown. Keep it under 160 words. Say the value as a range, midpoint, "
        "and confidence. State that sandbox prices are play money only if you mention price. "
        "Do not introduce any number that is not present verbatim in the facts. "
        "Do not present this as a real security or investment.\n\n"
        "Facts:\n- " + "\n- ".join(facts)
    )


def _fallback_summary(facts: list[str]) -> str:
    values = dict(line.split(": ", 1) for line in facts if ": " in line)
    event = values.get("event_summary")
    pressure = (
        f" A severity {values['event_severity']} {values['event_impact_type']} report "
        "adds pressure."
        if event
        else ""
    )
    basis = (
        "a simulated Time Machine scenario (scripted changes to observed data, not an observation)"
        if values["data_status"].startswith("simulated")
        else "deterministic satellite metrics"
    )
    return (
        f"## Ecological Performance Report — {values['report_period']}\n\n"
        f"Health {values['health_score']} / {values['health_score_scale']} "
        f"(grade {values['grade']}) is based on {basis} for "
        f"{values.get('asset_area', 'the demo site')}. The annual value range is "
        f"{values['value_range']} · mid {values['value_mid']} · "
        f"{values['confidence']} confidence.{pressure} Sandbox pricing is play money only; "
        "nothing here is a real security or investment."
    )


def _decimal(value: Decimal | None, *, places: int) -> str:
    if value is None:
        return "0"
    quant = Decimal("1") if places == 0 else Decimal("1").scaleb(-places)
    text = str(value.quantize(quant, rounding=ROUND_HALF_UP))
    return text.rstrip("0").rstrip(".") if "." in text else text


def _whole(value: Decimal | None) -> str:
    return _decimal(value, places=0)


def _display_date(value: date) -> str:
    return f"{value.day} {month_abbr[value.month]} {value.year}"


def _compact_money(value: Decimal | None) -> str:
    if value is None:
        return "$0"
    if abs(value) >= Decimal("1000000"):
        return f"${_decimal(value / Decimal('1000000'), places=1)}M"
    if abs(value) >= Decimal("1000"):
        return f"${_decimal(value / Decimal('1000'), places=0)}K"
    return f"${_decimal(value, places=0)}"

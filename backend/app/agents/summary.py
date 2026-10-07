"""Live Nemotron prose for report summaries, guarded by deterministic facts."""

from __future__ import annotations

import time
from calendar import month_abbr
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy.exc import SQLAlchemyError

from app import mocks
from app.agents.guards import uses_only_fact_numbers
from app.config import Settings
from app.llm import LLMClient, LLMError, Tier
from app.schemas import ReportOut, ReportSummarySource

AGENT_NAME = "report_summary"
_REPORT_PERIOD = "Q3 2026"
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
class CachedSummary:
    result: SummaryResult
    expires_at: float | None


_CACHE: dict[UUID, CachedSummary] = {}


def clear_summary_cache() -> None:
    _CACHE.clear()


def generate_report_summary(
    report: ReportOut,
    settings: Settings,
    llm_client_factory: Callable[[], LLMClient | None] | None,
    log_asset_id_factory: Callable[[], UUID | None] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> SummaryResult:
    cached = _cached(report.id, clock())
    if cached is not None:
        return cached

    facts = _facts(report)
    if settings.use_mocks or llm_client_factory is None:
        return _cache_result(
            report.id, _fallback_summary(facts), ReportSummarySource.FALLBACK, clock()
        )

    try:
        llm_client = llm_client_factory()
        if llm_client is None:
            return _cache_result(
                report.id, _fallback_summary(facts), ReportSummarySource.FALLBACK, clock()
            )
        result = llm_client.structured(
            agent=AGENT_NAME,
            tier=Tier.FAST,
            messages=[{"role": "user", "content": _prompt(facts)}],
            schema=ReportSummaryDraft,
            max_tokens=400,
            asset_id=log_asset_id_factory() if log_asset_id_factory else None,
        )
    except (LLMError, SQLAlchemyError):
        return _cache_result(
            report.id, _fallback_summary(facts), ReportSummarySource.FALLBACK, clock()
        )

    summary = result.value.summary_md.strip()
    if not uses_only_fact_numbers(summary, facts):
        return _cache_result(
            report.id, _fallback_summary(facts), ReportSummarySource.FALLBACK, clock()
        )
    return _cache_result(report.id, summary, ReportSummarySource.LIVE, clock())


def _cached(report_id: UUID, now: float) -> SummaryResult | None:
    cached = _CACHE.get(report_id)
    if cached is None:
        return None
    if cached.expires_at is not None and cached.expires_at <= now:
        _CACHE.pop(report_id, None)
        return None
    return cached.result


def _cache_result(
    report_id: UUID, summary_md: str, source: ReportSummarySource, now: float
) -> SummaryResult:
    result = SummaryResult(summary_md, source)
    expires_at = None if source is ReportSummarySource.LIVE else now + _FALLBACK_CACHE_SECONDS
    _CACHE[report_id] = CachedSummary(result, expires_at)
    return result


def _facts(report: ReportOut) -> list[str]:
    asset = mocks.get_asset(report.asset_id)
    event = asset.recent_events[0] if asset and asset.recent_events else None
    lines = [
        f"report_period: {_REPORT_PERIOD}",
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
    if asset is not None:
        lines.extend(
            [
                f"asset_name: {asset.name}",
                f"asset_area: {_whole(asset.area_ha)} ha",
                f"asset_country: {asset.country or 'unknown'}",
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
    return (
        f"## Ecological Performance Report — {values['report_period']}\n\n"
        f"Health {values['health_score']} / {values['health_score_scale']} "
        f"(grade {values['grade']}) is based on deterministic mock metrics for "
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

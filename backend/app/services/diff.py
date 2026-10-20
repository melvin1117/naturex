"""Report diffs (T37): what changed between two sealed versions of one asset's rating, and why.

Pure: it reads only the stored reports it is given. Every number is a stored value or the
Decimal difference of two. Every reason is stored text (the Auditor's cited key changes and
adjustment reason, a stored event title, a flag's stored detail, the Time Machine scenario's
description) or a fixed template filled with stored codes. No model is called here.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from app.agents.auditor import inline_citations
from app.models import Report
from app.schemas import DiffReason, GradeChange, MetricChange, MetricGroup, ReportDiff
from app.services.rating import report_fair_value_total
from app.tools.scoring import Grade

Getter = Callable[[Report], object]

# Citations that speak about a metric without naming its key.
_ALIASES: Mapping[str, tuple[str, ...]] = {
    "report:previous.health_change": ("score:health", "score:base_health"),
    "report:previous.value_mid_change": ("valuation:value_mid",),
    "score:confidence_before_audit": ("score:confidence",),
}
_GRADE_RANK = {grade.value: rank for rank, grade in enumerate(Grade)}  # 0 = best


@dataclass(frozen=True, slots=True)
class _Spec:
    id: str
    label: str
    group: MetricGroup
    unit: str | None
    get: Getter


def _rating(report: Report) -> Mapping[str, Any]:
    rating = (report.auditor_json or {}).get("rating")
    return rating if isinstance(rating, Mapping) else {}


def _at(mapping: Mapping[str, Any], *path: str) -> object:
    node: object = mapping
    for key in path:
        if not isinstance(node, Mapping):
            return None
        node = node.get(key)
    return node


def _number(value: object) -> Decimal | None:
    """A stored number as a Decimal (floats via their shortest repr); None if not a number."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, int | float | str):
        try:
            number = Decimal(str(value))
        except InvalidOperation:
            return None
        return number if number.is_finite() else None
    return None


def _rated(*path: str) -> Getter:
    return lambda report: _at(_rating(report), *path)


def _column(name: str) -> Getter:
    return lambda report: getattr(report, name)


def _service(group: str) -> Getter:
    return lambda report: (report.value_breakdown or {}).get(group)


_HEADLINE: tuple[_Spec, ...] = (
    _Spec("score:health", "Health score", "headline", "/100", _column("health_score")),
    _Spec("score:confidence", "Confidence", "headline", "%", _column("confidence")),
    _Spec("valuation:value_low", "Value (low)", "headline", "Int$/yr", _column("value_low")),
    _Spec("valuation:value_mid", "Value (mid)", "headline", "Int$/yr", _column("value_mid")),
    _Spec("valuation:value_high", "Value (high)", "headline", "Int$/yr", _column("value_high")),
    # The total, not per share: the share count changes at the IPO (T59).
    _Spec("fair_value:total", "Fair value (total)", "headline", "Int$", report_fair_value_total),
)
_SCORE: tuple[_Spec, ...] = (
    _Spec("score:base_health", "Base health", "health", "/100", _rated("score", "base_health")),
    _Spec(
        "score:auditor_adjustment",
        "Auditor adjustment",
        "health",
        "points",
        _rated("score", "auditor_adjustment"),
    ),
    *(
        _Spec(f"score:{key}", label, "health", "0-1", _rated("score", "components", key))
        for key, label in (
            ("vegetation_vigor", "Vegetation vigour"),
            ("natural_cover", "Natural cover"),
            ("habitat_loss", "Habitat loss (1 = none)"),
            ("water_stability", "Water stability"),
            ("threat_pressure", "Threat pressure (1 = none)"),
        )
    ),
    _Spec(
        "score:negative_severity_sum",
        "Negative event severity",
        "health",
        None,
        _rated("score", "negative_severity_sum"),
    ),
    *(
        _Spec(
            f"confidence:{key}",
            label,
            "confidence",
            "0-1",
            _rated("score", "confidence_components", key),
        )
        for key, label in (
            ("coverage", "Data coverage"),
            ("agreement", "Source agreement"),
            ("evidence", "Evidence"),
            ("recency", "Recency"),
        )
    ),
)
_SATELLITE: tuple[_Spec, ...] = tuple(
    _Spec(f"metric:{key}", label, "satellite", unit, _rated("metrics", field))
    for key, field, label, unit in (
        ("area_ha", "area_ha", "Area", "ha"),
        ("natural_fraction", "natural_fraction", "Natural land cover", "share"),
        ("ndvi_mean", "ndvi_mean", "NDVI mean", None),
        ("ndvi_trend", "ndvi_trend", "NDVI trend", "NDVI/yr"),
        ("water_change", "water_change", "Surface-water change", "-100 to 100"),
        ("forest_loss_5y_ha", "forest_loss_ha", "Forest loss (5 years)", "ha"),
        ("forest_loss_12m_ha", "forest_loss_last_12m_ha", "Forest loss (12 months)", "ha"),
        ("biomass_t_ha", "biomass_t_ha", "Above-ground biomass", "t/ha"),
        ("soc_t_c_ha", "soc_t_c_ha", "Soil organic carbon", "t C/ha"),
        ("mangrove_fraction", "mangrove_fraction", "Mangrove cover", "share"),
        ("cloud_free_obs", "cloud_free_obs", "Cloud-free observations", None),
    )
)
_VALUATION: tuple[_Spec, ...] = (
    _Spec(
        "valuation:carbon_stock_tco2",
        "Carbon stock",
        "valuation",
        "tCO2",
        _rated("valuation", "carbon", "total_stock_tco2"),
    ),
    _Spec(
        "valuation:sequestration_tco2_yr",
        "Carbon sequestration",
        "valuation",
        "tCO2/yr",
        _rated("valuation", "carbon", "sequestration_tco2_yr"),
    ),
)


def _keys(reports: Iterable[Report], get: Callable[[Report], object]) -> list[str]:
    keys: set[str] = set()
    for report in reports:
        value = get(report)
        if isinstance(value, Mapping):
            keys.update(str(key) for key in value)
    return sorted(keys)


def _specs(older: Report, newer: Report) -> list[_Spec]:
    """Fixed metrics, then each land-cover class and service group in either report."""
    pair = (older, newer)
    landcover = [
        _Spec(
            f"metric:landcover.{name}",
            f"Land cover: {name.replace('_', ' ')}",
            "satellite",
            "share",
            _rated("metrics", "landcover", name),
        )
        for name in _keys(pair, _rated("metrics", "landcover"))
    ]
    services = [
        _Spec(
            f"valuation:service.{group}",
            f"Service value: {group.replace('_', ' ')}",
            "valuation",
            "Int$/yr",
            _service(group),
        )
        for group in _keys(pair, _column("value_breakdown"))
    ]
    return [*_HEADLINE, *_SCORE, *_SATELLITE, *landcover, *_VALUATION, *services]


def _metric_changes(older: Report, newer: Report) -> list[MetricChange]:
    out: list[MetricChange] = []
    for spec in _specs(older, newer):
        old, new = _number(spec.get(older)), _number(spec.get(newer))
        if old == new:  # unchanged, or absent from both
            continue
        out.append(
            MetricChange(
                id=spec.id,
                label=spec.label,
                group=spec.group,
                unit=spec.unit,
                change="added" if old is None else "removed" if new is None else "changed",
                old=old,
                new=new,
                delta=None if old is None or new is None else new - old,
                reason_refs=[],
            )
        )
    return out


def _grade_change(older: Report, newer: Report) -> GradeChange | None:
    if older.grade == newer.grade:
        return None
    old_rank = _GRADE_RANK.get(older.grade or "")
    new_rank = _GRADE_RANK.get(newer.grade or "")
    direction = (
        None if old_rank is None or new_rank is None else "up" if new_rank < old_rank else "down"
    )
    return GradeChange(old=older.grade, new=newer.grade, direction=direction)


# ----- reasons ----------------------------------------------------------------------------------


def _data_reasons(older: Report, newer: Report) -> list[DiffReason]:
    old_version = _at(_rating(older), "metrics", "data_version")
    new_version = _at(_rating(newer), "metrics", "data_version")
    if old_version == new_version:
        return []
    reasons = [
        DiffReason(
            source="data",
            version=newer.version,
            code="data_version",
            text=f"Satellite data version {old_version or 'unknown'} → {new_version or 'unknown'}.",
            citations=[],
        )
    ]
    description = _at(_rating(newer), "metrics", "scenario_deltas", "description")
    if _at(_rating(newer), "metrics", "simulated") is True and isinstance(description, str):
        scenario = _at(_rating(newer), "metrics", "scenario")
        reasons.append(
            DiffReason(
                source="scenario",
                version=newer.version,
                code=str(scenario) if scenario else None,
                text=f"Simulated scenario, not an observation: {description}",
                citations=[],
            )
        )
    return reasons


def _events(report: Report) -> dict[str, Mapping[str, Any]]:
    """The relevant events the report's rating scored with, by citation ID."""
    events = _rating(report).get("events")
    if not isinstance(events, list):
        return {}
    return {
        str(event["id"]): event
        for event in events
        if isinstance(event, Mapping) and event.get("id") and event.get("relevant") is True
    }


def _event_reason(event: Mapping[str, Any], version: int, *, counted: bool) -> DiffReason:
    event_id = str(event["id"])
    title = str(event.get("title") or event_id)
    negative = event.get("direction") == -1
    return DiffReason(
        source="event",
        version=version,
        code=str(event["impact_type"]) if event.get("impact_type") else None,
        text=title if counted else f"No longer counted: {title}",
        # A relevant negative event is priced by threat pressure (dev-spec §7.7).
        citations=[event_id, *(["score:threat_pressure"] if negative else [])],
    )


def _event_reasons(older: Report, newer: Report) -> list[DiffReason]:
    before, after = _events(older), _events(newer)
    return [
        *(
            _event_reason(e, newer.version, counted=True)
            for k, e in after.items()
            if k not in before
        ),
        *(
            _event_reason(e, newer.version, counted=False)
            for k, e in before.items()
            if k not in after
        ),
    ]


def _flags(report: Report) -> dict[tuple[str, str], str]:
    out: dict[tuple[str, str], str] = {}
    for flag in report.flags or []:
        if isinstance(flag, Mapping) and flag.get("type"):
            out[(str(flag["type"]), str(flag.get("source") or ""))] = str(flag.get("detail") or "")
    return out


def _flag_reasons(older: Report, newer: Report) -> list[DiffReason]:
    before, after = _flags(older), _flags(newer)
    added = [
        DiffReason(
            source="flag", version=newer.version, code=kind, text=detail or kind, citations=[]
        )
        for (kind, source), detail in after.items()
        if (kind, source) not in before
    ]
    cleared = [
        DiffReason(
            source="flag",
            version=newer.version,
            code=kind,
            text=f"No longer flagged: {detail or kind}",
            citations=[],
        )
        for (kind, source), detail in before.items()
        if (kind, source) not in after
    ]
    return [*added, *cleared]


def _auditor(report: Report) -> Mapping[str, Any]:
    auditor = (report.auditor_json or {}).get("auditor")
    return auditor if isinstance(auditor, Mapping) else {}


def _auditor_reasons(older: Report, newer: Report, between: Sequence[Report]) -> list[DiffReason]:
    """Each audited version's cited key changes in (older, newer], oldest first; then the
    newer report's adjustment reason if its adjustment differs from the older one's."""
    reasons: list[DiffReason] = []
    for report in sorted(between, key=lambda r: r.version):
        if not older.version < report.version <= newer.version:
            continue
        for text in _auditor(report).get("key_changes") or []:
            if isinstance(text, str) and text.strip():
                reasons.append(
                    DiffReason(
                        source="auditor",
                        version=report.version,
                        code="key_change",
                        text=text,
                        citations=list(dict.fromkeys(inline_citations(text))),
                    )
                )
    auditor = _auditor(newer)
    reason = auditor.get("adjustment_reason")
    old_adjustment = _number(_at(_rating(older), "score", "auditor_adjustment")) or Decimal(0)
    new_adjustment = _number(auditor.get("auditor_adjustment")) or Decimal(0)
    if isinstance(reason, str) and reason.strip() and new_adjustment != old_adjustment:
        citations = list(dict.fromkeys([*inline_citations(reason), "score:auditor_adjustment"]))
        reasons.append(
            DiffReason(
                source="auditor",
                version=newer.version,
                code="adjustment",
                text=reason,
                citations=citations,
            )
        )
    return reasons


def _link(metrics: list[MetricChange], reasons: Sequence[DiffReason]) -> list[MetricChange]:
    """Point each changed metric at the reasons that cite it."""
    cited: dict[str, list[int]] = {}
    for index, reason in enumerate(reasons):
        for citation in reason.citations:
            for key in (citation, *_ALIASES.get(citation, ())):
                refs = cited.setdefault(key, [])
                if index not in refs:
                    refs.append(index)
    return [
        metric.model_copy(update={"reason_refs": cited.get(metric.id, [])}) for metric in metrics
    ]


# ----- headline lines (the pre-T37 contract, kept) -----------------------------------------------


def _line(label: str, before: object, after: object) -> str:
    return f"{label} unchanged: {after}" if before == after else f"{label}: {before} → {after}"


def headline_changes(older: Report, newer: Report) -> list[str]:
    return [
        _line("health_score", older.health_score, newer.health_score),
        _line("grade", older.grade, newer.grade),
        _line("confidence", older.confidence, newer.confidence),
        _line("value_mid", older.value_mid, newer.value_mid),
        _line("fair_value_total", report_fair_value_total(older), report_fair_value_total(newer)),
    ]


def diff_reports(older: Report, newer: Report, between: Sequence[Report] = ()) -> ReportDiff:
    """What changed from ``older`` to ``newer`` (two versions of one asset), and why.

    ``between`` holds the asset's reports with versions in ``(older, newer]`` (``newer``
    included), whose Auditor key changes explain the steps; others are ignored.
    """
    if older.asset_id != newer.asset_id:
        raise ValueError("reports belong to different assets")
    if older.version > newer.version:
        raise ValueError("older is a later version than newer")
    reasons = [
        *_data_reasons(older, newer),
        *_event_reasons(older, newer),
        *_flag_reasons(older, newer),
        *_auditor_reasons(older, newer, between),
    ]
    return ReportDiff(
        report_id=newer.id,
        prev_report_id=older.id,
        changes=headline_changes(older, newer),
        from_version=older.version,
        to_version=newer.version,
        grade_change=_grade_change(older, newer),
        metrics=_link(_metric_changes(older, newer), reasons),
        reasons=reasons,
    )

"""Report history and diffs, read from the caller's world (T19)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlmodel import Session, col, select

from app.agents.summary import SummaryContext, generate_report_summary
from app.config import Settings
from app.db import engine
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.llm import LLMClient, LLMError, get_llm_client
from app.models import Asset, Event, Report
from app.schemas import AuditorOutput, EventOut, ReportDiff, ReportOut

router = APIRouter(tags=["reports"])


def _summary_client(settings: Settings) -> LLMClient | None:
    if settings.use_mocks:
        return None
    try:
        return get_llm_client(settings, lambda: Session(engine))
    except LLMError:
        return None


def event_out(event: Event) -> EventOut:
    return EventOut(
        id=event.id,
        asset_id=event.asset_id,
        source=event.source.value,
        title=event.title,
        url=event.url,
        published_at=event.published_at,
        impact_type=event.impact_type,
        direction=event.direction,
        severity=event.severity,
        summary=event.summary,
        created_at=event.created_at,
    )


def recent_events(session: Session, asset: Asset, limit: int = 5) -> list[EventOut]:
    rows = session.exec(
        select(Event)
        .where(Event.world_id == asset.world_id, Event.asset_id == asset.id)
        .order_by(col(Event.created_at).desc())
        .limit(limit)
    ).all()
    return [event_out(row) for row in rows]


def report_out(report: Report) -> ReportOut:
    """API view of a stored report. The deterministic snapshot is `auditor_json["rating"]`;
    the Auditor's output, once T26 adds it, is `auditor_json["auditor"]`."""
    stored: dict[str, Any] = report.auditor_json or {}
    rating: dict[str, Any] | None = stored.get("rating")
    metrics: dict[str, Any] = (rating or {}).get("metrics") or {}
    auditor = stored.get("auditor")
    return ReportOut(
        id=report.id,
        asset_id=report.asset_id,
        version=report.version,
        health_score=report.health_score,
        grade=report.grade,
        confidence=report.confidence,
        value_low=report.value_low,
        value_mid=report.value_mid,
        value_high=report.value_high,
        value_breakdown=report.value_breakdown,
        fair_value_per_share=report.fair_value_per_share,
        flags=report.flags,
        summary_md=report.summary_md,
        recommendations=[str(r) for r in report.recommendations]
        if report.recommendations is not None
        else None,
        auditor=AuditorOutput.model_validate(auditor) if auditor else None,
        data_version=metrics.get("data_version"),
        period=(rating or {}).get("period"),
        simulated=bool(metrics.get("simulated", False)),
        rating=rating,
        created_at=report.created_at,
    )


def summarize_report(
    report: ReportOut, settings: Settings, context: SummaryContext | None = None
) -> ReportOut:
    summary = generate_report_summary(
        report,
        settings,
        lambda: _summary_client(settings),
        log_asset_id_factory=lambda: report.asset_id,
        context=context,
    )
    return report.model_copy(
        update={"summary_md": summary.summary_md, "summary_source": summary.source}
    )


def summary_context(session: Session, asset: Asset) -> SummaryContext:
    events = recent_events(session, asset, limit=1)
    return SummaryContext(
        asset_name=asset.name,
        area_ha=asset.area_ha,
        country=asset.country,
        event=events[0] if events else None,
    )


def present_report(session: Session, report: Report, asset: Asset, settings: Settings) -> ReportOut:
    """A stored report with T10's summary (live Nemotron, or the deterministic fallback)."""
    return summarize_report(report_out(report), settings, summary_context(session, asset))


def _world_report(session: Session, world_id: UUID, report_id: UUID) -> Report:
    report = session.exec(
        select(Report).where(Report.world_id == world_id, Report.id == report_id)
    ).first()
    if report is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Report not found")
    return report


@router.get("/reports/{report_id}", response_model=ReportOut)
def get_report(
    report_id: UUID, world: CurrentWorld, session: SessionDep, settings: SettingsDep
) -> ReportOut:
    report = _world_report(session, world.id, report_id)
    asset = session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.id == report.asset_id)
    ).one()
    return present_report(session, report, asset, settings)


def _change(label: str, before: object, after: object) -> str:
    return f"{label} unchanged: {after}" if before == after else f"{label}: {before} → {after}"


@router.get("/reports/{report_id}/diff/{prev}", response_model=ReportDiff)
def diff_reports(
    report_id: UUID, prev: UUID, world: CurrentWorld, session: SessionDep
) -> ReportDiff:
    """Headline changes between two reports of one asset (deterministic; T37 extends it)."""
    current = _world_report(session, world.id, report_id)
    previous = _world_report(session, world.id, prev)
    if current.asset_id != previous.asset_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Reports belong to different assets")
    return ReportDiff(
        report_id=report_id,
        prev_report_id=prev,
        changes=[
            _change("health_score", previous.health_score, current.health_score),
            _change("grade", previous.grade, current.grade),
            _change("confidence", previous.confidence, current.confidence),
            _change("value_mid", previous.value_mid, current.value_mid),
            _change(
                "fair_value_per_share",
                previous.fair_value_per_share,
                current.fair_value_per_share,
            ),
        ],
    )

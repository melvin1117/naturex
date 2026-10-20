"""Report history and diffs (T37), read from the caller's world (T19)."""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Path, status
from sqlmodel import Session, col, select

from app.agents.auditor import inline_citations
from app.agents.summary import SummaryContext, generate_report_summary
from app.authz import Action, Actor, AssetRef, OptionalActor, acting_world, asset_ref_in, require
from app.config import Settings
from app.db import engine
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.llm import LLMClient, LLMError, get_llm_client
from app.models import Asset, Event, Metrics, Report
from app.schemas import (
    AuditorOutput,
    EventOut,
    ReportDiff,
    ReportOut,
    ReportSummarySource,
)
from app.services.diff import AuditedStep
from app.services.diff import diff_reports as build_report_diff
from app.services.listings import visible_to
from app.tools.earth_obs import NdviPoint

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
    the Auditor's output is `auditor_json["auditor"]`, how it was made `["audit"]` and the
    rating run `["run"]` (T27)."""
    stored: dict[str, Any] = report.auditor_json or {}
    rating: dict[str, Any] | None = stored.get("rating")
    metrics: dict[str, Any] = (rating or {}).get("metrics") or {}
    auditor = stored.get("auditor")
    audit: dict[str, Any] = stored.get("audit") or {}
    run: dict[str, Any] = stored.get("run") or {}
    greenwashing = (
        audit.get("greenwashing_risk") if audit else (auditor or {}).get("greenwashing_risk")
    )
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
        greenwashing_risk=greenwashing,
        run_id=run.get("run_id"),
        created_at=report.created_at,
    )


def audit_fell_back(report: Report) -> bool:
    """True when the stored audit is the Auditor's deterministic no-LLM template (T27)."""
    audit: dict[str, Any] = (report.auditor_json or {}).get("audit") or {}
    return bool(audit.get("fallback")) or audit.get("source") == "fallback"


def auditor_summary(report: ReportOut) -> str | None:
    """The Auditor's summary when it has inline [ID] citations (T27), else None.

    Simulated reports return None: T10's deterministic fallback states in code that the
    figures are a scenario, which neither the Auditor nor its template guarantees. The stored
    copy is preferred when it extends the Auditor's text (it adds the sandbox note and is what
    the ledger hashes)."""
    auditor = report.auditor
    if report.simulated or auditor is None or not inline_citations(auditor.summary_md):
        return None
    stored = report.summary_md
    if stored and stored.startswith(auditor.summary_md.rstrip()):
        return stored
    return auditor.summary_md


def summarize_report(
    report: ReportOut,
    settings: Settings,
    context: SummaryContext | None = None,
    *,
    audit_fallback: bool = False,
) -> ReportOut:
    """The Auditor's cited summary when there is one; otherwise T10's read-time summary.

    An Auditor summary from its no-LLM template (`audit_fallback`) keeps its text but is
    labelled `fallback`, since it is a deterministic template, not a model's audit."""
    audited = auditor_summary(report)
    if audited is not None:
        source = ReportSummarySource.FALLBACK if audit_fallback else ReportSummarySource.AUDITOR
        return report.model_copy(update={"summary_md": audited, "summary_source": source})
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


def ndvi_series(session: Session, report: Report) -> list[NdviPoint]:
    """The monthly NDVI stored with the report's metrics row (same world), oldest first."""
    if report.metrics_id is None:
        return []
    series = session.exec(
        select(Metrics.ndvi_series).where(
            Metrics.world_id == report.world_id, Metrics.id == report.metrics_id
        )
    ).first()
    points = [NdviPoint.model_validate(point) for point in series or []]
    return sorted(points, key=lambda point: point.month)


def present_report(
    session: Session,
    report: Report,
    asset: Asset,
    settings: Settings,
    *,
    with_ndvi: bool = True,
) -> ReportOut:
    """A stored report with its Auditor summary, or T10's (live Nemotron or the fallback),
    and (unless `with_ndvi` is off, as in the version list) the NDVI series behind its trend."""
    presented = summarize_report(
        report_out(report),
        settings,
        summary_context(session, asset),
        audit_fallback=audit_fell_back(report),
    )
    if not with_ndvi:
        return presented
    return presented.model_copy(update={"ndvi_series": ndvi_series(session, report)})


def _world_report(
    session: Session, world_id: UUID, report_id: UUID, actor: Actor | None
) -> tuple[Report, Asset]:
    """The report and its asset; 404 unless the asset is visible to the actor (T58)."""
    report = session.exec(
        select(Report).where(Report.world_id == world_id, Report.id == report_id)
    ).first()
    asset = (
        None
        if report is None
        else session.exec(
            select(Asset).where(Asset.world_id == world_id, Asset.id == report.asset_id)
        ).one()
    )
    if report is None or asset is None or not visible_to(actor, asset):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return report, asset


def report_ref(
    report_id: Annotated[UUID, Path()], actor: OptionalActor, session: SessionDep
) -> AssetRef | None:
    """The report's asset, loading the report by `(world_id, id)` in the actor's world (T57)."""
    world_id = acting_world(actor)
    asset_id = session.exec(
        select(Report.asset_id).where(Report.world_id == world_id, Report.id == report_id)
    ).first()
    return None if asset_id is None else asset_ref_in(session, world_id, asset_id)


BROWSE_REPORT = require(Action.BROWSE, report_ref)


@router.get("/reports/{report_id}", response_model=ReportOut, dependencies=[BROWSE_REPORT])
def get_report(
    report_id: UUID,
    world: CurrentWorld,
    actor: OptionalActor,
    session: SessionDep,
    settings: SettingsDep,
) -> ReportOut:
    report, asset = _world_report(session, world.id, report_id, actor)
    return present_report(session, report, asset, settings)


@router.get(
    "/reports/{report_id}/diff/{prev}",
    response_model=ReportDiff,
    dependencies=[BROWSE_REPORT],
    responses={
        400: {
            "description": "The reports belong to different assets, or `prev` is the later "
            "version (`prev_not_older`)."
        },
        404: {"description": "Either report is missing, in another world or not visible."},
    },
)
def diff_reports(
    report_id: UUID, prev: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep
) -> ReportDiff:
    """What changed from report `prev` to report `report_id` (two versions of one asset):
    each changed number with its old and new value and delta, the grade change and the reasons
    (stored Auditor citations, events, flags and data versions; no model is called).
    400 `prev_not_older` when `prev` is a later version than `report_id`."""
    current, _ = _world_report(session, world.id, report_id, actor)
    previous, _ = _world_report(session, world.id, prev, actor)
    if current.asset_id != previous.asset_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Reports belong to different assets")
    if previous.version > current.version:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "prev_not_older")
    # Only each version's key changes: a full `auditor_json` also carries the run's trace.
    key_changes = col(Report.auditor_json)["auditor"]["key_changes"]
    rows = session.exec(
        select(Report.version, key_changes)
        .where(
            Report.world_id == world.id,
            Report.asset_id == current.asset_id,
            Report.version > previous.version,
            Report.version <= current.version,
        )
        .order_by(col(Report.version))
    ).all()
    steps = [AuditedStep(version, changes) for version, changes in rows]
    return build_report_diff(previous, current, steps)

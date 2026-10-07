"""Report history and diffs."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app import mocks
from app.agents.summary import generate_report_summary
from app.config import Settings
from app.db import engine
from app.deps import SettingsDep
from app.llm import LLMClient, LLMError, get_llm_client
from app.models import Asset
from app.schemas import ReportDiff, ReportOut

router = APIRouter(tags=["reports"])


def _summary_client(settings: Settings) -> LLMClient | None:
    if settings.use_mocks:
        return None
    try:
        with Session(engine) as session:
            session.execute(text("SELECT 1"))
        return get_llm_client(settings, lambda: Session(engine))
    except (LLMError, SQLAlchemyError):
        return None


def _log_asset_id(report: ReportOut, settings: Settings) -> UUID | None:
    if settings.use_mocks:
        return None
    try:
        with Session(engine) as session:
            return report.asset_id if session.get(Asset, report.asset_id) is not None else None
    except SQLAlchemyError:
        return None


@router.get("/reports/{report_id}", response_model=ReportOut)
def get_report(report_id: UUID, settings: SettingsDep) -> ReportOut:
    report = mocks.get_report(report_id)
    if report is None:
        # Fall back: any asset's latest report matching id is uncommon in mocks
        raise HTTPException(status_code=404, detail="Report not found")
    summary = generate_report_summary(
        report,
        settings,
        _summary_client(settings),
        log_asset_id=_log_asset_id(report, settings),
    )
    return report.model_copy(
        update={"summary_md": summary.summary_md, "summary_source": summary.source}
    )


@router.get("/reports/{report_id}/diff/{prev}", response_model=ReportDiff)
def diff_reports(report_id: UUID, prev: UUID) -> ReportDiff:
    current = mocks.get_report(report_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Report not found")
    return ReportDiff(
        report_id=report_id,
        prev_report_id=prev,
        changes=[
            "health_score: 79.6 → 77.6 (auditor −2)",
            "grade unchanged: A",
            "new event: encroachment severity 4",
        ],
    )

"""Report history and diffs."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app import mocks
from app.schemas import ReportDiff, ReportOut

router = APIRouter(tags=["reports"])


@router.get("/reports/{report_id}", response_model=ReportOut)
def get_report(report_id: UUID) -> ReportOut:
    report = mocks.get_report(report_id)
    if report is None:
        # Fall back: any asset's latest report matching id is uncommon in mocks
        raise HTTPException(status_code=404, detail="Report not found")
    return report


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

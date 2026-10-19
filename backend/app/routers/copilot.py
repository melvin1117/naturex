"""Investor Copilot (mock grounded answer)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.deps import current_principal
from app.mocks import EVENT_ENCROACH
from app.schemas import CopilotCitation, CopilotRequest, CopilotResponse

router = APIRouter(tags=["copilot"])


@router.post("/copilot", response_model=CopilotResponse, dependencies=[Depends(current_principal)])
def ask_copilot(body: CopilotRequest) -> CopilotResponse:
    return CopilotResponse(
        answer=(
            "The price moved mainly because of an encroachment news event "
            f"(severity 4) near the wetland. See [E{EVENT_ENCROACH}] and [R1]."
        ),
        citations=[
            CopilotCitation(
                ref=f"E{EVENT_ENCROACH}",
                snippet="Industrial park expansion bordering the wetland.",
            ),
            CopilotCitation(
                ref="R1",
                snippet="Health 77.6, grade A, auditor adjustment −2.",
            ),
        ],
    )

"""Investor Copilot (mock grounded answer)."""

from __future__ import annotations

from fastapi import APIRouter

from app.authz import (
    Action,
    DenyReason,
    OptionalActor,
    WorldRef,
    acting_world,
    asset_ref_in,
    denied,
    require,
)
from app.deps import SessionDep
from app.mocks import EVENT_ENCROACH
from app.schemas import CopilotCitation, CopilotRequest, CopilotResponse

router = APIRouter(tags=["copilot"])


def copilot_world(
    body: CopilotRequest, actor: OptionalActor, session: SessionDep
) -> WorldRef | None:
    """The caller's world, if the asset asked about (if any) is in it by `(world_id, id)`;
    None (a 404) otherwise. `body` is the route's own, parsed once."""
    world_id = acting_world(actor)
    if body.asset_id is not None and asset_ref_in(session, world_id, body.asset_id) is None:
        return None
    return WorldRef(world_id)


@router.post(
    "/copilot",
    response_model=CopilotResponse,
    dependencies=[require(Action.USE_OWN_ACCOUNT, copilot_world)],
    responses=denied(DenyReason.TREASURY_CANNOT_ACT),
)
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

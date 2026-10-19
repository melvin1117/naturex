"""Time Machine, event injection, and agent trace (mock). Tamper demo lives on the ledger router."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Query

from app import mocks
from app.deps import (
    ADMIN_ONLY,
    CurrentPrincipal,
    CurrentWorld,
    SessionDep,
    require_sandbox_or_admin,
)
from app.routers.assets import world_asset
from app.schemas import (
    EventOut,
    SimulateEventRequest,
    SimulateEventResponse,
    SimulateQuarterResponse,
    TraceOut,
)

router = APIRouter(prefix="/admin", tags=["admin"])


ADMIN_ONLY_RESPONSE: dict[int | str, dict[str, Any]] = {
    403: {"description": f"`{ADMIN_ONLY}`: only an admin can do this in the live world"}
}


@router.post(
    "/simulate/quarter", response_model=SimulateQuarterResponse, responses=ADMIN_ONLY_RESPONSE
)
def simulate_quarter(world: CurrentWorld, principal: CurrentPrincipal) -> SimulateQuarterResponse:
    require_sandbox_or_admin(world, principal)
    return SimulateQuarterResponse(
        data_version="sim-1",
        assets_rerated=3,
        message="Mock re-rate of all listed assets to data_version sim-1.",
    )


@router.post("/simulate/event", response_model=SimulateEventResponse, responses=ADMIN_ONLY_RESPONSE)
def simulate_event(
    body: SimulateEventRequest,
    world: CurrentWorld,
    principal: CurrentPrincipal,
    session: SessionDep,
) -> SimulateEventResponse:
    """Stub event for an asset in the caller's world (T38 persists it and re-rates)."""
    require_sandbox_or_admin(world, principal)
    world_asset(session, world.id, body.asset_id)
    event = EventOut(
        id=uuid4(),
        asset_id=body.asset_id,
        source="admin",
        title=f"Injected preset: {body.preset}",
        url=None,
        published_at=None,
        impact_type=body.preset if body.preset != "protection" else "protection",
        direction=1 if body.preset in {"restoration", "protection"} else -1,
        severity=4 if body.preset in {"fire", "encroachment", "drought"} else 2,
        summary=f"Admin Time Machine injected '{body.preset}' (mock).",
        created_at=datetime.now(UTC),
    )
    return SimulateEventResponse(event=event, alert_created=True)


@router.get("/trace", response_model=TraceOut)
def get_trace(asset_id: Annotated[UUID | None, Query()] = None) -> TraceOut:
    return TraceOut(asset_id=asset_id, steps=mocks.trace_steps(asset_id))

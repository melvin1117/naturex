"""Time Machine, event injection, and call log. Tamper demo lives on the ledger router.

The Time Machine and event injection are operator actions: admins only, in their own world
(`Action.OPERATE`; a demo admin persona operates only its sandbox). The agent trace is a read
(`Action.BROWSE`, ADR-0005 §3 matrix row 1).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Query
from sqlmodel import col, select

from app.authz import (
    Action,
    AssetRef,
    DenyReason,
    OptionalActor,
    WorldRef,
    acting_world,
    asset_ref_in,
    denied,
    require,
)
from app.deps import CurrentWorld, SessionDep
from app.models import LlmCall
from app.schemas import (
    EventOut,
    SimulateEventRequest,
    SimulateEventResponse,
    SimulateQuarterResponse,
    TraceOut,
    TraceStep,
)

router = APIRouter(prefix="/admin", tags=["admin"])


OPERATE = require(Action.OPERATE)
ADMIN_ONLY_RESPONSE: dict[int | str, dict[str, Any]] = denied(DenyReason.ADMIN_ONLY)


def injected_asset_ref(
    body: SimulateEventRequest, actor: OptionalActor, session: SessionDep
) -> AssetRef | None:
    """The asset an event is injected into, by `(world_id, id)` from the route's own body (parsed
    once, so the request schema is unchanged); None (a 404) outside the caller's world."""
    return asset_ref_in(session, acting_world(actor), body.asset_id)


def trace_target(
    actor: OptionalActor,
    session: SessionDep,
    asset_id: Annotated[UUID | None, Query()] = None,
) -> WorldRef | AssetRef | None:
    """The traced asset by `(world_id, id)` (None, a 404, if it isn't in the caller's world),
    or the world when no asset is given."""
    world_id = acting_world(actor)
    return WorldRef(world_id) if asset_id is None else asset_ref_in(session, world_id, asset_id)


@router.post(
    "/simulate/quarter",
    response_model=SimulateQuarterResponse,
    dependencies=[OPERATE],
    responses=ADMIN_ONLY_RESPONSE,
)
def simulate_quarter(world: CurrentWorld) -> SimulateQuarterResponse:
    return SimulateQuarterResponse(
        data_version="sim-1",
        assets_rerated=3,
        message="Mock re-rate of all listed assets to data_version sim-1.",
    )


@router.post(
    "/simulate/event",
    response_model=SimulateEventResponse,
    # On the asset, so an admin in the asset's community is refused (`conflict_of_interest`).
    dependencies=[require(Action.OPERATE, injected_asset_ref)],
    responses=denied(DenyReason.ADMIN_ONLY, DenyReason.CONFLICT_OF_INTEREST),
)
def simulate_event(body: SimulateEventRequest, world: CurrentWorld) -> SimulateEventResponse:
    """Stub event for an asset in the caller's world (T38 persists it and re-rates)."""
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


@router.get("/trace", response_model=TraceOut, dependencies=[require(Action.BROWSE, trace_target)])
def get_trace(
    world: CurrentWorld, session: SessionDep, asset_id: Annotated[UUID | None, Query()] = None
) -> TraceOut:
    """Recent call metadata for this world or asset; for per-run tool spans use /runs/{id}/trace."""
    query = select(LlmCall).where(LlmCall.world_id == world.id)
    if asset_id is not None:
        query = query.where(LlmCall.asset_id == asset_id)
    calls = session.exec(query.order_by(col(LlmCall.id).desc()).limit(50)).all()
    return TraceOut(
        asset_id=asset_id,
        steps=[
            TraceStep(
                agent=call.agent,
                model=call.model,
                prompt_tokens=call.prompt_tokens,
                completion_tokens=call.completion_tokens,
                latency_ms=call.latency_ms,
                created_at=call.created_at,
                status=call.status,
            )
            for call in calls
        ],
    )

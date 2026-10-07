"""World-scoped live events over SSE plus polling fallback."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from app import events as event_bus
from app.deps import CurrentWorld, SessionDep
from app.schemas import StreamEvent

router = APIRouter(tags=["events"])


def _parse_last_event_id(value: str | None) -> int | None:
    if value in (None, ""):
        return None
    try:
        event_id = int(value)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid Last-Event-ID") from exc
    if event_id < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid Last-Event-ID")
    return event_id


@router.get("/events", response_model=list[StreamEvent])
def poll_events(
    world: CurrentWorld,
    session: SessionDep,
    since: Annotated[datetime | None, Query()] = None,
    since_id: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=event_bus.REPLAY_BATCH_LIMIT)] = (
        event_bus.REPLAY_BATCH_LIMIT
    ),
) -> list[StreamEvent]:
    return event_bus.replay(session, world.id, since_id=since_id, since=since, limit=limit)


@router.get("/events/stream")
async def stream_events(
    request: Request,
    world: CurrentWorld,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    since_id: Annotated[int | None, Query(ge=0)] = None,
) -> StreamingResponse:
    cursor = _parse_last_event_id(last_event_id) if last_event_id is not None else since_id
    return StreamingResponse(
        event_bus.stream(world.id, request, cursor),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

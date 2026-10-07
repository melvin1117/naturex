"""World-scoped live events over SSE plus polling fallback."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from app import events as event_bus
from app.db import get_session
from app.deps import CurrentWorld, SessionDep, SettingsDep, current_world
from app.models import World
from app.schemas import StreamEvent

router = APIRouter(tags=["events"])
StreamSessionDep = Annotated[Session, Depends(get_session, scope="function")]


def current_world_for_stream(
    request: Request,
    response: Response,
    session: StreamSessionDep,
    settings: SettingsDep,
) -> World:
    return current_world(request, response, session, settings)


CurrentWorldForStream = Annotated[World, Depends(current_world_for_stream)]


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
    world: CurrentWorldForStream,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    since_id: Annotated[int | None, Query(ge=0)] = None,
) -> StreamingResponse:
    cursor = _parse_last_event_id(last_event_id) if last_event_id is not None else since_id
    release_slot = await event_bus.acquire_stream_slot()
    if release_slot is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "too_many_event_streams",
            headers={"Retry-After": str(event_bus.SSE_RETRY_MS // 1000)},
        )
    return StreamingResponse(
        event_bus.stream(world.id, request, cursor, release_slot),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

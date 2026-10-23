"""World-scoped live events over SSE plus polling fallback.

Both derive the reader and its world from the session (T57): they browse the world
(`Action.BROWSE`). Events about a listing under review reach only its community and same-world
admins (T58), and `alert` events only their targets (T57); see `app.events._visible`. The
stream re-checks the session on every poll and ends once it's gone.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlmodel import Session

from app import events as event_bus
from app.authz import Action, WorldRef, authorizes, enforce, lazy_actor, require
from app.channel import session_cookie
from app.db import get_session
from app.deps import (
    CurrentWorld,
    OptionalPrincipal,
    SessionDep,
    SettingsDep,
    current_world,
    optional_principal,
)
from app.schemas import StreamEvent

router = APIRouter(tags=["events"])
StreamSessionDep = Annotated[Session, Depends(get_session, scope="function")]


@dataclass(frozen=True)
class StreamAccess:
    world_id: UUID
    auth: event_bus.StreamAuth | None


@authorizes(Action.BROWSE)
def stream_access(request: Request, response: Response, session: StreamSessionDep) -> StreamAccess:
    """The stream's world and session, authorized like `require(Action.BROWSE)` but on a DB
    session closed before streaming starts, so an open stream never holds a pooled connection."""
    principal = optional_principal(request, session)
    world = current_world(request, response, session, principal)
    actor = None if principal is None else lazy_actor(session, principal)
    enforce(actor, Action.BROWSE, WorldRef(world.id))
    token = request.cookies.get(session_cookie(request))
    auth = (
        None
        if principal is None or token is None
        else event_bus.StreamAuth(token, principal.session_id)
    )
    return StreamAccess(world.id, auth)


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


@router.get("/events", response_model=list[StreamEvent], dependencies=[require(Action.BROWSE)])
def poll_events(
    world: CurrentWorld,
    principal: OptionalPrincipal,
    session: SessionDep,
    since: Annotated[datetime | None, Query()] = None,
    since_id: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query(ge=1, le=event_bus.REPLAY_BATCH_LIMIT)] = (
        event_bus.REPLAY_BATCH_LIMIT
    ),
) -> list[StreamEvent]:
    viewer = event_bus.viewer_for(world.id, principal)
    return event_bus.replay(
        session, world.id, since_id=since_id, since=since, limit=limit, viewer=viewer
    )


@router.get("/events/stream")
async def stream_events(
    request: Request,
    access: Annotated[StreamAccess, Depends(stream_access)],
    settings: SettingsDep,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    since_id: Annotated[int | None, Query(ge=0)] = None,
) -> event_bus.EventStreamResponse:
    cursor = _parse_last_event_id(last_event_id) if last_event_id is not None else since_id
    return event_bus.EventStreamResponse(
        access.world_id,
        request,
        cursor,
        settings.event_stream_max_concurrent,
        access.auth,
    )

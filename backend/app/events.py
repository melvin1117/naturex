"""Persisted, world-scoped event bus for polling and Server-Sent Events (T29).

Who sees what (`_visible`, one query per read): events about a listing under review go only to
its community's members and same-world admins (T58's audience); an `alert` goes only to its
targets, the holders of `payload["asset_id"]` and the members of that asset's community (T57).
Both are worked out from the reader's account on every read. A stream re-resolves its session
on every poll, so it closes within a poll interval of a logout, expiry or revocation.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import Connection, String, delete, insert, or_, text
from sqlalchemy import cast as sa_cast
from sqlalchemy import select as sa_select
from sqlalchemy.engine import CursorResult
from sqlmodel import Session, col, select
from sqlmodel.sql.expression import SelectOfScalar
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.types import Receive, Scope, Send

from app.auth import Principal, resolve_session
from app.db import engine
from app.models import Asset, CommunityMember, Holding, StreamEventType, WorldEvent
from app.schemas import StreamEvent

REPLAY_BATCH_LIMIT = 100
STREAM_REPLAY_BATCH_LIMIT = 100
STREAM_POLL_INTERVAL_SECONDS = 1.0
HEARTBEAT_INTERVAL_SECONDS = 15.0
STREAM_MAX_SECONDS = 300.0
STREAM_ACQUIRE_TIMEOUT_SECONDS = 0.01
SSE_RETRY_MS = 3000
EVENT_RETENTION = timedelta(hours=24)
_stream_semaphore_limit = 0
_stream_semaphore = asyncio.BoundedSemaphore(1)


ADMINS_ONLY = UUID(int=0)
"""Audience for an event no community may see, only same-world admins (T58)."""


@dataclass(frozen=True)
class Viewer:
    """Who reads a world's events: a signed-in account of that world (its holdings and
    memberships are looked up in each read's own query). Built only for a principal in the world
    being read; anyone else is `PUBLIC_VIEWER`."""

    user_id: UUID | None = None
    is_admin: bool = False


PUBLIC_VIEWER = Viewer()


def viewer_for(world_id: UUID, principal: Principal | None) -> Viewer:
    """The reader of `world_id` behind `principal`; public unless it's signed in to that world."""
    if principal is None or principal.world_id != world_id:
        return PUBLIC_VIEWER
    return Viewer(principal.user_id, principal.is_admin)


def _visible(
    stmt: SelectOfScalar[WorldEvent], world_id: UUID, viewer: Viewer
) -> SelectOfScalar[WorldEvent]:
    """Only the events `viewer` may see; both rules hold together, in one query:

    - **Audience (T58):** an event about a listing under review carries its community; only that
      community's members and same-world admins get it (`ADMINS_ONLY`: admins only).
    - **Alerts (T57):** an `alert` goes only to its targets, the holders of `payload.asset_id`
      and the members of that asset's community. An alert without an `asset_id` goes to nobody.

    Memberships and holdings are subqueries, so they are as of this read.
    """
    audience = col(WorldEvent.audience_community_id)
    is_alert = col(WorldEvent.type) == StreamEventType.ALERT
    if viewer.user_id is None:
        return stmt.where(audience.is_(None), ~is_alert)
    my_communities = sa_select(col(CommunityMember.community_id)).where(
        col(CommunityMember.world_id) == world_id,
        col(CommunityMember.user_id) == viewer.user_id,
    )
    if not viewer.is_admin:
        stmt = stmt.where(or_(audience.is_(None), audience.in_(my_communities)))
    held = sa_select(sa_cast(col(Holding.asset_id), String)).where(
        col(Holding.world_id) == world_id,
        col(Holding.user_id) == viewer.user_id,
        col(Holding.shares) > 0,
    )
    own = sa_select(sa_cast(col(Asset.id), String)).where(
        col(Asset.world_id) == world_id, col(Asset.community_id).in_(my_communities)
    )
    alert_asset = col(WorldEvent.payload)["asset_id"].astext
    return stmt.where(or_(~is_alert, alert_asset.in_(held), alert_asset.in_(own)))


async def _empty_stream() -> AsyncIterator[str]:
    if False:
        yield ""


@contextmanager
def session_scope() -> Iterator[Session]:
    """Open a short-lived DB session for stream polling."""
    with Session(engine) as session:
        yield session


def _event_type(value: StreamEventType | str) -> StreamEventType:
    try:
        return StreamEventType(value)
    except ValueError as exc:
        allowed = ", ".join(item.value for item in StreamEventType)
        raise ValueError(
            f"unsupported stream event type {value!r}; expected one of {allowed}"
        ) from exc


def _payload(value: Mapping[str, Any]) -> dict[str, Any]:
    encoded = jsonable_encoder(dict(value))
    if not isinstance(encoded, dict):
        raise TypeError("event payload must encode to a JSON object")
    return encoded


def _to_stream_event(row: WorldEvent) -> StreamEvent:
    if row.id is None:
        raise ValueError("world event has no id; flush before serializing")
    return StreamEvent(id=row.id, type=row.type, payload=row.payload, ts=row.created_at)


def lock_world_publisher(session_or_conn: Session | Connection, world_id: UUID) -> None:
    """The per-world publisher lock (transaction-scoped and re-entrant). Rating runs (T27)
    take it before their check-then-publish, so run caps can't race."""
    session_or_conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:world_id, 0))"),
        {"world_id": str(world_id)},
    )


def publish(
    session_or_conn: Session | Connection,
    world_id: UUID,
    type: StreamEventType | str,
    payload: Mapping[str, Any],
    *,
    audience: UUID | None = None,
) -> StreamEvent:
    """Persist an event in the caller's transaction and return its stream contract shape.

    `audience` scopes the event to one community's members and same-world admins (T58: a
    listing under review); None publishes it to everyone in the world.

    Same-world publishers take a transaction-level advisory lock before inserting, so the
    monotonic id cursor matches commit visibility for one world. Keep publishing
    transactions short; long transactions delay later events in the same visitor world.
    """
    event_type = _event_type(type)
    event_payload = _payload(payload)
    lock_world_publisher(session_or_conn, world_id)
    if isinstance(session_or_conn, Session):
        row = WorldEvent(
            world_id=world_id,
            type=event_type,
            payload=event_payload,
            audience_community_id=audience,
        )
        session_or_conn.add(row)
        session_or_conn.flush()
        return _to_stream_event(row)

    table = cast(Any, WorldEvent).__table__
    result = session_or_conn.execute(
        insert(table)
        .values(
            world_id=world_id,
            type=event_type.value,
            payload=event_payload,
            audience_community_id=audience,
        )
        .returning(table.c.id, table.c.created_at)
    ).one()
    return StreamEvent(
        id=cast(int, result.id),
        type=event_type,
        payload=event_payload,
        ts=cast(datetime, result.created_at),
    )


def replay(
    session: Session,
    world_id: UUID,
    *,
    since_id: int | None = None,
    since: datetime | None = None,
    limit: int = REPLAY_BATCH_LIMIT,
    viewer: Viewer = PUBLIC_VIEWER,
) -> list[StreamEvent]:
    """Return the events of one world `viewer` may see, ordered by monotonic event id."""
    capped_limit = max(0, min(limit, REPLAY_BATCH_LIMIT))
    if capped_limit == 0:
        return []

    stmt = _visible(select(WorldEvent).where(WorldEvent.world_id == world_id), world_id, viewer)
    if since_id is not None:
        stmt = stmt.where(col(WorldEvent.id) > since_id)
    elif since is not None:
        stmt = stmt.where(col(WorldEvent.created_at) > since)
    stmt = stmt.order_by(col(WorldEvent.id)).limit(capped_limit)
    return [_to_stream_event(row) for row in session.exec(stmt).all()]


def prune_old_events(session: Session, older_than: timedelta = EVENT_RETENTION) -> int:
    """Drop retained live events older than the retention window."""
    cutoff = datetime.now(UTC) - older_than
    result = cast(
        CursorResult[Any],
        session.execute(delete(WorldEvent).where(col(WorldEvent.created_at) < cutoff)),
    )
    return int(result.rowcount or 0)


def format_sse(event: StreamEvent) -> str:
    """Format one event according to the HTML event-stream field syntax."""
    lines: list[str] = []
    if event.id is not None:
        lines.append(f"id: {event.id}")
    lines.append(f"event: {event.type}")
    data = json.dumps(event.model_dump(mode="json"), separators=(",", ":"))
    lines.append(f"data: {data}")
    return "\n".join(lines) + "\n\n"


def heartbeat() -> StreamEvent:
    return StreamEvent(id=None, type=StreamEventType.HEARTBEAT, payload={}, ts=datetime.now(UTC))


@dataclass(frozen=True)
class StreamAuth:
    """The session a stream was opened with, re-checked on every poll (T57)."""

    token: str
    session_id: UUID


def current_viewer(session: Session, world_id: UUID, auth: StreamAuth | None) -> Viewer | None:
    """The stream's reader as of now, or None once its session has ended (logged out, expired,
    revoked, its account deleted) or no longer belongs to this world. Anonymous streams have no
    session to lose."""
    if auth is None:
        return PUBLIC_VIEWER
    principal = resolve_session(session, auth.token)
    if principal is None or (principal.session_id, principal.world_id) != (
        auth.session_id,
        world_id,
    ):
        return None
    return viewer_for(world_id, principal)


def _poll_once(
    world_id: UUID, cursor: int | None, auth: StreamAuth | None = None
) -> list[StreamEvent] | None:
    """The next batch for the stream's reader, or None when its session has ended."""
    with session_scope() as session:
        viewer = current_viewer(session, world_id, auth)
        if viewer is None:
            return None
        return replay(
            session,
            world_id,
            since_id=cursor,
            limit=STREAM_REPLAY_BATCH_LIMIT,
            viewer=viewer,
        )


def _stream_slots(max_concurrent: int) -> asyncio.BoundedSemaphore:
    global _stream_semaphore, _stream_semaphore_limit
    if max_concurrent < 1:
        raise ValueError("event_stream_max_concurrent must be at least 1")
    if _stream_semaphore_limit != max_concurrent:
        _stream_semaphore = asyncio.BoundedSemaphore(max_concurrent)
        _stream_semaphore_limit = max_concurrent
    return _stream_semaphore


def stream_slots_available(max_concurrent: int) -> int:
    return cast(int, cast(Any, _stream_slots(max_concurrent))._value)


async def acquire_stream_slot(max_concurrent: int) -> Callable[[], None] | None:
    slots = _stream_slots(max_concurrent)
    try:
        await asyncio.wait_for(slots.acquire(), timeout=STREAM_ACQUIRE_TIMEOUT_SECONDS)
    except TimeoutError:
        return None

    released = False

    def release() -> None:
        nonlocal released
        if not released:
            released = True
            # Release the semaphore we acquired, even if the limit changed meanwhile.
            slots.release()

    return release


class EventStreamResponse(StreamingResponse):
    def __init__(
        self,
        world_id: UUID,
        request: Request,
        since_id: int | None,
        max_concurrent: int,
        auth: StreamAuth | None = None,
    ) -> None:
        self.world_id = world_id
        self.auth = auth
        self.request = request
        self.since_id = since_id
        self.max_concurrent = max_concurrent
        super().__init__(
            _empty_stream(),
            media_type="text/event-stream",
            headers={
                # no-transform: stops proxies (e.g. Next.js's gzip on the /api rewrite) from
                # compressing, and so buffering, the stream.
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        release_slot = await acquire_stream_slot(self.max_concurrent)
        if release_slot is None:
            await JSONResponse(
                {"detail": "too_many_event_streams"},
                status_code=503,
                headers={"Retry-After": str(SSE_RETRY_MS // 1000)},
            )(scope, receive, send)
            return
        self.body_iterator = stream(
            self.world_id, self.request, self.since_id, release_slot, self.auth
        )
        try:
            await super().__call__(scope, receive, send)
        finally:
            release_slot()


async def stream(
    world_id: UUID,
    request: Request,
    since_id: int | None = None,
    release_slot: Callable[[], None] | None = None,
    auth: StreamAuth | None = None,
) -> AsyncIterator[str]:
    """Yield a finite SSE stream with replay, DB polling and heartbeat keep-alives.

    Every poll re-resolves `auth` first, and a heartbeat only follows a poll that did, so the
    stream ends (the client may reconnect with its current cookie) once the session is gone.
    """
    cursor = since_id
    deadline = time.monotonic() + STREAM_MAX_SECONDS
    last_heartbeat = time.monotonic()
    try:
        yield f"retry: {SSE_RETRY_MS}\n\n"

        while time.monotonic() < deadline:
            if await request.is_disconnected():
                break

            batch = await run_in_threadpool(_poll_once, world_id, cursor, auth)
            if batch is None:
                break

            if batch:
                for event in batch:
                    yield format_sse(event)
                    cursor = event.id
                continue

            now = time.monotonic()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
                yield format_sse(heartbeat())
                last_heartbeat = now

            await asyncio.sleep(STREAM_POLL_INTERVAL_SECONDS)
    finally:
        if release_slot is not None:
            release_slot()

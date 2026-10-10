"""Persisted, world-scoped event bus for polling and Server-Sent Events (T29)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import Connection, delete, insert, text
from sqlalchemy.engine import CursorResult
from sqlmodel import Session, col, select
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.types import Receive, Scope, Send

from app.db import engine
from app.models import StreamEventType, WorldEvent
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


def _lock_world_publisher(session_or_conn: Session | Connection, world_id: UUID) -> None:
    session_or_conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:world_id, 0))"),
        {"world_id": str(world_id)},
    )


def publish(
    session_or_conn: Session | Connection,
    world_id: UUID,
    type: StreamEventType | str,
    payload: Mapping[str, Any],
) -> StreamEvent:
    """Persist an event in the caller's transaction and return its stream contract shape.

    Same-world publishers take a transaction-level advisory lock before inserting, so the
    monotonic id cursor matches commit visibility for one world. Keep publishing
    transactions short; long transactions delay later events in the same visitor world.
    """
    event_type = _event_type(type)
    event_payload = _payload(payload)
    _lock_world_publisher(session_or_conn, world_id)
    if isinstance(session_or_conn, Session):
        row = WorldEvent(world_id=world_id, type=event_type, payload=event_payload)
        session_or_conn.add(row)
        session_or_conn.flush()
        return _to_stream_event(row)

    table = cast(Any, WorldEvent).__table__
    result = session_or_conn.execute(
        insert(table)
        .values(world_id=world_id, type=event_type.value, payload=event_payload)
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
) -> list[StreamEvent]:
    """Return persisted events for one world, ordered by monotonic event id."""
    capped_limit = max(0, min(limit, REPLAY_BATCH_LIMIT))
    if capped_limit == 0:
        return []

    stmt = select(WorldEvent).where(WorldEvent.world_id == world_id)
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


def _poll_once(world_id: UUID, cursor: int | None) -> list[StreamEvent]:
    with session_scope() as session:
        return replay(
            session,
            world_id,
            since_id=cursor,
            limit=STREAM_REPLAY_BATCH_LIMIT,
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
    ) -> None:
        self.world_id = world_id
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
        self.body_iterator = stream(self.world_id, self.request, self.since_id, release_slot)
        try:
            await super().__call__(scope, receive, send)
        finally:
            release_slot()


async def stream(
    world_id: UUID,
    request: Request,
    since_id: int | None = None,
    release_slot: Callable[[], None] | None = None,
) -> AsyncIterator[str]:
    """Yield a finite SSE stream with replay, DB polling and heartbeat keep-alives."""
    cursor = since_id
    deadline = time.monotonic() + STREAM_MAX_SECONDS
    last_heartbeat = time.monotonic()
    try:
        yield f"retry: {SSE_RETRY_MS}\n\n"

        while time.monotonic() < deadline:
            if await request.is_disconnected():
                break

            batch = await run_in_threadpool(_poll_once, world_id, cursor)

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

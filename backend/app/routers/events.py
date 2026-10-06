"""SSE live events + polling fallback."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app.schemas import StreamEvent

router = APIRouter(tags=["events"])


def _sample_events(since: datetime | None = None) -> list[StreamEvent]:
    _ = since
    now = datetime.now(UTC)
    return [
        StreamEvent(
            type="rating_progress",
            payload={"run_id": "mock-run", "step": "earth_obs"},
            ts=now,
        ),
        StreamEvent(
            type="rating_progress",
            payload={"run_id": "mock-run", "step": "done"},
            ts=now,
        ),
        StreamEvent(
            type="heartbeat",
            payload={},
            ts=now,
        ),
    ]


@router.get("/events", response_model=list[StreamEvent])
def poll_events(since: Annotated[datetime | None, Query()] = None) -> list[StreamEvent]:
    return _sample_events(since)


@router.get("/events/stream")
async def stream_events() -> StreamingResponse:
    async def gen() -> AsyncIterator[str]:
        for event in _sample_events():
            data = json.dumps(event.model_dump(mode="json"))
            yield f"event: {event.type}\ndata: {data}\n\n"
            await asyncio.sleep(0.05)
        # end stream after mock burst

    return StreamingResponse(gen(), media_type="text/event-stream")

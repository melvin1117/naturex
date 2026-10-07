"""World-scoped live event bus and SSE endpoints (T29)."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session, col, select
from starlette.requests import Request
from starlette.types import Message, Scope

from app import events
from app.config import get_settings
from app.db import engine, get_session
from app.main import app
from app.models import World, WorldEvent
from app.sandbox import COOKIE_NAME, create_world, prune_stale_worlds
from app.seed import seed
from tests.conftest import alembic_cfg, requires_db


@pytest.fixture
def session() -> Iterator[Session]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    @contextmanager
    def same_session_scope() -> Iterator[Session]:
        yield session

    app.dependency_overrides[get_session] = lambda: session
    monkeypatch.setattr(events, "session_scope", same_session_scope)
    yield TestClient(app)
    app.dependency_overrides.clear()


def set_world_cookie(client: TestClient, world_id: UUID) -> None:
    client.cookies.set(COOKIE_NAME, str(world_id))


def migrate() -> None:
    command.upgrade(alembic_cfg(), "head")


@requires_db
def test_publish_replay_orders_events_and_honors_since_cursor(session: Session) -> None:
    world = create_world(session)
    first = events.publish(session, world.id, "rating_progress", {"step": "earth_obs"})
    second = events.publish(
        session, world.id, "price_tick", {"asset_id": "asset-1", "price": "7.92"}
    )
    session.flush()

    replayed = events.replay(session, world.id)
    assert [event.id for event in replayed] == [first.id, second.id]
    assert [event.type for event in replayed] == ["rating_progress", "price_tick"]
    assert [event.id for event in events.replay(session, world.id, since_id=first.id)] == [
        second.id
    ]


@requires_db
def test_replay_is_scoped_to_one_world(session: Session) -> None:
    mine, other = create_world(session), create_world(session)
    own_event = events.publish(session, mine.id, "alert", {"message": "mine"})
    events.publish(session, other.id, "alert", {"message": "not mine"})
    session.flush()

    assert [event.id for event in events.replay(session, mine.id)] == [own_event.id]


@requires_db
def test_publish_accepts_a_transaction_connection(session: Session) -> None:
    world = create_world(session)

    event = events.publish(session.connection(), world.id, "alert", {"message": "via connection"})

    assert event.id is not None
    assert [replayed.payload for replayed in events.replay(session, world.id)] == [
        {"message": "via connection"}
    ]


@requires_db
def test_same_world_publish_ids_follow_commit_order() -> None:
    migrate()
    with Session(engine) as setup:
        seed(setup)
        world = create_world(setup)
        world_id = world.id

    tx_a = engine.connect()
    trans_a = tx_a.begin()
    tx_b_done = threading.Event()
    tx_b_ids: list[int | None] = []
    try:
        event_a = events.publish(tx_a, world_id, "alert", {"message": "a"})

        def publish_b() -> None:
            with engine.begin() as tx_b:
                tx_b_ids.append(events.publish(tx_b, world_id, "alert", {"message": "b"}).id)
            tx_b_done.set()

        thread = threading.Thread(target=publish_b)
        thread.start()
        time.sleep(0.2)
        assert not tx_b_done.is_set(), "same-world publisher B waits for publisher A to commit"

        with Session(engine) as reader:
            assert events.replay(reader, world_id) == []

        trans_a.commit()
        thread.join(timeout=2)
        assert tx_b_done.is_set(), "publisher B completed after A committed"

        with Session(engine) as reader:
            replayed = events.replay(reader, world_id)
            assert [event.id for event in replayed] == [event_a.id, tx_b_ids[0]]
            assert [event.payload["message"] for event in replayed] == ["a", "b"]
    finally:
        if trans_a.is_active:
            trans_a.rollback()
        tx_a.close()


@requires_db
def test_polling_endpoint_requires_an_existing_world_cookie(client: TestClient) -> None:
    res = client.get("/events")

    assert (res.status_code, res.json()["detail"]) == (401, "world_required")


@requires_db
def test_polling_endpoint_returns_world_events_after_since_id(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    first = events.publish(session, world.id, "rating_progress", {"step": "earth_obs"})
    second = events.publish(session, world.id, "alert", {"message": "Watchlist changed"})
    session.flush()
    set_world_cookie(client, world.id)

    res = client.get("/events", params={"since_id": first.id})

    assert res.status_code == 200
    body = res.json()
    assert [event["id"] for event in body] == [second.id]
    assert body[0]["type"] == "alert"


@requires_db
def test_polling_endpoint_keeps_since_datetime_backward_compatible(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    event = events.publish(session, world.id, "rating_progress", {"step": "done"})
    session.flush()
    set_world_cookie(client, world.id)

    future = datetime.now(UTC) + timedelta(seconds=1)
    res = client.get("/events", params={"since": future.isoformat()})

    assert res.status_code == 200
    assert res.json() == []
    assert events.replay(session, world.id, since_id=event.id) == []


@requires_db
def test_sse_stream_replays_from_last_event_id(
    session: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = create_world(session)
    first = events.publish(session, world.id, "rating_progress", {"step": "earth_obs"})
    second = events.publish(session, world.id, "price_tick", {"price": "8.00"})
    session.flush()
    set_world_cookie(client, world.id)
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 0.03)
    monkeypatch.setattr(events, "STREAM_POLL_INTERVAL_SECONDS", 0.01)

    res = client.get("/events/stream", headers={"Last-Event-ID": str(first.id)})

    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-cache, no-transform"
    assert res.headers["x-accel-buffering"] == "no"
    assert "retry:" in res.text
    assert f"id: {second.id}" in res.text
    assert "event: price_tick" in res.text
    assert f"id: {first.id}" not in res.text


@requires_db
def test_sse_stream_emits_heartbeats_when_idle(
    session: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = create_world(session)
    set_world_cookie(client, world.id)
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 0.03)
    monkeypatch.setattr(events, "STREAM_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(events, "HEARTBEAT_INTERVAL_SECONDS", 0.0)

    res = client.get("/events/stream")

    assert res.status_code == 200
    assert "event: heartbeat" in res.text


@requires_db
def test_sse_stream_releases_request_db_connection_between_polls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migrate()
    app.dependency_overrides.clear()
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 0.5)
    monkeypatch.setattr(events, "STREAM_POLL_INTERVAL_SECONDS", 0.1)
    monkeypatch.setattr(events, "HEARTBEAT_INTERVAL_SECONDS", 10.0)
    client = TestClient(app)
    assert client.get("/world").status_code == 200
    assert engine.pool.checkedout() == 0

    with client.stream("GET", "/events/stream") as res:
        assert res.status_code == 200
        assert next(res.iter_lines()) == "retry: 3000"
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and engine.pool.checkedout() != 0:
            time.sleep(0.01)
        assert engine.pool.checkedout() == 0


async def test_event_stream_response_releases_slot_when_response_fails_before_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    max_concurrent = 2
    assert events.stream_slots_available(max_concurrent) == max_concurrent

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        _ = message

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/events/stream",
        "raw_path": b"/events/stream",
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1),
        "server": ("testserver", 80),
    }
    response = events.EventStreamResponse(uuid4(), Request(scope, receive), None, max_concurrent)

    async def fail_before_body(
        self: StreamingResponse, scope: Scope, receive: object, send: object
    ) -> None:
        _ = (self, scope, receive, send)
        raise RuntimeError("response failed before stream body")

    monkeypatch.setattr(StreamingResponse, "__call__", fail_before_body)

    with pytest.raises(RuntimeError, match="before stream body"):
        await response(scope, receive, send)

    assert events.stream_slots_available(max_concurrent) == max_concurrent


@requires_db
def test_sse_stream_never_replays_another_worlds_event_after_last_event_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    migrate()
    app.dependency_overrides.clear()
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 0.03)
    monkeypatch.setattr(events, "STREAM_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(events, "HEARTBEAT_INTERVAL_SECONDS", 0.0)
    mine = TestClient(app)
    other = TestClient(app)
    mine_world = UUID(mine.get("/world").json()["id"])
    other_world = UUID(other.get("/world").json()["id"])

    with Session(engine) as session:
        own_event = events.publish(session, mine_world, "alert", {"message": "mine"})
        other_event = events.publish(session, other_world, "alert", {"message": "not mine"})
        session.commit()

    res = mine.get("/events/stream", headers={"Last-Event-ID": str(other_event.id - 1)})

    assert res.status_code == 200
    assert "not mine" not in res.text
    assert f"id: {other_event.id}" not in res.text
    assert f"id: {own_event.id}" not in res.text


@requires_db
def test_stale_world_prune_deletes_its_persisted_stream_events(session: Session) -> None:
    world = create_world(session)
    world_id = world.id
    events.publish(session, world.id, "alert", {"message": "stale"})
    world.last_seen_at = datetime.now(UTC) - timedelta(days=30)
    session.add(world)
    session.commit()

    assert prune_stale_worlds(session, older_than=timedelta(days=7)) == 1

    assert session.get(World, world_id) is None
    assert session.exec(select(WorldEvent).where(col(WorldEvent.world_id) == world_id)).all() == []

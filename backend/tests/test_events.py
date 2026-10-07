"""World-scoped live event bus and SSE endpoints (T29)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session, col, select

from app import events
from app.config import get_settings
from app.db import get_session
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
    assert res.headers["cache-control"] == "no-cache"
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

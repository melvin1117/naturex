"""Explicit sandbox and session fixtures for API tests (T73).

The world comes from the session: without one a request reads the live world. Tests that need
a private sandbox create one plus a DEMO session for a persona in it, standing in for T55's
`POST /demo/start`.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete
from sqlmodel import Session, col, select

from app.auth import SESSION_COOKIE, Principal, start_session
from app.authz import Actor
from app.config import Settings
from app.models import SessionKind, User, UserKind, World
from app.routers.admin import TimeMachineEnv
from app.sandbox import _delete_world_rows, create_world
from app.services.rating_runs import InlineExecutor, RatingRunner, news_runner


def start_demo(
    client: TestClient,
    session: Session,
    world: World | None = None,
    persona_key: str = "arjun",
) -> World:
    """Sign `client` in to a demo session for `persona_key` in `world` (a new sandbox if None).

    Returns the sandbox world. `arjun` is the demo investor persona.
    """
    world = world or create_world(session)
    world_id = world.id
    user = session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == persona_key)
    ).one()
    client.cookies.set(SESSION_COOKIE, start_session(session, user, SessionKind.DEMO))
    found = session.get(World, world_id)
    assert found is not None
    return found


def drop_worlds(engine: Engine, world_ids: Iterable[UUID]) -> None:
    """Delete committed sandboxes with every row they own, their sessions included, so tests
    that commit through `Session(engine)` leave the shared test database as they found it."""
    with Session(engine) as session:
        for world_id in world_ids:
            _delete_world_rows(session, world_id, keep_world=False)
            session.execute(delete(World).where(col(World.id) == world_id))
        session.commit()


def sign_in(client: TestClient, session: Session, user: User) -> None:
    """Sign `client` in as `user` with a password-kind session (no password check)."""
    client.cookies.set(SESSION_COOKIE, start_session(session, user, SessionKind.PASSWORD))


def stub_sandbox() -> World:
    """A demo sandbox world for DB-free tests of stub routes (override `current_world`)."""
    return World(id=uuid4(), label="visitor")


def stub_principal() -> Principal:
    """A signed-in principal for DB-free tests of stub routes (override `current_principal`)."""
    return Principal(
        user_id=uuid4(),
        world_id=uuid4(),
        session_id=uuid4(),
        session_kind=SessionKind.PASSWORD,
        user_kind=UserKind.PERSON,
        is_admin=False,
    )


def stub_actor(world: World, *, is_admin: bool = False) -> Actor:
    """A demo-session actor in `world` for DB-free tests of stub routes (override
    `authz.optional_actor`)."""
    return Actor(
        user_id=uuid4(),
        world_id=world.id,
        user_kind=UserKind.PERSONA,
        is_admin=is_admin,
        session_kind=SessionKind.DEMO,
    )


def mock_time_machine_env(session: Session) -> TimeMachineEnv:
    """The Time Machine (T38) on the test session's connection: T27's runner in mock mode
    (fixed pipeline, no model), run inline, with no LLM spend; override `get_time_machine_env`."""
    conn = session.connection()

    def sessions() -> Session:
        return Session(bind=conn, join_transaction_mode="create_savepoint")

    cfg = Settings(_env_file=None, use_mocks=True)
    runner = RatingRunner(
        session_factory=sessions,
        settings=cfg,
        executor=InlineExecutor(),
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: date(2026, 10, 7),
    )
    return TimeMachineEnv(session_factory=sessions, runner=runner, spend=lambda: Decimal(0))

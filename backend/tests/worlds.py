"""Explicit sandbox and session fixtures for API tests (T73).

The world comes from the session: without one a request reads the live world. Tests that need
a private sandbox create one plus a DEMO session for a persona in it, standing in for T55's
`POST /demo/start`.
"""

from __future__ import annotations

from uuid import uuid4

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.auth import SESSION_COOKIE, Principal, start_session
from app.models import SessionKind, User, UserKind, World
from app.sandbox import create_world


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


def sign_in(client: TestClient, session: Session, user: User) -> None:
    """Sign `client` in as `user` with a password-kind session (no password check)."""
    client.cookies.set(SESSION_COOKIE, start_session(session, user, SessionKind.PASSWORD))


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

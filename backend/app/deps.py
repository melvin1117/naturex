"""FastAPI dependencies shared by routers: DB session, settings, the request's world and the
signed-in principal.

The world always comes from the session, never from a client value (ADR-0005 §2, T73):
anonymous requests and password sessions use the live world, and a demo session uses its own
sandbox world. Anonymous requests are read-only.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlmodel import Session

from app.auth import SESSION_COOKIE, Principal, prune_auth_data, resolve_session
from app.config import Settings, get_settings
from app.db import get_session
from app.middleware import SAFE_METHODS
from app.models import SessionKind, World
from app.sandbox import ensure_live_world, is_sandbox, prune_stale_worlds
from app.seed import LIVE_WORLD_ID

log = logging.getLogger(__name__)

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Avoid a write on every request; last_seen_at only needs to be roughly right for pruning.
TOUCH_EVERY = timedelta(minutes=5)
PRUNE_EVERY = timedelta(minutes=10)
AUTH_REQUIRED = "auth_required"
_last_prune: datetime | None = None
_last_auth_prune: datetime | None = None


def prune_stale_worlds_now_and_then(session: Session) -> None:
    """Prune stale sandbox worlds at most every PRUNE_EVERY per process; never fail the request.

    Never touches the template or the live world (`prune_stale_worlds`).
    """
    global _last_prune
    now = datetime.now(UTC)
    if _last_prune is not None and now - _last_prune < PRUNE_EVERY:
        return
    _last_prune = now
    try:
        prune_stale_worlds(session)
    except Exception:
        session.rollback()
        log.exception("pruning stale sandbox worlds failed")


def prune_auth_data_now_and_then(session: Session) -> None:
    """Prune expired sessions and day-old auth attempts at most every PRUNE_EVERY per process.

    Never fails the request (T66).
    """
    global _last_auth_prune
    now = datetime.now(UTC)
    if _last_auth_prune is not None and now - _last_auth_prune < PRUNE_EVERY:
        return
    _last_auth_prune = now
    try:
        prune_auth_data(session)
    except Exception:
        session.rollback()
        log.exception("pruning expired sessions and auth attempts failed")


def _touch(session: Session, world: World) -> None:
    """Keep a demo sandbox from being pruned while it's in use."""
    if datetime.now(UTC) - world.last_seen_at > TOUCH_EVERY:
        world.last_seen_at = datetime.now(UTC)
        session.add(world)
        session.commit()


def optional_principal(request: Request, session: SessionDep) -> Principal | None:
    """The signed-in principal from the `nx_session` cookie, or None (ADR-0005 §1).

    Unknown, expired and revoked sessions all resolve to None; expired rows are deleted.
    """
    return resolve_session(session, request.cookies.get(SESSION_COOKIE))


def current_principal(
    principal: Annotated[Principal | None, Depends(optional_principal)],
) -> Principal:
    """The signed-in principal; 401 `auth_required` without a valid session."""
    if principal is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, AUTH_REQUIRED)
    return principal


OptionalPrincipal = Annotated[Principal | None, Depends(optional_principal)]
CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


def world_for(session: Session, principal: Principal | None) -> World:
    """The world a principal acts in (ADR-0005 §2): no session or a password session → the
    live world; a demo session → its own sandbox world.

    A session bound to any other world (e.g. a demo session on the live world) is refused with
    401 `auth_required` rather than served, so a sandbox is reachable only through its own demo
    session and the live world only through password sessions or none.
    """
    if principal is None:
        return ensure_live_world(session)
    world = session.get(World, principal.world_id)
    if principal.session_kind == SessionKind.DEMO:
        if world is not None and is_sandbox(world):
            _touch(session, world)
            return world
    elif world is not None and world.id == LIVE_WORLD_ID:
        return world
    log.warning("session %s is bound to an unexpected world; refused", principal.session_id)
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, AUTH_REQUIRED)


def current_world(
    request: Request, response: Response, session: SessionDep, principal: OptionalPrincipal
) -> World:
    """The request's world, from its session; never from a client value.

    Anonymous requests are read-only: any unsafe method (POST, PUT, PATCH, DELETE) on a route
    that uses this returns 401 `auth_required` without a session. Responses are `no-store`,
    since the same URL answers differently per session.
    """
    if principal is None and request.method not in SAFE_METHODS:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, AUTH_REQUIRED)
    world = world_for(session, principal)
    response.headers["Cache-Control"] = "no-store"
    return world


CurrentWorld = Annotated[World, Depends(current_world)]

"""FastAPI dependencies shared by routers: DB session, settings, the visitor's world and the
signed-in principal."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response, status
from sqlmodel import Session

from app.auth import SESSION_COOKIE, Principal, resolve_session
from app.config import Settings, get_settings, secure_cookies
from app.db import get_session
from app.models import World
from app.sandbox import (
    COOKIE_MAX_AGE_S,
    COOKIE_NAME,
    WorldLimitReached,
    create_world,
    prune_stale_worlds,
    world_from_cookie,
)

log = logging.getLogger(__name__)

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Avoid a write on every request; last_seen_at only needs to be roughly right for pruning.
TOUCH_EVERY = timedelta(minutes=5)
PRUNE_EVERY = timedelta(minutes=10)
WORLD_REQUIRED = "world_required"
AUTH_REQUIRED = "auth_required"
_last_prune: datetime | None = None


def _set_world_cookie(response: Response, world: World, settings: Settings) -> None:
    # SameSite=Lax needs the browser to see one site: the frontend proxies /api/* to this
    # backend (next.config.ts; T20). Don't switch to SameSite=None; browsers block it.
    response.set_cookie(
        COOKIE_NAME,
        str(world.id),
        max_age=COOKIE_MAX_AGE_S,
        httponly=True,
        samesite="lax",
        secure=secure_cookies(settings),
    )
    response.headers["Cache-Control"] = "no-store"


def _prune_now_and_then(session: Session) -> None:
    """Prune stale worlds at most every PRUNE_EVERY per process; never fail the request."""
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


def _touch(session: Session, world: World) -> None:
    if datetime.now(UTC) - world.last_seen_at > TOUCH_EVERY:
        world.last_seen_at = datetime.now(UTC)
        session.add(world)
        session.commit()


def visitor_world(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> World:
    """The visitor's world, created on the first visit. Only `GET /world` uses this."""
    world = world_from_cookie(session, request.cookies.get(COOKIE_NAME))
    if world is None:
        _prune_now_and_then(session)
        try:
            world = create_world(session, settings.sandbox_max_new_worlds_per_hour)
        except WorldLimitReached as exc:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "The demo is busy; try again in a few minutes",
                headers={"Retry-After": "300"},
            ) from exc
    else:
        _touch(session, world)
    _set_world_cookie(response, world, settings)
    return world


def current_world(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> World:
    """The visitor's existing world. Never creates one: 401 `world_required` without it.

    The frontend calls `GET /world` once before anything else, so errors on other routes
    can't silently create worlds whose cookie the browser never receives.
    """
    world = world_from_cookie(session, request.cookies.get(COOKIE_NAME))
    if world is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, WORLD_REQUIRED)
    _touch(session, world)
    _set_world_cookie(response, world, settings)
    return world


VisitorWorld = Annotated[World, Depends(visitor_world)]
CurrentWorld = Annotated[World, Depends(current_world)]


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

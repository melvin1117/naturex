"""FastAPI dependencies shared by routers: DB session, settings and the visitor's world."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, Request, Response
from sqlmodel import Session

from app.config import Settings, get_settings
from app.db import get_session
from app.models import World
from app.sandbox import (
    COOKIE_MAX_AGE_S,
    COOKIE_NAME,
    create_world,
    prune_stale_worlds,
    world_from_cookie,
)

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Avoid a write on every request; last_seen_at only needs to be roughly right for pruning.
TOUCH_EVERY = timedelta(minutes=5)


def current_world(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> World:
    """The visitor's sandbox world from the `nx_world` cookie, created on the first visit."""
    world = world_from_cookie(session, request.cookies.get(COOKIE_NAME))
    if world is None:
        prune_stale_worlds(session)
        world = create_world(session)
    elif datetime.now(UTC) - world.last_seen_at > TOUCH_EVERY:
        world.last_seen_at = datetime.now(UTC)
        session.add(world)
        session.commit()
    # SameSite=Lax assumes the browser sees one site: the frontend proxies /api/* to this
    # backend (T20). Don't switch to SameSite=None; browsers increasingly block it.
    response.set_cookie(
        COOKIE_NAME,
        str(world.id),
        max_age=COOKIE_MAX_AGE_S,
        httponly=True,
        samesite="lax",
        secure=settings.environment != "development",
    )
    return world


CurrentWorld = Annotated[World, Depends(current_world)]

"""No-sign-up demo sessions (T55, ADR-0005 §4): `POST /demo/start` and `POST /demo/persona`.

A judge gets a private sandbox (a copy of the template world with every persona) and a DEMO
session for one persona in it, with no account and no approval. They switch persona inside the
same sandbox; "Reset my demo" (`POST /world/reset`) restores it and keeps the session.

- **Bounded.** Each IP may start `RATE_LIMITS[DEMO_START]` sandboxes per hour, and
  `SANDBOX_MAX_NEW_WORLDS_PER_HOUR` bounds everyone together. A browser that already holds a demo
  session keeps its sandbox: starting again only switches persona. Model spend per sandbox is
  capped by `SANDBOX_LLM_BUDGET_USD`, under the global `LLM_BUDGET_USD`.
- **Separate from real accounts.** A demo session reaches only its own sandbox (`deps.world_for`);
  starting one replaces this browser's session cookie, and the session it replaces is ended.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlmodel import select

from app.auth import (
    SESSION_COOKIE,
    TOO_MANY_ATTEMPTS,
    AttemptsBusy,
    bucket_key,
    client_ip,
    consume_attempt,
    end_session,
    start_session,
)
from app.authz import Action, DenyReason, denied, require
from app.config import rate_limit_secret
from app.deps import (
    AUTH_REQUIRED,
    CurrentPrincipal,
    CurrentWorld,
    OptionalPrincipal,
    SessionDep,
    SettingsDep,
    prune_stale_worlds_now_and_then,
)
from app.models import AuthAttemptKind, AuthBucket, SessionKind, User, World
from app.routers.auth import AUTH_BUSY, _AuthRoute, _no_store, _set_session_cookie
from app.routers.world import world_out
from app.sandbox import WorldLimitReached, create_world, is_sandbox
from app.schemas import DemoPersonaIn, DemoStartIn, WorldOut

router = APIRouter(prefix="/demo", tags=["demo"], route_class=_AuthRoute)

DEMO_BUSY = "demo_busy"
"""Every new sandbox for this hour is taken; retry later (`Retry-After`)."""
PERSONA_NOT_FOUND = "persona_not_found"


def _persona(session: SessionDep, world: World, key: str) -> User:
    user = session.exec(
        select(User).where(User.world_id == world.id, User.persona_key == key)
    ).first()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, PERSONA_NOT_FOUND)
    return user


def _act_as(
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    world: World,
    user: User,
) -> WorldOut:
    """End this browser's session and start a DEMO session for `user`."""
    end_session(session, request.cookies.get(SESSION_COOKIE))
    _set_session_cookie(response, start_session(session, user, SessionKind.DEMO), settings)
    _no_store(response)
    return world_out(session, settings, world, user)


def _throttle(request: Request, session: SessionDep, settings: SettingsDep) -> None:
    ip = client_ip(
        request.headers.getlist("x-forwarded-for"),
        request.client.host if request.client else None,
        settings.trusted_proxy_hops,
    )
    key = bucket_key(rate_limit_secret(settings), AuthBucket.IP, ip)
    try:
        retry_after = consume_attempt(session, AuthAttemptKind.DEMO_START, [(AuthBucket.IP, key)])
    except AttemptsBusy:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            AUTH_BUSY,
            headers={"Retry-After": "1", "Cache-Control": "no-store"},
        ) from None
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            TOO_MANY_ATTEMPTS,
            headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
        )


@router.post(
    "/start",
    response_model=WorldOut,
    responses={
        404: {"description": f"`{PERSONA_NOT_FOUND}`: the sandbox has no such persona"},
        429: {
            "description": f"`{TOO_MANY_ATTEMPTS}`: this IP started too many sandboxes, or "
            f"`{DEMO_BUSY}`: every new sandbox for this hour is taken (see `Retry-After`)"
        },
    },
)
def start_demo(
    body: DemoStartIn,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    principal: OptionalPrincipal,
) -> WorldOut:
    """Start a demo: a private sandbox and a session as `persona`, with no sign-up.

    A browser that already has a demo session keeps its sandbox and only switches to `persona`,
    so returning to the story never loses what the judge did. Otherwise a new sandbox is made
    from the template; any other session this browser held (a real account's) is ended here.
    """
    if principal is not None and principal.session_kind is SessionKind.DEMO:
        world = session.get(World, principal.world_id)
        if world is not None and is_sandbox(world):
            return _act_as(
                request, response, session, settings, world, _persona(session, world, body.persona)
            )
    _throttle(request, session, settings)
    prune_stale_worlds_now_and_then(session)
    try:
        world = create_world(session, max_new_per_hour=settings.sandbox_max_new_worlds_per_hour)
    except WorldLimitReached:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            DEMO_BUSY,
            headers={"Retry-After": "600", "Cache-Control": "no-store"},
        ) from None
    return _act_as(
        request, response, session, settings, world, _persona(session, world, body.persona)
    )


@router.post(
    "/persona",
    response_model=WorldOut,
    dependencies=[require(Action.CONTROL_DEMO)],
    responses={
        401: {"description": f"`{AUTH_REQUIRED}`: no session"},
        404: {"description": f"`{PERSONA_NOT_FOUND}`: the sandbox has no such persona"},
        **denied(DenyReason.DEMO_SESSION_ONLY),
    },
)
def switch_persona(
    body: DemoPersonaIn,
    request: Request,
    response: Response,
    world: CurrentWorld,
    principal: CurrentPrincipal,
    session: SessionDep,
    settings: SettingsDep,
) -> WorldOut:
    """Act as another persona in the same sandbox: the old session ends and a new one starts.

    Demo sessions only (403 `demo_session_only` for a real account, which has one identity).
    """
    return _act_as(
        request, response, session, settings, world, _persona(session, world, body.persona)
    )

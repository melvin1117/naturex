"""Accounts and sessions (ADR-0005 §1, T54): register, login, logout and `GET /me`.

Password accounts live in the live world. CSRF and rate limits arrive with T66.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy.exc import SQLAlchemyError

from app.auth import (
    ABSOLUTE_TIMEOUT,
    EMAIL_UNAVAILABLE,
    LOGIN_FAILED,
    SESSION_COOKIE,
    EmailTaken,
    authenticate,
    end_session,
    register_person,
    start_session,
)
from app.config import secure_cookies
from app.deps import AUTH_REQUIRED, CurrentPrincipal, SessionDep, SettingsDep
from app.models import User
from app.sandbox import ensure_live_world
from app.schemas import LoginIn, MeOut, RegisterIn

log = logging.getLogger(__name__)
INTERNAL_ERROR = "internal_error"


class _AuthRoute(APIRoute):
    """Any unexpected database error becomes a bare 500.

    Only the exception type is logged: driver messages can quote the email (e.g. a unique
    violation's DETAIL), and nothing personal or secret may reach the logs.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except SQLAlchemyError as exc:
                log.error("database error on %s: %s", request.url.path, type(exc).__name__)
                return JSONResponse(
                    {"detail": INTERNAL_ERROR},
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    headers={"Cache-Control": "no-store"},
                )

        return guarded


router = APIRouter(tags=["auth"], route_class=_AuthRoute)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _set_session_cookie(response: Response, token: str, settings: SettingsDep) -> None:
    # Same first-party proxy reasoning as the nx_world cookie (deps._set_world_cookie).
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(ABSOLUTE_TIMEOUT.total_seconds()),
        path="/",
        httponly=True,
        samesite="lax",
        secure=secure_cookies(settings),
    )


def _clear_session_cookie(response: Response, settings: SettingsDep) -> None:
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        samesite="lax",
        secure=secure_cookies(settings),
    )


def _sign_in(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep, user: User
) -> MeOut:
    """Issue a fresh session; the one this browser presented (if any) is revoked."""
    end_session(session, request.cookies.get(SESSION_COOKIE))
    _set_session_cookie(response, start_session(session, user), settings)
    _no_store(response)
    return MeOut.model_validate(user)


@router.post(
    "/auth/register",
    response_model=MeOut,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"description": EMAIL_UNAVAILABLE}},
)
def register(
    body: RegisterIn,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
) -> MeOut:
    """Create a password account in the live world and sign in.

    A taken email returns a generic 409; without email verification that reveals the email
    exists, a risk ADR-0005 accepts. No permission depends on the email.
    """
    live = ensure_live_world(session)
    try:
        user = register_person(
            session, live.id, body.email, body.password.get_secret_value(), body.name
        )
    except EmailTaken:
        raise HTTPException(status.HTTP_409_CONFLICT, EMAIL_UNAVAILABLE) from None
    return _sign_in(request, response, session, settings, user)


@router.post(
    "/auth/login",
    response_model=MeOut,
    responses={401: {"description": LOGIN_FAILED}},
)
def login(
    body: LoginIn,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
) -> MeOut:
    """Sign in with email and password. Every failure is the same generic 401."""
    live = ensure_live_world(session)
    user = authenticate(session, live.id, body.email, body.password.get_secret_value())
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)
    return _sign_in(request, response, session, settings, user)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, session: SessionDep, settings: SettingsDep) -> Response:
    """End this session now: the row is deleted and the cookie cleared. Always succeeds."""
    end_session(session, request.cookies.get(SESSION_COOKIE))
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_session_cookie(response, settings)
    _no_store(response)
    return response


@router.get(
    "/me",
    response_model=MeOut,
    responses={401: {"description": AUTH_REQUIRED}},
)
def me(principal: CurrentPrincipal, response: Response, session: SessionDep) -> MeOut:
    """The signed-in account."""
    user = session.get(User, principal.user_id)
    if user is None:  # deleted between resolving the session and now
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, AUTH_REQUIRED)
    _no_store(response)
    return MeOut.model_validate(user)

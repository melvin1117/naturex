"""Accounts and sessions (ADR-0005 section 1, T54, T66): register, login, logout and `GET /me`.

Password accounts live in the live world. Register and login are rate limited per IP and per
account; CSRF is checked for every unsafe method in `app.middleware`.
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
    TOO_MANY_ATTEMPTS,
    AttemptsBusy,
    EmailTaken,
    authenticate,
    bucket_key,
    client_ip,
    consume_attempt,
    end_session,
    normalize_email,
    register_person,
    start_session,
)
from app.authz import Action, require
from app.config import rate_limit_secret, secure_cookies
from app.deps import (
    AUTH_REQUIRED,
    CurrentPrincipal,
    SessionDep,
    SettingsDep,
    prune_auth_data_now_and_then,
    prune_stale_worlds_now_and_then,
)
from app.models import AuthAttemptKind, AuthBucket, User
from app.sandbox import ensure_live_world
from app.schemas import LoginIn, MeOut, RegisterIn

log = logging.getLogger(__name__)
INTERNAL_ERROR = "internal_error"
AUTH_BUSY = "auth_busy"


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


def _throttle(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    kind: AuthAttemptKind,
    email: str,
) -> None:
    """429 when this IP or this account has used up its attempts (ADR-0005 section 1).

    Counted before any password work, and keyed on the submitted email whether or not an account
    exists, so the response never says which emails are registered.
    """
    prune_auth_data_now_and_then(session)
    prune_stale_worlds_now_and_then(session)
    secret = rate_limit_secret(settings)
    ip = client_ip(
        request.headers.getlist("x-forwarded-for"),
        request.client.host if request.client else None,
        settings.trusted_proxy_hops,
    )
    ip_key = bucket_key(secret, AuthBucket.IP, ip)
    account_key = bucket_key(secret, AuthBucket.ACCOUNT, normalize_email(email))
    try:
        retry_after = consume_attempt(
            session, kind, [(AuthBucket.IP, ip_key), (AuthBucket.ACCOUNT, account_key)]
        )
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


def _set_session_cookie(response: Response, token: str, settings: SettingsDep) -> None:
    # SameSite=Lax needs the browser to see one site: the frontend proxies /api/* to this
    # backend (next.config.ts; T20). Don't switch to SameSite=None; browsers block it.
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
    _throttle(request, session, settings, AuthAttemptKind.REGISTER, body.email)
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
    _throttle(request, session, settings, AuthAttemptKind.LOGIN, body.email)
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
    dependencies=[require(Action.USE_OWN_ACCOUNT)],
)
def me(principal: CurrentPrincipal, response: Response, session: SessionDep) -> MeOut:
    """The signed-in account."""
    user = session.get(User, principal.user_id)
    if user is None:  # deleted between resolving the session and now
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, AUTH_REQUIRED)
    _no_store(response)
    return MeOut.model_validate(user)

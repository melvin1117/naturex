"""The request's world (dev-spec §6, ADR-0005 §2): GET /world, POST /world/reset.

The world comes from the session (T73): the live world for anonymous requests and password
sessions, a private sandbox for a demo session.
"""

from __future__ import annotations

from fastapi import APIRouter
from sqlmodel import Session

from app.auth import Principal
from app.authz import Action, DenyReason, denied, require
from app.config import Settings
from app.deps import (
    AUTH_REQUIRED,
    CurrentPrincipal,
    CurrentWorld,
    OptionalPrincipal,
    SessionDep,
    SettingsDep,
)
from app.models import User, World
from app.sandbox import reset_world, world_contents
from app.schemas import MeOut, PersonaOut, WorldAssetOut, WorldOut
from app.services.document_check import upload_ai_check

router = APIRouter(prefix="/world", tags=["world"])


def _world_out(
    session: SessionDep, settings: SettingsDep, world: World, principal: Principal | None
) -> WorldOut:
    user = session.get(User, principal.user_id) if principal is not None else None
    return world_out(session, settings, world, user)


def world_out(session: Session, settings: Settings, world: World, user: User | None) -> WorldOut:
    """`GET /world`'s body for `world` as seen by `user` (None: anonymous)."""
    personas, assets = world_contents(session, world.id)
    return WorldOut(
        id=world.id,
        label=world.label,
        created_at=world.created_at,
        personas=[PersonaOut.model_validate(p) for p in personas],
        assets=[WorldAssetOut.model_validate(a) for a in assets],
        me=MeOut.model_validate(user) if user is not None else None,
        document_ai_check=upload_ai_check(settings, world.id),
    )


@router.get("", response_model=WorldOut, dependencies=[require(Action.BROWSE)])
def get_world(
    world: CurrentWorld, principal: OptionalPrincipal, session: SessionDep, settings: SettingsDep
) -> WorldOut:
    """The session's world: the live world when anonymous or signed in with a password, the
    demo sandbox for a demo session. `me` is the signed-in account, or null.
    `document_ai_check` says whether a verification upload may be read by an AI model here."""
    return _world_out(session, settings, world, principal)


@router.post(
    "/reset",
    response_model=WorldOut,
    dependencies=[require(Action.CONTROL_DEMO)],
    responses={
        401: {"description": f"`{AUTH_REQUIRED}`: sign in first"},
        **denied(DenyReason.DEMO_SESSION_ONLY),
    },
)
def reset(
    world: CurrentWorld, principal: CurrentPrincipal, session: SessionDep, settings: SettingsDep
) -> WorldOut:
    """ "Reset my demo": restore the demo session's sandbox to the template, keeping its ID.

    The live world is never reset: any other session gets 403 `demo_session_only`
    (`Action.CONTROL_DEMO`).
    """
    return _world_out(session, settings, reset_world(session, world.id), principal)

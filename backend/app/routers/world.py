"""The request's world (dev-spec §6, ADR-0005 §2): GET /world, POST /world/reset.

The world comes from the session (T73): the live world for anonymous requests and password
sessions, a private sandbox for a demo session.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.auth import Principal
from app.deps import (
    AUTH_REQUIRED,
    CurrentPrincipal,
    CurrentWorld,
    OptionalPrincipal,
    SessionDep,
    prune_stale_worlds_now_and_then,
)
from app.models import SessionKind, User, World
from app.sandbox import reset_world, world_contents
from app.schemas import MeOut, PersonaOut, WorldAssetOut, WorldOut

router = APIRouter(prefix="/world", tags=["world"])
DEMO_ONLY = "demo_only"


def _world_out(session: SessionDep, world: World, principal: Principal | None) -> WorldOut:
    personas, assets = world_contents(session, world.id)
    user = session.get(User, principal.user_id) if principal is not None else None
    return WorldOut(
        id=world.id,
        label=world.label,
        created_at=world.created_at,
        personas=[PersonaOut.model_validate(p) for p in personas],
        assets=[WorldAssetOut.model_validate(a) for a in assets],
        me=MeOut.model_validate(user) if user is not None else None,
    )


@router.get("", response_model=WorldOut)
def get_world(world: CurrentWorld, principal: OptionalPrincipal, session: SessionDep) -> WorldOut:
    """The session's world: the live world when anonymous or signed in with a password, the
    demo sandbox for a demo session. `me` is the signed-in account, or null."""
    out = _world_out(session, world, principal)
    prune_stale_worlds_now_and_then(session)
    return out


@router.post(
    "/reset",
    response_model=WorldOut,
    responses={
        401: {"description": AUTH_REQUIRED},
        403: {"description": f"`{DEMO_ONLY}`: only a demo session can reset its sandbox"},
    },
)
def reset(world: CurrentWorld, principal: CurrentPrincipal, session: SessionDep) -> WorldOut:
    """ "Reset my demo": restore the demo session's sandbox to the template, keeping its ID.

    The live world is never reset: any other session gets 403 `demo_only`.
    """
    if principal.session_kind != SessionKind.DEMO:
        raise HTTPException(status.HTTP_403_FORBIDDEN, DEMO_ONLY)
    return _world_out(session, reset_world(session, world.id), principal)

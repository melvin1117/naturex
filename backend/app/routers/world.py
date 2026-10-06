"""The visitor's sandbox world (dev-spec §6, demo-plan §3.5): GET /world, POST /world/reset."""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import CurrentWorld, SessionDep, VisitorWorld
from app.models import World
from app.sandbox import reset_world, world_contents
from app.schemas import PersonaOut, WorldAssetOut, WorldOut

router = APIRouter(prefix="/world", tags=["world"])


def _world_out(session: SessionDep, world: World) -> WorldOut:
    personas, assets = world_contents(session, world.id)
    return WorldOut(
        id=world.id,
        label=world.label,
        created_at=world.created_at,
        personas=[PersonaOut.model_validate(p) for p in personas],
        assets=[WorldAssetOut.model_validate(a) for a in assets],
    )


@router.get(
    "",
    response_model=WorldOut,
    responses={503: {"description": "Too many new demo worlds; retry later"}},
)
def get_world(world: VisitorWorld, session: SessionDep) -> WorldOut:
    """The visitor's world. The first call creates it and sets the `nx_world` cookie.

    Call this once before any other route; they return 401 `world_required` without it.
    """
    return _world_out(session, world)


@router.post(
    "/reset",
    response_model=WorldOut,
    responses={401: {"description": "No world yet: call GET /world first"}},
)
def reset(world: CurrentWorld, session: SessionDep) -> WorldOut:
    """ "Reset my demo": restore the visitor's world to the template, keeping its ID."""
    return _world_out(session, reset_world(session, world.id))

"""The visitor's sandbox world (dev-spec §6, demo-plan §3.5): GET /world, POST /world/reset."""

from __future__ import annotations

from fastapi import APIRouter
from sqlmodel import col, select

from app.deps import CurrentWorld, SessionDep
from app.models import Asset, User, World
from app.sandbox import reset_world
from app.schemas import PersonaOut, WorldAssetOut, WorldOut

router = APIRouter(prefix="/world", tags=["world"])


def _world_out(session: SessionDep, world: World) -> WorldOut:
    personas = session.exec(
        select(User).where(User.world_id == world.id).order_by(col(User.persona_key))
    ).all()
    assets = session.exec(
        select(Asset).where(Asset.world_id == world.id).order_by(col(Asset.site_key))
    ).all()
    return WorldOut(
        id=world.id,
        label=world.label,
        created_at=world.created_at,
        personas=[PersonaOut.model_validate(p) for p in personas],
        assets=[WorldAssetOut.model_validate(a) for a in assets],
    )


@router.get("", response_model=WorldOut)
def get_world(world: CurrentWorld, session: SessionDep) -> WorldOut:
    """The visitor's world; the first request creates it and sets the `nx_world` cookie."""
    return _world_out(session, world)


@router.post("/reset", response_model=WorldOut)
def reset(world: CurrentWorld, session: SessionDep) -> WorldOut:
    """ "Reset my demo": restore the visitor's world to the template, keeping its ID."""
    return _world_out(session, reset_world(session, world.id))

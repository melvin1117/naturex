"""Nature Ledger endpoints (dev-spec §6, §17)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlmodel import Session

from app.authz import (
    Action,
    Actor,
    DemoTarget,
    DenyReason,
    OptionalActor,
    acting_world,
    asset_ref,
    asset_ref_in,
    demo_target,
    denied,
    require,
)
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.ledger import VerifyResult, entries_for, tamper, verify
from app.models import Asset, World
from app.schemas import LedgerEntryOut, LedgerVerifyOut, TamperDemoIn, TamperDemoOut
from app.services.listings import visible_to

router = APIRouter(tags=["ledger"])
BROWSE_ASSET = require(Action.BROWSE, asset_ref)


def _verify_out(result: VerifyResult) -> LedgerVerifyOut:
    return LedgerVerifyOut(
        valid=result.valid, entries=result.entries, head=result.head, broken_at=result.broken_at
    )


def _require_asset(
    session: Session, world: World, asset_id: UUID, actor: Actor | None = None
) -> None:
    """404 unless the asset exists in the visitor's own world and is public, or the actor's
    community's listing (T58)."""
    asset = session.get(Asset, asset_id)
    if asset is None or asset.world_id != world.id or not visible_to(actor, asset):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")


@router.get("/ledger/{asset_id}", response_model=list[LedgerEntryOut], dependencies=[BROWSE_ASSET])
def list_ledger(
    asset_id: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep
) -> list[LedgerEntryOut]:
    _require_asset(session, world, asset_id, actor)
    return [LedgerEntryOut.model_validate(e) for e in entries_for(session, asset_id)]


@router.get(
    "/ledger/{asset_id}/verify", response_model=LedgerVerifyOut, dependencies=[BROWSE_ASSET]
)
def verify_ledger(
    asset_id: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep
) -> LedgerVerifyOut:
    _require_asset(session, world, asset_id, actor)
    return _verify_out(verify(entries_for(session, asset_id)))


def tamper_target(
    body: TamperDemoIn, actor: OptionalActor, settings: SettingsDep, session: SessionDep
) -> DemoTarget | None:
    """The tamper demo's world, once its asset is found by `(world_id, id)` (None, a 404,
    otherwise). With `DEMO_MODE` off the asset isn't looked up: the policy hides the route."""
    target = demo_target(actor, settings)
    if not target.demo_mode:
        return target
    found = asset_ref_in(session, acting_world(actor), body.asset_id)
    return None if found is None else target


@router.post(
    "/admin/tamper-demo",
    response_model=TamperDemoOut,
    # The policy checks DEMO_MODE (404 when off), admin and sandbox (ADR-0005 §3).
    dependencies=[require(Action.TAMPER_DEMO, tamper_target)],
    responses=denied(DenyReason.ADMIN_ONLY, DenyReason.SANDBOX_ONLY),
)
def tamper_demo(body: TamperDemoIn, world: CurrentWorld, session: SessionDep) -> TamperDemoOut:
    """DEMO_MODE, admins and demo sandboxes only: edit a copy of one entry and show
    verification failing. Writes nothing."""
    entries = entries_for(session, body.asset_id)
    if not entries:
        raise HTTPException(status.HTTP_409_CONFLICT, "This asset has no ledger entries yet")
    seq = entries[-1].seq if body.seq is None else body.seq
    try:
        result = tamper(entries, seq)
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    return TamperDemoOut(
        seq=result.seq,
        field=result.field,
        before=result.before,
        after=result.after,
        verify=_verify_out(verify(result.entries)),
    )

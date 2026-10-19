"""Nature Ledger endpoints (dev-spec §6, §17)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from sqlmodel import Session

from app.deps import SANDBOX_ONLY, CurrentWorld, SessionDep, SettingsDep, require_sandbox
from app.ledger import VerifyResult, entries_for, tamper, verify
from app.models import Asset, World
from app.schemas import LedgerEntryOut, LedgerVerifyOut, TamperDemoIn, TamperDemoOut

router = APIRouter(tags=["ledger"])


def _verify_out(result: VerifyResult) -> LedgerVerifyOut:
    return LedgerVerifyOut(
        valid=result.valid, entries=result.entries, head=result.head, broken_at=result.broken_at
    )


def _require_asset(session: Session, world: World, asset_id: UUID) -> None:
    """404 unless the asset exists in the visitor's own world."""
    asset = session.get(Asset, asset_id)
    if asset is None or asset.world_id != world.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found")


@router.get("/ledger/{asset_id}", response_model=list[LedgerEntryOut])
def list_ledger(asset_id: UUID, world: CurrentWorld, session: SessionDep) -> list[LedgerEntryOut]:
    _require_asset(session, world, asset_id)
    return [LedgerEntryOut.model_validate(e) for e in entries_for(session, asset_id)]


@router.get("/ledger/{asset_id}/verify", response_model=LedgerVerifyOut)
def verify_ledger(asset_id: UUID, world: CurrentWorld, session: SessionDep) -> LedgerVerifyOut:
    _require_asset(session, world, asset_id)
    return _verify_out(verify(entries_for(session, asset_id)))


@router.post(
    "/admin/tamper-demo",
    response_model=TamperDemoOut,
    responses={403: {"description": f"`{SANDBOX_ONLY}`: never in the live world"}},
)
def tamper_demo(
    body: TamperDemoIn, settings: SettingsDep, world: CurrentWorld, session: SessionDep
) -> TamperDemoOut:
    """DEMO_MODE and demo sandboxes only: edit a copy of one entry and show verification
    failing. Writes nothing."""
    if not settings.demo_mode:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    require_sandbox(world)
    _require_asset(session, world, body.asset_id)
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

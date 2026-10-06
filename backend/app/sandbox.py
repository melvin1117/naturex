"""Per-visitor sandbox worlds (demo-plan §3.5, T31).

Every visitor gets a private copy of the template world, so judges never affect each other.
Copies get fresh IDs, and every reference between them (asset → community persona,
holdings, prices, reports, ledger entries…) is remapped to the copy. Ledger chains stay
valid because an entry's hash covers its payload, kind, seq and previous hash, not its IDs.

Callers own the transaction boundaries only through these functions; each one commits.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Column, delete, inspect, or_, text
from sqlmodel import Session, SQLModel, col, select

from app.models import (
    Alert,
    Asset,
    DocChunk,
    Event,
    Holding,
    LedgerEntry,
    LlmCall,
    Metrics,
    Order,
    Price,
    Report,
    User,
    World,
)
from app.seed import WORLD_ID as TEMPLATE_WORLD_ID
from app.seed import seed

COOKIE_NAME = "nx_world"
COOKIE_MAX_AGE_S = 30 * 24 * 3600
STALE_AFTER = timedelta(days=7)
VISITOR_LABEL = "visitor"


def _now() -> datetime:
    return datetime.now(UTC)


def _clone(row: SQLModel, exclude: set[str], **overrides: Any) -> dict[str, Any]:
    return {**row.model_dump(exclude=exclude), **overrides}


def _world_col(model: type[SQLModel]) -> Column[Any]:
    mapper = inspect(model)
    assert mapper is not None, f"{model.__name__} is not a mapped table"
    column: Column[Any] = mapper.columns["world_id"]
    return column


def _rows(session: Session, model: type[SQLModel], world_id: UUID) -> list[Any]:
    return list(session.exec(select(model).where(_world_col(model) == world_id)).all())


def _copy_world_rows(session: Session, source: UUID, target: UUID) -> None:
    """Copy every world-scoped row from `source` into `target`, remapping IDs.

    Inserts are flushed table by table in foreign-key order. Orders and LLM call logs are
    visitor activity, not template content, so they are not copied.
    """
    ids: dict[UUID, UUID] = {}

    def remap(old: UUID | None) -> UUID | None:
        return None if old is None else ids.get(old, old)

    def copy_with_new_id(model: type[SQLModel], *remapped: str) -> None:
        for row in _rows(session, model, source):
            clone: Any = model(
                **_clone(
                    row,
                    {"id", "world_id"},
                    world_id=target,
                    **{field: remap(getattr(row, field)) for field in remapped},
                )
            )
            ids[row.id] = clone.id
            session.add(clone)
        session.flush()

    copy_with_new_id(User)
    copy_with_new_id(Asset, "community_user_id")
    copy_with_new_id(Metrics, "asset_id")
    copy_with_new_id(Report, "asset_id", "metrics_id")
    copy_with_new_id(Event, "asset_id")
    copy_with_new_id(Alert, "asset_id")
    copy_with_new_id(DocChunk, "asset_id", "report_id")

    for price in _rows(session, Price, source):
        session.add(
            Price(**_clone(price, {"world_id"}, world_id=target, asset_id=remap(price.asset_id)))
        )
    for holding in _rows(session, Holding, source):
        session.add(
            Holding(
                **_clone(
                    holding,
                    {"world_id"},
                    world_id=target,
                    user_id=remap(holding.user_id),
                    asset_id=remap(holding.asset_id),
                )
            )
        )
    for entry in _rows(session, LedgerEntry, source):
        session.add(
            LedgerEntry(
                **_clone(
                    entry,
                    {"id", "world_id"},
                    world_id=target,
                    asset_id=remap(entry.asset_id),
                    ref_id=remap(entry.ref_id),
                )
            )
        )
    session.flush()


def _delete_world_rows(session: Session, world_id: UUID) -> None:
    """Delete every row a world owns, children first. Opts in to deleting ledger entries.

    `SET LOCAL` lasts until the current transaction ends, which is the caller's commit.
    """
    session.execute(text("SET LOCAL naturex.allow_ledger_delete = 'on'"))
    world_assets = select(Asset.id).where(Asset.world_id == world_id)
    session.execute(
        delete(LlmCall).where(
            or_(col(LlmCall.world_id) == world_id, col(LlmCall.asset_id).in_(world_assets))
        )
    )
    for model in (
        LedgerEntry,
        DocChunk,
        Alert,
        Order,
        Holding,
        Price,
        Event,
        Report,
        Metrics,
        Asset,
        User,
    ):
        session.execute(delete(model).where(_world_col(model) == world_id))


def create_world(session: Session) -> World:
    """Create a visitor world as a copy of the template (seeding the template if needed)."""
    seed(session)
    world = World(label=VISITOR_LABEL)
    session.add(world)
    session.flush()
    _copy_world_rows(session, TEMPLATE_WORLD_ID, world.id)
    session.commit()
    session.refresh(world)
    return world


def reset_world(session: Session, world_id: UUID) -> World:
    """Restore a visitor world to the template state, keeping its ID (and so its cookie)."""
    if world_id == TEMPLATE_WORLD_ID:
        raise ValueError("the template world can't be reset")
    seed(session)
    world = session.exec(select(World).where(World.id == world_id).with_for_update()).first()
    if world is None:
        raise LookupError(f"world {world_id} not found")
    _delete_world_rows(session, world_id)
    _copy_world_rows(session, TEMPLATE_WORLD_ID, world_id)
    world.last_seen_at = _now()
    session.add(world)
    session.commit()
    session.refresh(world)
    return world


def prune_stale_worlds(
    session: Session, older_than: timedelta = STALE_AFTER, limit: int = 50
) -> int:
    """Delete visitor worlds not seen for `older_than`. Never touches the template."""
    stale = session.exec(
        select(World.id)
        .where(World.id != TEMPLATE_WORLD_ID, col(World.last_seen_at) < _now() - older_than)
        .limit(limit)
    ).all()
    for world_id in stale:
        _delete_world_rows(session, world_id)
        session.execute(delete(World).where(col(World.id) == world_id))
    session.commit()
    return len(stale)


def world_from_cookie(session: Session, value: str | None) -> World | None:
    """The visitor's world, or None if the cookie is missing, malformed, unknown or the template."""
    if not value:
        return None
    try:
        world_id = UUID(value)
    except ValueError:
        return None
    if world_id == TEMPLATE_WORLD_ID:
        return None
    return session.get(World, world_id)

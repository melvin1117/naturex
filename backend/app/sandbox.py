"""Per-visitor sandbox worlds (demo-plan §3.5, T31).

Every visitor gets a private copy of the template world, so judges never affect each other.
Copies get fresh IDs, and every reference between them (asset → community persona,
holdings, prices, reports, ledger entries…) is remapped to the copy. Ledger chains stay
valid because an entry's hash covers its payload, kind, seq and previous hash, not its IDs.

The live world (ADR-0005 §2, T54) is built with the same copy, once, and is never served as a
sandbox, reset or pruned.

`create_world`, `reset_world`, `prune_stale_worlds` and `ensure_live_world` each run and
commit their own transaction; call them with no other pending work in the session.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Column, delete, func, inspect, or_, text, update
from sqlalchemy.exc import IntegrityError
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
    UserKind,
    UserSession,
    World,
    WorldEvent,
)
from app.seed import LIVE_LABEL, LIVE_WORLD_ID, seed
from app.seed import WORLD_ID as TEMPLATE_WORLD_ID

log = logging.getLogger(__name__)

COOKIE_NAME = "nx_world"
COOKIE_MAX_AGE_S = 30 * 24 * 3600
STALE_AFTER = timedelta(days=7)
VISITOR_LABEL = "visitor"
# Never served as a sandbox, reset or pruned.
PROTECTED_WORLDS: frozenset[UUID] = frozenset({TEMPLATE_WORLD_ID, LIVE_WORLD_ID})

# Children before parents, so deletes never violate a foreign key.
_DELETE_ORDER: tuple[type[SQLModel], ...] = (
    LedgerEntry,
    DocChunk,
    Alert,
    WorldEvent,
    Order,
    Holding,
    Price,
    Event,
    Report,
    Metrics,
    Asset,
    UserSession,
    User,
)


class WorldLimitReached(RuntimeError):
    """Too many new worlds were created recently; the caller should retry later."""


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


def _ensure_template(session: Session) -> None:
    """Seed the template once. Tolerates two first visitors seeding an empty DB at once."""
    if session.get(World, TEMPLATE_WORLD_ID) is not None:
        return
    try:
        seed(session)
    except IntegrityError:
        session.rollback()
        log.info("template world was seeded concurrently")


def _copy_world_rows(
    session: Session, source: UUID, target: UUID, *, community_users_only: bool = False
) -> None:
    """Copy every world-scoped row from `source` into `target`, remapping IDs.

    Inserts are flushed table by table in foreign-key order. Orders, sessions and LLM call logs
    are visitor activity, not template content, so they are not copied. With
    `community_users_only`, only the users that own an asset (and their holdings) are copied,
    so demo investors and the demo admin persona never reach the live world.
    """
    ids: dict[UUID, UUID] = {}
    copied_users: set[UUID] | None = None
    if community_users_only:
        copied_users = {
            a.community_user_id
            for a in _rows(session, Asset, source)
            if a.community_user_id is not None
        }

    def fk(old: UUID | None) -> UUID | None:
        """Foreign keys must point at a row copied earlier; anything else is a copy-order bug."""
        if old is None:
            return None
        if old not in ids:
            raise RuntimeError(f"reference {old} was not copied before it was used")
        return ids[old]

    def copy_with_new_id(model: type[SQLModel], *fk_fields: str) -> None:
        for row in _rows(session, model, source):
            if model is User and copied_users is not None and row.id not in copied_users:
                continue
            clone: Any = model(
                **_clone(
                    row,
                    {"id", "world_id"},
                    world_id=target,
                    **{field: fk(getattr(row, field)) for field in fk_fields},
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
            Price(**_clone(price, {"world_id"}, world_id=target, asset_id=fk(price.asset_id)))
        )
    for holding in _rows(session, Holding, source):
        if copied_users is not None and holding.user_id not in copied_users:
            continue
        session.add(
            Holding(
                **_clone(
                    holding,
                    {"world_id"},
                    world_id=target,
                    user_id=fk(holding.user_id),
                    asset_id=fk(holding.asset_id),
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
                    asset_id=fk(entry.asset_id),
                    # ref_id has no FK and may name something that isn't copied (e.g. an
                    # order); it keeps the template's ID then, which is only a label.
                    ref_id=ids.get(entry.ref_id, entry.ref_id) if entry.ref_id else None,
                )
            )
        )
    session.flush()


def _delete_world_rows(session: Session, world_id: UUID, *, keep_world: bool) -> None:
    """Delete every row a world owns, children first.

    LLM call logs are kept for the spend cap (LLM_BUDGET_USD); they are only detached from
    the rows being deleted. The ledger-delete opt-in is switched off again before returning,
    so it never covers later work in the same transaction.
    """
    world_assets = select(Asset.id).where(Asset.world_id == world_id)
    detach: dict[str, None] = (
        {"asset_id": None} if keep_world else {"asset_id": None, "world_id": None}
    )
    session.execute(
        update(LlmCall)
        .where(or_(col(LlmCall.world_id) == world_id, col(LlmCall.asset_id).in_(world_assets)))
        .values(**detach)
    )
    session.execute(text("SET LOCAL naturex.allow_ledger_delete = 'on'"))
    try:
        for model in _DELETE_ORDER:
            session.execute(delete(model).where(_world_col(model) == world_id))
    finally:
        session.execute(text("SET LOCAL naturex.allow_ledger_delete = 'off'"))


def create_world(session: Session, max_new_per_hour: int | None = None) -> World:
    """Create a visitor world as a copy of the template.

    Raises WorldLimitReached when `max_new_per_hour` worlds were already created in the
    last hour, so a client that never keeps its cookie can't fill the database.
    """
    _ensure_template(session)
    if max_new_per_hour is not None:
        recent = session.exec(
            select(func.count())
            .select_from(World)
            .where(
                col(World.id).not_in(PROTECTED_WORLDS),
                col(World.created_at) > _now() - timedelta(hours=1),
            )
        ).one()
        if recent >= max_new_per_hour:
            raise WorldLimitReached(f"{recent} demo worlds were created in the last hour")
    world = World(label=VISITOR_LABEL)
    session.add(world)
    session.flush()
    _copy_world_rows(session, TEMPLATE_WORLD_ID, world.id)
    session.commit()
    session.refresh(world)
    return world


def reset_world(session: Session, world_id: UUID) -> World:
    """Restore a visitor world to the template state, keeping its ID (and so its cookie).

    The world row is locked first, so writes for this world wait for the reset. A write that
    was waiting then fails on its now-deleted user or asset; callers (e.g. the trade API)
    should turn that IntegrityError into a 409 "your demo was reset".
    """
    if world_id in PROTECTED_WORLDS:
        raise ValueError("the template and live worlds can't be reset")
    _ensure_template(session)
    world = session.exec(select(World).where(World.id == world_id).with_for_update()).first()
    if world is None:
        raise LookupError(f"world {world_id} not found")
    if world.label == LIVE_LABEL:
        raise ValueError("the live world can't be reset")
    _delete_world_rows(session, world_id, keep_world=True)
    _copy_world_rows(session, TEMPLATE_WORLD_ID, world_id)
    world.last_seen_at = _now()
    session.add(world)
    session.commit()
    session.refresh(world)
    return world


def prune_stale_worlds(
    session: Session, older_than: timedelta = STALE_AFTER, limit: int = 50
) -> int:
    """Delete visitor worlds not seen for `older_than`, and expired sessions.

    Never touches the template or the live world.

    Rows are locked in a fixed order and locked ones are skipped, so concurrent prunes
    can't deadlock and a world busy with a request is left for next time.
    """
    from app.auth import prune_expired_sessions
    from app.events import prune_old_events

    prune_old_events(session)
    prune_expired_sessions(session)
    stale = session.exec(
        select(World.id)
        .where(
            col(World.id).not_in(PROTECTED_WORLDS),
            col(World.label) != LIVE_LABEL,
            col(World.last_seen_at) < _now() - older_than,
        )
        .order_by(col(World.id))
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).all()
    for world_id in stale:
        _delete_world_rows(session, world_id, keep_world=False)
        session.execute(delete(World).where(col(World.id) == world_id))
    session.commit()
    return len(stale)


def world_from_cookie(session: Session, value: str | None) -> World | None:
    """The visitor's sandbox, or None if the cookie is missing, malformed or unknown, or names
    the template or the live world (which are never served as sandboxes)."""
    if not value:
        return None
    try:
        world_id = UUID(value)
    except ValueError:
        return None
    if world_id in PROTECTED_WORLDS:
        return None
    world = session.get(World, world_id)
    if world is None or world.label == LIVE_LABEL:
        return None
    return world


def ensure_live_world(session: Session) -> World:
    """Create the live world once: the curated sites copied from the template (ADR-0005 §2).

    Only the community persona that owns the sites comes along (no password, so nobody can
    sign in as it); T56 replaces it with real communities and treasuries. Idempotent, and
    safe when two processes run it at once.
    """
    world = session.get(World, LIVE_WORLD_ID)
    if world is not None:
        return world
    _ensure_template(session)
    try:
        world = World(id=LIVE_WORLD_ID, label=LIVE_LABEL)
        session.add(world)
        session.flush()
        _copy_world_rows(session, TEMPLATE_WORLD_ID, LIVE_WORLD_ID, community_users_only=True)
        session.commit()
    except IntegrityError:
        session.rollback()
        log.info("live world was created concurrently")
    live = session.get(World, LIVE_WORLD_ID)
    if live is None:
        raise RuntimeError("the live world could not be created")
    return live


def world_contents(session: Session, world_id: UUID) -> tuple[list[User], list[Asset]]:
    """The world's personas and assets, in a stable order. Password accounts are never listed."""
    users = session.exec(
        select(User)
        .where(User.world_id == world_id, User.kind == UserKind.PERSONA)
        .order_by(col(User.persona_key))
    ).all()
    assets = session.exec(
        select(Asset).where(Asset.world_id == world_id).order_by(col(Asset.site_key))
    ).all()
    return list(users), list(assets)

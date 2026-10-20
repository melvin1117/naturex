"""Demo sandbox worlds (demo-plan §3.5, T31) and the live world (ADR-0005 §2).

Every demo session gets a private copy of the template world, so judges never affect each
other. A sandbox is reachable only through its own demo session (T73, `deps.world_for`); no
client-supplied world ID is ever read.
Copies get fresh IDs, and every reference between them (community → treasury, members, asset →
community and treasury, holdings, prices, reports, ledger entries…) is remapped to the copy.
Ledger chains stay valid because an entry's hash covers its payload, kind, seq and previous
hash, not its IDs.

A reset keeps the world's persona users and their IDs (matched by `persona_key`), restoring
their fields from the template, so sessions that point at them survive (ADR-0005 §4, T56).
Everything else, communities and treasuries included, is deleted and copied again with fresh
IDs; nothing outside the world refers to those.

The live world (ADR-0005 §2, T54) is built with the same copy, once, and is never served as a
sandbox, reset or pruned.

`create_world`, `reset_world`, `prune_stale_worlds` and `ensure_live_world` each run and
commit their own transaction; call them with no other pending work in the session.
"""

from __future__ import annotations

import logging
from collections.abc import Collection
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import Column, delete, func, inspect, or_, text, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, col, select

from app.models import (
    Alert,
    AlertRecipient,
    Asset,
    Community,
    CommunityMember,
    CopilotQuestion,
    DocChunk,
    DocumentFingerprint,
    Event,
    Holding,
    LedgerEntry,
    ListingDocument,
    ListingDocumentBlob,
    LlmCall,
    Metrics,
    MonitorRun,
    Order,
    PayoutLine,
    Price,
    Report,
    User,
    UserKind,
    UserSession,
    VerificationRun,
    World,
    WorldEvent,
)
from app.seed import LIVE_LABEL, LIVE_WORLD_ID, seed
from app.seed import WORLD_ID as TEMPLATE_WORLD_ID
from app.services.lifecycle import PUBLIC_STATUSES
from app.worlds import PROTECTED_WORLDS

log = logging.getLogger(__name__)

STALE_AFTER = timedelta(days=7)
VISITOR_LABEL = "visitor"

# Children before parents, so deletes never violate a foreign key. Sessions go first, so a
# pruned world's sessions are gone before anything they could reach (ADR-0005 §4).
_DELETE_ORDER: tuple[type[SQLModel], ...] = (
    UserSession,
    LedgerEntry,
    PayoutLine,
    # Verification (T69): blobs → documents → fingerprint bindings and runs.
    ListingDocumentBlob,
    ListingDocument,
    DocumentFingerprint,
    VerificationRun,
    DocChunk,
    AlertRecipient,
    CopilotQuestion,
    Alert,
    MonitorRun,
    WorldEvent,
    Order,
    Holding,
    Price,
    Event,
    Report,
    Metrics,
    Asset,
    CommunityMember,
    Community,
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
    session: Session,
    source: UUID,
    target: UUID,
    *,
    communities_only: bool = False,
    keep_personas: dict[str, User] | None = None,
) -> None:
    """Copy every world-scoped row from `source` into `target`, remapping IDs.

    Inserts are flushed table by table in foreign-key order. Orders, sessions and LLM call logs
    are visitor activity, not template content, so they are not copied. Payouts and listing
    verification (documents and runs) are activity too, and the source must hold none (T67,
    T69). With `communities_only`, only the communities'
    treasuries and members (and their holdings) are copied, so demo investors and the demo
    admin persona never reach the live world. `keep_personas` maps `persona_key` to a persona
    already in `target`: that user keeps its ID and gets the source persona's fields, so its
    sessions survive a reset.
    """
    # A payout's leaf hashes cover its holders' user IDs, which a copy remaps, so copied lines
    # could never verify against the copied ledger commitment. Templates never pay out; payouts
    # happen in visitor and live worlds (T38 Time Machine, T44 impact UI).
    payout_line = select(PayoutLine.id).where(PayoutLine.world_id == source).limit(1)
    if session.exec(payout_line).first() is not None:
        raise RuntimeError(f"world {source} holds payouts, which can't be copied")
    # Verification (T69) is per world too: document fingerprints are keyed by world and a run's
    # input fingerprint covers the community's ID, which a copy remaps, so a copied run could
    # never match. Templates hold none; T76 creates sandboxes' demo runs in each world instead.
    for model in (VerificationRun, ListingDocument):
        if session.exec(select(model).where(_world_col(model) == source).limit(1)).first():
            raise RuntimeError(f"world {source} holds verification records, which can't be copied")
    ids: dict[UUID, UUID] = {}
    copied_users: set[UUID] | None = None
    if communities_only:
        copied_users = {c.treasury_user_id for c in _rows(session, Community, source)} | {
            m.user_id for m in _rows(session, CommunityMember, source)
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
            kept = keep_personas.get(row.persona_key) if model is User and keep_personas else None
            if kept is not None:
                for field, value in row.model_dump(exclude={"id", "world_id"}).items():
                    setattr(kept, field, value)
                ids[row.id] = kept.id
                session.add(kept)
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
    copy_with_new_id(Community, "treasury_user_id")
    for member in _rows(session, CommunityMember, source):
        session.add(
            CommunityMember(
                **_clone(
                    member,
                    {"world_id"},
                    world_id=target,
                    community_id=fk(member.community_id),
                    user_id=fk(member.user_id),
                )
            )
        )
    session.flush()
    copy_with_new_id(Asset, "community_id", "community_user_id")
    copy_with_new_id(Metrics, "asset_id")
    copy_with_new_id(Report, "asset_id", "metrics_id")
    copy_with_new_id(Event, "asset_id")
    copy_with_new_id(Alert, "asset_id", "report_id")
    copy_with_new_id(DocChunk, "asset_id", "report_id", "event_id")

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


def _delete_world_rows(
    session: Session, world_id: UUID, *, keep_world: bool, keep_users: Collection[UUID] = ()
) -> None:
    """Delete every row a world owns, children first; `keep_users` and their sessions stay.

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
    kept = list(keep_users)
    session.execute(text("SET LOCAL naturex.allow_ledger_delete = 'on'"))
    try:
        for model in _DELETE_ORDER:
            stmt = delete(model).where(_world_col(model) == world_id)
            if kept and model is UserSession:
                stmt = stmt.where(col(UserSession.user_id).not_in(kept))
            elif kept and model is User:
                stmt = stmt.where(col(User.id).not_in(kept))
            session.execute(stmt)
    finally:
        session.execute(text("SET LOCAL naturex.allow_ledger_delete = 'off'"))


def create_world(session: Session, max_new_per_hour: int | None = None) -> World:
    """Create a demo sandbox world as a copy of the template.

    Raises WorldLimitReached when `max_new_per_hour` worlds were already created in the
    last hour, so a client that never keeps its session can't fill the database.
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
    """Restore a sandbox world to the template state, keeping its ID (and its demo sessions).

    Persona users keep their IDs (matched by `persona_key`) and get the template's fields back
    (cash included), so a session on any persona stays valid (ADR-0005 §4). A persona the
    template no longer has is deleted with its sessions; every other row, communities and
    treasuries included, is copied again with fresh IDs.

    The world row is locked first, so writes for this world wait for the reset. A write that
    was waiting then finds its asset gone (assets get fresh IDs); callers (e.g. the trade API)
    should answer 404 or 409 "your demo was reset".
    """
    if world_id in PROTECTED_WORLDS:
        raise ValueError("the template and live worlds can't be reset")
    _ensure_template(session)
    world = session.exec(select(World).where(World.id == world_id).with_for_update()).first()
    if world is None:
        raise LookupError(f"world {world_id} not found")
    if world.label == LIVE_LABEL:
        raise ValueError("the live world can't be reset")
    template_keys = {
        u.persona_key for u in _rows(session, User, TEMPLATE_WORLD_ID) if u.persona_key
    }
    keep = {
        u.persona_key: u
        for u in _rows(session, User, world_id)
        if u.kind == UserKind.PERSONA and u.persona_key in template_keys
    }
    _delete_world_rows(session, world_id, keep_world=True, keep_users={u.id for u in keep.values()})
    _copy_world_rows(session, TEMPLATE_WORLD_ID, world_id, keep_personas=keep)
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


def is_sandbox(world: World) -> bool:
    """True for a demo sandbox; False for the template and the live world, which are never
    served as sandboxes."""
    return world.id not in PROTECTED_WORLDS and world.label != LIVE_LABEL


def ensure_live_world(session: Session) -> World:
    """Create the live world once: the curated sites copied from the template (ADR-0005 §2).

    Their communities come along with their treasuries (holding the retained stakes) and their
    owner persona (no password, so nobody can sign in as it); demo investors and the demo admin
    don't. Idempotent, and safe when two processes run it at once.
    """
    world = session.get(World, LIVE_WORLD_ID)
    if world is not None:
        return world
    _ensure_template(session)
    try:
        world = World(id=LIVE_WORLD_ID, label=LIVE_LABEL)
        session.add(world)
        session.flush()
        _copy_world_rows(session, TEMPLATE_WORLD_ID, LIVE_WORLD_ID, communities_only=True)
        session.commit()
    except IntegrityError:
        session.rollback()
        # Only a concurrent creator's committed world explains this; anything else (a failed
        # copy) is a real error and is raised as is.
        if session.get(World, LIVE_WORLD_ID) is None:
            raise
        log.info("live world was created concurrently")
    return session.get_one(World, LIVE_WORLD_ID)


def world_contents(session: Session, world_id: UUID) -> tuple[list[User], list[Asset]]:
    """The world's personas and public assets, in a stable order. Password accounts are never
    listed."""
    users = session.exec(
        select(User)
        .where(User.world_id == world_id, User.kind == UserKind.PERSONA)
        .order_by(col(User.persona_key))
    ).all()
    # Public listings only (T58): drafts and listings under review belong to their community.
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == world_id, col(Asset.status).in_(PUBLIC_STATUSES))
        .order_by(col(Asset.site_key))
    ).all()
    return list(users), list(assets)

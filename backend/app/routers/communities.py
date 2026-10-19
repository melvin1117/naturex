"""Communities and their stewards (ADR-0005 §3, T68).

Every route authorizes through `app.authz.require`, in the caller's own world (the session's;
anonymous callers read the live world). Reads: a community's profile is public like the rest of
the marketplace; its member list is the community's own data (members and same-world admins).
Writes take a KEY SHARE lock on the world row first, like orders, so they wait behind a
"Reset my demo" instead of racing it.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from app.authz import (
    Action,
    CommunityRef,
    DenyReason,
    Granted,
    MemberCandidate,
    community_ref,
    enforce,
    require,
)
from app.communities import (
    ALREADY_MEMBER,
    NOT_A_MEMBER,
    MembershipConflict,
    add_member,
    communities_of,
    create_community,
    holds_community_shares,
    remove_member,
    rename_treasury,
)
from app.deps import SessionDep
from app.models import Community, CommunityMember, CommunityRole, User, World
from app.schemas import (
    CommunityCreate,
    CommunityMemberAdd,
    CommunityMemberOut,
    CommunityOut,
    CommunityUpdate,
    MyCommunityOut,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["communities"])

# A signed-in user may own a handful of communities; this stops one account flooding a world.
MAX_OWNED_COMMUNITIES = 5
COMMUNITY_LIMIT_REACHED = "community_limit_reached"
USER_NOT_FOUND = "user_not_found"
CHECK_VIOLATION = "23514"
CONFLICT = "conflict"

Responses = dict[int | str, dict[str, Any]]
_AUTH: Responses = {401: {"description": "auth_required"}}
_DENIED: Responses = {403: {"description": "A reason code, e.g. owner_only or members_only"}}
_MISSING: Responses = {404: {"description": "Not found in the caller's world"}}

CommunityAccess = Annotated[Granted, require(Action.BROWSE, community_ref)]
CommunityData = Annotated[Granted, require(Action.VIEW_COMMUNITY_DATA, community_ref)]
CommunityEdit = Annotated[Granted, require(Action.EDIT_COMMUNITY, community_ref)]
CommunityMembers = Annotated[Granted, require(Action.MANAGE_MEMBERS, community_ref)]
CreateCommunity = Annotated[Granted, require(Action.CREATE_COMMUNITY)]
OwnAccount = Annotated[Granted, require(Action.USE_OWN_ACCOUNT)]


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _lock_world(session: Session, world_id: UUID) -> None:
    session.exec(select(World.id).where(World.id == world_id).with_for_update(key_share=True)).one()


def _community(session: Session, granted: Granted) -> Community:
    ref = granted.resource
    if not isinstance(ref, CommunityRef):  # pragma: no cover - loaders guarantee it
        raise TypeError(ref)
    return session.exec(
        select(Community).where(
            Community.world_id == ref.world_id, Community.id == ref.community_id
        )
    ).one()


def _refused(
    session: Session, exc: IntegrityError, *, on_check: str, otherwise: str
) -> HTTPException:
    """A 409 for a constraint or trigger refusal, rather than a 500.

    The 0009 triggers raise `check_violation` for treasury misuse. Only the SQLSTATE is logged,
    never the driver message (it can quote row values).
    """
    session.rollback()
    sqlstate = getattr(exc.orig, "sqlstate", None)
    log.warning("community write refused by the database: SQLSTATE %s", sqlstate)
    return HTTPException(
        status.HTTP_409_CONFLICT, on_check if sqlstate == CHECK_VIOLATION else otherwise
    )


@contextmanager
def _writing(
    session: Session, *, on_check: str = CONFLICT, otherwise: str = CONFLICT
) -> Iterator[None]:
    """Run the block's flushes, then commit; a database refusal anywhere in it is a 409."""
    try:
        yield
        session.commit()
    except IntegrityError as exc:
        raise _refused(session, exc, on_check=on_check, otherwise=otherwise) from None


def _member_out(member: CommunityMember, user: User) -> CommunityMemberOut:
    return CommunityMemberOut(
        user_id=member.user_id, name=user.name, role=member.role, created_at=member.created_at
    )


@router.post(
    "/communities",
    response_model=CommunityOut,
    status_code=status.HTTP_201_CREATED,
    responses={**_AUTH, 409: {"description": COMMUNITY_LIMIT_REACHED}},
)
def create(
    body: CommunityCreate, granted: CreateCommunity, session: SessionDep, response: Response
) -> CommunityOut:
    """Create a community in the caller's world. The caller becomes its owner, and its treasury
    account (holds the retained stake, never signs in or trades) is created with it."""
    actor = granted.signed_in
    _lock_world(session, actor.world_id)
    # Serializes one account's creations, so two concurrent requests can't both pass the cap.
    session.exec(
        select(User.id)
        .where(User.world_id == actor.world_id, User.id == actor.user_id)
        .with_for_update()
    ).one()
    owned = session.exec(
        select(func.count()).where(
            CommunityMember.world_id == actor.world_id,
            CommunityMember.user_id == actor.user_id,
            CommunityMember.role == CommunityRole.OWNER,
        )
    ).one()
    if owned >= MAX_OWNED_COMMUNITIES:
        raise HTTPException(status.HTTP_409_CONFLICT, COMMUNITY_LIMIT_REACHED)
    with _writing(session):
        community = create_community(
            session,
            actor.world_id,
            body.name,
            actor.user_id,
            country=body.country,
            description=body.description,
        )
    session.refresh(community)
    _no_store(response)
    return CommunityOut.model_validate(community)


@router.get("/communities/{community_id}", response_model=CommunityOut, responses=_MISSING)
def read(granted: CommunityAccess, session: SessionDep) -> CommunityOut:
    """A community's public profile. Anyone may read it, like the marketplace (ADR-0005 §3)."""
    return CommunityOut.model_validate(_community(session, granted))


@router.patch(
    "/communities/{community_id}",
    response_model=CommunityOut,
    responses={**_AUTH, **_DENIED, **_MISSING},
)
def update(
    body: CommunityUpdate, granted: CommunityEdit, session: SessionDep, response: Response
) -> CommunityOut:
    """Edit the community's profile (owner only). Only the fields sent change."""
    _lock_world(session, granted.signed_in.world_id)
    community = _community(session, granted)
    changes: dict[str, Any] = body.model_dump(include=body.model_fields_set)
    with _writing(session):
        for name, value in changes.items():
            setattr(community, name, value)
        session.add(community)
        session.flush()
        if "name" in changes:
            rename_treasury(session, community)
    session.refresh(community)
    _no_store(response)
    return CommunityOut.model_validate(community)


@router.get(
    "/communities/{community_id}/members",
    response_model=list[CommunityMemberOut],
    responses={**_AUTH, **_DENIED, **_MISSING},
)
def list_members(
    granted: CommunityData, session: SessionDep, response: Response
) -> list[CommunityMemberOut]:
    """The owner and stewards (the community's members and same-world admins only)."""
    community = _community(session, granted)
    rows = session.exec(
        select(CommunityMember, User)
        .join(
            User,
            (col(User.world_id) == col(CommunityMember.world_id))
            & (col(User.id) == col(CommunityMember.user_id)),
        )
        .where(
            CommunityMember.world_id == community.world_id,
            CommunityMember.community_id == community.id,
        )
        .order_by(col(CommunityMember.created_at), col(User.name))
    ).all()
    _no_store(response)
    return [_member_out(member, user) for member, user in rows]


@router.post(
    "/communities/{community_id}/members",
    response_model=CommunityMemberOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "member_has_holdings, member_not_eligible or already_member"},
    },
)
def add_steward(
    body: CommunityMemberAdd, granted: CommunityMembers, session: SessionDep, response: Response
) -> CommunityMemberOut:
    """Add a steward (owner only). Someone holding the community's asset shares can't join:
    members can't trade their own asset, so they'd be trapped (409 `member_has_holdings`)."""
    actor = granted.signed_in
    _lock_world(session, actor.world_id)
    community = _community(session, granted)
    # Orders lock the trader's user row, so holding it here keeps a buy from slipping in
    # between the holdings check and the insert.
    user = session.exec(
        select(User)
        .where(User.world_id == community.world_id, User.id == body.user_id)
        .with_for_update()
    ).first()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, USER_NOT_FOUND)
    candidate = MemberCandidate(
        world_id=community.world_id,
        community_id=community.id,
        user_id=user.id,
        user_kind=user.kind,
        holds_community_shares=holds_community_shares(session, community, user.id),
    )
    enforce(actor, Action.MANAGE_MEMBERS, candidate)
    try:
        with _writing(
            session, on_check=DenyReason.MEMBER_NOT_ELIGIBLE.value, otherwise=ALREADY_MEMBER
        ):
            member = add_member(session, community, user.id, CommunityRole.STEWARD)
    except MembershipConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, exc.reason) from None
    session.refresh(member)
    _no_store(response)
    return _member_out(member, user)


@router.delete(
    "/communities/{community_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "owner_cannot_be_removed"},
    },
)
def remove_steward(user_id: UUID, granted: CommunityMembers, session: SessionDep) -> Response:
    """Remove a steward (owner only). The owner can't be removed."""
    _lock_world(session, granted.signed_in.world_id)
    community = _community(session, granted)
    try:
        with _writing(session):
            remove_member(session, community, user_id)
    except MembershipConflict as exc:
        code = status.HTTP_404_NOT_FOUND if exc.reason == NOT_A_MEMBER else status.HTTP_409_CONFLICT
        raise HTTPException(code, exc.reason) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": "no-store"})


@router.get("/me/communities", response_model=list[MyCommunityOut], responses=_AUTH)
def my_communities(
    granted: OwnAccount, session: SessionDep, response: Response
) -> list[MyCommunityOut]:
    """The caller's communities and role in each, so the Steward app knows what to show."""
    actor = granted.signed_in
    _no_store(response)
    return [
        MyCommunityOut(
            id=community.id,
            name=community.name,
            country=community.country,
            description=community.description,
            created_at=community.created_at,
            role=role,
        )
        for community, role in communities_of(session, actor.world_id, actor.user_id)
    ]

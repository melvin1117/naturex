"""Communities and their stewards (ADR-0005 §3, T68).

Every route authorizes through `app.authz.require`, in the caller's own world (the session's;
anonymous callers read the live world). Reads: a community's profile is public like the rest of
the marketplace; its member list is the community's own data (members and same-world admins).
Reads vary with the session cookie, so they are `private, no-store`.
Writes first take the same world-row lock as orders (`with_for_update(key_share=True)`, which
SQLAlchemy renders as `FOR NO KEY UPDATE`), so they wait behind a "Reset my demo" instead of
racing it; that lock also serializes writes, orders included, within one world.
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
    MemberRef,
    community_ref,
    enforce,
    member_ref,
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
from app.models import (
    COMMUNITY_NAME_INDEX,
    Asset,
    Community,
    CommunityMember,
    CommunityRole,
    User,
    World,
)
from app.routers.assets import cards
from app.schemas import (
    CommunityCreate,
    CommunityMemberAdd,
    CommunityMemberOut,
    CommunityOut,
    CommunitySummaryOut,
    CommunityUpdate,
    HoldersOut,
    ListingSummaryOut,
    MyCommunityOut,
    PayoutSummaryOut,
    SharesOut,
    TopHolderOut,
    WalletOut,
)
from app.services.community_summary import Wallet, summarize

log = logging.getLogger(__name__)
router = APIRouter(tags=["communities"])

# A signed-in user may own a handful of communities; this stops one account flooding a world.
MAX_OWNED_COMMUNITIES = 5
COMMUNITY_LIMIT_REACHED = "community_limit_reached"
COMMUNITY_NAME_TAKEN = "community_name_taken"
USER_NOT_FOUND = "user_not_found"
CONFLICT = "conflict"
CHECK_VIOLATION = "23514"
UNIQUE_VIOLATION = "23505"
# Unique violations these routes can explain; any other refusal is a plain `conflict`.
_UNIQUE_REASONS: dict[str | None, str] = {
    COMMUNITY_NAME_INDEX: COMMUNITY_NAME_TAKEN,
    "community_members_pkey": ALREADY_MEMBER,
}

Responses = dict[int | str, dict[str, Any]]
_AUTH: Responses = {401: {"description": "auth_required"}}
_DENIED: Responses = {403: {"description": "A reason code, e.g. owner_only or members_only"}}
_MISSING: Responses = {404: {"description": "Not found in the caller's world"}}

CommunityAccess = Annotated[Granted, require(Action.BROWSE, community_ref)]
CommunityData = Annotated[Granted, require(Action.VIEW_COMMUNITY_DATA, community_ref)]
CommunityEdit = Annotated[Granted, require(Action.EDIT_COMMUNITY, community_ref)]
CommunityMembers = Annotated[Granted, require(Action.MANAGE_MEMBERS, community_ref)]
Membership = Annotated[Granted, require(Action.MANAGE_MEMBERS, member_ref)]
CreateCommunity = Annotated[Granted, require(Action.CREATE_COMMUNITY)]
OwnAccount = Annotated[Granted, require(Action.USE_OWN_ACCOUNT)]


NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"


def _no_store(response: Response, value: str = NO_STORE) -> None:
    response.headers["Cache-Control"] = value


def _lock_world(session: Session, world_id: UUID) -> None:
    session.exec(select(World.id).where(World.id == world_id).with_for_update(key_share=True)).one()


def _community(session: Session, granted: Granted) -> Community:
    ref = granted.resource
    if not isinstance(ref, CommunityRef | MemberRef):  # pragma: no cover - loaders guarantee it
        raise TypeError(ref)
    return session.exec(
        select(Community).where(
            Community.world_id == ref.world_id, Community.id == ref.community_id
        )
    ).one()


def _refused(session: Session, exc: IntegrityError, *, on_check: str) -> HTTPException:
    """A 409 for a constraint or trigger refusal, rather than a 500.

    The 0009 triggers raise `check_violation` for treasury misuse (`on_check`); a unique
    violation is explained only for the constraints in `_UNIQUE_REASONS`; anything else is
    `conflict`. Only the SQLSTATE and constraint name are logged, never the driver message (it
    can quote row values).
    """
    session.rollback()
    sqlstate = getattr(exc.orig, "sqlstate", None)
    constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    log.warning(
        "community write refused by the database: SQLSTATE %s, constraint %s", sqlstate, constraint
    )
    if sqlstate == CHECK_VIOLATION:
        reason = on_check
    elif sqlstate == UNIQUE_VIOLATION:
        reason = _UNIQUE_REASONS.get(constraint, CONFLICT)
    else:
        reason = CONFLICT
    return HTTPException(status.HTTP_409_CONFLICT, reason)


@contextmanager
def _writing(session: Session, *, on_check: str = CONFLICT) -> Iterator[None]:
    """Run the block's flushes, then commit; a database refusal anywhere in it is a 409."""
    try:
        yield
        session.commit()
    except IntegrityError as exc:
        raise _refused(session, exc, on_check=on_check) from None


def _member_out(member: CommunityMember, user: User) -> CommunityMemberOut:
    return CommunityMemberOut(
        user_id=member.user_id, name=user.name, role=member.role, created_at=member.created_at
    )


@router.post(
    "/communities",
    response_model=CommunityOut,
    status_code=status.HTTP_201_CREATED,
    responses={**_AUTH, 409: {"description": "community_limit_reached or community_name_taken"}},
)
def create(
    body: CommunityCreate, granted: CreateCommunity, session: SessionDep, response: Response
) -> CommunityOut:
    """Create a community in the caller's world. The caller becomes its owner, and its treasury
    account (holds the retained stake, never signs in or trades) is created with it."""
    actor = granted.signed_in
    _lock_world(session, actor.world_id)
    # The world lock already serializes this; the user lock keeps the cap safe for one account
    # even if that lock is ever narrowed to a true KEY SHARE.
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
def read(granted: CommunityAccess, session: SessionDep, response: Response) -> CommunityOut:
    """A community's public profile. Anyone may read it, like the marketplace (ADR-0005 §3)."""
    _no_store(response, PRIVATE_NO_STORE)
    return CommunityOut.model_validate(_community(session, granted))


@router.patch(
    "/communities/{community_id}",
    response_model=CommunityOut,
    responses={**_AUTH, **_DENIED, **_MISSING, 409: {"description": COMMUNITY_NAME_TAKEN}},
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
    _no_store(response, PRIVATE_NO_STORE)
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
    # Orders lock the trader's user row too, so an order that already holds it commits its
    # holding before the check below reads holdings. This alone doesn't stop an order that was
    # authorized earlier (memberships are read before any lock) from buying once this commits:
    # trade paths must re-check TRADE with `fresh_actor` after taking the lock (T57).
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
        is_admin=user.is_admin,
        holds_community_shares=holds_community_shares(session, community, user.id),
    )
    enforce(actor, Action.MANAGE_MEMBERS, candidate)
    try:
        with _writing(session, on_check=DenyReason.MEMBER_NOT_ELIGIBLE.value):
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
def remove_steward(user_id: UUID, granted: Membership, session: SessionDep) -> Response:
    """Remove a steward (owner), or leave the community (any member). The owner can't be removed."""
    _lock_world(session, granted.signed_in.world_id)
    community = _community(session, granted)
    try:
        with _writing(session):
            remove_member(session, community, user_id)
    except MembershipConflict as exc:
        code = status.HTTP_404_NOT_FOUND if exc.reason == NOT_A_MEMBER else status.HTTP_409_CONFLICT
        raise HTTPException(code, exc.reason) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": NO_STORE})


def _wallet_out(wallet: Wallet) -> WalletOut:
    return WalletOut(
        balance=wallet.balance,
        ipo_proceeds=wallet.ipo_proceeds,
        community_fund_payouts=wallet.community_fund_payouts,
        retained_dividends=wallet.retained_dividends,
        total_received=wallet.total_received,
    )


@router.get(
    "/communities/{community_id}/summary",
    response_model=CommunitySummaryOut,
    responses={**_AUTH, **_DENIED, **_MISSING},
)
def summary(granted: CommunityData, session: SessionDep, response: Response) -> CommunitySummaryOut:
    """The Steward home (T63; the community's members and same-world admins): its listings with
    their status and next action, the community wallet (IPO proceeds and community-fund
    payouts), the treasury's retained-stake dividends, holders (counted and ranked, never
    named), recent quarterly payouts and the latest reports' stewardship recommendations.
    Every number comes from stored rows (`app.services.community_summary`). Play money."""
    actor = granted.signed_in
    community = _community(session, granted)
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == community.world_id, Asset.community_id == community.id)
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    role = actor.role_in(community.id)
    facts = summarize(session, community.world_id, assets, can_launch=role == CommunityRole.OWNER)
    card_of = {card.id: card for card in cards(session, community.world_id, assets)}
    names = {asset.id: asset.name for asset in assets}
    _no_store(response, PRIVATE_NO_STORE)
    return CommunitySummaryOut(
        community=CommunityOut.model_validate(community),
        role=role,
        listings=[
            ListingSummaryOut(
                asset=card_of[listing.asset.id],
                next_action=listing.next_action,
                ipo_at=listing.asset.ipo_at,
                wallet=_wallet_out(listing.wallet),
                holders=HoldersOut(
                    count=listing.holders.count,
                    shares_held=listing.holders.shares_held,
                    top=[
                        TopHolderOut(rank=t.rank, shares=t.shares, pct_of_shares=t.pct_of_shares)
                        for t in listing.holders.top
                    ],
                ),
                shares=(
                    None
                    if listing.shares is None
                    else SharesOut(
                        shares_offered=listing.shares.shares_offered,
                        shares_sold=listing.shares.shares_sold,
                        retained_shares=listing.shares.retained_shares,
                    )
                ),
                recommendations=list(listing.recommendations),
                report_version=listing.report_version,
            )
            for listing in facts.listings
        ],
        wallet=_wallet_out(facts.wallet),
        holder_count=facts.holder_count,
        payouts=[
            PayoutSummaryOut(
                asset_id=p.asset_id,
                asset_name=names[p.asset_id],
                quarter_label=p.quarter_label,
                revenue=p.revenue,
                community_fund=p.community_fund,
                dividends_total=p.dividends_total,
                retained_dividend=p.retained_dividend,
                holder_count=p.holder_count,
                paid_at=p.paid_at,
            )
            for p in facts.payouts
        ],
        payouts_count=facts.payouts_count,
    )


@router.get("/me/communities", response_model=list[MyCommunityOut], responses=_AUTH)
def my_communities(
    granted: OwnAccount, session: SessionDep, response: Response
) -> list[MyCommunityOut]:
    """The caller's communities and role in each, so the Steward app knows what to show."""
    actor = granted.signed_in
    _no_store(response, PRIVATE_NO_STORE)
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

"""Communities, their treasuries and members (ADR-0005 §3; T56, T68).

Small DB functions the community routes and the seed share. None of them commit; the caller
owns the transaction. Authorization is `app.authz`'s job; these only enforce state rules.
"""

from __future__ import annotations

import re
import unicodedata
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import delete, exists, update
from sqlmodel import Session, col, select

from app.models import (
    Asset,
    Community,
    CommunityMember,
    CommunityRole,
    Holding,
    User,
    UserKind,
    UserRole,
    World,
)


class MembershipConflict(Exception):
    """A membership change that the community's current state doesn't allow."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


ALREADY_MEMBER = "already_member"
NOT_A_MEMBER = "not_a_member"
OWNER_CANNOT_BE_REMOVED = "owner_cannot_be_removed"
OWNER_IS_A_PERSON = "owner_is_a_person"
NOT_A_PERSON = "not_a_person"
MEMBER_HAS_HOLDINGS = "member_has_holdings"

NAME_MIN_LENGTH = 2
NAME_MAX_LENGTH = 80
DESCRIPTION_MAX_LENGTH = 1000
_NAME_PUNCTUATION = frozenset(" -'’.,&()")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")


def clean_name(raw: str) -> str:
    """A community name: letters (any script), digits, spaces and ``-'’.,&()``, starting with a
    letter or digit, 2–80 characters once trimmed; runs of spaces collapse to one.

    NFKC-normalized first, so a decomposed "Río" (i + combining accent) is the same name as the
    composed one, and compatibility forms (full-width letters, ligatures) fold to plain ones.
    """
    name = " ".join(unicodedata.normalize("NFKC", raw).split())
    if not NAME_MIN_LENGTH <= len(name) <= NAME_MAX_LENGTH:
        raise ValueError(f"Use {NAME_MIN_LENGTH}–{NAME_MAX_LENGTH} characters")
    if not name[0].isalnum() or any(not (ch.isalnum() or ch in _NAME_PUNCTUATION) for ch in name):
        raise ValueError("Use letters, digits, spaces and - ' . , & ( ) only")
    return name


def clean_country(raw: str | None) -> str | None:
    """An ISO 3166-1 alpha-2 code, upper-cased; empty means none."""
    if raw is None or not raw.strip():
        return None
    country = raw.strip().upper()
    if not _COUNTRY_RE.fullmatch(country):
        raise ValueError("Use a two-letter ISO country code")
    return country


def clean_description(raw: str | None) -> str | None:
    """Printable text and line breaks, at most 1000 characters once trimmed; empty means none."""
    if raw is None or not raw.strip():
        return None
    description = raw.strip()
    if len(description) > DESCRIPTION_MAX_LENGTH:
        raise ValueError(f"Use at most {DESCRIPTION_MAX_LENGTH} characters")
    if any(not (ch.isprintable() or ch in "\n\t") for ch in description):
        raise ValueError("Remove control characters")
    return description


def treasury_name(community_name: str) -> str:
    return f"{community_name} Treasury"


def create_community(
    session: Session,
    world_id: UUID,
    name: str,
    owner_id: UUID,
    *,
    country: str | None = None,
    description: str | None = None,
    community_id: UUID | None = None,
    treasury_id: UUID | None = None,
) -> Community:
    """A community, its treasury account and its owner's membership. Flushes; doesn't commit.

    The treasury never signs in or trades (DB triggers from migration 0009): 0 cash, no email,
    password or persona key. The seed passes fixed IDs; routes let them be generated.
    """
    treasury = User(
        id=treasury_id or uuid4(),
        world_id=world_id,
        name=treasury_name(name),
        role=UserRole.COMMUNITY,
        kind=UserKind.TREASURY,
        cash_balance=Decimal("0.00"),
    )
    session.add(treasury)
    session.flush()
    community = Community(
        id=community_id or uuid4(),
        world_id=world_id,
        name=name,
        country=country,
        description=description,
        treasury_user_id=treasury.id,
    )
    session.add(community)
    session.flush()
    add_member(session, community, owner_id, CommunityRole.OWNER)
    return community


def rename_treasury(session: Session, community: Community) -> None:
    """Keep the treasury's display name in step with its community's. Flushes."""
    treasury = session.exec(
        select(User).where(
            User.world_id == community.world_id, User.id == community.treasury_user_id
        )
    ).one()
    treasury.name = treasury_name(community.name)
    session.add(treasury)
    session.flush()


def get_member(session: Session, community: Community, user_id: UUID) -> CommunityMember | None:
    return session.exec(
        select(CommunityMember).where(
            CommunityMember.world_id == community.world_id,
            CommunityMember.community_id == community.id,
            CommunityMember.user_id == user_id,
        )
    ).first()


def add_member(
    session: Session, community: Community, user_id: UUID, role: CommunityRole
) -> CommunityMember:
    """Insert a membership. Raises MembershipConflict if the user is already a member. Flushes."""
    if get_member(session, community, user_id) is not None:
        raise MembershipConflict(ALREADY_MEMBER)
    member = CommunityMember(
        community_id=community.id, user_id=user_id, world_id=community.world_id, role=role
    )
    session.add(member)
    session.flush()
    return member


def remove_member(session: Session, community: Community, user_id: UUID) -> None:
    """Delete a steward's membership. The owner stays (a community always has one). Flushes."""
    member = get_member(session, community, user_id)
    if member is None:
        raise MembershipConflict(NOT_A_MEMBER)
    if member.role == CommunityRole.OWNER:
        raise MembershipConflict(OWNER_CANNOT_BE_REMOVED)
    session.execute(
        delete(CommunityMember).where(
            col(CommunityMember.world_id) == community.world_id,
            col(CommunityMember.community_id) == community.id,
            col(CommunityMember.user_id) == user_id,
        )
    )
    session.flush()


def transfer_ownership(session: Session, community: Community, new_owner_id: UUID) -> bool:
    """Hand a community from its seeded owner persona (who can't sign in) to a person: an
    operator step for the live world's curated communities (`app.jobs.seed_live`), never an API.

    Takes the same locks as adding a steward (the world, then the new owner's row) and keeps
    the same rule: someone holding the community's shares can't become a member (they couldn't
    trade them any more). Returns False when the person already owns it. Raises
    MembershipConflict: `owner_is_a_person` (only a persona's community is handed over),
    `not_a_person` or `member_has_holdings`. Flushes; the caller commits.
    """
    session.exec(
        select(World.id).where(World.id == community.world_id).with_for_update(key_share=True)
    ).one()
    owners = session.exec(
        select(User)
        .join(
            CommunityMember,
            (col(CommunityMember.world_id) == col(User.world_id))
            & (col(CommunityMember.user_id) == col(User.id)),
        )
        .where(
            CommunityMember.community_id == community.id,
            CommunityMember.role == CommunityRole.OWNER,
        )
    ).all()
    if any(owner.id == new_owner_id for owner in owners):
        return False
    if len(owners) != 1 or owners[0].kind is not UserKind.PERSONA:
        raise MembershipConflict(OWNER_IS_A_PERSON)
    current = owners[0]
    person = session.exec(
        select(User)
        .where(User.world_id == community.world_id, User.id == new_owner_id)
        .with_for_update()
    ).one()
    if person.kind is not UserKind.PERSON:
        raise MembershipConflict(NOT_A_PERSON)
    if get_member(session, community, person.id) is not None:
        raise MembershipConflict(ALREADY_MEMBER)
    if holds_community_shares(session, community, person.id):
        raise MembershipConflict(MEMBER_HAS_HOLDINGS)
    session.execute(
        update(CommunityMember)
        .where(
            col(CommunityMember.community_id) == community.id,
            col(CommunityMember.user_id) == current.id,
        )
        .values(user_id=person.id)
    )
    session.flush()
    return True


def holds_community_shares(session: Session, community: Community, user_id: UUID) -> bool:
    """Whether the user holds shares of any of the community's assets (insider-trading rule)."""
    held = select(Holding.asset_id).join(
        Asset,
        (col(Asset.world_id) == col(Holding.world_id)) & (col(Asset.id) == col(Holding.asset_id)),
    )
    held = held.where(
        Holding.world_id == community.world_id,
        Holding.user_id == user_id,
        Asset.community_id == community.id,
        col(Holding.shares) > 0,
    )
    return bool(session.exec(select(exists(held))).one())


def communities_of(
    session: Session, world_id: UUID, user_id: UUID
) -> list[tuple[Community, CommunityRole]]:
    """The user's communities in its world, with its role in each, oldest membership first."""
    rows = session.exec(
        select(Community, CommunityMember.role)
        .join(
            CommunityMember,
            (col(CommunityMember.world_id) == col(Community.world_id))
            & (col(CommunityMember.community_id) == col(Community.id)),
        )
        .where(CommunityMember.world_id == world_id, CommunityMember.user_id == user_id)
        .order_by(col(CommunityMember.created_at), col(Community.name))
    ).all()
    return [(community, CommunityRole(role)) for community, role in rows]

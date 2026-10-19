"""The authorization policy (ADR-0005 §3, T68): every role × action, allowed and denied.

Pure tests: `authorize` never touches the database. Route behaviour (401/403/404/409 through
`require`) is in `test_communities.py`.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from app.authz import (
    ALLOW,
    Action,
    Actor,
    AssetRef,
    CommunityRef,
    Decision,
    Deny,
    DenyReason,
    MemberCandidate,
    Resource,
    WorldRef,
    authorize,
    is_sandbox_world,
)
from app.models import CommunityRole, SessionKind, UserKind
from app.seed import LIVE_WORLD_ID, WORLD_ID

WORLD = LIVE_WORLD_ID
OTHER_WORLD = uuid4()
SANDBOX = uuid4()
COMMUNITY = uuid4()
OTHER_COMMUNITY = uuid4()
ASSET = uuid4()


def actor(
    *,
    world: UUID = WORLD,
    kind: UserKind = UserKind.PERSON,
    admin: bool = False,
    session_kind: SessionKind = SessionKind.PASSWORD,
    roles: dict[UUID, CommunityRole] | None = None,
) -> Actor:
    return Actor(
        user_id=uuid4(),
        world_id=world,
        user_kind=kind,
        is_admin=admin,
        session_kind=session_kind,
        memberships=roles or {},
    )


ROLES: dict[str, Actor | None] = {
    "anonymous": None,
    "user": actor(),
    "steward_own": actor(roles={COMMUNITY: CommunityRole.STEWARD}),
    "steward_other": actor(roles={OTHER_COMMUNITY: CommunityRole.STEWARD}),
    "owner_own": actor(roles={COMMUNITY: CommunityRole.OWNER}),
    "owner_other": actor(roles={OTHER_COMMUNITY: CommunityRole.OWNER}),
    "admin": actor(admin=True),
    "admin_other_world": actor(world=OTHER_WORLD, admin=True),
    "treasury": actor(kind=UserKind.TREASURY),
}
ROLE_NAMES = list(ROLES)

ASSET_REF = AssetRef(WORLD, ASSET, COMMUNITY)
COMMUNITY_REF = CommunityRef(WORLD, COMMUNITY)
WORLD_REF = WorldRef(WORLD)

RESOURCES: dict[Action, Resource] = {
    Action.BROWSE: ASSET_REF,
    Action.TRADE: ASSET_REF,
    Action.USE_OWN_ACCOUNT: WORLD_REF,
    Action.CREATE_COMMUNITY: WORLD_REF,
    Action.MANAGE_LISTING: ASSET_REF,
    Action.LAUNCH_IPO: ASSET_REF,
    Action.MANAGE_MEMBERS: COMMUNITY_REF,
    Action.EDIT_COMMUNITY: COMMUNITY_REF,
    Action.VIEW_COMMUNITY_DATA: COMMUNITY_REF,
    Action.OPERATE: WORLD_REF,
    Action.REVIEW_LISTING: ASSET_REF,
    Action.TAMPER_DEMO: WORLD_REF,  # the live world: sandbox only
    Action.CONTROL_DEMO: WORLD_REF,  # password sessions: demo sessions only
}

A = ALLOW
AR = Deny(DenyReason.AUTH_REQUIRED)
NF = Deny(DenyReason.NOT_FOUND)
OO = Deny(DenyReason.OWNER_ONLY)
MO = Deny(DenyReason.MEMBERS_ONLY)
AO = Deny(DenyReason.ADMIN_ONLY)
INS = Deny(DenyReason.INSIDER_TRADING_BLOCKED)
ADM = Deny(DenyReason.ADMINS_CANNOT_TRADE)
TRE = Deny(DenyReason.TREASURY_CANNOT_ACT)
SBX = Deny(DenyReason.SANDBOX_ONLY)
DSO = Deny(DenyReason.DEMO_SESSION_ONLY)

# Columns follow ROLE_NAMES:
#   anonymous, user, steward_own, steward_other, owner_own, owner_other, admin,
#   admin_other_world, treasury
MATRIX: dict[Action, tuple[Decision, ...]] = {
    Action.BROWSE: (A, A, A, A, A, A, A, NF, A),
    Action.TRADE: (AR, A, INS, A, INS, A, ADM, NF, TRE),
    Action.USE_OWN_ACCOUNT: (AR, A, A, A, A, A, A, NF, TRE),
    Action.CREATE_COMMUNITY: (AR, A, A, A, A, A, A, NF, TRE),
    Action.MANAGE_LISTING: (AR, MO, A, MO, A, MO, MO, NF, TRE),
    Action.LAUNCH_IPO: (AR, OO, OO, OO, A, OO, OO, NF, TRE),
    Action.MANAGE_MEMBERS: (AR, OO, OO, OO, A, OO, OO, NF, TRE),
    Action.EDIT_COMMUNITY: (AR, OO, OO, OO, A, OO, OO, NF, TRE),
    Action.VIEW_COMMUNITY_DATA: (AR, MO, A, MO, A, MO, A, NF, TRE),
    Action.OPERATE: (AR, AO, AO, AO, AO, AO, A, NF, TRE),
    Action.REVIEW_LISTING: (AR, AO, AO, AO, AO, AO, A, NF, TRE),
    Action.TAMPER_DEMO: (AR, AO, AO, AO, AO, AO, SBX, NF, TRE),
    Action.CONTROL_DEMO: (AR, DSO, DSO, DSO, DSO, DSO, DSO, NF, TRE),
}

CASES = [
    pytest.param(action, role, expected[i], id=f"{action.value}-{role}")
    for action, expected in MATRIX.items()
    for i, role in enumerate(ROLE_NAMES)
]


def test_the_matrix_covers_every_action_and_role() -> None:
    assert set(MATRIX) == set(Action)
    assert set(RESOURCES) == set(Action)
    assert all(len(row) == len(ROLE_NAMES) for row in MATRIX.values())


@pytest.mark.parametrize(("action", "role", "expected"), CASES)
def test_role_by_action(action: Action, role: str, expected: Decision) -> None:
    assert authorize(ROLES[role], action, RESOURCES[action]) == expected


# --- Demo sessions and sandbox worlds --------------------------------------------------------


def sandbox_actor(**kwargs: object) -> Actor:
    return actor(world=SANDBOX, session_kind=SessionKind.DEMO, **kwargs)  # type: ignore[arg-type]


def test_sandbox_worlds_are_everything_but_live_and_template() -> None:
    assert is_sandbox_world(SANDBOX)
    assert not is_sandbox_world(LIVE_WORLD_ID)
    assert not is_sandbox_world(WORLD_ID)


def test_the_tamper_demo_is_for_admins_in_their_own_sandbox_only() -> None:
    sandbox = WorldRef(SANDBOX)
    assert authorize(sandbox_actor(admin=True), Action.TAMPER_DEMO, sandbox) == A
    assert authorize(sandbox_actor(), Action.TAMPER_DEMO, sandbox) == AO
    assert authorize(sandbox_actor(admin=True), Action.TAMPER_DEMO, WorldRef(OTHER_WORLD)) == NF
    assert authorize(actor(admin=True), Action.TAMPER_DEMO, WorldRef(WORLD)) == SBX


def test_demo_controls_need_a_demo_session_in_the_same_world() -> None:
    sandbox = WorldRef(SANDBOX)
    for persona in (sandbox_actor(), sandbox_actor(admin=True)):
        assert authorize(persona, Action.CONTROL_DEMO, sandbox) == A
    assert authorize(sandbox_actor(), Action.CONTROL_DEMO, WorldRef(WORLD)) == NF


def test_a_demo_admin_is_admin_only_inside_its_sandbox() -> None:
    demo_admin = sandbox_actor(admin=True)
    assert authorize(demo_admin, Action.OPERATE, WorldRef(SANDBOX)) == A
    assert authorize(demo_admin, Action.OPERATE, WorldRef(LIVE_WORLD_ID)) == NF


def test_anonymous_visitors_browse_the_live_world_only() -> None:
    assert authorize(None, Action.BROWSE, ASSET_REF) == A
    assert authorize(None, Action.BROWSE, AssetRef(SANDBOX, ASSET, COMMUNITY)) == NF
    assert authorize(None, Action.BROWSE, CommunityRef(WORLD_ID, COMMUNITY)) == NF


def test_members_of_one_community_trade_other_communities_assets() -> None:
    steward = actor(roles={COMMUNITY: CommunityRole.STEWARD})
    elsewhere = AssetRef(WORLD, uuid4(), OTHER_COMMUNITY)
    assert authorize(steward, Action.TRADE, elsewhere) == A
    assert authorize(steward, Action.TRADE, AssetRef(WORLD, uuid4(), None)) == A


def test_an_asset_without_a_community_has_no_stewards() -> None:
    orphan = AssetRef(WORLD, uuid4(), None)
    owner = actor(roles={COMMUNITY: CommunityRole.OWNER})
    assert authorize(owner, Action.MANAGE_LISTING, orphan) == MO
    assert authorize(owner, Action.LAUNCH_IPO, orphan) == OO


def test_personas_are_signed_in_users() -> None:
    persona = sandbox_actor(kind=UserKind.PERSONA)
    assert authorize(persona, Action.TRADE, AssetRef(SANDBOX, ASSET, COMMUNITY)) == A


# --- Adding a member ------------------------------------------------------------------------


def candidate(
    *, kind: UserKind = UserKind.PERSON, holds: bool = False, world: UUID = WORLD
) -> MemberCandidate:
    return MemberCandidate(world, COMMUNITY, uuid4(), kind, holds)


def test_an_owner_adds_a_member_who_holds_none_of_the_communitys_shares() -> None:
    assert authorize(ROLES["owner_own"], Action.MANAGE_MEMBERS, candidate()) == A


def test_a_holder_of_the_communitys_shares_cannot_join() -> None:
    decision = authorize(ROLES["owner_own"], Action.MANAGE_MEMBERS, candidate(holds=True))
    assert decision == Deny(DenyReason.MEMBER_HAS_HOLDINGS)
    assert isinstance(decision, Deny) and decision.status_code == 409


def test_a_treasury_cannot_join() -> None:
    decision = authorize(
        ROLES["owner_own"], Action.MANAGE_MEMBERS, candidate(kind=UserKind.TREASURY)
    )
    assert decision == Deny(DenyReason.MEMBER_NOT_ELIGIBLE)


@pytest.mark.parametrize("role", ["user", "steward_own", "owner_other", "admin"])
def test_non_owners_learn_nothing_about_the_candidates_holdings(role: str) -> None:
    assert authorize(ROLES[role], Action.MANAGE_MEMBERS, candidate(holds=True)) == OO


def test_a_candidate_from_another_world_is_not_found() -> None:
    owner = ROLES["owner_own"]
    assert authorize(owner, Action.MANAGE_MEMBERS, candidate(world=OTHER_WORLD)) == NF


@pytest.mark.parametrize(
    ("reason", "code"),
    [
        (DenyReason.AUTH_REQUIRED, 401),
        (DenyReason.NOT_FOUND, 404),
        (DenyReason.MEMBER_HAS_HOLDINGS, 409),
        (DenyReason.MEMBER_NOT_ELIGIBLE, 409),
        (DenyReason.OWNER_ONLY, 403),
        (DenyReason.INSIDER_TRADING_BLOCKED, 403),
        (DenyReason.ADMINS_CANNOT_TRADE, 403),
        (DenyReason.TREASURY_CANNOT_ACT, 403),
    ],
)
def test_deny_status_codes(reason: DenyReason, code: int) -> None:
    assert Deny(reason).status_code == code

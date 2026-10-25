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
    DemoTarget,
    Deny,
    DenyReason,
    MemberCandidate,
    MemberRef,
    Resource,
    WorldRef,
    authorize,
    can_see,
)
from app.models import CommunityRole, SessionKind, UserKind
from app.worlds import LIVE_WORLD_ID, WORLD_ID, is_sandbox_world

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
    # Combined roles.
    "admin_owner_own": actor(admin=True, roles={COMMUNITY: CommunityRole.OWNER}),
    "admin_steward_own": actor(admin=True, roles={COMMUNITY: CommunityRole.STEWARD}),
    "owner_own_steward_other": actor(
        roles={COMMUNITY: CommunityRole.OWNER, OTHER_COMMUNITY: CommunityRole.STEWARD}
    ),
    "steward_own_owner_other": actor(
        roles={COMMUNITY: CommunityRole.STEWARD, OTHER_COMMUNITY: CommunityRole.OWNER}
    ),
}
ROLE_NAMES = list(ROLES)

ASSET_REF = AssetRef(WORLD, ASSET, COMMUNITY, public=True)
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
    Action.OPERATE: ASSET_REF,  # suspend or resume
    Action.SIMULATE: WORLD_REF,  # the Time Machine; sandboxes are below
    Action.REVIEW_LISTING: ASSET_REF,
    Action.TAMPER_DEMO: DemoTarget(WORLD, demo_mode=True),  # the live world: sandbox only
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
COI = Deny(DenyReason.CONFLICT_OF_INTEREST)

# Columns follow ROLE_NAMES:
#   anonymous, user, steward_own, steward_other, owner_own, owner_other, admin,
#   admin_other_world, treasury | admin_owner_own, admin_steward_own, owner_own_steward_other,
#   steward_own_owner_other
MATRIX: dict[Action, tuple[Decision, ...]] = {
    Action.BROWSE: (A, A, A, A, A, A, A, NF, A, A, A, A, A),
    Action.TRADE: (AR, A, INS, A, INS, A, ADM, NF, TRE, ADM, ADM, INS, INS),
    Action.USE_OWN_ACCOUNT: (AR, A, A, A, A, A, A, NF, TRE, A, A, A, A),
    Action.CREATE_COMMUNITY: (AR, A, A, A, A, A, A, NF, TRE, A, A, A, A),
    Action.MANAGE_LISTING: (AR, MO, A, MO, A, MO, MO, NF, TRE, A, A, A, A),
    Action.LAUNCH_IPO: (AR, OO, OO, OO, A, OO, OO, NF, TRE, A, OO, A, OO),
    Action.MANAGE_MEMBERS: (AR, OO, OO, OO, A, OO, OO, NF, TRE, A, OO, A, OO),
    Action.EDIT_COMMUNITY: (AR, OO, OO, OO, A, OO, OO, NF, TRE, A, OO, A, OO),
    Action.VIEW_COMMUNITY_DATA: (AR, MO, A, MO, A, MO, A, NF, TRE, A, A, A, A),
    Action.OPERATE: (AR, AO, AO, AO, AO, AO, A, NF, TRE, COI, COI, AO, AO),
    Action.SIMULATE: (AR, AO, AO, AO, AO, AO, A, NF, TRE, A, A, AO, AO),
    Action.REVIEW_LISTING: (AR, AO, AO, AO, AO, AO, A, NF, TRE, COI, COI, AO, AO),
    Action.TAMPER_DEMO: (AR, AO, AO, AO, AO, AO, SBX, NF, TRE, SBX, SBX, AO, AO),
    Action.CONTROL_DEMO: (AR, DSO, DSO, DSO, DSO, DSO, DSO, NF, TRE, DSO, DSO, DSO, DSO),
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
    sandbox = DemoTarget(SANDBOX, demo_mode=True)
    assert authorize(sandbox_actor(admin=True), Action.TAMPER_DEMO, sandbox) == A
    assert authorize(sandbox_actor(), Action.TAMPER_DEMO, sandbox) == AO
    elsewhere = DemoTarget(OTHER_WORLD, demo_mode=True)
    assert authorize(sandbox_actor(admin=True), Action.TAMPER_DEMO, elsewhere) == NF
    assert authorize(actor(admin=True), Action.TAMPER_DEMO, DemoTarget(WORLD, True)) == SBX


def test_the_tamper_demo_needs_demo_mode() -> None:
    off = DemoTarget(SANDBOX, demo_mode=False)
    for who in (sandbox_actor(admin=True), sandbox_actor()):
        decision = authorize(who, Action.TAMPER_DEMO, off)
        assert decision == Deny(DenyReason.DEMO_MODE_OFF)
        assert isinstance(decision, Deny) and decision.status_code == 404
    assert authorize(None, Action.TAMPER_DEMO, off) == AR


@pytest.mark.parametrize("role", ["admin", "admin_owner_own", "admin_steward_own"])
def test_admins_run_the_time_machine_whatever_their_memberships(role: str) -> None:
    assert authorize(ROLES[role], Action.OPERATE, WORLD_REF) == A


def test_an_admin_member_operates_and_reviews_other_communities_assets() -> None:
    elsewhere = AssetRef(WORLD, uuid4(), OTHER_COMMUNITY, public=True)
    for role in ("admin_owner_own", "admin_steward_own"):
        assert authorize(ROLES[role], Action.OPERATE, elsewhere) == A
        assert authorize(ROLES[role], Action.REVIEW_LISTING, elsewhere) == A


def test_only_admins_read_the_review_queue() -> None:
    """REVIEW_LISTING on the world (T69's queue); the queue itself leaves out the admin's own
    communities' listings."""
    for role in ("admin", "admin_owner_own", "admin_steward_own"):
        assert authorize(ROLES[role], Action.REVIEW_LISTING, WORLD_REF) == A
    for role in ("user", "owner_own"):
        assert authorize(ROLES[role], Action.REVIEW_LISTING, WORLD_REF) == AO
    assert authorize(None, Action.REVIEW_LISTING, WORLD_REF) == AR


@pytest.mark.parametrize(
    ("action", "resource"),
    [
        (Action.TRADE, COMMUNITY_REF),
        (Action.TRADE, WORLD_REF),
        (Action.REVIEW_LISTING, COMMUNITY_REF),
        (Action.VIEW_COMMUNITY_DATA, WORLD_REF),
        (Action.MANAGE_LISTING, COMMUNITY_REF),
        (Action.TAMPER_DEMO, WORLD_REF),
        (Action.CONTROL_DEMO, ASSET_REF),
        (Action.BROWSE, DemoTarget(WORLD, demo_mode=True)),
    ],
)
def test_a_resource_the_action_doesnt_take_is_denied(action: Action, resource: Resource) -> None:
    for role in ("user", "owner_own", "admin"):
        assert authorize(ROLES[role], action, resource) == Deny(DenyReason.INVALID_RESOURCE)


def test_demo_controls_need_a_demo_session_in_the_same_world() -> None:
    sandbox = WorldRef(SANDBOX)
    for persona in (sandbox_actor(), sandbox_actor(admin=True)):
        assert authorize(persona, Action.CONTROL_DEMO, sandbox) == A
    assert authorize(sandbox_actor(), Action.CONTROL_DEMO, WorldRef(WORLD)) == NF


def test_a_demo_admin_is_admin_only_inside_its_sandbox() -> None:
    demo_admin = sandbox_actor(admin=True)
    assert authorize(demo_admin, Action.OPERATE, WorldRef(SANDBOX)) == A
    assert authorize(demo_admin, Action.OPERATE, WorldRef(LIVE_WORLD_ID)) == NF


def test_anyone_in_a_sandbox_runs_its_time_machine_and_injects_its_events() -> None:
    """The sandbox's own demo control (ADR-0008): not an operator's power there."""
    own_asset = AssetRef(SANDBOX, ASSET, COMMUNITY, public=True)
    for persona in (
        sandbox_actor(),
        sandbox_actor(roles={COMMUNITY: CommunityRole.OWNER}),
        sandbox_actor(admin=True),
    ):
        assert authorize(persona, Action.SIMULATE, WorldRef(SANDBOX)) == A
        assert authorize(persona, Action.SIMULATE, own_asset) == A
        assert authorize(persona, Action.SIMULATE, WorldRef(OTHER_WORLD)) == NF
    # Outside a sandbox it stays an impartial admin's action, as OPERATE.
    assert authorize(actor(), Action.SIMULATE, WORLD_REF) == AO
    assert authorize(actor(world=SANDBOX), Action.SIMULATE, WorldRef(SANDBOX)) == AO
    assert authorize(ROLES["admin_owner_own"], Action.SIMULATE, ASSET_REF) == COI
    # Operating an asset (suspend, re-rate) is still for admins only, sandbox or not.
    assert authorize(sandbox_actor(), Action.OPERATE, own_asset) == AO


def test_anonymous_visitors_browse_the_live_world_only() -> None:
    assert authorize(None, Action.BROWSE, ASSET_REF) == A
    assert authorize(None, Action.BROWSE, AssetRef(SANDBOX, ASSET, COMMUNITY, public=True)) == NF
    assert authorize(None, Action.BROWSE, CommunityRef(WORLD_ID, COMMUNITY)) == NF


def test_members_of_one_community_trade_other_communities_assets() -> None:
    steward = actor(roles={COMMUNITY: CommunityRole.STEWARD})
    elsewhere = AssetRef(WORLD, uuid4(), OTHER_COMMUNITY, public=True)
    assert authorize(steward, Action.TRADE, elsewhere) == A
    assert authorize(steward, Action.TRADE, AssetRef(WORLD, uuid4(), None, public=True)) == A


def test_an_asset_without_a_community_has_no_stewards() -> None:
    orphan = AssetRef(WORLD, uuid4(), None, public=True)
    owner = actor(roles={COMMUNITY: CommunityRole.OWNER})
    assert authorize(owner, Action.MANAGE_LISTING, orphan) == MO
    assert authorize(owner, Action.LAUNCH_IPO, orphan) == OO


def test_personas_are_signed_in_users() -> None:
    persona = sandbox_actor(kind=UserKind.PERSONA)
    assert authorize(persona, Action.TRADE, AssetRef(SANDBOX, ASSET, COMMUNITY, public=True)) == A


# --- Adding a member ------------------------------------------------------------------------


def candidate(
    *,
    kind: UserKind = UserKind.PERSON,
    admin: bool = False,
    holds: bool = False,
    world: UUID = WORLD,
) -> MemberCandidate:
    return MemberCandidate(world, COMMUNITY, uuid4(), kind, admin, holds)


def test_an_owner_adds_a_member_who_holds_none_of_the_communitys_shares() -> None:
    assert authorize(ROLES["owner_own"], Action.MANAGE_MEMBERS, candidate()) == A


def test_a_holder_of_the_communitys_shares_cannot_join() -> None:
    decision = authorize(ROLES["owner_own"], Action.MANAGE_MEMBERS, candidate(holds=True))
    assert decision == Deny(DenyReason.MEMBER_HAS_HOLDINGS)
    assert isinstance(decision, Deny) and decision.status_code == 409


@pytest.mark.parametrize(
    "who", [candidate(kind=UserKind.TREASURY), candidate(admin=True)], ids=["treasury", "admin"]
)
def test_treasuries_and_admins_cannot_join(who: MemberCandidate) -> None:
    decision = authorize(ROLES["owner_own"], Action.MANAGE_MEMBERS, who)
    assert decision == Deny(DenyReason.MEMBER_NOT_ELIGIBLE)
    assert isinstance(decision, Deny) and decision.status_code == 409


def test_a_member_may_leave_and_only_the_owner_removes_others() -> None:
    steward = ROLES["steward_own"]
    assert isinstance(steward, Actor)
    leave = MemberRef(WORLD, COMMUNITY, steward.user_id)
    assert authorize(steward, Action.MANAGE_MEMBERS, leave) == A
    someone = MemberRef(WORLD, COMMUNITY, uuid4())
    assert authorize(steward, Action.MANAGE_MEMBERS, someone) == OO
    assert authorize(ROLES["owner_own"], Action.MANAGE_MEMBERS, someone) == A
    # "Leaving" a community you don't belong to is just removing someone: owner only.
    outsider = ROLES["steward_other"]
    assert isinstance(outsider, Actor)
    mine = MemberRef(WORLD, COMMUNITY, outsider.user_id)
    assert authorize(outsider, Action.MANAGE_MEMBERS, mine) == OO


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
        (DenyReason.DEMO_MODE_OFF, 404),
        (DenyReason.CONFLICT_OF_INTEREST, 403),
        (DenyReason.INVALID_RESOURCE, 403),
        (DenyReason.OWNER_ONLY, 403),
        (DenyReason.INSIDER_TRADING_BLOCKED, 403),
        (DenyReason.ADMINS_CANNOT_TRADE, 403),
        (DenyReason.TREASURY_CANNOT_ACT, 403),
    ],
)
def test_deny_status_codes(reason: DenyReason, code: int) -> None:
    assert Deny(reason).status_code == code


# --- Listings under review (T58 visibility, enforced by the policy since T57) -----------------

PRIVATE_ASSET = AssetRef(WORLD, ASSET, COMMUNITY, public=False)
NF = Deny(DenyReason.NOT_FOUND)
SEES_PRIVATE = {"steward_own", "owner_own", "admin", "admin_owner_own", "admin_steward_own"}
SEES_PRIVATE |= {"owner_own_steward_other", "steward_own_owner_other"}


@pytest.mark.parametrize("role", ROLE_NAMES)
def test_a_listing_under_review_is_browsable_by_its_community_and_admins_only(role: str) -> None:
    decision = authorize(ROLES[role], Action.BROWSE, PRIVATE_ASSET)
    assert decision == (A if role in SEES_PRIVATE else NF)
    assert can_see(ROLES[role], PRIVATE_ASSET) is (role in SEES_PRIVATE)


@pytest.mark.parametrize("role", ROLE_NAMES)
def test_trading_a_listing_under_review_is_not_found_for_outsiders(role: str) -> None:
    """Insiders and admins still get their own reasons; anyone else learns nothing."""
    decision = authorize(ROLES[role], Action.TRADE, PRIVATE_ASSET)
    if role == "anonymous":
        assert decision == Deny(DenyReason.AUTH_REQUIRED)
    elif role not in SEES_PRIVATE:
        assert decision == NF
    else:
        assert decision == authorize(ROLES[role], Action.TRADE, ASSET_REF)


@pytest.mark.parametrize(
    "action",
    [Action.MANAGE_LISTING, Action.LAUNCH_IPO, Action.VIEW_COMMUNITY_DATA, Action.OPERATE],
)
@pytest.mark.parametrize("role", ROLE_NAMES)
def test_every_action_on_a_listing_under_review_is_not_found_for_outsiders(
    action: Action, role: str
) -> None:
    """A 403 would reveal the listing; those who can see it get the usual decision."""
    decision = authorize(ROLES[role], action, PRIVATE_ASSET)
    if role == "anonymous":
        assert decision == Deny(DenyReason.AUTH_REQUIRED)
    elif role not in SEES_PRIVATE:
        assert decision == NF
    else:
        assert decision == authorize(ROLES[role], action, ASSET_REF)

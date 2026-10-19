"""Authorization policy (ADR-0005 §3, ADR-0006 §3; T68).

`authorize(actor, action, resource)` is pure: it decides from the actor (who is acting, in which
world, with which community roles) and a small typed description of the resource, and never
touches the database. Routes reach it through `require(action, loader)`, which resolves the
actor from the session, loads the resource by `(world_id, id)` and turns a `Deny` into an HTTP
error: 401 `auth_required`, 404 for anything outside the actor's world, 409 for state conflicts
and 403 with a machine-readable reason otherwise.

The policy covers every row of the ADR-0005 role × action matrix; T57 applies it to every route.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Annotated, Any, TypeVar
from uuid import UUID

from fastapi import Depends, HTTPException, Path, status
from sqlmodel import Session, select

from app.auth import Principal
from app.deps import OptionalPrincipal, SessionDep, SettingsDep, world_for
from app.models import (
    Asset,
    AssetStatus,
    Community,
    CommunityMember,
    CommunityRole,
    SessionKind,
    UserKind,
)
from app.services.lifecycle import is_public
from app.worlds import LIVE_WORLD_ID, is_sandbox_world


class Action(StrEnum):
    """One value per row of the ADR-0005 matrix; row 6 is split by route, plus ADR-0006's review."""

    BROWSE = "browse"
    """Marketplace, asset, reports, prices, ledger, verify, agent trace, community profiles."""
    TRADE = "trade"
    """Buy or sell shares of an asset."""
    USE_OWN_ACCOUNT = "use_own_account"
    """Portfolio, alerts, Copilot and the caller's own memberships."""
    CREATE_COMMUNITY = "create_community"
    MANAGE_LISTING = "manage_listing"
    """Draft or edit a listing, submit it for rating, upload evidence."""
    LAUNCH_IPO = "launch_ipo"
    MANAGE_MEMBERS = "manage_members"
    EDIT_COMMUNITY = "edit_community"
    VIEW_COMMUNITY_DATA = "view_community_data"
    """A community's own data: wallet, holders, payouts and its member list."""
    OPERATE = "operate"
    """Time Machine, inject events (on the world), suspend or resume an asset (on the asset)."""
    REVIEW_LISTING = "review_listing"
    """Approve, reject or revoke a listing's verification (ADR-0006 §3: admin in the hackathon)."""
    TAMPER_DEMO = "tamper_demo"
    """The ledger tamper demo: admins, sandbox worlds and `DEMO_MODE` only."""
    CONTROL_DEMO = "control_demo"
    """Reset my demo, switch persona."""


PUBLIC_ACTIONS = frozenset({Action.BROWSE})


class DenyReason(StrEnum):
    AUTH_REQUIRED = "auth_required"
    NOT_FOUND = "not_found"
    OWNER_ONLY = "owner_only"
    MEMBERS_ONLY = "members_only"
    ADMIN_ONLY = "admin_only"
    INSIDER_TRADING_BLOCKED = "insider_trading_blocked"
    ADMINS_CANNOT_TRADE = "admins_cannot_trade"
    TREASURY_CANNOT_ACT = "treasury_cannot_act"
    SANDBOX_ONLY = "sandbox_only"
    DEMO_SESSION_ONLY = "demo_session_only"
    DEMO_MODE_OFF = "demo_mode_off"
    CONFLICT_OF_INTEREST = "conflict_of_interest"
    """An admin acting as operator or reviewer on an asset of a community it belongs to."""
    INVALID_RESOURCE = "invalid_resource"
    """The route passed a resource type the action doesn't take: a bug, so fail closed."""
    MEMBER_HAS_HOLDINGS = "member_has_holdings"
    MEMBER_NOT_ELIGIBLE = "member_not_eligible"


DENY_STATUS: Mapping[DenyReason, int] = {
    DenyReason.AUTH_REQUIRED: status.HTTP_401_UNAUTHORIZED,
    DenyReason.NOT_FOUND: status.HTTP_404_NOT_FOUND,
    # With DEMO_MODE off the tamper demo doesn't exist, as before T68.
    DenyReason.DEMO_MODE_OFF: status.HTTP_404_NOT_FOUND,
    DenyReason.MEMBER_HAS_HOLDINGS: status.HTTP_409_CONFLICT,
    DenyReason.MEMBER_NOT_ELIGIBLE: status.HTTP_409_CONFLICT,
}


@dataclass(frozen=True)
class Allow:
    pass


@dataclass(frozen=True)
class Deny:
    reason: DenyReason

    @property
    def status_code(self) -> int:
        return DENY_STATUS.get(self.reason, status.HTTP_403_FORBIDDEN)


Decision = Allow | Deny
ALLOW = Allow()


@dataclass(frozen=True)
class Actor:
    """A signed-in principal plus its community roles in its own world. Anonymous is `None`."""

    user_id: UUID
    world_id: UUID
    user_kind: UserKind
    is_admin: bool
    session_kind: SessionKind
    memberships: Mapping[UUID, CommunityRole] = field(default_factory=dict)

    @classmethod
    def of(cls, principal: Principal, memberships: Mapping[UUID, CommunityRole]) -> Actor:
        return cls(
            user_id=principal.user_id,
            world_id=principal.world_id,
            user_kind=principal.user_kind,
            is_admin=principal.is_admin,
            session_kind=principal.session_kind,
            memberships=dict(memberships),
        )

    def role_in(self, community_id: UUID | None) -> CommunityRole | None:
        return None if community_id is None else self.memberships.get(community_id)


# --- Resources: the facts the policy needs, loaded by (world_id, id) -------------------------


@dataclass(frozen=True)
class WorldRef:
    """World-level actions: browse, own account, create a community, operate, demo controls."""

    world_id: UUID


@dataclass(frozen=True)
class DemoTarget:
    """The tamper demo's target world, with the deployment's `DEMO_MODE` setting."""

    world_id: UUID
    demo_mode: bool


@dataclass(frozen=True)
class CommunityRef:
    world_id: UUID
    community_id: UUID


@dataclass(frozen=True)
class AssetRef:
    world_id: UUID
    asset_id: UUID
    community_id: UUID | None
    public: bool
    """Listed or suspended (T58). A listing under review is visible only to its community and
    same-world admins; every action on it is `not_found` for anyone else. No default: every
    loader sets it from the asset's status (`asset_ref_in`, `asset_ref_of`)."""


@dataclass(frozen=True)
class MemberRef:
    """An existing membership to remove (MANAGE_MEMBERS): the owner's job, or a member leaving."""

    world_id: UUID
    community_id: UUID
    user_id: UUID


@dataclass(frozen=True)
class MemberCandidate:
    """A user an owner wants to add to a community (MANAGE_MEMBERS)."""

    world_id: UUID
    community_id: UUID
    user_id: UUID
    user_kind: UserKind
    is_admin: bool
    holds_community_shares: bool


Resource = WorldRef | DemoTarget | CommunityRef | AssetRef | MemberRef | MemberCandidate

# The resource types each action takes; anything else is denied (fail closed).
ACCEPTS: Mapping[Action, tuple[type[Resource], ...]] = {
    Action.BROWSE: (WorldRef, CommunityRef, AssetRef),
    Action.TRADE: (AssetRef,),
    Action.USE_OWN_ACCOUNT: (WorldRef,),
    Action.CREATE_COMMUNITY: (WorldRef,),
    Action.MANAGE_LISTING: (AssetRef,),
    Action.LAUNCH_IPO: (AssetRef,),
    Action.MANAGE_MEMBERS: (CommunityRef, MemberRef, MemberCandidate),
    Action.EDIT_COMMUNITY: (CommunityRef,),
    Action.VIEW_COMMUNITY_DATA: (CommunityRef, AssetRef),
    Action.OPERATE: (WorldRef, AssetRef),
    Action.REVIEW_LISTING: (AssetRef,),
    Action.TAMPER_DEMO: (DemoTarget,),
    Action.CONTROL_DEMO: (WorldRef,),
}


def _community_of(resource: Resource) -> UUID | None:
    if isinstance(resource, CommunityRef | AssetRef | MemberRef | MemberCandidate):
        return resource.community_id
    return None


def can_see(actor: Actor | None, asset: AssetRef) -> bool:
    """T58's visibility rule, in one place: a public (listed or suspended) asset is visible; a
    listing under review only to its community's members and same-world admins. Which world a
    caller may read is `authorize`'s first check, not this one."""
    if asset.public:
        return True
    if actor is None or asset.world_id != actor.world_id:
        return False
    return actor.is_admin or actor.role_in(asset.community_id) is not None


def authorize(actor: Actor | None, action: Action, resource: Resource) -> Decision:
    """Allow or deny `action` on `resource` (ADR-0005 §3 matrix). Pure; no I/O."""
    # A listing under review doesn't exist for anyone who can't see it, whatever the action
    # (T58, T57): a 403 would reveal it.
    hidden = isinstance(resource, AssetRef) and not can_see(actor, resource)
    if actor is None:
        if action not in PUBLIC_ACTIONS:
            return Deny(DenyReason.AUTH_REQUIRED)
        # Anonymous visitors read the live world only; anything else doesn't exist for them.
        if resource.world_id != LIVE_WORLD_ID or hidden:
            return Deny(DenyReason.NOT_FOUND)
        return ALLOW
    if resource.world_id != actor.world_id:
        return Deny(DenyReason.NOT_FOUND)
    if not isinstance(resource, ACCEPTS[action]):
        return Deny(DenyReason.INVALID_RESOURCE)
    if hidden:
        return Deny(DenyReason.NOT_FOUND)
    if action in PUBLIC_ACTIONS:
        return ALLOW
    if actor.user_kind == UserKind.TREASURY:
        return Deny(DenyReason.TREASURY_CANNOT_ACT)
    return _RULES[action](actor, resource)


def _signed_in(actor: Actor, resource: Resource) -> Decision:
    return ALLOW


def _trade(actor: Actor, resource: Resource) -> Decision:
    if not isinstance(resource, AssetRef):
        return Deny(DenyReason.INVALID_RESOURCE)
    if actor.is_admin:
        return Deny(DenyReason.ADMINS_CANNOT_TRADE)
    if actor.role_in(resource.community_id) is not None:
        return Deny(DenyReason.INSIDER_TRADING_BLOCKED)
    return ALLOW


def _members(actor: Actor, resource: Resource) -> Decision:
    if actor.role_in(_community_of(resource)) is not None:
        return ALLOW
    return Deny(DenyReason.MEMBERS_ONLY)


def _members_or_admin(actor: Actor, resource: Resource) -> Decision:
    return ALLOW if actor.is_admin else _members(actor, resource)


def _owner(actor: Actor, resource: Resource) -> Decision:
    if actor.role_in(_community_of(resource)) == CommunityRole.OWNER:
        return ALLOW
    return Deny(DenyReason.OWNER_ONLY)


def _manage_members(actor: Actor, resource: Resource) -> Decision:
    if (
        isinstance(resource, MemberRef)
        and resource.user_id == actor.user_id
        and actor.role_in(resource.community_id) is not None
    ):
        return ALLOW  # a member may leave; the owner can't (a state rule, 409)
    decision = _owner(actor, resource)
    if isinstance(decision, Deny) or not isinstance(resource, MemberCandidate):
        return decision
    # Treasuries never act; admins operate and review the community's assets, so they stay out.
    if resource.user_kind == UserKind.TREASURY or resource.is_admin:
        return Deny(DenyReason.MEMBER_NOT_ELIGIBLE)
    # Members can't trade their community's asset, so a holder would be trapped in a position.
    if resource.holds_community_shares:
        return Deny(DenyReason.MEMBER_HAS_HOLDINGS)
    return ALLOW


def _impartial_admin(actor: Actor, resource: Resource) -> Decision:
    """Admins only, and never on an asset of a community the admin belongs to."""
    if not actor.is_admin:
        return Deny(DenyReason.ADMIN_ONLY)
    if actor.role_in(_community_of(resource)) is not None:
        return Deny(DenyReason.CONFLICT_OF_INTEREST)
    return ALLOW


def _tamper_demo(actor: Actor, resource: Resource) -> Decision:
    if not isinstance(resource, DemoTarget) or not resource.demo_mode:
        return Deny(DenyReason.DEMO_MODE_OFF)
    if not actor.is_admin:
        return Deny(DenyReason.ADMIN_ONLY)
    if not is_sandbox_world(resource.world_id):
        return Deny(DenyReason.SANDBOX_ONLY)
    return ALLOW


def _demo_session(actor: Actor, resource: Resource) -> Decision:
    if actor.session_kind != SessionKind.DEMO:
        return Deny(DenyReason.DEMO_SESSION_ONLY)
    return ALLOW


_RULES: Mapping[Action, Callable[[Actor, Resource], Decision]] = {
    Action.TRADE: _trade,
    Action.USE_OWN_ACCOUNT: _signed_in,
    Action.CREATE_COMMUNITY: _signed_in,
    Action.MANAGE_LISTING: _members,
    Action.LAUNCH_IPO: _owner,
    Action.MANAGE_MEMBERS: _manage_members,
    Action.EDIT_COMMUNITY: _owner,
    Action.VIEW_COMMUNITY_DATA: _members_or_admin,
    Action.OPERATE: _impartial_admin,
    Action.REVIEW_LISTING: _impartial_admin,
    Action.TAMPER_DEMO: _tamper_demo,
    Action.CONTROL_DEMO: _demo_session,
}


# --- FastAPI glue ----------------------------------------------------------------------------


def deny_error(decision: Deny) -> HTTPException:
    headers = {"Cache-Control": "no-store"}
    return HTTPException(decision.status_code, decision.reason.value, headers=headers)


def denied(*reasons: DenyReason) -> dict[int | str, dict[str, Any]]:
    """The OpenAPI entry for a route's 403s: the policy reasons it can return."""
    codes = ", ".join(f"`{reason.value}`" for reason in reasons)
    return {403: {"description": f"Not allowed: {codes}"}}


def enforce(actor: Actor | None, action: Action, resource: Resource) -> None:
    """Raise the HTTP error for a denial; for checks a route makes after loading more data."""
    decision = authorize(actor, action, resource)
    if isinstance(decision, Deny):
        raise deny_error(decision)


def memberships(session: Session, world_id: UUID, user_id: UUID) -> dict[UUID, CommunityRole]:
    rows = session.exec(
        select(CommunityMember.community_id, CommunityMember.role).where(
            CommunityMember.world_id == world_id, CommunityMember.user_id == user_id
        )
    ).all()
    return {community_id: CommunityRole(role) for community_id, role in rows}


class LazyMemberships(Mapping[UUID, CommunityRole]):
    """An actor's community roles, read on first use: public actions (BROWSE) never need them,
    so reads don't query `community_members`."""

    def __init__(self, load: Callable[[], Mapping[UUID, CommunityRole]]) -> None:
        self._load = load
        self._roles: Mapping[UUID, CommunityRole] | None = None

    def _get(self) -> Mapping[UUID, CommunityRole]:
        if self._roles is None:
            self._roles = dict(self._load())
        return self._roles

    def __getitem__(self, community_id: UUID) -> CommunityRole:
        return self._get()[community_id]

    def __iter__(self) -> Iterator[UUID]:
        return iter(self._get())

    def __len__(self) -> int:
        return len(self._get())


def lazy_actor(session: Session, principal: Principal) -> Actor:
    """The principal as an actor whose memberships are read only if a check needs them (in
    `session`, which must still be open then)."""
    roles = LazyMemberships(lambda: memberships(session, principal.world_id, principal.user_id))
    return Actor(
        user_id=principal.user_id,
        world_id=principal.world_id,
        user_kind=principal.user_kind,
        is_admin=principal.is_admin,
        session_kind=principal.session_kind,
        memberships=roles,
    )


def fresh_actor(session: Session, principal: Principal) -> Actor:
    """The principal with its memberships as of now.

    Trade paths call this again after locking the trader's user row and `enforce` TRADE with
    it: an owner adding a steward locks the same row, so the membership read here is current.
    """
    return Actor.of(principal, memberships(session, principal.world_id, principal.user_id))


def optional_actor(principal: OptionalPrincipal, session: SessionDep) -> Actor | None:
    """The request's actor, from its session. A session bound to a world it may not use (a demo
    session outside its sandbox, a password session outside the live world) is 401, exactly as
    `CurrentWorld` refuses it (T73), so routes that only use `require` get the same check."""
    if principal is None:
        return None
    world_for(session, principal)
    return lazy_actor(session, principal)


OptionalActor = Annotated[Actor | None, Depends(optional_actor)]


def acting_world(actor: Actor | None) -> UUID:
    """The world a request acts in: the session's, or the live world when anonymous."""
    return LIVE_WORLD_ID if actor is None else actor.world_id


def world_ref(actor: OptionalActor) -> WorldRef:
    return WorldRef(acting_world(actor))


def demo_target(actor: OptionalActor, settings: SettingsDep) -> DemoTarget:
    """The tamper demo's resource: `DEMO_MODE` is enforced by the policy, not the route."""
    return DemoTarget(acting_world(actor), settings.demo_mode)


def community_ref(
    community_id: Annotated[UUID, Path()], actor: OptionalActor, session: SessionDep
) -> CommunityRef | None:
    """The community by `(world_id, id)` in the actor's world, or None (a 404)."""
    world_id = acting_world(actor)
    found = session.exec(
        select(Community.id).where(Community.world_id == world_id, Community.id == community_id)
    ).first()
    return None if found is None else CommunityRef(world_id, found)


def member_ref(
    community_id: Annotated[UUID, Path()],
    user_id: Annotated[UUID, Path()],
    actor: OptionalActor,
    session: SessionDep,
) -> MemberRef | None:
    """A membership slot `(community, user)` in the actor's world; None if the community isn't."""
    community = community_ref(community_id, actor, session)
    return None if community is None else MemberRef(community.world_id, community_id, user_id)


def asset_ref(
    asset_id: Annotated[UUID, Path()], actor: OptionalActor, session: SessionDep
) -> AssetRef | None:
    """The asset by `(world_id, id)` in the actor's world, with its community, or None (a 404)."""
    return asset_ref_in(session, acting_world(actor), asset_id)


def asset_ref_in(session: Session, world_id: UUID, asset_id: UUID) -> AssetRef | None:
    """`asset_ref` for an ID that doesn't come from the path (a request body or query)."""
    found = session.exec(
        select(Asset.id, Asset.community_id, Asset.status).where(
            Asset.world_id == world_id, Asset.id == asset_id
        )
    ).first()
    if found is None:
        return None
    asset_id, community_id, asset_status = found
    return AssetRef(world_id, asset_id, community_id, public=is_public(AssetStatus(asset_status)))


def asset_ref_of(asset: Asset) -> AssetRef:
    """The policy's view of a loaded asset (its visibility from its status)."""
    return AssetRef(asset.world_id, asset.id, asset.community_id, public=is_public(asset.status))


@dataclass(frozen=True)
class Granted:
    """What a route gets once `require` allowed it."""

    actor: Actor | None
    resource: Resource

    @property
    def signed_in(self) -> Actor:
        if self.actor is None:  # only reachable for public actions
            raise deny_error(Deny(DenyReason.AUTH_REQUIRED))
        return self.actor


ResourceLoader = Callable[..., Resource | None]


def require(action: Action, loader: ResourceLoader = world_ref) -> Any:
    """A dependency that authorizes `action` on the resource `loader` returns.

    Anonymous callers get 401 for non-public actions before the resource is looked at, so a 404
    never tells them whether an ID exists; a resource missing from the actor's world is a 404.
    Use as `granted: Annotated[Granted, require(Action.X, community_ref)]`.

    The actor's memberships are read before the route takes any lock. A route whose decision
    can be invalidated by a concurrent membership change must take its lock, then call
    `enforce(fresh_actor(session, principal), ...)` again. In particular every trade path
    (T57) locks the trader's user row and re-checks TRADE with fresh memberships, because
    adding a steward locks that same row: otherwise an order authorized before the
    membership commits could still buy the community's asset after it.

    Every route declares one of these (or an `authorizes` dependency); the route-inventory test
    enforces it (T57).
    """

    return require_any((action,), loader)


def require_any(actions: tuple[Action, ...], loader: ResourceLoader = world_ref) -> Any:
    """Like `require`, allowing the request if *any* of `actions` is allowed on the resource.

    A denial reports the first action's reason, so list the usual one first. Used where one
    route serves two matrix rows: a rating run is an operator's re-rate (OPERATE) or the
    community's own listing management (MANAGE_LISTING).
    """
    if not actions:
        raise ValueError("require_any needs at least one action")
    public = all(action in PUBLIC_ACTIONS for action in actions)

    # Runs before the loader (dependencies resolve in signature order), so an anonymous caller
    # never reaches a resource lookup or a request-body error before its 401.
    def signed_in_gate(actor: OptionalActor) -> None:
        if actor is None and not public:
            raise deny_error(Deny(DenyReason.AUTH_REQUIRED))

    # A default, not `Annotated[..., Depends(loader)]`: with postponed annotations FastAPI
    # resolves annotation strings in module globals, where the local `loader` isn't visible.
    def dependency(
        actor: OptionalActor,
        _gate: None = Depends(signed_in_gate),  # noqa: B008
        resource: Resource | None = Depends(loader),  # noqa: B008
    ) -> Granted:
        if resource is None:
            raise deny_error(Deny(DenyReason.NOT_FOUND))
        decisions = [authorize(actor, action, resource) for action in actions]
        denials = [decision for decision in decisions if isinstance(decision, Deny)]
        if len(denials) == len(decisions):
            raise deny_error(denials[0])
        return Granted(actor, resource)

    dependency.__name__ = "require_" + "_or_".join(action.value for action in actions)
    return Depends(authorizes(*actions)(dependency))


AUTHORIZERS: dict[Callable[..., Any], frozenset[Action]] = {}
"""Every dependency that authorizes a request, with its actions. The route-inventory test
(`tests/test_route_authz.py`) fails for any route that has none of them."""

_F = TypeVar("_F", bound=Callable[..., Any])


def authorizes(*actions: Action) -> Callable[[_F], _F]:
    """Register a dependency that authorizes `actions` itself (via `authorize`/`enforce`).

    `require` registers its own dependencies; use this only for the rare route that can't use
    `require`, such as the SSE stream, which must not hold a pooled session while streaming.
    """

    def register(dependency: _F) -> _F:
        AUTHORIZERS[dependency] = frozenset(actions)
        return dependency

    return register

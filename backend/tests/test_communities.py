"""Community routes and the `require` dependency (ADR-0005 §3, T68)."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, delete
from sqlmodel import Session, col, select

from app.auth import SESSION_COOKIE, start_session
from app.authz import Actor, Granted, WorldRef
from app.communities import (
    MembershipConflict,
    create_community,
    get_member,
    transfer_ownership,
)
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import (
    Asset,
    Community,
    CommunityMember,
    CommunityRole,
    Holding,
    SessionKind,
    User,
    UserKind,
    UserRole,
    World,
)
from app.routers import communities as communities_router
from app.sandbox import _delete_world_rows, create_world, ensure_live_world
from app.schemas import CommunityCreate
from app.seed import LIVE_WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

pytestmark = requires_db


@pytest.fixture
def conn() -> Iterator[Connection]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        outer = connection.begin()
        yield connection
        outer.rollback()
    engine.dispose()


@pytest.fixture
def session(conn: Connection) -> Iterator[Session]:
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    seed(db)
    ensure_live_world(db)
    yield db
    db.close()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def person(session: Session, name: str, world_id: UUID = LIVE_WORLD_ID, **fields: Any) -> User:
    user = User(world_id=world_id, name=name, role=UserRole.INVESTOR, kind=UserKind.PERSON)
    for key, value in fields.items():
        setattr(user, key, value)
    session.add(user)
    session.commit()
    return user


def sign_in(client: TestClient, session: Session, user: User | None) -> TestClient:
    """Act as `user` (None signs out)."""
    client.cookies.clear()
    if user is not None:
        kind = SessionKind.PASSWORD if user.world_id == LIVE_WORLD_ID else SessionKind.DEMO
        client.cookies.set(SESSION_COOKIE, start_session(session, user, kind))
    return client


def create(client: TestClient, name: str = "Río Verde Stewards", **body: Any) -> Any:
    return client.post("/communities", json={"name": name, **body})


def seeded_live_community(session: Session) -> tuple[Community, Asset]:
    community = session.exec(
        select(Community).where(Community.world_id == LIVE_WORLD_ID).order_by(Community.name)
    ).first()
    assert community is not None
    asset = session.exec(
        select(Asset).where(Asset.world_id == LIVE_WORLD_ID, Asset.community_id == community.id)
    ).one()
    return community, asset


@pytest.fixture
def owned(session: Session, client: TestClient) -> tuple[User, UUID]:
    """A live-world person who owns a freshly created community."""
    owner = person(session, "Owner")
    response = create(sign_in(client, session, owner))
    assert response.status_code == 201, response.text
    return owner, UUID(response.json()["id"])


def add(client: TestClient, community_id: UUID, user_id: UUID) -> Any:
    return client.post(f"/communities/{community_id}/members", json={"user_id": str(user_id)})


# --- POST /communities ----------------------------------------------------------------------


def test_creating_a_community_makes_the_caller_owner_and_creates_a_treasury(
    session: Session, client: TestClient
) -> None:
    owner = person(session, "Ana")
    response = create(
        sign_in(client, session, owner),
        name="  Río   Verde Stewards ",
        country="mx",
        description="Mangrove keepers.",
    )
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["name"] == "Río Verde Stewards"
    assert body["country"] == "MX"
    assert set(body) == {"id", "name", "country", "description", "created_at"}

    session.expire_all()
    community = session.get(Community, UUID(body["id"]))
    assert community is not None and community.world_id == LIVE_WORLD_ID
    treasury = session.get(User, community.treasury_user_id)
    assert treasury is not None
    assert treasury.kind == UserKind.TREASURY
    assert treasury.cash_balance == Decimal("0.00")
    assert treasury.name == "Río Verde Stewards Treasury"
    assert treasury.email is None and treasury.password_hash is None
    members = session.exec(
        select(CommunityMember).where(CommunityMember.community_id == community.id)
    ).all()
    assert [(m.user_id, m.role) for m in members] == [(owner.id, CommunityRole.OWNER)]

    mine = client.get("/me/communities")
    assert mine.status_code == 200
    assert [(c["id"], c["role"]) for c in mine.json()] == [(body["id"], "owner")]


def test_a_demo_persona_creates_its_community_in_its_own_sandbox(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    mia = session.exec(select(User).where(User.world_id == world.id, User.persona_key == "mia"))
    response = create(sign_in(client, session, mia.one()))
    assert response.status_code == 201
    community = session.get(Community, UUID(response.json()["id"]))
    assert community is not None and community.world_id == world.id


def test_anonymous_callers_get_401(client: TestClient) -> None:
    assert create(client).json() == {"detail": "auth_required"}
    assert create(client).status_code == 401
    assert client.get("/me/communities").status_code == 401


def test_creation_needs_an_allowed_origin(session: Session, client: TestClient) -> None:
    sign_in(client, session, person(session, "Ana"))
    response = client.post("/communities", json={"name": "Abc"}, headers={"Origin": "https://x.y"})
    assert response.status_code == 403
    assert response.json() == {"detail": "csrf_origin"}


@pytest.mark.parametrize(
    "body",
    [
        {"name": "A"},
        {"name": "x" * 81},
        {"name": "<script>alert(1)</script>"},
        {"name": "Bad\x00Name"},
        {"name": "-Leading dash"},
        {"name": "   "},
        {"name": "Fine", "country": "Mexico"},
        {"name": "Fine", "description": "bell\x07"},
        {"name": "Fine", "description": "x" * 1001},
        {"name": "Fine", "treasury_user_id": str(uuid4())},
        {},
    ],
)
def test_invalid_input_is_422(session: Session, client: TestClient, body: dict[str, Any]) -> None:
    sign_in(client, session, person(session, "Ana"))
    assert client.post("/communities", json=body).status_code == 422


def test_an_account_owns_at_most_a_handful_of_communities(
    session: Session, client: TestClient
) -> None:
    sign_in(client, session, person(session, "Ana"))
    for n in range(communities_router.MAX_OWNED_COMMUNITIES):
        assert create(client, name=f"Community {n}").status_code == 201
    response = create(client, name="One too many")
    assert response.status_code == 409
    assert response.json() == {"detail": "community_limit_reached"}


# --- GET /communities/{id} ------------------------------------------------------------------


def test_anyone_reads_a_live_communitys_public_profile(
    session: Session, client: TestClient
) -> None:
    community, _ = seeded_live_community(session)
    response = client.get(f"/communities/{community.id}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["name"] == community.name
    assert "treasury_user_id" not in response.json()


def test_communities_in_other_worlds_are_not_found(session: Session, client: TestClient) -> None:
    world = create_world(session)
    sandbox_community = session.exec(select(Community).where(Community.world_id == world.id))
    other = sandbox_community.first()
    assert other is not None
    assert client.get(f"/communities/{other.id}").status_code == 404  # anonymous: live only
    sign_in(client, session, person(session, "Ana"))
    assert client.get(f"/communities/{other.id}").status_code == 404
    assert client.get(f"/communities/{uuid4()}").json() == {"detail": "not_found"}
    assert client.patch(f"/communities/{other.id}", json={"name": "Mine"}).status_code == 404
    assert add(client, other.id, uuid4()).status_code == 404


# --- PATCH /communities/{id} ----------------------------------------------------------------


def test_the_owner_edits_the_community_and_the_treasury_follows_its_name(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    _, community_id = owned
    response = client.patch(
        f"/communities/{community_id}", json={"name": "New Name", "country": "BR"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "New Name"
    assert response.json()["country"] == "BR"
    session.expire_all()
    community = session.get(Community, community_id)
    assert community is not None
    treasury = session.get(User, community.treasury_user_id)
    assert treasury is not None and treasury.name == "New Name Treasury"

    cleared = client.patch(f"/communities/{community_id}", json={"country": None})
    assert cleared.json()["country"] is None
    assert cleared.json()["name"] == "New Name"
    assert client.patch(f"/communities/{community_id}", json={"name": None}).status_code == 422


def test_only_the_owner_edits(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    _, community_id = owned
    steward = person(session, "Steward")
    assert add(client, community_id, steward.id).status_code == 201
    admin = person(session, "Admin", is_admin=True)
    for who in (steward, person(session, "Stranger"), admin):
        response = sign_in(client, session, who).patch(
            f"/communities/{community_id}", json={"name": "Taken over"}
        )
        assert response.status_code == 403
        assert response.json() == {"detail": "owner_only"}
    anonymous = sign_in(client, session, None)
    assert anonymous.patch(f"/communities/{community_id}", json={"name": "X y"}).status_code == 401
    # 401 before 404: an anonymous caller can't probe which IDs exist.
    assert anonymous.patch(f"/communities/{uuid4()}", json={"name": "X y"}).status_code == 401


# --- Members --------------------------------------------------------------------------------


def test_the_owner_adds_lists_and_removes_a_steward(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    owner, community_id = owned
    steward = person(session, "Steward")
    response = add(client, community_id, steward.id)
    assert response.status_code == 201, response.text
    assert response.json()["role"] == "steward"

    sign_in(client, session, steward)
    listed = client.get(f"/communities/{community_id}/members")
    assert listed.status_code == 200
    assert [(m["user_id"], m["role"]) for m in listed.json()] == [
        (str(owner.id), "owner"),
        (str(steward.id), "steward"),
    ]
    assert listed.headers["cache-control"] == "private, no-store"
    mine = client.get("/me/communities")
    assert mine.headers["cache-control"] == "private, no-store"
    assert [c["role"] for c in mine.json()] == ["steward"]
    # A steward can't manage members.
    assert add(client, community_id, person(session, "Other").id).json() == {"detail": "owner_only"}
    assert client.delete(f"/communities/{community_id}/members/{owner.id}").status_code == 403

    sign_in(client, session, owner)
    assert client.delete(f"/communities/{community_id}/members/{steward.id}").status_code == 204
    assert client.delete(f"/communities/{community_id}/members/{steward.id}").json() == {
        "detail": "not_a_member"
    }
    removed = client.delete(f"/communities/{community_id}/members/{owner.id}")
    assert removed.status_code == 409
    assert removed.json() == {"detail": "owner_cannot_be_removed"}


def test_the_member_list_is_for_members_and_same_world_admins(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    _, community_id = owned
    path = f"/communities/{community_id}/members"
    assert sign_in(client, session, person(session, "Admin", is_admin=True)).get(path).is_success
    stranger = sign_in(client, session, person(session, "Stranger")).get(path)
    assert stranger.status_code == 403
    assert stranger.json() == {"detail": "members_only"}
    assert sign_in(client, session, None).get(path).status_code == 401


def test_adding_a_holder_of_the_communitys_shares_is_409(
    session: Session, client: TestClient
) -> None:
    community, asset = seeded_live_community(session)
    owner = person(session, "Owner")
    session.add(
        CommunityMember(
            community_id=community.id,
            user_id=owner.id,
            world_id=LIVE_WORLD_ID,
            role=CommunityRole.OWNER,
        )
    )
    holder = person(session, "Holder")
    session.add(Holding(world_id=LIVE_WORLD_ID, user_id=holder.id, asset_id=asset.id, shares=5))
    session.commit()

    response = add(sign_in(client, session, owner), community.id, holder.id)
    assert response.status_code == 409
    assert response.json() == {"detail": "member_has_holdings"}
    # Shares sold down to zero no longer block joining.
    holding = session.get(Holding, (LIVE_WORLD_ID, holder.id, asset.id))
    assert holding is not None
    holding.shares = 0
    session.add(holding)
    session.commit()
    assert add(client, community.id, holder.id).status_code == 201


def owners_of(session: Session, community: Community) -> list[UUID]:
    return list(
        session.exec(
            select(CommunityMember.user_id).where(
                CommunityMember.community_id == community.id,
                CommunityMember.role == CommunityRole.OWNER,
            )
        ).all()
    )


def test_an_operator_hands_a_seeded_community_from_its_persona_to_a_person(
    session: Session,
) -> None:
    community, _ = seeded_live_community(session)
    [persona_id] = owners_of(session, community)
    assert session.get_one(User, persona_id).kind is UserKind.PERSONA
    lucia = person(session, "Lucía")

    assert transfer_ownership(session, community, lucia.id) is True
    session.commit()
    assert owners_of(session, community) == [lucia.id]
    assert get_member(session, community, persona_id) is None
    assert transfer_ownership(session, community, lucia.id) is False, "idempotent"

    with pytest.raises(MembershipConflict) as taken:
        transfer_ownership(session, community, person(session, "Someone else").id)
    assert taken.value.reason == "owner_is_a_person"


def test_a_handover_refuses_members_holders_and_personas(session: Session) -> None:
    community, asset = seeded_live_community(session)
    steward = person(session, "Steward")
    holder = person(session, "Holder")
    session.add(
        CommunityMember(
            community_id=community.id,
            user_id=steward.id,
            world_id=LIVE_WORLD_ID,
            role=CommunityRole.STEWARD,
        )
    )
    session.add(Holding(world_id=LIVE_WORLD_ID, user_id=holder.id, asset_id=asset.id, shares=5))
    session.commit()
    [persona_id] = owners_of(session, community)

    for user_id, reason in [
        (steward.id, "already_member"),
        (holder.id, "member_has_holdings"),
        (person(session, "Persona", kind=UserKind.PERSONA).id, "not_a_person"),
        (person(session, "Admin", role=UserRole.ADMIN, is_admin=True).id, "member_not_eligible"),
    ]:
        with pytest.raises(MembershipConflict) as refused:
            transfer_ownership(session, community, user_id)
        assert refused.value.reason == reason
    assert owners_of(session, community) == [persona_id]


def test_a_handover_needs_exactly_one_owner(session: Session) -> None:
    community, _ = seeded_live_community(session)
    session.add(
        CommunityMember(
            community_id=community.id,
            user_id=person(session, "Co-owner").id,
            world_id=LIVE_WORLD_ID,
            role=CommunityRole.OWNER,
        )
    )
    session.commit()

    with pytest.raises(MembershipConflict) as refused:
        transfer_ownership(session, community, person(session, "Lucía").id)
    assert refused.value.reason == "owner_not_unique"


def test_member_conflicts_and_unknown_users(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    owner, community_id = owned
    community = session.get(Community, community_id)
    assert community is not None
    assert add(client, community_id, owner.id).json() == {"detail": "already_member"}
    treasury = add(client, community_id, community.treasury_user_id)
    assert treasury.status_code == 409
    assert treasury.json() == {"detail": "member_not_eligible"}
    assert add(client, community_id, uuid4()).json() == {"detail": "user_not_found"}
    admin = add(client, community_id, person(session, "Admin", is_admin=True).id)
    assert admin.status_code == 409
    assert admin.json() == {"detail": "member_not_eligible"}
    elsewhere = create_world(session)
    persona = session.exec(select(User).where(User.world_id == elsewhere.id)).first()
    assert persona is not None
    assert add(client, community_id, persona.id).status_code == 404


def test_a_database_refusal_is_409_not_500(
    session: Session,
    client: TestClient,
    owned: tuple[User, UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the policy ever let a treasury through, the 0009 trigger's check_violation is a 409."""
    _, community_id = owned
    community = session.get(Community, community_id)
    assert community is not None
    monkeypatch.setattr(communities_router, "enforce", lambda *args: None)
    response = add(client, community_id, community.treasury_user_id)
    assert response.status_code == 409
    assert response.json() == {"detail": "member_not_eligible"}


def test_a_steward_may_leave_but_not_remove_others(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    owner, community_id = owned
    first, second = person(session, "First"), person(session, "Second")
    assert add(client, community_id, first.id).status_code == 201
    assert add(client, community_id, second.id).status_code == 201

    sign_in(client, session, first)
    others = client.delete(f"/communities/{community_id}/members/{second.id}")
    assert others.status_code == 403
    assert others.json() == {"detail": "owner_only"}
    assert client.delete(f"/communities/{community_id}/members/{first.id}").status_code == 204
    assert client.get("/me/communities").json() == []
    # Gone: no longer a member, so "leaving" again is removing someone (owner only).
    again = client.delete(f"/communities/{community_id}/members/{first.id}")
    assert again.json() == {"detail": "owner_only"}

    sign_in(client, session, owner)
    leaving = client.delete(f"/communities/{community_id}/members/{owner.id}")
    assert leaving.status_code == 409
    assert leaving.json() == {"detail": "owner_cannot_be_removed"}


def test_member_routes_across_worlds_are_not_found(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    owner, community_id = owned
    world = create_world(session)
    sandbox_community = session.exec(select(Community).where(Community.world_id == world.id))
    other = sandbox_community.first()
    assert other is not None
    sign_in(client, session, owner)
    assert client.get(f"/communities/{other.id}/members").status_code == 404
    assert client.delete(f"/communities/{other.id}/members/{owner.id}").status_code == 404

    # A sandbox admin can't see or touch the live community.
    sandbox_admin = person(session, "Sandbox admin", world_id=world.id, is_admin=True)
    sign_in(client, session, sandbox_admin)
    members = client.get(f"/communities/{community_id}/members")
    assert members.status_code == 404
    assert members.json() == {"detail": "not_found"}
    removed = client.delete(f"/communities/{community_id}/members/{owner.id}")
    assert removed.status_code == 404


def test_anonymous_member_writes_are_401(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    owner, community_id = owned
    sign_in(client, session, None)
    for path in (
        f"/communities/{community_id}/members/{owner.id}",
        f"/communities/{uuid4()}/members/{uuid4()}",
    ):
        response = client.delete(path)
        assert response.status_code == 401
        assert response.json() == {"detail": "auth_required"}
    assert add(client, community_id, owner.id).status_code == 401


def test_an_admin_who_owns_a_community_edits_it_like_any_owner(
    session: Session, client: TestClient
) -> None:
    admin = person(session, "Admin", is_admin=True)
    created = create(sign_in(client, session, admin))
    assert created.status_code == 201
    community_id = created.json()["id"]
    assert client.patch(f"/communities/{community_id}", json={"name": "Renamed"}).is_success
    assert [c["role"] for c in client.get("/me/communities").json()] == ["owner"]


def test_patch_with_no_fields_changes_nothing(client: TestClient, owned: tuple[User, UUID]) -> None:
    _, community_id = owned
    before = client.get(f"/communities/{community_id}").json()
    response = client.patch(f"/communities/{community_id}", json={})
    assert response.status_code == 200
    assert response.json() == before


@pytest.mark.parametrize(
    "body",
    [
        {"name": "A"},
        {"name": "<b>bold</b>"},
        {"name": "   "},
        {"country": "Brazil"},
        {"country": "B1"},
        {"description": "nul\x00"},
        {"description": "x" * 1001},
        {"treasury_user_id": str(uuid4())},
    ],
)
def test_patch_rejects_invalid_values(
    client: TestClient, owned: tuple[User, UUID], body: dict[str, Any]
) -> None:
    _, community_id = owned
    assert client.patch(f"/communities/{community_id}", json=body).status_code == 422


def test_names_are_nfkc_normalized(session: Session, client: TestClient) -> None:
    sign_in(client, session, person(session, "Ana"))
    decomposed = "Ri\u0301o Verde"
    response = create(client, name=decomposed)
    assert response.status_code == 201
    assert response.json()["name"] == "Río Verde"
    assert create(client, name="\uff32\uff49\uff4f Ｂlanco").json()["name"] == "Rio Blanco"


def test_community_names_are_unique_per_world_in_any_case(
    session: Session, client: TestClient, owned: tuple[User, UUID]
) -> None:
    _, community_id = owned  # "Río Verde Stewards"
    sign_in(client, session, person(session, "Ana"))
    for name in ("Río Verde Stewards", "RÍO VERDE STEWARDS", "Ri\u0301o verde stewards"):
        response = create(client, name=name)
        assert response.status_code == 409
        assert response.json() == {"detail": "community_name_taken"}
    other = create(client, name="Another Place")
    assert other.status_code == 201
    renamed = client.patch(
        f"/communities/{other.json()['id']}", json={"name": "río verde stewards"}
    )
    assert renamed.status_code == 409
    assert renamed.json() == {"detail": "community_name_taken"}
    # The same name is fine in another world.
    world = create_world(session)
    mia = session.exec(select(User).where(User.world_id == world.id, User.persona_key == "mia"))
    assert create(sign_in(client, session, mia.one()), name="Río Verde Stewards").status_code == 201


def test_parallel_creates_respect_the_community_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Committed data: N simultaneous creates by one account at cap - 1 leave exactly one."""
    # Widen the window between the cap check and the insert, so an unlocked race would show.
    slow_create = communities_router.create_community

    def create_slowly(*args: Any, **kwargs: Any) -> Community:
        time.sleep(0.2)
        return slow_create(*args, **kwargs)

    monkeypatch.setattr(communities_router, "create_community", create_slowly)
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    threads = 4
    with Session(engine) as setup:
        seed(setup)
        world_id = create_world(setup).id
        user = User(world_id=world_id, name="Ana", role=UserRole.INVESTOR, kind=UserKind.PERSON)
        setup.add(user)
        setup.flush()
        for n in range(communities_router.MAX_OWNED_COMMUNITIES - 1):
            create_community(setup, world_id, f"Already mine {n}", user.id)
        setup.commit()
        user_id = user.id
    actor = Actor(user_id, world_id, UserKind.PERSON, False, SessionKind.DEMO, {})
    granted = Granted(actor, WorldRef(world_id))
    barrier = threading.Barrier(threads)

    def create_one(n: int) -> int:
        with Session(engine) as db:
            barrier.wait(timeout=10)
            try:
                communities_router.create(
                    CommunityCreate(name=f"Racing {n}"), granted, db, Response()
                )
                return 201
            except HTTPException as exc:
                db.rollback()
                return exc.status_code

    try:
        with ThreadPoolExecutor(max_workers=threads) as pool:
            codes = sorted(pool.map(create_one, range(threads), timeout=30))
        assert codes == [201] + [409] * (threads - 1)
        with Session(engine) as check:
            owned = check.exec(
                select(CommunityMember).where(
                    CommunityMember.world_id == world_id,
                    CommunityMember.user_id == user_id,
                    CommunityMember.role == CommunityRole.OWNER,
                )
            ).all()
            assert len(owned) == communities_router.MAX_OWNED_COMMUNITIES
    finally:
        with Session(engine) as cleanup:
            _delete_world_rows(cleanup, world_id, keep_world=False)
            cleanup.execute(delete(World).where(col(World.id) == world_id))
            cleanup.commit()
        engine.dispose()

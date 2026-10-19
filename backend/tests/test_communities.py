"""Community routes and the `require` dependency (ADR-0005 §3, T68)."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine
from sqlmodel import Session, select

from app.auth import SESSION_COOKIE, start_session
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
)
from app.routers import communities as communities_router
from app.sandbox import create_world, ensure_live_world
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
    assert listed.headers["cache-control"] == "no-store"
    assert [c["role"] for c in client.get("/me/communities").json()] == ["steward"]
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

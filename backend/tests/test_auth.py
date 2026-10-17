"""Accounts and server-side sessions (ADR-0005 §1–§2, T54)."""

from __future__ import annotations

import hashlib
import logging
import sys
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, select

from app import auth, cli
from app import seed as seed_module
from app.config import Settings, get_settings
from app.db import get_session
from app.main import app
from app.models import (
    Asset,
    Community,
    CommunityMember,
    CommunityRole,
    Holding,
    Price,
    SessionKind,
    User,
    UserKind,
    UserRole,
    UserSession,
    World,
)
from app.sandbox import (
    create_world,
    ensure_live_world,
    prune_stale_worlds,
    reset_world,
    world_from_cookie,
)
from app.seed import COMMUNITY_PERSONA, DEMO_SITES, LIVE_WORLD_ID, WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

PASSWORD = "correct horse battery"
EMAIL = "rosa.ok@example.org"


@pytest.fixture
def conn() -> Iterator[Connection]:
    """A connection inside a transaction that is rolled back, so nothing persists."""
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
    yield db
    db.close()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def register(client: TestClient, email: str = EMAIL, password: str = PASSWORD) -> Any:
    return client.post("/auth/register", json={"email": email, "password": password, "name": "Ro"})


def login(client: TestClient, email: str = EMAIL, password: str = PASSWORD) -> Any:
    return client.post("/auth/login", json={"email": email, "password": password})


def session_rows(session: Session) -> list[UserSession]:
    session.expire_all()
    return list(session.exec(select(UserSession)).all())


def row_for(session: Session, token: str) -> UserSession:
    session.expire_all()
    return session.exec(
        select(UserSession).where(UserSession.token_hash == auth.hash_token(token))
    ).one()


# --- Happy path ------------------------------------------------------------------------------


@requires_db
def test_register_login_me_logout(session: Session, client: TestClient) -> None:
    created = register(client)
    assert created.status_code == 201
    body = created.json()
    assert body["email"] == EMAIL
    assert (body["kind"], body["is_admin"]) == ("person", False)
    assert UUID(body["world_id"]) == LIVE_WORLD_ID
    assert "password_hash" not in body and "password" not in body
    assert client.get("/me").json()["id"] == body["id"]

    assert client.post("/auth/logout").status_code == 204
    assert client.get("/me").status_code == 401

    signed_in = login(client)
    assert signed_in.status_code == 200
    assert signed_in.json()["id"] == body["id"]
    me = client.get("/me")
    assert me.status_code == 200
    assert set(me.json()) == {"id", "name", "email", "kind", "is_admin", "world_id"}
    assert me.headers["cache-control"] == "no-store"


@requires_db
def test_new_account_is_a_live_person_with_play_money_and_an_argon2id_hash(
    session: Session, client: TestClient
) -> None:
    user_id = UUID(register(client, email="  New.Person@Example.ORG ").json()["id"])

    user = session.get(User, user_id)
    assert user is not None
    assert (user.world_id, user.kind, user.is_admin) == (LIVE_WORLD_ID, UserKind.PERSON, False)
    assert user.email == "new.person@example.org", "stored normalised"
    assert user.cash_balance == Decimal("10000.00")
    assert user.password_hash is not None and user.password_hash.startswith("$argon2id$")
    assert PASSWORD not in user.password_hash


@requires_db
def test_login_normalises_the_email(client: TestClient) -> None:
    register(client)
    client.post("/auth/logout")

    assert login(client, email=f"  {EMAIL.upper()} ").status_code == 200


# --- Failures --------------------------------------------------------------------------------


@requires_db
def test_wrong_password_and_unknown_email_get_the_same_generic_401(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    register(client)
    client.post("/auth/logout")
    calls: list[str] = []
    real_verify = auth.verify_password

    def spy(password: str, password_hash: str) -> tuple[bool, str | None]:
        calls.append(password_hash)
        return real_verify(password, password_hash)

    monkeypatch.setattr(auth, "verify_password", spy)

    wrong = login(client, password="not the password")
    unknown = login(client, email="nobody@example.org")

    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "Email or password is incorrect"}
    assert "nx_session" not in client.cookies
    assert len(calls) == 2, "the unknown email still runs a password verify"
    assert calls[1] == auth.dummy_hash()


@requires_db
def test_people_outside_the_live_world_and_personas_cannot_sign_in(
    session: Session, client: TestClient
) -> None:
    session.add(
        User(
            world_id=WORLD_ID,
            name="Elsewhere",
            role=UserRole.INVESTOR,
            kind=UserKind.PERSON,
            email="elsewhere@example.org",
            password_hash=auth.hash_password(PASSWORD),
        )
    )
    session.commit()

    assert login(client, email="elsewhere@example.org").status_code == 401
    assert login(client, email="rosa").status_code in {401, 422}, "personas have no email"


@requires_db
def test_duplicate_registration_is_a_generic_409_case_insensitively(client: TestClient) -> None:
    register(client)

    again = register(TestClient(app), email=EMAIL.upper(), password="another password 1")

    assert again.status_code == 409
    assert again.json() == {"detail": "This email can't be used to create an account"}
    assert "nx_session" not in again.cookies


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"email": "not-an-email", "password": PASSWORD, "name": "Ro"}, "email"),
        ({"email": EMAIL, "password": "Tiny-pw1", "name": "Ro"}, "password"),
        ({"email": EMAIL, "password": "x" * 129, "name": "Ro"}, "password"),
        ({"email": EMAIL, "password": PASSWORD, "name": "   "}, "name"),
        ({"email": EMAIL, "password": PASSWORD, "name": "n" * 81}, "name"),
        ({"email": "a" * 250 + "@x.io", "password": PASSWORD, "name": "Ro"}, "email"),
    ],
)
@requires_db
def test_registration_validates_input_without_echoing_it(
    client: TestClient, payload: dict[str, str], field: str
) -> None:
    res = client.post("/auth/register", json=payload)

    assert res.status_code == 422
    assert [e["loc"][-1] for e in res.json()["detail"]] == [field]
    assert payload["password"] not in res.text
    assert all("input" not in e for e in res.json()["detail"])


# --- Sessions --------------------------------------------------------------------------------


@requires_db
def test_only_the_token_hash_is_stored(session: Session, client: TestClient) -> None:
    register(client)
    token = client.cookies["nx_session"]

    row = row_for(session, token)
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert len(token) >= 43, "256 random bits, base64url"
    dumped = session.execute(text("SELECT sessions::text FROM sessions")).scalars().all()
    assert all(token not in r for r in dumped)
    assert (row.world_id, row.kind) == (LIVE_WORLD_ID, SessionKind.PASSWORD)
    assert row.expires_at - row.created_at == timedelta(days=30)


@requires_db
def test_each_login_issues_a_new_token_and_revokes_the_one_presented(
    session: Session, client: TestClient
) -> None:
    register(client)
    first = client.cookies["nx_session"]
    other_device = TestClient(app)
    login(other_device)

    login(client)
    second = client.cookies["nx_session"]

    assert second != first
    assert auth.hash_token(first) not in {r.token_hash for r in session_rows(session)}
    stale = TestClient(app, cookies={"nx_session": first})
    assert stale.get("/me").status_code == 401, "the replaced token is dead"
    assert other_device.get("/me").status_code == 200, "other devices stay signed in"


@requires_db
@pytest.mark.parametrize("limit", ["idle", "absolute"])
def test_expired_sessions_get_401_and_are_deleted(
    session: Session, client: TestClient, limit: str
) -> None:
    register(client)
    row = row_for(session, client.cookies["nx_session"])
    now = datetime.now(UTC)
    if limit == "idle":
        row.last_seen_at = now - timedelta(days=7, seconds=1)
    else:
        row.expires_at = now - timedelta(seconds=1)
    session.add(row)
    session.commit()

    res = client.get("/me")

    assert (res.status_code, res.json()["detail"]) == (401, "auth_required")
    assert session_rows(session) == []


@requires_db
def test_a_revoked_session_gets_401(session: Session, client: TestClient) -> None:
    register(client)
    session.delete(row_for(session, client.cookies["nx_session"]))
    session.commit()

    assert client.get("/me").status_code == 401


@requires_db
@pytest.mark.parametrize("cookie", ["", "garbage", "x" * 500])
def test_unknown_tokens_get_401(client: TestClient, cookie: str) -> None:
    client.cookies.set("nx_session", cookie)

    assert client.get("/me").status_code == 401


@requires_db
def test_last_seen_is_bumped_at_most_every_few_minutes(
    session: Session, client: TestClient
) -> None:
    register(client)
    token = client.cookies["nx_session"]
    row = row_for(session, token)
    recent = datetime.now(UTC) - timedelta(minutes=1)
    row.last_seen_at = recent
    session.add(row)
    session.commit()

    client.get("/me")
    assert row_for(session, token).last_seen_at == recent

    row = row_for(session, token)
    row.last_seen_at = datetime.now(UTC) - timedelta(days=6)
    session.add(row)
    session.commit()
    client.get("/me")
    assert datetime.now(UTC) - row_for(session, token).last_seen_at < timedelta(minutes=1)


@requires_db
def test_logout_deletes_the_row_and_clears_the_cookie(session: Session, client: TestClient) -> None:
    register(client)
    token = client.cookies["nx_session"]

    res = client.post("/auth/logout")

    assert res.status_code == 204
    cookie = res.headers["set-cookie"].lower()
    assert cookie.startswith("nx_session=") and "max-age=0" in cookie and "path=/" in cookie
    assert "nx_session" not in client.cookies
    assert session_rows(session) == []
    assert TestClient(app, cookies={"nx_session": token}).get("/me").status_code == 401
    assert TestClient(app).post("/auth/logout").status_code == 204, "idempotent"


@requires_db
def test_cookie_flags_in_test_and_production(client: TestClient) -> None:
    res = register(client)
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "path=/" in cookie
    assert f"max-age={30 * 24 * 3600}" in cookie
    assert "secure" not in cookie, "plain-HTTP local development must still get the cookie"

    app.dependency_overrides[get_settings] = lambda: Settings(
        environment="production", auth_rate_limit_secret="test-secret"
    )
    prod = login(client)
    assert "secure" in prod.headers["set-cookie"].lower()
    assert "secure" in client.post("/auth/logout").headers["set-cookie"].lower()


# --- Schema ----------------------------------------------------------------------------------


def _person(world_id: UUID, email: str) -> User:
    return User(
        world_id=world_id,
        name="P",
        role=UserRole.INVESTOR,
        kind=UserKind.PERSON,
        email=email,
        password_hash="$argon2id$x",
    )


@requires_db
def test_email_is_unique_per_world_case_insensitively(session: Session) -> None:
    ensure_live_world(session)
    session.add(_person(LIVE_WORLD_ID, "same@example.org"))
    session.add(_person(WORLD_ID, "same@example.org"))
    session.commit()

    session.add(_person(LIVE_WORLD_ID, "SAME@example.org"))
    with pytest.raises(IntegrityError, match="users_world_email"):
        session.commit()
    session.rollback()


@requires_db
def test_personas_and_treasuries_can_never_hold_credentials(session: Session) -> None:
    for kind in (UserKind.PERSONA, UserKind.TREASURY):
        user = _person(WORLD_ID, f"{kind}@example.org")
        user.kind = kind
        session.add(user)
        with pytest.raises(IntegrityError, match="ck_users_credentials_person_only"):
            session.commit()
        session.rollback()


@requires_db
def test_template_personas_are_backfilled_as_personas(session: Session) -> None:
    users = session.exec(select(User).where(User.world_id == WORLD_ID)).all()
    assert {u.kind for u in users if u.persona_key} == {UserKind.PERSONA}
    assert {u.kind for u in users if not u.persona_key} == {UserKind.TREASURY}  # T56
    assert not any(u.email or u.password_hash or u.is_admin for u in users)


@requires_db
def test_a_session_cannot_point_at_a_user_in_another_world(session: Session) -> None:
    ensure_live_world(session)
    session.add(
        UserSession(
            token_hash="a" * 64,
            world_id=LIVE_WORLD_ID,
            user_id=COMMUNITY_PERSONA.id,  # a template-world user
            kind=SessionKind.DEMO,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
    )
    with pytest.raises(IntegrityError, match="fk_sessions_user"):
        session.commit()
    session.rollback()


@requires_db
def test_accounts_migration_downgrades_and_upgrades() -> None:
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0005")  # the revision before accounts (0006)
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        tables = connection.execute(text("SELECT to_regclass('sessions')")).scalar()
        columns = connection.execute(
            text("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'")
        ).scalars()
        assert tables is None
        assert not {"kind", "email", "password_hash", "is_admin"} & set(columns)
    command.upgrade(cfg, "head")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT to_regclass('sessions')")).scalar() == "sessions"
    engine.dispose()


# --- The live world --------------------------------------------------------------------------


@requires_db
def test_live_world_holds_the_curated_sites_and_only_their_community(session: Session) -> None:
    live = ensure_live_world(session)
    again = ensure_live_world(session)

    assert (live.id, live.label, again.id) == (LIVE_WORLD_ID, "live", LIVE_WORLD_ID)
    assert session.exec(select(World).where(World.label == "live")).all() == [live]
    sites = session.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID)).all()
    assert sorted(a.site_key or "" for a in sites) == sorted(s.key for s in DEMO_SITES)
    assert not {a.id for a in sites} & {s.id for s in DEMO_SITES}, "fresh IDs"
    # The DB may already hold live accounts (e.g. after `make seed` on a dev database).
    personas = session.exec(
        select(User).where(User.world_id == LIVE_WORLD_ID, col(User.persona_key).is_not(None))
    ).all()
    assert [(u.persona_key, u.kind) for u in personas] == [
        (COMMUNITY_PERSONA.key, UserKind.PERSONA)
    ], "no demo investors or demo admin in the live world"
    rosa = personas[0]
    # T56: each site's community comes along, owned by Rosa; its treasury holds the stake.
    members = session.exec(
        select(CommunityMember).where(CommunityMember.world_id == LIVE_WORLD_ID)
    ).all()
    assert sorted((m.user_id, m.role) for m in members) == [(rosa.id, CommunityRole.OWNER)] * 3
    communities = session.exec(select(Community).where(Community.world_id == LIVE_WORLD_ID)).all()
    assert {a.community_id for a in sites} == {c.id for c in communities}
    treasuries = {c.treasury_user_id for c in communities}
    assert {a.community_user_id for a in sites} == treasuries
    holdings = session.exec(select(Holding).where(Holding.world_id == LIVE_WORLD_ID)).all()
    assert all(h.user_id in treasuries for h in holdings), "nobody else holds live shares yet"
    assert sorted(h.shares for h in holdings) == [510_000] * 3
    prices = session.exec(select(Price).where(Price.world_id == LIVE_WORLD_ID)).all()
    assert {p.asset_id for p in prices} == {a.id for a in sites}, "tradable from day one"


@requires_db
def test_make_seed_creates_the_live_world_idempotently(
    conn: Connection, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(seed_module, "engine", conn)

    seed_module.main()
    seed_module.main()

    with Session(bind=conn) as db:
        assert db.get(World, LIVE_WORLD_ID) is not None
        assert len(db.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID)).all()) == 3
    assert "live world" in capsys.readouterr().out


@requires_db
def test_live_world_is_never_pruned_reset_or_served_as_a_sandbox(
    session: Session, client: TestClient
) -> None:
    live = ensure_live_world(session)
    live.last_seen_at = datetime.now(UTC) - timedelta(days=365)
    session.add(live)
    session.commit()

    prune_stale_worlds(session, older_than=timedelta(days=7))
    assert session.get(World, LIVE_WORLD_ID) is not None
    assert len(session.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID)).all()) == 3

    with pytest.raises(ValueError):
        reset_world(session, LIVE_WORLD_ID)
    assert world_from_cookie(session, str(LIVE_WORLD_ID)) is None
    client.cookies.set("nx_world", str(LIVE_WORLD_ID))
    served = client.get("/world").json()
    assert UUID(served["id"]) not in {LIVE_WORLD_ID, WORLD_ID}


@requires_db
def test_world_listing_never_includes_password_accounts(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    session.add(_person(world.id, "hidden@example.org"))
    session.commit()
    client.cookies.set("nx_world", str(world.id))

    personas = client.get("/world").json()["personas"]

    assert "hidden@example.org" not in str(personas)
    assert len(personas) == 4


@requires_db
def test_prune_deletes_expired_sessions_and_stale_worlds_with_sessions(session: Session) -> None:
    world = create_world(session)
    world_id = world.id
    persona = session.exec(
        select(User).where(User.world_id == world_id, User.kind == UserKind.PERSONA)
    ).first()
    assert persona is not None
    now = datetime.now(UTC)
    session.add(
        UserSession(
            token_hash="b" * 64,
            world_id=world.id,
            user_id=persona.id,
            kind=SessionKind.DEMO,
            expires_at=now + timedelta(days=1),
        )
    )
    world.last_seen_at = now - timedelta(days=30)
    session.add(world)
    ensure_live_world(session)
    live_person = _person(LIVE_WORLD_ID, "old@example.org")
    session.add(live_person)
    session.flush()
    live_person_id = live_person.id
    session.add(
        UserSession(
            token_hash="c" * 64,
            world_id=LIVE_WORLD_ID,
            user_id=live_person.id,
            kind=SessionKind.PASSWORD,
            expires_at=now - timedelta(seconds=1),
        )
    )
    session.commit()

    prune_stale_worlds(session, older_than=timedelta(days=7))

    assert session.get(World, world_id) is None
    assert session_rows(session) == []
    assert session.get(User, live_person_id) is not None


# --- Admin CLI -------------------------------------------------------------------------------


@requires_db
def test_cli_create_admin_reads_the_password_with_getpass_and_never_prints_it(
    session: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "operator secret 42"
    prompts: list[str] = []

    def fake_getpass(prompt: str = "") -> str:
        prompts.append(prompt)
        return secret

    monkeypatch.setattr(cli.getpass, "getpass", fake_getpass)
    argv = ["create-admin", "--email", " Ops@Example.org ", "--name", "Ops"]
    monkeypatch.setattr(sys, "argv", ["app.cli", *argv])
    caplog.set_level(logging.DEBUG)

    assert cli.main(argv, session=session) == 0

    admin = session.exec(select(User).where(User.email == "ops@example.org")).one()
    assert (admin.world_id, admin.kind, admin.is_admin) == (LIVE_WORLD_ID, UserKind.PERSON, True)
    assert len(prompts) == 2, "asked twice, to confirm"
    out = capsys.readouterr()
    assert secret not in out.out + out.err + caplog.text
    assert secret not in " ".join(sys.argv)
    assert admin.password_hash is not None and secret not in admin.password_hash

    signed_in = login(client, email="ops@example.org", password=secret)
    assert signed_in.status_code == 200
    assert client.get("/me").json()["is_admin"] is True


@requires_db
def test_cli_never_takes_the_password_on_the_command_line(
    session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit):
        cli.main(
            ["create-admin", "--email", "a@b.io", "--name", "A", "--password", "x" * 12],
            session=session,
        )
    assert "x" * 12 not in capsys.readouterr().out


@requires_db
def test_cli_never_promotes_an_existing_account_by_email(
    session: Session,
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    register(client)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": "operator secret 42")

    code = cli.main(["create-admin", "--email", EMAIL, "--name", "Ops"], session=session)

    assert code == 1
    assert "already exists" in capsys.readouterr().err
    users = session.exec(select(User).where(User.email == EMAIL)).all()
    assert [u.is_admin for u in users] == [False]


@requires_db
@pytest.mark.parametrize("answers", [["short", "short"], ["long enough 1", "different one 2"]])
def test_cli_rejects_weak_or_mismatched_passwords(
    session: Session, monkeypatch: pytest.MonkeyPatch, answers: list[str]
) -> None:
    replies = iter(answers)
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": next(replies))

    code = cli.main(
        ["create-admin", "--email", "ops@example.org", "--name", "Ops"], session=session
    )

    assert code == 1
    assert session.exec(select(User).where(User.is_admin)).all() == []


# --- Review follow-ups -----------------------------------------------------------------------


@requires_db
@pytest.mark.parametrize(
    "email",
    [
        "ro\x00sa@example.org",
        "rosa@exam\x00ple.org",
        "ro\x1fsa@example.org",
        "rosa\x7f@example.org",
    ],
)
def test_control_characters_in_emails_are_422_never_500(client: TestClient, email: str) -> None:
    registered = register(client, email=email)
    signed_in = login(client, email=email)

    assert registered.status_code == 422
    assert signed_in.status_code in {401, 422}
    assert PASSWORD not in registered.text + signed_in.text


@requires_db
def test_a_database_error_on_an_auth_route_is_a_bare_500_that_logs_no_secrets(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from app.routers import auth as auth_router

    hashes: list[str] = []
    real_hash, real_register = auth.hash_password, auth.register_person

    def spy_hash(password: str) -> str:
        hashes.append(real_hash(password))
        return hashes[-1]

    def nul_register(
        session: Session, world_id: UUID, email: str, password: str, name: str
    ) -> User:
        # Bypasses validation to force a real psycopg DataError on INSERT.
        return real_register(session, world_id, "nul\x00" + email, password, name)

    monkeypatch.setattr(auth, "hash_password", spy_hash)
    monkeypatch.setattr(auth_router, "register_person", nul_register)
    caplog.set_level(logging.DEBUG)

    res = register(client)

    assert (res.status_code, res.json()) == (500, {"detail": "internal_error"})
    assert res.headers["cache-control"] == "no-store"
    assert hashes, "the INSERT carried a real argon2 hash"
    assert "DataError" in caplog.text
    for secret in (hashes[0], EMAIL, PASSWORD):
        assert secret not in caplog.text and secret not in res.text
    assert "nx_session" not in client.cookies


@requires_db
def test_the_app_engine_never_puts_bound_parameters_in_errors_or_logs(
    conn: Connection, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from sqlalchemy.exc import DataError

    from app.db import engine

    hashes: list[str] = []
    real_hash = auth.hash_password
    monkeypatch.setattr(
        auth, "hash_password", lambda pw: hashes.append(real_hash(pw)) or hashes[-1]
    )

    with Session(engine) as db, pytest.raises(DataError) as failure:
        auth.register_person(db, WORLD_ID, "nul\x00@example.org", PASSWORD, "Nul")
    logging.getLogger("tests.auth").error("insert failed", exc_info=failure.value)

    assert engine.hide_parameters
    assert "parameters hidden" in str(failure.value)
    assert hashes and hashes[0] not in caplog.text
    assert "nul\x00@example.org" not in caplog.text


@requires_db
def test_a_session_revoked_between_lookup_and_bump_is_a_401_not_a_500(
    conn: Connection, session: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    register(client)
    token = client.cookies["nx_session"]
    row = row_for(session, token)
    row.last_seen_at = datetime.now(UTC) - timedelta(hours=1)  # due for a bump
    session.add(row)
    session.commit()
    real_now = auth._now
    revoked: list[bool] = []

    def logout_elsewhere_then_now() -> datetime:
        """Runs after the session SELECT and before the bump: a concurrent logout."""
        if not revoked:
            with Session(bind=conn, join_transaction_mode="create_savepoint") as other:
                other.execute(
                    text("DELETE FROM sessions WHERE token_hash = :h"),
                    {"h": auth.hash_token(token)},
                )
                other.commit()
            revoked.append(True)
        return real_now()

    monkeypatch.setattr(auth, "_now", logout_elsewhere_then_now)

    res = client.get("/me")

    assert revoked, "the concurrent delete ran"
    assert (res.status_code, res.json()["detail"]) == (401, "auth_required")


@pytest.mark.parametrize(
    ("environment", "secure"),
    [(None, True), ("development", False), ("test", False), ("production", True), ("Dev", True)],
)
def test_secure_cookies_fail_closed_unless_environment_is_explicitly_dev_or_test(
    monkeypatch: pytest.MonkeyPatch, environment: str | None, secure: bool
) -> None:
    from app.config import secure_cookies

    if environment is None:
        monkeypatch.delenv("ENVIRONMENT", raising=False)
    else:
        monkeypatch.setenv("ENVIRONMENT", environment)

    assert secure_cookies(Settings(_env_file=None)) is secure  # type: ignore[call-arg]


@requires_db
def test_cookie_flags_with_environment_production(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        auth_rate_limit_secret="test-secret",
    )

    signed_up = register(client).headers["set-cookie"].lower()
    cleared = TestClient(app).post("/auth/logout").headers["set-cookie"].lower()

    for cookie in (signed_up, cleared):
        assert cookie.startswith("nx_session=")
        for flag in ("secure", "httponly", "samesite=lax", "path=/"):
            assert flag in cookie, (flag, cookie)


def test_startup_warns_whenever_cookies_are_not_secure(caplog: pytest.LogCaptureFixture) -> None:
    from app.main import warn_if_cookies_insecure

    warn_if_cookies_insecure(Settings(_env_file=None, environment="production"))  # type: ignore[call-arg]
    assert caplog.text == ""

    warn_if_cookies_insecure(Settings(_env_file=None, environment="development"))  # type: ignore[call-arg]
    assert "ENVIRONMENT=development" in caplog.text
    assert "ENVIRONMENT=production" in caplog.text

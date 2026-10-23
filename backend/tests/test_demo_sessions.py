"""No-sign-up demo sessions (T55): the sandbox channel (`/sandbox/*`, cookie `nx_demo`),
`POST /sandbox/demo/start`, `POST /sandbox/demo/persona`, and the hidden per-sandbox model spend
cap (`SANDBOX_LLM_BUDGET_USD`)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, delete, func
from sqlmodel import Session, col, select

from app import auth
from app.auth import SESSION_COOKIE
from app.channel import DEMO_COOKIE, SandboxChannelMiddleware
from app.config import Settings, get_settings
from app.db import get_session
from app.llm import BudgetExceeded, CallRecord, DbCallLog, Tier
from app.main import app
from app.models import Asset, LlmCall, SessionKind, UserSession, World
from app.sandbox import create_world, ensure_live_world, is_sandbox, reset_world
from app.seed import LIVE_WORLD_ID, WORLD_ID, seed
from app.worlds import PROTECTED_WORLDS
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import drop_worlds, sign_in

PASSWORD = "correct horse battery"


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


@contextmanager
def settings(**overrides: Any) -> Iterator[None]:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,
        allowed_origins="http://testserver",
        **overrides,
    )
    try:
        yield
    finally:
        del app.dependency_overrides[get_settings]


def from_one_ip() -> str:
    return f"10.9.{uuid4().int % 250}.{uuid4().int % 250}"


def start(client: TestClient, persona: str = "rosa") -> Any:
    return client.post("/sandbox/demo/start", json={"persona": persona})


def token_of(client: TestClient, cookie: str = DEMO_COOKIE) -> str:
    token = client.cookies.get(cookie)
    assert token
    return token


def row(session: Session, token: str) -> UserSession | None:
    session.expire_all()
    return session.exec(
        select(UserSession).where(UserSession.token_hash == auth.hash_token(token))
    ).first()


@requires_db
def test_one_click_gives_a_private_sandbox_and_a_demo_session(
    session: Session, client: TestClient
) -> None:
    response = start(client, "rosa")

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    world = session.get(World, UUID(body["id"]))
    assert world is not None and is_sandbox(world)
    assert body["label"] == "visitor"
    assert body["me"]["persona"] == "rosa" and body["me"]["is_admin"] is False
    assert {p["key"] for p in body["personas"]} >= {"rosa", "arjun", "mia", "admin"}
    stored = row(session, token_of(client))
    assert stored is not None and stored.kind is SessionKind.DEMO
    # The session is the world: GET /world serves that sandbox, never the live world.
    seen = client.get("/sandbox/world").json()
    assert seen["id"] == body["id"] and seen["me"]["persona"] == "rosa"


@requires_db
def test_two_visitors_get_separate_sandboxes(session: Session, client: TestClient) -> None:
    other = TestClient(app)
    first = start(client).json()
    second = start(other, "arjun").json()

    assert first["id"] != second["id"]
    assert UUID(first["id"]) != LIVE_WORLD_ID and UUID(second["id"]) != LIVE_WORLD_ID
    assert client.get("/sandbox/world").json()["id"] == first["id"]
    assert other.get("/sandbox/world").json()["id"] == second["id"]


@requires_db
def test_switching_persona_stays_in_the_sandbox_and_revokes_the_old_session(
    session: Session, client: TestClient
) -> None:
    world_id = start(client, "rosa").json()["id"]
    old = token_of(client)

    switched = client.post("/sandbox/demo/persona", json={"persona": "admin"})

    assert switched.status_code == 200, switched.text
    assert switched.json()["id"] == world_id
    assert switched.json()["me"]["persona"] == "admin" and switched.json()["me"]["is_admin"]
    assert token_of(client) != old
    assert row(session, old) is None
    assert client.get("/sandbox/world").json()["me"]["persona"] == "admin"


@requires_db
def test_starting_again_keeps_the_sandbox_and_only_switches_persona(
    session: Session, client: TestClient
) -> None:
    world_id = start(client, "rosa").json()["id"]
    worlds_before = len(session.exec(select(World)).all())

    again = start(client, "arjun")

    assert again.status_code == 200
    assert again.json()["id"] == world_id and again.json()["me"]["persona"] == "arjun"
    assert len(session.exec(select(World)).all()) == worlds_before


@requires_db
def test_reset_keeps_the_demo_session(session: Session, client: TestClient) -> None:
    world_id = start(client, "arjun").json()["id"]

    reset = client.post("/sandbox/world/reset")

    assert reset.status_code == 200
    assert reset.json()["id"] == world_id and reset.json()["me"]["persona"] == "arjun"


@requires_db
def test_a_real_account_has_one_identity(session: Session, client: TestClient) -> None:
    assert client.post("/sandbox/demo/persona", json={"persona": "admin"}).status_code == 401
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real@example.org", PASSWORD, "Real")
    sign_in(client, session, person)

    refused = client.post("/demo/persona", json={"persona": "admin"})
    # The sandbox never reads the real account's cookie.
    unknown = client.post("/sandbox/demo/persona", json={"persona": "admin"})

    assert (refused.status_code, refused.json()["detail"]) == (403, "demo_session_only")
    assert (unknown.status_code, unknown.json()["detail"]) == (401, "auth_required")


@requires_db
def test_a_real_account_trying_the_sandbox_stays_signed_in(
    session: Session, client: TestClient
) -> None:
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real2@example.org", PASSWORD, "Real")
    sign_in(client, session, person)
    real = token_of(client, SESSION_COOKIE)

    assert start(client, "mia").status_code == 200

    assert row(session, real) is not None
    assert client.get("/sandbox/world").json()["me"]["persona"] == "mia"
    assert client.get("/world").json()["me"]["id"] == str(person.id)


@requires_db
def test_the_real_app_never_becomes_a_sandbox(client: TestClient) -> None:
    refused = client.post("/demo/start", json={"persona": "rosa"})
    assert (refused.status_code, refused.json()["detail"]) == (403, "sandbox_path_only")
    assert client.cookies.get(SESSION_COOKIE) is None

    sandbox = start(client).json()["id"]

    assert client.get("/sandbox/world").json()["id"] == sandbox
    live = client.get("/world").json()
    assert UUID(live["id"]) == LIVE_WORLD_ID and live["me"] is None


@requires_db
def test_accounts_belong_to_the_real_app(session: Session, client: TestClient) -> None:
    body = {"email": "nobody@example.org", "password": PASSWORD}
    login = client.post("/sandbox/auth/login", json=body)
    register = client.post("/sandbox/auth/register", json={**body, "name": "Nobody"})

    assert (login.status_code, login.json()["detail"]) == (403, "not_in_sandbox")
    assert (register.status_code, register.json()["detail"]) == (403, "not_in_sandbox")


@requires_db
def test_leaving_the_sandbox_signs_out_only_the_demo(session: Session, client: TestClient) -> None:
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real4@example.org", PASSWORD, "Real")
    sign_in(client, session, person)
    start(client, "arjun")
    demo = token_of(client)

    assert client.post("/sandbox/auth/logout").status_code == 204

    assert row(session, demo) is None
    assert client.cookies.get(DEMO_COOKIE) is None
    assert client.get("/sandbox/world").json()["me"] is None
    assert client.get("/world").json()["me"]["id"] == str(person.id)


@requires_db
def test_the_sandbox_serves_demo_sessions_only(session: Session, client: TestClient) -> None:
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real5@example.org", PASSWORD, "Real")
    sign_in(client, session, person)
    client.cookies.set(DEMO_COOKIE, token_of(client, SESSION_COOKIE))

    assert client.get("/sandbox/world").json()["me"] is None


@requires_db
def test_unknown_personas_are_refused(client: TestClient) -> None:
    assert start(client, "someone").status_code == 422
    assert client.post("/sandbox/demo/start", json={}).json()["me"]["persona"] == "rosa"


@requires_db
def test_each_ip_may_start_only_so_many_sandboxes(client: TestClient) -> None:
    ip = from_one_ip()
    visitors = [TestClient(app, headers={"X-Forwarded-For": ip}) for _ in range(3)]
    with settings(trusted_proxy_hops=1, demo_starts_per_ip_per_hour=2):
        statuses = [start(v).status_code for v in visitors]

    assert statuses == [200, 200, 429]


@requires_db
def test_returning_to_a_demo_costs_no_new_attempt(client: TestClient) -> None:
    ip = from_one_ip()
    visitor, neighbour = (TestClient(app, headers={"X-Forwarded-For": ip}) for _ in range(2))
    with settings(trusted_proxy_hops=1, demo_starts_per_ip_per_hour=1):
        first = start(visitor, "rosa")
        again = start(visitor, "arjun")
        other = start(neighbour)

    assert (first.status_code, again.status_code) == (200, 200)
    assert again.json()["id"] == first.json()["id"]
    assert (other.status_code, other.json()["detail"]) == (429, "too_many_attempts")


@requires_db
def test_the_hourly_sandbox_cap_holds_for_everyone(client: TestClient) -> None:
    with settings(sandbox_max_new_worlds_per_hour=0):
        refused = start(client)

    assert (refused.status_code, refused.json()["detail"]) == (429, "demo_busy")
    assert refused.headers["retry-after"] == "600"


@requires_db
def test_a_refused_start_keeps_a_real_accounts_session(
    session: Session, client: TestClient
) -> None:
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real3@example.org", PASSWORD, "Real")
    sign_in(client, session, person)
    real = token_of(client, SESSION_COOKIE)

    with settings(sandbox_max_new_worlds_per_hour=0):
        busy = start(client)
    del client.headers["Origin"]
    forged = start(client)

    assert busy.status_code == 429
    assert (forged.status_code, forged.json()["detail"]) == (403, "csrf_origin")
    assert row(session, real) is not None
    assert client.get("/world").json()["me"]["id"] == str(person.id)


# --- the channel itself ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "seen", "sandbox"),
    [
        ("/sandbox/world", "/world", True),
        ("/sandbox", "/", True),
        ("/sandbox/", "/", True),
        ("/sandboxes", "/sandboxes", False),
        ("/world", "/world", False),
    ],
)
def test_the_prefix_is_stripped_and_marked(path: str, seen: str, sandbox: bool) -> None:
    got: dict[str, Any] = {}

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        got.update(scope)

    async def run() -> None:
        scope = {"type": "http", "path": path, "raw_path": path.encode()}
        await SandboxChannelMiddleware(inner)(scope, None, None)  # type: ignore[arg-type]

    import asyncio

    asyncio.run(run())
    assert (got["path"], got["raw_path"]) == (seen, seen.encode())
    assert bool(got.get("naturex.sandbox")) is sandbox


def test_uploads_through_the_sandbox_pass_the_csrf_body_check() -> None:
    # Stripped before the CSRF layer, so `/sandbox/assets/{id}/documents` is still an upload.
    res = TestClient(app).post(
        f"/sandbox/assets/{uuid4()}/documents",
        content=b"%PDF-1.4",
        headers={"Content-Type": "application/pdf"},
    )
    assert res.status_code != 415


# --- the hidden per-sandbox spend cap ------------------------------------------------------------


@pytest.fixture
def sandbox_log() -> Iterator[tuple[DbCallLog, UUID, str]]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        seed(session)
        session.commit()
        world = create_world(session)
    agent = f"test-{uuid4()}"
    yield DbCallLog(lambda: Session(engine), sandbox_budget=Decimal("0.01")), world.id, agent
    with Session(engine) as session:
        session.execute(delete(LlmCall).where(col(LlmCall.agent) == agent))
        session.commit()
    drop_worlds(engine, [world.id])
    engine.dispose()


def call(agent: str, world_id: UUID | None, cost: str) -> CallRecord:
    return CallRecord(
        agent=agent,
        tier=Tier.FAST,
        model="nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
        status="reserved",
        prompt_tokens=0,
        completion_tokens=0,
        latency_ms=0,
        cost_usd=Decimal(cost),
        world_id=world_id,
    )


@requires_db
def test_a_sandbox_spends_at_most_its_own_allowance(
    sandbox_log: tuple[DbCallLog, UUID, str],
) -> None:
    log, world_id, agent = sandbox_log
    plenty = Decimal("1000000")

    log.reserve(call(agent, world_id, "0.006"), plenty)
    with pytest.raises(BudgetExceeded, match="sandbox"):
        log.reserve(call(agent, world_id, "0.006"), plenty)
    # Protected worlds and unscoped calls only answer to the global budget.
    log.reserve(call(agent, WORLD_ID, "0.006"), plenty)
    log.reserve(call(agent, None, "0.006"), plenty)


@requires_db
def test_a_call_naming_only_its_asset_counts_in_that_assets_sandbox(
    sandbox_log: tuple[DbCallLog, UUID, str],
) -> None:
    log, world_id, agent = sandbox_log
    plenty = Decimal("1000000")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        asset_id = session.exec(select(Asset.id).where(col(Asset.world_id) == world_id)).first()
    assert asset_id is not None
    by_asset = replace(call(agent, None, "0.006"), asset_id=asset_id)

    handle = log.reserve(by_asset, plenty)
    log.settle(handle, by_asset)
    with pytest.raises(BudgetExceeded, match="sandbox"):
        log.reserve(by_asset, plenty)

    with Session(engine) as session:
        stored = session.get(LlmCall, handle)
        assert stored is not None and stored.world_id == world_id
    engine.dispose()


@requires_db
def test_every_sandbox_together_spends_at_most_the_hourly_allowance(
    sandbox_log: tuple[DbCallLog, UUID, str],
) -> None:
    _, world_id, agent = sandbox_log
    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        other = create_world(session).id
        recent = Decimal(
            session.exec(
                select(func.coalesce(func.sum(LlmCall.cost_usd), 0)).where(
                    col(LlmCall.world_id).is_not(None),
                    col(LlmCall.world_id).not_in(PROTECTED_WORLDS),
                    col(LlmCall.created_at) > datetime.now(UTC) - timedelta(hours=1),
                )
            ).one()
        )
    log = DbCallLog(
        lambda: Session(engine),
        sandbox_budget=Decimal("1"),
        sandboxes_per_hour=recent + Decimal("0.01"),
    )
    plenty = Decimal("1000000")
    try:
        log.reserve(call(agent, world_id, "0.006"), plenty)
        # A second sandbox has its own allowance left, but not the hour's.
        with pytest.raises(BudgetExceeded, match="sandboxes"):
            log.reserve(call(agent, other, "0.006"), plenty)
        # Protected worlds only answer to the global budget.
        log.reserve(call(agent, WORLD_ID, "0.006"), plenty)
    finally:
        drop_worlds(engine, [other])
        engine.dispose()


@requires_db
def test_reset_never_refills_a_sandboxs_allowance(
    sandbox_log: tuple[DbCallLog, UUID, str],
) -> None:
    log, world_id, agent = sandbox_log
    log.reserve(call(agent, world_id, "0.009"), Decimal("1000000"))
    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        reset_world(session, world_id)
    engine.dispose()

    with pytest.raises(BudgetExceeded):
        log.reserve(call(agent, world_id, "0.002"), Decimal("1000000"))

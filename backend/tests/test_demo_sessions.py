"""No-sign-up demo sessions (T55): `POST /demo/start`, `POST /demo/persona`, and the hidden
per-sandbox model spend cap (`SANDBOX_LLM_BUDGET_USD`)."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, delete
from sqlmodel import Session, col, select

from app import auth
from app.auth import SESSION_COOKIE, RateLimit
from app.config import Settings, get_settings
from app.db import get_session
from app.llm import BudgetExceeded, CallRecord, DbCallLog, Tier
from app.main import app
from app.models import AuthAttemptKind, LlmCall, SessionKind, UserSession, World
from app.sandbox import create_world, ensure_live_world, is_sandbox, reset_world
from app.seed import LIVE_WORLD_ID, WORLD_ID, seed
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


def start(client: TestClient, persona: str = "rosa") -> Any:
    return client.post("/demo/start", json={"persona": persona})


def token_of(client: TestClient) -> str:
    token = client.cookies.get(SESSION_COOKIE)
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
    seen = client.get("/world").json()
    assert seen["id"] == body["id"] and seen["me"]["persona"] == "rosa"


@requires_db
def test_two_visitors_get_separate_sandboxes(session: Session, client: TestClient) -> None:
    other = TestClient(app)
    first = start(client).json()
    second = start(other, "arjun").json()

    assert first["id"] != second["id"]
    assert UUID(first["id"]) != LIVE_WORLD_ID and UUID(second["id"]) != LIVE_WORLD_ID
    assert client.get("/world").json()["id"] == first["id"]
    assert other.get("/world").json()["id"] == second["id"]


@requires_db
def test_switching_persona_stays_in_the_sandbox_and_revokes_the_old_session(
    session: Session, client: TestClient
) -> None:
    world_id = start(client, "rosa").json()["id"]
    old = token_of(client)

    switched = client.post("/demo/persona", json={"persona": "admin"})

    assert switched.status_code == 200, switched.text
    assert switched.json()["id"] == world_id
    assert switched.json()["me"]["persona"] == "admin" and switched.json()["me"]["is_admin"]
    assert token_of(client) != old
    assert row(session, old) is None
    assert client.get("/world").json()["me"]["persona"] == "admin"


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

    reset = client.post("/world/reset")

    assert reset.status_code == 200
    assert reset.json()["id"] == world_id and reset.json()["me"]["persona"] == "arjun"


@requires_db
def test_a_real_account_has_one_identity(session: Session, client: TestClient) -> None:
    assert client.post("/demo/persona", json={"persona": "admin"}).status_code == 401
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real@example.org", PASSWORD, "Real")
    sign_in(client, session, person)

    refused = client.post("/demo/persona", json={"persona": "admin"})

    assert (refused.status_code, refused.json()["detail"]) == (403, "demo_session_only")


@requires_db
def test_a_real_account_starting_a_demo_leaves_its_session_in_this_browser(
    session: Session, client: TestClient
) -> None:
    live = ensure_live_world(session)
    person = auth.register_person(session, live.id, "real2@example.org", PASSWORD, "Real")
    sign_in(client, session, person)
    real = token_of(client)

    assert start(client, "mia").status_code == 200

    assert row(session, real) is None
    assert client.get("/world").json()["me"]["persona"] == "mia"


@requires_db
def test_unknown_personas_are_refused(client: TestClient) -> None:
    assert start(client, "someone").status_code == 422
    assert client.post("/demo/start", json={}).json()["me"]["persona"] == "rosa"


@requires_db
def test_each_ip_may_start_only_so_many_sandboxes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import timedelta

    monkeypatch.setitem(
        auth.RATE_LIMITS, AuthAttemptKind.DEMO_START, RateLimit(2, timedelta(hours=1))
    )
    ip = f"10.9.{uuid4().int % 250}.{uuid4().int % 250}"
    visitors = [TestClient(app, headers={"X-Forwarded-For": ip}) for _ in range(3)]
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        trusted_proxy_hops=1,
        allowed_origins="http://testserver",
    )
    try:
        statuses = [start(v).status_code for v in visitors]
    finally:
        del app.dependency_overrides[get_settings]

    assert statuses == [200, 200, 429]


@requires_db
def test_the_hourly_sandbox_cap_holds_for_everyone(client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None,  # type: ignore[call-arg]
        sandbox_max_new_worlds_per_hour=0,
        allowed_origins="http://testserver",
    )
    try:
        refused = start(client)
    finally:
        del app.dependency_overrides[get_settings]

    assert (refused.status_code, refused.json()["detail"]) == (429, "demo_busy")
    assert refused.headers["retry-after"] == "600"


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

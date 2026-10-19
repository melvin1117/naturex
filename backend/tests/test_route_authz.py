"""Authorization on every route (T57, ADR-0005 §3).

- A route-inventory test: every route declares an authorization dependency (`authz.require` or
  an `authz.authorizes` dependency), except an explicit allowlist of public routes.
- A cross-world test: every object endpoint answers 404 for another world's object, even to a
  caller who could act on that object in its own world.
- Orders enforce TRADE (insider trading, admins), re-checked under the trader's lock.
- Events: `alert` events reach only their targets; streams close once their session ends.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi import APIRouter, Depends, FastAPI, Response, WebSocket
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, event, update
from sqlmodel import Session, col, select
from starlette.requests import Request
from starlette.routing import Route

from app import authz, events
from app.auth import SESSION_COOKIE, Principal
from app.authz import AUTHORIZERS, Action, require
from app.config import get_settings
from app.db import engine, get_session
from app.main import app
from app.middleware import SAFE_METHODS
from app.models import (
    Asset,
    CommunityMember,
    CommunityRole,
    Holding,
    Order,
    Report,
    SessionKind,
    StreamEventType,
    User,
    UserKind,
    UserSession,
    World,
)
from app.routers import market
from app.routers.runs import get_rating_runner
from app.sandbox import create_world, ensure_live_world
from app.seed import LIVE_WORLD_ID, seed
from app.seed import WORLD_ID as TEMPLATE_WORLD_ID
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import drop_worlds, start_demo

# Routes anyone may call without an authorization dependency, with the reason.
PUBLIC: dict[tuple[str, str], str] = {
    ("POST", "/auth/register"): "signing up",
    ("POST", "/auth/login"): "signing in",
    ("POST", "/auth/logout"): "signing out (a no-op without a session)",
    ("GET", "/healthz"): "liveness probe",
    ("GET", "/readyz"): "readiness probe",
    ("GET", "/media/demo-sites/{site_key}/overlay.png"): "curated public imagery, no world data",
    ("GET", "/media/demo-sites/{site_key}/thumbnail.webp"): "curated public imagery",
    ("GET", "/media/demo-sites/{site_key}/images.json"): "curated public imagery",
}


# --- Route inventory ----------------------------------------------------------------------------


# FastAPI's own documentation routes: plain Starlette routes with no world data.
DOC_ROUTES = frozenset({"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"})


def other_routes(target: FastAPI) -> list[tuple[str, str]]:
    """Every route that isn't an `APIRoute` (websockets, mounts, plain Starlette routes): the
    inventory can't see their dependencies, so each one is reported unless it's a doc route."""
    out: list[tuple[str, str]] = []
    for context in iter_route_contexts(target.routes):
        route = context.original_route
        if isinstance(route, APIRoute):
            continue
        path = str(getattr(route, "path", ""))
        if type(route) is Route and path in DOC_ROUTES:
            continue
        out.append((type(route).__name__, path))
    return sorted(out)


def route_actions(target: FastAPI) -> dict[tuple[str, str], frozenset[Action]]:
    """Each (method, path) of `target` with the actions its authorization dependencies check."""
    out: dict[tuple[str, str], frozenset[Action]] = {}
    for context in iter_route_contexts(target.routes):
        if not isinstance(context.original_route, APIRoute):
            continue
        found: set[Action] = set()
        stack = [context.dependant]
        while stack:
            dependant = stack.pop()
            found |= AUTHORIZERS.get(dependant.call, frozenset()) if dependant.call else set()
            stack.extend(dependant.dependencies)
        for method in context.methods or ():
            out[(method, context.path)] = frozenset(found)
    return out


def unguarded(target: FastAPI, public: dict[tuple[str, str], str]) -> list[tuple[str, str]]:
    api = [key for key, found in route_actions(target).items() if not found and key not in public]
    return sorted(api + other_routes(target))


def test_every_route_declares_an_authorization_dependency() -> None:
    assert unguarded(app, PUBLIC) == []


def test_the_public_allowlist_names_real_routes_only() -> None:
    """A stale entry would let a future route at that path skip the inventory."""
    assert set(PUBLIC) <= set(route_actions(app))


def test_state_changing_routes_never_authorize_by_browsing_alone() -> None:
    writes = {
        key: found
        for key, found in route_actions(app).items()
        if key[0] not in SAFE_METHODS and key not in PUBLIC
    }
    assert writes
    assert [key for key, found in writes.items() if found <= {Action.BROWSE}] == []


def test_the_inventory_catches_a_route_without_authorization() -> None:
    """The inventory test itself: an unguarded route is reported, a guarded one isn't."""
    probe = FastAPI()
    router = APIRouter()

    @router.get("/guarded", dependencies=[require(Action.BROWSE)])
    def guarded() -> None: ...

    @router.post("/forgot")
    def forgot() -> None: ...

    @router.get("/other-dependency", dependencies=[Depends(lambda: None)])
    def other() -> None: ...

    @probe.websocket("/live")
    async def live(websocket: WebSocket) -> None: ...

    probe.include_router(router)
    probe.mount("/sub", FastAPI())

    assert unguarded(probe, {}) == [
        ("APIWebSocketRoute", "/live"),
        ("GET", "/other-dependency"),
        ("Mount", "/sub"),
        ("POST", "/forgot"),
    ]


def test_admin_routes_are_operator_only() -> None:
    actions = route_actions(app)
    assert actions[("POST", "/admin/simulate/quarter")] == {Action.OPERATE}
    assert actions[("POST", "/admin/simulate/event")] == {Action.OPERATE}
    assert actions[("POST", "/admin/tamper-demo")] == {Action.TAMPER_DEMO}
    assert actions[("POST", "/orders")] == {Action.TRADE}
    assert actions[("GET", "/assets/{asset_id}/quote")] == {Action.BROWSE}
    assert actions[("POST", "/assets/{asset_id}/rate")] == {Action.OPERATE, Action.MANAGE_LISTING}


def test_the_order_request_body_is_unchanged_by_its_loader() -> None:
    """The TRADE loader reads the route's own body; the request schema stays `OrderCreate`."""
    body = app.openapi()["paths"]["/orders"]["post"]["requestBody"]
    assert body["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/OrderCreate"
    }


# --- DB fixtures --------------------------------------------------------------------------------


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so nothing persists."""
    command.upgrade(alembic_cfg(), "head")
    test_engine = create_engine(get_settings().database_url)
    with test_engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        ensure_live_world(db)
        yield db
        db.close()
        outer.rollback()
    test_engine.dispose()


class RecordingRunner:
    """Stands in for the rating runner: records starts, runs nothing, spends nothing."""

    def __init__(self) -> None:
        self.started: list[tuple[UUID, UUID]] = []

    def start(self, world_id: UUID, asset_id: UUID, **_: object) -> UUID:
        self.started.append((world_id, asset_id))
        return uuid4()


@pytest.fixture
def runner() -> RecordingRunner:
    return RecordingRunner()


@pytest.fixture
def client(session: Session, runner: RecordingRunner) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_rating_runner] = lambda: runner
    yield TestClient(app)
    app.dependency_overrides.clear()


def persona(session: Session, world_id: UUID, key: str) -> User:
    return session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == key)
    ).one()


@dataclass(frozen=True)
class Objects:
    """One sandbox's objects, for building requests."""

    world: World
    asset: UUID
    report: UUID
    run: UUID
    community: UUID
    owner: UUID


def objects(session: Session, world: World) -> Objects:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world.id).order_by(Asset.site_key)
    ).first()
    assert asset is not None and asset.community_id is not None
    report = session.exec(
        select(Report.id).where(Report.world_id == world.id, Report.asset_id == asset.id)
    ).first()
    assert report is not None
    run = uuid4()
    events.publish(
        session,
        world.id,
        StreamEventType.RATING_PROGRESS,
        {
            "run_id": str(run),
            "asset_id": str(asset.id),
            "seq": 0,
            "step": "queued",
            "status": "queued",
            "trigger": "api",
        },
    )
    session.commit()
    owner = persona(session, world.id, "rosa").id
    return Objects(world, asset.id, report, run, asset.community_id, owner)


# (method, path) → (the persona who could do it in its own world, its request body)
OBJECT_ROUTES: dict[tuple[str, str], tuple[str, Callable[[Objects], Any] | None]] = {
    ("GET", "/communities/{community_id}"): ("arjun", None),
    ("PATCH", "/communities/{community_id}"): ("rosa", lambda o: {"description": "x"}),
    ("GET", "/communities/{community_id}/members"): ("rosa", None),
    ("POST", "/communities/{community_id}/members"): ("rosa", lambda o: {"user_id": str(o.owner)}),
    ("DELETE", "/communities/{community_id}/members/{user_id}"): ("rosa", None),
    ("GET", "/assets/{asset_id}"): ("arjun", None),
    ("POST", "/assets/{asset_id}/evidence"): ("rosa", None),
    ("GET", "/assets/{asset_id}/reports"): ("arjun", None),
    ("GET", "/assets/{asset_id}/prices"): ("arjun", None),
    ("GET", "/assets/{asset_id}/quote"): ("arjun", None),
    ("POST", "/assets/{asset_id}/rate"): ("admin", None),
    ("GET", "/reports/{report_id}"): ("arjun", None),
    ("GET", "/reports/{report_id}/diff/{prev}"): ("arjun", None),
    ("GET", "/ledger/{asset_id}"): ("arjun", None),
    ("GET", "/ledger/{asset_id}/verify"): ("arjun", None),
    ("GET", "/runs/{run_id}"): ("arjun", None),
}
# Required query parameters, so the same-world control reaches the handler.
QUERIES: dict[tuple[str, str], dict[str, str]] = {
    ("GET", "/assets/{asset_id}/quote"): {"side": "buy", "qty": "1"},
}
# Object IDs that travel in a body or query instead of the path: (persona, body, query), built
# from the other world's objects. The path, if templated, is filled from the caller's own world.
IdIn = Callable[[Objects], dict[str, Any]]
ID_ROUTES: dict[tuple[str, str], tuple[str, IdIn | None, IdIn | None, str]] = {
    ("POST", "/orders"): (
        "arjun",
        lambda o: {"asset_id": str(o.asset), "side": "buy", "qty": 1},
        None,
        "not_found",
    ),
    ("POST", "/admin/simulate/event"): (
        "admin",
        lambda o: {"asset_id": str(o.asset), "preset": "fire"},
        None,
        "not_found",
    ),
    ("POST", "/admin/tamper-demo"): (
        "admin",
        lambda o: {"asset_id": str(o.asset)},
        None,
        "not_found",
    ),
    ("POST", "/copilot"): (
        "arjun",
        lambda o: {"question": "why?", "asset_id": str(o.asset)},
        None,
        "not_found",
    ),
    ("GET", "/admin/trace"): ("arjun", None, lambda o: {"asset_id": str(o.asset)}, "not_found"),
    # Adding another world's account to my own community: T68's own 404.
    ("POST", "/communities/{community_id}/members"): (
        "rosa",
        lambda o: {"user_id": str(o.owner)},
        None,
        "user_not_found",
    ),
}
# Routes whose `*_id` body or query fields aren't world objects (none yet); each needs a reason.
ID_EXCEPTIONS: dict[tuple[str, str], str] = {}


def _is_uuid(schema: dict[str, Any]) -> bool:
    return "uuid" in {schema.get("format"), *(s.get("format") for s in schema.get("anyOf", []))}


def id_carrying_routes() -> set[tuple[str, str]]:
    """Every operation whose JSON body or query has a UUID field ending in `_id`, read from the
    OpenAPI schema (the API's source of truth)."""
    spec = app.openapi()
    components = spec["components"]["schemas"]
    found: set[tuple[str, str]] = set()
    for path, operations in spec["paths"].items():
        for method, operation in operations.items():
            fields = {
                p["name"]: p.get("schema", {})
                for p in operation.get("parameters", [])
                if p["in"] == "query"
            }
            content = operation.get("requestBody", {}).get("content", {})
            ref = content.get("application/json", {}).get("schema", {}).get("$ref")
            if ref:
                fields |= components[ref.rsplit("/", 1)[-1]].get("properties", {})
            if any(name.endswith("_id") and _is_uuid(f) for name, f in fields.items()):
                found.add((method.upper(), path))
    return found


def fill(path: str, o: Objects) -> str:
    values = {
        "community_id": o.community,
        "user_id": o.owner,
        "asset_id": o.asset,
        "report_id": o.report,
        "prev": o.report,
        "run_id": o.run,
    }
    return re.sub(r"\{([^}]+)\}", lambda m: str(values[m.group(1)]), path)


def test_every_object_endpoint_is_in_the_cross_world_test() -> None:
    templated = {key for key in route_actions(app) if "{" in key[1] and key not in PUBLIC}
    assert templated == set(OBJECT_ROUTES)


def test_every_body_or_query_id_is_in_the_cross_world_test() -> None:
    assert id_carrying_routes() - set(ID_EXCEPTIONS) == set(ID_ROUTES)
    assert set(ID_EXCEPTIONS) <= id_carrying_routes(), "a stale exception"


@requires_db
@pytest.mark.parametrize(("method", "path"), sorted(OBJECT_ROUTES))
def test_another_worlds_object_is_not_found(
    session: Session, client: TestClient, runner: RecordingRunner, method: str, path: str
) -> None:
    mine, theirs = objects(session, create_world(session)), objects(session, create_world(session))
    key, body = OBJECT_ROUTES[(method, path)]
    start_demo(client, session, mine.world, persona_key=key)

    res = client.request(
        method,
        fill(path, theirs),
        json=body(theirs) if body else None,
        params=QUERIES.get((method, path)),
    )

    assert (res.status_code, res.json()["detail"]) == (404, "not_found"), res.text
    assert runner.started == []


@requires_db
@pytest.mark.parametrize(("method", "path"), sorted(ID_ROUTES))
def test_another_worlds_object_in_a_body_or_query_is_not_found(
    session: Session, client: TestClient, method: str, path: str
) -> None:
    mine, theirs = objects(session, create_world(session)), objects(session, create_world(session))
    key, body, query, detail = ID_ROUTES[(method, path)]
    start_demo(client, session, mine.world, persona_key=key)

    res = client.request(
        method,
        fill(path, mine),
        json=body(theirs) if body else None,
        params=query(theirs) if query else None,
    )

    assert (res.status_code, res.json()["detail"]) == (404, detail), res.text


@requires_db
def test_a_diff_against_another_worlds_report_is_not_found(
    session: Session, client: TestClient
) -> None:
    mine, theirs = objects(session, create_world(session)), objects(session, create_world(session))
    start_demo(client, session, mine.world)

    other = client.get(f"/reports/{mine.report}/diff/{theirs.report}")
    own = client.get(f"/reports/{mine.report}/diff/{mine.report}")

    assert (other.status_code, other.json()["detail"]) == (404, "not_found")
    assert own.status_code == 200


@requires_db
def test_another_worlds_asset_trace_is_not_found(session: Session, client: TestClient) -> None:
    mine, theirs = objects(session, create_world(session)), objects(session, create_world(session))
    start_demo(client, session, mine.world)

    other = client.get("/admin/trace", params={"asset_id": str(theirs.asset)})
    own = client.get("/admin/trace", params={"asset_id": str(mine.asset)})

    assert (other.status_code, own.status_code) == (404, 200)


@requires_db
@pytest.mark.parametrize(
    ("method", "path"), sorted(key for key in OBJECT_ROUTES if key[0] in SAFE_METHODS)
)
def test_the_same_reads_succeed_in_the_callers_own_world(
    session: Session, client: TestClient, method: str, path: str
) -> None:
    """The control for the cross-world test: the 404 comes from the world, not the route."""
    mine = objects(session, create_world(session))
    start_demo(client, session, mine.world, persona_key=OBJECT_ROUTES[(method, path)][0])

    res = client.request(method, fill(path, mine), params=QUERIES.get((method, path)))

    assert res.status_code == 200, res.text


# --- Orders: TRADE on the asset -----------------------------------------------------------------


def _buy(client: TestClient, asset_id: UUID) -> Any:
    return client.post("/orders", json={"asset_id": str(asset_id), "side": "buy", "qty": 1})


def _orders(session: Session, asset_id: UUID) -> int:
    return len(session.exec(select(Order).where(Order.asset_id == asset_id)).all())


@requires_db
@pytest.mark.parametrize(
    ("key", "reason"),
    [("rosa", "insider_trading_blocked"), ("admin", "admins_cannot_trade")],
)
def test_insiders_and_admins_cannot_trade(
    session: Session, client: TestClient, key: str, reason: str
) -> None:
    mine = objects(session, create_world(session))
    start_demo(client, session, mine.world, persona_key=key)

    res = _buy(client, mine.asset)

    assert (res.status_code, res.json()["detail"]) == (403, reason)
    assert res.headers["cache-control"] == "no-store"
    assert _orders(session, mine.asset) == 0


@requires_db
def test_an_investor_trades_as_itself(session: Session, client: TestClient) -> None:
    mine = objects(session, create_world(session))
    arjun = persona(session, mine.world.id, "arjun")
    start_demo(client, session, mine.world)

    res = _buy(client, mine.asset)

    assert res.status_code == 200, res.text
    order = session.exec(select(Order).where(Order.asset_id == mine.asset)).one()
    assert order.user_id == arjun.id


@requires_db
def test_a_membership_committed_while_an_order_waits_blocks_the_buy(
    session: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`require` passed before the membership existed; the re-check under the trader's lock
    (`fresh_actor`) sees it, so the order is refused and nothing is written."""
    mine = objects(session, create_world(session))
    arjun = persona(session, mine.world.id, "arjun")
    start_demo(client, session, mine.world)
    lock_trader = market._actor

    def joined_while_waiting(db: Session, world_id: UUID, principal: Principal, **kw: Any) -> User:
        db.add(
            CommunityMember(
                world_id=world_id,
                community_id=mine.community,
                user_id=arjun.id,
                role=CommunityRole.STEWARD,
            )
        )
        db.flush()
        return lock_trader(db, world_id, principal, **kw)

    monkeypatch.setattr(market, "_actor", joined_while_waiting)

    res = _buy(client, mine.asset)

    assert (res.status_code, res.json()["detail"]) == (403, "insider_trading_blocked")
    assert _orders(session, mine.asset) == 0


# --- Quotes: anyone may price an order; TRADE decides who may place it -------------------------


def _quote(client: TestClient, asset_id: UUID, side: str = "buy") -> dict[str, Any]:
    res = client.get(f"/assets/{asset_id}/quote", params={"side": side, "qty": 1})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


@requires_db
def test_anonymous_visitors_read_live_quotes(session: Session, client: TestClient) -> None:
    asset = session.exec(
        select(Asset.id).where(Asset.world_id == LIVE_WORLD_ID).order_by(Asset.site_key)
    ).first()
    assert asset is not None

    quote = _quote(client, asset)

    assert (quote["max_qty"], quote["trade_blocked_reason"]) == (None, None)
    assert Decimal(quote["total"]) > 0


@requires_db
def test_an_investor_gets_a_tradable_quote(session: Session, client: TestClient) -> None:
    mine = objects(session, create_world(session))
    start_demo(client, session, mine.world)

    quote = _quote(client, mine.asset)

    assert quote["trade_blocked_reason"] is None and quote["max_qty"] > 0


@requires_db
@pytest.mark.parametrize(
    ("key", "reason"),
    [("rosa", "insider_trading_blocked"), ("admin", "admins_cannot_trade")],
)
@pytest.mark.parametrize("side", ["buy", "sell"])
def test_a_quote_tells_blocked_traders_why_and_offers_nothing(
    session: Session, client: TestClient, key: str, reason: str, side: str
) -> None:
    mine = objects(session, create_world(session))
    start_demo(client, session, mine.world, persona_key=key)

    quote = _quote(client, mine.asset, side)

    assert (quote["max_qty"], quote["trade_blocked_reason"]) == (0, reason)
    assert Decimal(quote["total"]) > 0, "the price is still shown"
    assert _buy(client, mine.asset).json()["detail"] == reason, "the order agrees"


@requires_db
def test_a_quote_reflects_a_new_membership(session: Session, client: TestClient) -> None:
    mine = objects(session, create_world(session))
    arjun = persona(session, mine.world.id, "arjun")
    start_demo(client, session, mine.world)
    assert _quote(client, mine.asset)["trade_blocked_reason"] is None
    session.add(
        CommunityMember(
            world_id=mine.world.id,
            community_id=mine.community,
            user_id=arjun.id,
            role=CommunityRole.STEWARD,
        )
    )
    session.commit()

    assert _quote(client, mine.asset)["trade_blocked_reason"] == "insider_trading_blocked"


# --- Rating runs: an operator's re-rate or the community's own listing --------------------------


@requires_db
def test_an_admin_in_the_assets_community_rates_as_its_steward_not_as_operator(
    session: Session, client: TestClient, runner: RecordingRunner
) -> None:
    """`require_any(OPERATE, MANAGE_LISTING)`: OPERATE refuses an admin who belongs to the
    asset's community (`conflict_of_interest`), but as a steward it manages its own listing."""
    mine = objects(session, create_world(session))
    admin = persona(session, mine.world.id, "admin")
    session.add(
        CommunityMember(
            world_id=mine.world.id,
            community_id=mine.community,
            user_id=admin.id,
            role=CommunityRole.STEWARD,
        )
    )
    session.commit()
    start_demo(client, session, mine.world, persona_key="admin")

    res = client.post(f"/assets/{mine.asset}/rate")

    assert res.status_code == 202, res.text
    assert runner.started == [(mine.world.id, mine.asset)]


# --- Admin tools: operator actions on the asset ----------------------------------------------


@requires_db
def test_an_admin_cant_inject_events_into_its_own_communitys_asset(
    session: Session, client: TestClient
) -> None:
    mine = objects(session, create_world(session))
    admin = persona(session, mine.world.id, "admin")
    other = session.exec(
        select(Asset.id).where(
            Asset.world_id == mine.world.id, col(Asset.community_id) != mine.community
        )
    ).first()
    session.add(
        CommunityMember(
            world_id=mine.world.id,
            community_id=mine.community,
            user_id=admin.id,
            role=CommunityRole.STEWARD,
        )
    )
    session.commit()
    start_demo(client, session, mine.world, persona_key="admin")

    own = client.post("/admin/simulate/event", json={"asset_id": str(mine.asset), "preset": "fire"})
    impartial = client.post(
        "/admin/simulate/event", json={"asset_id": str(other), "preset": "fire"}
    )

    assert (own.status_code, own.json()["detail"]) == (403, "conflict_of_interest")
    assert impartial.status_code == 200, impartial.text


# --- Memberships are read only when a check needs them -----------------------------------------


@requires_db
def test_reads_never_load_memberships(
    session: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = objects(session, create_world(session))
    start_demo(client, session, mine.world)
    loads: list[UUID] = []
    load = authz.memberships

    def recording(db: Session, world_id: UUID, user_id: UUID) -> dict[UUID, CommunityRole]:
        loads.append(user_id)
        return load(db, world_id, user_id)

    monkeypatch.setattr(authz, "memberships", recording)
    for path in (f"/assets/{mine.asset}", "/assets", "/world", "/events"):
        assert client.get(path).status_code == 200, path
    assert loads == [], "BROWSE needs no community roles"

    assert _buy(client, mine.asset).status_code == 200
    assert len(loads) == 2, "TRADE reads them, then again under the trader's lock"


# --- Events: alerts reach only their targets ----------------------------------------------------


@requires_db
def test_alerts_reach_only_holders_and_the_assets_community(
    session: Session, client: TestClient
) -> None:
    mine = objects(session, create_world(session))
    world_id = mine.world.id
    arjun = persona(session, world_id, "arjun")
    session.add(Holding(world_id=world_id, user_id=arjun.id, asset_id=mine.asset, shares=5))
    targeted = events.publish(session, world_id, "alert", {"asset_id": str(mine.asset)})
    untargeted = events.publish(session, world_id, "alert", {"message": "no asset"})
    tick = events.publish(session, world_id, "price_tick", {"asset_id": str(mine.asset)})
    session.commit()
    since = {"since_id": targeted.id - 1}

    seen: dict[str, list[int]] = {}
    for key in ("arjun", "rosa", "mia", "admin"):
        start_demo(client, session, mine.world, persona_key=key)
        seen[key] = [event["id"] for event in client.get("/events", params=since).json()]

    assert seen["arjun"] == seen["rosa"] == [targeted.id, tick.id]  # holder; owner
    assert seen["mia"] == seen["admin"] == [tick.id]  # neither holds nor belongs
    assert untargeted.id not in {i for ids in seen.values() for i in ids}


@requires_db
def test_anonymous_readers_never_get_alerts(session: Session, client: TestClient) -> None:
    live = ensure_live_world(session)
    asset = session.exec(select(Asset.id).where(Asset.world_id == live.id)).first()
    alert = events.publish(session, live.id, "alert", {"asset_id": str(asset)})
    tick = events.publish(session, live.id, "price_tick", {"asset_id": str(asset)})
    session.commit()

    ids = [e["id"] for e in client.get("/events", params={"since_id": alert.id - 1}).json()]

    assert ids == [tick.id]


@requires_db
def test_a_viewer_is_public_outside_its_own_world(session: Session) -> None:
    world = create_world(session)
    arjun = persona(session, world.id, "arjun")
    principal = Principal(
        user_id=arjun.id,
        world_id=world.id,
        session_id=uuid4(),
        session_kind=SessionKind.DEMO,
        user_kind=UserKind.PERSONA,
        is_admin=False,
    )

    assert events.viewer_for(uuid4(), principal) == events.PUBLIC_VIEWER
    assert events.viewer_for(world.id, None) == events.PUBLIC_VIEWER
    assert events.viewer_for(world.id, principal) == events.Viewer(arjun.id)


@requires_db
def test_a_poll_costs_two_queries(session: Session) -> None:
    """Re-checking the session and reading the reader's events, alert targets included."""
    world = create_world(session)
    client = TestClient(app)
    start_demo(client, session, world)
    token = client.cookies[SESSION_COOKIE]
    session_id = session.exec(select(UserSession.id).where(UserSession.world_id == world.id)).one()
    auth = events.StreamAuth(token, session_id)
    statements: list[str] = []

    def count(*args: Any) -> None:
        if str(args[2]).lstrip().upper().startswith("SELECT"):
            statements.append(str(args[2]))

    connection = session.connection()
    event.listen(connection, "before_cursor_execute", count)
    try:
        viewer = events.current_viewer(session, world.id, auth)
        assert viewer is not None
        events.replay(session, world.id, viewer=viewer)
    finally:
        event.remove(connection, "before_cursor_execute", count)

    assert len(statements) == 2, statements


async def _streamed(world_id: UUID, auth: events.StreamAuth, since_id: int) -> str:
    chunks = events.stream(world_id, cast(Request, _Connected()), since_id, None, auth)
    return "".join([chunk async for chunk in chunks])


@requires_db
async def test_a_stream_delivers_alerts_only_to_their_targets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Over SSE too: the holder gets its asset's alert, another investor doesn't, and a holder
    who sold everything stops getting them."""
    command.upgrade(alembic_cfg(), "head")
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 0.1)
    monkeypatch.setattr(events, "STREAM_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(events, "HEARTBEAT_INTERVAL_SECONDS", 10.0)
    holder, other = TestClient(app), TestClient(app)
    with Session(engine) as setup:
        seed(setup)
        world = start_demo(holder, setup)
        start_demo(other, setup, world, persona_key="mia")
        world_id = world.id
        asset = setup.exec(select(Asset.id).where(Asset.world_id == world_id)).first()
        arjun = persona(setup, world_id, "arjun")
        setup.add(Holding(world_id=world_id, user_id=arjun.id, asset_id=asset, shares=5))
        first = events.publish(setup, world_id, "alert", {"asset_id": str(asset), "n": "first"})
        setup.commit()
        mia = persona(setup, world_id, "mia")

        def auth_of(client: TestClient, user: User) -> events.StreamAuth:
            row = setup.exec(select(UserSession.id).where(UserSession.user_id == user.id)).one()
            return events.StreamAuth(client.cookies[SESSION_COOKIE], row)

        arjun_auth, mia_auth = auth_of(holder, arjun), auth_of(other, mia)
        arjun_id = arjun.id
    since = first.id - 1
    try:
        assert '"n":"first"' in await _streamed(world_id, arjun_auth, since)
        assert '"n":"first"' not in await _streamed(world_id, mia_auth, since)

        with Session(engine) as db:
            db.execute(
                update(Holding)
                .where(col(Holding.world_id) == world_id, col(Holding.user_id) == arjun_id)
                .values(shares=0)
            )
            second = events.publish(db, world_id, "alert", {"asset_id": str(asset), "n": "second"})
            db.commit()

        assert '"n":"second"' not in await _streamed(world_id, arjun_auth, second.id - 1)
    finally:
        drop_worlds(engine, [world_id])


# --- Streams close when their session ends ------------------------------------------------------


def _end_by_logout(client: TestClient, session: Session, session_id: UUID) -> None:
    logout = TestClient(app, cookies=dict(client.cookies))
    assert logout.post("/auth/logout").status_code == 204


def _end_by_expiry(client: TestClient, session: Session, session_id: UUID) -> None:
    session.execute(
        update(UserSession)
        .where(col(UserSession.id) == session_id)
        .values(expires_at=UserSession.created_at)
    )
    session.commit()


def _end_by_revocation(client: TestClient, session: Session, session_id: UUID) -> None:
    session.execute(delete(UserSession).where(col(UserSession.id) == session_id))
    session.commit()


class _Connected:
    """A request whose client never disconnects."""

    async def is_disconnected(self) -> bool:
        return False


@requires_db
@pytest.mark.parametrize("end", [_end_by_logout, _end_by_expiry, _end_by_revocation])
async def test_a_stream_closes_once_its_session_ends(
    monkeypatch: pytest.MonkeyPatch,
    end: Callable[[TestClient, Session, UUID], None],
) -> None:
    """The stream re-checks its session on every poll, and a heartbeat only follows a poll that
    did: once the session ends, nothing more is sent and the stream ends."""
    command.upgrade(alembic_cfg(), "head")
    app.dependency_overrides.clear()
    monkeypatch.setattr(events, "STREAM_MAX_SECONDS", 20.0)
    monkeypatch.setattr(events, "STREAM_POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(events, "HEARTBEAT_INTERVAL_SECONDS", 0.0)
    client = TestClient(app)
    with Session(engine) as setup:
        seed(setup)
        world_id = start_demo(client, setup).id
        session_id = setup.exec(
            select(UserSession.id).where(UserSession.world_id == world_id)
        ).one()
    auth = events.StreamAuth(client.cookies[SESSION_COOKIE], session_id)
    stream = events.stream(world_id, cast(Request, _Connected()), None, None, auth)
    try:
        assert await anext(stream) == f"retry: {events.SSE_RETRY_MS}\n\n"
        assert (await anext(stream)).startswith("event: heartbeat"), "streaming while valid"
        with Session(engine) as db:
            end(client, db, session_id)
        started = time.monotonic()

        rest = [chunk async for chunk in stream]

        assert rest == [], "no heartbeat or event after the session ended"
        assert time.monotonic() - started < 5, "closed long before STREAM_MAX_SECONDS"
    finally:
        await stream.aclose()
        drop_worlds(engine, [world_id])


@requires_db
def test_the_stream_is_bound_to_the_callers_session(
    session: Session, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[tuple[UUID, events.StreamAuth | None]] = []

    def record(
        world_id: UUID,
        request: Request,
        since_id: int | None,
        max_concurrent: int,
        auth: events.StreamAuth | None = None,
    ) -> Response:
        opened.append((world_id, auth))
        return Response()

    monkeypatch.setattr(events, "EventStreamResponse", record)
    world = create_world(session)
    start_demo(client, session, world)
    signed_in = client.get("/events/stream")
    client.cookies.clear()
    anonymous = client.get("/events/stream")

    assert (signed_in.status_code, anonymous.status_code) == (200, 200)
    (own_world, own_auth), (anon_world, anon_auth) = opened
    session_id = session.exec(select(UserSession.id).where(UserSession.world_id == world.id)).one()
    assert own_world == world.id and own_auth is not None and own_auth.session_id == session_id
    assert (anon_world, anon_auth) == (LIVE_WORLD_ID, None)


@requires_db
def test_a_streams_reader_is_rechecked_against_its_session(session: Session) -> None:
    world = create_world(session)
    arjun = persona(session, world.id, "arjun")
    client = TestClient(app)
    start_demo(client, session, world)
    token = client.cookies["nx_session"]
    session_id = session.exec(select(UserSession.id).where(UserSession.user_id == arjun.id)).one()

    auth = events.StreamAuth(token, session_id)
    assert events.current_viewer(session, world.id, auth) is not None
    assert events.current_viewer(session, uuid4(), auth) is None, "another world"
    assert events.current_viewer(session, world.id, events.StreamAuth(token, uuid4())) is None
    assert events.current_viewer(session, world.id, None) == events.PUBLIC_VIEWER


# --- The demo admin persona: an admin in sandboxes, never in the live world ---------------------


@requires_db
def test_the_live_world_has_no_admin(session: Session) -> None:
    live = ensure_live_world(session)

    admins = session.exec(select(User).where(User.world_id == live.id, col(User.is_admin))).all()

    assert admins == []
    assert persona(session, create_world(session).id, "admin").is_admin


@requires_db
def test_seed_makes_a_pre_t57_templates_demo_admin_an_admin(session: Session) -> None:
    session.execute(
        update(User).where(col(User.world_id) == TEMPLATE_WORLD_ID).values(is_admin=False)
    )
    session.commit()

    seed(session)

    session.expire_all()
    admins = session.exec(
        select(User.persona_key).where(User.world_id == TEMPLATE_WORLD_ID, col(User.is_admin))
    ).all()
    assert admins == ["admin"]

"""Per-visitor sandbox worlds (T31, demo-plan §3.5): copy, isolate, reset, prune."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, text
from sqlalchemy.exc import DBAPIError
from sqlmodel import Session, select

from app.config import Settings, get_settings
from app.db import get_session
from app.ledger import append, entries_for, verify
from app.main import app
from app.market.revenue import pay_quarter
from app.models import (
    Alert,
    Asset,
    DocChunk,
    Event,
    EventSource,
    Holding,
    LedgerEntry,
    LedgerKind,
    LlmCall,
    Metrics,
    Order,
    OrderSide,
    PayoutLine,
    PayoutSalt,
    Price,
    Report,
    User,
    World,
)
from app.sandbox import (
    COOKIE_MAX_AGE_S,
    COOKIE_NAME,
    WorldLimitReached,
    create_world,
    ensure_live_world,
    prune_stale_worlds,
    reset_world,
)
from app.seed import (
    COMMUNITY_PERSONA,
    DEMO_GEOJSON,
    DEMO_SITES,
    LIVE_WORLD_ID,
    PERSONAS,
    WORLD_ID,
    seed,
)
from tests.conftest import alembic_cfg, requires_db

TEMPLATE_ASSET = DEMO_SITES[0].id


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test worlds never persist."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


def users(session: Session, world_id: UUID) -> list[User]:
    return list(session.exec(select(User).where(User.world_id == world_id)).all())


def assets(session: Session, world_id: UUID) -> list[Asset]:
    return list(session.exec(select(Asset).where(Asset.world_id == world_id)).all())


def persona(session: Session, world_id: UUID, key: str) -> User:
    return session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == key)
    ).one()


# --- Creating a world ------------------------------------------------------------------------


@requires_db
def test_new_world_copies_every_persona_and_demo_asset_with_fresh_ids(session: Session) -> None:
    world = create_world(session)

    copied_users = users(session, world.id)
    copied_assets = assets(session, world.id)
    assert {u.persona_key for u in copied_users} == {p.key for p in PERSONAS}
    assert {a.site_key for a in copied_assets} == {s.key for s in DEMO_SITES}
    assert not {u.id for u in copied_users} & {p.id for p in PERSONAS}
    assert not {a.id for a in copied_assets} & {s.id for s in DEMO_SITES}
    assert all(u.cash_balance == Decimal("10000.00") for u in copied_users)


@requires_db
def test_seed_upgrades_demo_site_boundaries_in_visitor_worlds(session: Session) -> None:
    world = create_world(session)
    site = next(s for s in DEMO_SITES if s.key == "mangrove_mx")
    copy = session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.site_key == site.key)
    ).one()
    # A visitor world cloned before T13, still holding the placeholder square.
    copy.name = "Coastal Mangrove Reserve"
    copy.geojson = {
        "type": "Polygon",
        "coordinates": [[[-87.52, 21.48], [-87.48, 21.48], [-87.48, 21.52], [-87.52, 21.48]]],
    }
    copy.area_ha = Decimal("320.00")
    copy.centroid_lat, copy.centroid_lon = 21.50, -87.50
    copy.primary_shares_remaining = 123
    copy.community_wallet = Decimal("42.00")
    session.add(copy)
    session.commit()

    seed(session)
    session.refresh(copy)

    assert copy.name == site.name
    assert copy.geojson == DEMO_GEOJSON[site.key]
    assert copy.area_ha == site.area_ha
    assert (copy.centroid_lat, copy.centroid_lon) == (site.centroid_lat, site.centroid_lon)
    assert copy.primary_shares_remaining == 123
    assert copy.community_wallet == Decimal("42.00")


@requires_db
def test_copied_assets_point_at_the_copied_community_persona(session: Session) -> None:
    world = create_world(session)

    rosa = persona(session, world.id, COMMUNITY_PERSONA.key)
    assert {a.community_user_id for a in assets(session, world.id)} == {rosa.id}


@requires_db
def test_template_holdings_prices_and_ledger_are_copied_and_remapped(session: Session) -> None:
    session.add(
        Price(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, price=Decimal("7.9200"), reason="ipo")
    )
    append(
        session,
        world_id=WORLD_ID,
        asset_id=TEMPLATE_ASSET,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    append(
        session,
        world_id=WORLD_ID,
        asset_id=TEMPLATE_ASSET,
        kind=LedgerKind.PRICE_ANCHOR,
        payload={"price": "7.9200", "reason": "ipo"},
    )
    session.commit()

    world = create_world(session)

    wetland = session.exec(
        select(Asset).where(Asset.world_id == world.id, Asset.site_key == DEMO_SITES[0].key)
    ).one()
    rosa = persona(session, world.id, COMMUNITY_PERSONA.key)
    holding = session.exec(
        select(Holding).where(Holding.world_id == world.id, Holding.asset_id == wetland.id)
    ).one()
    assert (holding.user_id, holding.shares) == (rosa.id, 510_000)
    world_assets = {a.id: a.site_key for a in assets(session, world.id)}
    template_assets = {a.id: a.site_key for a in assets(session, WORLD_ID)}

    def by_site(
        world_id: UUID, keys: dict[UUID, str | None]
    ) -> list[tuple[str | None, Decimal, str | None]]:
        rows = session.exec(select(Price).where(Price.world_id == world_id)).all()
        return sorted((keys[p.asset_id], p.price, p.reason) for p in rows)

    copied_prices = by_site(world.id, world_assets)
    assert copied_prices == by_site(WORLD_ID, template_assets)
    assert (DEMO_SITES[0].key, Decimal("7.9200"), "ipo") in copied_prices
    copied = entries_for(session, wetland.id)
    assert [e.kind for e in copied] == [LedgerKind.LISTING, LedgerKind.PRICE_ANCHOR]
    assert verify(copied).valid, "a copied chain must still verify"


# --- Isolation -------------------------------------------------------------------------------


@requires_db
def test_trading_in_one_world_never_touches_another_or_the_template(session: Session) -> None:
    first, second = create_world(session), create_world(session)
    arjun = persona(session, first.id, "arjun")
    wetland = assets(session, first.id)[0]

    arjun.cash_balance = Decimal("1.00")
    wetland.community_wallet = Decimal("999.00")
    session.add(Holding(world_id=first.id, user_id=arjun.id, asset_id=wetland.id, shares=5))
    session.commit()

    assert persona(session, second.id, "arjun").cash_balance == Decimal("10000.00")
    assert persona(session, WORLD_ID, "arjun").cash_balance == Decimal("10000.00")
    assert all(a.community_wallet == Decimal("0.00") for a in assets(session, second.id))
    assert all(a.community_wallet == Decimal("0.00") for a in assets(session, WORLD_ID))
    assert community_stake_only(session, second.id)


# --- Reset -----------------------------------------------------------------------------------


@requires_db
def test_reset_restores_the_template_state_and_keeps_the_world_id(session: Session) -> None:
    world = create_world(session)
    arjun = persona(session, world.id, "arjun")
    wetland = assets(session, world.id)[0]
    arjun.cash_balance = Decimal("42.00")
    session.add(Holding(world_id=world.id, user_id=arjun.id, asset_id=wetland.id, shares=7))
    session.add(
        Order(
            world_id=world.id,
            user_id=arjun.id,
            asset_id=wetland.id,
            side=OrderSide.BUY,
            qty=7,
            fill_price=Decimal("7.9300"),
        )
    )
    append(
        session,
        world_id=world.id,
        asset_id=wetland.id,
        kind=LedgerKind.EVENT,
        payload={"impact_type": "fire"},
    )
    session.commit()

    restored = reset_world(session, world.id)

    assert restored.id == world.id
    assert persona(session, world.id, "arjun").cash_balance == Decimal("10000.00")
    assert community_stake_only(session, world.id), "Arjun's holding is gone, Rosa's stake is back"
    assert session.exec(select(Order).where(Order.world_id == world.id)).all() == []
    assert session.exec(select(LedgerEntry).where(LedgerEntry.world_id == world.id)).all() == []
    assert len(users(session, world.id)) == len(PERSONAS)
    assert len(assets(session, world.id)) == len(DEMO_SITES)


@requires_db
def test_the_template_and_live_worlds_can_never_be_reset(session: Session) -> None:
    ensure_live_world(session)
    for world_id in (WORLD_ID, LIVE_WORLD_ID):
        with pytest.raises(ValueError):
            reset_world(session, world_id)


@requires_db
def test_reset_of_an_unknown_world_fails(session: Session) -> None:
    with pytest.raises(LookupError):
        reset_world(session, uuid4())


# --- Pruning ---------------------------------------------------------------------------------


@requires_db
def test_prune_removes_only_stale_visitor_worlds(session: Session) -> None:
    stale, fresh = create_world(session), create_world(session)
    stale_id, fresh_id = stale.id, fresh.id
    append(
        session,
        world_id=stale.id,
        asset_id=assets(session, stale.id)[0].id,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    long_ago = datetime.now(UTC) - timedelta(days=30)
    stale.last_seen_at = long_ago
    template = session.get(World, WORLD_ID)
    assert template is not None
    template.last_seen_at = long_ago
    live = ensure_live_world(session)
    live.last_seen_at = long_ago
    session.commit()

    removed = prune_stale_worlds(session, older_than=timedelta(days=7))

    assert removed == 1
    assert session.get(World, stale_id) is None
    assert users(session, stale_id) == []
    assert session.get(World, fresh_id) is not None
    assert session.get(World, WORLD_ID) is not None, "the template is never pruned"
    assert session.get(World, LIVE_WORLD_ID) is not None, "the live world is never pruned"


# --- API -------------------------------------------------------------------------------------


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


@requires_db
def test_first_visit_creates_a_world_and_sets_the_cookie(client: TestClient) -> None:
    res = client.get("/world")

    assert res.status_code == 200
    body = res.json()
    assert UUID(body["id"]) != WORLD_ID
    assert client.cookies.get(COOKIE_NAME) == body["id"]
    assert {p["key"] for p in body["personas"]} == {p.key for p in PERSONAS}
    assert {a["site_key"] for a in body["assets"]} == {s.key for s in DEMO_SITES}
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert f"max-age={COOKIE_MAX_AGE_S}" in cookie
    assert "secure" not in cookie, "plain-HTTP local development must still get the cookie"
    assert res.headers["cache-control"] == "no-store"


@requires_db
def test_returning_visitor_keeps_the_same_world(client: TestClient) -> None:
    first = client.get("/world").json()["id"]

    assert client.get("/world").json()["id"] == first


@pytest.mark.parametrize("cookie", ["not-a-uuid", str(uuid4()), str(WORLD_ID), str(LIVE_WORLD_ID)])
@requires_db
def test_bad_unknown_template_or_live_cookie_gets_a_fresh_world(
    session: Session, client: TestClient, cookie: str
) -> None:
    ensure_live_world(session)
    client.cookies.set(COOKIE_NAME, cookie)

    body = client.get("/world").json()

    assert body["id"] != cookie
    assert UUID(body["id"]) not in {WORLD_ID, LIVE_WORLD_ID}


@requires_db
def test_reset_endpoint_restores_the_visitors_world(session: Session, client: TestClient) -> None:
    world_id = UUID(client.get("/world").json()["id"])
    persona(session, world_id, "arjun").cash_balance = Decimal("5.00")
    session.commit()

    res = client.post("/world/reset")

    assert res.status_code == 200
    assert UUID(res.json()["id"]) == world_id
    arjun = next(p for p in res.json()["personas"] if p["key"] == "arjun")
    assert Decimal(arjun["cash_balance"]) == Decimal("10000.00")


@requires_db
def test_ledger_of_another_worlds_asset_is_not_visible(client: TestClient) -> None:
    mine = client.get("/world").json()
    other = TestClient(app).get("/world").json()

    assert client.get(f"/ledger/{mine['assets'][0]['id']}").status_code == 200
    assert client.get(f"/ledger/{other['assets'][0]['id']}").status_code == 404


# --- Review follow-ups -----------------------------------------------------------------------


def community_stake_only(session: Session, world_id: UUID) -> bool:
    """True when the world's holdings are exactly the template's: Rosa's retained stake."""
    rosa = persona(session, world_id, COMMUNITY_PERSONA.key)
    held = session.exec(select(Holding).where(Holding.world_id == world_id)).all()
    return sorted((h.user_id, h.shares) for h in held) == [(rosa.id, 510_000)] * len(DEMO_SITES)


def world_count(session: Session) -> int:
    return session.exec(select(func.count()).select_from(World)).one()


@requires_db
def test_first_visit_gets_the_community_stake_so_shares_are_conserved(
    session: Session, client: TestClient
) -> None:
    world_id = UUID(client.get("/world").json()["id"])

    rosa = persona(session, world_id, COMMUNITY_PERSONA.key)
    for asset in assets(session, world_id):
        held = session.exec(select(Holding).where(Holding.asset_id == asset.id)).all()
        assert [(h.user_id, h.shares) for h in held] == [(rosa.id, 510_000)]
        assert asset.primary_shares_remaining + sum(h.shares for h in held) == asset.total_shares


@requires_db
def test_world_scoped_routes_need_a_cookie_and_never_create_worlds(
    session: Session, client: TestClient
) -> None:
    before = world_count(session)

    ledger = client.get(f"/ledger/{TEMPLATE_ASSET}")
    reset = client.post("/world/reset")

    assert (ledger.status_code, ledger.json()["detail"]) == (401, "world_required")
    assert reset.status_code == 401
    assert world_count(session) == before
    assert COOKIE_NAME not in client.cookies


@requires_db
def test_new_worlds_are_capped_per_hour(session: Session, client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(sandbox_max_new_worlds_per_hour=0)

    res = client.get("/world")

    assert res.status_code == 503
    assert res.headers["retry-after"] == "300"
    with pytest.raises(WorldLimitReached):
        create_world(session, max_new_per_hour=0)


@requires_db
def test_cookie_is_secure_outside_development(client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(environment="production")

    res = client.get("/world")

    assert "secure" in res.headers["set-cookie"].lower()


@requires_db
def test_reset_and_prune_keep_llm_call_history(session: Session) -> None:
    kept, pruned = create_world(session), create_world(session)
    kept_id, pruned_id = kept.id, pruned.id
    for world_id in (kept_id, pruned_id):
        asset = assets(session, world_id)[0]
        session.add(
            LlmCall(world_id=world_id, asset_id=asset.id, agent="auditor", prompt_tokens=10)
        )
        arjun = persona(session, world_id, "arjun")
        session.add(
            Order(
                world_id=world_id,
                user_id=arjun.id,
                asset_id=asset.id,
                side=OrderSide.BUY,
                qty=1,
                fill_price=Decimal("7.9300"),
            )
        )
    pruned.last_seen_at = datetime.now(UTC) - timedelta(days=30)
    session.commit()

    reset_world(session, kept_id)
    prune_stale_worlds(session, older_than=timedelta(days=7))

    rows = {(c.world_id, c.asset_id) for c in session.exec(select(LlmCall)).all()}
    assert rows == {(kept_id, None), (None, None)}, (
        "spend history survives: reset detaches the asset, prune detaches world and asset"
    )
    assert session.exec(select(Order).where(Order.world_id == pruned_id)).all() == []


@requires_db
def test_reset_by_one_visitor_never_touches_another(session: Session, client: TestClient) -> None:
    other = TestClient(app)
    a_id = UUID(client.get("/world").json()["id"])
    b_id = UUID(other.get("/world").json()["id"])
    b_asset = assets(session, b_id)[0]
    append(
        session,
        world_id=b_id,
        asset_id=b_asset.id,
        kind=LedgerKind.EVENT,
        payload={"impact_type": "fire"},
    )
    persona(session, a_id, "arjun").cash_balance = Decimal("1.00")
    persona(session, b_id, "arjun").cash_balance = Decimal("2.00")
    session.commit()
    b_head = verify(entries_for(session, b_asset.id)).head

    assert client.post("/world/reset").status_code == 200

    assert persona(session, a_id, "arjun").cash_balance == Decimal("10000.00")
    assert persona(session, b_id, "arjun").cash_balance == Decimal("2.00")
    assert persona(session, WORLD_ID, "arjun").cash_balance == Decimal("10000.00")
    assert verify(entries_for(session, b_asset.id)).head == b_head


@requires_db
def test_full_template_round_trips_through_create_and_reset(session: Session) -> None:
    metrics = Metrics(
        world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, data_version="2026Q3", landcover={"water": 0.4}
    )
    session.add(metrics)
    session.flush()
    report = Report(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, version=1, metrics_id=metrics.id)
    session.add(report)
    session.flush()
    session.add(
        DocChunk(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, report_id=report.id, content="x")
    )
    session.add(
        Event(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, source=EventSource.ADMIN, title="t")
    )
    session.add(Alert(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, kind="grade", message="m"))
    append(
        session,
        world_id=WORLD_ID,
        asset_id=TEMPLATE_ASSET,
        kind=LedgerKind.REPORT,
        payload={"health": 72},
        ref_id=report.id,
    )
    session.commit()

    def check(world_id: UUID) -> None:
        wetland = session.exec(
            select(Asset).where(Asset.world_id == world_id, Asset.site_key == DEMO_SITES[0].key)
        ).one()
        copied_metrics = session.exec(select(Metrics).where(Metrics.world_id == world_id)).one()
        copied_report = session.exec(select(Report).where(Report.world_id == world_id)).one()
        chunk = session.exec(select(DocChunk).where(DocChunk.world_id == world_id)).one()
        entry = session.exec(select(LedgerEntry).where(LedgerEntry.world_id == world_id)).one()
        assert copied_metrics.asset_id == wetland.id
        assert copied_report.metrics_id == copied_metrics.id != metrics.id
        assert chunk.report_id == copied_report.id
        assert entry.ref_id == copied_report.id
        assert len(session.exec(select(Event).where(Event.world_id == world_id)).all()) == 1
        assert len(session.exec(select(Alert).where(Alert.world_id == world_id)).all()) == 1
        assert verify(entries_for(session, wetland.id)).valid

    world = create_world(session)
    world_id = world.id
    check(world_id)
    reset_world(session, world_id)
    check(world_id)


@requires_db
def test_ledger_delete_opt_in_is_off_again_after_a_reset(session: Session) -> None:
    world = create_world(session)
    append(
        session,
        world_id=world.id,
        asset_id=assets(session, world.id)[0].id,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    session.commit()
    reset_world(session, world.id)
    append(
        session,
        world_id=WORLD_ID,
        asset_id=TEMPLATE_ASSET,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    session.flush()

    with pytest.raises(DBAPIError, match="append-only"), session.begin_nested():
        session.execute(text("DELETE FROM ledger_entries"))


# --- Payouts (T67) ---------------------------------------------------------------------------


def _pay_in(session: Session, world_id: UUID) -> None:
    """One quarter's payout on the world's wetland, to Rosa's retained stake and Arjun."""
    wetland = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.site_key == DEMO_SITES[0].key)
    ).one()
    arjun = persona(session, world_id, "arjun")
    wetland.primary_shares_remaining -= 1_000
    session.add(Holding(world_id=world_id, user_id=arjun.id, asset_id=wetland.id, shares=1_000))
    session.flush()
    pay_quarter(
        session,
        world_id=world_id,
        asset_id=wetland.id,
        value_mid=Decimal("100000.00"),
        quarter_label="2026-Q4",
    )
    session.commit()


def payout_rows(session: Session, world_id: UUID) -> int:
    lines = session.exec(select(PayoutLine).where(PayoutLine.world_id == world_id)).all()
    salts = session.exec(select(PayoutSalt).where(PayoutSalt.world_id == world_id)).all()
    return len(lines) + len(salts)


@requires_db
def test_reset_and_prune_delete_a_worlds_private_payout_lines(session: Session) -> None:
    kept, pruned = create_world(session), create_world(session)
    kept_id, pruned_id = kept.id, pruned.id
    for world_id in (kept_id, pruned_id):
        _pay_in(session, world_id)
        assert payout_rows(session, world_id) == 3, "two lines and one salt"
    pruned.last_seen_at = datetime.now(UTC) - timedelta(days=30)
    session.commit()

    reset_world(session, kept_id)
    prune_stale_worlds(session, older_than=timedelta(days=7))

    assert payout_rows(session, kept_id) == 0
    assert payout_rows(session, pruned_id) == 0
    assert session.get(World, pruned_id) is None


@requires_db
def test_payouts_in_a_visitor_world_never_reach_new_copies(session: Session) -> None:
    visitor = create_world(session)
    _pay_in(session, visitor.id)

    fresh = create_world(session)

    assert payout_rows(session, fresh.id) == 0
    assert payout_rows(session, WORLD_ID) == 0


@requires_db
def test_a_template_holding_payouts_is_never_copied(session: Session) -> None:
    """Copies remap user IDs, so copied lines couldn't verify against the copied commitment."""
    _pay_in(session, WORLD_ID)

    with pytest.raises(RuntimeError, match="holds payouts"):
        create_world(session)

"""Demo sandbox worlds (T31, demo-plan §3.5): copy, isolate, reset, prune.

Over HTTP a sandbox is reached only through its own demo session (T73, tests.worlds.start_demo).
"""

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
from sqlmodel import Session, col, select

from app.config import get_settings
from app.db import get_session
from app.ledger import append, entries_for, verify
from app.main import app
from app.market.revenue import pay_quarter
from app.models import (
    Alert,
    Asset,
    Community,
    CommunityMember,
    CommunityRole,
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
    Price,
    Report,
    User,
    UserKind,
    World,
)
from app.sandbox import (
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
from tests.worlds import start_demo

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


def treasuries(session: Session, world_id: UUID) -> set[UUID]:
    """The world's community treasuries (T56), which hold the retained stakes."""
    return {
        c.treasury_user_id
        for c in session.exec(select(Community).where(Community.world_id == world_id)).all()
    }


# --- Creating a world ------------------------------------------------------------------------


@requires_db
def test_new_world_copies_every_persona_and_demo_asset_with_fresh_ids(session: Session) -> None:
    world = create_world(session)

    copied_users = users(session, world.id)
    copied_personas = [u for u in copied_users if u.kind == UserKind.PERSONA]
    copied_assets = assets(session, world.id)
    assert {u.persona_key for u in copied_personas} == {p.key for p in PERSONAS}
    assert {u.id for u in copied_users} - {u.id for u in copied_personas} == treasuries(
        session, world.id
    )
    assert {a.site_key for a in copied_assets} == {s.key for s in DEMO_SITES}
    assert not {u.id for u in copied_users} & {u.id for u in users(session, WORLD_ID)}
    assert not {a.id for a in copied_assets} & {s.id for s in DEMO_SITES}
    assert all(u.cash_balance == Decimal("10000.00") for u in copied_personas)


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
def test_copied_assets_point_at_the_copied_communities_and_treasuries(session: Session) -> None:
    world = create_world(session)

    rosa = persona(session, world.id, COMMUNITY_PERSONA.key)
    communities = session.exec(select(Community).where(Community.world_id == world.id)).all()
    members = session.exec(
        select(CommunityMember).where(CommunityMember.world_id == world.id)
    ).all()
    by_id = {c.id: c for c in communities}
    for asset in assets(session, world.id):
        assert asset.community_id in by_id
        assert asset.community_user_id == by_id[asset.community_id].treasury_user_id
    assert sorted((m.community_id, m.user_id, m.role) for m in members) == sorted(
        (c.id, rosa.id, CommunityRole.OWNER) for c in communities
    )


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
    holding = session.exec(
        select(Holding).where(Holding.world_id == world.id, Holding.asset_id == wetland.id)
    ).one()
    assert (holding.user_id, holding.shares) == (wetland.community_user_id, 510_000)
    assert holding.user_id in treasuries(session, world.id)
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
    assert [e.kind for e in copied] == [
        LedgerKind.REPORT,  # the seed's report v1 (T19)
        LedgerKind.LISTING,
        LedgerKind.PRICE_ANCHOR,
    ]
    copied_report = session.exec(select(Report).where(Report.asset_id == wetland.id)).one()
    assert copied[0].ref_id == copied_report.id
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
    assert community_stake_only(session, world.id), "Arjun's holding is gone, the stakes are back"
    assert session.exec(select(Order).where(Order.world_id == world.id)).all() == []
    kinds = session.exec(select(LedgerEntry.kind).where(LedgerEntry.world_id == world.id)).all()
    assert kinds == [LedgerKind.REPORT] * len(DEMO_SITES), "only the template's report entries"
    assert len(users(session, world.id)) == len(PERSONAS) + len(DEMO_SITES), "+ 3 treasuries"
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
def test_a_demo_session_reads_its_own_sandbox(session: Session, client: TestClient) -> None:
    world = start_demo(client, session)

    res = client.get("/world")

    assert res.status_code == 200
    body = res.json()
    assert UUID(body["id"]) == world.id
    assert UUID(body["id"]) not in {WORLD_ID, LIVE_WORLD_ID}
    assert {p["key"] for p in body["personas"]} == {p.key for p in PERSONAS}
    assert {a["site_key"] for a in body["assets"]} == {s.key for s in DEMO_SITES}
    assert body["me"]["id"] == str(persona(session, world.id, "arjun").id)
    assert "set-cookie" not in res.headers, "no world cookie is issued any more (T73)"
    assert res.headers["cache-control"] == "no-store"
    assert client.get("/world").json()["id"] == body["id"]


@pytest.mark.parametrize("cookie", ["not-a-uuid", str(uuid4()), str(WORLD_ID), "sandbox"])
@requires_db
def test_an_nx_world_cookie_is_ignored(session: Session, client: TestClient, cookie: str) -> None:
    sandbox = create_world(session)
    client.cookies.set("nx_world", str(sandbox.id) if cookie == "sandbox" else cookie)

    body = client.get("/world").json()

    assert UUID(body["id"]) == LIVE_WORLD_ID
    assert body["me"] is None


@requires_db
def test_reset_endpoint_restores_the_demo_sandbox(session: Session, client: TestClient) -> None:
    world_id = start_demo(client, session).id
    persona(session, world_id, "arjun").cash_balance = Decimal("5.00")
    session.commit()

    res = client.post("/world/reset")

    assert res.status_code == 200
    assert UUID(res.json()["id"]) == world_id
    arjun = next(p for p in res.json()["personas"] if p["key"] == "arjun")
    assert Decimal(arjun["cash_balance"]) == Decimal("10000.00")
    assert client.get("/me").status_code == 200, "the demo session survives the reset"


@requires_db
def test_ledger_of_another_worlds_asset_is_not_visible(
    session: Session, client: TestClient
) -> None:
    other = TestClient(app)
    mine = start_demo(client, session)
    theirs = start_demo(other, session)

    assert client.get(f"/ledger/{assets(session, mine.id)[0].id}").status_code == 200
    assert client.get(f"/ledger/{assets(session, theirs.id)[0].id}").status_code == 404


# --- Review follow-ups -----------------------------------------------------------------------


def community_stake_only(session: Session, world_id: UUID) -> bool:
    """True when the world's holdings are exactly the template's: each treasury's retained
    stake in its own community's asset."""
    held = session.exec(select(Holding).where(Holding.world_id == world_id)).all()
    stakes = sorted((a.community_user_id, a.id, 510_000) for a in assets(session, world_id))
    return sorted((h.user_id, h.asset_id, h.shares) for h in held) == stakes


def world_count(session: Session) -> int:
    return session.exec(select(func.count()).select_from(World)).one()


@requires_db
def test_first_visit_gets_the_community_stake_so_shares_are_conserved(
    session: Session, client: TestClient
) -> None:
    world_id = start_demo(client, session).id

    for asset in assets(session, world_id):
        held = session.exec(select(Holding).where(Holding.asset_id == asset.id)).all()
        assert [(h.user_id, h.shares) for h in held] == [(asset.community_user_id, 510_000)]
        assert asset.primary_shares_remaining + sum(h.shares for h in held) == asset.total_shares


@requires_db
def test_anonymous_requests_read_the_live_world_and_never_create_sandboxes(
    session: Session, client: TestClient
) -> None:
    ensure_live_world(session)
    before = world_count(session)

    ledger = client.get(f"/ledger/{TEMPLATE_ASSET}")
    reset = client.post("/world/reset")

    assert ledger.status_code == 404, "the template's asset isn't in the live world"
    assert (reset.status_code, reset.json()["detail"]) == (401, "auth_required")
    assert world_count(session) == before


@requires_db
def test_new_worlds_are_capped_per_hour(session: Session) -> None:
    with pytest.raises(WorldLimitReached):
        create_world(session, max_new_per_hour=0)


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
    a_id = start_demo(client, session).id
    b_id = start_demo(other, session).id
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
    # The seed already stored report v1 (T19).
    report = Report(world_id=WORLD_ID, asset_id=TEMPLATE_ASSET, version=2, metrics_id=metrics.id)
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
        copied_metrics = session.exec(
            select(Metrics)
            .where(Metrics.world_id == world_id, Metrics.asset_id == wetland.id)
            .order_by(col(Metrics.created_at).desc())
        ).first()
        assert copied_metrics is not None
        copied_report = session.exec(
            select(Report).where(Report.world_id == world_id, Report.version == 2)
        ).one()
        chunk = session.exec(select(DocChunk).where(DocChunk.world_id == world_id)).one()
        entry = session.exec(
            select(LedgerEntry).where(LedgerEntry.world_id == world_id, LedgerEntry.seq == 1)
        ).one()
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
    """One quarter's payout on the world's wetland, to its treasury's retained stake and Arjun."""
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
    return len(session.exec(select(PayoutLine).where(PayoutLine.world_id == world_id)).all())


@requires_db
def test_reset_and_prune_delete_a_worlds_private_payout_lines(session: Session) -> None:
    kept, pruned = create_world(session), create_world(session)
    kept_id, pruned_id = kept.id, pruned.id
    for world_id in (kept_id, pruned_id):
        _pay_in(session, world_id)
        assert payout_rows(session, world_id) == 2, "the treasury's and Arjun's lines"
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

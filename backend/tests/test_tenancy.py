"""Communities, members, treasuries and DB-enforced world isolation (ADR-0005 §2–§4, T56)."""

from __future__ import annotations

import importlib.util
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from sqlalchemy import create_engine, func, inspect, text, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, col, select

from app.auth import resolve_session, start_session
from app.config import get_settings
from app.ledger import entries_for, verify
from app.market.revenue import pay_quarter, verify_payout_commitment
from app.models import (
    Asset,
    Community,
    CommunityMember,
    CommunityRole,
    Holding,
    LedgerEntry,
    LedgerKind,
    LlmCall,
    Order,
    OrderSide,
    PayoutLine,
    SessionKind,
    User,
    UserKind,
    UserRole,
    UserSession,
    World,
    WorldEvent,
)
from app.sandbox import (
    _DELETE_ORDER,
    create_world,
    ensure_live_world,
    prune_stale_worlds,
    reset_world,
)
from app.seed import (
    COMMUNITY_PERSONA,
    DEMO_SITES,
    LIVE_WORLD_ID,
    PERSONAS,
    SEED_COMMUNITIES,
    WORLD_ID,
    seed,
)
from tests.conftest import alembic_cfg, requires_db

D = Decimal
RETAINED = 510_000


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


def rows(session: Session, model: type[SQLModel], world_id: UUID) -> list[Any]:
    world_col: Any = model.__table__.c.world_id  # type: ignore[attr-defined]
    return list(session.exec(select(model).where(world_col == world_id)).all())


def persona(session: Session, world_id: UUID, key: str) -> User:
    return session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == key)
    ).one()


def site_asset(session: Session, world_id: UUID, n: int = 0) -> Asset:
    return session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.site_key == DEMO_SITES[n].key)
    ).one()


def community_of(session: Session, asset: Asset) -> Community:
    assert asset.community_id is not None
    return session.get_one(Community, asset.community_id)


def assert_tenancy_invariants(session: Session, world_id: UUID, *, traded: bool = False) -> None:
    """Every asset has its own community, whose treasury holds the retained stake and whose
    only member is Rosa as owner; shares are conserved."""
    assets = rows(session, Asset, world_id)
    communities = {c.id: c for c in rows(session, Community, world_id)}
    rosa = persona(session, world_id, COMMUNITY_PERSONA.key)
    assert len(assets) == len(communities) == len(DEMO_SITES)
    assert len({c.treasury_user_id for c in communities.values()}) == len(communities)
    for asset in assets:
        community = communities[asset.community_id]
        treasury = session.get_one(User, community.treasury_user_id)
        assert asset.community_user_id == treasury.id
        assert treasury.world_id == world_id
        assert treasury.kind == UserKind.TREASURY
        assert (treasury.email, treasury.password_hash, treasury.persona_key) == (None, None, None)
        assert not treasury.is_admin
        held = rows(session, Holding, world_id)
        stake = [h for h in held if h.asset_id == asset.id and h.user_id == treasury.id]
        assert [h.shares for h in stake] == [RETAINED]
        held_total = sum(h.shares for h in held if h.asset_id == asset.id)
        if traded:
            assert asset.primary_shares_remaining + held_total <= asset.total_shares
        else:
            assert asset.primary_shares_remaining + held_total == asset.total_shares
        members = session.exec(
            select(CommunityMember).where(CommunityMember.community_id == community.id)
        ).all()
        assert [(m.world_id, m.user_id, m.role) for m in members] == [
            (world_id, rosa.id, CommunityRole.OWNER)
        ]
    assert rosa.id not in {h.user_id for h in rows(session, Holding, world_id)}, (
        "the owner is a member, not a holder"
    )


# --- Seed --------------------------------------------------------------------------------------


@requires_db
def test_seed_gives_each_curated_site_a_community_owner_and_treasury(session: Session) -> None:
    assert_tenancy_invariants(session, WORLD_ID)
    for seeded in SEED_COMMUNITIES:
        asset = session.get_one(Asset, seeded.site.id)
        assert (asset.community_id, asset.community_user_id) == (seeded.id, seeded.treasury_id)
        treasury = session.get_one(User, seeded.treasury_id)
        assert (treasury.cash_balance, treasury.role) == (D("0.00"), UserRole.COMMUNITY)


def test_migration_backfill_uses_the_seed_ids() -> None:
    """Migration 0009 freezes the template's community and treasury IDs; they must match."""
    path = Path(__file__).parents[1] / "migrations/versions/0009_communities.py"
    spec = importlib.util.spec_from_file_location("migration_0009", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    assert {
        c.site.id: (c.id, c.treasury_id) for c in SEED_COMMUNITIES
    } == migration.TEMPLATE_COMMUNITY_IDS
    assert (migration.TEMPLATE_WORLD_ID, migration.LIVE_WORLD_ID) == (WORLD_ID, LIVE_WORLD_ID)


# --- Cross-world references fail in the database ---------------------------------------------


def _two_worlds(session: Session) -> tuple[UUID, UUID]:
    return create_world(session).id, create_world(session).id


@requires_db
def test_a_member_cannot_be_a_user_from_another_world(session: Session) -> None:
    mine, other = _two_worlds(session)
    community = community_of(session, site_asset(session, mine))
    stranger = persona(session, other, "mia")

    with pytest.raises(IntegrityError, match="fk_community_members_user"), session.begin_nested():
        session.add(
            CommunityMember(
                community_id=community.id,
                user_id=stranger.id,
                world_id=mine,
                role=CommunityRole.STEWARD,
            )
        )
        session.flush()


@requires_db
def test_a_member_cannot_join_a_community_in_another_world(session: Session) -> None:
    mine, other = _two_worlds(session)
    foreign = community_of(session, site_asset(session, other))
    mia = persona(session, mine, "mia")

    with (
        pytest.raises(IntegrityError, match="fk_community_members_community"),
        session.begin_nested(),
    ):
        session.add(
            CommunityMember(
                community_id=foreign.id, user_id=mia.id, world_id=mine, role=CommunityRole.STEWARD
            )
        )
        session.flush()


@pytest.mark.parametrize(
    ("values", "constraint"),
    [
        # An asset can't belong to another world's community.
        (lambda own, foreign: {"community_id": foreign.id, "community_user_id": None},
         "fk_assets_community"),
        # Nor point its treasury at another world's user.
        (lambda own, foreign: {"community_id": None, "community_user_id": foreign.treasury_user_id},
         "fk_assets_community_user"),
    ],
)  # fmt: skip
@requires_db
def test_an_asset_cannot_reference_another_worlds_community_or_treasury(
    session: Session,
    values: Callable[[Community, Community], dict[str, UUID | None]],
    constraint: str,
) -> None:
    mine, other = _two_worlds(session)
    asset = site_asset(session, mine)
    own, foreign = community_of(session, asset), community_of(session, site_asset(session, other))

    with pytest.raises(IntegrityError, match=constraint), session.begin_nested():
        session.execute(
            update(Asset).where(col(Asset.id) == asset.id).values(**values(own, foreign))
        )


@requires_db
def test_an_assets_treasury_must_be_its_own_communitys(session: Session) -> None:
    world = create_world(session).id
    wetland, mangrove = site_asset(session, world, 0), site_asset(session, world, 1)

    with (
        pytest.raises(IntegrityError, match="fk_assets_community_treasury"),
        session.begin_nested(),
    ):
        session.execute(
            update(Asset)
            .where(col(Asset.id) == wetland.id)
            .values(community_user_id=mangrove.community_user_id)
        )


@requires_db
def test_a_community_cannot_use_another_worlds_treasury(session: Session) -> None:
    mine, other = _two_worlds(session)
    spare = User(world_id=other, name="Spare", role=UserRole.COMMUNITY, kind=UserKind.TREASURY)
    session.add(spare)
    session.flush()

    with (
        pytest.raises(IntegrityError, match="fk_communities_treasury_user"),
        session.begin_nested(),
    ):
        session.add(Community(world_id=mine, name="Borrowed", treasury_user_id=spare.id))
        session.flush()


def _holding(world_id: UUID, user_id: UUID, asset_id: UUID) -> SQLModel:
    return Holding(world_id=world_id, user_id=user_id, asset_id=asset_id, shares=1)


def _order(world_id: UUID, user_id: UUID, asset_id: UUID, qty: int = 1) -> SQLModel:
    return Order(
        world_id=world_id,
        user_id=user_id,
        asset_id=asset_id,
        side=OrderSide.BUY,
        qty=qty,
        fill_price=D("1.0000"),
    )


@pytest.mark.parametrize(
    ("make_row", "foreign", "constraint"),
    [
        (_holding, "user", "fk_holdings_user"),
        (_holding, "asset", "fk_holdings_asset"),
        (_order, "user", "fk_orders_user"),
        (_order, "asset", "fk_orders_asset"),
    ],
)
@requires_db
def test_a_holding_or_order_cannot_reference_another_worlds_user_or_asset(
    session: Session,
    make_row: Callable[[UUID, UUID, UUID], SQLModel],
    foreign: str,
    constraint: str,
) -> None:
    mine, other = _two_worlds(session)
    user_world, asset_world = (other, mine) if foreign == "user" else (mine, other)
    user = persona(session, user_world, "mia")
    asset = site_asset(session, asset_world)

    with pytest.raises(IntegrityError, match=constraint), session.begin_nested():
        session.add(make_row(mine, user.id, asset.id))
        session.flush()


# --- Treasuries ----------------------------------------------------------------------------


def _treasury(session: Session, world_id: UUID) -> User:
    return session.get_one(User, site_asset(session, world_id).community_user_id)


@requires_db
def test_each_community_has_its_own_treasury(session: Session) -> None:
    taken = _treasury(session, WORLD_ID)

    with (
        pytest.raises(IntegrityError, match="uq_communities_treasury_user_id"),
        session.begin_nested(),
    ):
        session.add(Community(world_id=WORLD_ID, name="Second", treasury_user_id=taken.id))
        session.flush()


@requires_db
def test_a_communitys_treasury_must_be_a_treasury_account(session: Session) -> None:
    rosa = persona(session, WORLD_ID, COMMUNITY_PERSONA.key)

    with pytest.raises(IntegrityError, match="treasury account"), session.begin_nested():
        session.add(Community(world_id=WORLD_ID, name="Persona-run", treasury_user_id=rosa.id))
        session.flush()


@requires_db
def test_a_treasury_can_never_hold_credentials(session: Session) -> None:
    treasury = _treasury(session, WORLD_ID)

    for values in ({"email": "treasury@example.org"}, {"password_hash": "$argon2id$x"}):
        with (
            pytest.raises(IntegrityError, match="ck_users_credentials_person_only"),
            session.begin_nested(),
        ):
            session.execute(update(User).where(col(User.id) == treasury.id).values(**values))


@requires_db
def test_a_treasury_cannot_trade_sign_in_or_be_a_member(session: Session) -> None:
    treasury = _treasury(session, WORLD_ID)
    community = community_of(session, site_asset(session, WORLD_ID))
    attempts: list[tuple[str, SQLModel]] = [
        (
            "can't trade",
            Order(
                world_id=WORLD_ID,
                user_id=treasury.id,
                asset_id=DEMO_SITES[0].id,
                side=OrderSide.SELL,
                qty=1,
                fill_price=D("1.0000"),
            ),
        ),
        (
            "can't sign in",
            UserSession(
                token_hash="t" * 64,
                world_id=WORLD_ID,
                user_id=treasury.id,
                kind=SessionKind.DEMO,
                expires_at=datetime.now(UTC) + timedelta(days=1),
            ),
        ),
        (
            "can't be community members",
            CommunityMember(
                community_id=community.id,
                user_id=treasury.id,
                world_id=WORLD_ID,
                role=CommunityRole.STEWARD,
            ),
        ),
    ]
    for message, row in attempts:
        with pytest.raises(IntegrityError, match=message), session.begin_nested():
            session.add(row)
            session.flush()


@requires_db
def test_a_communitys_treasury_cannot_stop_being_a_treasury(session: Session) -> None:
    treasury = _treasury(session, WORLD_ID)

    for kind in (UserKind.PERSONA, UserKind.PERSON):
        with pytest.raises(IntegrityError, match="must stay a treasury"), session.begin_nested():
            session.execute(update(User).where(col(User.id) == treasury.id).values(kind=kind))


@requires_db
def test_a_user_with_sessions_orders_or_memberships_cannot_become_a_treasury(
    session: Session,
) -> None:
    world_id = create_world(session).id
    rosa = persona(session, world_id, COMMUNITY_PERSONA.key)  # an owner
    arjun = persona(session, world_id, "arjun")
    mia = persona(session, world_id, "mia")
    start_session(session, mia, SessionKind.DEMO)
    session.add(
        Order(
            world_id=world_id,
            user_id=arjun.id,
            asset_id=site_asset(session, world_id).id,
            side=OrderSide.BUY,
            qty=1,
            fill_price=D("1.0000"),
        )
    )
    session.commit()

    for user in (rosa, arjun, mia):
        with (
            pytest.raises(IntegrityError, match="can't become a treasury"),
            session.begin_nested(),
        ):
            session.execute(
                update(User).where(col(User.id) == user.id).values(kind=UserKind.TREASURY)
            )

    # A user with none of them can; a treasury no community names can become a persona again.
    admin = persona(session, world_id, "admin")
    session.execute(update(User).where(col(User.id) == admin.id).values(kind=UserKind.TREASURY))
    session.execute(update(User).where(col(User.id) == admin.id).values(kind=UserKind.PERSONA))
    session.flush()


@requires_db
def test_pay_quarter_pays_the_retained_dividend_to_the_treasury(session: Session) -> None:
    world_id = create_world(session).id
    wetland = site_asset(session, world_id)
    arjun = persona(session, world_id, "arjun")
    rosa = persona(session, world_id, COMMUNITY_PERSONA.key)
    treasury = _treasury(session, world_id)
    wetland.primary_shares_remaining -= 90_000
    session.add(Holding(world_id=world_id, user_id=arjun.id, asset_id=wetland.id, shares=90_000))
    session.flush()

    applied = pay_quarter(
        session,
        world_id=world_id,
        asset_id=wetland.id,
        value_mid=D("100000.00"),
        quarter_label="2026-Q4",
    )
    session.commit()

    # revenue 500.00 → fund 250.00, dividends 250.00 over 600 000 held shares.
    assert (treasury.cash_balance, arjun.cash_balance) == (D("212.50"), D("10037.50"))
    assert rosa.cash_balance == D("10000.00")
    lines = rows(session, PayoutLine, world_id)
    assert {(line.user_id, line.amount) for line in lines} == {
        (treasury.id, D("212.50")),
        (arjun.id, D("37.50")),
    }
    assert verify_payout_commitment(session, applied.ledger_entry).status == "ok"
    assert verify(entries_for(session, wetland.id)).valid
    assert_tenancy_invariants(session, world_id, traded=True)


# --- Sandbox clone, reset and prune ----------------------------------------------------------

_ACTIVITY: frozenset[type[SQLModel]] = frozenset({UserSession, Order, PayoutLine, WorldEvent})


def _referenced_tables(model: type[SQLModel]) -> set[str]:
    table: Any = model.__table__  # type: ignore[attr-defined]
    return {fk.column.table.name for fk in table.foreign_keys} - {table.name, "worlds"}


def test_the_delete_order_covers_every_world_table_children_first() -> None:
    # Model calls and counted live ratings outlive resets and prunes, so neither frees a budget.
    kept = {"llm_calls", "live_rating_requests"}
    world_tables = {
        t.name for t in SQLModel.metadata.sorted_tables if "world_id" in t.c and t.name not in kept
    }
    order = [m.__tablename__ for m in _DELETE_ORDER]
    assert set(order) == world_tables
    assert order[0] == "sessions", "pruning deletes a world's sessions first"
    for i, model in enumerate(_DELETE_ORDER):
        assert not _referenced_tables(model) & set(order[: i + 1]), model.__tablename__


@requires_db
def test_a_new_world_copies_every_template_table(session: Session) -> None:
    world_id = create_world(session).id

    for model in _DELETE_ORDER:
        expected = 0 if model in _ACTIVITY else len(rows(session, model, WORLD_ID))
        assert len(rows(session, model, world_id)) == expected, model.__tablename__
    assert_tenancy_invariants(session, world_id)


@requires_db
def test_reset_keeps_persona_ids_so_sessions_survive(session: Session) -> None:
    world_id = create_world(session).id
    before = {u.persona_key: u.id for u in rows(session, User, world_id) if u.persona_key}
    old_communities = {c.id for c in rows(session, Community, world_id)}
    old_treasuries = {c.treasury_user_id for c in rows(session, Community, world_id)}
    arjun, rosa = persona(session, world_id, "arjun"), persona(session, world_id, "rosa")
    arjun_token = start_session(session, arjun, SessionKind.DEMO)
    rosa_token = start_session(session, rosa, SessionKind.DEMO)
    # Visitor activity the reset must undo.
    arjun.cash_balance, rosa.name = D("1.00"), "Renamed"
    community = community_of(session, site_asset(session, world_id))
    community.name = "Renamed community"
    session.add(
        CommunityMember(
            community_id=community.id,
            user_id=persona(session, world_id, "mia").id,
            world_id=world_id,
            role=CommunityRole.STEWARD,
        )
    )
    session.commit()

    reset_world(session, world_id)
    session.expire_all()

    after = {u.persona_key: u.id for u in rows(session, User, world_id) if u.persona_key}
    assert after == before
    for token, user_id in ((arjun_token, before["arjun"]), (rosa_token, before["rosa"])):
        principal = resolve_session(session, token)
        assert principal is not None, "the session still resolves after a reset"
        assert (principal.user_id, principal.world_id) == (user_id, world_id)
    assert persona(session, world_id, "arjun").cash_balance == D("10000.00")
    assert persona(session, world_id, "rosa").name == "Rosa"
    communities = rows(session, Community, world_id)
    assert not {c.id for c in communities} & old_communities, "recreated with fresh IDs"
    assert not {c.treasury_user_id for c in communities} & old_treasuries
    assert not {u.id for u in rows(session, User, world_id)} & old_treasuries, "old ones gone"
    assert {c.name for c in communities} == {c.name for c in SEED_COMMUNITIES}
    assert_tenancy_invariants(session, world_id)


@requires_db
def test_reset_drops_a_persona_the_template_lacks_with_its_sessions(session: Session) -> None:
    world_id = create_world(session).id
    ghost = User(world_id=world_id, name="Ghost", role=UserRole.INVESTOR, persona_key="ghost")
    session.add(ghost)
    session.flush()
    token = start_session(session, ghost, SessionKind.DEMO)
    ghost_id = ghost.id

    reset_world(session, world_id)

    assert resolve_session(session, token) is None
    assert session.get(User, ghost_id) is None
    assert {u.persona_key for u in rows(session, User, world_id) if u.persona_key} == {
        p.key for p in PERSONAS
    }


@requires_db
def test_reset_after_a_payout_restores_the_treasury_stakes(session: Session) -> None:
    world_id = create_world(session).id
    wetland = site_asset(session, world_id)
    pay_quarter(
        session,
        world_id=world_id,
        asset_id=wetland.id,
        value_mid=D("100000.00"),
        quarter_label="2026-Q4",
    )
    session.commit()

    reset_world(session, world_id)

    assert rows(session, PayoutLine, world_id) == []
    assert all(
        u.cash_balance == D("0.00") for u in rows(session, User, world_id) if not u.persona_key
    )
    assert_tenancy_invariants(session, world_id)


def _trade(session: Session, world_id: UUID) -> None:
    """Arjun buys 1 000 primary shares of the first site: an order and a holding to clean up."""
    arjun, wetland = persona(session, world_id, "arjun"), site_asset(session, world_id)
    wetland.primary_shares_remaining -= 1_000
    session.add(_order(world_id, arjun.id, wetland.id, qty=1_000))
    session.add(Holding(world_id=world_id, user_id=arjun.id, asset_id=wetland.id, shares=1_000))
    session.flush()


@requires_db
def test_reset_after_trading_clears_orders_and_investor_holdings(session: Session) -> None:
    world_id = create_world(session).id
    _trade(session, world_id)
    session.commit()

    reset_world(session, world_id)

    assert rows(session, Order, world_id) == []
    assert len(rows(session, Holding, world_id)) == len(rows(session, Holding, WORLD_ID))
    assert_tenancy_invariants(session, world_id)


@requires_db
def test_prune_deletes_a_worlds_sessions_communities_and_treasuries(session: Session) -> None:
    world = create_world(session)
    world_id = world.id
    start_session(session, persona(session, world_id, "arjun"), SessionKind.DEMO)
    _trade(session, world_id)
    world.last_seen_at = datetime.now(UTC) - timedelta(days=30)
    session.add(world)
    ensure_live_world(session)
    session.commit()

    assert prune_stale_worlds(session, older_than=timedelta(days=7)) == 1

    assert session.get(World, world_id) is None
    for model in _DELETE_ORDER:
        assert rows(session, model, world_id) == [], model.__tablename__
    assert_tenancy_invariants(session, WORLD_ID)
    assert_tenancy_invariants(session, LIVE_WORLD_ID)


@requires_db
def test_the_live_world_gets_communities_owners_and_treasuries_only(session: Session) -> None:
    ensure_live_world(session)

    assert_tenancy_invariants(session, LIVE_WORLD_ID)
    personas = [u for u in rows(session, User, LIVE_WORLD_ID) if u.kind == UserKind.PERSONA]
    assert [u.persona_key for u in personas] == [COMMUNITY_PERSONA.key]


# --- Migration 0009 ----------------------------------------------------------------------------


def _count(session: Session, model: type[SQLModel]) -> int:
    return session.exec(select(func.count()).select_from(model)).one()


@requires_db
def test_migration_backfills_seeded_worlds_and_discards_visitor_sandboxes() -> None:
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            seed(db)
            ensure_live_world(db)
            visitor = create_world(db)
            visitor_id, visitor_asset = visitor.id, site_asset(db, visitor.id).id
            db.add(LlmCall(world_id=visitor_id, asset_id=visitor_asset, agent="auditor"))
            live_wetland = site_asset(db, LIVE_WORLD_ID).id
            payout = pay_quarter(
                db,
                world_id=LIVE_WORLD_ID,
                asset_id=live_wetland,
                value_mid=D("100000.00"),
                quarter_label="2026-Q4",
            ).ledger_entry
            db.commit()
            payout_id = payout.id

        # 0008: the community persona held every stake and was each asset's community user.
        command.downgrade(cfg, "0008")
        with engine.connect() as conn:
            stakes = conn.execute(
                text(
                    "SELECT u.persona_key, h.shares FROM assets a "
                    "JOIN users u ON u.id = a.community_user_id "
                    "JOIN holdings h ON h.asset_id = a.id AND h.user_id = u.id"
                )
            ).all()
            assert sorted(stakes) == [("rosa", RETAINED)] * (3 * len(DEMO_SITES))
            assert (
                conn.execute(text("SELECT count(*) FROM users WHERE kind = 'treasury'")).one()[0]
                == 0
            )
            live_rosa_cash = conn.execute(
                text("SELECT cash_balance FROM users WHERE world_id = :w AND persona_key = 'rosa'"),
                {"w": LIVE_WORLD_ID},
            ).one()[0]
            assert live_rosa_cash == D("10250.00"), "the treasury's dividend went back to Rosa"

        command.upgrade(cfg, "head")
        with Session(engine) as db:
            assert {w.id for w in db.exec(select(World)).all()} == {WORLD_ID, LIVE_WORLD_ID}
            assert [(c.world_id, c.asset_id) for c in db.exec(select(LlmCall)).all()] == [
                (None, None)
            ], "spend history is kept, detached"
            assert_tenancy_invariants(db, WORLD_ID)
            assert_tenancy_invariants(db, LIVE_WORLD_ID)
            assert {(c.id, c.treasury_user_id) for c in rows(db, Community, WORLD_ID)} == {
                (c.id, c.treasury_id) for c in SEED_COMMUNITIES
            }
            entry = db.get_one(LedgerEntry, payout_id)
            assert entry.kind == LedgerKind.PAYOUT
            check = verify_payout_commitment(db, entry)
            assert (check.status, check.erased) == ("ok_with_erasures", 1)
            assert verify(entries_for(db, live_wetland)).valid
            counts = {m: _count(db, m) for m in (User, Community, CommunityMember, Holding, Asset)}
            seed(db)
            assert {m: _count(db, m) for m in counts} == counts, (
                "seed is a no-op after the backfill"
            )
    finally:
        engine.dispose()
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "head")


@requires_db
def test_the_migration_round_trips_an_ownerless_treasury() -> None:
    """A treasury whose community has no owner survives a downgrade and is reused on upgrade."""
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            seed(db)
            ensure_live_world(db)
            treasury = User(
                world_id=LIVE_WORLD_ID,
                name="Orphan Treasury",
                role=UserRole.COMMUNITY,
                kind=UserKind.TREASURY,
                cash_balance=D("0.00"),
            )
            db.add(treasury)
            db.flush()
            community = Community(
                world_id=LIVE_WORLD_ID, name="Orphan", treasury_user_id=treasury.id
            )
            db.add(community)
            db.flush()
            asset = Asset(
                world_id=LIVE_WORLD_ID,
                name="Orphan Reserve",
                community_id=community.id,
                community_user_id=treasury.id,
                geojson={"type": "Point", "coordinates": [0, 0]},
                area_ha=D("10.00"),
                primary_shares_remaining=0,
            )
            db.add(asset)
            db.commit()
            treasury_id, asset_id = treasury.id, asset.id

        command.downgrade(cfg, "0008")
        with engine.connect() as conn:
            kind = conn.execute(
                text("SELECT kind FROM users WHERE id = :id"), {"id": treasury_id}
            ).scalar()
            assert kind == "treasury", "kept: there is no owner to hand its stake to"
        command.upgrade(cfg, "head")

        with Session(engine) as db:
            orphan = db.get_one(Asset, asset_id)
            assert orphan.community_user_id == treasury_id
            restored = community_of(db, orphan)
            assert restored.treasury_user_id == treasury_id
            members = db.exec(
                select(CommunityMember).where(CommunityMember.community_id == restored.id)
            ).all()
            assert members == []
            assert_tenancy_invariants(db, WORLD_ID)
    finally:
        engine.dispose()
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "head")


# --- Migration 0010 ----------------------------------------------------------------------------

_WORLD_SCOPED_FKS = {
    "holdings": {
        "fk_holdings_user": (["world_id", "user_id"], "users"),
        "fk_holdings_asset": (["world_id", "asset_id"], "assets"),
        "holdings_world_id_fkey": (["world_id"], "worlds"),
    },
    "orders": {
        "fk_orders_user": (["world_id", "user_id"], "users"),
        "fk_orders_asset": (["world_id", "asset_id"], "assets"),
        "orders_world_id_fkey": (["world_id"], "worlds"),
    },
}
_PLAIN_FKS = {
    "holdings": {
        "holdings_user_id_fkey": (["user_id"], "users"),
        "holdings_asset_id_fkey": (["asset_id"], "assets"),
        "holdings_world_id_fkey": (["world_id"], "worlds"),
    },
    "orders": {
        "orders_user_id_fkey": (["user_id"], "users"),
        "orders_asset_id_fkey": (["asset_id"], "assets"),
        "orders_world_id_fkey": (["world_id"], "worlds"),
    },
}


def _foreign_keys(engine: Any) -> dict[str, dict[str, tuple[list[str], str]]]:
    inspector = inspect(engine)
    return {
        table: {
            fk["name"]: (fk["constrained_columns"], fk["referred_table"])
            for fk in inspector.get_foreign_keys(table)
        }
        for table in ("holdings", "orders")
    }


def _trades(db: Session) -> tuple[set[tuple[Any, ...]], set[tuple[Any, ...]]]:
    orders = {(o.world_id, o.user_id, o.asset_id, o.qty) for o in db.exec(select(Order)).all()}
    holdings = {
        (h.world_id, h.user_id, h.asset_id, h.shares) for h in db.exec(select(Holding)).all()
    }
    return orders, holdings


@requires_db
def test_the_holdings_and_orders_migration_round_trips() -> None:
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            seed(db)
            mine = create_world(db).id
            _trade(db, mine)
            db.commit()
            before = _trades(db)
        assert _foreign_keys(engine) == _WORLD_SCOPED_FKS

        command.downgrade(cfg, "0009")
        assert _foreign_keys(engine) == _PLAIN_FKS
        assert "ix_holdings_world_id_asset_id" not in {
            i["name"] for i in inspect(engine).get_indexes("holdings")
        }
        command.upgrade(cfg, "head")
        assert _foreign_keys(engine) == _WORLD_SCOPED_FKS
        assert "ix_holdings_world_id_asset_id" in {
            i["name"] for i in inspect(engine).get_indexes("holdings")
        }
        with Session(engine) as db:
            assert _trades(db) == before, "orders and holdings survive the round trip"
            assert_tenancy_invariants(db, mine)
    finally:
        engine.dispose()
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "head")


_CROSS_WORLD_INSERTS = {
    "holdings": "INSERT INTO holdings (world_id, user_id, asset_id, shares) VALUES (:w, :u, :a, 1)",
    "orders": "INSERT INTO orders (id, world_id, user_id, asset_id, side, qty, is_primary) "
    "VALUES (gen_random_uuid(), :w, :u, :a, 'buy', 1, false)",
}


@pytest.mark.parametrize("table", ["holdings", "orders"])
@pytest.mark.parametrize("foreign", ["users", "assets"])
@requires_db
def test_the_holdings_and_orders_migration_rejects_cross_world_rows(
    table: str, foreign: str
) -> None:
    """At 0009 only application code stops a cross-world row, so upgrading must refuse one."""
    cfg = alembic_cfg()
    command.downgrade(cfg, "base")
    command.upgrade(cfg, "head")
    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            seed(db)
            mine, other = create_world(db).id, create_world(db).id
            user_world, asset_world = (other, mine) if foreign == "users" else (mine, other)
            row = {
                "w": mine,
                "u": persona(db, user_world, "mia").id,
                "a": site_asset(db, asset_world).id,
            }
            db.commit()

        command.downgrade(cfg, "0009")
        with engine.begin() as conn:
            conn.execute(text(_CROSS_WORLD_INSERTS[table]), row)
        with pytest.raises(RuntimeError, match=rf"1 {table} row\(s\) reference {foreign} "):
            command.upgrade(cfg, "head")
        assert _foreign_keys(engine) == _PLAIN_FKS, "the failed upgrade changed nothing"
    finally:
        engine.dispose()
        command.downgrade(cfg, "base")
        command.upgrade(cfg, "head")

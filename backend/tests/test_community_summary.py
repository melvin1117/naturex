"""The Steward home's summary (T63): `GET /communities/{id}/summary` and its pure math."""

from __future__ import annotations

from collections.abc import Iterator
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine
from sqlmodel import Session, select

from app.auth import SESSION_COOKIE, start_session
from app.communities import add_member
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.market.revenue import pay_quarter
from app.models import (
    Asset,
    AssetStatus,
    Community,
    CommunityRole,
    PayoutLine,
    Report,
    SessionKind,
    User,
    UserKind,
    UserRole,
)
from app.sandbox import create_world, ensure_live_world
from app.seed import LIVE_WORLD_ID, seed
from app.services.community_summary import (
    NextAction,
    Wallet,
    holder_summary,
    ipo_proceeds,
    next_action,
    share_split,
    total_wallet,
    wallet_credit,
)
from tests.conftest import alembic_cfg, requires_db
from tests.test_geometry import square

# --- Pure functions -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "launched", "owner", "expected"),
    [
        (AssetStatus.DRAFT, False, True, NextAction.CONTINUE_LISTING),
        (AssetStatus.RATING, False, True, NextAction.RATING_IN_PROGRESS),
        (AssetStatus.NEEDS_EVIDENCE, False, False, NextAction.ADD_EVIDENCE),
        (AssetStatus.LISTED, False, True, NextAction.LAUNCH_IPO),
        (AssetStatus.LISTED, False, False, NextAction.AWAITING_IPO),
        (AssetStatus.LISTED, True, True, NextAction.VIEW_ON_EXCHANGE),
        (AssetStatus.SUSPENDED, True, False, NextAction.VIEW_ON_EXCHANGE),
        (AssetStatus.INELIGIBLE, False, True, NextAction.NONE),
        (AssetStatus.WITHDRAWN, False, True, NextAction.NONE),
    ],
)
def test_next_action_follows_the_status_the_launch_and_the_role(
    status: AssetStatus, launched: bool, owner: bool, expected: NextAction
) -> None:
    assert next_action(status, launched=launched, can_launch=owner) is expected


def test_ipo_proceeds_round_each_purchase_like_the_engine() -> None:
    # 3 × 0.3333 = 0.9999 → 1.00 and 1 × 0.0050 = 0.005 → 0.01, per order, not on the total.
    assert ipo_proceeds([(3, Decimal("0.3333")), (1, Decimal("0.0050"))]) == Decimal("1.01")
    assert ipo_proceeds([]) == Decimal("0.00")


def test_wallet_credit_reads_the_payout_entry_and_legacy_entries() -> None:
    assert wallet_credit({"community_fund": "5.00", "community_wallet_credit": "5.01"}) == Decimal(
        "5.01"
    )
    assert wallet_credit({"community_fund": "2.5"}) == Decimal("2.50")


def test_holder_summary_counts_and_ranks_without_identities() -> None:
    holders = holder_summary([0, 50, 200, 10, 3, 1, 7], total_shares=1_000, top_n=3)
    assert holders.count == 6
    assert holders.shares_held == 271
    assert [(t.rank, t.shares, t.pct_of_shares) for t in holders.top] == [
        (1, 200, Decimal("20.00")),
        (2, 50, Decimal("5.00")),
        (3, 10, Decimal("1.00")),
    ]
    assert holder_summary([], total_shares=0).count == 0


def test_share_split_reads_the_float_from_the_retained_stake() -> None:
    split = share_split(total_shares=1_000, retained_shares=510, primary_remaining=400)
    assert (split.shares_offered, split.shares_sold, split.retained_shares) == (490, 90, 510)


def test_total_wallet_adds_every_part() -> None:
    one = Wallet(Decimal("3.00"), Decimal("2.00"), Decimal("1.00"), Decimal("0.50"))
    total = total_wallet([one, one])
    assert total == Wallet(Decimal("6.00"), Decimal("4.00"), Decimal("2.00"), Decimal("1.00"))
    assert total.total_received == Decimal("7.00")


# --- The route ----------------------------------------------------------------------------------

DB = requires_db


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
    client.cookies.clear()
    if user is not None:
        kind = SessionKind.PASSWORD if user.world_id == LIVE_WORLD_ID else SessionKind.DEMO
        client.cookies.set(SESSION_COOKIE, start_session(session, user, kind))
    return client


def summary_of(client: TestClient, community_id: UUID) -> Any:
    return client.get(f"/communities/{community_id}/summary")


def seeded_live(session: Session) -> tuple[Community, Asset]:
    community = session.exec(
        select(Community).where(Community.world_id == LIVE_WORLD_ID).order_by(Community.name)
    ).first()
    assert community is not None
    asset = session.exec(
        select(Asset).where(Asset.world_id == LIVE_WORLD_ID, Asset.community_id == community.id)
    ).one()
    return community, asset


def draft(session: Session, community: Community, name: str, status: AssetStatus) -> Asset:
    asset = Asset(
        world_id=community.world_id,
        name=name,
        community_id=community.id,
        community_user_id=community.treasury_user_id,
        geojson=square(1_200, lat=9.9, lon=-84.0),
        area_ha=Decimal("1200.00"),
        primary_shares_remaining=0,
        status=status,
    )
    session.add(asset)
    session.commit()
    return asset


@DB
def test_a_new_community_has_an_empty_home(session: Session, client: TestClient) -> None:
    owner = person(session, "Ana")
    created = sign_in(client, session, owner).post("/communities", json={"name": "Selva Nueva"})
    assert created.status_code == 201, created.text
    community_id = UUID(created.json()["id"])

    response = summary_of(client, community_id)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    body = response.json()
    assert body["community"]["name"] == "Selva Nueva"
    assert body["role"] == "owner"
    assert body["listings"] == []
    assert body["payouts"] == []
    assert body["holder_count"] == 0
    assert body["payouts_count"] == 0
    assert body["wallet"] == {
        "balance": "0.00",
        "ipo_proceeds": "0.00",
        "community_fund_payouts": "0.00",
        "retained_dividends": "0.00",
        "total_received": "0.00",
    }


@DB
def test_the_summary_is_for_members_and_same_world_admins(
    session: Session, client: TestClient
) -> None:
    community, _ = seeded_live(session)
    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()

    as_steward = summary_of(sign_in(client, session, steward), community.id)
    assert as_steward.status_code == 200
    assert as_steward.json()["role"] == "steward"

    as_admin = summary_of(
        sign_in(client, session, person(session, "Ops", is_admin=True)), community.id
    )
    assert as_admin.status_code == 200
    assert as_admin.json()["role"] is None

    stranger = summary_of(sign_in(client, session, person(session, "Investor")), community.id)
    assert stranger.status_code == 403
    assert stranger.json() == {"detail": "members_only"}

    assert summary_of(sign_in(client, session, None), community.id).status_code == 401


@DB
def test_another_worlds_community_is_not_found(session: Session, client: TestClient) -> None:
    community, _ = seeded_live(session)
    world = create_world(session)
    sandbox_community = session.exec(
        select(Community).where(Community.world_id == world.id)
    ).first()
    assert sandbox_community is not None

    # A same-world admin of the sandbox can't read the live community, and vice versa.
    sandbox_admin = person(session, "Sandbox ops", world_id=world.id, is_admin=True)
    response = summary_of(sign_in(client, session, sandbox_admin), community.id)
    assert response.status_code == 404
    assert response.json() == {"detail": "not_found"}
    live_admin = person(session, "Live ops", is_admin=True)
    assert summary_of(sign_in(client, session, live_admin), sandbox_community.id).status_code == 404


@DB
def test_listings_show_their_next_action_per_role(session: Session, client: TestClient) -> None:
    owner = person(session, "Owner")
    created = sign_in(client, session, owner).post("/communities", json={"name": "Bosque Uno"})
    community = session.get(Community, UUID(created.json()["id"]))
    assert community is not None
    statuses = [
        AssetStatus.DRAFT,
        AssetStatus.RATING,
        AssetStatus.NEEDS_EVIDENCE,
        AssetStatus.LISTED,
        AssetStatus.INELIGIBLE,
        AssetStatus.WITHDRAWN,
    ]
    for index, status in enumerate(statuses):
        draft(session, community, f"Parcel {index}", status)

    body = summary_of(sign_in(client, session, owner), community.id).json()
    actions = {item["asset"]["status"]: item["next_action"] for item in body["listings"]}
    assert actions == {
        "draft": "continue_listing",
        "rating": "rating_in_progress",
        "needs_evidence": "add_evidence",
        "listed": "launch_ipo",
        "ineligible": "none",
        "withdrawn": "none",
    }
    listed = next(item for item in body["listings"] if item["asset"]["status"] == "listed")
    # No shares exist before the IPO.
    assert listed["shares"] is None
    assert listed["holders"] == {"count": 0, "shares_held": 0, "top": []}

    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()
    body = summary_of(sign_in(client, session, steward), community.id).json()
    listed = next(item for item in body["listings"] if item["asset"]["status"] == "listed")
    assert listed["next_action"] == "awaiting_ipo"


@DB
def test_totals_come_from_orders_payouts_and_the_treasurys_lines(
    session: Session, client: TestClient
) -> None:
    community, asset = seeded_live(session)
    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()

    # Two investors buy from the IPO float.
    investors = [person(session, "Investor A"), person(session, "Investor B")]
    paid = Decimal("0.00")
    for investor, qty in zip(investors, (2, 1), strict=True):
        order = sign_in(client, session, investor).post(
            "/orders", json={"asset_id": str(asset.id), "side": "buy", "qty": qty}
        )
        assert order.status_code == 200, order.text
        paid += Decimal(order.json()["community_amount"])

    applied = pay_quarter(
        session,
        world_id=LIVE_WORLD_ID,
        asset_id=asset.id,
        value_mid=Decimal("1234567.00"),
        quarter_label="2026Q3",
    )
    session.commit()
    treasury_line = session.exec(
        select(PayoutLine).where(
            PayoutLine.asset_id == asset.id, PayoutLine.user_id == asset.community_user_id
        )
    ).one()
    assert treasury_line.amount is not None
    report = session.exec(select(Report).where(Report.asset_id == asset.id)).one()
    report.recommendations = ["Fence the riverbank", "Report fires within a day"]
    session.add(report)
    session.commit()

    response = summary_of(sign_in(client, session, steward), community.id)
    assert response.status_code == 200, response.text
    body = response.json()
    session.refresh(asset)

    wallet = {key: Decimal(value) for key, value in body["wallet"].items()}
    credit = applied.payout.community_wallet_credit
    assert wallet["ipo_proceeds"] == paid
    assert wallet["community_fund_payouts"] == credit
    assert wallet["balance"] == asset.community_wallet == paid + credit
    assert wallet["retained_dividends"] == treasury_line.amount
    assert wallet["total_received"] == paid + credit + treasury_line.amount

    (listing,) = body["listings"]
    assert listing["next_action"] == "view_on_exchange"
    assert listing["asset"]["trading"] is True
    assert {key: Decimal(v) for key, v in listing["wallet"].items()} == wallet
    assert listing["holders"]["count"] == 2
    assert listing["holders"]["shares_held"] == 3
    assert [t["shares"] for t in listing["holders"]["top"]] == [2, 1]
    assert listing["shares"]["shares_sold"] == 3
    assert listing["shares"]["shares_offered"] == (
        asset.total_shares - listing["shares"]["retained_shares"]
    )
    assert listing["recommendations"] == ["Fence the riverbank", "Report fires within a day"]
    assert listing["report_version"] == report.version
    assert body["holder_count"] == 2

    (payout,) = body["payouts"]
    assert payout["quarter_label"] == "2026Q3"
    assert payout["asset_name"] == asset.name
    assert Decimal(payout["revenue"]) == applied.payout.revenue
    assert Decimal(payout["community_fund"]) == credit
    assert Decimal(payout["retained_dividend"]) == treasury_line.amount
    assert payout["holder_count"] == 3  # both investors and the treasury
    assert body["payouts_count"] == 1

    # Holders are never identified: no investor or treasury ID, no name.
    for investor in investors:
        assert str(investor.id) not in response.text
        assert investor.name not in response.text
    assert str(asset.community_user_id) not in response.text

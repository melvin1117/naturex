"""The Steward home's summary (T63): `GET /communities/{id}/summary` and its pure math."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, event
from sqlmodel import Session, select

from app.auth import SESSION_COOKIE, start_session
from app.communities import add_member
from app.config import get_settings
from app.db import get_session
from app.ledger import append
from app.main import app
from app.market.revenue import pay_quarter
from app.models import (
    Asset,
    AssetStatus,
    Community,
    CommunityRole,
    Holding,
    LedgerKind,
    PayoutLine,
    Report,
    SessionKind,
    User,
    UserKind,
    UserRole,
    VerificationLevel,
    VerificationMode,
    VerificationRun,
)
from app.sandbox import create_world, ensure_live_world
from app.schemas import ListingManageAction, NextAction
from app.seed import LIVE_WORLD_ID, seed
from app.services.community_summary import (
    RECENT_PAYOUTS,
    Wallet,
    holder_summary,
    ipo_proceeds,
    manage_actions,
    next_action,
    share_split,
    total_wallet,
    wallet_credit,
)
from app.services.verification import RunView, Standing, standing
from tests.conftest import alembic_cfg, requires_db
from tests.test_geometry import square

# --- Pure functions -----------------------------------------------------------------------------


def stands(
    level: VerificationLevel = VerificationLevel.UNVERIFIED,
    *,
    required: bool = False,
    revoked: bool = False,
    in_review: bool = False,
) -> Standing:
    return Standing(level, in_review=in_review, required=required, revoked=revoked)


FREE = stands()
NEEDED = stands(required=True)
IN_REVIEW = stands(VerificationLevel.DOCUMENTS_SUBMITTED, required=True, in_review=True)
REVOKED = stands(VerificationLevel.REVOKED, required=True, revoked=True)
RESUBMITTED = stands(VerificationLevel.REVOKED, required=True, revoked=True, in_review=True)
# A sandbox needs no verification: a waiting submission doesn't hold the offer back.
SANDBOX_IN_REVIEW = stands(VerificationLevel.DOCUMENTS_SUBMITTED, in_review=True)


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
        (AssetStatus.SUSPENDED, False, True, NextAction.NONE),
        (AssetStatus.INELIGIBLE, False, True, NextAction.NONE),
        (AssetStatus.WITHDRAWN, False, True, NextAction.NONE),
    ],
)
def test_next_action_follows_the_status_the_launch_and_the_role(
    status: AssetStatus, launched: bool, owner: bool, expected: NextAction
) -> None:
    action = next_action(
        status, launched=launched, can_manage=True, can_launch=owner, verification=FREE
    )
    assert action is expected


@pytest.mark.parametrize(
    ("status", "launched", "owner", "verification", "expected"),
    [
        # The opening offer waits for verification: a member's next step is to verify.
        (AssetStatus.LISTED, False, True, NEEDED, NextAction.VERIFY),
        (AssetStatus.LISTED, False, False, NEEDED, NextAction.VERIFY),
        (AssetStatus.LISTED, False, True, IN_REVIEW, NextAction.VERIFICATION_IN_REVIEW),
        (AssetStatus.LISTED, False, True, FREE, NextAction.LAUNCH_IPO),
        (AssetStatus.LISTED, False, True, SANDBOX_IN_REVIEW, NextAction.LAUNCH_IPO),
        # A revocation pauses trading (and blocks the offer) until a new run is approved.
        (AssetStatus.SUSPENDED, True, True, REVOKED, NextAction.VERIFY),
        (AssetStatus.SUSPENDED, False, False, REVOKED, NextAction.VERIFY),
        (AssetStatus.SUSPENDED, True, True, RESUBMITTED, NextAction.VERIFICATION_IN_REVIEW),
        # Once launched, a stale run doesn't stop trading: the gate is the offer's.
        (AssetStatus.LISTED, True, True, NEEDED, NextAction.VIEW_ON_EXCHANGE),
        # Earlier steps come first, and closed listings have none.
        (AssetStatus.DRAFT, False, True, NEEDED, NextAction.CONTINUE_LISTING),
        (AssetStatus.WITHDRAWN, False, True, REVOKED, NextAction.NONE),
    ],
)
def test_next_action_sends_members_to_verify_before_the_locked_offer(
    status: AssetStatus,
    launched: bool,
    owner: bool,
    verification: Standing,
    expected: NextAction,
) -> None:
    action = next_action(
        status, launched=launched, can_manage=True, can_launch=owner, verification=verification
    )
    assert action is expected


@pytest.mark.parametrize(
    ("status", "launched", "verification", "expected"),
    [
        (AssetStatus.LISTED, False, NEEDED, NextAction.AWAITING_VERIFICATION),
        (AssetStatus.LISTED, False, IN_REVIEW, NextAction.AWAITING_VERIFICATION),
        (AssetStatus.SUSPENDED, True, REVOKED, NextAction.AWAITING_VERIFICATION),
        (AssetStatus.LISTED, False, FREE, NextAction.AWAITING_IPO),
        (AssetStatus.LISTED, True, FREE, NextAction.VIEW_ON_EXCHANGE),
    ],
)
def test_a_non_member_is_never_offered_to_verify_or_launch(
    status: AssetStatus, launched: bool, verification: Standing, expected: NextAction
) -> None:
    action = next_action(
        status, launched=launched, can_manage=False, can_launch=False, verification=verification
    )
    assert action is expected


EDIT, WITHDRAW = ListingManageAction.EDIT, ListingManageAction.WITHDRAW


@pytest.mark.parametrize(
    ("status", "run_active", "expected"),
    [
        (AssetStatus.DRAFT, False, (EDIT, WITHDRAW)),
        # A run that failed or waits for metrics can be withdrawn; an active one can't (yet).
        (AssetStatus.RATING, False, (WITHDRAW,)),
        (AssetStatus.RATING, True, ()),
        (AssetStatus.NEEDS_EVIDENCE, False, (WITHDRAW,)),
        # Once listed it can't be withdrawn: supporters may hold it.
        (AssetStatus.LISTED, False, ()),
        (AssetStatus.SUSPENDED, False, ()),
        (AssetStatus.INELIGIBLE, False, ()),
        (AssetStatus.WITHDRAWN, False, ()),
    ],
)
def test_manage_actions_follow_the_lifecycle(
    status: AssetStatus, run_active: bool, expected: tuple[ListingManageAction, ...]
) -> None:
    assert manage_actions(status, can_manage=True, run_active=run_active) == expected


@pytest.mark.parametrize("status", list(AssetStatus))
def test_a_non_member_is_never_offered_a_change(status: AssetStatus) -> None:
    assert manage_actions(status, can_manage=False, run_active=False) == ()


def _view(level: VerificationLevel, *, matches: bool = True, **fields: Any) -> RunView:
    run = VerificationRun(
        world_id=LIVE_WORLD_ID,
        asset_id=UUID(int=1),
        level=level,
        input_fingerprint="f" * 64,
        checklist=[],
        method_version="v1",
        mode=VerificationMode.REVIEW,
        document_count=2,
        **fields,
    )
    return RunView(run, [], matches)


NOON = datetime(2026, 10, 12, 12, tzinfo=UTC)
LATER = datetime(2026, 10, 14, tzinfo=UTC)


def test_the_standing_follows_the_ipo_gate() -> None:
    assert standing(None, revoked_at=None, live=False) == FREE
    assert standing(None, revoked_at=None, live=True) == NEEDED
    verified = _view(VerificationLevel.VERIFIED, decided_at=NOON, reason="Matches the map.")
    facts = standing(verified, revoked_at=None, live=True)
    assert (facts.level, facts.required, facts.decision, facts.decided_at, facts.reason) == (
        VerificationLevel.VERIFIED,
        False,
        VerificationLevel.VERIFIED,
        NOON,
        "Matches the map.",
    )
    # A verified run the listing has since outgrown is unverified again, and blocks the offer.
    stale = standing(
        _view(VerificationLevel.VERIFIED, matches=False, decided_at=NOON),
        revoked_at=None,
        live=True,
    )
    assert (stale.level, stale.required, stale.decision, stale.run_id) == (
        VerificationLevel.UNVERIFIED,
        True,
        None,
        None,
    )
    # Sandboxes need no verification, but a rejection still shows with its reason.
    rejected = standing(
        _view(VerificationLevel.REJECTED, decided_at=NOON, reason="Unsigned minutes."),
        revoked_at=None,
        live=False,
    )
    assert (rejected.level, rejected.required, rejected.decision, rejected.reason) == (
        VerificationLevel.REJECTED,
        False,
        VerificationLevel.REJECTED,
        "Unsigned minutes.",
    )
    # A sandbox submission waits for a reviewer without blocking the offer.
    waiting = standing(_view(VerificationLevel.DOCUMENTS_SUBMITTED), revoked_at=None, live=False)
    assert (waiting.level, waiting.in_review, waiting.required) == (
        VerificationLevel.DOCUMENTS_SUBMITTED,
        True,
        False,
    )


def test_a_revocation_stands_until_an_approval_even_in_a_sandbox() -> None:
    revoked = standing(
        _view(
            VerificationLevel.REVOKED,
            decided_at=NOON,
            reason="Fine.",
            revoked_at=LATER,
            revoke_reason="Disputed title.",
        ),
        revoked_at=LATER,
        live=False,
    )
    assert (revoked.level, revoked.required, revoked.revoked) == (
        VerificationLevel.REVOKED,
        True,
        True,
    )
    assert (revoked.decision, revoked.decided_at, revoked.reason) == (
        VerificationLevel.REVOKED,
        LATER,
        "Disputed title.",
    )
    # A newer submission waits: the revocation still stands (as on the public panel), in review.
    waiting = standing(_view(VerificationLevel.DOCUMENTS_SUBMITTED), revoked_at=LATER, live=False)
    assert (waiting.level, waiting.in_review, waiting.required) == (
        VerificationLevel.REVOKED,
        True,
        True,
    )
    assert (waiting.decision, waiting.decided_at) == (VerificationLevel.REVOKED, LATER)
    # The newer submission was rejected: still revoked, and the latest decision is the rejection.
    rejected = standing(
        _view(VerificationLevel.REJECTED, decided_at=NOON, reason="Still unsigned."),
        revoked_at=LATER,
        live=False,
    )
    assert (rejected.level, rejected.in_review, rejected.decision, rejected.reason) == (
        VerificationLevel.REVOKED,
        False,
        VerificationLevel.REJECTED,
        "Still unsigned.",
    )
    # The listing changed since: the revocation is what stands.
    changed = standing(
        _view(VerificationLevel.DOCUMENTS_SUBMITTED, matches=False), revoked_at=LATER, live=False
    )
    assert (changed.level, changed.in_review, changed.decided_at) == (
        VerificationLevel.REVOKED,
        False,
        LATER,
    )


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


def owned_community(client: TestClient, session: Session, owner: User) -> Community:
    created = sign_in(client, session, owner).post("/communities", json={"name": "Bosque Dos"})
    assert created.status_code == 201, created.text
    community = session.get(Community, UUID(created.json()["id"]))
    assert community is not None
    return community


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


def draft(
    session: Session,
    community: Community,
    name: str,
    status: AssetStatus,
    *,
    launched: bool = False,
) -> Asset:
    asset = Asset(
        ipo_at=datetime.now(UTC) if launched else None,
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
    # The live world's opening offer waits for verification: that's the next step (#216).
    assert actions == {
        "draft": "continue_listing",
        "rating": "rating_in_progress",
        "needs_evidence": "add_evidence",
        "listed": "verify",
        "ineligible": "none",
        "withdrawn": "none",
    }
    listed = next(item for item in body["listings"] if item["asset"]["status"] == "listed")
    assert listed["verification"] == {
        "level": "unverified",
        "in_review": False,
        "required": True,
        "decision": None,
        "decided_at": None,
        "reason": None,
        "run_id": None,
    }
    # No shares exist before the IPO.
    assert listed["shares"] is None
    assert listed["holders"] == {"count": 0, "shares_held": 0, "top": []}

    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()
    body = summary_of(sign_in(client, session, steward), community.id).json()
    listed = next(item for item in body["listings"] if item["asset"]["status"] == "listed")
    assert listed["next_action"] == "verify"

    # A same-world admin reads the home too, but isn't a member: told what it waits for, never
    # offered to verify or launch it.
    admin = person(session, "Ops", is_admin=True)
    body = summary_of(sign_in(client, session, admin), community.id).json()
    assert body["role"] is None
    listed = next(item for item in body["listings"] if item["asset"]["status"] == "listed")
    assert listed["next_action"] == "awaiting_verification"


@DB
def test_members_are_offered_the_changes_the_routes_allow(
    session: Session, client: TestClient
) -> None:
    owner = person(session, "Owner")
    community = owned_community(client, session, owner)
    for status in AssetStatus:
        draft(session, community, f"Parcel {status.value}", status)
    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()

    expected = {
        "draft": ["edit", "withdraw"],
        "rating": ["withdraw"],  # no run is active
        "needs_evidence": ["withdraw"],
        "listed": [],
        "suspended": [],
        "ineligible": [],
        "withdrawn": [],
    }
    for member in (owner, steward):
        body = summary_of(sign_in(client, session, member), community.id).json()
        offered = {item["asset"]["status"]: item["manage_actions"] for item in body["listings"]}
        assert offered == expected

    admin = person(session, "Ops", is_admin=True)
    body = summary_of(sign_in(client, session, admin), community.id).json()
    assert all(item["manage_actions"] == [] for item in body["listings"])


@DB
def test_last_updated_is_the_newest_ledger_entry(session: Session, client: TestClient) -> None:
    owner = person(session, "Owner")
    community = owned_community(client, session, owner)
    quiet = draft(session, community, "Quiet", AssetStatus.DRAFT)
    busy = draft(session, community, "Busy", AssetStatus.DRAFT)
    entry = append(
        session,
        world_id=community.world_id,
        asset_id=busy.id,
        kind=LedgerKind.LISTING,
        payload={"transition": "edit", "from": "draft", "to": "draft"},
    )
    session.commit()

    body = summary_of(sign_in(client, session, owner), community.id).json()
    updated = {item["asset"]["id"]: item["updated_at"] for item in body["listings"]}
    assert datetime.fromisoformat(updated[str(busy.id)]) == entry.created_at
    assert entry.created_at > busy.created_at
    # No ledger entry yet: when it was created.
    assert datetime.fromisoformat(updated[str(quiet.id)]) == quiet.created_at


@DB
def test_a_sandbox_listing_offers_the_launch_to_its_owner_only(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    session.commit()
    owner = person(session, "Sandbox owner", world_id=world.id)
    community = owned_community(client, session, owner)
    draft(session, community, "Parcel", AssetStatus.LISTED)

    body = summary_of(sign_in(client, session, owner), community.id).json()
    (listed,) = body["listings"]
    assert listed["next_action"] == "launch_ipo"
    assert (listed["verification"]["level"], listed["verification"]["required"]) == (
        "unverified",
        False,
    )

    steward = person(session, "Sandbox steward", world_id=world.id)
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()
    body = summary_of(sign_in(client, session, steward), community.id).json()
    assert body["listings"][0]["next_action"] == "awaiting_ipo"

    # A same-world admin reads it too, and can't launch: the owner does.
    admin = person(session, "Sandbox ops", world_id=world.id, is_admin=True)
    body = summary_of(sign_in(client, session, admin), community.id).json()
    assert body["listings"][0]["next_action"] == "awaiting_ipo"


@DB
def test_suspended_listings_offer_the_exchange_only_once_launched(
    session: Session, client: TestClient
) -> None:
    owner = person(session, "Owner")
    community = owned_community(client, session, owner)
    launched = draft(session, community, "Launched", AssetStatus.SUSPENDED, launched=True)
    unlaunched = draft(session, community, "Unlaunched", AssetStatus.SUSPENDED)

    body = summary_of(sign_in(client, session, owner), community.id).json()
    actions = {item["asset"]["id"]: item["next_action"] for item in body["listings"]}
    assert actions == {str(launched.id): "view_on_exchange", str(unlaunched.id): "none"}


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


def buy(client: TestClient, asset: Asset, qty: int, side: str = "buy") -> Any:
    response = client.post("/orders", json={"asset_id": str(asset.id), "side": side, "qty": qty})
    assert response.status_code == 200, response.text
    return response.json()


@DB
def test_a_secondary_trade_leaves_the_ipo_proceeds_alone(
    session: Session, client: TestClient
) -> None:
    community, asset = seeded_live(session)
    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()
    investor = person(session, "Investor")
    paid = Decimal(buy(sign_in(client, session, investor), asset, 3)["community_amount"])

    sold = buy(client, asset, 2, side="sell")
    assert sold["is_primary"] is False
    assert Decimal(sold["community_amount"]) == 0

    wallet = summary_of(sign_in(client, session, steward), community.id).json()["wallet"]
    assert Decimal(wallet["ipo_proceeds"]) == paid
    assert Decimal(wallet["balance"]) == paid


@DB
def test_payouts_are_capped_newest_first_and_all_counted(
    session: Session, client: TestClient
) -> None:
    community, asset = seeded_live(session)
    steward = person(session, "Steward")
    add_member(session, community, steward.id, CommunityRole.STEWARD)
    session.commit()
    quarters = [f"{2023 + i // 4}Q{i % 4 + 1}" for i in range(RECENT_PAYOUTS + 2)]
    credit = Decimal("0.00")
    for quarter in quarters:
        applied = pay_quarter(
            session,
            world_id=LIVE_WORLD_ID,
            asset_id=asset.id,
            value_mid=Decimal("1000000.00"),
            quarter_label=quarter,
        )
        credit += applied.payout.community_wallet_credit
        session.commit()

    body = summary_of(sign_in(client, session, steward), community.id).json()
    assert body["payouts_count"] == len(quarters)
    assert [p["quarter_label"] for p in body["payouts"]] == quarters[::-1][:RECENT_PAYOUTS]
    # The totals cover every payout, not only the ones listed.
    assert Decimal(body["wallet"]["community_fund_payouts"]) == credit


@DB
def test_an_investor_in_two_listings_counts_once(session: Session, client: TestClient) -> None:
    owner = person(session, "Owner")
    community = owned_community(client, session, owner)
    first = draft(session, community, "First", AssetStatus.LISTED, launched=True)
    second = draft(session, community, "Second", AssetStatus.LISTED, launched=True)
    both, one = person(session, "Both"), person(session, "One")
    for user, asset, shares in ((both, first, 30), (both, second, 5), (one, second, 10)):
        session.add(
            Holding(world_id=LIVE_WORLD_ID, user_id=user.id, asset_id=asset.id, shares=shares)
        )
    session.commit()

    body = summary_of(sign_in(client, session, owner), community.id).json()
    assert body["holder_count"] == 2
    holders = {item["asset"]["name"]: item["holders"] for item in body["listings"]}
    assert holders["First"]["count"] == 1
    assert holders["Second"]["count"] == 2
    assert [t["shares"] for t in holders["Second"]["top"]] == [10, 5]


@DB
def test_an_older_payout_entry_counts_its_community_fund(
    session: Session, client: TestClient
) -> None:
    owner = person(session, "Owner")
    community = owned_community(client, session, owner)
    asset = draft(session, community, "Old", AssetStatus.LISTED, launched=True)
    # Before T41's `community_wallet_credit`, payout entries recorded `community_fund` only.
    append(
        session,
        world_id=LIVE_WORLD_ID,
        asset_id=asset.id,
        kind=LedgerKind.PAYOUT,
        payload={"quarter_label": "2025Q4", "revenue": "10.01", "community_fund": "5.01"},
    )
    session.commit()

    body = summary_of(sign_in(client, session, owner), community.id).json()
    assert body["wallet"]["community_fund_payouts"] == "5.01"
    (payout,) = body["payouts"]
    assert (payout["revenue"], payout["community_fund"], payout["holder_count"]) == (
        "10.01",
        "5.01",
        0,
    )


@DB
def test_the_number_of_queries_does_not_grow_with_listings(
    session: Session, client: TestClient, conn: Connection
) -> None:
    owner = person(session, "Owner")
    community = owned_community(client, session, owner)
    sign_in(client, session, owner)
    investor = person(session, "Investor")

    def queries_for(listings: int) -> int:
        while (
            len(session.exec(select(Asset).where(Asset.community_id == community.id)).all())
            < listings
        ):
            asset = draft(session, community, f"Site {listings}", AssetStatus.LISTED, launched=True)
            session.add(
                Holding(world_id=LIVE_WORLD_ID, user_id=investor.id, asset_id=asset.id, shares=1)
            )
            session.commit()
        statements: list[str] = []

        def count(*_: Any) -> None:
            statements.append("x")

        event.listen(conn, "before_cursor_execute", count)
        try:
            assert summary_of(client, community.id).status_code == 200
        finally:
            event.remove(conn, "before_cursor_execute", count)
        return len(statements)

    two = queries_for(2)
    assert two > 0
    assert queries_for(5) == two

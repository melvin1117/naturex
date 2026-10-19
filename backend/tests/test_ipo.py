"""IPO launch (T59): the preview, the launch transaction, `not_trading` and share conservation."""

from __future__ import annotations

import threading
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.ledger import verify
from app.market.engine import ipo_terms
from app.models import (
    Asset,
    AssetStatus,
    Holding,
    LedgerEntry,
    LedgerKind,
    Price,
    Report,
    StreamEventType,
    User,
    WorldEvent,
)
from app.seed import COMMUNITY_PERSONA
from app.services import ipo as ipo_service
from app.services.ipo import (
    ALREADY_LAUNCHED,
    NO_RATING,
    NOT_LISTED,
    PRICE_TOO_LOW,
    FairValueInputs,
    InvalidOffering,
    IpoRefused,
    Offering,
    fair_value_inputs,
    launch,
    quote,
)
from tests import test_lifecycle as lifecycle
from tests.conftest import alembic_cfg, requires_db
from tests.test_lifecycle import (
    LAT,
    Committed,
    World_,
    _committed_draft,
    client_as,
    curated,
    draft,
    square,
    submit,
)

# The listing lifecycle's fixtures: a sandbox world in a rolled-back transaction, and a
# committed one for concurrency tests.
conn = lifecycle.conn
world = lifecycle.world
committed = lifecycle.committed

D = Decimal

# ----- pure rules -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("total_shares", "retained_pct"),
    [
        (9_999, "51"),
        (10_000_001, "51"),
        (1_000_000, "9.99"),
        (1_000_000, "90.01"),
        (10**6, "1.001"),
    ],
)
def test_an_offering_outside_the_bounds_is_invalid(total_shares: int, retained_pct: str) -> None:
    with pytest.raises(InvalidOffering):
        Offering(total_shares, D(retained_pct))


def test_the_bounds_themselves_are_valid() -> None:
    Offering(10_000, D("10"))
    Offering(10_000_000, D("90"))


def _report(**overrides: Any) -> Report:
    fields: dict[str, Any] = {
        "world_id": UUID(int=1),
        "asset_id": UUID(int=2),
        "version": 3,
        "value_mid": D("1000000.00"),
        "health_score": D("80.00"),
        "confidence": D("60.00"),
        **overrides,
    }
    return Report(**fields)


def _asset() -> Asset:
    return Asset(
        world_id=UUID(int=1),
        name="Bosque",
        geojson={},
        area_ha=D("100"),
        primary_shares_remaining=0,
        status=AssetStatus.LISTED,
    )


def test_the_quote_is_the_engines_ipo_terms_of_the_report() -> None:
    q = quote(_asset(), _report(), Offering(2_000_000, D("30")))

    assert q.terms == ipo_terms(
        value_mid=D("1000000.00"),
        health=D("80.00"),
        confidence=D("60.00"),
        total_shares=2_000_000,
        retained_pct=D("30"),
    )
    assert (q.terms.price, q.terms.primary_float, q.terms.retained_shares) == (
        D("3.9600"),
        1_400_000,
        600_000,
    )
    assert q.report_version == 3


def test_the_quote_prefers_the_reports_unrounded_snapshot() -> None:
    snapshot = {"value_mid": "1000000.004", "health": "80.04", "confidence": "59.996"}
    report = _report(auditor_json={"rating": {"fair_value": snapshot}})

    assert fair_value_inputs(report) == FairValueInputs(D("1000000.004"), D("80.04"), D("59.996"))
    assert fair_value_inputs(_report()) == FairValueInputs(D("1000000.00"), D("80.00"), D("60.00"))


@pytest.mark.parametrize(
    ("report", "code"),
    [
        (None, NO_RATING),
        (_report(value_mid=None), NO_RATING),
        (_report(confidence=None), NO_RATING),
        (_report(health_score=D("101")), NO_RATING),
        (_report(value_mid=D("1.00"), health_score=D("1"), confidence=D("1")), PRICE_TOO_LOW),
    ],
)
def test_a_report_that_cant_price_an_ipo_is_refused(report: Report | None, code: str) -> None:
    with pytest.raises(IpoRefused) as refused:
        quote(_asset(), report, Offering())
    assert refused.value.code == code


# ----- helpers ----------------------------------------------------------------------------------


def listed(w: World_) -> dict[str, Any]:
    """A new listing rated into `listed`, not launched."""
    asset = draft(w)
    assert submit(w, asset["id"]).status_code == 202
    w.executor.run_all()
    w.session.expire_all()
    assert w.session.get_one(Asset, UUID(asset["id"])).status is AssetStatus.LISTED
    return asset


def preview(w: World_, asset_id: str, user: User | None = None, **params: Any) -> Any:
    return client_as(w, user or w.owner).get(f"/assets/{asset_id}/ipo/preview", params=params)


def launch_ipo(w: World_, asset_id: str, user: User | None = None, **body: Any) -> Any:
    return client_as(w, user or w.owner).post(f"/assets/{asset_id}/ipo", json=body)


def buy(w: World_, asset_id: str, qty: int) -> Any:
    return client_as(w, w.outsider).post(
        "/orders", json={"asset_id": asset_id, "side": "buy", "qty": qty}
    )


def report_of(w: World_, asset_id: str) -> Report:
    return w.session.exec(select(Report).where(Report.asset_id == UUID(asset_id))).one()


def written(w: World_, asset_id: str) -> tuple[int, int, int, int]:
    """Prices, holdings, ledger entries and price ticks for the asset."""
    w.session.expire_all()
    uid = UUID(asset_id)
    ticks = w.session.exec(
        select(WorldEvent).where(
            WorldEvent.world_id == w.id, WorldEvent.type == StreamEventType.PRICE_TICK
        )
    ).all()
    return (
        len(w.session.exec(select(Price).where(Price.asset_id == uid)).all()),
        len(w.session.exec(select(Holding).where(Holding.asset_id == uid)).all()),
        len(w.session.exec(select(LedgerEntry).where(LedgerEntry.asset_id == uid)).all()),
        sum(1 for t in ticks if t.payload["asset_id"] == asset_id),
    )


def assert_conserved(session: Session, asset_id: UUID, market_maker: int = 0) -> None:
    """total_shares = primary float + market-maker inventory + Σ holdings (treasury included)."""
    session.expire_all()
    asset = session.get_one(Asset, asset_id)
    held = session.exec(
        select(func.coalesce(func.sum(Holding.shares), 0)).where(Holding.asset_id == asset_id)
    ).one()
    assert asset.primary_shares_remaining + market_maker + int(held) == asset.total_shares


# ----- preview ----------------------------------------------------------------------------------


@requires_db
def test_the_owner_previews_every_term_of_the_formula(world: World_) -> None:
    asset = listed(world)
    response = preview(world, asset["id"])

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    body = response.json()
    report = report_of(world, asset["id"])
    inputs = fair_value_inputs(report)
    terms = ipo_terms(
        value_mid=inputs.value_mid,
        health=inputs.health,
        confidence=inputs.confidence,
        total_shares=1_000_000,
        retained_pct=D("51"),
    )
    assert body["report_id"] == str(report.id) and body["report_version"] == 1
    assert D(body["value_mid"]) == terms.value_mid
    assert D(body["health"]) == terms.health and D(body["confidence"]) == terms.confidence
    assert D(body["health_factor"]) == terms.health_factor
    assert D(body["confidence_factor"]) == terms.confidence_factor
    assert D(body["fair_value_total"]) == terms.fair_value_total
    assert D(body["fair_value_per_share"]) == D(body["ipo_price"]) == terms.price
    # With the report's own share count the IPO price is the report's fair value per share.
    assert terms.price == report.fair_value_per_share
    assert (body["total_shares"], body["shares_offered"], body["retained_shares"]) == (
        1_000_000,
        490_000,
        510_000,
    )
    assert "health_factor" in body["formula"] and "retained_pct" in body["formula"]
    assert written(world, asset["id"])[:2] == (0, 0)  # a preview writes nothing


@requires_db
def test_the_preview_follows_the_offering(world: World_) -> None:
    asset = listed(world)
    base = preview(world, asset["id"]).json()
    bigger = preview(world, asset["id"], total_shares=2_000_000, retained_pct="30").json()

    assert bigger["fair_value_total"] == base["fair_value_total"]
    assert (bigger["shares_offered"], bigger["retained_shares"]) == (1_400_000, 600_000)
    assert D(bigger["ipo_price"]) == (D(base["fair_value_total"]) / 2_000_000).quantize(D("0.0001"))


@requires_db
@pytest.mark.parametrize(
    "params",
    [
        {"retained_pct": "9.99"},
        {"retained_pct": "90.01"},
        {"retained_pct": "50.123"},
        {"total_shares": 9_999},
        {"total_shares": 10_000_001},
    ],
)
def test_the_preview_validates_the_offering(world: World_, params: dict[str, Any]) -> None:
    asset = listed(world)
    assert preview(world, asset["id"], **params).status_code == 422


@requires_db
def test_only_the_owner_previews_or_launches(world: World_) -> None:
    asset = listed(world)
    for user, status_code, detail in [
        (world.steward, 403, "owner_only"),
        (world.outsider, 403, "owner_only"),
        (world.other_steward, 403, "owner_only"),
        (world.admin, 403, "owner_only"),
    ]:
        for response in (preview(world, asset["id"], user), launch_ipo(world, asset["id"], user)):
            assert (response.status_code, response.json()["detail"]) == (status_code, detail)
    anonymous = client_as(world, None)
    assert anonymous.get(f"/assets/{asset['id']}/ipo/preview").status_code == 401
    assert anonymous.post(f"/assets/{asset['id']}/ipo", json={}).status_code == 401
    # Another world's asset doesn't exist for this owner.
    other_world_asset = world.session.exec(
        select(Asset.id).where(Asset.world_id != world.id, Asset.site_key == "wetland_mx")
    ).first()
    assert other_world_asset is not None
    assert preview(world, str(other_world_asset)).status_code == 404
    assert launch_ipo(world, str(other_world_asset)).status_code == 404
    assert written(world, asset["id"])[:2] == (0, 0)


# ----- launch -----------------------------------------------------------------------------------


@requires_db
def test_the_launch_prices_seeds_the_stake_records_and_opens_the_float(world: World_) -> None:
    asset = listed(world)
    asset_id = UUID(asset["id"])
    shown = preview(world, asset["id"], total_shares=2_000_000, retained_pct="40").json()
    card_before = next(
        c for c in client_as(world, world.outsider).get("/assets").json() if c["id"] == asset["id"]
    )
    assert (card_before["trading"], card_before["price"]) == (False, None)

    response = launch_ipo(
        world,
        asset["id"],
        total_shares=2_000_000,
        retained_pct="40",
        expected_price=shown["ipo_price"],
    )

    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert {k: v for k, v in body.items() if k != "launched_at"} == shown
    world.session.expire_all()
    row = world.session.get_one(Asset, asset_id)
    assert row.ipo_at is not None
    assert (row.total_shares, row.retained_pct, row.primary_shares_remaining) == (
        2_000_000,
        D("40.00"),
        1_200_000,
    )
    assert row.community_wallet == D("0.00")
    stake = world.session.exec(select(Holding).where(Holding.asset_id == asset_id)).all()
    assert [(h.user_id, h.shares) for h in stake] == [(row.community_user_id, 800_000)]
    prices = world.session.exec(select(Price).where(Price.asset_id == asset_id)).all()
    assert [(p.price, p.reason, p.ts) for p in prices] == [
        (D(shown["ipo_price"]), "ipo", row.ipo_at)
    ]
    entries = world.session.exec(
        select(LedgerEntry).where(LedgerEntry.asset_id == asset_id).order_by(col(LedgerEntry.seq))
    ).all()
    anchor = entries[-1]
    assert anchor.kind is LedgerKind.PRICE_ANCHOR
    assert anchor.ref_id == UUID(shown["report_id"])
    assert anchor.payload["reason"] == "ipo"
    for key in (
        "value_mid",
        "health",
        "confidence",
        "health_factor",
        "confidence_factor",
        "fair_value_total",
        "fair_value_per_share",
        "retained_pct",
    ):
        assert D(anchor.payload[key]) == D(shown[key]), key
    assert (anchor.payload["price"], anchor.payload["total_shares"]) == (
        shown["ipo_price"],
        2_000_000,
    )
    assert (anchor.payload["shares_offered"], anchor.payload["retained_shares"]) == (
        1_200_000,
        800_000,
    )
    assert str(row.community_user_id) not in str(anchor.payload)  # T67: no account IDs
    assert verify(entries).valid
    tick = world.session.exec(
        select(WorldEvent)
        .where(WorldEvent.world_id == world.id, WorldEvent.type == StreamEventType.PRICE_TICK)
        .order_by(col(WorldEvent.id).desc())
    ).first()
    assert tick is not None and tick.audience_community_id is None  # public
    assert tick.payload == {"asset_id": asset["id"], "price": shown["ipo_price"], "reason": "ipo"}
    assert_conserved(world.session, asset_id)

    outsider = client_as(world, world.outsider)
    card = next(c for c in outsider.get("/assets").json() if c["id"] == asset["id"])
    assert (card["trading"], card["price"], card["price_change_pct"]) == (
        True,
        shown["ipo_price"],
        0.0,
    )
    detail = outsider.get(f"/assets/{asset['id']}").json()
    assert detail["trading"] is True and detail["ipo_at"] is not None
    assert detail["primary_shares_remaining"] == 1_200_000


@requires_db
def test_an_ipo_launches_only_once(world: World_) -> None:
    asset = listed(world)
    assert launch_ipo(world, asset["id"]).status_code == 201
    before = written(world, asset["id"])

    again = launch_ipo(world, asset["id"], retained_pct="20")

    assert (again.status_code, again.json()["detail"]) == (409, ALREADY_LAUNCHED)
    assert again.headers["cache-control"] == "no-store"
    assert written(world, asset["id"]) == before
    seen = preview(world, asset["id"])
    assert (seen.status_code, seen.json()["detail"]) == (409, ALREADY_LAUNCHED)


@requires_db
def test_curated_sites_are_already_launched(world: World_) -> None:
    rosa = world.session.exec(
        select(User).where(User.world_id == world.id, User.persona_key == COMMUNITY_PERSONA.key)
    ).one()
    site = curated(world)
    assert site.ipo_at is not None
    response = launch_ipo(world, str(site.id), rosa)
    assert (response.status_code, response.json()["detail"]) == (409, ALREADY_LAUNCHED)
    card = next(
        c for c in client_as(world, world.outsider).get("/assets").json() if c["id"] == str(site.id)
    )
    assert card["trading"] is True


@requires_db
def test_only_a_listed_asset_launches(world: World_) -> None:
    unlisted = draft(world, geojson=square(800, lat=LAT + 1))
    for response in (preview(world, unlisted["id"]), launch_ipo(world, unlisted["id"])):
        assert (response.status_code, response.json()["detail"]) == (409, NOT_LISTED)

    asset = listed(world)
    admin = client_as(world, world.admin)
    suspended = admin.post(f"/admin/assets/{asset['id']}/suspend", json={"reason": "moderation"})
    assert suspended.status_code == 200, suspended.text
    for response in (preview(world, asset["id"]), launch_ipo(world, asset["id"])):
        assert (response.status_code, response.json()["detail"]) == (409, NOT_LISTED)
    assert written(world, asset["id"])[:2] == (0, 0)


@requires_db
@pytest.mark.parametrize(
    "body",
    [
        {"retained_pct": "9.99"},
        {"retained_pct": "90.01"},
        {"retained_pct": 50.555},
        {"total_shares": 9_999},
        {"total_shares": 10_000_001},
        {"expected_price": "0"},
        {"holder": "someone"},
    ],
)
def test_the_launch_validates_the_offering(world: World_, body: dict[str, Any]) -> None:
    asset = listed(world)
    assert launch_ipo(world, asset["id"], **body).status_code == 422
    assert written(world, asset["id"])[:2] == (0, 0)


@requires_db
def test_a_stale_confirmed_price_is_refused(world: World_) -> None:
    asset = listed(world)
    price = D(preview(world, asset["id"]).json()["ipo_price"])

    stale = launch_ipo(world, asset["id"], expected_price=str(price + D("0.0001")))

    assert (stale.status_code, stale.json()["detail"]) == (409, "ipo_price_changed")
    assert written(world, asset["id"])[:2] == (0, 0)
    assert launch_ipo(world, asset["id"], expected_price=str(price)).status_code == 201


@requires_db
def test_the_launch_gate_is_checked_inside_the_transaction(
    world: World_, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The T69 seam: a gate refusal (e.g. not verified) rolls everything back."""
    asset = listed(world)
    seen: list[AssetStatus] = []

    def gate(session: Session, locked: Asset) -> None:
        seen.append(locked.status)
        raise IpoRefused("verification_required")

    monkeypatch.setattr(ipo_service, "check_gate", gate)
    response = launch_ipo(world, asset["id"])

    assert (response.status_code, response.json()["detail"]) == (409, "verification_required")
    assert seen == [AssetStatus.LISTED]
    assert written(world, asset["id"])[:2] == (0, 0)
    world.session.expire_all()
    assert world.session.get_one(Asset, UUID(asset["id"])).ipo_at is None


# ----- trading ----------------------------------------------------------------------------------


@requires_db
def test_orders_need_a_launched_listed_asset(world: World_) -> None:
    asset = listed(world)
    asset_id = UUID(asset["id"])
    refused = buy(world, asset["id"], 10)
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_trading")

    assert launch_ipo(world, asset["id"]).status_code == 201
    filled = buy(world, asset["id"], 10)
    assert filled.status_code == 200, filled.text
    assert filled.json()["is_primary"] is True
    world.session.expire_all()
    row = world.session.get_one(Asset, asset_id)
    assert row.primary_shares_remaining == 490_000 - 10
    assert row.community_wallet == (D(filled.json()["fill_price"]) * 10).quantize(D("0.01"))
    assert_conserved(world.session, asset_id)

    admin = client_as(world, world.admin)
    suspend = admin.post(f"/admin/assets/{asset['id']}/suspend", json={"reason": "moderation"})
    assert suspend.status_code == 200
    halted = buy(world, asset["id"], 10)
    assert (halted.status_code, halted.json()["detail"]) == (409, "not_trading")
    card = next(
        c for c in client_as(world, world.outsider).get("/assets").json() if c["id"] == asset["id"]
    )
    assert card["trading"] is False
    assert admin.post(f"/admin/assets/{asset['id']}/resume").status_code == 200
    assert buy(world, asset["id"], 10).status_code == 200


@requires_db
def test_shares_are_conserved_through_primary_and_secondary_trades(world: World_) -> None:
    asset = listed(world)
    asset_id = UUID(asset["id"])
    assert launch_ipo(world, asset["id"], retained_pct="90").status_code == 201
    assert_conserved(world.session, asset_id)

    investor = client_as(world, world.outsider)
    for side, qty in [("buy", 60), ("sell", 25), ("buy", 40)]:
        response = investor.post(
            "/orders", json={"asset_id": asset["id"], "side": side, "qty": qty}
        )
        assert response.status_code == 200, response.text
    # Buys take the float first, so the 25 sold back stay with the market maker.
    world.session.expire_all()
    row = world.session.get_one(Asset, asset_id)
    held = world.session.exec(
        select(func.sum(Holding.shares)).where(Holding.asset_id == asset_id)
    ).one()
    assert row.primary_shares_remaining == 100_000 - 60 - 40
    assert held == 900_000 + 75
    assert_conserved(world.session, asset_id, market_maker=25)


# ----- concurrency (committed transactions) -----------------------------------------------------


@requires_db
def test_two_concurrent_launches_open_one_ipo(committed: Committed) -> None:
    asset_id = _committed_draft(committed)
    with Session(committed.engine) as setup:
        site = setup.exec(
            select(Report).where(
                Report.world_id == committed.world_id,
                col(Report.asset_id).in_(
                    select(Asset.id).where(
                        Asset.world_id == committed.world_id, Asset.site_key == "wetland_mx"
                    )
                ),
            )
        ).first()
        assert site is not None
        setup.add(
            Report(
                world_id=committed.world_id,
                asset_id=asset_id,
                version=1,
                value_mid=site.value_mid,
                health_score=site.health_score,
                confidence=site.confidence,
            )
        )
        asset = setup.get_one(Asset, asset_id)
        asset.status = AssetStatus.LISTED
        setup.add(asset)
        setup.commit()

    barrier = threading.Barrier(2)
    outcomes: list[str] = []

    def go() -> None:
        with Session(committed.engine) as session:
            barrier.wait(timeout=10)
            try:
                launch(session, committed.world_id, asset_id, Offering())
                session.commit()
                outcomes.append("launched")
            except IpoRefused as exc:
                session.rollback()
                outcomes.append(exc.code)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert sorted(outcomes) == [ALREADY_LAUNCHED, "launched"]
    with Session(committed.engine) as check:
        prices = check.exec(select(Price).where(Price.asset_id == asset_id)).all()
        assert [p.reason for p in prices] == ["ipo"]
        assert_conserved(check, asset_id)


# ----- migration --------------------------------------------------------------------------------


@requires_db
def test_the_migration_backfills_launches_and_downgrades() -> None:
    cfg = alembic_cfg()
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0012")
    command.upgrade(cfg, "head")
    from app.db import engine

    with Session(engine) as check:
        priced = check.exec(
            select(Asset).where(col(Asset.id).in_(select(Price.asset_id).distinct()))
        ).all()
        assert all(asset.ipo_at is not None for asset in priced)

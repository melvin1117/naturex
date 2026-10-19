"""IPO launch (T59): the preview, the launch transaction, `not_trading` and share conservation."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi import HTTPException
from sqlalchemy import func, text
from sqlmodel import Session, col, select

from app.ledger import verify
from app.market.engine import ipo_terms
from app.market.offering import InvalidOffering, Offering
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
from app.models import World as WorldRow
from app.routers import ipo as ipo_router
from app.routers.market import place_order
from app.schemas import OrderCreate
from app.seed import COMMUNITY_PERSONA
from app.services import ipo as ipo_service
from app.services.ipo import (
    ALREADY_LAUNCHED,
    NO_RATING,
    NOT_LISTED,
    PRICE_TOO_HIGH,
    PRICE_TOO_LOW,
    IpoRefused,
    is_trading,
    launch,
    quote,
)
from app.services.lifecycle import SuspensionReason
from app.services.listings import RUN_IN_PROGRESS, suspend
from app.services.rating import FairValueInputs, fair_value_inputs, report_fair_value_total
from tests import test_lifecycle as lifecycle
from tests.conftest import alembic_cfg, requires_db
from tests.test_lifecycle import (
    LAT,
    Committed,
    World_,
    _committed_draft,
    _race,
    client_as,
    curated,
    draft,
    square,
    submit,
)
from tests.test_lifecycle import _slow_publish as _slow_listing_publish
from tests.test_market_api import _as

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


def _snapshot(**fair_value: str) -> dict[str, Any]:
    return {"rating": {"fair_value": fair_value}}


def test_the_quote_prefers_the_reports_unrounded_snapshot() -> None:
    report = _report(
        auditor_json=_snapshot(value_mid="1000000.004", health="80.04", confidence="59.996")
    )

    assert fair_value_inputs(report) == FairValueInputs(D("1000000.004"), D("80.04"), D("59.996"))


def test_without_a_snapshot_the_inputs_are_the_stored_columns() -> None:
    expected = FairValueInputs(D("1000000.00"), D("80.00"), D("60.00"))
    assert fair_value_inputs(_report()) == expected
    assert fair_value_inputs(_report(auditor_json={"rating": {}})) == expected
    # An incomplete snapshot never mixes with the columns: all three come from one source.
    partial = _report(auditor_json=_snapshot(value_mid="5", health="10"))
    assert fair_value_inputs(partial) == expected


def test_a_snapshot_health_of_zero_is_a_value_not_a_gap() -> None:
    report = _report(auditor_json=_snapshot(value_mid="1000000", health="0", confidence="0"))

    assert fair_value_inputs(report) == FairValueInputs(D("1000000"), D("0"), D("0"))
    terms = quote(_asset(), report, Offering()).terms
    assert (terms.health_factor, terms.confidence_factor) == (D("0.5"), D("0.7"))


def test_a_price_above_a_new_accounts_cash_is_quoted_but_blocked() -> None:
    # 2e9 × 10 × 1 × 1 = 2e10 over 1M shares: 20,000 a share, more than the 10,000 starting cash.
    rich = _report(value_mid=D("2000000000.00"), health_score=D("100"), confidence=D("100"))

    blocked = quote(_asset(), rich, Offering())
    assert (blocked.terms.price, blocked.launchable) == (D("20000.0000"), False)
    assert blocked.blocked_reason == PRICE_TOO_HIGH
    fine = quote(_asset(), rich, Offering(total_shares=2_000_000))
    assert (fine.terms.price, fine.launchable) == (D("10000.0000"), True)


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
    """POST the launch; `expected_price` defaults to the owner's preview of the same offering
    (a placeholder when there's no preview)."""
    if "expected_price" not in body:
        params = {k: body[k] for k in ("total_shares", "retained_pct") if k in body}
        shown = preview(w, asset_id, **params)
        body["expected_price"] = shown.json()["ipo_price"] if shown.status_code == 200 else "1"
    return client_as(w, user or w.owner).post(f"/assets/{asset_id}/ipo", json=body)


def set_fair_value(w: World_, asset_id: str, value_mid: str, health: str, confidence: str) -> None:
    """Make the latest report price the IPO from these inputs (its rating snapshot's)."""
    report = report_of(w, asset_id)
    auditor_json = dict(report.auditor_json or {})
    rating = dict(auditor_json.get("rating") or {})
    rating["fair_value"] = {"value_mid": value_mid, "health": health, "confidence": confidence}
    auditor_json["rating"] = rating
    report.auditor_json = auditor_json
    w.session.add(report)
    w.session.commit()


def buy(w: World_, asset_id: str, qty: int) -> Any:
    return client_as(w, w.outsider).post(
        "/orders", json={"asset_id": asset_id, "side": "buy", "qty": qty}
    )


def report_of(w: World_, asset_id: str) -> Report:
    report = w.session.exec(
        select(Report).where(Report.asset_id == UUID(asset_id)).order_by(col(Report.version).desc())
    ).first()
    assert report is not None
    return report


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
    assert inputs is not None
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
    assert (body["launchable"], body["blocked_reason"]) == (True, None)
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
    detail_before = client_as(world, world.outsider).get(f"/assets/{asset['id']}").json()
    assert (detail_before["total_shares"], detail_before["retained_pct"]) == (None, None)
    assert (detail_before["ipo_at"], detail_before["primary_shares_remaining"]) == (None, 0)

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
    preview_only = {"launched_at", "launchable", "blocked_reason"}
    assert {k: v for k, v in body.items() if k not in preview_only} == {
        k: v for k, v in shown.items() if k not in preview_only
    }
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
    assert (detail["total_shares"], detail["retained_pct"]) == (2_000_000, "40.00")


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
    """The T69 seam: the preview says why the launch is blocked, and a gate refusal inside the
    launch transaction (e.g. not verified) rolls everything back."""
    asset = listed(world)
    price = preview(world, asset["id"]).json()["ipo_price"]
    seen: list[AssetStatus] = []

    def gate(session: Session, locked: Asset) -> None:
        seen.append(locked.status)
        raise IpoRefused("verification_required")

    monkeypatch.setattr(ipo_service, "check_gate", gate)
    shown = preview(world, asset["id"]).json()
    assert (shown["launchable"], shown["blocked_reason"]) == (False, "verification_required")
    response = launch_ipo(world, asset["id"], expected_price=price)

    assert (response.status_code, response.json()["detail"]) == (409, "verification_required")
    assert seen == [AssetStatus.LISTED, AssetStatus.LISTED]  # the preview's, then the launch's
    assert written(world, asset["id"])[:2] == (0, 0)
    world.session.expire_all()
    assert world.session.get_one(Asset, UUID(asset["id"])).ipo_at is None


# ----- trading ----------------------------------------------------------------------------------


@requires_db
def test_orders_need_a_launched_listed_asset(world: World_) -> None:
    asset = listed(world)
    asset_id = UUID(asset["id"])
    quote_url = f"/assets/{asset['id']}/quote?side=buy&qty=10"
    refused = buy(world, asset["id"], 10)
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_trading")
    # Anonymous visitors read the live world (T73), where this sandbox asset doesn't exist.
    assert client_as(world, None).get(quote_url).status_code == 404
    quoted = client_as(world, world.outsider).get(quote_url)
    assert (quoted.status_code, quoted.json()["detail"]) == (409, "not_trading")

    assert launch_ipo(world, asset["id"]).status_code == 201
    assert client_as(world, world.outsider).get(quote_url).status_code == 200
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
    paused_quote = client_as(world, world.outsider).get(quote_url)
    assert (paused_quote.status_code, paused_quote.json()["detail"]) == (409, "not_trading")
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
def test_a_listing_the_caller_cant_see_is_not_found(world: World_) -> None:
    """A draft is private to its community (T58): outsiders get 404, never a 403 that would
    tell them it exists."""
    unlisted = draft(world)
    for user in (world.outsider, world.other_steward):
        for response in (
            preview(world, unlisted["id"], user),
            launch_ipo(world, unlisted["id"], user),
        ):
            assert (response.status_code, response.json()["detail"]) == (404, "not_found")
    # Those who can see it get the policy's answer.
    for user, expected in [
        (world.steward, (403, "owner_only")),
        (world.admin, (403, "owner_only")),
        (world.owner, (409, NOT_LISTED)),
    ]:
        response = preview(world, unlisted["id"], user)
        assert (response.status_code, response.json()["detail"]) == expected
    anonymous = client_as(world, None)
    assert anonymous.get(f"/assets/{unlisted['id']}/ipo/preview").status_code == 401


@requires_db
def test_an_asset_removed_meanwhile_is_not_found(
    world: World_, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A "Reset my demo" can delete the asset between authorization and the launch's lock."""
    asset = listed(world)

    def gone(*args: Any, **kwargs: Any) -> Any:
        raise LookupError("asset not found")

    monkeypatch.setattr(ipo_service, "lock_asset", gone)
    monkeypatch.setattr(ipo_router, "preview", gone)

    for response in (
        preview(world, asset["id"]),
        launch_ipo(world, asset["id"], expected_price="1"),
    ):
        assert (response.status_code, response.json()["detail"]) == (404, "not_found")
    assert written(world, asset["id"])[:2] == (0, 0)


@requires_db
def test_a_launch_is_refused_while_a_rating_run_is_queued(world: World_) -> None:
    asset = listed(world)
    world.runner.start(world.id, UUID(asset["id"]))  # queued; the Deferred executor holds it

    shown = preview(world, asset["id"]).json()
    assert (shown["launchable"], shown["blocked_reason"]) == (False, RUN_IN_PROGRESS)
    refused = launch_ipo(world, asset["id"], expected_price=shown["ipo_price"])
    assert (refused.status_code, refused.json()["detail"]) == (409, RUN_IN_PROGRESS)
    assert written(world, asset["id"])[:2] == (0, 0)

    world.executor.run_all()
    assert preview(world, asset["id"]).json()["launchable"] is True
    assert launch_ipo(world, asset["id"]).status_code == 201


@requires_db
def test_a_launch_is_refused_while_a_rating_run_is_running(world: World_) -> None:
    asset = listed(world)
    attempts: list[Any] = []
    saved = world.runner.metrics_loader

    def load_and_try_to_launch(info: Any, scenario: Any) -> Any:
        attempts.append(launch_ipo(world, asset["id"]))  # mid-run: the run is active
        return saved(info, scenario)

    world.runner.metrics_loader = load_and_try_to_launch
    world.runner.start(world.id, UUID(asset["id"]))
    world.executor.run_all()

    assert [(r.status_code, r.json()["detail"]) for r in attempts] == [(409, RUN_IN_PROGRESS)]
    world.session.expire_all()
    assert world.session.get_one(Asset, UUID(asset["id"])).ipo_at is None


@requires_db
def test_a_report_sealed_after_a_launch_uses_the_new_share_count(world: World_) -> None:
    """Defence in depth: the run's report reads `total_shares` from the locked asset when it
    stores, not from the start of the run."""
    asset = listed(world)
    world.runner.start(world.id, UUID(asset["id"]))
    row = world.session.get_one(Asset, UUID(asset["id"]))
    row.total_shares = 2_000_000  # as if a launch had landed while the run was in flight
    world.session.add(row)
    world.session.commit()

    world.executor.run_all()

    report = report_of(world, asset["id"])
    total = report_fair_value_total(report)
    assert report.version == 2 and total is not None
    assert report.fair_value_per_share == (total / 2_000_000).quantize(D("0.0001"))


@requires_db
def test_the_report_diff_compares_total_fair_value_across_the_launch(world: World_) -> None:
    asset = listed(world)
    first = report_of(world, asset["id"])
    assert launch_ipo(world, asset["id"], total_shares=2_000_000).status_code == 201
    world.runner.start(world.id, UUID(asset["id"]))
    world.executor.run_all()
    second = report_of(world, asset["id"])
    assert second.fair_value_per_share != first.fair_value_per_share  # half: twice the shares

    diff = client_as(world, world.outsider).get(f"/reports/{second.id}/diff/{first.id}")

    changes = diff.json()["changes"]
    assert not any(change.startswith("fair_value_per_share") for change in changes)
    total = report_fair_value_total(second)
    assert f"fair_value_total unchanged: {total}" in changes


@requires_db
def test_a_price_nobody_can_afford_is_blocked_until_more_shares_are_issued(
    world: World_,
) -> None:
    asset = listed(world)
    set_fair_value(world, asset["id"], "2000000000", "100", "100")

    shown = preview(world, asset["id"]).json()
    assert (shown["ipo_price"], shown["launchable"], shown["blocked_reason"]) == (
        "20000.0000",
        False,
        PRICE_TOO_HIGH,
    )
    refused = launch_ipo(world, asset["id"], expected_price=shown["ipo_price"])
    assert (refused.status_code, refused.json()["detail"]) == (409, PRICE_TOO_HIGH)
    assert written(world, asset["id"])[:2] == (0, 0)

    more = preview(world, asset["id"], total_shares=4_000_000).json()
    assert (more["ipo_price"], more["launchable"]) == ("5000.0000", True)
    assert launch_ipo(world, asset["id"], total_shares=4_000_000).status_code == 201


@requires_db
def test_the_confirmed_price_may_drop_trailing_zeros(world: World_) -> None:
    asset = listed(world)
    set_fair_value(world, asset["id"], "1000000", "80", "60")
    assert preview(world, asset["id"]).json()["ipo_price"] == "7.9200"

    assert launch_ipo(world, asset["id"], expected_price="7.92").status_code == 201


@requires_db
def test_the_confirmed_price_is_required(world: World_) -> None:
    asset = listed(world)
    response = client_as(world, world.owner).post(f"/assets/{asset['id']}/ipo", json={})

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "expected_price"]
    assert written(world, asset["id"])[:2] == (0, 0)


def _committed_listed(c: Committed, lat: float = LAT) -> tuple[UUID, Decimal]:
    """A committed listing in `listed` with a report v1 (the curated wetland's numbers), and
    its IPO price for the default offering."""
    asset_id = _committed_draft(c, lat=lat)
    with Session(c.engine) as setup:
        site = setup.exec(
            select(Report)
            .join(Asset, col(Asset.id) == col(Report.asset_id))
            .where(Asset.world_id == c.world_id, Asset.site_key == "wetland_mx")
        ).first()
        assert site is not None
        setup.add(
            Report(
                world_id=c.world_id,
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
        price = ipo_service.preview(setup, c.world_id, asset_id, Offering()).terms.price
    return asset_id, price


def _launch_job(c: Committed, asset_id: UUID, price: Decimal) -> Callable[[], str]:
    def job() -> str:
        with Session(c.engine) as session:
            try:
                launch(session, c.world_id, asset_id, Offering(), expected_price=price)
                session.commit()
                return "launched"
            except IpoRefused as exc:
                session.rollback()
                return exc.code

    return job


def _slow_ipo_publish(monkeypatch: pytest.MonkeyPatch, held: threading.Event) -> None:
    """In the thread named `holder`, pause the launch just before it publishes, holding the
    world, asset and publisher locks."""
    real = ipo_service.publish

    def publish(*args: Any, **kwargs: Any) -> Any:
        if threading.current_thread().name == "holder":
            held.set()
            time.sleep(0.5)
        return real(*args, **kwargs)

    monkeypatch.setattr(ipo_service, "publish", publish)


@requires_db
def test_two_concurrent_launches_open_one_ipo(committed: Committed) -> None:
    asset_id, price = _committed_listed(committed)
    barrier = threading.Barrier(2)
    outcomes: list[str] = []
    job = _launch_job(committed, asset_id, price)

    def go() -> None:
        barrier.wait(timeout=10)
        outcomes.append(job())

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


@requires_db
def test_an_order_waits_for_a_launch_in_progress_then_trades(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    asset_id, price = _committed_listed(committed)
    held = threading.Event()
    _slow_ipo_publish(monkeypatch, held)

    with Session(committed.engine) as setup:
        buyer = _as(lifecycle._person(setup, committed.world_id, "Buyer"))

    def order() -> int:
        with Session(committed.engine) as session:
            current = session.get_one(WorldRow, committed.world_id)
            try:
                place_order(
                    OrderCreate(asset_id=asset_id, side="buy", qty=10), current, buyer, session
                )
                return 200
            except HTTPException as exc:
                session.rollback()
                return exc.status_code

    launched, ordered = _race(_launch_job(committed, asset_id, price), order, held)

    assert (launched, ordered) == ("launched", 200)
    with Session(committed.engine) as check:
        reasons = check.exec(
            select(Price.reason).where(Price.asset_id == asset_id).order_by(col(Price.ts))
        ).all()
        assert list(reasons) == ["ipo", "order"]
        assert check.get_one(Asset, asset_id).primary_shares_remaining == 490_000 - 10
        assert_conserved(check, asset_id)


@requires_db
def test_a_suspend_waits_for_a_launch_in_progress(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    asset_id, price = _committed_listed(committed)
    held = threading.Event()
    _slow_ipo_publish(monkeypatch, held)

    def suspend_it() -> AssetStatus:
        with Session(committed.engine) as session:
            asset = suspend(session, committed.world_id, asset_id, SuspensionReason.MODERATION)
            session.commit()
            return asset.status

    launched, suspended = _race(_launch_job(committed, asset_id, price), suspend_it, held)

    assert (launched, suspended) == ("launched", AssetStatus.SUSPENDED)
    with Session(committed.engine) as check:
        asset = check.get_one(Asset, asset_id)
        assert asset.ipo_at is not None and not is_trading(asset)


@requires_db
def test_a_launch_waits_for_a_suspend_in_progress_and_is_refused(
    committed: Committed, monkeypatch: pytest.MonkeyPatch
) -> None:
    asset_id, price = _committed_listed(committed)
    held = threading.Event()
    _slow_listing_publish(monkeypatch, held)

    def suspend_it() -> AssetStatus:
        with Session(committed.engine) as session:
            asset = suspend(session, committed.world_id, asset_id, SuspensionReason.MODERATION)
            session.commit()
            return asset.status

    suspended, launched = _race(suspend_it, _launch_job(committed, asset_id, price), held)

    assert (suspended, launched) == (AssetStatus.SUSPENDED, NOT_LISTED)
    with Session(committed.engine) as check:
        assert check.get_one(Asset, asset_id).ipo_at is None
        assert check.exec(select(Price).where(Price.asset_id == asset_id)).all() == []


# ----- migration --------------------------------------------------------------------------------


def _sql(c: Committed, statement: str, **params: Any) -> list[Any]:
    with c.engine.begin() as connection:
        result = connection.execute(text(statement), params)
        return list(result.all()) if result.returns_rows else []


@requires_db
def test_the_migration_backfills_launches_and_zeroes_unissued_floats(
    committed: Committed,
) -> None:
    cfg = alembic_cfg()
    unpriced = _committed_draft(committed, lat=LAT)
    held = _committed_draft(committed, lat=LAT + 1)
    priced = _committed_draft(committed, lat=LAT + 2)
    curated_launched = _sql(
        committed,
        "SELECT id, ipo_at FROM assets WHERE world_id = :w AND site_key IS NOT NULL",
        w=committed.world_id,
    )
    assert curated_launched and all(ipo_at is not None for _, ipo_at in curated_launched)
    try:
        command.downgrade(cfg, "0012")
        ids = [unpriced, held, priced]
        _sql(
            committed,
            "UPDATE assets SET primary_shares_remaining = 490000 WHERE id = ANY(:ids)",
            ids=ids,
        )
        _sql(
            committed,
            "INSERT INTO holdings (world_id, user_id, asset_id, shares) "
            "SELECT world_id, community_user_id, id, 510000 FROM assets WHERE id = :a",
            a=held,
        )
        first, later = datetime(2026, 10, 1, tzinfo=UTC), datetime(2026, 10, 2, tzinfo=UTC)
        for ts, reason in ((later, "order"), (first, "ipo")):
            _sql(
                committed,
                "INSERT INTO prices (world_id, asset_id, ts, price, reason) "
                "VALUES (:w, :a, :ts, 7.92, :r)",
                w=committed.world_id,
                a=priced,
                ts=ts,
                r=reason,
            )

        command.upgrade(cfg, "head")

        rows = {
            asset_id: (ipo_at, primary)
            for asset_id, ipo_at, primary in _sql(
                committed,
                "SELECT id, ipo_at, primary_shares_remaining FROM assets WHERE id = ANY(:ids)",
                ids=ids,
            )
        }
        assert rows[unpriced] == (None, 0)  # no prices: unlaunched, no shares issued
        assert rows[held] == (None, 490_000)  # holdings: left alone (and warned about)
        assert rows[priced] == (first, 490_000)  # launched at its first price
        backfilled = _sql(
            committed,
            "SELECT id, ipo_at FROM assets WHERE world_id = :w AND site_key IS NOT NULL",
            w=committed.world_id,
        )
        assert sorted(backfilled) == sorted(curated_launched)  # the first price's ts again
    finally:
        command.upgrade(cfg, "head")


@requires_db
def test_the_migration_refuses_an_asset_with_two_ipo_prices(committed: Committed) -> None:
    cfg = alembic_cfg()
    asset_id = _committed_draft(committed)
    try:
        command.downgrade(cfg, "0012")
        for day in (1, 2):
            _sql(
                committed,
                "INSERT INTO prices (world_id, asset_id, ts, price, reason) "
                "VALUES (:w, :a, :ts, 7.92, 'ipo')",
                w=committed.world_id,
                a=asset_id,
                ts=datetime(2026, 10, day, tzinfo=UTC),
            )

        with pytest.raises(RuntimeError, match="1 assets have more than one 'ipo' price"):
            command.upgrade(cfg, "head")

        assert _sql(committed, "SELECT version_num FROM alembic_version") == [("0012",)]
        _sql(
            committed,
            "DELETE FROM prices WHERE asset_id = :a AND ts = :ts",
            a=asset_id,
            ts=datetime(2026, 10, 2, tzinfo=UTC),
        )
    finally:
        command.upgrade(cfg, "head")
    assert _sql(committed, "SELECT version_num FROM alembic_version") == [("0013",)]

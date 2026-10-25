"""Opening offers sent for review (ADR-0008 §5): the owner sends, the Reviewer decides."""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlmodel import col, select

from app.models import Asset, AssetStatus, Holding, Price
from tests import test_lifecycle as lifecycle
from tests.conftest import requires_db
from tests.test_ipo import listed, preview, set_fair_value
from tests.test_lifecycle import World_, client_as

conn = lifecycle.conn
world = lifecycle.world


def send(w: World_, asset_id: str, user: Any = None, **body: Any) -> Any:
    """POST the offer; `expected_price` defaults to the owner's preview of the same terms."""
    if "expected_price" not in body:
        params = {k: body[k] for k in ("total_shares", "retained_pct") if k in body}
        shown = preview(w, asset_id, **params)
        body["expected_price"] = shown.json()["ipo_price"] if shown.status_code == 200 else "1"
    return client_as(w, user or w.owner).post(f"/assets/{asset_id}/offer", json=body)


def queue(w: World_, user: Any = None) -> Any:
    return client_as(w, user or w.admin).get("/admin/offers")


def decide(w: World_, asset_id: str, step: str, user: Any = None, **body: Any) -> Any:
    return client_as(w, user or w.admin).post(
        f"/admin/assets/{asset_id}/offer/{step}", json=body or None
    )


def detail(w: World_, asset_id: str, user: Any = None) -> Any:
    return client_as(w, user or w.owner).get(f"/assets/{asset_id}")


@requires_db
def test_the_owner_sends_an_offer_that_waits_off_the_marketplace(world: World_) -> None:
    asset = listed(world)

    sent = send(world, asset["id"], total_shares=2_000_000, retained_pct="40")

    assert sent.status_code == 200, sent.text
    body = sent.json()
    assert (body["total_shares"], Decimal(body["retained_pct"])) == (2_000_000, Decimal(40))
    assert body["sent_at"]
    offer = detail(world, asset["id"]).json()["offer"]
    assert offer == {
        "total_shares": 2_000_000,
        "retained_pct": "40.00",
        "sent_at": offer["sent_at"],
        "review_note": None,
    }
    # Nothing trades yet, and nobody outside the community sees it.
    world.session.expire_all()
    row = world.session.get_one(Asset, UUID(asset["id"]))
    assert (row.status, row.ipo_at) == (AssetStatus.LISTED, None)
    assert detail(world, asset["id"], world.outsider).status_code == 404


@requires_db
def test_an_offer_needs_the_price_the_rating_sets_now(world: World_) -> None:
    asset = listed(world)

    stale = send(world, asset["id"], expected_price="0.0001")

    assert (stale.status_code, stale.json()["detail"]) == (409, "ipo_price_changed")
    assert detail(world, asset["id"]).json()["offer"] is None


@requires_db
def test_only_the_owner_sends_and_only_the_reviewer_decides(world: World_) -> None:
    asset = listed(world)
    for user, code, reason in [
        (world.steward, 403, "owner_only"),
        (world.admin, 403, "owner_only"),
        (world.outsider, 404, "not_found"),
    ]:
        response = send(world, asset["id"], user, expected_price="1")
        assert (response.status_code, response.json()["detail"]) == (code, reason)
    assert send(world, asset["id"]).status_code == 200
    for user in (world.owner, world.steward, world.outsider):
        assert queue(world, user).status_code in (403, 404)
        for step, body in (("approve", {}), ("send-back", {"note": "x"})):
            assert decide(world, asset["id"], step, user, **body).status_code in (403, 404)


@requires_db
def test_the_reviewer_sees_what_waits_and_approving_launches_it(world: World_) -> None:
    asset = listed(world)
    terms = send(world, asset["id"], total_shares=2_000_000, retained_pct="40").json()

    waiting = queue(world)
    assert waiting.status_code == 200, waiting.text
    [item] = [i for i in waiting.json() if i["asset_id"] == asset["id"]]
    assert item["asset_name"] == asset["name"]
    assert item["community_name"]
    assert item["ipo_price"] == terms["ipo_price"]
    assert (item["total_shares"], Decimal(item["retained_pct"])) == (2_000_000, Decimal(40))
    assert item["verification"]["level"]

    approved = decide(world, asset["id"], "approve")

    assert approved.status_code == 200, approved.text
    assert approved.json()["ipo_price"] == terms["ipo_price"]
    world.session.expire_all()
    row = world.session.get_one(Asset, UUID(asset["id"]))
    assert row.ipo_at is not None and row.offer_sent_at is None
    assert (row.total_shares, str(row.retained_pct)) == (2_000_000, "40.00")
    # Launched with the community's terms: its stake and the opening price are written.
    stake = world.session.exec(select(Holding.shares).where(Holding.asset_id == row.id)).one()
    assert stake == 800_000
    assert world.session.exec(select(Price).where(Price.asset_id == row.id)).first()
    # Public now, and no longer waiting.
    assert detail(world, asset["id"], world.outsider).status_code == 200
    assert detail(world, asset["id"]).json()["offer"] is None
    assert all(i["asset_id"] != asset["id"] for i in queue(world).json())


@requires_db
def test_an_approval_launches_at_the_price_the_rating_sets_then(world: World_) -> None:
    asset = listed(world)
    before = send(world, asset["id"]).json()["ipo_price"]
    set_fair_value(world, asset["id"], value_mid="3000000", health="90", confidence="90")

    approved = decide(world, asset["id"], "approve")

    assert approved.status_code == 200, approved.text
    assert approved.json()["ipo_price"] != before


@requires_db
def test_the_reviewer_sends_an_offer_back_with_a_note(world: World_) -> None:
    asset = listed(world)
    send(world, asset["id"])

    back = decide(world, asset["id"], "send-back", note="Keep at least half of the units.")

    assert back.status_code == 200, back.text
    assert back.json()["review_note"] == "Keep at least half of the units."
    offer = detail(world, asset["id"]).json()["offer"]
    assert (offer["sent_at"], offer["review_note"]) == (None, "Keep at least half of the units.")
    assert all(i["asset_id"] != asset["id"] for i in queue(world).json())
    # Nothing to approve until it's sent again, which clears the note.
    nothing = decide(world, asset["id"], "approve")
    assert (nothing.status_code, nothing.json()["detail"]) == (409, "offer_not_sent")
    assert send(world, asset["id"], retained_pct="60").status_code == 200
    offer = detail(world, asset["id"]).json()["offer"]
    assert offer["sent_at"] and offer["review_note"] is None


@requires_db
def test_a_launched_or_unsent_listing_has_nothing_to_decide(world: World_) -> None:
    asset = listed(world)
    for step, body in (("approve", {}), ("send-back", {"note": "x"})):
        response = decide(world, asset["id"], step, **body)
        assert (response.status_code, response.json()["detail"]) == (409, "offer_not_sent")
    send(world, asset["id"])
    assert decide(world, asset["id"], "approve").status_code == 200
    again = send(world, asset["id"], expected_price="1")
    assert (again.status_code, again.json()["detail"]) == (409, "ipo_already_launched")
    world.session.expire_all()
    assert (
        world.session.exec(
            select(col(Asset.offer_sent_at)).where(Asset.id == UUID(asset["id"]))
        ).one()
        is None
    )

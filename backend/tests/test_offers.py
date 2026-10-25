"""Opening offers sent for review (ADR-0008 §5): the owner sends, the Reviewer decides."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from sqlmodel import col, select

from app.models import Asset, AssetStatus, Holding, Price, UserRole
from app.schemas import NextAction
from tests import test_lifecycle as lifecycle
from tests.conftest import requires_db
from tests.test_ipo import listed, preview, set_fair_value
from tests.test_lifecycle import World_, _member, _person, client_as

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


NEVER_SENT = "2026-01-01T00:00:00Z"


def sent_at(w: World_, asset_id: str) -> str:
    """The offer's `sent_at` as the queue shows it (a placeholder when nothing is sent)."""
    w.session.expire_all()
    at = w.session.exec(select(Asset.offer_sent_at).where(Asset.id == UUID(asset_id))).one()
    return at.isoformat() if at else NEVER_SENT


def decide(w: World_, asset_id: str, step: str, user: Any = None, **body: Any) -> Any:
    """POST a decision on the offer; `sent_at` defaults to the one waiting now."""
    body.setdefault("sent_at", sent_at(w, asset_id))
    return client_as(w, user or w.admin).post(f"/admin/assets/{asset_id}/offer/{step}", json=body)


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
    assert item["terms"]["ipo_price"] == terms["ipo_price"]
    assert item["blocked_reason"] is None
    assert item["sent_at"] == terms["sent_at"]
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


@requires_db
def test_a_decision_names_the_offer_the_reviewer_read(world: World_) -> None:
    asset = listed(world)
    first = send(world, asset["id"], total_shares=2_000_000).json()
    # The community sends new terms while the Reviewer still reads the first ones.
    assert send(world, asset["id"], total_shares=1_000_000).status_code == 200

    for step, body in (("approve", {}), ("send-back", {"note": "Too many units."})):
        stale = decide(world, asset["id"], step, sent_at=first["sent_at"], **body)
        assert (stale.status_code, stale.json()["detail"]) == (409, "offer_changed")
    world.session.expire_all()
    row = world.session.get_one(Asset, UUID(asset["id"]))
    assert (row.ipo_at, row.offer_review_note, row.total_shares) == (None, None, 1_000_000)

    approved = decide(world, asset["id"], "approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["total_shares"] == 1_000_000


@requires_db
def test_the_reviewer_never_decides_their_own_communitys_offer(world: World_) -> None:
    asset = listed(world)
    send(world, asset["id"])
    _member(world.session, world.id, world.community_id, world.admin)
    impartial = _person(world.session, world.id, "Second Admin", UserRole.ADMIN)

    assert queue(world).json() == [], "an admin never sees their own community's offers"
    assert [i["asset_id"] for i in queue(world, impartial).json()] == [asset["id"]]
    for step, body in (("approve", {}), ("send-back", {"note": "x"})):
        refused = decide(world, asset["id"], step, **body)
        assert (refused.status_code, refused.json()["detail"]) == (403, "conflict_of_interest")
    assert decide(world, asset["id"], "approve", impartial).status_code == 200


@requires_db
@pytest.mark.parametrize(
    "body",
    [
        {"note": ""},
        {"note": "   \n "},
        {"note": "x" * 501},
        {"note": "fine", "extra": 1},
        {"note": "fine", "sent_at": None},
    ],
)
def test_a_send_back_needs_a_note_and_the_offer(world: World_, body: dict[str, Any]) -> None:
    asset = listed(world)
    send(world, asset["id"])
    response = decide(world, asset["id"], "send-back", **body)
    assert response.status_code == 422
    assert sent_at(world, asset["id"]) != NEVER_SENT, "still waiting"


@requires_db
def test_a_note_is_trimmed(world: World_) -> None:
    asset = listed(world)
    send(world, asset["id"])
    back = decide(world, asset["id"], "send-back", note="  Keep more units.  ")
    assert back.json()["review_note"] == "Keep more units."


@requires_db
def test_an_offer_the_launch_would_refuse_stays_in_the_queue(world: World_) -> None:
    """A re-rate can price the offer at zero, and a revocation blocks its launch: either way
    the Reviewer still sees it, with why, and can send it back."""
    asset = listed(world)
    send(world, asset["id"], total_shares=10_000_000)
    set_fair_value(world, asset["id"], value_mid="1", health="1", confidence="1")

    [item] = queue(world).json()
    assert (item["terms"], item["blocked_reason"]) == (None, "ipo_price_too_low")
    refused = decide(world, asset["id"], "approve")
    assert (refused.status_code, refused.json()["detail"]) == (409, "ipo_price_too_low")
    assert decide(world, asset["id"], "send-back", note="Issue fewer units.").status_code == 200


@requires_db
def test_a_revoked_listing_cant_send_or_launch_its_offer(world: World_) -> None:
    asset = listed(world)
    send(world, asset["id"])
    row = world.session.get_one(Asset, UUID(asset["id"]))
    row.verification_revoked_at = datetime.now(UTC)
    world.session.add(row)
    world.session.commit()

    [item] = queue(world).json()
    assert item["terms"] is not None and item["blocked_reason"] == "not_verified"
    refused = decide(world, asset["id"], "approve")
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_verified")
    assert sent_at(world, asset["id"]) != NEVER_SENT, "the offer still waits"
    again = send(world, asset["id"])
    assert (again.status_code, again.json()["detail"]) == (409, "not_verified")


@requires_db
def test_a_steward_reads_the_offer_and_the_summary_says_where_it_stands(
    world: World_,
) -> None:
    asset = listed(world)

    def action(user: Any = None) -> tuple[str, Any]:
        summary = client_as(world, user or world.owner).get(
            f"/communities/{world.community_id}/summary"
        )
        [listing] = [x for x in summary.json()["listings"] if x["asset"]["id"] == asset["id"]]
        return listing["next_action"], listing["offer"]

    assert action() == (NextAction.LAUNCH_IPO, None)
    send(world, asset["id"])
    assert detail(world, asset["id"], world.steward).json()["offer"]["sent_at"]
    assert action()[0] == NextAction.OFFER_IN_REVIEW
    decide(world, asset["id"], "send-back", note="Keep more units.")
    next_action, offer = action(world.steward)
    assert next_action == NextAction.OFFER_SENT_BACK
    assert offer["review_note"] == "Keep more units."
    # A same-world admin reads the home but not the community's offer.
    assert action(world.admin) == (NextAction.AWAITING_IPO, None)

"""The live-world seed's data and pure helpers (app.jobs.seed_live). The seed itself drives a
running API with live models, so it isn't run here."""

from __future__ import annotations

import io
import json
import re

from PIL import Image

from app.jobs.seed_live import DATA, DOC_TITLES, box_polygon, sample_document

SEED = json.loads(DATA.read_text())


def community_names() -> set[str]:
    return {c.get("name") or c["match_name"] for c in SEED["communities"]}


def test_every_listing_belongs_to_a_seeded_community_and_has_land() -> None:
    names = community_names()
    for listing in SEED["listings"]:
        assert listing["community"] in names, listing["name"]
        assert ("box" in listing) != ("geometry" in listing), listing["name"]
        assert set(listing["documents"]) <= set(DOC_TITLES), listing["name"]


def test_every_community_has_an_owner_and_a_steward_who_are_people() -> None:
    people = {p["key"] for p in SEED["people"]}
    for community in SEED["communities"]:
        assert community["owner"] in people
        assert community["stewards"]
        assert set(community["stewards"]) <= people


def test_supporters_never_trade_their_own_community() -> None:
    """Members can't back their own community's sites (the insider rule), so traders are
    supporters only."""
    members = {c["owner"] for c in SEED["communities"]} | {
        s for c in SEED["communities"] for s in c["stewards"]
    }
    for who, _site, side, amount in (
        SEED["trades_round_1"] + SEED["trades_round_2"] + SEED["trades_round_3"]
    ):
        assert who not in members
        assert side in {"buy", "sell"}
        assert amount > 0 and (side == "buy" or amount <= 1)


def test_the_data_holds_no_secret() -> None:
    text = DATA.read_text().lower()
    assert "password" not in text.replace("passwords are generated", "")
    assert not re.search(r"\b(sk|key|token)[-_][a-z0-9]{8,}", text)


def test_a_box_is_a_closed_lon_lat_ring() -> None:
    ring = box_polygon([20.0, -87.5, 20.1, -87.4])["coordinates"][0]
    assert ring[0] == ring[-1] == [-87.5, 20.0]
    assert len(ring) == 5


def test_a_sample_document_says_it_is_a_sample_and_is_unique_per_listing() -> None:
    asset = {"area_ha": "400.0", "centroid_lat": 20.03, "centroid_lon": -87.55}
    first = sample_document("assembly_minutes", "Site A", "Community", asset)
    second = sample_document("assembly_minutes", "Site B", "Community", asset)
    image = Image.open(io.BytesIO(first))
    assert image.format == "PNG"
    assert image.size == (1240, 1754)
    # Different listings, different files: a document can't be reused across listings.
    assert first != second

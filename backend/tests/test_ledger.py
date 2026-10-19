"""Nature Ledger (dev-spec §17, stories F1–F2): hashing, verification, append and API."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date
from decimal import Decimal

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session

from app.config import Settings, get_settings
from app.db import get_session
from app.deps import current_world
from app.ledger import (
    GENESIS_HASH,
    ChainEntry,
    append,
    canonical,
    entries_for,
    entry_hash,
    tamper,
    verify,
)
from app.main import app
from app.models import Asset, LedgerKind, World
from app.seed import WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import start_demo

# --- Hashing --------------------------------------------------------------------------------


def test_canonical_json_sorts_keys_and_drops_whitespace() -> None:
    assert canonical({"b": 1, "a": [1, 2]}) == b'{"a":[1,2],"b":1}'


def test_canonical_json_is_independent_of_key_order() -> None:
    assert canonical({"x": 1, "y": {"q": 2, "p": 3}}) == canonical({"y": {"p": 3, "q": 2}, "x": 1})


def test_canonical_json_writes_decimals_uuids_and_dates_as_strings() -> None:
    asset = uuid.UUID("22222222-2222-2222-2222-222222222222")
    payload = {"price": Decimal("7.9200"), "asset": asset, "day": date(2026, 10, 5)}

    assert canonical(payload) == (
        b'{"asset":"22222222-2222-2222-2222-222222222222","day":"2026-10-05","price":"7.9200"}'
    )


def test_canonical_json_rejects_nan() -> None:
    with pytest.raises(ValueError):
        canonical({"score": float("nan")})


def test_entry_hash_matches_the_spec_formula() -> None:
    import hashlib

    expected = hashlib.sha256(b'{"a":1}' + b"listing" + b"0" + GENESIS_HASH.encode()).hexdigest()

    assert entry_hash({"a": 1}, LedgerKind.LISTING, 0, GENESIS_HASH) == expected


def test_entry_hash_changes_with_every_input() -> None:
    base = entry_hash({"a": 1}, LedgerKind.REPORT, 3, "f" * 64)

    assert entry_hash({"a": 2}, LedgerKind.REPORT, 3, "f" * 64) != base
    assert entry_hash({"a": 1}, LedgerKind.EVENT, 3, "f" * 64) != base
    assert entry_hash({"a": 1}, LedgerKind.REPORT, 4, "f" * 64) != base
    assert entry_hash({"a": 1}, LedgerKind.REPORT, 3, "e" * 64) != base


# --- Verification ---------------------------------------------------------------------------


def chain(*payloads: dict[str, object]) -> list[ChainEntry]:
    entries: list[ChainEntry] = []
    prev = GENESIS_HASH
    for seq, payload in enumerate(payloads):
        kind = LedgerKind.LISTING if seq == 0 else LedgerKind.REPORT
        digest = entry_hash(payload, kind, seq, prev)
        entries.append(ChainEntry(seq, kind, payload, prev, digest))
        prev = digest
    return entries


def test_empty_chain_is_valid() -> None:
    result = verify([])

    assert result.valid
    assert result.entries == 0
    assert result.head == GENESIS_HASH
    assert result.broken_at is None


def test_intact_chain_is_valid_and_reports_its_head() -> None:
    entries = chain({"area_ha": "500.00"}, {"health": 72}, {"health": 75})

    result = verify(entries)

    assert result.valid
    assert result.entries == 3
    assert result.head == entries[-1].hash


def test_edited_payload_breaks_the_chain_at_that_entry() -> None:
    entries = chain({"area_ha": "500.00"}, {"health": 72}, {"health": 75})
    entries[1] = replace(entries[1], payload={"health": 95})

    result = verify(entries)

    assert not result.valid
    assert result.broken_at == 1
    assert result.head is None


def test_removed_entry_breaks_the_chain() -> None:
    entries = chain({"a": 1}, {"a": 2}, {"a": 3})
    del entries[1]

    assert verify(entries).broken_at == 1


def test_rehashed_entry_still_breaks_the_link_to_the_next_one() -> None:
    entries = chain({"a": 1}, {"a": 2}, {"a": 3})
    forged = {"a": 99}
    entries[1] = replace(
        entries[1],
        payload=forged,
        hash=entry_hash(forged, entries[1].kind, 1, entries[1].prev_hash),
    )

    assert verify(entries).broken_at == 2


def test_out_of_order_sequence_is_invalid() -> None:
    entries = chain({"a": 1}, {"a": 2})

    assert verify(list(reversed(entries))).broken_at == 0


# --- Tamper demo ----------------------------------------------------------------------------


def test_tamper_changes_the_first_number_in_a_copy() -> None:
    entries = chain({"area_ha": "500.00"}, {"grade": "AA", "health": 72})

    result = tamper(entries, seq=1)

    assert result.field == "health"
    assert result.before == 72
    assert result.after == 720
    assert result.entries[1].payload == {"grade": "AA", "health": 720}
    assert entries[1].payload == {"grade": "AA", "health": 72}, "original must be untouched"
    assert verify(result.entries).broken_at == 1


def test_tamper_handles_numeric_strings() -> None:
    result = tamper(chain({"area_ha": "500.00"}), seq=0)

    assert (result.field, result.before, result.after) == ("area_ha", "500.00", "5000.00")


def test_tamper_marks_payloads_without_numbers() -> None:
    result = tamper(chain({"title": "Fire nearby"}), seq=0)

    assert result.field == "tampered"
    assert result.entries[0].payload == {"title": "Fire nearby", "tampered": True}


def test_tamper_rejects_an_unknown_seq() -> None:
    with pytest.raises(LookupError):
        tamper(chain({"a": 1}), seq=5)


# --- Database: append -----------------------------------------------------------------------

# A bare asset with an empty chain: seeded demo assets already hold their report v1 entry (T19).
ASSET_ID = uuid.UUID("33333333-3333-3333-3333-3333333333ff")


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so append-only rows never persist."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        db.add(
            Asset(
                id=ASSET_ID,
                world_id=WORLD_ID,
                name="Ledger test parcel",
                geojson={"type": "Polygon", "coordinates": []},
                area_ha=Decimal("500.00"),
                primary_shares_remaining=490_000,
            )
        )
        db.commit()
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@requires_db
def test_append_links_entries_in_sequence(session: Session) -> None:
    first = append(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        kind=LedgerKind.LISTING,
        payload={"area_ha": Decimal("500.00")},
    )
    second = append(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        kind=LedgerKind.REPORT,
        payload={"health": 72, "grade": "AA"},
        ref_id=uuid.UUID("33333333-3333-3333-3333-333333333333"),
    )

    assert (first.seq, first.prev_hash) == (0, GENESIS_HASH)
    assert (second.seq, second.prev_hash) == (1, first.hash)
    assert first.payload == {"area_ha": "500.00"}, "payload is stored exactly as it was hashed"


@requires_db
def test_appended_chain_verifies_after_a_round_trip_through_postgres(session: Session) -> None:
    payloads = [
        {"area_ha": Decimal("500.00"), "name": "Wetland"},
        {"health": 72.5, "values": {"carbon": "12000.00", "water": "8000.00"}},
        {"price": Decimal("7.9200"), "reason": "ipo"},
    ]
    for kind, payload in zip(
        (LedgerKind.LISTING, LedgerKind.REPORT, LedgerKind.PRICE_ANCHOR), payloads, strict=True
    ):
        append(session, world_id=WORLD_ID, asset_id=ASSET_ID, kind=kind, payload=payload)
    session.commit()
    session.expire_all()

    result = verify(entries_for(session, ASSET_ID))

    assert result.valid
    assert result.entries == 3


@requires_db
def test_append_belongs_to_the_callers_transaction(session: Session) -> None:
    savepoint = session.begin_nested()
    append(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        kind=LedgerKind.EVENT,
        payload={"impact_type": "fire", "severity": 4},
    )
    savepoint.rollback()

    assert entries_for(session, ASSET_ID) == []


@requires_db
def test_append_rejects_an_unknown_asset(session: Session) -> None:
    with pytest.raises(LookupError):
        append(
            session,
            world_id=WORLD_ID,
            asset_id=uuid.uuid4(),
            kind=LedgerKind.LISTING,
            payload={"area_ha": "1"},
        )


# --- API ------------------------------------------------------------------------------------


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    """These tests use the seeded template assets, so the visitor's world is the template."""
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[current_world] = lambda: session.get(World, WORLD_ID)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _fill(session: Session, world_id: uuid.UUID = WORLD_ID, asset_id: uuid.UUID = ASSET_ID) -> None:
    append(
        session,
        world_id=world_id,
        asset_id=asset_id,
        kind=LedgerKind.LISTING,
        payload={"area_ha": "500.00"},
    )
    append(
        session,
        world_id=world_id,
        asset_id=asset_id,
        kind=LedgerKind.REPORT,
        payload={"grade": "AA", "health": 72},
    )
    session.flush()


@requires_db
def test_get_ledger_lists_entries_in_order(session: Session, client: TestClient) -> None:
    _fill(session)

    response = client.get(f"/ledger/{ASSET_ID}")

    assert response.status_code == 200
    body = response.json()
    assert [(e["seq"], e["kind"]) for e in body] == [(0, "listing"), (1, "report")]
    assert body[1]["prev_hash"] == body[0]["hash"]
    assert body[1]["payload"] == {"grade": "AA", "health": 72}


@requires_db
def test_verify_endpoint_reports_a_valid_chain(session: Session, client: TestClient) -> None:
    _fill(session)

    response = client.get(f"/ledger/{ASSET_ID}/verify")

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["entries"] == 2
    assert body["broken_at"] is None
    assert len(body["head"]) == 64


@requires_db
def test_ledger_endpoints_404_for_an_unknown_asset(client: TestClient) -> None:
    missing = uuid.uuid4()

    assert client.get(f"/ledger/{missing}").status_code == 404
    assert client.get(f"/ledger/{missing}/verify").status_code == 404


@pytest.fixture
def sandbox_asset(session: Session, client: TestClient) -> uuid.UUID:
    """A bare asset in a demo sandbox, with the client signed in to it: the tamper demo runs
    only in sandboxes (T73)."""
    app.dependency_overrides.pop(current_world, None)
    world = start_demo(client, session)
    asset = Asset(
        world_id=world.id,
        name="Sandbox ledger parcel",
        geojson={"type": "Polygon", "coordinates": []},
        area_ha=Decimal("500.00"),
        primary_shares_remaining=490_000,
    )
    session.add(asset)
    session.commit()
    return asset.id


@requires_db
def test_tamper_demo_breaks_verification_without_writing(
    session: Session, client: TestClient, sandbox_asset: uuid.UUID
) -> None:
    _fill(session, session.get_one(Asset, sandbox_asset).world_id, sandbox_asset)

    response = client.post("/admin/tamper-demo", json={"asset_id": str(sandbox_asset), "seq": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["seq"] == 1
    assert (body["field"], body["before"], body["after"]) == ("health", 72, 720)
    assert body["verify"] == {"valid": False, "entries": 2, "head": None, "broken_at": 1}
    assert client.get(f"/ledger/{sandbox_asset}/verify").json()["valid"] is True


@requires_db
def test_tamper_demo_defaults_to_the_latest_entry(
    session: Session, client: TestClient, sandbox_asset: uuid.UUID
) -> None:
    _fill(session, session.get_one(Asset, sandbox_asset).world_id, sandbox_asset)

    response = client.post("/admin/tamper-demo", json={"asset_id": str(sandbox_asset)})

    assert response.json()["seq"] == 1


@requires_db
def test_tamper_demo_needs_entries(client: TestClient, sandbox_asset: uuid.UUID) -> None:
    response = client.post("/admin/tamper-demo", json={"asset_id": str(sandbox_asset)})

    assert response.status_code == 409


@requires_db
def test_tamper_demo_never_runs_outside_a_sandbox(session: Session, client: TestClient) -> None:
    _fill(session)

    response = client.post("/admin/tamper-demo", json={"asset_id": str(ASSET_ID)})

    assert (response.status_code, response.json()["detail"]) == (403, "sandbox_only")


def test_tamper_demo_is_hidden_outside_demo_mode() -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(demo_mode=False)
    app.dependency_overrides[current_world] = lambda: World(label="visitor")
    try:
        response = TestClient(app).post("/admin/tamper-demo", json={"asset_id": str(uuid.uuid4())})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 404

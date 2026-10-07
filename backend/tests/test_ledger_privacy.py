"""Ledger privacy (ADR-0005 §6, T67): the public ledger never holds account identifiers.

Two layers: `append` rejects denied keys and email-shaped strings (cheap, generic), and the scan
below builds one entry of every `LedgerKind` and checks it against the real accounts in the DB.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest
from alembic import command
from sqlalchemy import create_engine
from sqlmodel import Session, col, select

from app.config import get_settings
from app.ledger import LedgerPrivacyError, append, canonical, check_public_payload, entries_for
from app.market.revenue import pay_quarter
from app.models import (
    Asset,
    Event,
    EventSource,
    Holding,
    LedgerEntry,
    LedgerKind,
    Price,
    User,
    UserKind,
    UserRole,
)
from app.seed import DEMO_SITES, PERSONAS, WORLD_ID, seed
from tests.conftest import alembic_cfg, requires_db

ASSET_ID = DEMO_SITES[0].id

# --- The append guard -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {"user_id": "x"},
        {"User_ID": "x"},
        {"holder_payouts": [{"shares": 1}]},
        {"lines": [{"holder_id": "x"}]},
        {"outer": {"email": "x"}},
        {"buyer_user_id": "x"},
        {"contact_email": "x"},
        {"password_hash": "x"},
        {"display_name": "Ada"},
        {"title": "Write to ada.lovelace+news@example.org for details"},
        {"items": ["fine", {"note": "ADA@EXAMPLE.ORG"}]},
    ],
)
def test_guard_rejects_account_keys_and_emails_at_any_depth(payload: dict[str, Any]) -> None:
    with pytest.raises(LedgerPrivacyError):
        check_public_payload(payload)


def test_guard_allows_public_business_values() -> None:
    check_public_payload(
        {
            "name": "Xochimilco Wetland",
            "holder_count": 3,
            "dividends_total": "250.00",
            "url": "https://medium.com/@reporter/fire-near-the-wetland-1.html",
            "summary_sha256": "ab" * 32,
            "value_breakdown": {"regulating": 100, "cultural": 5},
            "flags": ["simulated"],
        }
    )


# --- Database --------------------------------------------------------------------------------


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so append-only rows never persist."""
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


@requires_db
def test_append_rejects_a_private_payload_and_writes_nothing(session: Session) -> None:
    with pytest.raises(LedgerPrivacyError, match="user_id"):
        append(
            session,
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            kind=LedgerKind.EVENT,
            payload={"impact_type": "fire", "reported_by": {"user_id": str(PERSONAS[1].id)}},
        )

    assert entries_for(session, ASSET_ID) == []


def _add_person_holder(session: Session) -> User:
    """A real password account (ADR-0005), so the scan covers emails and person names."""
    person = User(
        world_id=WORLD_ID,
        name="Ada Lovelace",
        role=UserRole.INVESTOR,
        kind=UserKind.PERSON,
        email="ada.lovelace@example.org",
        password_hash="$argon2id$not-a-real-hash",
    )
    session.add(person)
    session.flush()
    asset = session.get_one(Asset, ASSET_ID)
    for user_id, shares in ((person.id, 100_000), (PERSONAS[1].id, 50_000)):
        asset.primary_shares_remaining -= shares
        session.add(Holding(world_id=WORLD_ID, user_id=user_id, asset_id=ASSET_ID, shares=shares))
    session.flush()
    return person


def _spec_payload(session: Session, kind: LedgerKind) -> dict[str, Any]:
    """dev-spec §17's payload for a kind with no producer on this branch yet, built from rows.

    Each producer that lands (T19 reports, T58 listings, T27 events, T59 IPOs…) writes real
    entries, which the scan then covers instead of these.
    """
    asset = session.get_one(Asset, ASSET_ID)
    if kind is LedgerKind.LISTING:
        return {
            "name": asset.name,
            "country": asset.country,
            "area_ha": asset.area_ha,
            "geojson": asset.geojson,
            "total_shares": asset.total_shares,
            "retained_pct": asset.retained_pct,
        }
    if kind is LedgerKind.REPORT:
        return {
            "version": 1,
            "health_score": "72.50",
            "grade": "A",
            "value_mid": "1000000.00",
            "fair_value_per_share": "7.9200",
            "summary_sha256": hashlib.sha256(b"summary").hexdigest(),
        }
    if kind is LedgerKind.EVENT:
        event = Event(
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            source=EventSource.ADMIN,
            title="Fire near the wetland",
            url="https://example.org/news/fire",
            impact_type="fire",
            direction=-1,
            severity=4,
        )
        session.add(event)
        session.flush()
        return {
            "title": event.title,
            "url": event.url,
            "impact_type": event.impact_type,
            "direction": event.direction,
            "severity": event.severity,
            "source": event.source,
        }
    if kind is LedgerKind.PRICE_ANCHOR:
        price = session.exec(
            select(Price).where(Price.world_id == WORLD_ID, Price.asset_id == ASSET_ID)
        ).first()
        return {"price": price.price if price else Decimal("7.9200"), "reason": "ipo"}
    raise AssertionError(f"{kind} has a real producer and needs no spec payload")


# Keys that suggest a person or an account. `holder_count` is an aggregate, and a listing's
# `name` (also in its GeoJSON properties) is the public site name, not a person's.
_SUSPECT_KEY = re.compile(
    r"email|(^|_)(user|users|holder|holders|person|persona|owner|member|members|account"
    r"|name|names)(_|$)",
    re.IGNORECASE,
)
_ALLOWED_KEYS = {
    (None, "$.holder_count"),
    (LedgerKind.LISTING, "$.name"),
    (LedgerKind.LISTING, "$.geojson.properties.name"),
}


def _leaks(
    kind: LedgerKind, payload: Any, identifiers: set[str], names: set[str], path: str = "$"
) -> list[str]:
    found: list[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            here = f"{path}.{key}"
            allowed = (None, here) in _ALLOWED_KEYS or (kind, here) in _ALLOWED_KEYS
            if _SUSPECT_KEY.search(key) and not allowed:
                found.append(f"{kind}: key {here}")
            found += _leaks(kind, value, identifiers, names, here)
    elif isinstance(payload, list):
        for index, value in enumerate(payload):
            found += _leaks(kind, value, identifiers, names, f"{path}[{index}]")
    elif isinstance(payload, str):
        lowered = payload.lower()
        found += [f"{kind}: {path} holds {i}" for i in identifiers if i in lowered]
        found += [
            f"{kind}: {path} holds the name {n!r}"
            for n in names
            if re.search(rf"\b{re.escape(n)}\b", payload)
        ]
    return found


@requires_db
def test_no_ledger_payload_of_any_kind_holds_an_account_identifier(session: Session) -> None:
    _add_person_holder(session)
    pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=Decimal("100000.00"),
        quarter_label="2026-Q4",
    )
    session.flush()
    in_world = select(LedgerEntry).where(LedgerEntry.world_id == WORLD_ID)
    produced = {e.kind for e in session.exec(in_world).all()}
    for kind in LedgerKind:
        if kind not in produced:
            append(
                session,
                world_id=WORLD_ID,
                asset_id=ASSET_ID,
                kind=kind,
                payload=_spec_payload(session, kind),
            )
    session.flush()

    users = session.exec(select(User)).all()
    identifiers = {str(u.id).lower() for u in users} | {
        u.email.lower() for u in users if u.email is not None
    }
    names = {u.name for u in users} | {p.name for p in PERSONAS}
    entries = session.exec(in_world.order_by(col(LedgerEntry.asset_id), col(LedgerEntry.seq))).all()

    assert {e.kind for e in entries} == set(LedgerKind), "every payload kind is scanned"
    assert LedgerKind.PAYOUT in produced, "payouts come from the real pay_quarter path"
    leaks = [leak for e in entries for leak in _leaks(e.kind, e.payload, identifiers, names)]
    assert leaks == []
    for entry in entries:
        text = canonical(entry.payload).decode().lower()
        assert not [i for i in identifiers if i in text], entry.kind


def test_scan_flags_the_pre_t67_payout_payload() -> None:
    arjun = str(PERSONAS[1].id)
    payload = {"holder_count": 1, "holder_payouts": [{"user_id": arjun, "note": "paid Arjun"}]}

    leaks = _leaks(LedgerKind.PAYOUT, payload, {arjun}, {"Arjun"})

    assert leaks == [
        "payout: key $.holder_payouts",
        "payout: key $.holder_payouts[0].user_id",
        f"payout: $.holder_payouts[0].user_id holds {arjun}",
        "payout: $.holder_payouts[0].note holds the name 'Arjun'",
    ]

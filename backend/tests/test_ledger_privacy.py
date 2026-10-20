"""Ledger privacy (ADR-0005 §6, T67): the public ledger never holds account identifiers.

Two layers. `append` rejects denied keys, email addresses and user-ID `ref_id`s (cheap,
generic). The scan finds every `ledger.append` call in `app/`, runs the real producer for each
kind that has one, and checks every entry against the real accounts in the DB. Only kinds with
no producer in `app/` yet fall back to a hand-built payload following dev-spec §17.
"""

from __future__ import annotations

import ast
import hashlib
import re
from collections.abc import Callable, Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from alembic import command
from sqlalchemy import create_engine
from sqlmodel import Session, col, select

import app
from app.communities import create_community
from app.config import get_settings
from app.ledger import LedgerPrivacyError, append, canonical, check_public_payload, entries_for
from app.market.offering import Offering
from app.market.revenue import pay_quarter
from app.models import (
    Asset,
    AssetStatus,
    Community,
    DocumentType,
    Event,
    EventSource,
    Holding,
    LedgerEntry,
    LedgerKind,
    Report,
    User,
    UserKind,
    UserRole,
)
from app.seed import DEMO_SITES, PERSONAS, WORLD_ID, seed
from app.services import verification
from app.services.ipo import launch, preview
from app.services.lifecycle import SuspensionReason
from app.services.listings import (
    ListingDetails,
    ListingSubmit,
    create_draft,
    resume,
    revise,
    suspend,
    update_draft,
    withdraw,
)
from app.tools.documents import Inspection
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
        {"url": "https://ada%40example.org@news.example.org/fire"},
        {"url": "https://reader:secret@news.example.org/fire"},
        {"url": "https://news.example.org/fire?contact=ada%40example.org&page=2"},
        {"url": "https://news.example.org/fire?contact=ada@example.org"},
        {"url": "https://news.example.org/fire#reply-to:ada.lovelace@example.org"},
        {"title": "Story at https://news.example.org/fire, tips: (ada@example.org)"},
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
            "cover_image_url": "https://cdn.example.org/img/cover@2x.png",
            "photos": [
                "https://cdn.example.org/img/fire@3x.jpg?w=1",
                "HTTPS://cdn.example.org/img/smoke@2x.webp#top",
            ],
            "title": "Fire photographed (https://cdn.example.org/img/fire@3x.jpg?w=1) at dawn",
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
    before = entries_for(session, ASSET_ID)  # the seed's report v1 (T19)
    with pytest.raises(LedgerPrivacyError, match="user_id"):
        append(
            session,
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            kind=LedgerKind.EVENT,
            payload={"impact_type": "fire", "reported_by": {"user_id": str(PERSONAS[1].id)}},
        )

    assert entries_for(session, ASSET_ID) == before


@requires_db
def test_append_rejects_a_user_id_as_ref_id(session: Session) -> None:
    before = entries_for(session, ASSET_ID)  # the seed's report v1 (T19)
    with pytest.raises(LedgerPrivacyError, match="ref_id"):
        append(
            session,
            world_id=WORLD_ID,
            asset_id=ASSET_ID,
            kind=LedgerKind.EVENT,
            payload={"impact_type": "fire"},
            ref_id=PERSONAS[1].id,
        )

    assert entries_for(session, ASSET_ID) == before


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


def _ledger_append_kind(node: ast.Call) -> str | None:
    """`LedgerKind.X` → "X" for a call to the ledger's `append`, "?" if the kind isn't a
    literal, None if the call isn't a ledger append (e.g. `list.append`)."""
    func = node.func
    is_ledger_append = (isinstance(func, ast.Name) and func.id == "append") or (
        isinstance(func, ast.Attribute)
        and func.attr == "append"
        and isinstance(func.value, ast.Name)
        and func.value.id == "ledger"
    )
    kind = next((kw.value for kw in node.keywords if kw.arg == "kind"), None)
    if not is_ledger_append or kind is None:
        return None
    if (
        isinstance(kind, ast.Attribute)
        and isinstance(kind.value, ast.Name)
        and kind.value.id == "LedgerKind"
    ):
        return kind.attr
    return "?"


def _ledger_producers() -> dict[LedgerKind | None, list[str]]:
    """Every `ledger.append(…, kind=LedgerKind.X)` call in `app/`, by kind (None: not literal)."""
    root = Path(app.__file__).parent
    found: dict[LedgerKind | None, list[str]] = {}
    for path in sorted(root.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), str(path))):
            if isinstance(node, ast.Call) and (name := _ledger_append_kind(node)) is not None:
                kind = None if name == "?" else LedgerKind[name]
                found.setdefault(kind, []).append(f"{path.relative_to(root)}:{node.lineno}")
    return found


def _produce_listing(session: Session) -> None:
    """A draft whose description and GeoJSON properties name a person, edited, submitted,
    revised, resubmitted and withdrawn, plus a suspend and resume of a curated asset: every
    `listing` transition the API writes but `rated` (covered by test_lifecycle's scan)."""
    community_id = session.exec(
        select(Community.id).where(Community.world_id == WORLD_ID).order_by(col(Community.name))
    ).first()
    assert community_id is not None
    ring = [[-84.1, 9.9], [-84.09, 9.9], [-84.09, 9.91], [-84.1, 9.91], [-84.1, 9.9]]
    feature = {
        "type": "Feature",
        "properties": {"steward": "Ada Lovelace", "contact": "ada.lovelace@example.org"},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    details = ListingDetails(
        name="Bosque Vivo", country="CR", description="Kept by Ada Lovelace.", geojson=feature
    )
    draft = create_draft(session, world_id=WORLD_ID, community_id=community_id, details=details)
    update_draft(session, WORLD_ID, draft.id, {"description": "Ada Lovelace's family land."})
    submit = ListingSubmit(metrics_version=None)
    submit.lock(session, WORLD_ID, draft.id)
    submit(session, draft, uuid4())
    revise(session, WORLD_ID, draft.id, run_active=lambda *_: False)
    withdraw(session, WORLD_ID, draft.id, run_active=lambda *_: False)
    suspend(session, WORLD_ID, ASSET_ID, SuspensionReason.MODERATION)
    resume(session, WORLD_ID, ASSET_ID)


def _produce_payout(session: Session) -> None:
    pay_quarter(
        session,
        world_id=WORLD_ID,
        asset_id=ASSET_ID,
        value_mid=Decimal("100000.00"),
        quarter_label="2026-Q4",
    )


def _produce_price_anchor(session: Session) -> None:
    """An owner's IPO (T59) of a listed listing whose community and description name a person."""
    community = create_community(session, WORLD_ID, "Ada Lovelace's Keepers", PERSONAS[0].id)
    ring = [[-84.3, 9.7], [-84.29, 9.7], [-84.29, 9.71], [-84.3, 9.71], [-84.3, 9.7]]
    details = ListingDetails(
        name="Bosque de Ada",
        country="CR",
        description="Kept by Ada Lovelace.",
        geojson={"type": "Polygon", "coordinates": [ring]},
    )
    listing = create_draft(session, world_id=WORLD_ID, community_id=community.id, details=details)
    curated = session.exec(
        select(Report).where(Report.world_id == WORLD_ID, Report.asset_id == ASSET_ID)
    ).first()
    assert curated is not None
    session.add(
        Report(
            world_id=WORLD_ID,
            asset_id=listing.id,
            version=1,
            health_score=curated.health_score,
            grade=curated.grade,
            confidence=curated.confidence,
            value_mid=curated.value_mid,
        )
    )
    listing.status = AssetStatus.LISTED
    session.add(listing)
    session.flush()
    price = preview(session, WORLD_ID, listing.id, Offering()).terms.price
    launch(session, WORLD_ID, listing.id, Offering(), expected_price=price)


def _produce_verification(session: Session) -> None:
    """T69's decisions on a listing whose community, documents and reasons name people: a
    rejection, then an approval and a revocation (`verification` entries)."""
    community = create_community(session, WORLD_ID, "Ada Lovelace's Verifiers", PERSONAS[0].id)
    reviewer = User(
        world_id=WORLD_ID,
        name="Grace Hopper",
        role=UserRole.ADMIN,
        kind=UserKind.PERSON,
        email="grace.hopper@example.org",
        is_admin=True,
    )
    session.add(reviewer)
    session.flush()
    ring = [[-84.5, 9.5], [-84.49, 9.5], [-84.49, 9.51], [-84.5, 9.51], [-84.5, 9.5]]
    details = ListingDetails(
        name="Bosque de Grace",
        country="CR",
        description="Title held by Ada Lovelace.",
        geojson={"type": "Polygon", "coordinates": [ring]},
    )
    listing = create_draft(session, world_id=WORLD_ID, community_id=community.id, details=details)
    for step in ("reject", "approve"):
        document = verification.store_document(
            session,
            world_id=WORLD_ID,
            asset_id=listing.id,
            uploaded_by=PERSONAS[0].id,
            doc_type=DocumentType.ASSEMBLY_MINUTES,
            data=f"Assembly minutes signed by Ada Lovelace ({step})".encode(),
            inspection=Inspection("application/pdf", page_count=1),
            secret="ledger-privacy-test",
            quota=verification.StorageQuota(10**9, 10**9),
        )
        run = verification.submit_run(
            session,
            world_id=WORLD_ID,
            asset_id=listing.id,
            submitted_by=PERSONAS[0].id,
            document_ids=[document.id],
        ).run
        ids = {"world_id": WORLD_ID, "asset_id": listing.id, "run_id": run.id}
        if step == "reject":
            verification.reject(
                session, **ids, reviewer=reviewer.id, reason="Ada Lovelace's scan is unreadable"
            )
        else:
            verification.approve(session, **ids, reviewer=reviewer.id, reason="Grace checked it")
            verification.revoke(
                session, **ids, revoked_by=reviewer.id, reason="Grace Hopper found a dispute"
            )


# The real producer to run for each kind with one in `app/`. Kinds whose producer already ran
# during `seed()` (e.g. T19's reports) are covered by the seeded entries instead.
_REAL_PRODUCERS: dict[LedgerKind, Callable[[Session], None]] = {
    LedgerKind.PAYOUT: _produce_payout,
    LedgerKind.LISTING: _produce_listing,
    LedgerKind.PRICE_ANCHOR: _produce_price_anchor,
    LedgerKind.VERIFICATION: _produce_verification,
}


def test_producer_discovery_finds_the_payout_producer() -> None:
    producers = _ledger_producers()

    assert None not in producers, f"ledger appends with a non-literal kind: {producers.get(None)}"
    assert any(site.startswith("market/revenue.py:") for site in producers[LedgerKind.PAYOUT])


def _spec_payload(session: Session, kind: LedgerKind) -> dict[str, Any]:
    """dev-spec §17's payload for a kind with no producer in `app/` yet, built from DB rows.

    Raises once a producer exists, so a stand-in can never hide what the real code writes.
    """
    sites = _ledger_producers().get(kind)
    if sites:
        raise AssertionError(f"{kind} has a real producer ({', '.join(sites)}); scan that")
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
    raise AssertionError(f"no spec payload for {kind}")


# Keys that suggest a person or an account. `holder_count` is an aggregate, and a listing's
# `name` is the public site name, not a person's (its GeoJSON properties are dropped; T58).
_SUSPECT_KEY = re.compile(
    r"email|(^|_)(user|users|holder|holders|person|persona|owner|member|members|account"
    r"|name|names)(_|$)",
    re.IGNORECASE,
)
_ALLOWED_KEYS = {
    (None, "$.holder_count"),
    (LedgerKind.LISTING, "$.name"),
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
def test_a_kind_with_a_real_producer_gets_no_stand_in_payload(session: Session) -> None:
    with pytest.raises(AssertionError, match="real producer"):
        _spec_payload(session, LedgerKind.PAYOUT)


@requires_db
def test_no_ledger_payload_of_any_kind_holds_an_account_identifier(session: Session) -> None:
    producers = _ledger_producers()
    assert None not in producers, f"ledger appends with a non-literal kind: {producers.get(None)}"
    _add_person_holder(session)
    in_world = select(LedgerEntry).where(LedgerEntry.world_id == WORLD_ID)
    seeded = {e.kind for e in session.exec(in_world).all()}
    for kind, sites in producers.items():
        assert kind is not None
        if kind in _REAL_PRODUCERS:
            _REAL_PRODUCERS[kind](session)
        else:
            assert kind in seeded, f"run {kind}'s producer ({', '.join(sites)}) in the scan"
    session.flush()
    for kind in LedgerKind:
        if kind not in producers:
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
    leaks = [leak for e in entries for leak in _leaks(e.kind, e.payload, identifiers, names)]
    assert leaks == []
    for entry in entries:
        public = (canonical(entry.payload).decode() + str(entry.ref_id)).lower()
        assert not [i for i in identifiers if i in public], entry.kind


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

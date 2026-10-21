"""Listing verification (T69, ADR-0006 review mode). Hostile files themselves are in
`test_documents.py`; here they go through the upload route.

- Private documents: who may upload, list, download and preview them (404 for everyone else,
  other worlds included), and the download headers.
- A document is bound to one listing; the same listing may reuse it.
- Write-once runs (DB triggers), the checklist, approve / reject, conflict of interest, the
  review queue, stale fingerprints, revoke during trading, the live-world IPO gate, sandbox
  reset and the public panel. Ledger payload privacy is also scanned in
  `test_ledger_privacy.py`.
"""

from __future__ import annotations

import hashlib
import io
import re
import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import Connection, text, update
from sqlalchemy import event as sa_event
from sqlalchemy.exc import DBAPIError
from sqlmodel import Session, col, select

from app.auth import SESSION_COOKIE, start_session
from app.communities import create_community
from app.config import Settings, document_fingerprint_secret, get_settings
from app.db import get_session
from app.main import app
from app.models import (
    Asset,
    AssetStatus,
    DocumentFingerprint,
    DocumentType,
    LedgerEntry,
    LedgerKind,
    ListingDocument,
    ListingDocumentBlob,
    SessionKind,
    User,
    UserRole,
    VerificationLevel,
    VerificationRun,
    VerificationRunDocument,
)
from app.routers import verification as verification_routes
from app.routers.runs import get_rating_runner
from app.sandbox import (
    _copy_world_rows,
    _world_col,
    create_world,
    ensure_live_world,
    reset_world,
)
from app.seed import seed
from app.services import verification
from app.services.document_check import get_document_checker
from app.tools import documents as docs
from app.tools.verification import (
    NOT_CHECKED,
    ListingFacts,
    commitment_of,
    input_fingerprint,
    private_fingerprint,
    reason_commitment,
    world_document_key,
)
from app.worlds import LIVE_WORLD_ID
from tests import test_lifecycle as lifecycle
from tests.conftest import alembic_cfg, requires_db
from tests.test_documents import bomb_png, encrypted_pdf, javascript_pdf, pdf, png
from tests.test_lifecycle import (
    Committed,
    Deferred,
    World_,
    _checker,
    _committed_draft,
    _member,
    _person,
    _runner,
    _sessions,
    _settings,
    body,
    square,
    status_of,
)

conn = lifecycle.conn
world = lifecycle.world

# ----- fingerprints and commitments (pure) ------------------------------------------------------


def _facts(**changes: Any) -> ListingFacts:
    fields: dict[str, Any] = {
        "community_id": UUID(int=7),
        "name": "Bosque Vivo",
        "geojson": square(1_200),
        "area_ha": Decimal("144.00"),
        **changes,
    }
    return ListingFacts(**fields)


def test_the_input_fingerprint_covers_exactly_the_verified_inputs() -> None:
    documents = [(DocumentType.TITLE, "a" * 64), (DocumentType.ASSEMBLY_MINUTES, "b" * 64)]
    base = input_fingerprint(_facts(), documents)

    assert input_fingerprint(_facts(), list(reversed(documents))) == base, "order-free"
    assert input_fingerprint(_facts(area_ha=Decimal("144")), documents) == base
    for changed in (
        _facts(name="Bosque Viejo"),
        _facts(community_id=UUID(int=8)),
        _facts(geojson=square(1_300)),
        _facts(area_ha=Decimal("150.00")),
    ):
        assert input_fingerprint(changed, documents) != base
    assert input_fingerprint(_facts(), documents[:1]) != base
    assert input_fingerprint(_facts(), [(DocumentType.OTHER, "a" * 64), documents[1]]) != base
    assert input_fingerprint(_facts(), documents, method_version="v0") != base


def test_private_fingerprints_are_keyed_per_world_and_commitments_are_randomised() -> None:
    data = png()
    one, two = world_document_key("k", UUID(int=1)), world_document_key("k", UUID(int=2))

    assert private_fingerprint(one, data) == private_fingerprint(one, data)
    assert private_fingerprint(one, data) != private_fingerprint(two, data)
    assert private_fingerprint(one, data) != hashlib.sha256(data).hexdigest()
    assert commitment_of(b"\x01" * 32, data) != commitment_of(b"\x02" * 32, data)


def test_production_needs_a_document_fingerprint_secret() -> None:
    with pytest.raises(RuntimeError, match="DOCUMENT_FINGERPRINT_SECRET"):
        document_fingerprint_secret(Settings(_env_file=None, environment="production"))  # type: ignore[call-arg]
    deployed = Settings(_env_file=None, environment="production", document_fingerprint_secret="s")  # type: ignore[call-arg]
    assert document_fingerprint_secret(deployed) == "s"


# ----- API helpers ------------------------------------------------------------------------------


def client_for(w: World_, user: User | None) -> TestClient:
    """Signed in as `user` with the session kind its world allows (T73): demo in sandboxes,
    password in the live world."""
    client = TestClient(app)
    if user is not None:
        kind = SessionKind.PASSWORD if user.world_id == LIVE_WORLD_ID else SessionKind.DEMO
        client.cookies.set(SESSION_COOKIE, start_session(w.session, user, kind))
    return client


def draft(w: World_, user: User | None = None, **overrides: Any) -> dict[str, Any]:
    response = client_for(w, user or w.steward).post("/assets", json=body(w, **overrides))
    assert response.status_code == 201, response.text
    return dict(response.json())


def upload(
    w: World_,
    asset_id: str | UUID,
    data: bytes,
    *,
    media: str = "image/png",
    doc_type: str = "title",
    user: User | None = None,
) -> Any:
    return client_for(w, user or w.steward).post(
        f"/assets/{asset_id}/documents",
        params={"doc_type": doc_type},
        content=data,
        headers={"Content-Type": media},
    )


def uploaded(w: World_, asset_id: str | UUID, data: bytes, **kw: Any) -> str:
    response = upload(w, asset_id, data, **kw)
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def submit_run(w: World_, asset_id: str | UUID, ids: list[str], user: User | None = None) -> Any:
    return client_for(w, user or w.steward).post(
        f"/assets/{asset_id}/verification/runs", json={"document_ids": ids}
    )


def evidence(w: World_, asset_id: str | UUID, seed_byte: int = 1) -> dict[str, Any]:
    """Upload a title and assembly minutes (distinct files per `seed_byte`) and submit them."""
    title = uploaded(w, asset_id, png(600 + seed_byte, 400))
    minutes = uploaded(
        w, asset_id, pdf(1 + seed_byte % 3), media="application/pdf", doc_type="assembly_minutes"
    )
    response = submit_run(w, asset_id, [title, minutes])
    assert response.status_code == 201, response.text
    return dict(response.json())


def decide(
    w: World_, asset_id: str | UUID, run_id: str, step: str, user: User | None = None, **body: Any
) -> Any:
    return client_for(w, user or w.admin).post(
        f"/admin/assets/{asset_id}/verification/{run_id}/{step}", json=body
    )


def verified(w: World_, asset_id: str | UUID, seed_byte: int = 1) -> dict[str, Any]:
    run = evidence(w, asset_id, seed_byte)
    response = decide(w, asset_id, run["id"], "approve")
    assert response.status_code == 200, response.text
    return dict(response.json())


def listed(w: World_, **overrides: Any) -> dict[str, Any]:
    asset = draft(w, **overrides)
    assert client_for(w, w.steward).post(f"/assets/{asset['id']}/submit").status_code == 202
    w.executor.run_all()
    assert status_of(w, asset["id"])[0] is AssetStatus.LISTED
    return asset


def ipo_preview(w: World_, asset_id: str) -> Any:
    return client_for(w, w.owner).get(f"/assets/{asset_id}/ipo/preview")


def launch(w: World_, asset_id: str) -> Any:
    shown = ipo_preview(w, asset_id).json()
    price = shown.get("ipo_price", "1")
    return client_for(w, w.owner).post(f"/assets/{asset_id}/ipo", json={"expected_price": price})


def buy(w: World_, asset_id: str) -> Any:
    return client_for(w, w.outsider).post(
        "/orders", json={"asset_id": asset_id, "side": "buy", "qty": 1}
    )


def ledger(w: World_, asset_id: str | UUID, kind: LedgerKind | None = None) -> list[LedgerEntry]:
    w.session.expire_all()
    query = select(LedgerEntry).where(LedgerEntry.asset_id == UUID(str(asset_id)))
    if kind is not None:
        query = query.where(LedgerEntry.kind == kind)
    return list(w.session.exec(query.order_by(col(LedgerEntry.seq))).all())


def stored(w: World_, asset_id: str | UUID) -> int:
    w.session.expire_all()
    return len(
        w.session.exec(
            select(ListingDocument).where(ListingDocument.asset_id == UUID(str(asset_id)))
        ).all()
    )


# ----- upload and access ------------------------------------------------------------------------


@requires_db
def test_a_steward_uploads_a_document_that_only_the_community_and_admins_read(
    world: World_,
) -> None:
    asset = draft(world)
    data = png(1_000, 800)

    response = upload(world, asset["id"], data)

    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert (body["doc_type"], body["media_type"], body["size_bytes"]) == (
        "title",
        "image/png",
        len(data),
    )
    assert (body["width"], body["height"], body["has_preview"], body["submitted"]) == (
        1_000,
        800,
        True,
        False,
    )
    assert "private_fingerprint" not in body and "nonce" not in str(body)
    url = f"/assets/{asset['id']}/documents/{body['id']}"
    other_world = create_world(world.session)
    stranger = world.session.exec(
        select(User).where(User.world_id == other_world.id, User.persona_key == "rosa")
    ).one()
    expected = {
        "owner": (world.owner, 200),
        "steward": (world.steward, 200),
        "admin": (world.admin, 200),
        "investor": (world.outsider, 404),
        "other community": (world.other_steward, 404),
        "other world's owner": (stranger, 404),
    }
    for who, (user, code) in expected.items():
        client = client_for(world, user)
        for path in (url, f"{url}/preview", f"/assets/{asset['id']}/documents"):
            got = client.get(path)
            assert got.status_code == code, (who, path, got.text)
            if code == 404:
                assert got.json()["detail"] == "not_found"
    assert TestClient(app).get(url).status_code == 401

    download = client_for(world, world.steward).get(url)
    assert download.content == data
    assert download.headers["content-type"] == "image/png"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert download.headers["x-content-type-options"] == "nosniff"
    assert download.headers["cache-control"] == "no-store"
    assert "sandbox" in download.headers["content-security-policy"]
    preview = client_for(world, world.admin).get(f"{url}/preview")
    assert preview.headers["content-type"] == "image/png"
    assert preview.headers["x-content-type-options"] == "nosniff"
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.format == "PNG"


@requires_db
def test_documents_are_found_by_world_asset_and_id(world: World_) -> None:
    """A document ID under another listing's path is not found, even for the same community."""
    first, second = draft(world), draft(world, geojson=square(800, lat=9.7))
    document = uploaded(world, first["id"], png())
    steward = client_for(world, world.steward)

    assert steward.get(f"/assets/{first['id']}/documents/{document}").status_code == 200
    wrong = steward.get(f"/assets/{second['id']}/documents/{document}")
    assert (wrong.status_code, wrong.json()["detail"]) == (404, "document_not_found")
    missing = steward.get(f"/assets/{first['id']}/documents/{uuid4()}/preview")
    assert (missing.status_code, missing.json()["detail"]) == (404, "document_not_found")


@requires_db
def test_another_worlds_document_is_not_found(world: World_) -> None:
    """The same steward role in another sandbox can't reach this world's document by ID."""
    asset = draft(world)
    document = uploaded(world, asset["id"], png())
    elsewhere = create_world(world.session)
    rosa = world.session.exec(
        select(User).where(User.world_id == elsewhere.id, User.persona_key == "rosa")
    ).one()
    theirs = world.session.exec(
        select(Asset.id).where(Asset.world_id == elsewhere.id, col(Asset.site_key).is_not(None))
    ).first()
    client = client_for(world, rosa)

    for path in (
        f"/assets/{asset['id']}/documents/{document}",
        f"/assets/{theirs}/documents/{document}",
        f"/assets/{asset['id']}/verification/runs",
    ):
        got = client.get(path)
        assert got.status_code == 404, path


@requires_db
def test_who_may_upload(world: World_) -> None:
    hidden = draft(world)
    public = listed(world, geojson=square(900, lat=9.6))

    assert upload(world, hidden["id"], png(), user=world.owner).status_code == 201
    for user, asset, code, detail in (
        (world.outsider, hidden, 404, "not_found"),
        (world.outsider, public, 403, "members_only"),
        (world.admin, public, 403, "members_only"),
        (world.other_steward, public, 403, "members_only"),
    ):
        response = upload(world, asset["id"], png(10, 10), user=user)
        assert (response.status_code, response.json()["detail"]) == (code, detail)
    anonymous = TestClient(app).post(
        f"/assets/{hidden['id']}/documents",
        params={"doc_type": "title"},
        content=png(),
        headers={"Content-Type": "image/png"},
    )
    assert anonymous.status_code == 401
    assert stored(world, hidden["id"]) == 1 and stored(world, public["id"]) == 0


@requires_db
@pytest.mark.parametrize(
    ("data", "media", "code", "detail"),
    [
        (b"<html>hi</html>", "image/png", 422, "unsupported_format"),
        (pdf(), "image/png", 422, "media_type_mismatch"),
        (bomb_png(), "image/png", 422, "image_too_large"),
        (encrypted_pdf(), "application/pdf", 422, "pdf_encrypted"),
        (pdf(51), "application/pdf", 422, "pdf_too_many_pages"),
        (javascript_pdf(), "application/pdf", 422, "pdf_active_content"),
        (png() + pdf(), "image/png", 422, "trailing_data"),
        (b"\x00" * (docs.MAX_DOCUMENT_BYTES + 1), "application/pdf", 413, "file_too_large"),
        (png(), "text/plain", 415, "unsupported_media_type"),
        (png(), "image/gif", 415, "unsupported_media_type"),
    ],
    ids=[
        "wrong-magic",
        "mismatch",
        "bomb",
        "encrypted",
        "pages",
        "javascript",
        "polyglot",
        "oversized",
        "text",
        "gif",
    ],
)
def test_hostile_uploads_are_refused_and_nothing_is_stored(
    world: World_, data: bytes, media: str, code: int, detail: str
) -> None:
    asset = draft(world)

    response = upload(world, asset["id"], data, media=media)

    assert (response.status_code, response.json()["detail"]) == (code, detail)
    assert stored(world, asset["id"]) == 0


@requires_db
def test_an_upload_needs_an_allowed_origin_and_a_length(world: World_) -> None:
    asset = draft(world)
    client = client_for(world, world.steward)
    url = f"/assets/{asset['id']}/documents?doc_type=title"

    no_origin = client.post(
        url, content=png(), headers={"Content-Type": "image/png", "Origin": "https://evil.example"}
    )
    chunked = client.post(url, content=iter([png()]), headers={"Content-Type": "image/png"})

    assert (no_origin.status_code, no_origin.json()["detail"]) == (403, "csrf_origin")
    assert (chunked.status_code, chunked.json()["detail"]) == (411, "length_required")
    assert stored(world, asset["id"]) == 0


@requires_db
def test_a_document_backs_one_listing_and_may_be_reused_by_it(world: World_) -> None:
    first, second = draft(world), draft(world, geojson=square(800, lat=9.7))
    title = png(1_234, 567)

    once = upload(world, first["id"], title)
    again = upload(world, first["id"], title)
    reused = upload(world, second["id"], title, user=world.owner)

    assert once.status_code == again.status_code == 201, "the same listing may upload it again"
    assert again.json()["commitment"] != once.json()["commitment"], "a fresh nonce each time"
    assert (reused.status_code, reused.json()["detail"]) == (409, "document_reused")
    assert stored(world, second["id"]) == 0
    # Fingerprints are keyed per world: another world's listing isn't blocked.
    elsewhere = create_world(world.session)
    rosa = world.session.exec(
        select(User).where(User.world_id == elsewhere.id, User.persona_key == "rosa")
    ).one()
    theirs = world.session.exec(
        select(Asset.id).where(Asset.world_id == elsewhere.id, col(Asset.community_id).is_not(None))
    ).first()
    other_world = client_for(world, rosa).post(
        f"/assets/{theirs}/documents",
        params={"doc_type": "title"},
        content=title,
        headers={"Content-Type": "image/png"},
    )
    assert other_world.status_code == 201, other_world.text


@requires_db
def test_a_listing_holds_a_limited_number_of_documents(
    world: World_, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(verification, "MAX_DOCUMENTS_PER_ASSET", 2)
    asset = draft(world)
    uploaded(world, asset["id"], png(10, 10))
    uploaded(world, asset["id"], png(11, 10))

    monkeypatch.setattr(
        verification_routes, "run_worker", lambda *_a, **_k: pytest.fail("inspected")
    )

    third = upload(world, asset["id"], png(12, 10))

    assert (third.status_code, third.json()["detail"]) == (409, "document_limit_reached")


# ----- runs, the checklist and decisions --------------------------------------------------------


def _checks(run: dict[str, Any]) -> dict[str, str]:
    return {item["check"]: item["result"] for item in run["checklist"]}


@requires_db
def test_a_run_has_a_deterministic_checklist_with_values_and_sources(world: World_) -> None:
    asset = draft(world)

    run = evidence(world, asset["id"])

    assert run["level"] == run["effective_level"] == "documents_submitted"
    assert (run["is_current"], run["fingerprint_matches"]) == (True, True)
    assert (run["mode"], run["evidence_kind"]) == ("review", "real")
    assert _checks(run) == {
        "accepted_format": "pass",
        "not_reused": "pass",
        "boundary_free": "pass",
        "consent_document": "pass",
    }
    assert all(item["found"] and item["source"] for item in run["checklist"])
    assert "2 documents: PNG (601 × 400 px); PDF (2 pages)" in run["checklist"][0]["found"]
    assert {document["doc_type"] for document in run["documents"]} == {
        "title",
        "assembly_minutes",
    }
    assert all(document["submitted"] for document in run["documents"])
    runs = client_for(world, world.owner).get(f"/assets/{asset['id']}/verification/runs").json()
    assert [r["id"] for r in runs] == [run["id"]]
    assert ledger(world, asset["id"], LedgerKind.VERIFICATION) == [], "submitting isn't decided"
    # The deferred check (a run has exactly its submitted documents) passes at commit.
    world.session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@requires_db
def test_warnings_and_failures_show_in_the_checklist(world: World_) -> None:
    asset = draft(world)
    title = png(700, 500)
    first = uploaded(world, asset["id"], title)
    second = uploaded(world, asset["id"], title, doc_type="entity_registration")

    run = submit_run(world, asset["id"], [first, second]).json()

    assert _checks(run)["not_reused"] == "warn"
    assert _checks(run)["consent_document"] == "fail"
    refused = decide(world, asset["id"], run["id"], "approve")
    assert (refused.status_code, refused.json()["detail"]) == (409, "checks_failed")
    rejected = decide(world, asset["id"], run["id"], "reject", reason="Add the assembly minutes")
    assert rejected.status_code == 200, rejected.text
    assert (rejected.json()["level"], rejected.json()["reason"]) == (
        "rejected",
        "Add the assembly minutes",
    )


@requires_db
def test_submitting_needs_the_listings_own_unsubmitted_documents(world: World_) -> None:
    asset, other = draft(world), draft(world, geojson=square(800, lat=9.7))
    mine = uploaded(world, asset["id"], png())
    theirs = uploaded(world, other["id"], png(20, 20))

    foreign = submit_run(world, asset["id"], [mine, theirs])
    unknown = submit_run(world, asset["id"], [str(uuid4())])
    first = submit_run(world, asset["id"], [mine])
    again = submit_run(world, asset["id"], [mine])
    four = submit_run(world, asset["id"], [str(uuid4()) for _ in range(4)])
    twice = submit_run(world, asset["id"], [mine, mine])
    outsider = submit_run(world, other["id"], [theirs], user=world.outsider)

    assert (foreign.status_code, foreign.json()["detail"]) == (404, "document_not_found")
    assert (unknown.status_code, unknown.json()["detail"]) == (404, "document_not_found")
    assert first.status_code == 201
    assert (again.status_code, again.json()["detail"]) == (409, "document_already_submitted")
    assert four.status_code == twice.status_code == 422
    assert outsider.status_code == 404


def runs_of(w: World_, asset_id: str | UUID) -> list[dict[str, Any]]:
    response = client_for(w, w.steward).get(f"/assets/{asset_id}/verification/runs")
    assert response.status_code == 200, response.text
    return list(response.json())


def doc_ids(run: dict[str, Any]) -> set[str]:
    return {document["id"] for document in run["documents"]}


@requires_db
def test_adding_a_document_while_a_run_waits_keeps_the_earlier_ones(world: World_) -> None:
    """#210: the new run covers the waiting run's documents and the new one; the reviewer sees
    all three, and the superseded run still reads as it was submitted."""
    asset = draft(world)
    first = evidence(world, asset["id"])
    extra = uploaded(world, asset["id"], png(77, 77), doc_type="entity_registration")

    added = submit_run(world, asset["id"], [extra])
    stale = decide(world, asset["id"], first["id"], "approve")

    assert added.status_code == 201, added.text
    second = added.json()
    assert doc_ids(second) == doc_ids(first) | {extra}
    assert second["fingerprint_matches"] and "3 documents" in second["checklist"][0]["found"]
    assert (stale.status_code, stale.json()["detail"]) == (409, "run_superseded")
    runs = runs_of(world, asset["id"])
    assert [(r["id"], r["is_current"], len(r["documents"])) for r in runs] == [
        (second["id"], True, 3),
        (first["id"], False, 2),
    ]
    assert runs[1]["input_fingerprint"] == first["input_fingerprint"], "write-once"
    assert runs[1]["fingerprint_matches"], "the superseded run still matches its own documents"
    (item,) = client_for(world, world.admin).get("/admin/verifications").json()
    assert (item["run"]["id"], doc_ids(item["run"])) == (second["id"], doc_ids(second))
    listed_docs = client_for(world, world.steward).get(f"/assets/{asset['id']}/documents").json()
    assert all(document["submitted"] for document in listed_docs)

    approved = decide(world, asset["id"], second["id"], "approve")
    assert approved.status_code == 200, approved.text
    (entry,) = ledger(world, asset["id"], LedgerKind.VERIFICATION)
    commitments = {document["commitment"] for document in second["documents"]}
    assert {c["commitment"] for c in entry.payload["document_commitments"]} == commitments


@requires_db
def test_a_submission_holds_at_most_three_documents(world: World_) -> None:
    asset = draft(world)
    first = evidence(world, asset["id"])
    title, minutes = (
        (d["id"] for d in first["documents"] if d["doc_type"] == "title"),
        (d["id"] for d in first["documents"] if d["doc_type"] == "assembly_minutes"),
    )
    title_id, minutes_id = next(title), next(minutes)
    one = uploaded(world, asset["id"], png(70, 70), doc_type="other")
    two = uploaded(world, asset["id"], png(71, 71), doc_type="entity_registration")

    full = submit_run(world, asset["id"], [one, two])
    again = submit_run(world, asset["id"], [minutes_id])
    not_in_it = client_for(world, world.steward).post(
        f"/assets/{asset['id']}/verification/runs",
        json={"document_ids": [one], "remove_document_ids": [two]},
    )
    assert (full.status_code, full.json()["detail"]) == (409, "submission_full")
    assert (again.status_code, again.json()["detail"]) == (409, "document_already_submitted")
    assert (not_in_it.status_code, not_in_it.json()["detail"]) == (
        409,
        "document_not_in_submission",
    )
    assert [r["id"] for r in runs_of(world, asset["id"])] == [first["id"]], "nothing changed"

    swapped = client_for(world, world.steward).post(
        f"/assets/{asset['id']}/verification/runs",
        json={"document_ids": [one, two], "remove_document_ids": [title_id]},
    )

    assert swapped.status_code == 201, swapped.text
    assert doc_ids(swapped.json()) == {minutes_id, one, two}
    assert doc_ids(runs_of(world, asset["id"])[1]) == {title_id, minutes_id}


@requires_db
def test_a_steward_may_leave_out_every_carried_document(world: World_) -> None:
    asset = draft(world)
    first = evidence(world, asset["id"])
    fresh = uploaded(world, asset["id"], png(91, 91), doc_type="assembly_minutes")

    replaced = client_for(world, world.steward).post(
        f"/assets/{asset['id']}/verification/runs",
        json={"document_ids": [fresh], "remove_document_ids": sorted(doc_ids(first))},
    )

    assert replaced.status_code == 201, replaced.text
    assert doc_ids(replaced.json()) == {fresh}
    assert doc_ids(runs_of(world, asset["id"])[1]) == doc_ids(first), "history unchanged"


@requires_db
def test_after_a_decision_a_submission_starts_afresh(world: World_) -> None:
    """A decided run's documents were judged: they stay in its record and don't carry over."""
    asset = draft(world)
    first = evidence(world, asset["id"])
    assert decide(world, asset["id"], first["id"], "reject", reason="Blurry").status_code == 200
    fresh = uploaded(world, asset["id"], png(90, 90), doc_type="assembly_minutes")

    removing = client_for(world, world.steward).post(
        f"/assets/{asset['id']}/verification/runs",
        json={"document_ids": [fresh], "remove_document_ids": [first["documents"][0]["id"]]},
    )
    second = submit_run(world, asset["id"], [fresh])

    assert (removing.status_code, removing.json()["detail"]) == (
        409,
        "document_not_in_submission",
    )
    assert second.status_code == 201, second.text
    assert doc_ids(second.json()) == {fresh}
    rejected = runs_of(world, asset["id"])[1]
    assert (rejected["level"], rejected["reason"], doc_ids(rejected)) == (
        "rejected",
        "Blurry",
        doc_ids(first),
    )


@requires_db
def test_only_an_impartial_admin_decides(world: World_) -> None:
    asset = draft(world)
    run = evidence(world, asset["id"])
    _member(world.session, world.id, world.community_id, world.admin)

    conflicted = decide(world, asset["id"], run["id"], "approve")
    steward = decide(world, asset["id"], run["id"], "approve", user=world.steward)
    impartial = _person(world.session, world.id, "Second Admin", UserRole.ADMIN)
    queue_conflicted = client_for(world, world.admin).get("/admin/verifications").json()
    queue = client_for(world, impartial).get("/admin/verifications")
    investor_queue = client_for(world, world.outsider).get("/admin/verifications")

    assert (conflicted.status_code, conflicted.json()["detail"]) == (403, "conflict_of_interest")
    assert (steward.status_code, steward.json()["detail"]) == (403, "admin_only")
    assert queue_conflicted == [], "an admin never reviews its own community's listings"
    assert [item["run"]["id"] for item in queue.json()] == [run["id"]]
    assert queue.json()[0]["asset_name"] == "Bosque Vivo"
    assert (investor_queue.status_code, investor_queue.json()["detail"]) == (403, "admin_only")
    assert TestClient(app).get("/admin/verifications").status_code == 401
    approved = decide(world, asset["id"], run["id"], "approve", user=impartial, reason="Clear")
    assert approved.status_code == 200, approved.text
    assert client_for(world, impartial).get("/admin/verifications").json() == []


@requires_db
def test_a_decision_is_written_once_and_ledgered_without_personal_data(world: World_) -> None:
    asset = draft(world)
    run = evidence(world, asset["id"])

    approved = decide(world, asset["id"], run["id"], "approve", reason="Title matches the land")
    twice = decide(world, asset["id"], run["id"], "reject", reason="Changed my mind")
    no_reason = decide(world, asset["id"], run["id"], "revoke")
    blank = decide(world, asset["id"], run["id"], "revoke", reason="   ")

    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert (body["level"], body["reviewer_role"], body["reason"]) == (
        "verified",
        "platform_admin",
        "Title matches the land",
    )
    assert "reviewer_user_id" not in body
    assert (twice.status_code, twice.json()["detail"]) == (409, "run_already_decided")
    assert no_reason.status_code == blank.status_code == 422
    (entry,) = ledger(world, asset["id"], LedgerKind.VERIFICATION)
    payload = entry.payload
    assert entry.ref_id == UUID(run["id"])
    assert payload["level"] == "verified" and payload["reviewer_role"] == "platform_admin"
    assert payload["input_fingerprint"] == run["input_fingerprint"]
    assert payload["checks"] == [
        {"check": c["check"], "result": c["result"]} for c in run["checklist"]
    ]
    salt = world.session.get_one(VerificationRun, UUID(run["id"])).reason_salt
    assert payload["reason_commitment"] == reason_commitment(
        salt, "decision", "Title matches the land"
    )
    assert payload["reason_commitment"] != hashlib.sha256(b"Title matches the land").hexdigest()
    commitments = {d["commitment"] for d in run["documents"]}
    assert {c["commitment"] for c in payload["document_commitments"]} == commitments
    _assert_private(world, entry.payload, asset["id"])


def _assert_private(w: World_, payload: dict[str, Any], asset_id: str) -> None:
    """No raw document hash, private fingerprint, nonce, account ID, name or reason text."""
    public = str(payload).lower()
    rows = w.session.exec(
        select(ListingDocument, ListingDocumentBlob)
        .join(ListingDocumentBlob, col(ListingDocumentBlob.document_id) == col(ListingDocument.id))
        .where(ListingDocument.asset_id == UUID(asset_id))
    ).all()
    assert rows
    for document, blob in rows:
        assert hashlib.sha256(blob.content).hexdigest() not in public
        assert document.private_fingerprint not in public
        assert document.commitment_nonce is not None
        assert document.commitment_nonce.hex() not in public
    for user in w.session.exec(select(User).where(User.world_id == w.id)).all():
        assert str(user.id) not in public
        assert not re.search(rf"\b{re.escape(user.name)}\b", str(payload), re.IGNORECASE)
    assert "title matches" not in public


# ----- write-once runs (DB) ---------------------------------------------------------------------


def _raises_in_db(w: World_, statement: str, *more: str, **params: Any) -> str:
    """Run the statements in a savepoint; return the database's error message."""
    savepoint = w.session.begin_nested()
    with pytest.raises(DBAPIError) as caught:
        for sql in (statement, *more):
            w.session.execute(text(sql), params)
        w.session.flush()
    savepoint.rollback()
    return str(caught.value.orig)


@requires_db
def test_runs_and_documents_are_write_once_in_the_database(world: World_) -> None:
    asset = draft(world)
    run = verified(world, asset["id"])
    run_id = run["id"]
    document_id = run["documents"][0]["id"]

    assert "write-once" in _raises_in_db(
        world,
        "UPDATE verification_runs SET input_fingerprint = :f WHERE id = :id",
        f="0" * 64,
        id=run_id,
    )
    assert "write-once" in _raises_in_db(
        world, "UPDATE verification_runs SET checklist = '[]' WHERE id = :id", id=run_id
    )
    assert "not allowed" in _raises_in_db(
        world,
        "UPDATE verification_runs SET level = 'documents_submitted' WHERE id = :id",
        id=run_id,
    )
    assert "written once" in _raises_in_db(
        world, "UPDATE verification_runs SET reason = 'edited' WHERE id = :id", id=run_id
    )
    assert "DELETE" in _raises_in_db(
        world, "DELETE FROM verification_runs WHERE id = :id", id=run_id
    )
    assert "write-once" in _raises_in_db(
        world, "UPDATE listing_documents SET doc_type = 'other' WHERE id = :id", id=document_id
    )
    assert "immutable" in _raises_in_db(
        world,
        "DELETE FROM verification_run_documents WHERE document_id = :id",
        id=document_id,
    )
    assert "immutable" in _raises_in_db(
        world,
        "UPDATE verification_run_documents SET document_id = :other WHERE document_id = :id",
        id=document_id,
        other=run["documents"][1]["id"],
    )
    assert "immutable" in _raises_in_db(
        world,
        "UPDATE listing_document_blobs SET content = 'x' WHERE document_id = :id",
        id=document_id,
    )
    assert "immutable" in _raises_in_db(
        world,
        "UPDATE document_fingerprints SET private_fingerprint = repeat('0', 64) "
        "WHERE world_id = :world_id",
        world_id=world.id,
    )
    assert "immutable" in _raises_in_db(
        world,
        "UPDATE document_fingerprints SET active = false WHERE world_id = :world_id",
        "UPDATE document_fingerprints SET active = true WHERE world_id = :world_id",
        world_id=world.id,
    )
    assert "current" in _raises_in_db(
        world,
        "INSERT INTO verification_runs (id, world_id, asset_id, level, input_fingerprint, "
        "checklist, method_version, mode, evidence_kind, document_count) "
        "VALUES (:id, :world_id, :a, "
        "'verified', :f, '[]', 'v', 'review', 'real', 1)",
        id=uuid4(),
        world_id=world.id,
        a=asset["id"],
        f="0" * 64,
    )


@requires_db
def test_one_current_run_per_asset(world: World_) -> None:
    asset = draft(world)
    evidence(world, asset["id"])
    current = world.session.exec(
        select(VerificationRun).where(VerificationRun.asset_id == UUID(asset["id"]))
    ).one()

    message = _raises_in_db(
        world,
        "INSERT INTO verification_runs (id, world_id, asset_id, level, input_fingerprint, "
        "checklist, method_version, mode, evidence_kind, document_count) "
        "VALUES (:id, :world_id, :a, "
        "'documents_submitted', :f, '[]', 'v', 'review', 'real', 1)",
        id=uuid4(),
        world_id=world.id,
        a=asset["id"],
        f=current.input_fingerprint,
    )
    assert "uq_verification_runs_current" in message
    assert "never becomes current" in _raises_in_db(
        world,
        "UPDATE verification_runs SET is_current = false WHERE id = :id",
        "UPDATE verification_runs SET is_current = true WHERE id = :id",
        id=current.id,
    )


@requires_db
def test_documents_cant_be_linked_to_a_run_after_it_was_submitted(world: World_) -> None:
    """The deferred trigger: at commit, a run has exactly the documents it was submitted with."""
    asset = draft(world)
    run = evidence(world, asset["id"])
    late = uploaded(world, asset["id"], png(33, 33), doc_type="other")

    message = _raises_in_db(
        world,
        "INSERT INTO verification_run_documents (run_id, document_id, world_id, asset_id) "
        "VALUES (:run, :id, :world_id, :asset_id)",
        "SET CONSTRAINTS ALL IMMEDIATE",
        run=run["id"],
        id=late,
        world_id=world.id,
        asset_id=asset["id"],
    )

    assert "has 3 documents, not 2" in message


@requires_db
def test_a_document_links_only_to_a_run_of_its_own_asset(world: World_) -> None:
    asset, other = draft(world), draft(world, geojson=square(800, lat=9.7))
    run = evidence(world, asset["id"])
    foreign = uploaded(world, other["id"], png(44, 44))

    message = _raises_in_db(
        world,
        "INSERT INTO verification_run_documents (run_id, document_id, world_id, asset_id) "
        "VALUES (:run, :id, :world_id, :asset_id)",
        run=run["id"],
        id=foreign,
        world_id=world.id,
        asset_id=asset["id"],
    )

    assert "fk_verification_run_documents_document" in message


# ----- the fingerprint makes edits unverified ---------------------------------------------------


@requires_db
def test_an_edit_after_submission_makes_the_run_stale(world: World_) -> None:
    """The stale-fingerprint bypass: a run submitted for one polygon can't approve another."""
    asset = draft(world)
    run = evidence(world, asset["id"])
    edited = client_for(world, world.steward).patch(
        f"/assets/{asset['id']}", json={"geojson": square(1_500)}
    )
    assert edited.status_code == 200, edited.text

    refused = decide(world, asset["id"], run["id"], "approve")

    assert (refused.status_code, refused.json()["detail"]) == (409, "stale_run")
    runs = client_for(world, world.steward).get(f"/assets/{asset['id']}/verification/runs").json()
    assert (runs[0]["level"], runs[0]["effective_level"], runs[0]["fingerprint_matches"]) == (
        "documents_submitted",
        "unverified",
        False,
    )


@requires_db
def test_a_verified_listing_that_is_revised_and_renamed_is_unverified(world: World_) -> None:
    asset = draft(world)
    verified(world, asset["id"])
    panel = client_for(world, world.owner).get(f"/assets/{asset['id']}/verification").json()
    assert panel["level"] == "verified"

    renamed = client_for(world, world.steward).patch(
        f"/assets/{asset['id']}", json={"name": "Bosque Nuevo"}
    )
    assert renamed.status_code == 200
    after = client_for(world, world.owner).get(f"/assets/{asset['id']}/verification").json()
    described = client_for(world, world.steward).patch(
        f"/assets/{asset['id']}", json={"name": "Bosque Vivo", "description": "New words"}
    )

    assert after["level"] == "unverified" and after["checks"] == []
    assert after["badge"] == "Self-attested by the community"
    assert described.status_code == 200
    restored = client_for(world, world.owner).get(f"/assets/{asset['id']}/verification").json()
    assert restored["level"] == "verified", "the description isn't a verified input"


# ----- revoke during trading --------------------------------------------------------------------


@requires_db
def test_revoking_suspends_trading_until_a_new_run_is_approved(world: World_) -> None:
    asset = listed(world)
    asset_id = asset["id"]
    assert launch(world, asset_id).status_code == 201, "sandboxes need no verification"
    run = verified(world, asset_id)
    assert buy(world, asset_id).status_code == 200

    revoked = decide(world, asset_id, run["id"], "revoke", reason="Disputed title")

    assert revoked.status_code == 200, revoked.text
    assert (revoked.json()["level"], revoked.json()["revoke_reason"]) == (
        "revoked",
        "Disputed title",
    )
    assert status_of(world, asset_id) == (AssetStatus.SUSPENDED, "verification_revoked")
    refused = buy(world, asset_id)
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_trading")
    kinds = [
        (e.kind, e.payload.get("level") or e.payload.get("transition"))
        for e in ledger(world, asset_id)
    ]
    assert kinds[-2:] == [(LedgerKind.VERIFICATION, "revoked"), (LedgerKind.LISTING, "suspend")]
    revoke_entry = ledger(world, asset_id, LedgerKind.VERIFICATION)[-1].payload
    salt = world.session.get_one(VerificationRun, UUID(run["id"])).reason_salt
    assert revoke_entry["revoke_reason_commitment"] == reason_commitment(
        salt, "revocation", "Disputed title"
    )
    panel = client_for(world, world.outsider).get(f"/assets/{asset_id}/verification").json()
    assert (panel["level"], panel["badge"]) == ("revoked", "Verification revoked")

    resume = client_for(world, world.admin).post(f"/admin/assets/{asset_id}/resume")
    again = decide(world, asset_id, run["id"], "revoke", reason="Twice")
    assert (resume.status_code, resume.json()["detail"]) == (409, "not_verified")
    assert (again.status_code, again.json()["detail"]) == (409, "not_verified")

    renewed = verified(world, asset_id, seed_byte=2)

    assert renewed["level"] == "verified"
    assert status_of(world, asset_id) == (AssetStatus.LISTED, None)
    assert buy(world, asset_id).status_code == 200
    transitions = [e.payload.get("transition") for e in ledger(world, asset_id, LedgerKind.LISTING)]
    assert transitions[-2:] == ["suspend", "resume"]


@requires_db
def test_approving_doesnt_lift_a_moderation_suspension(world: World_) -> None:
    asset = listed(world)
    suspended = client_for(world, world.admin).post(
        f"/admin/assets/{asset['id']}/suspend", json={"reason": "moderation"}
    )
    assert suspended.status_code == 200

    verified(world, asset["id"])

    assert status_of(world, asset["id"]) == (AssetStatus.SUSPENDED, "moderation")


@requires_db
def test_the_public_panel_shows_results_not_values(world: World_) -> None:
    asset = listed(world)
    before = client_for(world, world.outsider).get(f"/assets/{asset['id']}/verification")
    run = verified(world, asset["id"])

    panel = client_for(world, world.outsider).get(f"/assets/{asset['id']}/verification").json()

    assert before.json()["level"] == "unverified"
    assert before.json()["not_checked"] == list(NOT_CHECKED)
    assert (panel["level"], panel["reviewer_role"], panel["run_id"]) == (
        "verified",
        "platform_admin",
        run["id"],
    )
    assert panel["badge"] == "Documents reviewed by NatureX (hackathon process)"
    assert panel["checks"] == [
        {"check": c["check"], "result": c["result"]} for c in run["checklist"]
    ]
    assert panel["not_checked"] == list(NOT_CHECKED)
    (entry,) = ledger(world, asset["id"], LedgerKind.VERIFICATION)
    assert panel["ledger_seq"] == entry.seq
    assert "reason" not in panel and "documents" not in panel
    private = draft(world, geojson=square(700, lat=9.5))["id"]
    hidden = client_for(world, world.outsider).get(f"/assets/{private}/verification")
    assert hidden.status_code == 404


# ----- the live-world IPO gate ------------------------------------------------------------------


@pytest.fixture
def live(conn: Connection) -> Iterator[World_]:
    """The live world with a community (owner + steward), a second community, an investor and
    a live admin, all password accounts (T73)."""
    session = _sessions(conn)()
    seed(session)
    ensure_live_world(session)
    owner = _person(session, LIVE_WORLD_ID, "Live Owner")
    steward = _person(session, LIVE_WORLD_ID, "Live Steward")
    outsider = _person(session, LIVE_WORLD_ID, "Live Investor")
    other_steward = _person(session, LIVE_WORLD_ID, "Live Other Steward")
    admin = _person(session, LIVE_WORLD_ID, "Live Admin", UserRole.ADMIN)
    community = create_community(session, LIVE_WORLD_ID, "Live Bosque Stewards", owner.id)
    other = create_community(session, LIVE_WORLD_ID, "Live Río Keepers", other_steward.id)
    session.commit()
    _member(session, LIVE_WORLD_ID, community.id, steward)
    runner = _runner(_sessions(conn))
    assert isinstance(runner.executor, Deferred)
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_settings] = lambda: _settings()
    app.dependency_overrides[get_rating_runner] = lambda: runner
    checker = _checker(_sessions(conn))
    app.dependency_overrides[get_document_checker] = lambda: checker
    yield World_(
        LIVE_WORLD_ID,
        community.id,
        other.id,
        owner,
        steward,
        outsider,
        other_steward,
        admin,
        session,
        runner,
        runner.executor,
        checker,
    )
    app.dependency_overrides.clear()
    session.close()


@requires_db
def test_the_live_ipo_waits_for_a_verified_run(live: World_) -> None:
    asset = listed(live)
    asset_id = asset["id"]

    blocked = ipo_preview(live, asset_id)
    refused = launch(live, asset_id)

    assert blocked.status_code == 200, blocked.text
    assert (blocked.json()["launchable"], blocked.json()["blocked_reason"]) == (
        False,
        "not_verified",
    )
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_verified")
    run = evidence(live, asset_id)
    pending = ipo_preview(live, asset_id).json()
    assert pending["blocked_reason"] == "not_verified", "submitted isn't verified"

    approved = decide(live, asset_id, run["id"], "approve")
    assert approved.status_code == 200, approved.text
    ready = ipo_preview(live, asset_id).json()
    assert (ready["launchable"], ready["blocked_reason"]) == (True, None)
    launched = launch(live, asset_id)
    assert launched.status_code == 201, launched.text
    assert buy(live, asset_id).status_code == 200


@requires_db
def test_a_live_listing_verified_then_edited_is_blocked_again(live: World_) -> None:
    asset = draft(live)
    asset_id = asset["id"]
    verified(live, asset_id)
    redrawn = client_for(live, live.steward).patch(
        f"/assets/{asset_id}", json={"geojson": square(1_250)}
    )
    assert redrawn.status_code == 200, redrawn.text
    assert client_for(live, live.steward).post(f"/assets/{asset_id}/submit").status_code == 202
    live.executor.run_all()
    assert status_of(live, asset_id)[0] is AssetStatus.LISTED

    blocked = ipo_preview(live, asset_id).json()
    refused = launch(live, asset_id)

    assert blocked["blocked_reason"] == "not_verified"
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_verified")


@requires_db
def test_the_gate_is_rechecked_inside_the_launch_transaction(
    live: World_, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run revoked between the preview and the launch: the locked check refuses it."""
    from app.services import ipo as ipo_service

    asset = listed(live)
    run = verified(live, asset["id"])
    price = ipo_preview(live, asset["id"]).json()["ipo_price"]
    lock = ipo_service.lock_asset

    def revoked_meanwhile(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
        session.execute(
            update(VerificationRun)
            .where(col(VerificationRun.id) == UUID(run["id"]))
            .values(
                level=VerificationLevel.REVOKED, revoked_at=datetime.now(UTC), revoke_reason="r"
            )
        )
        session.execute(
            update(Asset)
            .where(col(Asset.id) == asset_id)
            .values(verification_revoked_at=datetime.now(UTC))
        )
        return lock(session, world_id, asset_id)

    monkeypatch.setattr(ipo_service, "lock_asset", revoked_meanwhile)
    refused = client_for(live, live.owner).post(
        f"/assets/{asset['id']}/ipo", json={"expected_price": price}
    )

    assert (refused.status_code, refused.json()["detail"]) == (409, "not_verified")


# ----- sandboxes ---------------------------------------------------------------------------------


@requires_db
def test_a_sandbox_reset_deletes_its_verification_records(world: World_) -> None:
    sandbox = create_world(world.session)
    rosa = world.session.exec(
        select(User).where(User.world_id == sandbox.id, User.persona_key == "rosa")
    ).one()
    asset = world.session.exec(
        select(Asset).where(Asset.world_id == sandbox.id, col(Asset.community_id).is_not(None))
    ).first()
    assert asset is not None
    client = client_for(world, rosa)
    response = client.post(
        f"/assets/{asset.id}/documents",
        params={"doc_type": "assembly_minutes"},
        content=png(),
        headers={"Content-Type": "image/png"},
    )
    assert response.status_code == 201, response.text
    assert (
        client.post(
            f"/assets/{asset.id}/verification/runs", json={"document_ids": [response.json()["id"]]}
        ).status_code
        == 201
    )

    reset_world(world.session, sandbox.id)

    for model in (
        VerificationRun,
        VerificationRunDocument,
        ListingDocument,
        ListingDocumentBlob,
        DocumentFingerprint,
    ):
        rows = world.session.exec(select(model).where(_world_col(model) == sandbox.id)).all()
        assert rows == [], model.__name__


@requires_db
def test_a_world_with_verification_records_isnt_copied(world: World_) -> None:
    asset = draft(world)
    evidence(world, asset["id"])

    with pytest.raises(RuntimeError, match="verification records"):
        _copy_world_rows(world.session, world.id, uuid4())


# ----- revocations stand until an approval -----------------------------------------------------


def _revoked_at(w: World_, asset_id: str) -> datetime | None:
    w.session.expire_all()
    return w.session.get_one(Asset, UUID(asset_id)).verification_revoked_at


@requires_db
def test_a_new_run_doesnt_undo_a_revocation(world: World_) -> None:
    asset_id = listed(world)["id"]
    assert launch(world, asset_id).status_code == 201
    run = verified(world, asset_id)
    assert decide(world, asset_id, run["id"], "revoke", reason="Disputed").status_code == 200
    assert _revoked_at(world, asset_id) is not None

    pending = evidence(world, asset_id, seed_byte=2)  # submitted, not approved
    resume = client_for(world, world.admin).post(f"/admin/assets/{asset_id}/resume")
    panel = client_for(world, world.outsider).get(f"/assets/{asset_id}/verification").json()

    assert (resume.status_code, resume.json()["detail"]) == (409, "not_verified")
    assert status_of(world, asset_id) == (AssetStatus.SUSPENDED, "verification_revoked")
    assert (panel["level"], panel["badge"]) == ("revoked", "Verification revoked")
    assert buy(world, asset_id).json()["detail"] == "not_trading"

    approved = decide(world, asset_id, pending["id"], "approve")

    assert approved.status_code == 200, approved.text
    assert _revoked_at(world, asset_id) is None, "only an approval clears it"
    assert status_of(world, asset_id) == (AssetStatus.LISTED, None)
    assert buy(world, asset_id).status_code == 200


@requires_db
def test_a_revoked_listing_cant_launch_even_in_a_sandbox(world: World_) -> None:
    """Revoked as a draft (nothing to suspend), then rated into `listed` with a new, undecided
    run: the sandbox IPO is still refused until an approval."""
    asset_id = draft(world)["id"]
    run = verified(world, asset_id)
    assert decide(world, asset_id, run["id"], "revoke", reason="Forged").status_code == 200
    assert status_of(world, asset_id)[0] is AssetStatus.DRAFT
    pending = evidence(world, asset_id, seed_byte=2)
    assert client_for(world, world.steward).post(f"/assets/{asset_id}/submit").status_code == 202
    world.executor.run_all()
    assert status_of(world, asset_id)[0] is AssetStatus.LISTED

    blocked = ipo_preview(world, asset_id).json()
    refused = launch(world, asset_id)

    assert blocked["blocked_reason"] == "not_verified"
    assert (refused.status_code, refused.json()["detail"]) == (409, "not_verified")
    assert decide(world, asset_id, pending["id"], "approve").status_code == 200
    assert ipo_preview(world, asset_id).json()["launchable"] is True
    assert launch(world, asset_id).status_code == 201


@requires_db
def test_the_public_panel_still_says_revoked_after_an_edit(world: World_) -> None:
    asset_id = draft(world)["id"]
    run = verified(world, asset_id)
    assert decide(world, asset_id, run["id"], "revoke", reason="Disputed").status_code == 200
    renamed = client_for(world, world.steward).patch(
        f"/assets/{asset_id}", json={"name": "Bosque Renombrado"}
    )
    assert renamed.status_code == 200

    panel = client_for(world, world.owner).get(f"/assets/{asset_id}/verification").json()

    assert (panel["level"], panel["badge"], panel["checks"]) == (
        "revoked",
        "Verification revoked",
        [],
    )
    assert panel["revoked_at"] is not None
    (entry,) = [e for e in ledger(world, asset_id, LedgerKind.VERIFICATION)][-1:]
    assert panel["ledger_seq"] == entry.seq


# ----- upload limits: slots, rate, quotas -------------------------------------------------------


@requires_db
def test_a_busy_process_answers_503_at_once(world: World_, monkeypatch: pytest.MonkeyPatch) -> None:
    asset_id = draft(world)["id"]
    monkeypatch.setattr(verification_routes, "run_worker", lambda *a, **k: pytest.fail("ran"))
    held = [docs.try_acquire_slot() for _ in range(docs.MAX_CONCURRENT_INSPECTIONS)]
    try:
        assert all(held)
        started = time.monotonic()
        response = upload(world, asset_id, png())
        elapsed = time.monotonic() - started
    finally:
        for _ in held:
            docs.release_slot()

    assert (response.status_code, response.json()["detail"]) == (503, "inspection_busy")
    assert response.headers["retry-after"] == "5"
    assert elapsed < 2, "never waits for a slot"
    assert stored(world, asset_id) == 0


@requires_db
def test_uploads_are_rate_limited_per_account(world: World_) -> None:
    app.dependency_overrides[get_settings] = lambda: _settings(document_uploads_per_hour=2)
    asset_id = draft(world)["id"]

    rejected = upload(world, asset_id, b"<html>not an image</html>")
    accepted = upload(world, asset_id, png())
    limited = upload(world, asset_id, png())
    owner = upload(world, asset_id, png(), user=world.owner)

    assert rejected.status_code == 422, "refused files count too"
    assert accepted.status_code == 201
    assert (limited.status_code, limited.json()["detail"]) == (429, "upload_rate_limited")
    assert 1 <= int(limited.headers["retry-after"]) <= 3600
    assert owner.status_code == 201, "the limit is per account"
    assert stored(world, asset_id) == 2


@requires_db
def test_documents_have_community_and_world_byte_quotas(world: World_) -> None:
    first = png()
    app.dependency_overrides[get_settings] = lambda: _settings(
        document_quota_community_bytes=len(first) + 100
    )
    asset_id = draft(world)["id"]
    other = draft(
        world,
        user=world.other_steward,
        community_id=str(world.other_community_id),
        geojson=square(700, lat=9.5),
    )["id"]

    assert upload(world, asset_id, first).status_code == 201
    over = upload(world, asset_id, png())
    elsewhere = upload(world, other, png(), user=world.other_steward)

    assert (over.status_code, over.json()["detail"]) == (409, "storage_quota_exceeded")
    assert elsewhere.status_code == 201, "another community has its own quota"

    used = sum(
        d.size_bytes
        for d in world.session.exec(
            select(ListingDocument).where(ListingDocument.world_id == world.id)
        ).all()
    )
    app.dependency_overrides[get_settings] = lambda: _settings(
        document_quota_world_bytes=used + 100
    )
    world_full = upload(world, other, png(), user=world.other_steward)
    assert (world_full.status_code, world_full.json()["detail"]) == (
        409,
        "storage_quota_exceeded",
    )


# ----- a closed listing releases its documents to its own community -----------------------------


@requires_db
def test_a_closed_listings_document_can_back_another_listing_of_its_community(
    world: World_,
) -> None:
    first = draft(world)["id"]
    title = png()
    kept = uploaded(world, first, title)
    second = draft(world, geojson=square(800, lat=9.7))["id"]
    taken = upload(world, second, title)
    assert (taken.status_code, taken.json()["detail"]) == (409, "document_reused"), "still open"

    assert client_for(world, world.steward).post(f"/assets/{first}/withdraw").status_code == 200
    moved = upload(world, second, title)

    assert moved.status_code == 201, moved.text
    run = submit_run(world, second, [moved.json()["id"]]).json()
    assert _checks(run)["not_reused"] == "pass"
    old = client_for(world, world.steward).get(f"/assets/{first}/documents/{kept}")
    assert old.status_code == 200 and old.content == title, "the withdrawn listing keeps it"

    # Never across communities, even from a withdrawn listing.
    assert client_for(world, world.steward).post(f"/assets/{second}/withdraw").status_code == 200
    foreign = draft(
        world,
        user=world.other_steward,
        community_id=str(world.other_community_id),
        geojson=square(700, lat=9.5),
    )["id"]
    crossed = upload(world, foreign, title, user=world.other_steward)
    assert (crossed.status_code, crossed.json()["detail"]) == (409, "document_reused")


@requires_db
def test_an_ineligible_listings_document_moves_within_its_community(world: World_) -> None:
    first = draft(world)["id"]
    title = png()
    uploaded(world, first, title)
    world.session.execute(
        update(Asset).where(col(Asset.id) == UUID(first)).values(status=AssetStatus.INELIGIBLE)
    )
    world.session.commit()
    second = draft(world, geojson=square(800, lat=9.7))["id"]

    assert upload(world, second, title).status_code == 201
    bindings = world.session.exec(
        select(DocumentFingerprint).where(DocumentFingerprint.world_id == world.id)
    ).all()
    assert sorted((str(b.asset_id), b.active) for b in bindings) == sorted(
        [(first, False), (second, True)]
    )
    message = _raises_in_db(
        world,
        "UPDATE document_fingerprints SET active = true WHERE asset_id = :a",
        a=first,
    )
    assert "immutable" in message


@requires_db
def test_only_one_binding_per_file_is_active(world: World_) -> None:
    first, second = draft(world)["id"], draft(world, geojson=square(800, lat=9.7))["id"]
    uploaded(world, first, png())
    binding = world.session.exec(
        select(DocumentFingerprint).where(DocumentFingerprint.asset_id == UUID(first))
    ).one()

    message = _raises_in_db(
        world,
        "INSERT INTO document_fingerprints (world_id, private_fingerprint, asset_id, active) "
        "VALUES (:world_id, :fp, :a, true)",
        world_id=world.id,
        fp=binding.private_fingerprint,
        a=second,
    )

    assert "uq_document_fingerprints_active" in message


# ----- CSRF: binary bodies only on the upload route ---------------------------------------------


@requires_db
def test_binary_bodies_are_accepted_on_the_upload_route_only(world: World_) -> None:
    asset_id = draft(world)["id"]
    document = uploaded(world, asset_id, png())
    client = client_for(world, world.steward)
    for method, url in (
        ("POST", "/assets"),
        ("PUT", f"/assets/{asset_id}/documents"),
        ("PATCH", f"/assets/{asset_id}/documents"),
        ("POST", f"/assets/{asset_id}/documents/{document}"),
        ("POST", f"/assets/{asset_id}/verification/runs"),
        ("PATCH", f"/assets/{asset_id}"),
    ):
        response = client.request(
            method, url, content=pdf(), headers={"Content-Type": "application/pdf"}
        )
        assert (response.status_code, response.json()["detail"]) == (
            415,
            "unsupported_media_type",
        ), (method, url)
    assert stored(world, asset_id) == 1


# ----- reads stay cheap -------------------------------------------------------------------------


def _selects(session: Session) -> tuple[list[str], Callable[[], None]]:
    statements: list[str] = []

    def count(*args: Any) -> None:
        if str(args[2]).lstrip().upper().startswith("SELECT"):
            statements.append(str(args[2]))

    connection = session.connection()
    sa_event.listen(connection, "before_cursor_execute", count)
    return statements, lambda: sa_event.remove(connection, "before_cursor_execute", count)


@requires_db
def test_the_review_queue_pages_in_two_queries(world: World_) -> None:
    runs = []
    for index, lat in enumerate((9.9, 9.7, 9.5)):
        asset_id = draft(world, geojson=square(700, lat=lat))["id"]
        runs.append(evidence(world, asset_id, seed_byte=index + 1)["id"])
    admin = client_for(world, world.admin)

    first = admin.get("/admin/verifications", params={"limit": 2}).json()
    rest = admin.get("/admin/verifications", params={"limit": 2, "offset": 2}).json()
    too_many = admin.get("/admin/verifications", params={"limit": 101})

    assert [item["run"]["id"] for item in first + rest] == runs, "oldest first, no overlap"
    assert all(len(item["run"]["documents"]) == 2 for item in first + rest)
    assert too_many.status_code == 422
    statements, stop = _selects(world.session)
    try:
        verification.review_queue(world.session, world.id)
    finally:
        stop()
    assert len(statements) == 2, statements


@requires_db
def test_decided_listings_newest_decision_first_by_level_and_paged(world: World_) -> None:
    """#211: a reviewer finds listings again after deciding them; waiting ones stay queued."""
    approved, rejected, revoked, waiting = (
        draft(world, geojson=square(700, lat=lat))["id"] for lat in (9.9, 9.7, 9.5, 9.3)
    )
    verified(world, approved, seed_byte=1)
    run = evidence(world, rejected, seed_byte=2)
    assert decide(world, rejected, run["id"], "reject", reason="Blurry").status_code == 200
    run = verified(world, revoked, seed_byte=3)
    assert decide(world, revoked, run["id"], "revoke", reason="Disputed").status_code == 200
    evidence(world, waiting, seed_byte=4)
    admin = client_for(world, world.admin)

    def ids(**params: Any) -> list[str]:
        response = admin.get("/admin/verifications/decided", params=params)
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        return [item["asset_id"] for item in response.json()]

    everything = admin.get("/admin/verifications/decided").json()
    assert [item["asset_id"] for item in everything] == [revoked, rejected, approved]
    assert [item["run"]["level"] for item in everything] == ["revoked", "rejected", "verified"]
    assert everything[0]["last_decision_at"] == everything[0]["run"]["revoked_at"]
    assert everything[1]["run"]["reason"] == "Blurry"
    assert all(len(item["run"]["documents"]) == 2 for item in everything)
    assert ids(level="verified") == [approved]
    assert ids(level="rejected") == [rejected]
    assert ids(level="revoked") == [revoked]
    assert ids(limit=1, offset=1) == [rejected]
    assert ids(offset=3) == []
    for bad in ({"level": "documents_submitted"}, {"limit": 101}, {"offset": -1}):
        assert admin.get("/admin/verifications/decided", params=bad).status_code == 422
    statements, stop = _selects(world.session)
    try:
        verification.decided_listings(world.session, world.id)
    finally:
        stop()
    assert len(statements) == 2, statements


@requires_db
def test_decided_listings_are_world_scoped_and_admin_only(world: World_) -> None:
    asset = draft(world)
    verified(world, asset["id"])
    impartial = _person(world.session, world.id, "Second Admin", UserRole.ADMIN)
    _member(world.session, world.id, world.community_id, world.admin)
    elsewhere = create_world(world.session)
    other_admin = world.session.exec(
        select(User).where(User.world_id == elsewhere.id, User.role == UserRole.ADMIN)
    ).first()
    assert other_admin is not None
    path = "/admin/verifications/decided"

    mine = client_for(world, impartial).get(path).json()
    conflicted = client_for(world, world.admin).get(path).json()
    steward = client_for(world, world.steward).get(path)
    investor = client_for(world, world.outsider).get(path)
    other_world = client_for(world, other_admin).get(path)
    other_world_runs = client_for(world, other_admin).get(
        f"/assets/{asset['id']}/verification/runs"
    )

    assert [item["asset_id"] for item in mine] == [asset["id"]]
    assert conflicted == [], "an admin never reviews its own community's listings"
    assert (steward.status_code, steward.json()["detail"]) == (403, "admin_only")
    assert (investor.status_code, investor.json()["detail"]) == (403, "admin_only")
    assert TestClient(app).get(path).status_code == 401
    assert (other_world.status_code, other_world.json()) == (200, [])
    assert (other_world_runs.status_code, other_world_runs.json()["detail"]) == (404, "not_found")


@requires_db
def test_the_preview_never_reads_the_original(world: World_) -> None:
    asset_id = draft(world)["id"]
    document = uploaded(world, asset_id, png())
    statements, stop = _selects(world.session)
    try:
        _, preview = verification.document_bytes(
            world.session, world.id, UUID(asset_id), UUID(document), preview=True
        )
    finally:
        stop()

    assert preview is not None
    assert not [sql for sql in statements if "listing_document_blobs.content" in sql]


# ----- committed transactions: the deferred check, a binding race, the downgrade ----------------

committed = lifecycle.committed
QUOTA = verification.StorageQuota(10**9, 10**9)


def _store(c: Committed, asset_id: UUID, data: bytes, doc_type: DocumentType) -> UUID:
    with Session(c.engine) as session:
        document = verification.store_document(
            session,
            world_id=c.world_id,
            asset_id=asset_id,
            uploaded_by=c.owner_id,
            doc_type=doc_type,
            data=data,
            inspection=docs.inspect_document(data, "image/png"),
            secret="test",
            quota=QUOTA,
        )
        session.commit()
        return document.id


@requires_db
def test_a_run_commits_with_its_documents_and_nothing_can_be_linked_later(
    committed: Committed,
) -> None:
    asset_id = _committed_draft(committed)
    title = _store(committed, asset_id, png(), DocumentType.TITLE)
    minutes = _store(committed, asset_id, png(), DocumentType.ASSEMBLY_MINUTES)
    late = _store(committed, asset_id, png(), DocumentType.OTHER)
    with Session(committed.engine) as session:
        run = verification.submit_run(
            session,
            world_id=committed.world_id,
            asset_id=asset_id,
            submitted_by=committed.owner_id,
            document_ids=[title, minutes],
        ).run
        session.commit()  # the deferred check passes: 2 documents, as submitted
        run_id = run.id

    with Session(committed.engine) as session:
        session.add(
            VerificationRunDocument(
                run_id=run_id, document_id=late, world_id=committed.world_id, asset_id=asset_id
            )
        )
        with pytest.raises(DBAPIError, match="has 3 documents, not 2"):
            session.commit()

    with Session(committed.engine) as session:
        linked = session.exec(
            select(VerificationRunDocument.document_id).where(
                VerificationRunDocument.run_id == run_id
            )
        ).all()
        assert sorted(linked) == sorted([title, minutes])


@requires_db
def test_two_listings_binding_the_same_file_at_once_get_one_binding(
    committed: Committed,
) -> None:
    first, second = _committed_draft(committed), _committed_draft(committed, lat=9.2)
    data = png()
    bound = threading.Event()
    results: dict[str, str] = {}

    def hold_first() -> None:
        with Session(committed.engine) as session:
            verification.store_document(
                session,
                world_id=committed.world_id,
                asset_id=first,
                uploaded_by=committed.owner_id,
                doc_type=DocumentType.TITLE,
                data=data,
                inspection=docs.inspect_document(data, "image/png"),
                secret="test",
                quota=QUOTA,
            )
            bound.set()
            time.sleep(0.5)  # the second binding waits on this uncommitted row
            session.commit()
            results["first"] = "stored"

    def race_second() -> None:
        bound.wait(5)
        try:
            _store(committed, second, data, DocumentType.TITLE)
            results["second"] = "stored"
        except verification.VerificationRefused as exc:
            results["second"] = exc.code

    threads = [threading.Thread(target=hold_first), threading.Thread(target=race_second)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)

    assert results == {"first": "stored", "second": "document_reused"}


@requires_db
def test_the_migration_wont_drop_verification_ledger_entries(committed: Committed) -> None:
    cfg = alembic_cfg()
    asset_id = _committed_draft(committed)
    minutes = _store(committed, asset_id, png(), DocumentType.ASSEMBLY_MINUTES)
    with Session(committed.engine) as session:
        run = verification.submit_run(
            session,
            world_id=committed.world_id,
            asset_id=asset_id,
            submitted_by=committed.owner_id,
            document_ids=[minutes],
        ).run
        verification.reject(
            session,
            world_id=committed.world_id,
            asset_id=asset_id,
            run_id=run.id,
            reviewer=committed.owner_id,
            reason="Unreadable",
        )
        session.commit()
        run_id = run.id
    try:
        with pytest.raises(RuntimeError, match="verification ledger entries exist"):
            command.downgrade(cfg, "0015")
    finally:
        command.upgrade(cfg, "head")
    head = ScriptDirectory.from_config(cfg).get_current_head()
    with committed.engine.connect() as connection:
        version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
    assert version == head
    with Session(committed.engine) as session:
        linked = session.exec(
            select(VerificationRunDocument.document_id).where(
                VerificationRunDocument.run_id == run_id
            )
        ).all()
    assert linked == [minutes], "the run keeps its document whichever way the migrations ran"


@requires_db
def test_the_migration_wont_squeeze_a_carried_document_into_one_run(
    committed: Committed,
) -> None:
    """0022's downgrade: a document in two runs (#210) can't go back to a single `run_id`."""
    cfg = alembic_cfg()
    asset_id = _committed_draft(committed)
    minutes = _store(committed, asset_id, png(), DocumentType.ASSEMBLY_MINUTES)
    title = _store(committed, asset_id, png(), DocumentType.TITLE)
    with Session(committed.engine) as session:
        for document in (minutes, title):
            verification.submit_run(
                session,
                world_id=committed.world_id,
                asset_id=asset_id,
                submitted_by=committed.owner_id,
                document_ids=[document],
            )
        session.commit()
    try:
        with pytest.raises(RuntimeError, match="1 documents are linked to more than one"):
            command.downgrade(cfg, "0021")
    finally:
        command.upgrade(cfg, "head")
    with Session(committed.engine) as session:
        links = session.exec(
            select(VerificationRunDocument.document_id).where(
                VerificationRunDocument.asset_id == asset_id
            )
        ).all()
    assert sorted(links) == sorted([minutes, minutes, title])


@requires_db
def test_the_migration_moves_links_both_ways(committed: Committed) -> None:
    cfg = alembic_cfg()
    asset_id = _committed_draft(committed)
    minutes = _store(committed, asset_id, png(), DocumentType.ASSEMBLY_MINUTES)
    with Session(committed.engine) as session:
        run_id = verification.submit_run(
            session,
            world_id=committed.world_id,
            asset_id=asset_id,
            submitted_by=committed.owner_id,
            document_ids=[minutes],
        ).run.id
        session.commit()
    try:
        command.downgrade(cfg, "0021")
        with committed.engine.connect() as connection:
            restored = connection.execute(
                text("SELECT run_id FROM listing_documents WHERE id = :id"), {"id": minutes}
            ).scalar()
        assert restored == run_id
    finally:
        command.upgrade(cfg, "head")
    with Session(committed.engine) as session:
        links = session.exec(
            select(VerificationRunDocument.document_id).where(
                VerificationRunDocument.run_id == run_id
            )
        ).all()
    assert links == [minutes]

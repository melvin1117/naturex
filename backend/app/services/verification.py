"""Listing verification (T69, ADR-0006 review mode): documents, runs, decisions and the gate.

Rules and hashes live in `app.tools.verification` (pure) and file safety in
`app.tools.documents`; this module loads state, applies a step and records it.

- **Upload** (`store_document`): the file was inspected in a worker before any lock. Its
  private fingerprint is bound to the asset in `document_fingerprints` (insert or find the
  binding): a file already bound to another listing is refused `document_reused`.
- **Submit** (`submit_run`): a new current run (the previous one is superseded), with its
  checklist and input fingerprint, over 1–3 of the listing's not-yet-submitted documents plus,
  while the current run still waits for a decision, that run's documents (#210): the reviewer
  sees everything the steward submitted. The steward may leave some of them out; past 3 in all
  it's `submission_full`. After a decision a submission starts afresh.
- **Decide** (`approve`, `reject`): an impartial admin decides the current, undecided run, once.
  Approval needs the run's fingerprint to still match the listing (`stale_run`), no failed check
  (`checks_failed`) and no overlap now (`overlap`); it resumes trading on an asset suspended by
  a revocation. Each decision appends a `verification` ledger entry.
- **Revoke** (`revoke`): the current verified run becomes `revoked` and a listed asset is
  suspended (`verification_revoked`) in the same transaction, with both ledger entries.
- **The gate** (`gate_refusal`): in the live world the IPO needs the current run `verified`, in
  review mode with real evidence and a matching fingerprint; in every world a revoked current
  run blocks it. Sandboxes are otherwise ungated until T76's demo mode verifies their listings.

Ledger payloads hold the level, the reviewer's role, the method version, mode and evidence
kind, check results, the input fingerprint, the documents' types and randomized commitments,
and the hash of the reviewer's reason: never documents, raw file hashes, names or account IDs.

Locks follow `app.services.listings`: the world row (`FOR KEY SHARE`) → the world's listing
lock (submit and decisions, which read overlaps and may suspend or resume) → the asset row →
the run row → the publisher lock (inside `publish`).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, text, update
from sqlmodel import Session, col, select

from app.events import publish
from app.ledger import append
from app.models import (
    Asset,
    AssetStatus,
    DocumentFingerprint,
    DocumentType,
    EvidenceKind,
    LedgerKind,
    ListingDocument,
    ListingDocumentBlob,
    ReviewerRole,
    StreamEventType,
    VerificationLevel,
    VerificationMode,
    VerificationRun,
    VerificationRunDocument,
)
from app.services.lifecycle import TERMINAL_STATUSES, ListingEvent, SuspensionReason, transition
from app.services.listings import (
    OVERLAP,
    audience,
    lock_asset,
    lock_listings,
    overlap_candidates,
    record,
)
from app.tools.documents import Inspection
from app.tools.geometry import geometry_bbox, overlapping
from app.tools.verification import (
    METHOD_VERSION,
    NOT_VERIFIED,
    DocumentFacts,
    ListingFacts,
    checklist,
    document_commitments,
    failed_checks,
    input_fingerprint,
    new_commitment,
    new_reason_salt,
    private_fingerprint,
    public_checks,
    reason_commitment,
    world_document_key,
)
from app.worlds import LIVE_WORLD_ID

MAX_DOCUMENTS_PER_ASSET = 20
"""Documents a listing may hold in total (every run's included), so uploads can't fill the DB."""
MAX_RUN_DOCUMENTS = 3
"""Documents one run covers (ADR-0006 §2), carried-over ones included."""
DECIDED_LEVELS = (VerificationLevel.VERIFIED, VerificationLevel.REJECTED, VerificationLevel.REVOKED)

# Refusal codes (HTTP 409 unless noted).
LISTING_CLOSED = "listing_closed"
DOCUMENT_LIMIT_REACHED = "document_limit_reached"
DOCUMENT_REUSED = "document_reused"
DOCUMENT_ALREADY_SUBMITTED = "document_already_submitted"
DOCUMENT_NOT_IN_SUBMISSION = "document_not_in_submission"
SUBMISSION_FULL = "submission_full"
RUN_SUPERSEDED = "run_superseded"
RUN_ALREADY_DECIDED = "run_already_decided"
STALE_RUN = "stale_run"
CHECKS_FAILED = "checks_failed"
STORAGE_QUOTA_EXCEEDED = "storage_quota_exceeded"


class VerificationRefused(Exception):
    """The step isn't possible now (HTTP 409 `code`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DocumentNotFound(LookupError):
    """A document ID that isn't one of this listing's (HTTP 404 `document_not_found`)."""


class RunNotFound(LookupError):
    """A run ID that isn't one of this listing's (HTTP 404 `run_not_found`)."""


@dataclass(frozen=True, slots=True)
class RunView:
    """A run with its documents and whether it still describes the listing."""

    run: VerificationRun
    documents: list[ListingDocument]
    fingerprint_matches: bool

    @property
    def effective_level(self) -> VerificationLevel:
        """`unverified` once the listing changed since the run, else the run's level."""
        return self.run.level if self.fingerprint_matches else VerificationLevel.UNVERIFIED


# ----- reads ------------------------------------------------------------------------------------


def listing_facts(asset: Asset) -> ListingFacts:
    return ListingFacts(asset.community_id, asset.name, asset.geojson, asset.area_ha)


_DOCUMENT_ORDER = (col(ListingDocument.created_at), col(ListingDocument.id))


def documents_of(session: Session, world_id: UUID, asset_id: UUID) -> list[ListingDocument]:
    """The listing's documents, submitted or not, oldest first."""
    query = select(ListingDocument).where(
        ListingDocument.world_id == world_id, ListingDocument.asset_id == asset_id
    )
    return list(session.exec(query.order_by(*_DOCUMENT_ORDER)).all())


def linked_documents(
    session: Session, world_id: UUID, run_ids: Iterable[UUID]
) -> dict[UUID, list[ListingDocument]]:
    """Each run's documents, oldest first, in one query (runs without any are left out)."""
    wanted = list(run_ids)
    if not wanted:
        return {}
    rows = session.exec(
        select(VerificationRunDocument.run_id, ListingDocument)
        .join(
            ListingDocument,
            (col(ListingDocument.world_id) == col(VerificationRunDocument.world_id))
            & (col(ListingDocument.asset_id) == col(VerificationRunDocument.asset_id))
            & (col(ListingDocument.id) == col(VerificationRunDocument.document_id)),
        )
        .where(
            VerificationRunDocument.world_id == world_id,
            col(VerificationRunDocument.run_id).in_(wanted),
        )
        .order_by(*_DOCUMENT_ORDER)
    ).all()
    linked: dict[UUID, list[ListingDocument]] = {}
    for run_id, document in rows:
        linked.setdefault(run_id, []).append(document)
    return linked


def submitted_ids(session: Session, world_id: UUID, asset_id: UUID) -> set[UUID]:
    """The listing's documents that are in a run."""
    return set(
        session.exec(
            select(VerificationRunDocument.document_id).where(
                VerificationRunDocument.world_id == world_id,
                VerificationRunDocument.asset_id == asset_id,
            )
        ).all()
    )


def _fingerprint_now(
    asset: Asset, run: VerificationRun, documents: Sequence[ListingDocument]
) -> str:
    return input_fingerprint(
        listing_facts(asset),
        [(document.doc_type, document.commitment) for document in documents],
        method_version=run.method_version,
        mode=run.mode,
        evidence_kind=run.evidence_kind,
    )


def view_of(session: Session, asset: Asset, run: VerificationRun) -> RunView:
    documents = linked_documents(session, asset.world_id, [run.id]).get(run.id, [])
    matches = _fingerprint_now(asset, run, documents) == run.input_fingerprint
    return RunView(run, documents, matches)


def current_run(session: Session, world_id: UUID, asset_id: UUID) -> VerificationRun | None:
    return session.exec(
        select(VerificationRun).where(
            VerificationRun.world_id == world_id,
            VerificationRun.asset_id == asset_id,
            col(VerificationRun.is_current),
        )
    ).one_or_none()


def current_view(session: Session, asset: Asset) -> RunView | None:
    run = current_run(session, asset.world_id, asset.id)
    return None if run is None else view_of(session, asset, run)


def runs_of(session: Session, asset: Asset) -> list[RunView]:
    """Every run of the listing, newest first, with its documents."""
    runs = session.exec(
        select(VerificationRun)
        .where(VerificationRun.world_id == asset.world_id, VerificationRun.asset_id == asset.id)
        .order_by(col(VerificationRun.created_at).desc(), col(VerificationRun.id))
    ).all()
    by_run = linked_documents(session, asset.world_id, [run.id for run in runs])
    views = []
    for run in runs:
        linked = by_run.get(run.id, [])
        matches = _fingerprint_now(asset, run, linked) == run.input_fingerprint
        views.append(RunView(run, linked, matches))
    return views


def is_verified(view: RunView | None) -> bool:
    """The IPO's rule: a verified review-mode run on real evidence that still matches."""
    return (
        view is not None
        and view.fingerprint_matches
        and view.run.level is VerificationLevel.VERIFIED
        and view.run.mode is VerificationMode.REVIEW
        and view.run.evidence_kind is EvidenceKind.REAL
    )


def gate_refusal(session: Session, asset: Asset) -> str | None:
    """Why the asset may not launch its IPO now (`not_verified`), or None. See the module
    docstring: live-world assets need a verified run; a revocation not yet cleared by an
    approval (`assets.verification_revoked_at`) blocks in every world."""
    if asset.verification_revoked_at is not None:
        return NOT_VERIFIED
    if asset.world_id == LIVE_WORLD_ID and not is_verified(current_view(session, asset)):
        return NOT_VERIFIED
    return None


def _current_runs(
    session: Session,
    world_id: UUID,
    levels: Sequence[VerificationLevel],
    exclude_communities: Iterable[UUID],
    *,
    newest_first: bool,
    limit: int,
    offset: int,
    asset_id: UUID | None = None,
) -> list[tuple[Asset, RunView]]:
    """Listings whose current run is at one of `levels`, without the excluded communities'
    listings: one page, in two queries (the runs with their assets, then their documents).
    Oldest submission first, or newest decision (a revocation, else the decision) first."""
    query = (
        select(VerificationRun, Asset)
        .join(
            Asset,
            (col(Asset.world_id) == col(VerificationRun.world_id))
            & (col(Asset.id) == col(VerificationRun.asset_id)),
        )
        .where(
            VerificationRun.world_id == world_id,
            col(VerificationRun.is_current),
            col(VerificationRun.level).in_(list(levels)),
        )
    )
    if newest_first:
        decided = func.coalesce(col(VerificationRun.revoked_at), col(VerificationRun.decided_at))
        query = query.order_by(decided.desc(), col(VerificationRun.id))
    else:
        query = query.order_by(col(VerificationRun.created_at), col(VerificationRun.id))
    if asset_id is not None:
        query = query.where(VerificationRun.asset_id == asset_id)
    excluded = list(exclude_communities)
    if excluded:
        query = query.where(
            col(Asset.community_id).is_(None) | col(Asset.community_id).not_in(excluded)
        )
    rows = session.exec(query.offset(offset).limit(limit)).all()
    linked = linked_documents(session, world_id, [run.id for run, _ in rows])
    out = []
    for run, asset in rows:
        docs = linked.get(run.id, [])
        out.append(
            (asset, RunView(run, docs, _fingerprint_now(asset, run, docs) == run.input_fingerprint))
        )
    return out


def review_queue(
    session: Session,
    world_id: UUID,
    exclude_communities: Iterable[UUID] = (),
    *,
    limit: int = 50,
    offset: int = 0,
    asset_id: UUID | None = None,
) -> list[tuple[Asset, RunView]]:
    """Current runs waiting for a decision, oldest first, without the excluded communities'
    listings (an admin never reviews its own community's): one page, in two queries. With
    `asset_id`, only that listing's (at most one: one run is current per asset)."""
    return _current_runs(
        session,
        world_id,
        [VerificationLevel.DOCUMENTS_SUBMITTED],
        exclude_communities,
        newest_first=False,
        limit=limit,
        offset=offset,
        asset_id=asset_id,
    )


def decided_listings(
    session: Session,
    world_id: UUID,
    exclude_communities: Iterable[UUID] = (),
    *,
    level: VerificationLevel | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[tuple[Asset, RunView]]:
    """Listings whose current run was decided (verified, rejected or revoked; one `level` if
    given), the latest decision first, without the excluded communities' listings (#211): one
    page, in two queries. A listing with a newer submission waiting is in the queue instead."""
    if level is not None and level not in DECIDED_LEVELS:
        raise ValueError(f"{level} isn't a decision")
    return _current_runs(
        session,
        world_id,
        [level] if level is not None else DECIDED_LEVELS,
        exclude_communities,
        newest_first=True,
        limit=limit,
        offset=offset,
    )


def document_bytes(
    session: Session, world_id: UUID, asset_id: UUID, document_id: UUID, *, preview: bool = False
) -> tuple[ListingDocument, bytes | None]:
    """A document and either its original bytes or its preview (`preview=True`), by
    `(world_id, asset_id, id)`; only that column is read. Raises DocumentNotFound."""
    column = ListingDocumentBlob.preview_png if preview else ListingDocumentBlob.content
    found = session.exec(
        select(ListingDocument, column)
        .join(
            ListingDocumentBlob,
            col(ListingDocumentBlob.document_id) == col(ListingDocument.id),
        )
        .where(
            ListingDocument.world_id == world_id,
            ListingDocument.asset_id == asset_id,
            ListingDocument.id == document_id,
            ListingDocumentBlob.world_id == world_id,
            ListingDocumentBlob.asset_id == asset_id,
        )
    ).one_or_none()
    if found is None:
        raise DocumentNotFound(document_id)
    document, data = found
    return document, data


# ----- upload -----------------------------------------------------------------------------------


def documents_held(session: Session, world_id: UUID, asset_id: UUID) -> int:
    """How many documents the listing holds (every run's and unsubmitted ones)."""
    return session.exec(
        select(func.count()).where(
            ListingDocument.world_id == world_id, ListingDocument.asset_id == asset_id
        )
    ).one()


def _open_listing(session: Session, world_id: UUID, asset_id: UUID) -> Asset:
    asset = lock_asset(session, world_id, asset_id)
    if asset.status in TERMINAL_STATUSES:
        raise VerificationRefused(LISTING_CLOSED)
    return asset


@dataclass(frozen=True, slots=True)
class StorageQuota:
    """The most document bytes a community's listings, and a whole world, may hold."""

    community_bytes: int
    world_bytes: int


def bytes_stored(session: Session, world_id: UUID, community_id: UUID | None) -> tuple[int, int]:
    """Document bytes held by the community's listings and by the whole world."""
    world_total = session.exec(
        select(func.coalesce(func.sum(ListingDocument.size_bytes), 0)).where(
            ListingDocument.world_id == world_id
        )
    ).one()
    community_total = 0
    if community_id is not None:
        community_total = session.exec(
            select(func.coalesce(func.sum(ListingDocument.size_bytes), 0))
            .join(
                Asset,
                (col(Asset.world_id) == col(ListingDocument.world_id))
                & (col(Asset.id) == col(ListingDocument.asset_id)),
            )
            .where(ListingDocument.world_id == world_id, Asset.community_id == community_id)
        ).one()
    return int(community_total), int(world_total)


def check_quota(
    session: Session, world_id: UUID, community_id: UUID | None, size: int, quota: StorageQuota
) -> None:
    """Raises VerificationRefused(`storage_quota_exceeded`) if `size` more bytes won't fit."""
    community_total, world_total = bytes_stored(session, world_id, community_id)
    if (
        community_id is not None and community_total + size > quota.community_bytes
    ) or world_total + size > quota.world_bytes:
        raise VerificationRefused(STORAGE_QUOTA_EXCEEDED)


def _bind(session: Session, world_id: UUID, fingerprint: str, asset: Asset) -> None:
    """Bind the file to `asset` (ADR-0006 §2, clarified by T69): free, or already this
    listing's, or held by a withdrawn or ineligible listing **of the same community**, whose
    binding is then retired. Anything else is `document_reused`. Serialized per fingerprint by a
    transaction advisory lock; the partial unique index on active bindings backs it up."""
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"document-fingerprint:{world_id}:{fingerprint}"},
    )
    active = session.exec(
        select(DocumentFingerprint).where(
            DocumentFingerprint.world_id == world_id,
            DocumentFingerprint.private_fingerprint == fingerprint,
            col(DocumentFingerprint.active),
        )
    ).one_or_none()
    if active is not None and active.asset_id == asset.id:
        return
    if active is not None:
        holder = session.exec(
            select(Asset.community_id, Asset.status).where(
                Asset.world_id == world_id, Asset.id == active.asset_id
            )
        ).one()
        community_id, holder_status = holder
        released = AssetStatus(holder_status) in TERMINAL_STATUSES
        if not (released and community_id is not None and community_id == asset.community_id):
            raise VerificationRefused(DOCUMENT_REUSED)
        active.active = False
        session.add(active)
        session.flush()
    session.add(
        DocumentFingerprint(
            world_id=world_id, private_fingerprint=fingerprint, asset_id=asset.id, active=True
        )
    )
    session.flush()


def store_document(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    uploaded_by: UUID,
    doc_type: DocumentType,
    data: bytes,
    inspection: Inspection,
    secret: str,
    quota: StorageQuota,
) -> ListingDocument:
    """Store an inspected upload for the listing (the caller authorized MANAGE_LISTING and
    commits). Raises LookupError, or VerificationRefused: `listing_closed`,
    `document_limit_reached`, `storage_quota_exceeded`, `document_reused`.

    Takes the world's listing lock after the world row, so quota checks in one world can't
    race; the worker inspection happened before, with no lock held."""
    fingerprint = private_fingerprint(world_document_key(secret, world_id), data)
    lock_listings(session, world_id)
    asset = _open_listing(session, world_id, asset_id)
    if documents_held(session, world_id, asset.id) >= MAX_DOCUMENTS_PER_ASSET:
        raise VerificationRefused(DOCUMENT_LIMIT_REACHED)
    check_quota(session, world_id, asset.community_id, len(data), quota)
    _bind(session, world_id, fingerprint, asset)
    nonce, commitment = new_commitment(data)
    document = ListingDocument(
        world_id=world_id,
        asset_id=asset.id,
        doc_type=doc_type,
        media_type=inspection.media_type,
        size_bytes=len(data),
        page_count=inspection.page_count,
        width=inspection.width,
        height=inspection.height,
        has_preview=inspection.preview_png is not None,
        private_fingerprint=fingerprint,
        commitment=commitment,
        commitment_nonce=nonce,
        uploaded_by=uploaded_by,
    )
    session.add(document)
    session.flush()
    session.add(
        ListingDocumentBlob(
            document_id=document.id,
            world_id=world_id,
            asset_id=asset.id,
            content=data,
            preview_png=inspection.preview_png,
        )
    )
    session.flush()
    return document


# ----- submit -----------------------------------------------------------------------------------


def _overlaps_now(session: Session, asset: Asset) -> int:
    candidates = overlap_candidates(
        session,
        asset.world_id,
        asset.community_id,
        geometry_bbox(asset.geojson),
        exclude=asset.id,
    )
    return len(overlapping(asset.geojson, candidates)) if candidates else 0


def submit_run(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    submitted_by: UUID,
    document_ids: Sequence[UUID],
    remove_document_ids: Sequence[UUID] = (),
) -> RunView:
    """A new current run, superseding the current one, over `document_ids` (1–3 distinct, the
    listing's own, never submitted before) plus, while the current run still waits for a
    decision, that run's documents except `remove_document_ids` (#210): adding a document
    keeps what the reviewer already had. At most MAX_RUN_DOCUMENTS in all. A decided run's
    documents don't carry over: after a decision a submission starts afresh. The caller
    authorized MANAGE_LISTING and commits. Raises LookupError, DocumentNotFound, or
    VerificationRefused: `listing_closed`, `document_already_submitted`,
    `document_not_in_submission` (a removed ID that isn't in the waiting run),
    `submission_full`."""
    wanted = list(dict.fromkeys(document_ids))
    if not 1 <= len(wanted) <= MAX_RUN_DOCUMENTS or len(wanted) != len(document_ids):
        raise ValueError("a run takes 1 to 3 distinct new documents")
    removed = set(remove_document_ids)
    lock_listings(session, world_id)
    asset = _open_listing(session, world_id, asset_id)
    waiting = current_run(session, world_id, asset.id)
    carried: list[ListingDocument] = []
    if waiting is not None and waiting.level is VerificationLevel.DOCUMENTS_SUBMITTED:
        carried = linked_documents(session, world_id, [waiting.id]).get(waiting.id, [])
    if not removed <= {document.id for document in carried}:
        raise VerificationRefused(DOCUMENT_NOT_IN_SUBMISSION)
    added = list(
        session.exec(
            select(ListingDocument)
            .where(
                ListingDocument.world_id == world_id,
                ListingDocument.asset_id == asset.id,
                col(ListingDocument.id).in_(wanted),
            )
            .order_by(*_DOCUMENT_ORDER)
            .with_for_update()
        ).all()
    )
    if len(added) != len(wanted):
        raise DocumentNotFound(set(wanted) - {document.id for document in added})
    already = session.exec(
        select(VerificationRunDocument.document_id)
        .where(
            VerificationRunDocument.world_id == world_id,
            VerificationRunDocument.asset_id == asset.id,
            col(VerificationRunDocument.document_id).in_(wanted),
        )
        .limit(1)
    ).first()
    if already is not None:
        raise VerificationRefused(DOCUMENT_ALREADY_SUBMITTED)
    documents = sorted(
        [document for document in carried if document.id not in removed] + added,
        key=lambda document: (document.created_at, document.id),
    )
    if len(documents) > MAX_RUN_DOCUMENTS:
        raise VerificationRefused(SUBMISSION_FULL)
    bindings = dict(
        session.exec(
            select(DocumentFingerprint.private_fingerprint, DocumentFingerprint.asset_id).where(
                DocumentFingerprint.world_id == world_id,
                col(DocumentFingerprint.active),
                col(DocumentFingerprint.private_fingerprint).in_(
                    [document.private_fingerprint for document in documents]
                ),
            )
        ).all()
    )
    facts = [
        DocumentFacts(
            doc_type=document.doc_type,
            media_type=document.media_type,
            page_count=document.page_count,
            width=document.width,
            height=document.height,
            private_fingerprint=document.private_fingerprint,
            # A binding retired since the upload (never for an open listing) counts as elsewhere.
            bound_asset_id=bindings.get(document.private_fingerprint, UUID(int=0)),
            commitment=document.commitment,
        )
        for document in documents
    ]
    items = checklist(asset.id, facts, _overlaps_now(session, asset))
    session.execute(
        update(VerificationRun)
        .where(
            col(VerificationRun.world_id) == world_id,
            col(VerificationRun.asset_id) == asset.id,
            col(VerificationRun.is_current),
        )
        .values(is_current=False)
    )
    run = VerificationRun(
        world_id=world_id,
        asset_id=asset.id,
        level=VerificationLevel.DOCUMENTS_SUBMITTED,
        input_fingerprint=input_fingerprint(
            listing_facts(asset), [(d.doc_type, d.commitment) for d in documents]
        ),
        checklist=items,
        method_version=METHOD_VERSION,
        mode=VerificationMode.REVIEW,
        evidence_kind=EvidenceKind.REAL,
        document_count=len(documents),
        reason_salt=new_reason_salt(),
        submitted_by=submitted_by,
    )
    session.add(run)
    session.flush()
    session.add_all(
        VerificationRunDocument(
            run_id=run.id, document_id=document.id, world_id=world_id, asset_id=asset.id
        )
        for document in documents
    )
    session.flush()
    _publish(session, asset, run, private=True)
    return RunView(run, documents, True)


# ----- decisions --------------------------------------------------------------------------------


def _decidable(
    session: Session, world_id: UUID, asset_id: UUID, run_id: UUID
) -> tuple[Asset, VerificationRun]:
    lock_listings(session, world_id)
    asset = lock_asset(session, world_id, asset_id)
    run = session.exec(
        select(VerificationRun)
        .where(
            VerificationRun.world_id == world_id,
            VerificationRun.asset_id == asset.id,
            VerificationRun.id == run_id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    ).one_or_none()
    if run is None:
        raise RunNotFound(run_id)
    if not run.is_current:
        raise VerificationRefused(RUN_SUPERSEDED)
    return asset, run


def _ledger_payload(asset: Asset, view: RunView) -> dict[str, Any]:
    run = view.run
    payload: dict[str, Any] = {
        "level": run.level.value,
        "run_id": str(run.id),
        "community_id": str(asset.community_id) if asset.community_id else None,
        "reviewer_role": run.reviewer_role.value if run.reviewer_role else None,
        "method_version": run.method_version,
        "mode": run.mode.value,
        "evidence_kind": run.evidence_kind.value,
        "checks": public_checks(run.checklist),
        "input_fingerprint": run.input_fingerprint,
        "document_commitments": document_commitments(
            [(document.doc_type, document.commitment) for document in view.documents]
        ),
        "reason_commitment": reason_commitment(run.reason_salt, "decision", run.reason),
        "decided_at": run.decided_at.isoformat() if run.decided_at else None,
    }
    if run.level is VerificationLevel.REVOKED:
        payload["revoke_reason_commitment"] = reason_commitment(
            run.reason_salt, "revocation", run.revoke_reason
        )
        payload["revoked_at"] = run.revoked_at.isoformat() if run.revoked_at else None
    return payload


def _publish(session: Session, asset: Asset, run: VerificationRun, *, private: bool) -> None:
    """A `listing_status` event (`transition: verification`) with IDs and the level only. A
    submission is for the community and admins; a decision follows the asset's visibility."""
    publish(
        session,
        asset.world_id,
        StreamEventType.LISTING_STATUS,
        {
            "asset_id": str(asset.id),
            "community_id": str(asset.community_id) if asset.community_id else None,
            "transition": "verification",
            "run_id": str(run.id),
            "level": run.level.value,
        },
        audience=(asset.community_id or audience(asset)) if private else audience(asset),
    )


def _record_decision(session: Session, asset: Asset, view: RunView) -> None:
    session.add(view.run)
    session.flush()
    append(
        session,
        world_id=asset.world_id,
        asset_id=asset.id,
        kind=LedgerKind.VERIFICATION,
        payload=_ledger_payload(asset, view),
        ref_id=view.run.id,
    )


def approve(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    run_id: UUID,
    reviewer: UUID,
    reason: str | None,
    now: datetime | None = None,
) -> RunView:
    """documents_submitted → verified. The caller authorized REVIEW_LISTING and commits.
    Raises LookupError, RunNotFound, or VerificationRefused: `run_superseded`,
    `run_already_decided`, `listing_closed`, `stale_run`, `checks_failed`, `overlap`."""
    asset, run = _decidable(session, world_id, asset_id, run_id)
    if run.level is not VerificationLevel.DOCUMENTS_SUBMITTED:
        raise VerificationRefused(RUN_ALREADY_DECIDED)
    if asset.status in TERMINAL_STATUSES:
        raise VerificationRefused(LISTING_CLOSED)
    view = view_of(session, asset, run)
    if not view.fingerprint_matches:
        raise VerificationRefused(STALE_RUN)
    if failed_checks(run.checklist):
        raise VerificationRefused(CHECKS_FAILED)
    if _overlaps_now(session, asset):
        raise VerificationRefused(OVERLAP)
    run.level = VerificationLevel.VERIFIED
    run.reviewer_role = ReviewerRole.PLATFORM_ADMIN
    run.reviewer_user_id = reviewer
    run.reason = reason
    run.decided_at = now or datetime.now(UTC)
    _record_decision(session, asset, view)
    if asset.verification_revoked_at is not None:
        asset.verification_revoked_at = None  # only an approval clears a revocation
        session.add(asset)
        session.flush()
    if (
        asset.status is AssetStatus.SUSPENDED
        and asset.status_reason == SuspensionReason.VERIFICATION_REVOKED.value
    ):
        record(session, asset, transition(asset.status, ListingEvent.RESUME))
    _publish(session, asset, run, private=False)
    return view


def reject(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    run_id: UUID,
    reviewer: UUID,
    reason: str,
    now: datetime | None = None,
) -> RunView:
    """documents_submitted → rejected, with the reason the steward sees. Raises like
    `approve` (`run_superseded`, `run_already_decided`)."""
    if not reason:
        raise ValueError("a rejection needs a reason")
    asset, run = _decidable(session, world_id, asset_id, run_id)
    if run.level is not VerificationLevel.DOCUMENTS_SUBMITTED:
        raise VerificationRefused(RUN_ALREADY_DECIDED)
    run.level = VerificationLevel.REJECTED
    run.reviewer_role = ReviewerRole.PLATFORM_ADMIN
    run.reviewer_user_id = reviewer
    run.reason = reason
    run.decided_at = now or datetime.now(UTC)
    view = view_of(session, asset, run)
    _record_decision(session, asset, view)
    _publish(session, asset, run, private=False)
    return view


def revoke(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    run_id: UUID,
    revoked_by: UUID,
    reason: str,
    now: datetime | None = None,
) -> RunView:
    """verified → revoked, and a listed asset → suspended (`verification_revoked`), at once:
    orders are refused until a new run is approved. Raises RunNotFound, or
    VerificationRefused: `run_superseded`, `not_verified` (the run isn't verified)."""
    if not reason:
        raise ValueError("a revocation needs a reason")
    asset, run = _decidable(session, world_id, asset_id, run_id)
    if run.level is not VerificationLevel.VERIFIED:
        raise VerificationRefused(NOT_VERIFIED)
    run.level = VerificationLevel.REVOKED
    run.revoked_by = revoked_by
    run.revoke_reason = reason
    run.revoked_at = now or datetime.now(UTC)
    view = view_of(session, asset, run)
    _record_decision(session, asset, view)
    # Until an admin approves a new run: no resume, no IPO, whatever runs are submitted.
    asset.verification_revoked_at = run.revoked_at
    session.add(asset)
    session.flush()
    if asset.status is AssetStatus.LISTED:
        step = transition(
            asset.status, ListingEvent.SUSPEND, suspension=SuspensionReason.VERIFICATION_REVOKED
        )
        record(session, asset, step)
    _publish(session, asset, run, private=False)
    return view

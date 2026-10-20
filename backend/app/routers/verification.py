"""Listing verification routes (T69, ADR-0006 review mode; rules in `app.services.verification`).

Steward (the listing's community owner or stewards, `MANAGE_LISTING`):

- `POST /assets/{id}/documents?doc_type=…`: upload one document; the request body is the file
  (`Content-Type: application/pdf | image/jpeg | image/png`, ≤ 5 MB). It's inspected in a worker
  with a timeout before anything is stored (`app.tools.documents`).
- `POST /assets/{id}/verification/runs`: submit 1–3 uploaded documents for review.

The listing's community members and same-world admins (`VIEW_COMMUNITY_DATA`; **404 for anyone
else**, so a document's existence never leaks): `GET /assets/{id}/documents`, the file itself at
`GET /assets/{id}/documents/{document_id}` (always a download: `Content-Disposition:
attachment`, `nosniff`, `no-store`), its sanitised PNG preview at `…/preview`, and every run
with its checklist at `GET /assets/{id}/verification/runs`.

Anyone who can see the asset: `GET /assets/{id}/verification`, the public "How this listing was
verified" panel (check names and results only, plus what was not checked).

Reviewer (an admin, never on its own community's listing, `REVIEW_LISTING`): the queue at
`GET /admin/verifications`, and `POST /admin/assets/{id}/verification/{run_id}/approve`,
`…/reject` and `…/revoke` (the last two need a reason). A refused step is 409 with a code.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlmodel import Session, col, select

from app.auth import AttemptsBusy, RateLimit, bucket_key, consume_attempt
from app.authz import (
    Action,
    Allow,
    AssetRef,
    Deny,
    DenyReason,
    Granted,
    OptionalActor,
    asset_ref,
    authorize,
    authorizes,
    deny_error,
    require,
)
from app.config import Settings, document_fingerprint_secret, rate_limit_secret
from app.deps import SessionDep, SettingsDep
from app.models import (
    Asset,
    AuthAttemptKind,
    AuthBucket,
    DocumentType,
    LedgerEntry,
    LedgerKind,
    VerificationLevel,
)
from app.schemas import (
    AssetStatusOut,
    ListingDocumentOut,
    PublicCheckOut,
    ReviewQueueItem,
    VerificationApprove,
    VerificationCheckOut,
    VerificationPublicOut,
    VerificationReason,
    VerificationRunOut,
    VerificationSubmit,
)
from app.services import verification
from app.services.listings import OVERLAP
from app.services.verification import (
    CHECKS_FAILED,
    DOCUMENT_ALREADY_SUBMITTED,
    DOCUMENT_LIMIT_REACHED,
    DOCUMENT_REUSED,
    LISTING_CLOSED,
    RUN_ALREADY_DECIDED,
    RUN_SUPERSEDED,
    STALE_RUN,
    STORAGE_QUOTA_EXCEEDED,
    DocumentNotFound,
    RunNotFound,
    RunView,
    StorageQuota,
    VerificationRefused,
)
from app.tools.documents import (
    ACCEPTED_MEDIA_TYPES,
    MAX_DOCUMENT_BYTES,
    DocumentRejected,
    release_slot,
    run_worker,
    try_acquire_slot,
)
from app.tools.verification import NOT_CHECKED, NOT_VERIFIED, badge, public_checks

router = APIRouter(tags=["verification"])

NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"
LENGTH_REQUIRED = "length_required"
FILE_TOO_LARGE = "file_too_large"
UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
INSPECTION_BUSY = "inspection_busy"
UPLOAD_RATE_LIMITED = "upload_rate_limited"
UPLOAD_WINDOW = timedelta(hours=1)
NO_PREVIEW = "no_preview"
_EXTENSIONS = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png"}
# Served bytes are never rendered by the API's origin: a download, no sniffing, no caching,
# no scripts or subresources even if a browser did render it.
_FILE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": NO_STORE,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
}

Responses = dict[int | str, dict[str, Any]]
_AUTH: Responses = {401: {"description": "auth_required"}}
_HIDDEN: Responses = {
    404: {
        "description": "`not_found`: outside the caller's world, or the caller isn't a member "
        "of the listing's community or a same-world admin"
    }
}

ManageListing = Annotated[Granted, require(Action.MANAGE_LISTING, asset_ref)]
ReviewListing = Annotated[Granted, require(Action.REVIEW_LISTING, asset_ref)]
ReviewQueue = Annotated[Granted, require(Action.REVIEW_LISTING)]
BrowseAsset = Annotated[Granted, require(Action.BROWSE, asset_ref)]


def _signed_in(actor: OptionalActor) -> None:
    if actor is None:
        raise deny_error(Deny(DenyReason.AUTH_REQUIRED))


@authorizes(Action.VIEW_COMMUNITY_DATA)
def community_evidence(
    actor: OptionalActor,
    _gate: None = Depends(_signed_in),  # noqa: B008 - before the asset is looked up
    resource: AssetRef | None = Depends(asset_ref),  # noqa: B008
) -> Granted:
    """The listing's community members and same-world admins (ADR-0006 §5). Every other
    signed-in caller gets 404, never 403: a 403 would confirm the listing has documents."""
    if resource is None or not isinstance(
        authorize(actor, Action.VIEW_COMMUNITY_DATA, resource), Allow
    ):
        raise deny_error(Deny(DenyReason.NOT_FOUND))
    return Granted(actor, resource)


CommunityEvidence = Annotated[Granted, Depends(community_evidence)]


def _ref(granted: Granted) -> AssetRef:
    ref = granted.resource
    if not isinstance(ref, AssetRef):  # pragma: no cover - the loaders guarantee it
        raise TypeError(ref)
    return ref


def _asset(session: Session, granted: Granted) -> Asset:
    ref = _ref(granted)
    asset = session.exec(
        select(Asset).where(Asset.world_id == ref.world_id, Asset.id == ref.asset_id)
    ).one_or_none()
    if asset is None:
        raise _missing()
    return asset


def _missing(detail: str = "not_found") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail, headers={"Cache-Control": NO_STORE})


def _refused(code: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, code, headers={"Cache-Control": NO_STORE})


def _document_out(document: Any) -> ListingDocumentOut:
    return ListingDocumentOut.model_validate(document)


def run_out(view: RunView) -> VerificationRunOut:
    run = view.run
    return VerificationRunOut(
        id=run.id,
        asset_id=run.asset_id,
        level=run.level,
        effective_level=view.effective_level,
        is_current=run.is_current,
        fingerprint_matches=view.fingerprint_matches,
        input_fingerprint=run.input_fingerprint,
        method_version=run.method_version,
        mode=run.mode,
        evidence_kind=run.evidence_kind,
        checklist=[VerificationCheckOut.model_validate(item) for item in run.checklist],
        documents=[_document_out(document) for document in view.documents],
        created_at=run.created_at,
        reviewer_role=run.reviewer_role,
        reason=run.reason,
        decided_at=run.decided_at,
        revoke_reason=run.revoke_reason,
        revoked_at=run.revoked_at,
    )


# ----- documents --------------------------------------------------------------------------------


def upload_rate_limit(
    granted: ManageListing, session: SessionDep, settings: SettingsDep
) -> Granted:
    """At most DOCUMENT_UPLOADS_PER_HOUR upload attempts per account (accepted or not), counted
    before the body is read or a worker runs (T66's limiter; 429 `upload_rate_limited`)."""
    actor = granted.signed_in
    subject = f"document_upload|{actor.world_id}|{actor.user_id}"
    key = bucket_key(rate_limit_secret(settings), AuthBucket.ACCOUNT, subject)
    limit = RateLimit(settings.document_uploads_per_hour, UPLOAD_WINDOW)
    try:
        retry_after = consume_attempt(
            session, AuthAttemptKind.DOCUMENT_UPLOAD, [(AuthBucket.ACCOUNT, key)], limit=limit
        )
    except AttemptsBusy:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            INSPECTION_BUSY,
            headers={"Retry-After": "1", "Cache-Control": NO_STORE},
        ) from None
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            UPLOAD_RATE_LIMITED,
            headers={"Retry-After": str(retry_after), "Cache-Control": NO_STORE},
        )
    return granted


def worker_slot(_limited: Granted = Depends(upload_rate_limit)) -> Iterator[None]:  # noqa: B008
    """One of this process's inspection slots for the whole request, taken without waiting and
    before the body is read: a busy process answers 503 at once, holding no thread or memory."""
    if not try_acquire_slot():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            INSPECTION_BUSY,
            headers={"Retry-After": "5", "Cache-Control": NO_STORE},
        )
    try:
        yield
    finally:
        release_slot()


async def document_body(request: Request, _slot: None = Depends(worker_slot)) -> bytes:  # noqa: B008
    """The raw request body, refused before it's read if it says it's over the limit, and
    while it's read if it is (411 without a Content-Length: no chunked uploads). Chunks are
    joined once, at the end."""
    declared = request.headers.get("content-length", "")
    if not declared.isdigit():
        raise HTTPException(status.HTTP_411_LENGTH_REQUIRED, LENGTH_REQUIRED)
    if int(declared) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, FILE_TOO_LARGE)
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_DOCUMENT_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, FILE_TOO_LARGE)
        chunks.append(chunk)
    return b"".join(chunks)


_UPLOAD_BODY = {
    "requestBody": {
        "required": True,
        "description": "The file itself (PDF, JPEG or PNG, at most 5 MB).",
        "content": {
            media: {"schema": {"type": "string", "format": "binary"}}
            for media in ACCEPTED_MEDIA_TYPES
        },
    }
}


def _quota(settings: Settings) -> StorageQuota:
    return StorageQuota(
        settings.document_quota_community_bytes, settings.document_quota_world_bytes
    )


@router.post(
    "/assets/{asset_id}/documents",
    response_model=ListingDocumentOut,
    status_code=status.HTTP_201_CREATED,
    openapi_extra=_UPLOAD_BODY,
    responses={
        **_AUTH,
        403: {"description": "members_only, treasury_cannot_act"},
        404: {"description": "Not found in the caller's world, or not visible to the caller"},
        409: {
            "description": f"`{LISTING_CLOSED}` (ineligible or withdrawn), "
            f"`{DOCUMENT_LIMIT_REACHED}` (20 per listing), `{STORAGE_QUOTA_EXCEEDED}` (the "
            f"community's or world's document bytes) or `{DOCUMENT_REUSED}` (the same file "
            "backs another listing, unless that's a withdrawn or ineligible listing of the "
            "same community)"
        },
        411: {"description": LENGTH_REQUIRED},
        413: {"description": f"`{FILE_TOO_LARGE}`: over 5 MB"},
        415: {"description": f"`{UNSUPPORTED_MEDIA_TYPE}`: not PDF, JPEG or PNG"},
        422: {
            "description": "The file is refused: empty_file, unsupported_format, "
            "media_type_mismatch, image_too_large, image_malformed, trailing_data, "
            "embedded_signature, pdf_encrypted, pdf_malformed, pdf_too_many_pages, "
            "pdf_too_many_objects, pdf_active_content, inspection_timeout or inspection_failed"
        },
        429: {"description": f"`{UPLOAD_RATE_LIMITED}`: see Retry-After"},
        503: {"description": f"`{INSPECTION_BUSY}`: see Retry-After"},
    },
)
def upload_document(
    granted: ManageListing,
    doc_type: Annotated[DocumentType, Query(description="What the document is.")],
    content_type: Annotated[str, Header()],
    data: Annotated[bytes, Depends(document_body)],
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> ListingDocumentOut:
    """Upload one verification document for the listing (its community's owner or stewards).
    The body is the file. It's checked by magic bytes, size, pixel and PDF limits in a worker
    with a timeout; only then is it stored, privately. By uploading, the steward confirms they
    may share it. Submit documents for review with `POST /assets/{id}/verification/runs`."""
    actor = granted.signed_in
    ref = _ref(granted)
    media = content_type.split(";", 1)[0].strip().lower()
    if media not in ACCEPTED_MEDIA_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, UNSUPPORTED_MEDIA_TYPE)
    secret = document_fingerprint_secret(settings)
    quota = _quota(settings)
    # Cheap early refusals, so a full listing or quota never costs a worker run; both are
    # re-checked under the locks.
    asset = _asset(session, granted)
    try:
        if verification.documents_held(session, ref.world_id, ref.asset_id) >= (
            verification.MAX_DOCUMENTS_PER_ASSET
        ):
            raise VerificationRefused(DOCUMENT_LIMIT_REACHED)
        verification.check_quota(session, ref.world_id, asset.community_id, len(data), quota)
    except VerificationRefused as exc:
        raise _refused(exc.code) from None
    session.commit()  # no transaction stays open while the worker runs
    try:
        inspection = run_worker(data, media)  # this request's `worker_slot` is held
    except DocumentRejected as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, exc.code, headers={"Cache-Control": NO_STORE}
        ) from None
    try:
        document = verification.store_document(
            session,
            world_id=ref.world_id,
            asset_id=ref.asset_id,
            uploaded_by=actor.user_id,
            doc_type=doc_type,
            data=data,
            inspection=inspection,
            secret=secret,
            quota=quota,
        )
    except VerificationRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    response.headers["Location"] = f"/assets/{ref.asset_id}/documents/{document.id}"
    return _document_out(document)


@router.get(
    "/assets/{asset_id}/documents",
    response_model=list[ListingDocumentOut],
    responses={**_AUTH, **_HIDDEN},
)
def list_documents(
    granted: CommunityEvidence, session: SessionDep, response: Response
) -> list[ListingDocumentOut]:
    """The listing's documents, submitted or not, oldest first."""
    ref = _ref(granted)
    documents = verification.documents_of(session, ref.world_id, ref.asset_id)
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return [_document_out(document) for document in documents]


_FILE_RESPONSE: Responses = {
    200: {
        "description": "The original file, as a download",
        "content": {
            media: {"schema": {"type": "string", "format": "binary"}}
            for media in ACCEPTED_MEDIA_TYPES
        },
    },
    **_AUTH,
    404: {"description": "`not_found` (see the list route) or `document_not_found`"},
}


@router.get(
    "/assets/{asset_id}/documents/{document_id}",
    response_class=Response,
    responses=_FILE_RESPONSE,
)
def download_document(
    document_id: UUID, granted: CommunityEvidence, session: SessionDep
) -> Response:
    """The original file, always as an attachment (`Content-Disposition: attachment`,
    `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`). Loaded by
    `(world_id, asset_id, id)`."""
    ref = _ref(granted)
    try:
        document, content = verification.document_bytes(
            session, ref.world_id, ref.asset_id, document_id
        )
    except DocumentNotFound:
        raise _missing("document_not_found") from None
    name = f"naturex-document-{document.id}.{_EXTENSIONS[document.media_type]}"
    return Response(
        content=content,
        media_type=document.media_type,
        headers={**_FILE_HEADERS, "Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.get(
    "/assets/{asset_id}/documents/{document_id}/preview",
    response_class=Response,
    responses={
        200: {
            "description": "A sanitised, re-encoded PNG",
            "content": {"image/png": {"schema": {"type": "string", "format": "binary"}}},
        },
        **_AUTH,
        404: {"description": f"`not_found`, `document_not_found` or `{NO_PREVIEW}`"},
    },
)
def preview_document(
    document_id: UUID, granted: CommunityEvidence, session: SessionDep
) -> Response:
    """The document's sanitised preview: a PNG re-encoded from the decoded pixels, at most
    1600 px, with no metadata. Never the original bytes."""
    ref = _ref(granted)
    try:
        document, preview = verification.document_bytes(
            session, ref.world_id, ref.asset_id, document_id, preview=True
        )
    except DocumentNotFound:
        raise _missing("document_not_found") from None
    if preview is None:
        raise _missing(NO_PREVIEW)
    name = f"naturex-document-{document.id}-preview.png"
    return Response(
        content=preview,
        media_type="image/png",
        headers={**_FILE_HEADERS, "Content-Disposition": f'inline; filename="{name}"'},
    )


# ----- runs -------------------------------------------------------------------------------------


@router.post(
    "/assets/{asset_id}/verification/runs",
    response_model=VerificationRunOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_AUTH,
        403: {"description": "members_only, treasury_cannot_act"},
        404: {
            "description": "`not_found`, or `document_not_found` (a document that isn't one of "
            "this listing's)"
        },
        409: {"description": f"`{LISTING_CLOSED}` or `{DOCUMENT_ALREADY_SUBMITTED}`"},
    },
)
def submit_verification(
    body: VerificationSubmit,
    granted: ManageListing,
    session: SessionDep,
    response: Response,
) -> VerificationRunOut:
    """Submit 1–3 uploaded documents for review: a new current run with its deterministic
    checklist (accepted format, not reused, boundary free, consent document attached) and the
    fingerprint of what it vouches for. Any earlier run stops being current."""
    actor = granted.signed_in
    ref = _ref(granted)
    try:
        view = verification.submit_run(
            session,
            world_id=ref.world_id,
            asset_id=ref.asset_id,
            submitted_by=actor.user_id,
            document_ids=body.document_ids,
        )
    except DocumentNotFound:
        session.rollback()
        raise _missing("document_not_found") from None
    except VerificationRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return run_out(view)


@router.get(
    "/assets/{asset_id}/verification/runs",
    response_model=list[VerificationRunOut],
    responses={**_AUTH, **_HIDDEN},
)
def list_verification_runs(
    granted: CommunityEvidence, session: SessionDep, response: Response
) -> list[VerificationRunOut]:
    """Every run of the listing, newest first, with its checklist values, documents and the
    reviewer's reasons (never the reviewer's identity)."""
    asset = _asset(session, granted)
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return [run_out(view) for view in verification.runs_of(session, asset)]


def _ledger_seq(session: Session, asset: Asset, run_id: UUID | None) -> int | None:
    """The latest `verification` entry of the run (of any run, for None)."""
    query = select(LedgerEntry.seq).where(
        LedgerEntry.asset_id == asset.id, LedgerEntry.kind == LedgerKind.VERIFICATION
    )
    if run_id is not None:
        query = query.where(LedgerEntry.ref_id == run_id)
    return session.exec(query.order_by(col(LedgerEntry.seq).desc()).limit(1)).first()


@router.get(
    "/assets/{asset_id}/verification",
    response_model=VerificationPublicOut,
    responses={404: {"description": "Not found in the caller's world, or not visible"}},
)
def verification_panel(
    granted: BrowseAsset, session: SessionDep, response: Response
) -> VerificationPublicOut:
    """How this listing was verified (ADR-0006 §4): the level and its badge, the date, the
    reviewer's role, each check's result, the ledger entry, and what was **not** checked.
    Never documents, values or reasons."""
    asset = _asset(session, granted)
    view = verification.current_view(session, asset)
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    revoked = asset.verification_revoked_at is not None
    current_revoked = (
        view is not None
        and view.fingerprint_matches
        and view.run.level is VerificationLevel.REVOKED
    )
    if revoked and not current_revoked:
        # A revocation stands until an approval, even once a new run is submitted or the
        # listing changed: the panel keeps saying so (its latest decision is the revocation).
        return VerificationPublicOut(
            asset_id=asset.id,
            level=VerificationLevel.REVOKED,
            badge=badge(VerificationLevel.REVOKED),
            revoked_at=asset.verification_revoked_at,
            not_checked=list(NOT_CHECKED),
            ledger_seq=_ledger_seq(session, asset, None),
        )
    if view is None or not view.fingerprint_matches:
        return VerificationPublicOut(
            asset_id=asset.id,
            level=VerificationLevel.UNVERIFIED,
            badge=badge(VerificationLevel.UNVERIFIED),
            not_checked=list(NOT_CHECKED),
        )
    run = view.run
    return VerificationPublicOut(
        asset_id=asset.id,
        level=run.level,
        badge=badge(run.level),
        run_id=run.id,
        submitted_at=run.created_at,
        decided_at=run.decided_at,
        revoked_at=run.revoked_at,
        reviewer_role=run.reviewer_role,
        method_version=run.method_version,
        checks=[PublicCheckOut.model_validate(item) for item in public_checks(run.checklist)],
        not_checked=list(NOT_CHECKED),
        ledger_seq=_ledger_seq(session, asset, run.id),
    )


# ----- review -----------------------------------------------------------------------------------


@router.get(
    "/admin/verifications",
    response_model=list[ReviewQueueItem],
    tags=["admin"],
    responses={**_AUTH, 403: {"description": "admin_only"}},
)
def review_queue(
    granted: ReviewQueue,
    session: SessionDep,
    response: Response,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ReviewQueueItem]:
    """Listings waiting for a reviewer in the caller's world, oldest first, with their current
    run, one page at a time (`limit`, `offset`). Listings of the admin's own communities are
    left out (conflict of interest)."""
    actor = granted.signed_in
    rows = verification.review_queue(
        session, actor.world_id, list(actor.memberships), limit=limit, offset=offset
    )
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return [
        ReviewQueueItem(
            asset_id=asset.id,
            asset_name=asset.name,
            asset_status=AssetStatusOut(asset.status.value),
            community_id=asset.community_id,
            run=run_out(view),
        )
        for asset, view in rows
    ]


_DECISION: Responses = {
    **_AUTH,
    403: {"description": "admin_only, conflict_of_interest (the admin's own community)"},
    404: {"description": "`not_found`, or `run_not_found` (not one of this listing's runs)"},
}


def _decided(session: Session, step: Any) -> VerificationRunOut:
    try:
        view = step()
    except RunNotFound:
        session.rollback()
        raise _missing("run_not_found") from None
    except VerificationRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    return run_out(view)


@router.post(
    "/admin/assets/{asset_id}/verification/{run_id}/approve",
    response_model=VerificationRunOut,
    tags=["admin"],
    responses={
        **_DECISION,
        409: {
            "description": f"`{RUN_SUPERSEDED}`, `{RUN_ALREADY_DECIDED}`, `{LISTING_CLOSED}`, "
            f"`{STALE_RUN}` (the listing changed since the run: it needs a new one), "
            f"`{CHECKS_FAILED}` or `{OVERLAP}`"
        },
    },
)
def approve_verification(
    run_id: UUID,
    body: VerificationApprove,
    granted: ReviewListing,
    session: SessionDep,
    response: Response,
) -> VerificationRunOut:
    """Approve the listing's current run: it becomes `verified`, a `verification` ledger entry
    records the decision, and an asset suspended by a revocation trades again."""
    actor = granted.signed_in
    ref = _ref(granted)
    out = _decided(
        session,
        lambda: verification.approve(
            session,
            world_id=ref.world_id,
            asset_id=ref.asset_id,
            run_id=run_id,
            reviewer=actor.user_id,
            reason=body.reason,
        ),
    )
    response.headers["Cache-Control"] = NO_STORE
    return out


@router.post(
    "/admin/assets/{asset_id}/verification/{run_id}/reject",
    response_model=VerificationRunOut,
    tags=["admin"],
    responses={
        **_DECISION,
        409: {"description": f"`{RUN_SUPERSEDED}` or `{RUN_ALREADY_DECIDED}`"},
    },
)
def reject_verification(
    run_id: UUID,
    body: VerificationReason,
    granted: ReviewListing,
    session: SessionDep,
    response: Response,
) -> VerificationRunOut:
    """Reject the listing's current run with a reason the steward sees."""
    actor = granted.signed_in
    ref = _ref(granted)
    out = _decided(
        session,
        lambda: verification.reject(
            session,
            world_id=ref.world_id,
            asset_id=ref.asset_id,
            run_id=run_id,
            reviewer=actor.user_id,
            reason=body.reason,
        ),
    )
    response.headers["Cache-Control"] = NO_STORE
    return out


@router.post(
    "/admin/assets/{asset_id}/verification/{run_id}/revoke",
    response_model=VerificationRunOut,
    tags=["admin"],
    responses={
        **_DECISION,
        409: {"description": f"`{RUN_SUPERSEDED}` or `{NOT_VERIFIED}` (the run isn't verified)"},
    },
)
def revoke_verification(
    run_id: UUID,
    body: VerificationReason,
    granted: ReviewListing,
    session: SessionDep,
    response: Response,
) -> VerificationRunOut:
    """Revoke the listing's verified run, with a reason: in one transaction it becomes
    `revoked` and a listed asset is suspended (`verification_revoked`), so orders are refused
    until a new run is approved. Both changes are in the ledger."""
    actor = granted.signed_in
    ref = _ref(granted)
    out = _decided(
        session,
        lambda: verification.revoke(
            session,
            world_id=ref.world_id,
            asset_id=ref.asset_id,
            run_id=run_id,
            revoked_by=actor.user_id,
            reason=body.reason,
        ),
    )
    response.headers["Cache-Control"] = NO_STORE
    return out

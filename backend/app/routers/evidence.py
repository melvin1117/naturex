"""Field evidence routes (T40, dev-spec §7.6; rules in `app.tools.field_evidence`).

Steward (the listing's community owner or stewards, `MANAGE_LISTING`; investors 403, another
world's listing 404):

- `POST /assets/{id}/evidence`: upload one geotagged photo; the request body is the file
  (`Content-Type: image/jpeg | image/png`, ≤ 10 MB), at most 5 per listing. It's inspected in
  a worker with a timeout; the EXIF GPS position and date are checked against the listing, then
  only a re-encoded JPEG without metadata is stored. When both checks pass, the image model
  labels it in the background; code decides whether it's validated evidence.
- `DELETE /assets/{id}/evidence/{photo_id}`: remove a photo and its evidence event (the next
  rating stops counting it).

The listing's community members and same-world admins (`VIEW_COMMUNITY_DATA`; 404 for anyone
else): `GET /assets/{id}/evidence` (every photo's checks and the confidence effect), one photo's
checks at `GET /assets/{id}/evidence/{photo_id}` (the upload's `Location`) and the re-encoded
photo at `GET /assets/{id}/evidence/{photo_id}/image`.

Anyone who can see the asset: `GET /assets/{id}/evidence/summary`, counts and labels of the
validated photos only: never a photo, a position, who took it or the day.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status

from app.auth import AttemptsBusy, RateLimit, bucket_key, consume_attempt
from app.authz import Action, Granted, OptionalActor, asset_ref, require
from app.config import rate_limit_secret
from app.deps import CurrentWorld, SessionDep, SettingsDep
from app.models import AuthAttemptKind, AuthBucket
from app.routers.assets import world_asset
from app.routers.verification import CommunityEvidence
from app.schemas import FieldEvidenceOut, FieldEvidencePublicOut, FieldPhotoOut
from app.services import field_evidence as evidence
from app.services.field_evidence import (
    LISTING_CLOSED,
    PENDING,
    PHOTO_DUPLICATE,
    PHOTO_LIMIT_REACHED,
    EvidenceAnalyzer,
    EvidenceRefused,
    PhotoNotFound,
    get_evidence_analyzer,
)
from app.tools.documents import (
    MAX_PHOTO_BYTES,
    MEDIA_JPEG,
    MEDIA_PNG,
    DocumentRejected,
    release_slot,
    run_worker,
    try_acquire_slot,
)
from app.tools.field_evidence import MAX_PHOTOS_PER_ASSET

router = APIRouter(tags=["evidence"])

NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"
LENGTH_REQUIRED = "length_required"
FILE_TOO_LARGE = "file_too_large"
UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type"
INSPECTION_BUSY = "inspection_busy"
UPLOAD_RATE_LIMITED = "upload_rate_limited"
PHOTO_NOT_FOUND = "photo_not_found"
UPLOAD_WINDOW = timedelta(hours=1)
PHOTO_MEDIA_TYPES = (MEDIA_JPEG, MEDIA_PNG)
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
BROWSE_ASSET = require(Action.BROWSE, asset_ref)


def _missing(detail: str = "not_found") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail, headers={"Cache-Control": NO_STORE})


def _refused(code: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, code, headers={"Cache-Control": NO_STORE})


def _ref(granted: Granted) -> tuple[UUID, UUID]:
    ref = granted.resource
    world_id, asset_id = getattr(ref, "world_id", None), getattr(ref, "asset_id", None)
    if not isinstance(world_id, UUID) or not isinstance(asset_id, UUID):  # pragma: no cover
        raise TypeError(ref)
    return world_id, asset_id


def upload_rate_limit(
    granted: ManageListing, session: SessionDep, settings: SettingsDep
) -> Granted:
    """At most EVIDENCE_UPLOADS_PER_HOUR upload attempts per account (accepted or not), counted
    before the body is read or a worker runs (T66's limiter, its own bucket)."""
    actor = granted.signed_in
    subject = f"evidence_upload|{actor.world_id}|{actor.user_id}"
    key = bucket_key(rate_limit_secret(settings), AuthBucket.ACCOUNT, subject)
    limit = RateLimit(settings.evidence_uploads_per_hour, UPLOAD_WINDOW)
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


def worker_slot(granted: Granted = Depends(upload_rate_limit)) -> Iterator[Granted]:  # noqa: B008
    """One of this process's inspection slots (shared with document uploads), taken without
    waiting and before the body is read."""
    if not try_acquire_slot():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            INSPECTION_BUSY,
            headers={"Retry-After": "5", "Cache-Control": NO_STORE},
        )
    try:
        yield granted
    finally:
        release_slot()


async def photo_body(request: Request, _slot: Granted = Depends(worker_slot)) -> bytes:  # noqa: B008
    """The raw body, refused before it's read if it says it's over the limit, and while it's
    read if it is (411 without a Content-Length)."""
    declared = request.headers.get("content-length", "")
    if not declared.isdigit():
        raise HTTPException(status.HTTP_411_LENGTH_REQUIRED, LENGTH_REQUIRED)
    if int(declared) > MAX_PHOTO_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, FILE_TOO_LARGE)
    chunks: list[bytes] = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_PHOTO_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, FILE_TOO_LARGE)
        chunks.append(chunk)
    return b"".join(chunks)


_UPLOAD_BODY = {
    "requestBody": {
        "required": True,
        "description": "The photo itself (JPEG or PNG, at most 10 MB), with its EXIF.",
        "content": {
            media: {"schema": {"type": "string", "format": "binary"}} for media in PHOTO_MEDIA_TYPES
        },
    }
}


@router.post(
    "/assets/{asset_id}/evidence",
    response_model=FieldPhotoOut,
    status_code=status.HTTP_201_CREATED,
    openapi_extra=_UPLOAD_BODY,
    responses={
        **_AUTH,
        403: {"description": "members_only, treasury_cannot_act"},
        404: {"description": "Not found in the caller's world, or not visible to the caller"},
        409: {
            "description": f"`{LISTING_CLOSED}` (ineligible or withdrawn), "
            f"`{PHOTO_LIMIT_REACHED}` ({MAX_PHOTOS_PER_ASSET} per listing) or "
            f"`{PHOTO_DUPLICATE}` (this file is already uploaded)"
        },
        411: {"description": LENGTH_REQUIRED},
        413: {"description": f"`{FILE_TOO_LARGE}`: over 10 MB"},
        415: {"description": f"`{UNSUPPORTED_MEDIA_TYPE}`: not JPEG or PNG"},
        422: {
            "description": "The file is refused: empty_file, unsupported_format, "
            "media_type_mismatch, image_too_large, image_malformed, trailing_data, "
            "embedded_signature, inspection_timeout or inspection_failed"
        },
        429: {"description": f"`{UPLOAD_RATE_LIMITED}`: see Retry-After"},
        503: {"description": f"`{INSPECTION_BUSY}`: see Retry-After"},
    },
)
def upload_photo(
    granted: ManageListing,
    content_type: Annotated[str, Header()],
    data: Annotated[bytes, Depends(photo_body)],
    session: SessionDep,
    settings: SettingsDep,
    analyzer: Annotated[EvidenceAnalyzer, Depends(get_evidence_analyzer)],
    response: Response,
) -> FieldPhotoOut:
    """Upload one geotagged field photo for the listing (its community's owner or stewards).
    The body is the file. Its EXIF position must be inside the listing (or within 100 m of its
    edge) and its date at most a year old; only those checks' results are kept, never the
    position. The photo is stored re-encoded, with no metadata, and read by an image model on
    Nebius Token Factory when both checks pass and AI analysis is on (`analysis_status`: poll
    the `Location`, `GET …/evidence/{photo_id}`)."""
    world_id, asset_id = _ref(granted)
    media = content_type.split(";", 1)[0].strip().lower()
    if media not in PHOTO_MEDIA_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, UNSUPPORTED_MEDIA_TYPE)
    # Cheap early refusals, so a full or closed listing never costs a worker run; both are
    # re-checked under the asset's lock.
    asset = world_asset(session, world_id, asset_id, granted.actor)
    try:
        evidence.check_open(asset)
        if evidence.photo_count(session, world_id, asset_id) >= MAX_PHOTOS_PER_ASSET:
            raise EvidenceRefused(PHOTO_LIMIT_REACHED)
    except EvidenceRefused as exc:
        raise _refused(exc.code) from None
    session.commit()  # no transaction stays open while the worker runs
    try:
        inspection = run_worker(data, media, photo=True)  # this request's slot is held
    except DocumentRejected as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, exc.code, headers={"Cache-Control": NO_STORE}
        ) from None
    now = datetime.now(UTC)
    try:
        photo = evidence.store_photo(
            session,
            world_id=world_id,
            asset_id=asset_id,
            uploaded_by=granted.signed_in.user_id,
            sha256=hashlib.sha256(data).hexdigest(),
            inspection=inspection,
            mode=evidence.ai_mode(settings, world_id),
            today=now.date(),
        )
    except EvidenceRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    if photo.analysis_status == PENDING:
        analyzer.schedule(world_id, asset_id, photo.id)
        session.refresh(photo)
    response.headers["Cache-Control"] = NO_STORE
    response.headers["Location"] = f"/assets/{asset_id}/evidence/{photo.id}"
    return evidence.photo_out(photo, now)


@router.get(
    "/assets/{asset_id}/evidence",
    response_model=FieldEvidenceOut,
    responses={**_AUTH, **_HIDDEN},
)
def list_photos(
    granted: CommunityEvidence, session: SessionDep, settings: SettingsDep, response: Response
) -> FieldEvidenceOut:
    """The listing's field photos, oldest first, with each one's checks, and the confidence
    the next rating would have with the validated ones (from the latest report)."""
    world_id, asset_id = _ref(granted)
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return evidence.steward_view(session, settings, world_id, asset_id, datetime.now(UTC))


@router.get(
    "/assets/{asset_id}/evidence/summary",
    response_model=FieldEvidencePublicOut,
    dependencies=[BROWSE_ASSET],
)
def evidence_summary(
    asset_id: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep
) -> FieldEvidencePublicOut:
    """Field evidence in aggregate, for anyone who can see the asset: how many photos, how many
    validated, and the land cover and disturbance labels seen in validated ones."""
    asset = world_asset(session, world.id, asset_id, actor)
    return evidence.public_view(session, world.id, asset.id)


@router.get(
    "/assets/{asset_id}/evidence/{photo_id}",
    response_model=FieldPhotoOut,
    responses={
        **_AUTH,
        404: {"description": f"`not_found` (see the list route) or `{PHOTO_NOT_FOUND}`"},
    },
)
def get_photo(
    photo_id: UUID, granted: CommunityEvidence, session: SessionDep, response: Response
) -> FieldPhotoOut:
    """One field photo's checks (the upload's `Location`; poll it while `pending`)."""
    world_id, asset_id = _ref(granted)
    try:
        photo = evidence.photo_of(session, world_id, asset_id, photo_id)
    except PhotoNotFound:
        raise _missing(PHOTO_NOT_FOUND) from None
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return evidence.photo_out(photo, datetime.now(UTC))


@router.get(
    "/assets/{asset_id}/evidence/{photo_id}/image",
    response_class=Response,
    responses={
        200: {
            "description": "The photo re-encoded as a JPEG with no metadata",
            "content": {"image/jpeg": {"schema": {"type": "string", "format": "binary"}}},
        },
        **_AUTH,
        404: {"description": f"`not_found` (see the list route) or `{PHOTO_NOT_FOUND}`"},
    },
)
def photo_image(photo_id: UUID, granted: CommunityEvidence, session: SessionDep) -> Response:
    """The photo as stored: a JPEG re-encoded from the decoded pixels, at most 1280 px, with no
    EXIF (so no location). Loaded by `(world_id, asset_id, id)`."""
    world_id, asset_id = _ref(granted)
    try:
        content = evidence.photo_image(session, world_id, asset_id, photo_id)
    except PhotoNotFound:
        raise _missing(PHOTO_NOT_FOUND) from None
    name = f"wildworth-field-photo-{photo_id}.jpg"
    return Response(
        content=content,
        media_type=MEDIA_JPEG,
        headers={**_FILE_HEADERS, "Content-Disposition": f'inline; filename="{name}"'},
    )


@router.delete(
    "/assets/{asset_id}/evidence/{photo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={
        **_AUTH,
        403: {"description": "members_only, treasury_cannot_act"},
        404: {"description": f"`not_found` or `{PHOTO_NOT_FOUND}`"},
    },
)
def delete_photo(photo_id: UUID, granted: ManageListing, session: SessionDep) -> Response:
    """Remove a field photo with its image and evidence event. A rating already sealed keeps its
    own copy of what it cited; the next one won't count the photo."""
    world_id, asset_id = _ref(granted)
    try:
        evidence.delete_photo(session, world_id, asset_id, photo_id)
    except PhotoNotFound:
        session.rollback()
        raise _missing(PHOTO_NOT_FOUND) from None
    except LookupError:
        session.rollback()
        raise _missing() from None
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT, headers={"Cache-Control": NO_STORE})

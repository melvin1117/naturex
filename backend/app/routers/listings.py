"""The listing lifecycle routes (T58; rules in `app.services.lifecycle`).

- `POST /assets` creates a draft in a community the caller owns or stewards (`MANAGE_LISTING`),
  with an attestation and a polygon checked by T36; `PATCH /assets/{id}` edits a draft.
- `POST /assets/{id}/submit` starts a rating run whose sealed report decides `listed`,
  `needs_evidence` or `ineligible`; `…/revise` returns a listing under review to `draft`;
  `…/withdraw` ends one that was never listed.
- `GET /communities/{id}/assets` lists a community's listings at every status.
- `POST /admin/assets/{id}/suspend` and `…/resume` are admin moderation (`OPERATE`).

Writes act in the session's world. A refused transition is 409 with a reason code; rate limits
are 429 with `Retry-After`. Reads vary with the session cookie, so they are `private,
no-store`; writes are `no-store`.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Response, status
from sqlmodel import Session, col, select

from app.authz import (
    Action,
    AssetRef,
    CommunityRef,
    Granted,
    OptionalActor,
    acting_world,
    asset_ref,
    community_ref,
    require,
)
from app.deps import SessionDep, SettingsDep
from app.models import Asset, Community
from app.routers.assets import asset_detail, cards
from app.routers.runs import RunnerDep
from app.schemas import (
    AssetCard,
    AssetCreate,
    AssetDetail,
    AssetStatusOut,
    AssetSubmitted,
    AssetUpdate,
    SuspendRequest,
)
from app.services.lifecycle import (
    EVIDENCE_REQUIRED,
    METRICS_UNAVAILABLE,
    SuspensionReason,
    TransitionRefused,
)
from app.services.listings import (
    OVERLAP,
    RUN_IN_PROGRESS,
    ListingDetails,
    ListingLimitReached,
    ListingSubmit,
    NoChanges,
    PolygonRejected,
    TooSoon,
    create_draft,
    resume,
    revise,
    suspend,
    update_draft,
    withdraw,
)
from app.services.rating_runs import RunInProgress, RunnerBusy, RunRateLimited, run_active

router = APIRouter(tags=["listings"])

LISTING_LIMIT_REACHED = "listing_limit_reached"
NO_CHANGES = "no_changes"
NO_STORE = "no-store"
PRIVATE_NO_STORE = "private, no-store"

Responses = dict[int | str, dict[str, Any]]
_AUTH: Responses = {401: {"description": "auth_required"}}
_DENIED: Responses = {403: {"description": "A reason code, e.g. members_only or admin_only"}}
_MISSING: Responses = {404: {"description": "Not found in the caller's world"}}
_POLYGON: Responses = {
    422: {
        "description": "Invalid body, or the polygon fails T36's checks: each problem is an "
        "item with `type` `polygon.<code>` (invalid_geojson, too_complex, self_intersection, "
        "too_small, too_large, overlap) at `loc` [body, geojson]"
    }
}


def new_listing_ref(
    body: AssetCreate, actor: OptionalActor, session: SessionDep
) -> AssetRef | None:
    """The listing about to exist in the body's community, found by `(world_id, id)` in the
    caller's world (None, a 404, otherwise). `body` is the route's own, parsed once."""
    world_id = acting_world(actor)
    community = session.exec(
        select(Community.id).where(
            Community.world_id == world_id, Community.id == body.community_id
        )
    ).first()
    # Nothing exists yet to hide, and the community is public: an outsider learns `members_only`.
    return None if community is None else AssetRef(world_id, uuid4(), community, public=True)


NEW_LISTING = require(Action.MANAGE_LISTING, new_listing_ref)
ListingAccess = Annotated[Granted, require(Action.MANAGE_LISTING, asset_ref)]
OperateAsset = Annotated[Granted, require(Action.OPERATE, asset_ref)]
CommunityData = Annotated[Granted, require(Action.VIEW_COMMUNITY_DATA, community_ref)]


def _polygon_error(exc: PolygonRejected) -> HTTPException:
    """422 in FastAPI's validation-error shape, one item per problem (T36 reports them all)."""
    detail = [
        {"type": f"polygon.{problem.code}", "loc": ["body", "geojson"], "msg": problem.message}
        for problem in exc.problems
    ]
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _refused(code: str) -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, code, headers={"Cache-Control": NO_STORE})


def _too_soon(exc: TooSoon) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        exc.code,
        headers={"Retry-After": str(exc.retry_after_s), "Cache-Control": NO_STORE},
    )


def _listing(session: Session, granted: Granted) -> Asset:
    ref = granted.resource
    if not isinstance(ref, AssetRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    return session.exec(
        select(Asset).where(Asset.world_id == ref.world_id, Asset.id == ref.asset_id)
    ).one()


@router.get(
    "/communities/{community_id}/assets",
    response_model=list[AssetCard],
    responses={**_AUTH, **_DENIED, **_MISSING},
)
def list_community_assets(
    granted: CommunityData, session: SessionDep, response: Response
) -> list[AssetCard]:
    """The community's listings at every status, drafts included (its members and same-world
    admins only): the Steward app's listing flow."""
    ref = granted.resource
    if not isinstance(ref, CommunityRef):  # pragma: no cover - the loader guarantees it
        raise TypeError(ref)
    assets = session.exec(
        select(Asset)
        .where(Asset.world_id == ref.world_id, Asset.community_id == ref.community_id)
        .order_by(col(Asset.created_at), col(Asset.name))
    ).all()
    response.headers["Cache-Control"] = PRIVATE_NO_STORE
    return cards(session, ref.world_id, assets)


@router.post(
    "/assets",
    response_model=AssetDetail,
    status_code=status.HTTP_201_CREATED,
    responses={
        **_AUTH,
        **_DENIED,
        404: {"description": "The community isn't in the caller's world"},
        409: {"description": LISTING_LIMIT_REACHED},
        **_POLYGON,
    },
)
def create_listing(
    body: AssetCreate,
    granted: Annotated[Granted, NEW_LISTING],
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    """Create a **draft** listing in a community the caller owns or stewards, in the session's
    world. Needs `attestation: true`; the polygon must pass T36's checks and not overlap a
    submitted listing in the world or one of the community's own drafts. Nothing is public
    until it's listed."""
    actor = granted.signed_in
    community = body.community_id
    details = ListingDetails(
        name=body.name, country=body.country, description=body.description, geojson=body.geojson
    )
    try:
        asset = create_draft(
            session, world_id=actor.world_id, community_id=community, details=details
        )
    except PolygonRejected as exc:
        session.rollback()
        raise _polygon_error(exc) from None
    except ListingLimitReached:
        session.rollback()
        raise _refused(LISTING_LIMIT_REACHED) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.patch(
    "/assets/{asset_id}",
    response_model=AssetDetail,
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        400: {"description": f"`{NO_CHANGES}`: the body changes nothing"},
        409: {"description": "`cannot_edit_<status>`: only drafts can be edited"},
        429: {"description": "`edit_rate_limited`; see Retry-After"},
        **_POLYGON,
    },
)
def edit_listing(
    body: AssetUpdate,
    granted: ListingAccess,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    """Edit a draft (its community's owner or stewards). Only the fields sent change; a body
    that changes nothing is 400 and writes nothing."""
    ref = _listing(session, granted)
    changes: dict[str, Any] = body.model_dump(include=body.model_fields_set)
    try:
        asset = update_draft(session, ref.world_id, ref.id, changes)
    except NoChanges:
        session.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, NO_CHANGES) from None
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    except TooSoon as exc:
        session.rollback()
        raise _too_soon(exc) from None
    except PolygonRejected as exc:
        session.rollback()
        raise _polygon_error(exc) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.post(
    "/assets/{asset_id}/submit",
    response_model=AssetSubmitted,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {
            "description": f"`cannot_submit_<status>`, `{OVERLAP}` (a listing submitted first "
            f"claims the land), `{EVIDENCE_REQUIRED}` (needs_evidence with no new evidence or "
            f"newer data), `{METRICS_UNAVAILABLE}` (still no metrics for the polygon) or "
            f"`{RUN_IN_PROGRESS}` (Location: the active run)"
        },
        429: {
            "description": "`resubmit_cooldown`, `rating_rate_limited` or "
            "`rating_global_limit`; see Retry-After"
        },
        503: {"description": "`rating_busy`; see Retry-After"},
    },
)
def submit_listing(
    granted: ListingAccess, session: SessionDep, runner: RunnerDep, response: Response
) -> AssetSubmitted:
    """Submit a draft for rating, or resubmit: a `needs_evidence` listing with new evidence or
    newer satellite data, or a `rating` listing whose run failed (at most every 10 minutes).
    The move to `rating`, its ledger entry and the queued run commit together; the run's
    sealed report then sets `listed`, `needs_evidence` or `ineligible`. Follow it with
    `GET /runs/{run_id}` or `listing_status` events."""
    asset = _listing(session, granted)
    world_id, asset_id = asset.world_id, asset.id
    hook = ListingSubmit(runner.metrics_version(asset))  # probed before any lock
    # End the read transaction: the runner uses its own session and waits on run locks.
    session.commit()
    try:
        run_id = runner.start(world_id, asset_id, trigger="listing", on_queue=hook)
    except TransitionRefused as exc:
        raise _refused(exc.code) from None
    except TooSoon as exc:
        raise _too_soon(exc) from None
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from exc
    except RunInProgress as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            RUN_IN_PROGRESS,
            headers={"Location": f"/runs/{exc.run_id}"},
        ) from exc
    except RunRateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            exc.code,
            headers={"Retry-After": str(exc.retry_after_s)},
        ) from exc
    except RunnerBusy as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "rating_busy",
            headers={"Retry-After": str(exc.retry_after_s)},
        ) from exc
    response.headers["Location"] = f"/runs/{run_id}"
    response.headers["Cache-Control"] = NO_STORE
    return AssetSubmitted(asset_id=asset_id, run_id=run_id, status=AssetStatusOut.RATING)


_LEAVE_REVIEW: Responses = {
    **_AUTH,
    **_DENIED,
    **_MISSING,
    409: {"description": f"`cannot_<event>_<status>` or `{RUN_IN_PROGRESS}`"},
}


@router.post("/assets/{asset_id}/revise", response_model=AssetDetail, responses=_LEAVE_REVIEW)
def revise_listing(
    granted: ListingAccess, session: SessionDep, settings: SettingsDep, response: Response
) -> AssetDetail:
    """Return a `needs_evidence` listing, or a `rating` one with no active run, to `draft`, so
    the community can redraw and resubmit it."""
    ref = _listing(session, granted)
    try:
        asset = revise(session, ref.world_id, ref.id, run_active=run_active)
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.post("/assets/{asset_id}/withdraw", response_model=AssetDetail, responses=_LEAVE_REVIEW)
def withdraw_listing(
    granted: ListingAccess, session: SessionDep, settings: SettingsDep, response: Response
) -> AssetDetail:
    """Withdraw a listing that was never listed (draft, needs_evidence, or rating with no
    active run). `withdrawn` is final; it frees the land and the community's open-listing
    slot, and the listing stays visible to its community only."""
    ref = _listing(session, granted)
    try:
        asset = withdraw(session, ref.world_id, ref.id, run_active=run_active)
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.post(
    "/admin/assets/{asset_id}/suspend",
    response_model=AssetDetail,
    tags=["admin"],
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "`cannot_suspend_<status>`: only listed assets"},
    },
)
def suspend_listing(
    body: SuspendRequest,
    granted: OperateAsset,
    session: SessionDep,
    settings: SettingsDep,
    response: Response,
) -> AssetDetail:
    """Suspend trading on a listed asset (admins, never on their own community's asset)."""
    ref = _listing(session, granted)
    try:
        asset = suspend(session, ref.world_id, ref.id, SuspensionReason(body.reason))
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)


@router.post(
    "/admin/assets/{asset_id}/resume",
    response_model=AssetDetail,
    tags=["admin"],
    responses={
        **_AUTH,
        **_DENIED,
        **_MISSING,
        409: {"description": "`cannot_resume_<status>`: only suspended assets"},
    },
)
def resume_listing(
    granted: OperateAsset, session: SessionDep, settings: SettingsDep, response: Response
) -> AssetDetail:
    """Resume trading on a suspended asset (admins, never on their own community's asset)."""
    ref = _listing(session, granted)
    try:
        asset = resume(session, ref.world_id, ref.id)
    except TransitionRefused as exc:
        session.rollback()
        raise _refused(exc.code) from None
    session.commit()
    response.headers["Cache-Control"] = NO_STORE
    return asset_detail(session, asset, settings)

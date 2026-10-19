"""Rating runs (T27): `POST /assets/{asset_id}/rate` → 202 + `run_id`; `GET /runs/{run_id}`.

Both are scoped to the session's world (404 for another world's asset or run). Starting a run
spends LLM budget, so it is either an operator's re-rate (`Action.OPERATE`: an admin of this
world with no stake in the asset's community) or the community's own listing management
(`Action.MANAGE_LISTING`: its owner or a steward), ADR-0005 §3 rows 5 and 8; anyone else gets 403
`admin_only`, anonymous callers 401. Progress also streams as `rating_progress` events
(`GET /events/stream`).
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from sqlmodel import select

from app.authz import (
    Action,
    AssetRef,
    DenyReason,
    OptionalActor,
    acting_world,
    asset_ref,
    asset_ref_in,
    require,
    require_any,
)
from app.deps import CurrentWorld, SessionDep
from app.models import Asset
from app.schemas import RatingRunAccepted, RatingRunOut
from app.services.listings import visible_to
from app.services.rating_runs import (
    AssetNotRateable,
    RatingRunner,
    RunInProgress,
    RunnerBusy,
    RunRateLimited,
    default_runner,
    get_run,
)

router = APIRouter(tags=["runs"])


def get_rating_runner() -> RatingRunner:
    return default_runner()


RunnerDep = Annotated[RatingRunner, Depends(get_rating_runner)]


def world_run(
    run_id: Annotated[UUID, Path()], actor: OptionalActor, session: SessionDep
) -> RatingRunOut | None:
    """The run by `(world_id, id)` in the caller's world, or None. Cached per request, so the
    loader and the route share one lookup."""
    return get_run(session, acting_world(actor), run_id)


WorldRun = Annotated[RatingRunOut | None, Depends(world_run)]


def run_ref(run: WorldRun, actor: OptionalActor, session: SessionDep) -> AssetRef | None:
    """The rated asset of a run in the caller's world (T57), or None (a 404)."""
    return None if run is None else asset_ref_in(session, acting_world(actor), run.asset_id)


@router.post(
    "/assets/{asset_id}/rate",
    response_model=RatingRunAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        403: {
            "description": f"`{DenyReason.ADMIN_ONLY.value}`: only an admin of this world, or a "
            "member of the asset's community, can start a rating run"
        },
        404: {"description": "Asset not found in this world"},
        409: {
            "description": "`run_in_progress` (Location: the active run), `asset_is_draft` or "
            "`asset_not_listed` (listings under review are rated through `/submit`; T58)"
        },
        429: {
            "description": "`rating_rate_limited` (per-world cap) or `rating_global_limit` "
            "(all worlds); see Retry-After"
        },
        503: {"description": "`rating_busy`: too many runs, or the run lock is busy"},
    },
    dependencies=[require_any((Action.OPERATE, Action.MANAGE_LISTING), asset_ref)],
)
def start_rating(
    asset_id: UUID,
    world: CurrentWorld,
    session: SessionDep,
    runner: RunnerDep,
    response: Response,
) -> RatingRunAccepted:
    """Start an async rating run for the asset; follow it with `GET /runs/{run_id}`."""
    # End the request's read transaction so its pooled connection is free while the runner
    # opens its own session and waits (bounded) on the run locks: one connection at a time.
    world_id = world.id  # read before the commit expires the row
    session.commit()
    try:
        run_id = runner.start(world_id, asset_id, trigger="api")
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found") from exc
    except AssetNotRateable as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, exc.code) from exc
    except RunInProgress as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "run_in_progress",
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
    return RatingRunAccepted(run_id=run_id, asset_id=asset_id)


@router.get(
    "/runs/{run_id}", response_model=RatingRunOut, dependencies=[require(Action.BROWSE, run_ref)]
)
def get_rating_run(
    run_id: UUID, world: CurrentWorld, actor: OptionalActor, session: SessionDep, run: WorldRun
) -> RatingRunOut:
    """The run's status and steps, rebuilt from its progress events (any worker can answer).
    A run of a listing under review is its community's and same-world admins' only (T58)."""
    asset = (
        None
        if run is None
        else session.exec(
            select(Asset).where(Asset.world_id == world.id, Asset.id == run.asset_id)
        ).first()
    )
    if run is None or asset is None or not visible_to(actor, asset):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return run

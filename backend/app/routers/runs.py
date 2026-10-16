"""Rating runs (T27): `POST /assets/{asset_id}/rate` → 202 + `run_id`; `GET /runs/{run_id}`.

Both are scoped to the caller's world (401 `world_required` without one, 404 for another
world's asset or run). Progress also streams as `rating_progress` events (`GET /events/stream`).
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.deps import CurrentWorld, SessionDep
from app.routers.assets import world_asset
from app.schemas import RatingRunAccepted, RatingRunOut
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


@router.post(
    "/assets/{asset_id}/rate",
    response_model=RatingRunAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        404: {"description": "Asset not found in this world"},
        409: {"description": "`run_in_progress` (Location: the active run) or `asset_is_draft`"},
        429: {"description": "`rating_rate_limited`: per-world run cap; see Retry-After"},
        503: {"description": "`rating_busy`: too many runs in progress; see Retry-After"},
    },
)
def start_rating(
    asset_id: UUID,
    world: CurrentWorld,
    session: SessionDep,
    runner: RunnerDep,
    response: Response,
) -> RatingRunAccepted:
    """Start an async rating run for the asset; follow it with `GET /runs/{run_id}`."""
    world_asset(session, world.id, asset_id)
    try:
        run_id = runner.start(world.id, asset_id, trigger="api")
    except LookupError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Asset not found") from exc
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
            "rating_rate_limited",
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


@router.get("/runs/{run_id}", response_model=RatingRunOut)
def get_rating_run(run_id: UUID, world: CurrentWorld, session: SessionDep) -> RatingRunOut:
    """The run's status and steps, rebuilt from its progress events (any worker can answer)."""
    run = get_run(session, world.id, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found")
    return run

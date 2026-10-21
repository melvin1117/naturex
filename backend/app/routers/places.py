"""Place search for the listing map (#215): a name in, a few places to fly to out."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.authz import Action, require
from app.deps import SettingsDep
from app.schemas import PlaceSearchOut
from app.services.place_search import (
    ATTRIBUTION,
    NominatimPlaceSearch,
    PlaceSearchBusy,
    PlaceSearchUnavailable,
    default_place_search,
)

router = APIRouter(tags=["places"])

PLACE_SEARCH_BUSY = "place_search_busy"
PLACE_SEARCH_UNAVAILABLE = "place_search_unavailable"


def get_place_search(settings: SettingsDep) -> NominatimPlaceSearch:
    return default_place_search(settings.nominatim_user_agent)


PlaceSearchDep = Annotated[NominatimPlaceSearch, Depends(get_place_search)]
_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"description": "auth_required"},
    429: {"description": PLACE_SEARCH_BUSY},
    503: {"description": PLACE_SEARCH_UNAVAILABLE},
}


@router.get(
    "/places/search",
    response_model=PlaceSearchOut,
    responses=_ERRORS,
    # Signed-in only: the app is not a public proxy for OSMF's free service.
    dependencies=[require(Action.USE_OWN_ACCOUNT)],
)
def search_places(
    searcher: PlaceSearchDep,
    response: Response,
    q: Annotated[str, Query(min_length=2, max_length=120)],
) -> PlaceSearchOut:
    if len(q.strip()) < 2:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Type at least 2 characters.")
    try:
        results = searcher.search(q)
    except PlaceSearchBusy:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, PLACE_SEARCH_BUSY, headers={"Retry-After": "1"}
        ) from None
    except PlaceSearchUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, PLACE_SEARCH_UNAVAILABLE) from None
    response.headers["Cache-Control"] = "private, max-age=3600"
    return PlaceSearchOut(results=results, attribution=ATTRIBUTION)

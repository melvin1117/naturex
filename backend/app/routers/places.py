"""Place search for the listing map (#215): a name in, a few places to fly to out."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.authz import Action, Granted, require
from app.deps import SettingsDep
from app.schemas import PlaceSearchOut
from app.services.place_search import (
    ATTRIBUTION,
    NominatimPlaceSearch,
    PlaceSearchBusy,
    PlaceSearchQuota,
    PlaceSearchRateLimited,
    PlaceSearchUnavailable,
    default_place_search,
    default_place_search_quota,
    normalize_query,
)

router = APIRouter(tags=["places"])

PLACE_QUERY_TOO_SHORT = "place_query_too_short"
PLACE_SEARCH_RATE_LIMITED = "place_search_rate_limited"
PLACE_SEARCH_BUSY = "place_search_busy"
PLACE_SEARCH_UNAVAILABLE = "place_search_unavailable"
MIN_QUERY_CHARS = 2


def get_place_search(settings: SettingsDep) -> NominatimPlaceSearch:
    return default_place_search(settings.nominatim_user_agent)


def get_place_search_quota(settings: SettingsDep) -> PlaceSearchQuota:
    return default_place_search_quota(settings.place_searches_per_user_per_minute)


PlaceSearchDep = Annotated[NominatimPlaceSearch, Depends(get_place_search)]
PlaceSearchQuotaDep = Annotated[PlaceSearchQuota, Depends(get_place_search_quota)]
# Signed-in only: the app is not a public proxy for OSMF's free service.
OwnAccount = Annotated[Granted, require(Action.USE_OWN_ACCOUNT)]
_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"description": "auth_required"},
    422: {"description": f"`{PLACE_QUERY_TOO_SHORT}`: fewer than 2 characters besides spaces"},
    429: {
        "description": f"`{PLACE_SEARCH_RATE_LIMITED}`: this account's searches per minute; "
        f"`{PLACE_SEARCH_BUSY}`: the process's Nominatim slot is more than 2 s away "
        "(`Retry-After: 1`)"
    },
    503: {"description": PLACE_SEARCH_UNAVAILABLE},
}


@router.get("/places/search", response_model=PlaceSearchOut, responses=_ERRORS)
def search_places(
    granted: OwnAccount,
    searcher: PlaceSearchDep,
    quota: PlaceSearchQuotaDep,
    response: Response,
    q: Annotated[str, Query(max_length=120)],
) -> PlaceSearchOut:
    if len(normalize_query(q)) < MIN_QUERY_CHARS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, PLACE_QUERY_TOO_SHORT)
    try:
        quota.take(granted.signed_in.user_id)
        results = searcher.search(q)
    except PlaceSearchRateLimited:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            PLACE_SEARCH_RATE_LIMITED,
            headers={"Retry-After": "60"},
        ) from None
    except PlaceSearchBusy:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, PLACE_SEARCH_BUSY, headers={"Retry-After": "1"}
        ) from None
    except PlaceSearchUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, PLACE_SEARCH_UNAVAILABLE) from None
    response.headers["Cache-Control"] = "private, max-age=3600"
    return PlaceSearchOut(results=results, attribution=ATTRIBUTION)

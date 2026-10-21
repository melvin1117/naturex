"""Find a place by name for the listing map (#215), with OpenStreetMap Nominatim.

Follows OSMF's usage policy (https://operations.osmfoundation.org/policies/nominatim/): the
app's own User-Agent (`NOMINATIM_USER_AGENT`), at most one request per second per process
(shared with the News Scout's reverse geocoding), results cached, and searches only when the
person submits (no search-as-you-type). The query is sent to Nominatim and nowhere else.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from typing import Any, Protocol

import httpx
from pydantic import BaseModel, ValidationError

from app.agents.news_scout import (
    _DEFAULT_NOMINATIM_RATE_LIMITER,
    EXTERNAL_TIMEOUT_S,
    NominatimRateLimiter,
)
from app.schemas import PlaceOut

log = logging.getLogger(__name__)

NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
ATTRIBUTION = "Place search © OpenStreetMap contributors (Nominatim)"
MAX_RESULTS = 5
# Waiting longer than this for the shared 1 request/s slot answers "busy" instead.
MAX_WAIT_S = 2.0
CACHE_TTL_S = 24 * 3600.0
CACHE_MAX_ENTRIES = 512


class PlaceSearchBusy(Exception):
    """Too many searches in this process right now; try again in a second."""


class PlaceSearchUnavailable(Exception):
    """Nominatim couldn't be reached or answered with something unusable."""


class PlaceSearchHttpGet(Protocol):
    def __call__(
        self, url: str, *, params: Mapping[str, Any], headers: Mapping[str, str]
    ) -> Any: ...


class _NominatimPlace(BaseModel):
    display_name: str = ""
    lat: float
    lon: float
    boundingbox: list[float] | None = None


def _http_get(url: str, *, params: Mapping[str, Any], headers: Mapping[str, str]) -> Any:
    with httpx.Client(timeout=EXTERNAL_TIMEOUT_S, follow_redirects=False) as client:
        response = client.get(url, params=dict(params), headers=dict(headers))
        response.raise_for_status()
        return response.json()


def normalize_query(query: str) -> str:
    return " ".join(query.split())


def _place(raw: _NominatimPlace) -> PlaceOut | None:
    label = raw.display_name.strip()
    if not label or not (-90 <= raw.lat <= 90 and -180 <= raw.lon <= 180):
        return None
    bbox: tuple[float, float, float, float] | None = None
    if raw.boundingbox and len(raw.boundingbox) == 4:
        south, north, west, east = raw.boundingbox
        if -90 <= south <= north <= 90 and -180 <= west <= east <= 180:
            bbox = (south, west, north, east)
    return PlaceOut(label=label, lat=raw.lat, lon=raw.lon, bbox=bbox)


class _Cache:
    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._items: OrderedDict[str, tuple[float, list[PlaceOut]]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> list[PlaceOut] | None:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            if self._clock() >= item[0]:
                del self._items[key]
                return None
            self._items.move_to_end(key)
            return item[1]

    def set(self, key: str, places: list[PlaceOut]) -> None:
        with self._lock:
            self._items[key] = (self._clock() + CACHE_TTL_S, places)
            self._items.move_to_end(key)
            while len(self._items) > CACHE_MAX_ENTRIES:
                self._items.popitem(last=False)


class NominatimPlaceSearch:
    def __init__(
        self,
        user_agent: str,
        *,
        http_get: PlaceSearchHttpGet | None = None,
        rate_limiter: NominatimRateLimiter | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not user_agent.strip():
            raise ValueError("NOMINATIM_USER_AGENT must identify the NatureX app")
        self._user_agent = user_agent
        self._http_get = http_get or _http_get
        self._rate_limiter = rate_limiter or _DEFAULT_NOMINATIM_RATE_LIMITER
        self._cache = _Cache(clock)

    def search(self, query: str) -> list[PlaceOut]:
        text = normalize_query(query)
        key = text.casefold()
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        if not self._rate_limiter.wait(MAX_WAIT_S):
            raise PlaceSearchBusy
        try:
            payload = self._http_get(
                NOMINATIM_SEARCH_URL,
                params={"q": text, "format": "jsonv2", "limit": MAX_RESULTS},
                headers={
                    "Accept": "application/json",
                    "Accept-Language": "en",
                    "User-Agent": self._user_agent,
                },
            )
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("place search failed: %s", type(exc).__name__)
            raise PlaceSearchUnavailable from exc
        if not isinstance(payload, list):
            raise PlaceSearchUnavailable
        places: list[PlaceOut] = []
        for item in payload[:MAX_RESULTS]:
            try:
                place = _place(_NominatimPlace.model_validate(item))
            except ValidationError:
                continue
            if place is not None:
                places.append(place)
        self._cache.set(key, places)
        return places


_default: NominatimPlaceSearch | None = None
_default_lock = threading.Lock()


def default_place_search(user_agent: str) -> NominatimPlaceSearch:
    """One searcher (and cache) per process."""
    global _default
    with _default_lock:
        if _default is None or _default._user_agent != user_agent:
            _default = NominatimPlaceSearch(user_agent)
        return _default

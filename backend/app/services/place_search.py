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
from collections import OrderedDict, deque
from collections.abc import Callable, Mapping
from concurrent.futures import Future
from typing import Any, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, ValidationError

from app.schemas import PlaceOut
from app.services.nominatim import DEFAULT_NOMINATIM_RATE_LIMITER, NominatimRateLimiter

log = logging.getLogger(__name__)

NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
ATTRIBUTION = "Place search © OpenStreetMap contributors (Nominatim)"
MAX_RESULTS = 5
# Waiting longer than this for the shared 1 request/s slot answers "busy" instead.
MAX_WAIT_S = 2.0
CACHE_TTL_S = 24 * 3600.0
CACHE_MAX_ENTRIES = 512
EXTERNAL_TIMEOUT_S = 10.0
QUOTA_WINDOW_S = 60.0


class PlaceSearchBusy(Exception):
    """Too many searches in this process right now; try again in a second."""


class PlaceSearchUnavailable(Exception):
    """Nominatim couldn't be reached or answered with something unusable."""


class PlaceSearchRateLimited(Exception):
    """This account has searched too often in the last minute."""


class PlaceSearchQuota:
    """Searches per account per rolling minute, in this process (like the Nominatim slot): keeps
    one account from spending the whole process's 1 request/s on its own."""

    def __init__(self, per_minute: int, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.per_minute = per_minute
        self._clock = clock
        self._seen: dict[UUID, deque[float]] = {}
        self._lock = threading.Lock()

    def take(self, user_id: UUID) -> None:
        """Count one search for `user_id`, or raise `PlaceSearchRateLimited` (not counted)."""
        with self._lock:
            now = self._clock()
            recent = self._seen.setdefault(user_id, deque())
            while recent and recent[0] <= now - QUOTA_WINDOW_S:
                recent.popleft()
            if len(recent) >= self.per_minute:
                raise PlaceSearchRateLimited
            recent.append(now)
            # Forget idle accounts so the map stays as small as the last minute's searchers.
            for idle in [u for u, times in self._seen.items() if not times]:
                del self._seen[idle]


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
        self.user_agent = user_agent
        self._http_get = http_get or _http_get
        self._rate_limiter = rate_limiter or DEFAULT_NOMINATIM_RATE_LIMITER
        self._cache = _Cache(clock)
        # Identical searches in flight share one Nominatim request.
        self._in_flight: dict[str, Future[list[PlaceOut]]] = {}
        self._in_flight_lock = threading.Lock()

    def search(self, query: str) -> list[PlaceOut]:
        text = normalize_query(query)
        key = text.casefold()
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        with self._in_flight_lock:
            pending = self._in_flight.get(key)
            if pending is None:
                mine: Future[list[PlaceOut]] = Future()
                self._in_flight[key] = mine
        if pending is not None:
            return pending.result()
        try:
            places = self._fetch(text)
        except BaseException as exc:
            mine.set_exception(exc)
            raise
        else:
            # Only answers are cached (empty ones too); a failure is retried next time.
            self._cache.set(key, places)
            mine.set_result(places)
            return places
        finally:
            with self._in_flight_lock:
                self._in_flight.pop(key, None)

    def _fetch(self, text: str) -> list[PlaceOut]:
        if not self._rate_limiter.wait(MAX_WAIT_S):
            raise PlaceSearchBusy
        try:
            payload = self._http_get(
                NOMINATIM_SEARCH_URL,
                params={"q": text, "format": "jsonv2", "limit": MAX_RESULTS},
                headers={
                    "Accept": "application/json",
                    "Accept-Language": "en",
                    "User-Agent": self.user_agent,
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
        return places


_default: NominatimPlaceSearch | None = None
_default_quota: PlaceSearchQuota | None = None
_default_lock = threading.Lock()


def default_place_search(user_agent: str) -> NominatimPlaceSearch:
    """One searcher (and cache) per process, replaced if the User-Agent setting changes."""
    global _default
    with _default_lock:
        if _default is None or _default.user_agent != user_agent:
            _default = NominatimPlaceSearch(user_agent)
        return _default


def default_place_search_quota(per_minute: int) -> PlaceSearchQuota:
    """One per-account quota per process, replaced if its setting changes."""
    global _default_quota
    with _default_lock:
        if _default_quota is None or _default_quota.per_minute != per_minute:
            _default_quota = PlaceSearchQuota(per_minute)
        return _default_quota

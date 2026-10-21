"""Place search for the listing map (#215): Nominatim usage policy, parsing and the route."""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import httpx
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine
from sqlmodel import Session

from app.agents.news_scout import NominatimRateLimiter
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.routers.places import get_place_search
from app.sandbox import ensure_live_world
from app.seed import seed
from app.services.place_search import (
    MAX_RESULTS,
    NOMINATIM_SEARCH_URL,
    NominatimPlaceSearch,
    PlaceSearchBusy,
    PlaceSearchUnavailable,
)
from tests.conftest import alembic_cfg, requires_db

XOCHIMILCO = {
    "display_name": "Xochimilco, Mexico City, Mexico",
    "lat": "19.2572",
    "lon": "-99.1031",
    "boundingbox": ["19.1", "19.3", "-99.2", "-99.0"],
}


class FakeGet:
    def __init__(self, payload: Any = None, error: Exception | None = None) -> None:
        self.payload = [XOCHIMILCO] if payload is None else payload
        self.error = error
        self.calls: list[tuple[str, Mapping[str, Any], Mapping[str, str]]] = []

    def __call__(self, url: str, *, params: Mapping[str, Any], headers: Mapping[str, str]) -> Any:
        self.calls.append((url, params, headers))
        if self.error:
            raise self.error
        return self.payload


class Clock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def searcher(get: FakeGet, clock: Clock | None = None) -> NominatimPlaceSearch:
    clock = clock or Clock()
    return NominatimPlaceSearch(
        "NatureX-test/1 (test@example.com)",
        http_get=get,
        rate_limiter=NominatimRateLimiter(clock=clock, sleep=clock.sleep),
        clock=clock,
    )


def test_search_identifies_the_app_and_parses_places() -> None:
    get = FakeGet()
    places = searcher(get).search("  Xochimilco   wetland ")

    assert [p.model_dump() for p in places] == [
        {
            "label": "Xochimilco, Mexico City, Mexico",
            "lat": 19.2572,
            "lon": -99.1031,
            "bbox": (19.1, -99.2, 19.3, -99.0),
        }
    ]
    url, params, headers = get.calls[0]
    assert url == NOMINATIM_SEARCH_URL
    assert params == {"q": "Xochimilco wetland", "format": "jsonv2", "limit": MAX_RESULTS}
    assert headers["User-Agent"] == "NatureX-test/1 (test@example.com)"


def test_repeated_searches_are_cached_case_insensitively() -> None:
    get = FakeGet()
    search = searcher(get)
    first = search.search("Xochimilco")
    assert search.search("xochimilco ") == first
    assert len(get.calls) == 1


def test_searches_are_spaced_one_second_apart_and_busy_beyond_the_wait() -> None:
    clock = Clock()
    limiter = NominatimRateLimiter(clock=clock, sleep=lambda _s: None)
    search = NominatimPlaceSearch(
        "NatureX-test/1", http_get=FakeGet(), rate_limiter=limiter, clock=clock
    )
    search.search("a place")
    search.search("another place")  # waits 1 s for its slot (sleep is a no-op here)
    search.search("a third place")  # 2 s
    with pytest.raises(PlaceSearchBusy):
        search.search("one too many")  # would wait 3 s


def test_drops_unusable_results_and_bad_bounding_boxes() -> None:
    payload = [
        {"display_name": "", "lat": "1", "lon": "1"},
        {"display_name": "Nowhere", "lat": "north", "lon": "1"},
        {"display_name": "Off the map", "lat": "95", "lon": "1"},
        {**XOCHIMILCO, "boundingbox": ["19.3", "19.1", "-99.2", "-99.0"]},
    ]
    places = searcher(FakeGet(payload)).search("x y")
    assert len(places) == 1
    assert places[0].bbox is None


@pytest.mark.parametrize(
    "get",
    [
        FakeGet(error=httpx.ConnectError("offline")),
        FakeGet(error=ValueError("not json")),
        FakeGet(payload={"error": "Unable to geocode"}),
    ],
)
def test_failures_are_unavailable(get: FakeGet) -> None:
    with pytest.raises(PlaceSearchUnavailable):
        searcher(get).search("Xochimilco")


def test_needs_a_user_agent() -> None:
    with pytest.raises(ValueError, match="NOMINATIM_USER_AGENT"):
        NominatimPlaceSearch(" ")


# --- Route ---------------------------------------------------------------------------------


@pytest.fixture
def conn() -> Iterator[Connection]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        outer = connection.begin()
        yield connection
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(conn: Connection) -> Iterator[TestClient]:
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    seed(db)
    ensure_live_world(db)
    app.dependency_overrides[get_session] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()
    db.close()


def sign_up(client: TestClient) -> None:
    res = client.post(
        "/auth/register",
        json={"email": "rosa@example.com", "password": "correct horse battery", "name": "Rosa"},
    )
    assert res.status_code == 201, res.text


@requires_db
def test_route_needs_a_signed_in_person(client: TestClient) -> None:
    app.dependency_overrides[get_place_search] = lambda: searcher(FakeGet())
    assert client.get("/places/search", params={"q": "Xochimilco"}).status_code == 401


@requires_db
def test_route_returns_places_with_attribution(client: TestClient) -> None:
    get = FakeGet()
    app.dependency_overrides[get_place_search] = lambda: searcher(get)
    sign_up(client)

    res = client.get("/places/search", params={"q": "Xochimilco"})

    assert res.status_code == 200
    body = res.json()
    assert body["results"][0]["label"] == "Xochimilco, Mexico City, Mexico"
    assert body["results"][0]["bbox"] == [19.1, -99.2, 19.3, -99.0]
    assert "OpenStreetMap" in body["attribution"]
    assert client.get("/places/search", params={"q": "x"}).status_code == 422
    assert client.get("/places/search", params={"q": "  "}).status_code == 422


@requires_db
def test_route_maps_failures_to_codes(client: TestClient) -> None:
    sign_up(client)
    app.dependency_overrides[get_place_search] = lambda: searcher(
        FakeGet(error=httpx.ConnectError("offline"))
    )
    res = client.get("/places/search", params={"q": "Xochimilco"})
    assert (res.status_code, res.json()["detail"]) == (503, "place_search_unavailable")

    class Busy(NominatimPlaceSearch):
        def search(self, query: str) -> list[Any]:
            raise PlaceSearchBusy

    app.dependency_overrides[get_place_search] = lambda: Busy("NatureX-test/1")
    res = client.get("/places/search", params={"q": "Xochimilco"})
    assert (res.status_code, res.json()["detail"]) == (429, "place_search_busy")
    assert res.headers["Retry-After"] == "1"

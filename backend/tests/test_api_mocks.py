"""Contract smoke tests for mock API routes (T08). Ledger coverage is in test_ledger.py;
orders/portfolio coverage is in test_market_api.py."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.mocks import REPORT_WETLAND, WETLAND_ID, news_scout_fixture
from app.schemas import AuditorOutput, NewsScoutItem, NewsScoutOutput

client = TestClient(app)


def test_list_assets() -> None:
    res = client.get("/assets")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 3
    assert {a["site_key"] for a in data} == {
        "wetland_mx",
        "mangrove_mx",
        "restoration_forest",
    }


def test_get_asset_with_report() -> None:
    res = client.get(f"/assets/{WETLAND_ID}")
    assert res.status_code == 200
    body = res.json()
    assert body["latest_report"]["grade"] == "A"
    assert body["latest_report"]["auditor"]["auditor_adjustment"] == -2


def test_create_asset_accepted() -> None:
    res = client.post(
        "/assets",
        json={
            "name": "Test Parcel",
            "geojson": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
        },
    )
    assert res.status_code == 202
    assert "run_id" in res.json()


def test_admin_and_copilot() -> None:
    assert client.post("/admin/simulate/quarter").status_code == 200
    assert (
        client.post(
            "/admin/simulate/event",
            json={"asset_id": str(WETLAND_ID), "preset": "encroachment"},
        ).status_code
        == 200
    )
    assert client.get("/admin/trace", params={"asset_id": str(WETLAND_ID)}).status_code == 200
    assert client.post("/copilot", json={"question": "Why did it drop?"}).status_code == 200


def test_events_require_world_cookie_and_report_still_works() -> None:
    event_res = client.get("/events")
    assert (event_res.status_code, event_res.json()["detail"]) == (401, "world_required")
    assert client.get(f"/reports/{REPORT_WETLAND}").status_code == 200


def test_agent_schemas_validate_fixtures() -> None:
    items = news_scout_fixture()
    for item in items:
        NewsScoutItem.model_validate(item.model_dump())
    NewsScoutOutput(events=items)
    report = client.get(f"/assets/{WETLAND_ID}").json()["latest_report"]
    AuditorOutput.model_validate(report["auditor"])


def test_openapi_contains_core_paths() -> None:
    paths = client.get("/openapi.json").json()["paths"]
    for path in (
        "/assets",
        "/assets/{asset_id}",
        "/orders",
        "/portfolio",
        "/copilot",
        "/events",
        "/events/stream",
        "/admin/simulate/quarter",
        "/admin/tamper-demo",
        "/ledger/{asset_id}",
        "/ledger/{asset_id}/verify",
    ):
        assert path in paths

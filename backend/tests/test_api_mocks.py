"""Contract smoke tests for the routes that are still stubs (T08). Assets and reports are real
since T19 (test_reports_api.py); ledger coverage is in test_ledger.py; orders/portfolio
coverage is in test_market_api.py."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.mocks import REPORT_WETLAND, WETLAND_ID, news_scout_fixture, wetland_report
from app.schemas import AuditorOutput, NewsScoutItem, NewsScoutOutput

client = TestClient(app)


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


def test_world_scoped_routes_require_a_world_cookie() -> None:
    for path in ("/events", "/assets", f"/assets/{WETLAND_ID}", f"/reports/{REPORT_WETLAND}"):
        res = client.get(path)
        assert (res.status_code, res.json()["detail"]) == (401, "world_required"), path


def test_agent_schemas_validate_fixtures() -> None:
    items = news_scout_fixture()
    for item in items:
        NewsScoutItem.model_validate(item.model_dump())
    NewsScoutOutput(events=items)
    auditor = wetland_report().auditor
    assert auditor is not None
    AuditorOutput.model_validate(auditor.model_dump())


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

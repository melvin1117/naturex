"""Real reports and assets API, scoped to the caller's world (T19)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session, select

from app.agents.summary import clear_summary_cache
from app.config import Settings, get_settings
from app.db import get_session
from app.llm import LLMClient
from app.main import app
from app.models import Asset, Report
from app.routers import reports as reports_router
from app.routers.assets import SPARKLINE_POINTS
from app.sandbox import create_world, ensure_live_world
from app.schemas import ReportSummarySource
from app.seed import DEMO_SITES, LIVE_WORLD_ID, WORLD_ID, seed
from app.services.rating import latest_report, rate_asset
from app.tools.earth_obs import load_site_metrics
from tests.conftest import alembic_cfg, requires_db
from tests.test_summary import FakeTransport, MemoryCallLog, reply
from tests.test_summary import settings as summary_settings
from tests.worlds import start_demo

HERO = "wetland_mx"
D = Decimal


@pytest.fixture
def session() -> Iterator[Session]:
    """A session inside a transaction that is rolled back, so test worlds never persist."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    # USE_MOCKS=true (the default): no live LLM call, but every number comes from the DB.
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, use_mocks=True)
    clear_summary_cache()
    with TestClient(app) as test_client:
        start_demo(test_client, session)
        yield test_client
    app.dependency_overrides.clear()
    clear_summary_cache()


def _world(client: TestClient) -> dict[str, Any]:
    """The client's demo sandbox and its contents."""
    res = client.get("/world")
    assert res.status_code == 200
    body: dict[str, Any] = res.json()
    return body


def _asset_id(world: dict[str, Any], site_key: str = HERO) -> str:
    return str(next(a["id"] for a in world["assets"] if a["site_key"] == site_key))


def _world_asset(session: Session, world_id: UUID, site_key: str = HERO) -> Asset:
    return session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.site_key == site_key)
    ).one()


def _rate_restoration(session: Session, world_id: UUID) -> Report:
    asset = _world_asset(session, world_id)
    metrics = load_site_metrics(HERO, "restoration")
    report = rate_asset(session, world_id, asset, metrics=metrics, as_of=date(2026, 10, 1))
    session.commit()
    return report


@requires_db
def test_marketplace_cards_carry_real_report_and_price_numbers(client: TestClient) -> None:
    world = _world(client)

    res = client.get("/assets")

    assert res.status_code == 200
    cards = {card["site_key"]: card for card in res.json()}
    assert set(cards) == {site.key for site in DEMO_SITES}
    hero = cards[HERO]
    assert hero["id"] == _asset_id(world)
    assert hero["name"] == "Xochimilco Wetland"
    assert hero["status"] == "listed"
    assert (D(hero["health_score"]), hero["grade"], D(hero["confidence"])) == (
        D("76.2"),
        "A",
        D("71.0"),
    )
    assert (D(hero["value_low"]), D(hero["value_mid"]), D(hero["value_high"])) == (
        D("2121067"),
        D("2669511"),
        D("2669511"),
    )
    assert D(hero["price"]) == D("21.4723")
    assert hero["price_change_pct"] == 0.0
    assert hero["trend"] is None
    assert [D(p) for p in hero["sparkline"]] == [D("21.4723")]
    assert (cards["mangrove_mx"]["grade"], D(cards["mangrove_mx"]["price"])) == (
        "AA",
        D("285.1519"),
    )
    assert (cards["restoration_forest"]["grade"], D(cards["restoration_forest"]["price"])) == (
        "A",
        D("19.5456"),
    )


@requires_db
def test_marketplace_price_change_and_trend_follow_trades_and_new_reports(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    assert client.post(
        "/orders", json={"asset_id": _asset_id(world), "side": "buy", "qty": 100}
    ).is_success
    _rate_restoration(session, UUID(world["id"]))

    hero = next(c for c in client.get("/assets").json() if c["site_key"] == HERO)

    assert hero["price_change_pct"] > 0
    assert (hero["grade"], hero["trend"]) == ("AA", "improving")


@requires_db
def test_card_sparklines_keep_the_latest_prices_oldest_first(client: TestClient) -> None:
    world = _world(client)
    asset_id = _asset_id(world)
    for _ in range(SPARKLINE_POINTS + 2):
        assert client.post(
            "/orders", json={"asset_id": asset_id, "side": "buy", "qty": 1}
        ).is_success
    history = [D(p["price"]) for p in client.get(f"/assets/{asset_id}/prices").json()]
    assert len(history) == SPARKLINE_POINTS + 3

    cards = {c["site_key"]: c for c in client.get("/assets").json()}

    assert [D(p) for p in cards[HERO]["sparkline"]] == history[-SPARKLINE_POINTS:]
    assert [D(p) for p in cards["mangrove_mx"]["sparkline"]] == [D("285.1519")]


@requires_db
def test_asset_detail_carries_the_change_since_the_ipo(client: TestClient) -> None:
    world = _world(client)
    asset_id = _asset_id(world)
    assert client.get(f"/assets/{asset_id}").json()["price_change_pct"] == 0.0
    assert client.post("/orders", json={"asset_id": asset_id, "side": "buy", "qty": 100}).is_success

    detail = client.get(f"/assets/{asset_id}").json()
    card = next(c for c in client.get("/assets").json() if c["id"] == asset_id)

    assert detail["price_change_pct"] > 0
    assert detail["price_change_pct"] == card["price_change_pct"]
    assert D(detail["price"]) == D(card["price"])


@requires_db
def test_asset_detail_serves_the_stored_report(client: TestClient) -> None:
    world = _world(client)

    res = client.get(f"/assets/{_asset_id(world)}")

    assert res.status_code == 200
    body = res.json()
    assert D(body["price"]) == D("21.4723")
    assert body["recent_events"] == []
    report = body["latest_report"]
    assert report["version"] == 1
    assert (D(report["health_score"]), report["grade"], D(report["confidence"])) == (
        D("76.2"),
        "A",
        D("71.0"),
    )
    assert D(report["fair_value_per_share"]) == D("21.4723")
    assert sum(report["value_breakdown"].values()) == 2_669_511
    assert [f["type"] for f in report["flags"]] == [
        "low_bound_fallback:shrubland",
        "auditor_pending",
    ]
    assert (report["data_version"], report["period"], report["simulated"]) == (
        "2026Q3",
        "2026Q3",
        False,
    )
    assert report["rating"]["score"]["health"] == "76.2"
    assert report["auditor"] is None
    assert report["recommendations"] == []
    assert report["summary_source"] == ReportSummarySource.FALLBACK.value
    assert "Health 76.2 / 100 (grade A)" in report["summary_md"]


@requires_db
def test_report_history_lists_every_version_newest_first(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    second = _rate_restoration(session, UUID(world["id"]))

    res = client.get(f"/assets/{_asset_id(world)}/reports")

    assert res.status_code == 200
    reports = res.json()
    assert [r["version"] for r in reports] == [2, 1]
    assert reports[0]["id"] == str(second.id)
    assert (reports[0]["simulated"], reports[0]["data_version"], reports[0]["period"]) == (
        True,
        "sim-1",
        "2026Q4",
    )
    assert reports[0]["flags"][0]["type"] == "simulated"
    assert "simulated Time Machine scenario" in reports[0]["summary_md"]
    latest = client.get(f"/assets/{_asset_id(world)}").json()["latest_report"]
    assert latest["id"] == str(second.id)


@requires_db
def test_single_reports_carry_the_ndvi_series_of_their_own_metrics(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    observed = [p.model_dump() for p in load_site_metrics(HERO).ndvi_series]
    simulated = [p.model_dump() for p in load_site_metrics(HERO, "restoration").ndvi_series]
    first = client.get(f"/assets/{_asset_id(world)}").json()["latest_report"]
    assert first["ndvi_series"] == observed
    assert [p["month"] for p in observed] == sorted(p["month"] for p in observed)
    assert len(observed) >= 48

    second = _rate_restoration(session, UUID(world["id"]))

    latest = client.get(f"/assets/{_asset_id(world)}").json()["latest_report"]
    assert (latest["id"], latest["ndvi_series"]) == (str(second.id), simulated)
    assert client.get(f"/reports/{first['id']}").json()["ndvi_series"] == observed


@requires_db
def test_the_report_version_list_leaves_out_the_ndvi_series(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    _rate_restoration(session, UUID(world["id"]))

    reports = client.get(f"/assets/{_asset_id(world)}/reports").json()

    assert [r["version"] for r in reports] == [2, 1]
    assert [r["ndvi_series"] for r in reports] == [[], []]


@requires_db
def test_reports_without_metrics_have_an_empty_ndvi_series(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    world_id = UUID(world["id"])
    report = latest_report(session, world_id, _world_asset(session, world_id).id)
    assert report is not None
    report.metrics_id = None
    session.add(report)
    session.commit()

    res = client.get(f"/reports/{report.id}")

    assert res.status_code == 200
    assert res.json()["ndvi_series"] == []


@requires_db
def test_a_metrics_row_of_another_world_is_never_served(
    client: TestClient, session: Session
) -> None:
    world = _world(client)
    world_id = UUID(world["id"])
    report = latest_report(session, world_id, _world_asset(session, world_id).id)
    template = latest_report(session, WORLD_ID, _world_asset(session, WORLD_ID).id)
    assert report is not None and template is not None and template.metrics_id is not None
    report.metrics_id = template.metrics_id
    session.add(report)
    session.commit()

    assert client.get(f"/reports/{report.id}").json()["ndvi_series"] == []
    detail = client.get(f"/assets/{_asset_id(world)}").json()
    assert detail["latest_report"]["ndvi_series"] == []


@requires_db
def test_get_report_and_diff(client: TestClient, session: Session) -> None:
    world = _world(client)
    first = client.get(f"/assets/{_asset_id(world)}").json()["latest_report"]
    second = _rate_restoration(session, UUID(world["id"]))

    res = client.get(f"/reports/{first['id']}")
    diff = client.get(f"/reports/{second.id}/diff/{first['id']}")

    assert res.status_code == 200
    assert res.json() == first
    assert diff.status_code == 200
    changes = diff.json()["changes"]
    assert changes[0] == "health_score: 76.20 → 87.10"
    assert changes[1] == "grade: A → AA"


@requires_db
def test_diff_rejects_reports_of_different_assets(client: TestClient, session: Session) -> None:
    world = _world(client)
    world_id = UUID(world["id"])
    hero = latest_report(session, world_id, _world_asset(session, world_id).id)
    mangrove = latest_report(session, world_id, _world_asset(session, world_id, "mangrove_mx").id)
    assert hero is not None and mangrove is not None

    assert client.get(f"/reports/{hero.id}/diff/{mangrove.id}").status_code == 400


@requires_db
def test_price_history_is_the_worlds_price_rows(client: TestClient) -> None:
    world = _world(client)
    asset_id = _asset_id(world)
    assert client.post("/orders", json={"asset_id": asset_id, "side": "buy", "qty": 10}).is_success

    res = client.get(f"/assets/{asset_id}/prices")

    assert res.status_code == 200
    points = res.json()
    assert [p["reason"] for p in points] == ["ipo", "order"]
    assert D(points[0]["price"]) == D("21.4723")


@requires_db
def test_reports_and_assets_of_other_worlds_are_not_found(
    client: TestClient, session: Session
) -> None:
    _world(client)
    other = create_world(session)
    other_asset = _world_asset(session, other.id)
    other_report = latest_report(session, other.id, other_asset.id)
    template_asset = _world_asset(session, WORLD_ID)
    template_report = latest_report(session, WORLD_ID, template_asset.id)
    assert other_report is not None and template_report is not None

    for asset_id in (other_asset.id, template_asset.id):
        for path in ("", "/reports", "/prices"):
            assert client.get(f"/assets/{asset_id}{path}").status_code == 404, path
    for report_id in (other_report.id, template_report.id):
        assert client.get(f"/reports/{report_id}").status_code == 404
    listed = {card["id"] for card in client.get("/assets").json()}
    assert str(other_asset.id) not in listed and str(template_asset.id) not in listed


@requires_db
def test_anonymous_reads_see_the_live_world_only(client: TestClient, session: Session) -> None:
    report = latest_report(session, WORLD_ID, _world_asset(session, WORLD_ID).id)
    assert report is not None
    ensure_live_world(session)
    anonymous = TestClient(app)

    for path in (f"/assets/{report.asset_id}", f"/reports/{report.id}"):
        assert anonymous.get(path).status_code == 404, path
    listed = anonymous.get("/assets")
    assert listed.status_code == 200
    live = {a.id for a in session.exec(select(Asset).where(Asset.world_id == LIVE_WORLD_ID))}
    assert {UUID(card["id"]) for card in listed.json()} == live


@requires_db
def test_two_worlds_share_one_live_summary_per_report(
    client: TestClient, session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    transport = FakeTransport(
        reply(json.dumps({"summary_md": "Health is 76.2 / 100 (grade A) at 71% confidence."}))
    )

    def fake_summary_client(config: Settings) -> LLMClient:
        return LLMClient(config, transport, MemoryCallLog())

    app.dependency_overrides[get_settings] = lambda: summary_settings(use_mocks=False)
    monkeypatch.setattr(reports_router, "_summary_client", fake_summary_client)
    first_world = _world(client)
    first = client.get(f"/assets/{_asset_id(first_world)}").json()["latest_report"]
    client.cookies.clear()
    start_demo(client, session)
    second_world = _world(client)
    second = client.get(f"/assets/{_asset_id(second_world)}").json()["latest_report"]

    assert first_world["id"] != second_world["id"] and first["id"] != second["id"]
    assert first["summary_source"] == second["summary_source"] == "live"
    assert first["summary_md"] == second["summary_md"]
    assert len(transport.requests) == 1


@requires_db
def test_simulate_event_is_scoped_to_the_callers_world(
    client: TestClient, session: Session
) -> None:
    template_asset = _world_asset(session, WORLD_ID)
    body = {"asset_id": str(template_asset.id), "preset": "encroachment"}
    no_world = TestClient(app).post("/admin/simulate/event", json=body)
    investor = client.post(
        "/admin/simulate/event", json={**body, "asset_id": _asset_id(_world(client))}
    )
    start_demo(client, session, persona_key="admin")  # the Time Machine is for admins (T57)
    world = _world(client)
    other_asset = _world_asset(session, create_world(session).id)

    own = client.post("/admin/simulate/event", json={**body, "asset_id": _asset_id(world)})

    assert (no_world.status_code, no_world.json()["detail"]) == (401, "auth_required")
    assert (investor.status_code, investor.json()["detail"]) == (403, "admin_only")
    assert own.status_code == 200
    assert own.json()["event"]["asset_id"] == _asset_id(world)
    for asset_id in (template_asset.id, other_asset.id):
        res = client.post("/admin/simulate/event", json={**body, "asset_id": str(asset_id)})
        assert res.status_code == 404

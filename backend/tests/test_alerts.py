"""T75 alerts: thresholds (pure), delivery to holders and the community only, read/unread API."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlmodel import Session, select

from app import events
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import (
    Alert,
    AlertRecipient,
    Asset,
    Holding,
    Report,
    StreamEventType,
    User,
    UserKind,
    VerificationLevel,
    World,
)
from app.sandbox import create_world, ensure_live_world
from app.schemas import NewsScoutItem
from app.seed import seed
from app.services import alerts
from app.services.alerts import (
    AlertKind,
    RatingSnapshot,
    news_alert,
    news_key,
    rating_alert,
    safe_url,
    verification_alert,
)
from tests.conftest import alembic_cfg, requires_db
from tests.worlds import start_demo

REPORT = UUID("aaaaaaaa-0000-0000-0000-000000000001")
ASSET = UUID("bbbbbbbb-0000-0000-0000-000000000001")


def snap(health: str | None, grade: str | None) -> RatingSnapshot:
    return RatingSnapshot(Decimal(health) if health is not None else None, grade)


def item(severity: int, **overrides: object) -> NewsScoutItem:
    base: dict[str, object] = {
        "id": "evt-1",
        "relevant": True,
        "impact_type": "fire",
        "direction": -1,
        "severity": severity,
        "summary": "A fire burned part of the reserve's buffer zone.",
        "published_at": date(2026, 10, 1),
        "title": "Fire near the reserve",
        "url": "https://news.example.org/fire",
    }
    return NewsScoutItem.model_validate({**base, **overrides})


# --- thresholds (pure) --------------------------------------------------------------------------


def test_a_first_rating_never_alerts() -> None:
    assert rating_alert("Site", None, snap("40", "B"), report_id=REPORT) is None


@pytest.mark.parametrize(
    ("before", "after"),
    [("70.0", "74.9"), ("74.9", "70.0"), ("80.0", "80.0"), ("61.0", "64.9")],
)
def test_health_moves_under_five_points_with_the_same_grade_are_quiet(
    before: str, after: str
) -> None:
    grade = "A" if Decimal(before) >= 70 else "BBB"
    assert rating_alert("Site", snap(before, grade), snap(after, grade), report_id=REPORT) is None


def test_a_five_point_drop_alerts_as_a_health_change() -> None:
    draft = rating_alert("Site", snap("79.0", "A"), snap("74.0", "A"), report_id=REPORT)

    assert draft is not None
    assert draft.kind is AlertKind.HEALTH_CHANGE
    assert draft.severity == 3
    assert draft.title == "Site: health fell 5.0 points"
    assert draft.message == "Health 79.0 → 74.0 (−5.0 points)."
    assert (draft.dedupe_key, draft.report_id) == (f"report:{REPORT}", REPORT)


def test_a_five_point_rise_alerts_with_a_low_severity() -> None:
    draft = rating_alert("Site", snap("70.0", "A"), snap("75.0", "A"), report_id=REPORT)

    assert draft is not None and draft.kind is AlertKind.HEALTH_CHANGE
    assert draft.severity == 2
    assert draft.title == "Site: health rose 5.0 points"


def test_a_grade_change_alerts_even_on_a_small_move() -> None:
    draft = rating_alert("Site", snap("70.5", "A"), snap("69.5", "BBB"), report_id=REPORT)

    assert draft is not None
    assert draft.kind is AlertKind.GRADE_CHANGE
    assert draft.severity == 4
    assert draft.title == "Site downgraded to BBB"
    assert draft.message == "Health 70.5 → 69.5 (−1.0 points). Grade A → BBB."


def test_an_upgrade_and_a_big_drop() -> None:
    up = rating_alert("Site", snap("69.0", "BBB"), snap("71.0", "A"), report_id=REPORT)
    drop = rating_alert("Site", snap("79.0", "A"), snap("69.0", "BBB"), report_id=REPORT)
    big = rating_alert("Site", snap("89.0", "AA"), snap("80.0", "AA"), report_id=REPORT)

    assert up is not None and (up.title, up.severity) == ("Site upgraded to A", 2)
    assert drop is not None and drop.severity == 4
    assert big is not None and (big.kind, big.severity) == (AlertKind.HEALTH_CHANGE, 3)
    huge = rating_alert("Site", snap("89.0", "AA"), snap("79.0", "AA"), report_id=REPORT)
    assert huge is not None and huge.severity == 4


def test_news_alerts_on_relevant_severity_four_or_more_only() -> None:
    assert news_alert(ASSET, "Site", item(3)) is None
    assert news_alert(ASSET, "Site", item(5, relevant=False)) is None
    for severity in (4, 5):
        draft = news_alert(ASSET, "Site", item(severity))
        assert draft is not None
        assert draft.kind is AlertKind.NEWS and draft.severity == severity
        assert draft.title == "Fire reported near Site"
        assert draft.message == "A fire burned part of the reserve's buffer zone."
        assert draft.url == "https://news.example.org/fire"


def test_news_keys_are_stable_per_asset_and_article() -> None:
    assert news_key(ASSET, item(4)) == news_key(ASSET, item(5))
    assert news_key(ASSET, item(4)) != news_key(uuid4(), item(4))
    assert news_key(ASSET, item(4)) != news_key(ASSET, item(4, id="evt-2"))


def test_a_verification_decision_alerts_once_per_run_and_level_without_its_reason() -> None:
    run = uuid4()
    approved = verification_alert("Laguna Viva", run, VerificationLevel.VERIFIED)
    rejected = verification_alert("Laguna Viva", run, VerificationLevel.REJECTED)
    revoked = verification_alert("Laguna Viva", run, VerificationLevel.REVOKED)
    assert approved is not None and rejected is not None and revoked is not None
    assert {d.kind for d in (approved, rejected, revoked)} == {AlertKind.VERIFICATION}
    assert (approved.title, approved.severity) == ("Laguna Viva: land documents verified", 2)
    assert (rejected.title, rejected.severity) == ("Laguna Viva: documents not approved", 3)
    assert (revoked.title, revoked.severity) == ("Laguna Viva: verification revoked", 4)
    assert "Verification on the Steward home" in rejected.message
    assert "until new documents are approved" in revoked.message
    keys = {d.dedupe_key for d in (approved, rejected, revoked)}
    assert keys == {f"verification:{run}:{level}" for level in ("verified", "rejected", "revoked")}
    assert verification_alert("Laguna Viva", run, VerificationLevel.DOCUMENTS_SUBMITTED) is None
    assert verification_alert("Laguna Viva", run, VerificationLevel.UNVERIFIED) is None


@pytest.mark.parametrize(
    "url", ["javascript:alert(1)", "data:text/html,x", "//evil.example", "ftp://x.org/a", ""]
)
def test_only_http_links_are_kept(url: str) -> None:
    assert safe_url(url) is None
    assert news_alert(ASSET, "Site", item(4, url=url or None)).url is None  # type: ignore[union-attr]


# --- delivery (DB) ------------------------------------------------------------------------------


@pytest.fixture
def session() -> Iterator[Session]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        db = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(db)
        ensure_live_world(db)
        yield db
        db.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: session
    yield TestClient(app)
    app.dependency_overrides.clear()


def persona(session: Session, world_id: UUID, key: str) -> User:
    return session.exec(
        select(User).where(User.world_id == world_id, User.persona_key == key)
    ).one()


def first_asset(session: Session, world_id: UUID) -> Asset:
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id).order_by(Asset.site_key)
    ).first()
    assert asset is not None
    return asset


def hold(session: Session, world_id: UUID, user: User, asset: Asset, shares: int = 10) -> None:
    session.add(Holding(world_id=world_id, user_id=user.id, asset_id=asset.id, shares=shares))
    session.flush()


def grade_drop(session: Session, world: World, asset: Asset) -> Alert:
    report = session.exec(
        select(Report).where(Report.world_id == world.id, Report.asset_id == asset.id)
    ).first()
    assert report is not None
    draft = rating_alert(asset.name, snap("75.0", "A"), snap("65.0", "BBB"), report_id=report.id)
    assert draft is not None
    alert = alerts.raise_alert(session, world.id, asset, draft)
    assert alert is not None
    session.commit()
    return alert


def recipients(session: Session, alert: Alert) -> set[UUID]:
    rows = session.exec(select(AlertRecipient).where(AlertRecipient.alert_id == alert.id)).all()
    return {row.user_id for row in rows}


@requires_db
def test_an_alert_reaches_holders_and_the_community_only(session: Session) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    arjun, mia, rosa = (persona(session, world.id, key) for key in ("arjun", "mia", "rosa"))
    hold(session, world.id, arjun, asset)
    hold(session, world.id, mia, asset, shares=0)  # sold out: not a holder

    alert = grade_drop(session, world, asset)

    assert recipients(session, alert) == {arjun.id, rosa.id}
    treasury = session.get_one(User, asset.community_user_id)
    assert treasury.kind is UserKind.TREASURY and treasury.id not in recipients(session, alert)
    stream = events.replay(session, world.id, viewer=events.Viewer(arjun.id))
    assert [e.payload["alert_id"] for e in stream if e.type is StreamEventType.ALERT] == [
        str(alert.id)
    ]
    outsider = events.replay(session, world.id, viewer=events.Viewer(mia.id))
    assert all(e.type is not StreamEventType.ALERT for e in outsider)


@requires_db
def test_an_alert_is_raised_once_per_cause(session: Session) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    draft = news_alert(asset.id, asset.name, item(5))
    assert draft is not None

    first = alerts.raise_alert(session, world.id, asset, draft)
    again = alerts.raise_alert(session, world.id, asset, draft)

    assert first is not None and again is None
    assert len(session.exec(select(Alert).where(Alert.world_id == world.id)).all()) == 1
    rosa = persona(session, world.id, "rosa")
    stream = events.replay(session, world.id, viewer=events.Viewer(rosa.id))
    assert len([e for e in stream if e.type is StreamEventType.ALERT]) == 1


@requires_db
def test_the_same_cause_in_another_world_is_another_alert(session: Session) -> None:
    worlds = [create_world(session), create_world(session)]
    for world in worlds:
        asset = first_asset(session, world.id)
        draft = news_alert(ASSET, asset.name, item(5))
        assert draft is not None
        assert alerts.raise_alert(session, world.id, asset, draft) is not None


# --- read/unread API ----------------------------------------------------------------------------


@requires_db
def test_my_alerts_list_newest_first_with_the_unread_count(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    hold(session, world.id, persona(session, world.id, "arjun"), asset)
    rerate = grade_drop(session, world, asset)
    news = alerts.raise_alert(session, world.id, asset, news_alert(asset.id, asset.name, item(4)))  # type: ignore[arg-type]
    assert news is not None
    session.commit()
    start_demo(client, session, world, persona_key="arjun")

    body = client.get("/alerts").json()

    assert body["unread_count"] == 2
    assert {a["id"] for a in body["alerts"]} == {str(rerate.id), str(news.id)}
    by_kind = {a["kind"]: a for a in body["alerts"]}
    assert by_kind["grade_change"]["title"] == f"{asset.name} downgraded to BBB"
    assert by_kind["grade_change"]["asset_name"] == asset.name
    assert by_kind["news"]["url"] == "https://news.example.org/fire"
    assert all(a["read_at"] is None for a in body["alerts"])


@requires_db
def test_reading_one_then_all(session: Session, client: TestClient) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    hold(session, world.id, persona(session, world.id, "arjun"), asset)
    one = grade_drop(session, world, asset)
    other = alerts.raise_alert(session, world.id, asset, news_alert(asset.id, asset.name, item(4)))  # type: ignore[arg-type]
    assert other is not None
    session.commit()
    start_demo(client, session, world, persona_key="arjun")

    read = client.post(f"/alerts/{one.id}/read")
    assert read.status_code == 200 and read.json()["read_at"] is not None
    first_read = read.json()["read_at"]
    assert client.post(f"/alerts/{one.id}/read").json()["read_at"] == first_read  # idempotent
    assert client.get("/alerts").json()["unread_count"] == 1
    unread = client.get("/alerts", params={"unread_only": True}).json()["alerts"]
    assert [a["id"] for a in unread] == [str(other.id)]

    assert client.post("/alerts/read-all").json() == {"marked": 1}
    assert client.get("/alerts").json()["unread_count"] == 0
    assert client.post("/alerts/read-all").json() == {"marked": 0}


@requires_db
def test_someone_elses_alert_is_not_found_and_not_listed(
    session: Session, client: TestClient
) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    alert = grade_drop(session, world, asset)  # rosa (owner) only: nobody holds it
    start_demo(client, session, world, persona_key="mia")

    assert client.get("/alerts").json() == {"alerts": [], "unread_count": 0, "next_before": None}
    res = client.post(f"/alerts/{alert.id}/read")
    assert (res.status_code, res.json()["detail"]) == (404, "not_found")
    assert client.post(f"/alerts/{uuid4()}/read").status_code == 404


@requires_db
def test_another_worlds_alert_is_not_found(session: Session, client: TestClient) -> None:
    theirs = create_world(session)
    alert = grade_drop(session, theirs, first_asset(session, theirs.id))
    mine = create_world(session)
    start_demo(client, session, mine, persona_key="rosa")

    assert client.get("/alerts").json()["alerts"] == []
    res = client.post(f"/alerts/{alert.id}/read")
    assert (res.status_code, res.json()["detail"]) == (404, "not_found")
    assert session.get_one(AlertRecipient, (alert.id, persona(session, theirs.id, "rosa").id))


@requires_db
def test_alerts_need_a_session(client: TestClient) -> None:
    assert client.get("/alerts").status_code == 401
    assert client.post("/alerts/read-all").status_code == 401


# --- stream and list agree (recipients fixed at delivery) ---------------------------------------


@requires_db
def test_the_stream_and_the_list_show_the_same_alerts(session: Session, client: TestClient) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    arjun, mia = persona(session, world.id, "arjun"), persona(session, world.id, "mia")
    hold(session, world.id, arjun, asset)
    alert = grade_drop(session, world, asset)
    hold(session, world.id, mia, asset)  # bought after the alert: not a recipient
    session.commit()

    for user, expected in ((arjun, [str(alert.id)]), (mia, [])):
        stream = events.replay(session, world.id, viewer=events.Viewer(user.id))
        streamed = [e.payload["alert_id"] for e in stream if e.type is StreamEventType.ALERT]
        start_demo(client, session, world, persona_key=user.persona_key or "")
        listed = [a["id"] for a in client.get("/alerts").json()["alerts"]]
        assert streamed == listed == expected


# --- community filter and pagination ------------------------------------------------------------


def news_alerts(session: Session, world: World, asset: Asset, n: int) -> list[Alert]:
    raised = []
    for i in range(n):
        draft = news_alert(asset.id, asset.name, item(4, id=f"evt-{i}"))
        assert draft is not None
        alert = alerts.raise_alert(session, world.id, asset, draft)
        assert alert is not None
        raised.append(alert)
    session.commit()
    return raised


@requires_db
def test_alerts_come_a_page_at_a_time(session: Session, client: TestClient) -> None:
    world = create_world(session)
    asset = first_asset(session, world.id)
    raised = news_alerts(session, world, asset, 3)
    start_demo(client, session, world, persona_key="rosa")

    first = client.get("/alerts", params={"limit": 2}).json()
    second = client.get("/alerts", params={"limit": 2, "before": first["next_before"]}).json()

    ids = [a["id"] for a in first["alerts"] + second["alerts"]]
    assert sorted(ids) == sorted(str(a.id) for a in raised) and len(set(ids)) == 3
    assert first["next_before"] == first["alerts"][-1]["id"] and second["next_before"] is None
    assert first["unread_count"] == second["unread_count"] == 3
    unknown = client.get("/alerts", params={"before": str(uuid4())})
    assert (unknown.status_code, unknown.json()["detail"]) == (404, "not_found")


@requires_db
def test_a_member_filters_alerts_by_community(session: Session, client: TestClient) -> None:
    world = create_world(session)
    assets = session.exec(
        select(Asset).where(Asset.world_id == world.id).order_by(Asset.site_key)
    ).all()
    mine, other = assets[0], assets[1]
    assert mine.community_id != other.community_id
    arjun = persona(session, world.id, "arjun")
    hold(session, world.id, arjun, mine)
    hold(session, world.id, arjun, other)
    about_mine = news_alerts(session, world, mine, 1)[0]
    news_alerts(session, world, other, 1)
    start_demo(client, session, world, persona_key="rosa")  # owner of every seeded community
    params = {"community_id": str(mine.community_id)}

    body = client.get("/alerts", params=params).json()
    assert [a["id"] for a in body["alerts"]] == [str(about_mine.id)]
    assert body["unread_count"] == 1
    assert client.get("/alerts").json()["unread_count"] == 2
    assert client.post("/alerts/read-all", params=params).json() == {"marked": 1}
    assert client.get("/alerts").json()["unread_count"] == 1

    start_demo(client, session, world, persona_key="arjun")  # a holder, not a member
    for res in (
        client.get("/alerts", params=params),
        client.post("/alerts/read-all", params=params),
    ):
        assert (res.status_code, res.json()["detail"]) == (404, "not_found")
    assert client.get("/alerts").json()["unread_count"] == 2

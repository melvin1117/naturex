"""T38 Time Machine: quarters, event presets, price re-anchoring.

Pure tests cover the scenario effects and the re-anchor formula. DB tests run the real
`RatingRunner` in mock mode (fixed pipeline, no model) inline on one rolled-back connection, as
T75's job tests do.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import date
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine
from sqlmodel import Session, col, func, select

from app.config import Settings, get_settings
from app.db import get_session
from app.main import app
from app.market.anchoring import FORMULA
from app.market.engine import (
    ALPHA_RERATE,
    MAX_NOISE,
    MIN_PRICE,
    PriceReason,
    anchor_price,
    seeded_shock,
)
from app.models import (
    Alert,
    AlertRecipient,
    Asset,
    AssetStatus,
    Event,
    Holding,
    LedgerEntry,
    LedgerKind,
    Metrics,
    PayoutLine,
    Price,
    Report,
    User,
    World,
    WorldEvent,
)
from app.routers.admin import get_time_machine_env
from app.sandbox import create_world, reset_world
from app.seed import seed
from app.services import time_machine as tm
from app.services.rating import rate_site
from app.services.rating_runs import InlineExecutor, RatingRunner, RunRateLimited, news_runner
from app.tools.earth_obs import (
    EarthObsMetrics,
    is_mock_metrics,
    load_site_metrics,
    mock_listing_metrics,
)
from app.tools.scenarios import (
    EVENT_PRESETS,
    PRESET_NAMES,
    ScenarioDeltas,
    advance,
    fit_deltas,
    load_scenario_spec,
    preset_deltas,
    preset_version,
    timeline_version,
)
from app.worlds import WORLD_ID as TEMPLATE_WORLD_ID
from tests.conftest import alembic_cfg, requires_db
from tests.test_llm import settings
from tests.worlds import mock_time_machine_env, start_demo

SPEC = load_scenario_spec()
SITES = sorted(SPEC.sites)
AS_OF = date(2026, 10, 1)
NO_SPEND: Callable[[], Decimal] = lambda: Decimal(0)  # noqa: E731


def _rating(metrics: EarthObsMetrics, site: str) -> tuple[Decimal, str]:
    wetland = site == "wetland_mx"
    rated = rate_site(metrics, is_wetland=wetland, as_of=AS_OF, total_shares=1_000_000)
    return rated.score.health, rated.score.grade.value


# --- scenario effects (pure) --------------------------------------------------------------------


@pytest.mark.parametrize("site", SITES)
def test_a_quarter_on_a_committed_version_gives_the_committed_next_version(site: str) -> None:
    baseline = load_site_metrics(site)
    restoration = advance(baseline, SPEC.sites[site]["restoration"], timeline_version(SPEC, 1))
    encroachment = advance(restoration, SPEC.sites[site]["encroachment"], timeline_version(SPEC, 2))

    assert restoration == load_site_metrics(site, "restoration")
    assert encroachment == load_site_metrics(site, "encroachment")


def test_fit_deltas_returns_the_same_deltas_when_every_transfer_fits() -> None:
    deltas = SPEC.sites["wetland_mx"]["encroachment"]

    assert fit_deltas(deltas, load_site_metrics("wetland_mx").landcover) is deltas


def test_fit_deltas_caps_a_transfer_at_what_its_sources_hold_and_drops_empty_ones() -> None:
    deltas = ScenarioDeltas.model_validate(
        {
            "description": "test",
            "landcover_transfers": [
                {"from": ["water"], "to": "bare", "pp": 10},
                {"from": ["snow_and_ice"], "to": "bare", "pp": 1},
            ],
        }
    )
    landcover = {"water": 0.04, "trees": 0.96}

    fitted = fit_deltas(deltas, landcover)

    assert [(t.from_classes, t.pp) for t in fitted.landcover_transfers] == [(("water",), 4.0)]


@pytest.mark.parametrize("preset", PRESET_NAMES)
@pytest.mark.parametrize("site", [*SITES, "mock"])
def test_every_preset_gives_valid_labelled_metrics_that_move_health_its_way(
    preset: Any, site: str
) -> None:
    if site == "mock":
        current = mock_listing_metrics(area_ha=120.0, centroid_lat=19.3, centroid_lon=-99.1)
    else:
        current = load_site_metrics(site)
    version = preset_version(preset, 0, "2026Q3")

    after = advance(current, preset_deltas(preset, current.site_key, SPEC), version)

    assert after.simulated and after.scenario == preset
    assert after.data_version == f"sim-0-{preset}" and after.period == "2026Q3"
    assert after.based_on == current.data_version
    assert sum(after.landcover.values()) == pytest.approx(1.0)
    assert min(after.landcover.values()) >= 0
    assert (after.area_ha, after.centroid) == (current.area_ha, current.centroid)
    before_health, _ = _rating(current, site)
    after_health, _ = _rating(after, site)
    if EVENT_PRESETS[preset].direction < 0:
        assert after_health < before_health
    else:
        assert after_health >= before_health


def test_injected_encroachment_takes_the_hero_wetland_from_a_to_bbb() -> None:
    baseline = load_site_metrics("wetland_mx")
    version = preset_version("encroachment", 0, "2026Q3")

    after = advance(baseline, preset_deltas("encroachment", "wetland_mx", SPEC), version)

    assert _rating(baseline, "wetland_mx")[1] == "A"
    assert _rating(after, "wetland_mx")[1] == "BBB"


def test_curated_sites_use_their_own_story_and_others_the_generic_effect() -> None:
    assert (
        preset_deltas("encroachment", "wetland_mx", SPEC)
        is SPEC.sites["wetland_mx"]["encroachment"]
    )
    assert preset_deltas("encroachment", None, SPEC) is EVENT_PRESETS["encroachment"].deltas
    assert preset_deltas("fire", "wetland_mx", SPEC) is EVENT_PRESETS["fire"].deltas


def test_presets_stack_on_the_current_state() -> None:
    baseline = load_site_metrics("restoration_forest")
    once = advance(baseline, EVENT_PRESETS["fire"].deltas, preset_version("fire", 0, "2026Q3"))
    twice = advance(once, EVENT_PRESETS["fire"].deltas, preset_version("fire", 0, "2026Q3"))

    assert twice.landcover["bare"] > once.landcover["bare"] > baseline.landcover["bare"]
    assert twice.observed_data_version == baseline.data_version


def test_a_simulated_version_of_mock_data_is_still_mock_data() -> None:
    mock = mock_listing_metrics(area_ha=50.0, centroid_lat=10.0, centroid_lon=-84.0)
    fire = advance(mock, EVENT_PRESETS["fire"].deltas, preset_version("fire", 1, "2026Q4"))

    assert is_mock_metrics(fire)
    assert not is_mock_metrics(load_site_metrics("wetland_mx", "restoration"))


def test_simulated_labels_never_look_like_a_real_quarter() -> None:
    version = timeline_version(SPEC, 1)

    assert tm.claim_period(version) == "tm-sim-1"
    assert tm.payout_label(version) == "2026Q4-sim-1"


# --- re-anchoring (pure) ------------------------------------------------------------------------


def test_the_rerate_shock_is_deterministic_and_bounded() -> None:
    shocks = [seeded_shock(f"report-{n}") for n in range(500)]

    assert seeded_shock("report-1") == shocks[1]
    assert all(-MAX_NOISE <= shock <= MAX_NOISE for shock in shocks)
    assert len(set(shocks)) > 400  # a real spread, not a constant


@pytest.mark.parametrize(
    ("price", "fair_value"),
    [("10", "20"), ("20", "10"), ("21.4723", "16.1653"), ("0.0001", "0"), ("285.15", "300")],
)
def test_a_rerate_moves_the_price_35_percent_of_the_way_within_the_noise(
    price: str, fair_value: str
) -> None:
    old, target = Decimal(price), Decimal(fair_value)
    for key in ("a", "b", "c"):
        shock = seeded_shock(key)
        change = anchor_price(old, target, PriceReason.RERATE, shock)
        anchored = old + ALPHA_RERATE * (target - old)

        assert change.reason is PriceReason.RERATE
        assert change.price >= MIN_PRICE
        assert abs(change.price - anchored * (1 + shock)) <= Decimal("0.00005") or (
            change.price == MIN_PRICE
        )


def test_anchor_price_clamps_the_shock() -> None:
    assert anchor_price(Decimal(10), Decimal(10), PriceReason.RERATE, Decimal(1)).price == Decimal(
        "10.0900"
    )


# --- DB fixtures --------------------------------------------------------------------------------


def sessions(conn: Connection) -> Callable[[], Session]:
    return lambda: Session(bind=conn, join_transaction_mode="create_savepoint")


@pytest.fixture
def db() -> Iterator[Connection]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        with sessions(conn)() as setup:
            seed(setup)
        yield conn
        outer.rollback()
    engine.dispose()


@pytest.fixture
def world_id(db: Connection) -> UUID:
    with sessions(db)() as session:
        return create_world(session).id


def runner(conn: Connection, **cfg_: Any) -> RatingRunner:
    cfg = settings(use_mocks=True, **cfg_)
    return RatingRunner(
        session_factory=sessions(conn),
        settings=cfg,
        executor=InlineExecutor(),
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: date(2026, 10, 7),
    )


def quarter(
    db: Connection, world_id: UUID, period: str, run: Any = None, **overrides: Any
) -> tm.QuarterOutcome:
    kwargs: dict[str, Any] = {
        "world_id": world_id,
        "period": period,
        "spend": NO_SPEND,
        "llm_budget_usd": Decimal(20),
        "job_cap_usd": Decimal(2),
        "runs_per_hour": 6,
        **overrides,
    }
    return tm.next_quarter(sessions(db), run or runner(db), **kwargs)


def inject(
    db: Connection, world_id: UUID, asset_id: UUID, preset: Any, run: Any = None, **kw: Any
) -> tm.EventOutcome:
    kwargs: dict[str, Any] = {"spend": NO_SPEND, "llm_budget_usd": Decimal(20), **kw}
    return tm.inject_event(
        sessions(db),
        run or runner(db),
        world_id=world_id,
        asset_id=asset_id,
        preset_name=preset,
        **kwargs,
    )


def count(db: Connection, model: Any, world_id: UUID, *where: Any) -> int:
    with sessions(db)() as session:
        return session.exec(
            select(func.count()).select_from(model).where(model.world_id == world_id, *where)
        ).one()


def site(db: Connection, world_id: UUID, key: str) -> Asset:
    with sessions(db)() as session:
        return session.exec(
            select(Asset).where(Asset.world_id == world_id, Asset.site_key == key)
        ).one()


def persona(db: Connection, world_id: UUID, key: str) -> UUID:
    with sessions(db)() as session:
        return session.exec(
            select(User.id).where(User.world_id == world_id, User.persona_key == key)
        ).one()


def give(db: Connection, world_id: UUID, user_id: UUID, asset_id: UUID, shares: int) -> None:
    with sessions(db)() as session:
        session.add(Holding(world_id=world_id, user_id=user_id, asset_id=asset_id, shares=shares))
        session.commit()


def recipients(db: Connection, alert_id: UUID) -> set[UUID]:
    with sessions(db)() as session:
        return set(
            session.exec(
                select(AlertRecipient.user_id).where(AlertRecipient.alert_id == alert_id)
            ).all()
        )


def step_of(db: Connection, world_id: UUID) -> int:
    with sessions(db)() as session:
        return session.exec(select(World.time_machine_step).where(World.id == world_id)).one()


# --- next quarter -------------------------------------------------------------------------------


@requires_db
def test_next_quarter_rerates_reanchors_alerts_and_pays_once(
    db: Connection, world_id: UUID
) -> None:
    wetland = site(db, world_id, "wetland_mx")
    arjun, rosa = persona(db, world_id, "arjun"), persona(db, world_id, "rosa")
    give(db, world_id, arjun, wetland.id, 5)
    reports, prices = count(db, Report, world_id), count(db, Price, world_id)

    outcome = quarter(db, world_id, "2026Q4")

    assert (outcome.step, outcome.replayed, outcome.stopped) == (1, False, None)
    assert outcome.version.data_version == "sim-1" and step_of(db, world_id) == 1
    assert [a.status for a in outcome.assets] == ["rerated"] * len(outcome.assets) != []
    assert count(db, Report, world_id) == reports + len(outcome.assets)
    hero = next(a for a in outcome.assets if a.asset_id == wetland.id)
    assert hero.before is not None and hero.after is not None
    assert (hero.before.grade, hero.after.grade) == ("A", "AA")
    assert hero.after.data_version == "sim-1" and hero.after.simulated
    assert hero.run_id is not None and hero.payout == "paid"
    # Price re-anchored toward the new fair value, from the report's deterministic shock.
    assert hero.before.price is not None and hero.after.price is not None
    assert hero.after.fair_value_per_share is not None
    expected = anchor_price(
        hero.before.price,
        hero.after.fair_value_per_share,
        PriceReason.RERATE,
        seeded_shock(str(hero.after.report_id)),
    )
    assert hero.after.price == expected.price > hero.before.price
    assert count(db, Price, world_id) == prices + len(outcome.assets)
    with sessions(db)() as session:
        anchor = session.exec(
            select(LedgerEntry)
            .where(
                LedgerEntry.world_id == world_id,
                LedgerEntry.asset_id == wetland.id,
                LedgerEntry.kind == LedgerKind.PRICE_ANCHOR,
            )
            .order_by(col(LedgerEntry.seq).desc())
        ).first()
        assert anchor is not None and anchor.ref_id == hero.after.report_id
        assert anchor.payload["reason"] == "rerate" and anchor.payload["formula"] == FORMULA
        assert Decimal(anchor.payload["price"]) == hero.after.price
        ticks = session.exec(
            select(WorldEvent).where(
                WorldEvent.world_id == world_id, WorldEvent.type == "price_tick"
            )
        ).all()
        assert any(
            t.payload
            == {"asset_id": str(wetland.id), "price": str(expected.price), "reason": "rerate"}
            for t in ticks
        )
    # The grade change alerted the holder and the owner.
    assert len(hero.alert_ids) == 1
    assert recipients(db, hero.alert_ids[0]) == {arjun, rosa}
    # One payout per asset, labelled as a simulated quarter.
    with sessions(db)() as session:
        labels = session.exec(
            select(PayoutLine.quarter_label).where(PayoutLine.world_id == world_id)
        ).all()
    assert set(labels) == {"2026Q4-sim-1"}
    payouts = count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT)
    assert payouts == outcome.payouts == len(outcome.assets)
    alerts = count(db, Alert, world_id)

    replay = quarter(db, world_id, "2026Q4")

    assert (replay.step, replay.replayed) == (1, True)
    assert {a.status for a in replay.assets} == {"already_done"}
    assert {a.payout for a in replay.assets} == {"already_paid"}
    assert next(a for a in replay.assets if a.asset_id == wetland.id).run_id == hero.run_id
    assert count(db, Report, world_id) == reports + len(outcome.assets)
    assert count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT) == payouts
    assert count(db, Alert, world_id) == alerts
    assert step_of(db, world_id) == 1


@requires_db
def test_the_timeline_moves_one_quarter_at_a_time_and_ends(db: Connection, world_id: UUID) -> None:
    with pytest.raises(tm.TimeMachineRefused, match="quarter_mismatch"):
        quarter(db, world_id, "2027Q1")  # skips a quarter
    with pytest.raises(tm.TimeMachineRefused, match="quarter_mismatch"):
        quarter(db, world_id, "2026Q3")  # the observed baseline isn't a simulated quarter
    quarter(db, world_id, "2026Q4")

    second = quarter(db, world_id, "2027Q1")

    assert (second.step, second.version.scenario) == (2, "encroachment")
    wetland = next(a for a in second.assets if a.name.startswith("Xochimilco"))
    assert wetland.after is not None and wetland.after.data_version == "sim-2"
    assert wetland.after.grade == "BBB" and len(wetland.alert_ids) == 1
    with pytest.raises(tm.TimeMachineRefused, match="timeline_end"):
        quarter(db, world_id, "2027Q2")
    with pytest.raises(tm.TimeMachineRefused, match="quarter_mismatch"):
        quarter(db, world_id, "2026Q4")  # can't go back
    assert step_of(db, world_id) == 2


@requires_db
def test_a_quarter_carries_an_injected_event_forward(db: Connection, world_id: UUID) -> None:
    forest = site(db, world_id, "restoration_forest")
    inject(db, world_id, forest.id, "fire")

    outcome = quarter(db, world_id, "2026Q4")

    with sessions(db)() as session:
        current = tm.current_metrics(session, world_id, session.get_one(Asset, forest.id))
    assert current is not None and current.scenario == "restoration"
    assert current.based_on == "sim-0-fire"
    assert current != load_site_metrics("restoration_forest", "restoration")
    assert next(a for a in outcome.assets if a.asset_id == forest.id).status == "rerated"


@requires_db
def test_assets_without_time_machine_versions_are_skipped_but_paid(
    db: Connection, world_id: UUID
) -> None:
    wetland = site(db, world_id, "wetland_mx")
    with sessions(db)() as session:
        row = session.get_one(Asset, wetland.id)
        row.site_key = None  # a new polygon (T60): no scripted versions
        session.add(row)
        session.commit()

    outcome = quarter(db, world_id, "2026Q4")

    result = next(a for a in outcome.assets if a.asset_id == wetland.id)
    assert (result.status, result.detail, result.payout) == ("skipped", tm.NO_VERSION, "paid")
    assert result.run_id is None and result.before == result.after


@requires_db
def test_the_quarter_stops_at_the_budget_and_a_replay_finishes_it(
    db: Connection, world_id: UUID
) -> None:
    reports = count(db, Report, world_id)

    stopped = quarter(db, world_id, "2026Q4", spend=lambda: Decimal("19.60"))

    assert stopped.stopped == "llm_budget_exhausted"
    assert {(a.status, a.detail) for a in stopped.assets} == {("stopped", "llm_budget_exhausted")}
    assert {a.payout for a in stopped.assets} == {None}
    assert count(db, Report, world_id) == reports
    assert count(db, LedgerEntry, world_id, LedgerEntry.kind == LedgerKind.PAYOUT) == 0

    finished = quarter(db, world_id, "2026Q4")

    assert finished.replayed and {a.status for a in finished.assets} == {"rerated"}
    assert finished.payouts == len(finished.assets)


@requires_db
def test_a_rate_limit_stops_the_quarter(db: Connection, world_id: UUID) -> None:
    class Limited:
        def start(self, *_: Any, **__: Any) -> UUID:
            raise RunRateLimited(60, "rating_global_limit")

    outcome = quarter(db, world_id, "2026Q4", run=Limited())

    assert outcome.stopped == "rating_global_limit"
    assert outcome.assets[0].status == "failed"
    assert {a.status for a in outcome.assets[1:]} == {"stopped"}


@requires_db
def test_the_template_world_never_runs_the_time_machine(db: Connection) -> None:
    with pytest.raises(tm.TimeMachineRefused, match="template_world"):
        quarter(db, TEMPLATE_WORLD_ID, "2026Q4")
    with sessions(db)() as session:
        asset = session.exec(select(Asset.id).where(Asset.world_id == TEMPLATE_WORLD_ID)).first()
    assert asset is not None
    with pytest.raises(tm.TimeMachineRefused, match="template_world"):
        inject(db, TEMPLATE_WORLD_ID, asset, "fire")


@requires_db
def test_a_quarter_stays_in_its_world(db: Connection, world_id: UUID) -> None:
    with sessions(db)() as session:
        other = create_world(session).id
    before = (count(db, Report, other), count(db, Price, other), step_of(db, other))

    quarter(db, world_id, "2026Q4")

    assert (count(db, Report, other), count(db, Price, other), step_of(db, other)) == before


@requires_db
def test_a_reset_rewinds_the_time_machine(db: Connection, world_id: UUID) -> None:
    quarter(db, world_id, "2026Q4")
    assert step_of(db, world_id) == 1

    with sessions(db)() as session:
        reset_world(session, world_id)

    assert step_of(db, world_id) == 0
    assert quarter(db, world_id, "2026Q4").replayed is False  # claims went with the assets


# --- event presets ------------------------------------------------------------------------------


@requires_db
def test_injected_encroachment_downgrades_a_to_bbb_alerts_and_drops_the_price(
    db: Connection, world_id: UUID
) -> None:
    wetland = site(db, world_id, "wetland_mx")
    arjun, rosa = persona(db, world_id, "arjun"), persona(db, world_id, "rosa")
    give(db, world_id, arjun, wetland.id, 5)

    outcome = inject(db, world_id, wetland.id, "encroachment")

    assert outcome.before is not None and outcome.after is not None
    assert (outcome.before.grade, outcome.after.grade) == ("A", "BBB")
    assert outcome.after.data_version == "sim-0-encroachment"
    assert outcome.before.price is not None and outcome.after.price is not None
    assert outcome.after.price < outcome.before.price
    event = outcome.event
    assert (event.source, event.impact_type, event.direction, event.severity) == (
        "admin",
        "encroachment",
        -1,
        4,
    )
    assert event.title == f"Encroachment at {wetland.name} (simulated)"
    # The re-rate's grade alert and the event's own alert, both to the holder and the owner.
    assert len(outcome.alert_ids) == 2
    with sessions(db)() as session:
        kinds = set(
            session.exec(select(Alert.kind).where(col(Alert.id).in_(outcome.alert_ids))).all()
        )
        ledger = session.exec(
            select(LedgerEntry).where(
                LedgerEntry.world_id == world_id,
                LedgerEntry.asset_id == wetland.id,
                LedgerEntry.kind == LedgerKind.EVENT,
            )
        ).one()
    assert kinds == {"grade_change", "news"}
    assert all(recipients(db, alert) == {arjun, rosa} for alert in outcome.alert_ids)
    assert ledger.ref_id == event.id and ledger.payload["preset"] == "encroachment"
    assert ledger.payload["simulated"] is True
    assert step_of(db, world_id) == 0  # an event doesn't move the world


@requires_db
def test_a_positive_preset_raises_no_event_alert(db: Connection, world_id: UUID) -> None:
    mangrove = site(db, world_id, "mangrove_mx")

    outcome = inject(db, world_id, mangrove.id, "protection")

    assert outcome.event.severity == 2 and outcome.event.direction == 1
    with sessions(db)() as session:
        kinds = session.exec(select(Alert.kind).where(col(Alert.id).in_(outcome.alert_ids))).all()
    assert "news" not in kinds


@requires_db
def test_presets_start_from_the_stored_metrics(db: Connection, world_id: UUID) -> None:
    forest = site(db, world_id, "restoration_forest")
    inject(db, world_id, forest.id, "fire")

    second = inject(db, world_id, forest.id, "fire")

    with sessions(db)() as session:
        report = session.exec(
            select(Report)
            .where(Report.world_id == world_id, Report.asset_id == forest.id)
            .order_by(col(Report.version).desc())
        ).first()
        assert report is not None and report.metrics_id is not None
        metrics = session.get_one(Metrics, report.metrics_id)
    stored = EarthObsMetrics.model_validate(metrics.provenance)
    assert stored.based_on == "sim-0-fire"  # the second fire burned the first one's state
    assert second.after is not None and second.before is not None
    assert second.after.health_score is not None and second.before.health_score is not None
    assert second.after.health_score < second.before.health_score


@requires_db
def test_presets_refuse_unlisted_assets_and_the_budget(db: Connection, world_id: UUID) -> None:
    wetland = site(db, world_id, "wetland_mx")
    events = count(db, Event, world_id)

    with pytest.raises(tm.TimeMachineRefused, match="llm_budget_exhausted"):
        inject(db, world_id, wetland.id, "fire", spend=lambda: Decimal("19.90"))
    with sessions(db)() as session:
        row = session.get_one(Asset, wetland.id)
        row.status = AssetStatus.SUSPENDED
        session.add(row)
        session.commit()
    with pytest.raises(tm.TimeMachineRefused, match="asset_not_listed"):
        inject(db, world_id, wetland.id, "fire")
    with sessions(db)() as session:
        other = create_world(session).id
    with pytest.raises(LookupError):
        inject(db, other, wetland.id, "fire")  # another world's asset

    assert count(db, Event, world_id) == events


@requires_db
def test_a_failed_preset_rerate_stores_no_event(db: Connection, world_id: UUID) -> None:
    wetland = site(db, world_id, "wetland_mx")

    class NoReport:
        def start(self, *_: Any, **__: Any) -> UUID:
            return UUID(int=1)

    with pytest.raises(tm.RerateFailed):
        inject(db, world_id, wetland.id, "fire", run=NoReport())

    assert count(db, Event, world_id, Event.source == "admin") == 0


# --- API ----------------------------------------------------------------------------------------


@pytest.fixture
def api_session() -> Iterator[Session]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        outer = conn.begin()
        session = Session(bind=conn, join_transaction_mode="create_savepoint")
        seed(session)
        yield session
        session.close()
        outer.rollback()
    engine.dispose()


@pytest.fixture
def client(api_session: Session) -> Iterator[TestClient]:
    app.dependency_overrides[get_session] = lambda: api_session
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, use_mocks=True)
    app.dependency_overrides[get_time_machine_env] = lambda: mock_time_machine_env(api_session)
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@requires_db
def test_the_api_runs_the_time_machine_for_the_demo_admin(
    client: TestClient, api_session: Session
) -> None:
    sandbox = start_demo(client, api_session, persona_key="admin")

    before = client.get("/admin/time-machine")
    assert before.status_code == 200, before.text
    state = before.json()
    assert (state["step"], state["current"]["period"], state["next"]["period"]) == (
        0,
        "2026Q3",
        "2026Q4",
    )
    assert [p["preset"] for p in state["presets"]] == list(PRESET_NAMES)
    assert {p["preset"]: p["alerts"] for p in state["presets"]}["fire"] is True
    assert [q["data_version"] for q in state["timeline"]] == [None, "sim-1", "sim-2"]

    res = client.post("/admin/simulate/quarter", json={"period": "2026Q4"})

    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["step"], body["data_version"], body["payout_label"], body["replayed"]) == (
        1,
        "sim-1",
        "2026Q4-sim-1",
        False,
    )
    assert body["assets_rerated"] == len(body["assets"]) == body["payouts"] > 0
    hero = next(a for a in body["assets"] if a["name"].startswith("Xochimilco"))
    assert (hero["before"]["grade"], hero["after"]["grade"]) == ("A", "AA")
    assert hero["after"]["simulated"] is True and hero["run_id"]
    assert Decimal(hero["after"]["price"]) != Decimal(hero["before"]["price"])
    assert client.get("/admin/time-machine").json()["step"] == 1

    replay = client.post("/admin/simulate/quarter", json={"period": "2026Q4"}).json()
    assert replay["replayed"] is True and replay["assets_rerated"] == 0
    assert {a["status"] for a in replay["assets"]} == {"already_done"}

    skip = client.post("/admin/simulate/quarter", json={"period": "2027Q2"})
    assert (skip.status_code, skip.json()["detail"]) == (409, "quarter_mismatch")

    asset = api_session.exec(
        select(Asset).where(Asset.world_id == sandbox.id, Asset.site_key == "wetland_mx")
    ).one()
    event = client.post(
        "/admin/simulate/event", json={"asset_id": str(asset.id), "preset": "encroachment"}
    )
    assert event.status_code == 200, event.text
    out = event.json()
    assert out["event"]["source"] == "admin" and out["event"]["impact_type"] == "encroachment"
    assert (out["data_version"], out["period"]) == ("sim-1-encroachment", "2026Q4")
    assert out["alert_created"] is True and out["after"]["grade"] != out["before"]["grade"]


@requires_db
def test_only_admins_use_the_time_machine(client: TestClient, api_session: Session) -> None:
    start_demo(client, api_session)  # the demo investor

    for res in (
        client.get("/admin/time-machine"),
        client.post("/admin/simulate/quarter", json={"period": "2026Q4"}),
    ):
        assert (res.status_code, res.json()["detail"]) == (403, "admin_only")
    anonymous = TestClient(app)
    assert anonymous.get("/admin/time-machine").status_code == 401


@requires_db
def test_next_quarter_is_off_without_local_jobs(client: TestClient, api_session: Session) -> None:
    start_demo(client, api_session, persona_key="admin")
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, use_mocks=True, local_jobs=False
    )

    res = client.post("/admin/simulate/quarter", json={"period": "2026Q4"})

    assert (res.status_code, res.json()["detail"]) == (409, "local_jobs_disabled")
    assert client.get("/admin/time-machine").json()["local_jobs"] is False

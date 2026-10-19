"""Rating runs and the Orchestrator (T27): async runs, tool protocol, fallback, caps, status.

Every model reply comes from a scripted fake transport and News Scout is a fixture, so no
test touches the network. DB tests run inside one rolled-back transaction, except the
real-thread test, which commits and cleans up after itself.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from functools import partial
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import httpx
import openai
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, delete, text, update
from sqlmodel import Session, col, func, select

from app import mocks
from app.agents import orchestrator
from app.agents.auditor import ScoreInputs, audit_events_from_news
from app.agents.orchestrator import (
    EarthObsArgs,
    FallbackReason,
    Tool,
    parse_call,
    tool_specs,
)
from app.config import Settings, get_settings
from app.db import get_session
from app.events import publish
from app.ledger import verify
from app.llm import THINKING_OFF, LLMClient
from app.main import app
from app.models import Asset, AssetStatus, LedgerEntry, Report, StreamEventType, User, World
from app.models import WorldEvent as WorldEventRow
from app.routers.runs import get_rating_runner
from app.sandbox import _delete_world_rows, create_world, ensure_live_world
from app.schemas import NewsScoutOutput, RatingRunStatus
from app.seed import seed
from app.services import rating_runs
from app.services.rating import rate_site
from app.services.rating_runs import (
    GLOBAL_RUNS_LOCK_KEY,
    AssetInfo,
    RatingRunner,
    RunInProgress,
    RunnerBusy,
    RunRateLimited,
    ToolFailed,
    get_run,
    global_runs_queued,
    load_cached_metrics,
    news_runner,
)
from app.tools.earth_obs import EarthObsMetrics, ScenarioName, load_site_metrics
from tests.conftest import alembic_cfg, requires_db
from tests.test_auditor import answer, quiet_answer, raw
from tests.test_llm import SUPER, ULTRA, FakeTransport, MemoryCallLog, reply, settings
from tests.worlds import start_demo

HERO = "wetland_mx"
RATING_DATE = date(2026, 10, 7)
REQUEST = httpx.Request("POST", "https://api.tokenfactory.nebius.com/v1/chat/completions")
FIXTURE = mocks.news_scout_fixture()
EVENT = audit_events_from_news(FIXTURE)[0].citation_id
STEPS = ["queued", "started", "earth_obs", "valuation", "news", "evidence", "audit", "done"]


# ----- fakes ------------------------------------------------------------------------------------


def call(name: str, args: dict[str, Any] | None = None) -> Any:
    return SimpleNamespace(
        id=f"call_{uuid4().hex[:8]}",
        function=SimpleNamespace(name=name, arguments=json.dumps(args or {})),
    )


def turn(*calls: Any) -> Any:
    return reply(tool_calls=list(calls), prompt_tokens=900, completion_tokens=30)


def happy_script() -> list[Any]:
    return [
        turn(call("earth_obs")),
        turn(call("valuation")),
        turn(call("news_scout")),
        turn(call("auditor")),
        raw(),
    ]


class Inline(Executor):
    """Runs the job in the caller's thread (DB tests share one rolled-back connection)."""

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        future: Future[Any] = Future()
        future.set_result(fn(*args, **kwargs))
        return future


class Deferred(Executor):
    """Keeps jobs until `run_all`, so a run stays queued."""

    def __init__(self) -> None:
        self.jobs: list[Callable[[], Any]] = []

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        self.jobs.append(partial(fn, *args, **kwargs))
        return Future()

    def run_all(self) -> None:
        jobs, self.jobs = self.jobs, []
        for job in jobs:
            job()


def fixture_news(_asset: Any, _llm: Any) -> NewsScoutOutput:
    return NewsScoutOutput(events=mocks.news_scout_fixture())


@dataclass
class Harness:
    runner: RatingRunner
    transport: FakeTransport
    log: MemoryCallLog
    clients: list[LLMClient] = field(default_factory=list)


def harness(
    conn: Connection,
    *script: Any,
    executor: Executor | None = None,
    news: Callable[[Any, Any], NewsScoutOutput] = fixture_news,
    metrics_loader: Callable[[AssetInfo, ScenarioName], EarthObsMetrics] = load_cached_metrics,
    max_pending: int = 16,
    spent: str = "0",
    **overrides: Any,
) -> Harness:
    cfg = settings(**{"use_mocks": False, **overrides})
    transport = FakeTransport(*script)
    log = MemoryCallLog(spent)
    made: list[LLMClient] = []

    def llm_factory(wrap: Any) -> LLMClient:
        client = LLMClient(cfg, transport, wrap(log))
        made.append(client)
        return client

    runner = RatingRunner(
        session_factory=sessions(conn),
        settings=cfg,
        executor=executor or Inline(),
        llm_factory=llm_factory,
        news=news,
        metrics_loader=metrics_loader,
        today=lambda: RATING_DATE,
        max_pending=max_pending,
    )
    return Harness(runner, transport, log, made)


# ----- DB fixtures ------------------------------------------------------------------------------


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


@dataclass(frozen=True)
class Site:
    world_id: UUID
    asset_id: UUID
    assets: dict[str, UUID]


@pytest.fixture
def site(db: Connection) -> Site:
    with sessions(db)() as session:
        world = create_world(session)
        assets = session.exec(select(Asset).where(Asset.world_id == world.id)).all()
        by_key = {str(asset.site_key): asset.id for asset in assets}
        return Site(world.id, by_key[HERO], by_key)


def progress(conn: Connection, world_id: UUID, run_id: UUID) -> list[dict[str, Any]]:
    with sessions(conn)() as session:
        rows = session.exec(
            select(WorldEventRow)
            .where(
                WorldEventRow.world_id == world_id,
                WorldEventRow.type == StreamEventType.RATING_PROGRESS,
            )
            .order_by(col(WorldEventRow.id))
        ).all()
        return [row.payload for row in rows if row.payload.get("run_id") == str(run_id)]


def steps(events: list[dict[str, Any]]) -> list[str]:
    return [event["step"] for event in events]


def run_report(conn: Connection, world_id: UUID, run_id: UUID) -> Report:
    with sessions(conn)() as session:
        reports = session.exec(select(Report).where(Report.world_id == world_id)).all()
        return next(
            r for r in reports if (r.auditor_json or {}).get("run", {}).get("run_id") == str(run_id)
        )


def run_status(conn: Connection, world_id: UUID, run_id: UUID) -> Any:
    with sessions(conn)() as session:
        return get_run(session, world_id, run_id)


def expected_audited(asset_total_shares: int, *, adjustment: int, agreement: float | None) -> Any:
    """`rate_site` with the fixture news, then the bounded audit path, computed independently."""
    metrics = load_site_metrics(HERO)
    events = audit_events_from_news(FIXTURE)
    base = rate_site(
        metrics, is_wetland=True, as_of=RATING_DATE, total_shares=asset_total_shares, events=events
    )
    inputs = ScoreInputs.from_metrics(
        metrics,
        is_wetland=True,
        data_age_days=base.data_age_days,
        events=events,
        forest_loss_last_12m_ha=metrics.forest_loss_last_12m_ha,
    )
    score = inputs.score(
        agreement=agreement,
        auditor_adjustment=adjustment,
        adjustment_reason=answer()["adjustment_reason"] if adjustment else None,
    )
    return base.with_score(score)


# ----- the tool protocol (pure) -----------------------------------------------------------------


class _Box:
    scenario: ScenarioName = "baseline"

    def __init__(self, done: set[Tool] | None = None, evidence: bool = False) -> None:
        self.done = done or set()
        self.evidence = evidence

    def offered(self) -> tuple[Tool, ...]:
        return tuple(t for t in Tool if t is not Tool.FIELD_EVIDENCE or self.evidence)

    def is_done(self, tool: Tool) -> bool:
        return tool in self.done


def test_tools_take_no_ids_and_bind_the_scenario() -> None:
    specs = tool_specs(tuple(Tool), "encroachment")
    assert [spec["function"]["name"] for spec in specs] == [t.value for t in Tool]
    for spec in specs:
        params = spec["function"]["parameters"]
        assert params["additionalProperties"] is False
        assert not any("id" in name for name in params["properties"])
    assert specs[0]["function"]["parameters"]["properties"]["scenario"]["enum"] == ["encroachment"]


@pytest.mark.parametrize(
    ("name", "arguments", "done", "expected"),
    [
        ("earth_obs", "{}", set(), Tool.EARTH_OBS),
        ("earth_obs", '{"scenario": "baseline"}', set(), Tool.EARTH_OBS),
        ("earth_obs", '{"scenario": "restoration"}', set(), FallbackReason.INVALID_ARGUMENTS),
        ("earth_obs", '{"asset_id": "x"}', set(), FallbackReason.INVALID_ARGUMENTS),
        ("valuation", '{"world_id": "x"}', {Tool.EARTH_OBS}, FallbackReason.INVALID_ARGUMENTS),
        ("valuation", "[1]", {Tool.EARTH_OBS}, FallbackReason.INVALID_ARGUMENTS),
        ("valuation", "x" * 600, {Tool.EARTH_OBS}, FallbackReason.INVALID_ARGUMENTS),
        ("valuation", "{}", set(), FallbackReason.WRONG_ORDER),
        ("auditor", "{}", {Tool.EARTH_OBS, Tool.VALUATION}, FallbackReason.WRONG_ORDER),
        ("earth_obs", "{}", {Tool.EARTH_OBS}, FallbackReason.DUPLICATE_CALL),
        ("field_evidence", "{}", set(), FallbackReason.TOOL_UNAVAILABLE),
        ("shell", "{}", set(), FallbackReason.UNKNOWN_TOOL),
        (None, "{}", set(), FallbackReason.UNKNOWN_TOOL),
    ],
)
def test_parse_call_validates_names_arguments_and_order(
    name: object, arguments: str, done: set[Tool], expected: object
) -> None:
    assert parse_call(name, arguments, _Box(done)) == expected  # type: ignore[arg-type]


def test_auditor_needs_offered_evidence_first() -> None:
    before = {Tool.EARTH_OBS, Tool.VALUATION, Tool.NEWS_SCOUT}
    box = _Box(before, evidence=True)
    assert parse_call("auditor", "{}", box) == FallbackReason.WRONG_ORDER  # type: ignore[arg-type]
    box.done.add(Tool.FIELD_EVIDENCE)
    assert parse_call("auditor", "{}", box) is Tool.AUDITOR  # type: ignore[arg-type]
    box.done.add(Tool.AUDITOR)
    assert parse_call("auditor", "{}", box) == FallbackReason.AUDITOR_CALLED_TWICE  # type: ignore[arg-type]
    assert EarthObsArgs().scenario is None


# ----- happy path -------------------------------------------------------------------------------


@requires_db
def test_orchestrated_run_stores_a_sealed_audited_report(db: Connection, site: Site) -> None:
    h = harness(db, *happy_script())
    run_id = h.runner.start(site.world_id, site.asset_id)

    events = progress(db, site.world_id, run_id)
    assert steps(events) == STEPS
    assert [event["seq"] for event in events] == list(range(len(STEPS)))
    assert events[5]["status"] == "skipped"
    assert events[-1]["status"] == "succeeded"
    assert {e["pipeline"] for e in events[2:7] if e.get("pipeline")} == {"orchestrator"}

    # Four Super turns with thinking off, then one Ultra audit.
    models = [request["model"] for request in h.transport.requests]
    assert models == [SUPER] * 4 + [ULTRA]
    for request in h.transport.requests[:4]:
        assert request["extra_body"] == THINKING_OFF
        assert request["tools"]

    report = run_report(db, site.world_id, run_id)
    with sessions(db)() as session:
        asset = session.get_one(Asset, site.asset_id)
        expected = expected_audited(asset.total_shares, adjustment=-2, agreement=0.8)
        assert report.version == 2
        assert report.health_score == expected.score.health == Decimal("71.6")
        assert report.confidence == expected.score.confidence == Decimal("80.0")
        assert report.grade == expected.score.grade.value == "A"
        assert report.fair_value_per_share == expected.fair_value_per_share
        assert report.value_mid == Decimal(expected.valuation.value_mid)
        assert report.recommendations == answer()["recommendations"]

        stored = report.auditor_json or {}
        assert stored["auditor"]["auditor_adjustment"] == -2
        assert stored["audit"]["source"] == "ultra"
        assert stored["audit"]["greenwashing_risk"] == "low"
        assert [event["id"] for event in stored["rating"]["events"]] == [EVENT]
        run = stored["run"]
        assert run["run_id"] == str(run_id)
        assert run["pipeline"] == "orchestrator"
        assert run["degraded"] is False and run["reasons"] == []
        assert run["orchestrator"]["model_turns"] == 4

        entries = session.exec(
            select(LedgerEntry)
            .where(LedgerEntry.asset_id == site.asset_id)
            .order_by(col(LedgerEntry.seq))
        ).all()
        assert verify(entries).valid is True
        last = entries[-1]
        assert last.kind == "report" and last.ref_id == report.id
        assert last.payload["health_score"] == str(expected.score.health)
        assert last.payload["audit"]["auditor_adjustment"] == -2
        assert last.payload["event_ids"] == [EVENT]

    done = events[-1]
    assert done["report_id"] == str(report.id) and done["grade"] == "A"
    assert done["previous_grade"] == "A"

    status = run_status(db, site.world_id, run_id)
    assert status.status is RatingRunStatus.SUCCEEDED
    assert status.report_id == report.id and status.pipeline == "orchestrator"


@requires_db
def test_trace_ready_every_call_has_agent_asset_and_a_step(db: Connection, site: Site) -> None:
    h = harness(db, *happy_script())
    run_id = h.runner.start(site.world_id, site.asset_id)

    for record in h.log.records:
        assert record.agent in {"orchestrator", "auditor", "news_scout"}
        assert record.asset_id == site.asset_id
    events = {e["step"]: e for e in progress(db, site.world_id, run_id)}
    assert events["earth_obs"]["model"] == SUPER and events["earth_obs"]["tool"] == "earth_obs"
    audit = events["audit"]
    assert audit["model"] == ULTRA
    assert [c["agent"] for c in audit["llm_calls"]] == ["orchestrator", "auditor"]
    assert audit["prompt_tokens"] == 900 + 2000 and audit["completion_tokens"] == 30 + 400
    assert Decimal(audit["cost_usd"]) > 0 and audit["latency_ms"] >= 0
    logged = sum(len(e.get("llm_calls", [])) for e in events.values())
    assert logged == len(h.log.records) == 5


@requires_db
def test_news_reaches_the_orchestrator_as_counts_only(db: Connection, site: Site) -> None:
    h = harness(db, *happy_script())
    h.runner.start(site.world_id, site.asset_id)

    orchestrator_requests = [r for r in h.transport.requests if r.get("tools")]
    last = orchestrator_requests[-1]["messages"]
    news = json.loads(last[-1]["content"])
    assert news == {
        "status": "ok",
        "events": 1,
        "relevant": 1,
        "negative": 1,
        "positive": 0,
        "max_severity": 4,
        "impact_types": ["encroachment"],
        "dropped_off_site": 0,
        "locality_unverified": False,
    }
    text = json.dumps([r["messages"] for r in orchestrator_requests])
    item = FIXTURE[0]
    for untrusted in (item.title, item.summary, item.url):
        assert untrusted and untrusted not in text
    assert str(site.asset_id) not in text


# ----- misbehaviour → fixed pipeline ------------------------------------------------------------


MISBEHAVIOUR: list[tuple[str, list[Any], str]] = [
    ("unknown tool", [turn(call("delete_everything")), turn(call("drop_tables"))], "unknown_tool"),
    ("wrong order", [turn(call("auditor")), turn(call("valuation"))], "wrong_order"),
    (
        "foreign asset id and extra args",
        [
            turn(call("earth_obs", {"asset_id": str(uuid4())})),
            turn(call("earth_obs", {"scenario": "encroachment"})),
        ],
        "invalid_arguments",
    ),
    (
        "auditor twice",
        [
            turn(call("earth_obs")),
            turn(call("valuation")),
            turn(call("news_scout")),
            turn(call("auditor"), call("auditor")),
        ],
        "auditor_called_twice",
    ),
    (
        "duplicate call",
        [turn(call("earth_obs")), turn(call("earth_obs")), turn(call("earth_obs"))],
        "duplicate_call",
    ),
    ("stops early", [reply("All done."), reply("Finished.")], "stopped_early"),
]


@requires_db
@pytest.mark.parametrize(
    ("script", "reason"), [(s, r) for _, s, r in MISBEHAVIOUR], ids=[n for n, _, _ in MISBEHAVIOUR]
)
def test_misbehaviour_falls_back_to_the_fixed_pipeline(
    db: Connection, site: Site, script: list[Any], reason: str
) -> None:
    h = harness(db, *script, raw())
    run_id = h.runner.start(site.world_id, site.asset_id)

    events = progress(db, site.world_id, run_id)
    assert steps(events)[-1] == "done" and events[-1]["status"] == "degraded"
    fallback = next(e for e in events if e["step"] == "fallback")
    assert fallback["reason"] == reason
    for step in ("earth_obs", "valuation", "news", "audit"):
        assert sum(e["step"] == step for e in events) == 1, step

    report = run_report(db, site.world_id, run_id)
    run = (report.auditor_json or {})["run"]
    assert run["pipeline"] == "fixed"
    assert run["orchestrator"]["fallback_reason"] == reason
    assert f"pipeline_fixed:{reason}" in run["reasons"]
    assert "orchestrator_fallback" in [flag["type"] for flag in report.flags or []]
    # Same numbers as an orchestrated run: they never depend on who ordered the steps.
    assert report.health_score == Decimal("71.6") and report.confidence == Decimal("80.0")
    # Model-written tool names are never stored.
    assert "delete_everything" not in json.dumps(report.auditor_json)
    assert h.transport.script == []


@requires_db
def test_fixed_pipeline_resumes_where_the_model_stopped(db: Connection, site: Site) -> None:
    script = [turn(call("earth_obs")), turn(call("earth_obs")), turn(call("earth_obs")), raw()]
    h = harness(db, *script)
    run_id = h.runner.start(site.world_id, site.asset_id)

    by_step = {e["step"]: e for e in progress(db, site.world_id, run_id)}
    assert by_step["earth_obs"]["pipeline"] == "orchestrator"
    assert by_step["valuation"]["pipeline"] == "fixed"
    assert by_step["audit"]["pipeline"] == "fixed"


@requires_db
def test_eight_steps_exceeded_falls_back(
    db: Connection, site: Site, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(orchestrator, "MAX_STEPS", 2)
    h = harness(db, turn(call("earth_obs")), turn(call("valuation")), raw())
    run_id = h.runner.start(site.world_id, site.asset_id)

    run = (run_report(db, site.world_id, run_id).auditor_json or {})["run"]
    assert run["orchestrator"]["fallback_reason"] == "max_steps"
    assert run["orchestrator"]["model_turns"] == 2
    assert orchestrator.MAX_STEPS == 2
    monkeypatch.undo()
    assert orchestrator.MAX_STEPS == 8


@requires_db
def test_llm_error_falls_back_and_the_audit_still_runs(db: Connection, site: Site) -> None:
    rejected = openai.BadRequestError(
        "bad request", response=httpx.Response(400, request=REQUEST), body=None
    )
    h = harness(db, rejected, raw())
    run_id = h.runner.start(site.world_id, site.asset_id)

    report = run_report(db, site.world_id, run_id)
    stored = report.auditor_json or {}
    assert stored["run"]["orchestrator"]["fallback_reason"] == "llm_error"
    assert stored["audit"]["source"] == "ultra"
    assert report.health_score == Decimal("71.6")


@requires_db
def test_budget_exhaustion_falls_back_to_a_no_op_audit(db: Connection, site: Site) -> None:
    h = harness(db, llm_budget_usd=0.000001)
    run_id = h.runner.start(site.world_id, site.asset_id)

    assert h.transport.requests == []
    report = run_report(db, site.world_id, run_id)
    stored = report.auditor_json or {}
    assert stored["run"]["reasons"] == ["pipeline_fixed:budget_exhausted", "auditor_unavailable"]
    assert stored["audit"]["fallback"] is True
    assert stored["audit"]["greenwashing_risk"] is None
    with sessions(db)() as session:
        asset = session.get_one(Asset, site.asset_id)
    expected = expected_audited(asset.total_shares, adjustment=0, agreement=None)
    assert report.health_score == expected.score.health == Decimal("73.6")
    assert report.confidence == Decimal("71.0")
    assert "auditor_unavailable" in [flag["type"] for flag in report.flags or []]
    assert run_status(db, site.world_id, run_id).status is RatingRunStatus.DEGRADED


@requires_db
def test_use_mocks_runs_the_fixed_pipeline_without_any_llm(db: Connection, site: Site) -> None:
    cfg = settings(use_mocks=True)
    asked: list[Any] = []
    runner = RatingRunner(
        session_factory=sessions(db),
        settings=cfg,
        executor=Inline(),
        llm_factory=lambda wrap: asked.append(wrap),  # type: ignore[func-returns-value]
        news=news_runner(cfg),
        today=lambda: RATING_DATE,
    )
    run_id = runner.start(site.world_id, site.asset_id)

    assert asked == []
    events = progress(db, site.world_id, run_id)
    assert events[1]["pipeline"] == "fixed" and events[1]["reason"] == "use_mocks"
    assert steps(events) == STEPS[:2] + ["fallback"] + STEPS[2:]
    report = run_report(db, site.world_id, run_id)
    stored = report.auditor_json or {}
    assert stored["run"]["reasons"] == ["pipeline_fixed:use_mocks", "auditor_unavailable"]
    assert stored["run"]["totals"]["llm_calls"] == 0
    assert report.health_score == Decimal("73.6")


@requires_db
def test_scenario_run_for_the_time_machine(db: Connection, site: Site) -> None:
    cfg = settings(use_mocks=True)
    runner = RatingRunner(
        session_factory=sessions(db),
        settings=cfg,
        executor=Inline(),
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: RATING_DATE,
    )
    run_id = runner.start(
        site.world_id, site.asset_id, scenario="encroachment", trigger="time_machine"
    )

    report = run_report(db, site.world_id, run_id)
    stored = report.auditor_json or {}
    assert (
        stored["rating"]["metrics"]["data_version"]
        == load_site_metrics(HERO, "encroachment").data_version
    )
    assert stored["run"]["scenario"] == "encroachment"
    assert stored["run"]["trigger"] == "time_machine"
    assert "simulated" in [flag["type"] for flag in report.flags or []]
    status = run_status(db, site.world_id, run_id)
    assert status.scenario == "encroachment" and status.trigger == "time_machine"


@requires_db
def test_locality_gate_counts_reach_the_orchestrator(db: Connection, site: Site) -> None:
    def gated(_asset: Any, _llm: Any) -> NewsScoutOutput:
        return NewsScoutOutput(
            events=mocks.news_scout_fixture(), dropped_off_site=2, locality_unverified=True
        )

    h = harness(db, *happy_script(), news=gated)
    h.runner.start(site.world_id, site.asset_id)

    last = [r for r in h.transport.requests if r.get("tools")][-1]["messages"]
    news = json.loads(last[-1]["content"])
    assert (news["dropped_off_site"], news["locality_unverified"]) == (2, True)


@requires_db
def test_optional_news_failure_is_retried_once_then_flagged(db: Connection, site: Site) -> None:
    attempts: list[int] = []

    def broken(_asset: Any, _llm: Any) -> NewsScoutOutput:
        attempts.append(1)
        raise RuntimeError("tavily down")

    quiet = reply(json.dumps(quiet_answer(agreement=0.5)), prompt_tokens=2000)
    h = harness(db, *happy_script()[:-1], quiet, news=broken)
    run_id = h.runner.start(site.world_id, site.asset_id)

    assert len(attempts) == 2
    news = next(e for e in progress(db, site.world_id, run_id) if e["step"] == "news")
    assert news["status"] == "failed" and news["error"] == "news_scout_error"
    assert news["attempts"] == 2
    report = run_report(db, site.world_id, run_id)
    assert "news_unavailable" in [flag["type"] for flag in report.flags or []]
    assert "news_unavailable" in (report.auditor_json or {})["run"]["reasons"]


@requires_db
def test_required_step_failure_fails_the_run_without_a_report(db: Connection, site: Site) -> None:
    def no_metrics(_asset: AssetInfo, _scenario: ScenarioName) -> EarthObsMetrics:
        raise ToolFailed("earth_engine_timeout")

    h = harness(db, turn(call("earth_obs")), metrics_loader=no_metrics)
    run_id = h.runner.start(site.world_id, site.asset_id)

    events = progress(db, site.world_id, run_id)
    assert events[-1]["step"] == "done" and events[-1]["status"] == "failed"
    assert events[-1]["error"] == "earth_obs_failed:earth_engine_timeout"
    with sessions(db)() as session:
        versions = session.exec(
            select(Report.version).where(Report.asset_id == site.asset_id)
        ).all()
    assert list(versions) == [1]
    status = run_status(db, site.world_id, run_id)
    assert status.status is RatingRunStatus.FAILED and status.error == events[-1]["error"]


# ----- caps -------------------------------------------------------------------------------------


@requires_db
def test_one_run_per_asset_at_a_time(db: Connection, site: Site) -> None:
    deferred = Deferred()
    h = harness(db, executor=deferred, use_mocks=True)
    first = h.runner.start(site.world_id, site.asset_id)
    with pytest.raises(RunInProgress) as exc:
        h.runner.start(site.world_id, site.asset_id)
    assert exc.value.run_id == first
    other = h.runner.start(site.world_id, site.assets["mangrove_mx"])  # other assets may run

    assert run_status(db, site.world_id, first).status is RatingRunStatus.QUEUED
    deferred.run_all()
    assert run_status(db, site.world_id, first).status is RatingRunStatus.DEGRADED
    assert run_status(db, site.world_id, other).status is RatingRunStatus.DEGRADED
    h.runner.start(site.world_id, site.asset_id)  # finished, so the asset is free again


@requires_db
def test_a_stale_run_no_longer_blocks_the_asset(db: Connection, site: Site) -> None:
    stale_id = uuid4()
    with sessions(db)() as session:
        session.add(
            WorldEventRow(
                world_id=site.world_id,
                type=StreamEventType.RATING_PROGRESS,
                payload={
                    "run_id": str(stale_id),
                    "asset_id": str(site.asset_id),
                    "seq": 0,
                    "step": "queued",
                    "status": "queued",
                },
                created_at=session.exec(select(func.now())).one() - timedelta(minutes=20),
            )
        )
        session.commit()
    h = harness(db, executor=Deferred(), use_mocks=True)
    h.runner.start(site.world_id, site.asset_id)
    status = run_status(db, site.world_id, stale_id)
    assert status.status is RatingRunStatus.FAILED and status.error == "stale"


@requires_db
def test_per_world_cap_returns_retry_after(db: Connection, site: Site) -> None:
    h = harness(db, executor=Deferred(), use_mocks=True, rating_runs_per_world_per_hour=2)
    keys = sorted(site.assets)
    h.runner.start(site.world_id, site.assets[keys[0]])
    h.runner.start(site.world_id, site.assets[keys[1]])
    with pytest.raises(RunRateLimited) as exc:
        h.runner.start(site.world_id, site.assets[keys[2]])
    assert 1 <= exc.value.retry_after_s <= 3601
    # The cap is per world, and a Time Machine quarter may raise it explicitly.
    h.runner.start(site.world_id, site.assets[keys[2]], max_runs_per_hour=10)


@requires_db
def test_process_wide_backlog_cap(db: Connection, site: Site) -> None:
    h = harness(db, executor=Deferred(), use_mocks=True, max_pending=1)
    h.runner.start(site.world_id, site.asset_id)
    with pytest.raises(RunnerBusy):
        h.runner.start(site.world_id, site.assets["mangrove_mx"])


# ----- status -----------------------------------------------------------------------------------


@requires_db
def test_status_is_rebuilt_from_events_then_from_the_report(db: Connection, site: Site) -> None:
    deferred = Deferred()
    h = harness(db, executor=deferred, use_mocks=True)
    run_id = h.runner.start(site.world_id, site.asset_id)
    assert run_status(db, site.world_id, run_id).status is RatingRunStatus.QUEUED

    with sessions(db)() as session:
        publish(
            session,
            site.world_id,
            StreamEventType.RATING_PROGRESS,
            {
                "run_id": str(run_id),
                "asset_id": str(site.asset_id),
                "step": "started",
                "status": "running",
                "seq": 1,
            },
        )
        session.commit()
    assert run_status(db, site.world_id, run_id).status is RatingRunStatus.RUNNING

    deferred.run_all()
    done = run_status(db, site.world_id, run_id)
    assert done.status is RatingRunStatus.DEGRADED
    assert done.reasons == ["pipeline_fixed:use_mocks", "auditor_unavailable"]
    assert done.version == 2 and done.grade == "A"

    # Events are pruned after 24 h; the sealed report's run record still answers.
    with sessions(db)() as session:
        session.execute(delete(WorldEventRow).where(col(WorldEventRow.world_id) == site.world_id))
        session.commit()
    pruned = run_status(db, site.world_id, run_id)
    assert pruned.status is RatingRunStatus.DEGRADED and pruned.report_id == done.report_id
    assert [s.step for s in pruned.steps][:2] == ["fallback", "earth_obs"]
    assert run_status(db, site.world_id, uuid4()) is None


# ----- no leaks ---------------------------------------------------------------------------------


def _keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


@requires_db
def test_no_account_identifiers_in_ledger_report_or_events(db: Connection, site: Site) -> None:
    h = harness(db, *happy_script())
    run_id = h.runner.start(site.world_id, site.asset_id)

    report = run_report(db, site.world_id, run_id)
    with sessions(db)() as session:
        users = session.exec(select(User.id)).all()
        entry = session.exec(select(LedgerEntry).where(LedgerEntry.ref_id == report.id)).one()
    stored = [
        entry.payload,
        report.auditor_json,
        report.flags,
        *progress(db, site.world_id, run_id),
    ]
    blob = json.dumps(stored, default=str)
    assert not [user for user in users if str(user) in blob]
    forbidden = {"user_id", "community_user_id", "account_id", "email", "holder", "payout_lines"}
    assert not _keys(stored) & forbidden


# ----- API --------------------------------------------------------------------------------------


@pytest.fixture
def api(db: Connection) -> Iterator[tuple[TestClient, Deferred]]:
    """Yields the client and the deferred executor; `api_session` holds the request session."""
    session = sessions(db)()
    deferred = Deferred()
    cfg = settings(use_mocks=True)
    runner = RatingRunner(
        session_factory=sessions(db),
        settings=cfg,
        executor=deferred,
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: RATING_DATE,
    )
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, use_mocks=True)
    app.dependency_overrides[get_rating_runner] = lambda: runner
    API_SESSION[:] = [session]
    with TestClient(app) as client:
        start_demo(client, session)
        yield client, deferred
    app.dependency_overrides.clear()
    session.close()


def _hero(client: TestClient) -> str:
    world = client.get("/world").json()
    return str(next(a["id"] for a in world["assets"] if a["site_key"] == HERO))


API_SESSION: list[Session] = []


@requires_db
def test_rate_returns_202_and_the_run_completes(api: tuple[TestClient, Deferred]) -> None:
    client, deferred = api
    hero = _hero(client)

    res = client.post(f"/assets/{hero}/rate")
    assert res.status_code == 202
    run_id = res.json()["run_id"]
    assert res.json() == {"run_id": run_id, "asset_id": hero, "status": "queued"}
    assert res.headers["location"] == f"/runs/{run_id}"
    assert client.get(f"/runs/{run_id}").json()["status"] == "queued"

    again = client.post(f"/assets/{hero}/rate")
    assert again.status_code == 409 and again.json()["detail"] == "run_in_progress"
    assert again.headers["location"] == f"/runs/{run_id}"

    deferred.run_all()
    body = client.get(f"/runs/{run_id}").json()
    assert body["status"] == "degraded" and body["pipeline"] == "fixed"
    assert [s["step"] for s in body["steps"]] == STEPS[:2] + ["fallback"] + STEPS[2:]
    report = client.get(f"/reports/{body['report_id']}").json()
    assert report["run_id"] == run_id and report["version"] == 2
    assert report["greenwashing_risk"] is None  # the no-op audit didn't assess it


@requires_db
def test_rate_and_runs_are_world_scoped(api: tuple[TestClient, Deferred]) -> None:
    client, _ = api
    hero = _hero(client)
    run_id = client.post(f"/assets/{hero}/rate").json()["run_id"]

    with TestClient(app) as other:
        start_demo(other, API_SESSION[0])
        _hero(other)
        assert other.get(f"/runs/{run_id}").status_code == 404
        assert other.post(f"/assets/{hero}/rate").status_code == 404
    ensure_live_world(API_SESSION[0])
    with TestClient(app) as anonymous:
        assert anonymous.get(f"/runs/{run_id}").status_code == 404, "reads the live world"
        rate = anonymous.post(f"/assets/{hero}/rate")
        assert (rate.status_code, rate.json()["detail"]) == (401, "auth_required")
    assert client.get(f"/runs/{uuid4()}").status_code == 404


@requires_db
def test_rate_cap_and_draft_errors(api: tuple[TestClient, Deferred], db: Connection) -> None:
    client, _ = api
    world = client.get("/world").json()
    ids = [a["id"] for a in world["assets"]]
    runner: RatingRunner = app.dependency_overrides[get_rating_runner]()
    runner.settings = settings(use_mocks=True, rating_runs_per_world_per_hour=1)

    assert client.post(f"/assets/{ids[0]}/rate").status_code == 202
    limited = client.post(f"/assets/{ids[1]}/rate")
    assert limited.status_code == 429 and limited.json()["detail"] == "rating_rate_limited"
    assert int(limited.headers["retry-after"]) >= 1

    runner.settings = settings(use_mocks=True)
    with sessions(db)() as session:
        draft = session.get_one(Asset, UUID(ids[2]))
        draft.status = AssetStatus.DRAFT
        session.add(draft)
        session.commit()
    res = client.post(f"/assets/{ids[2]}/rate")
    assert res.status_code == 409 and res.json()["detail"] == "asset_is_draft"


@requires_db
def test_rate_needs_an_allowed_origin(api: tuple[TestClient, Deferred]) -> None:
    client, _ = api
    hero = _hero(client)
    res = client.post(f"/assets/{hero}/rate", headers={"Origin": "https://evil.example"})
    assert res.status_code == 403


# ----- a real background thread -----------------------------------------------------------------


@requires_db
def test_run_completes_on_a_real_worker_thread() -> None:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as setup:
        seed(setup)
        world = create_world(setup)
        world_id = world.id
        hero = setup.exec(
            select(Asset.id).where(Asset.world_id == world_id, Asset.site_key == HERO)
        ).one()
    cfg = settings(use_mocks=True)
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="test-rating-run")
    runner = RatingRunner(
        session_factory=lambda: Session(engine),
        settings=cfg,
        executor=pool,
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: RATING_DATE,
    )
    try:
        run_id = runner.start(world_id, hero)
        deadline = time.monotonic() + 30
        status = None
        while time.monotonic() < deadline:
            with Session(engine) as check:
                status = get_run(check, world_id, run_id)
            assert status is not None
            if status.status not in (RatingRunStatus.QUEUED, RatingRunStatus.RUNNING):
                break
            time.sleep(0.1)
        assert status is not None and status.status is RatingRunStatus.DEGRADED
        assert status.version == 2
        with Session(engine) as check:
            entries = check.exec(
                select(LedgerEntry)
                .where(LedgerEntry.asset_id == hero)
                .order_by(col(LedgerEntry.seq))
            ).all()
            assert verify(entries).valid is True
    finally:
        pool.shutdown(wait=True)
        with Session(engine) as cleanup:
            _delete_world_rows(cleanup, world_id, keep_world=False)
            cleanup.execute(delete(World).where(col(World.id) == world_id))
            cleanup.commit()
        engine.dispose()


# ----- review fixes: global cap, bounded lock waits, stale queued runs --------------------------


def _queued_runs_now(conn: Connection) -> int:
    with sessions(conn)() as session:
        return len(global_runs_queued(session, session.exec(select(func.now())).one()))


@requires_db
def test_global_cap_spans_worlds(db: Connection, site: Site) -> None:
    with sessions(db)() as session:
        others = [create_world(session).id for _ in range(2)]
        hero_of = {
            world_id: session.exec(
                select(Asset.id).where(Asset.world_id == world_id, Asset.site_key == HERO)
            ).one()
            for world_id in others
        }
    cap = _queued_runs_now(db) + 2
    h = harness(db, executor=Deferred(), use_mocks=True, rating_runs_global_per_hour=cap)
    h.runner.start(site.world_id, site.asset_id)
    h.runner.start(others[0], hero_of[others[0]])
    with pytest.raises(RunRateLimited) as exc:
        h.runner.start(others[1], hero_of[others[1]])  # a fresh world doesn't reset it
    assert exc.value.code == "rating_global_limit"
    assert 1 <= exc.value.retry_after_s <= 3601
    # A Time Machine override raises only the per-world cap, never the global one.
    with pytest.raises(RunRateLimited):
        h.runner.start(others[1], hero_of[others[1]], max_runs_per_hour=100)


@requires_db
def test_global_cap_is_a_distinct_429(api: tuple[TestClient, Deferred], db: Connection) -> None:
    client, _ = api
    world = client.get("/world").json()
    first, second = (a["id"] for a in world["assets"][:2])
    assert client.post(f"/assets/{first}/rate").status_code == 202
    runner: RatingRunner = app.dependency_overrides[get_rating_runner]()
    runner.settings = settings(use_mocks=True, rating_runs_global_per_hour=_queued_runs_now(db))
    res = client.post(f"/assets/{second}/rate")
    assert res.status_code == 429 and res.json()["detail"] == "rating_global_limit"
    assert int(res.headers["retry-after"]) >= 1


@requires_db
def test_route_releases_its_connection_before_starting(
    api: tuple[TestClient, Deferred],
) -> None:
    client, _ = api
    hero = _hero(client)
    session = API_SESSION[0]
    seen: list[bool] = []
    real: RatingRunner = app.dependency_overrides[get_rating_runner]()

    class Probe:
        def start(self, *args: Any, **kwargs: Any) -> UUID:
            seen.append(session.in_transaction())
            return real.start(*args, **kwargs)

    app.dependency_overrides[get_rating_runner] = lambda: Probe()
    assert client.post(f"/assets/{hero}/rate").status_code == 202
    assert seen == [False]
    assert client.post(f"/assets/{uuid4()}/rate").status_code == 404  # via _enqueue


@requires_db
def test_lock_timeout_maps_to_503(
    api: tuple[TestClient, Deferred], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = api
    hero = _hero(client)
    monkeypatch.setattr(rating_runs, "LOCK_TIMEOUT_MS", 100)
    engine = create_engine(get_settings().database_url)
    cfg = settings(use_mocks=True)
    runner = RatingRunner(
        session_factory=lambda: Session(engine),
        settings=cfg,
        executor=Deferred(),
        llm_factory=lambda wrap: None,
        news=news_runner(cfg),
        today=lambda: RATING_DATE,
    )
    app.dependency_overrides[get_rating_runner] = lambda: runner
    try:
        with engine.connect() as holder:
            holder.begin()
            holder.execute(
                text("SELECT pg_advisory_xact_lock(:key)"), {"key": GLOBAL_RUNS_LOCK_KEY}
            )
            begun = time.monotonic()
            res = client.post(f"/assets/{hero}/rate")
            assert time.monotonic() - begun < 5
            holder.rollback()
        assert res.status_code == 503 and res.json()["detail"] == "rating_busy"
        assert int(res.headers["retry-after"]) >= 1
        # The backlog slot taken for the attempt was given back.
        assert runner._slots._value == runner.max_pending  # type: ignore[attr-defined]
    finally:
        engine.dispose()


@requires_db
def test_a_run_that_went_stale_in_the_queue_never_runs(db: Connection, site: Site) -> None:
    deferred = Deferred()
    h = harness(db, executor=deferred)  # live LLM path, but no scripted reply: none may be sent
    run_id = h.runner.start(site.world_id, site.asset_id)
    payload_col: Any = WorldEventRow.payload
    with sessions(db)() as session:
        session.execute(
            update(WorldEventRow)
            .where(payload_col["run_id"].astext == str(run_id))
            .values(created_at=func.now() - timedelta(minutes=20))
        )
        session.commit()
    newer = h.runner.start(site.world_id, site.asset_id)  # the stale run no longer blocks

    deferred.jobs[0]()  # the stale run finally reaches a worker
    assert h.transport.requests == []
    events = progress(db, site.world_id, run_id)
    assert steps(events) == ["queued", "done"]
    assert events[-1]["status"] == "failed" and events[-1]["error"] == "stale"
    status = run_status(db, site.world_id, run_id)
    assert status.status is RatingRunStatus.FAILED and status.error == "stale"
    with sessions(db)() as session:
        versions = session.exec(
            select(Report.version).where(Report.asset_id == site.asset_id)
        ).all()
    assert list(versions) == [1]
    assert run_status(db, site.world_id, newer).status is RatingRunStatus.QUEUED


@requires_db
def test_api_runs_keep_off_the_llm_inside_the_reserve(db: Connection, site: Site) -> None:
    h = harness(db, llm_budget_usd=6.0, llm_reserve_usd=5.0, spent="2")
    run_id = h.runner.start(site.world_id, site.asset_id)
    assert h.transport.requests == []
    run = (run_report(db, site.world_id, run_id).auditor_json or {})["run"]
    assert run["orchestrator"]["fallback_reason"] == "budget_reserve"

    # Time Machine runs may still use the reserve.
    tm = harness(db, *happy_script(), llm_budget_usd=6.0, llm_reserve_usd=5.0, spent="2")
    tm_run = tm.runner.start(site.world_id, site.asset_id, trigger="time_machine")
    assert [r["model"] for r in tm.transport.requests] == [SUPER] * 4 + [ULTRA]
    assert (run_report(db, site.world_id, tm_run).auditor_json or {})["run"]["pipeline"] == (
        "orchestrator"
    )


@requires_db
def test_mock_run_report_returns_the_stored_auditor_template_as_fallback(
    api: tuple[TestClient, Deferred], db: Connection
) -> None:
    """End to end (#145): a real mock-mode run, then GET /reports/{id}."""
    client, deferred = api
    hero = _hero(client)
    run_id = client.post(f"/assets/{hero}/rate").json()["run_id"]
    deferred.run_all()
    report_id = client.get(f"/runs/{run_id}").json()["report_id"]

    body = client.get(f"/reports/{report_id}").json()

    with sessions(db)() as session:
        row = session.get(Report, UUID(report_id))
        assert row is not None
        stored_summary = row.summary_md
    assert body["summary_source"] == "fallback"
    assert body["summary_md"] == stored_summary
    assert "[score:base_health]" in body["summary_md"]
    assert body["auditor"]["summary_md"] in body["summary_md"]


@requires_db
def test_mock_scenario_run_report_states_it_is_simulated(
    api: tuple[TestClient, Deferred],
) -> None:
    """End to end (#145): a Time Machine run's report keeps the code-written warning."""
    client, deferred = api
    hero = _hero(client)
    world_id = UUID(client.get("/world").json()["id"])
    runner: RatingRunner = app.dependency_overrides[get_rating_runner]()
    run_id = runner.start(world_id, UUID(hero), scenario="encroachment", trigger="time_machine")
    deferred.run_all()
    report_id = client.get(f"/runs/{run_id}").json()["report_id"]

    body = client.get(f"/reports/{report_id}").json()

    assert body["simulated"] is True
    assert body["summary_source"] == "fallback"
    assert "simulated Time Machine scenario" in body["summary_md"]
    assert "not an observation" in body["summary_md"]

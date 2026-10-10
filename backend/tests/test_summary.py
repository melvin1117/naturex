"""Live report summary generation (T10)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, col, select

from app.agents.summary import SummaryContext, clear_summary_cache, generate_report_summary
from app.config import Settings, get_settings
from app.llm import BudgetExceeded, CallRecord, DbCallLog, LLMClient, Tier
from app.main import app
from app.mocks import wetland_report
from app.models import LlmCall, World
from app.routers import reports as reports_router
from app.sandbox import _delete_world_rows
from app.schemas import EventOut, ReportSummarySource
from app.seed import seed
from tests.conftest import alembic_cfg, requires_db

NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
SUPER = "nvidia/nemotron-3-super-120b-a12b"
ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b"


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "model_fast": NANO,
        "model_orchestrator": SUPER,
        "model_auditor": ULTRA,
        "llm_budget_usd": 20.0,
        "nebius_api_key": "test-key",
        "use_mocks": False,
    }
    return Settings(_env_file=None, **{**base, **overrides})


def reply(content: str, prompt_tokens: int = 180, completion_tokens: int = 48) -> Any:
    message = SimpleNamespace(content=content, tool_calls=None, model_extra={})
    usage = SimpleNamespace(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


class FakeTransport:
    """Replays scripted replies and records every request without touching the network."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class MemoryCallLog:
    def __init__(self, budget_exhausted: bool = False) -> None:
        self.budget_exhausted = budget_exhausted
        self.rows: list[CallRecord] = []

    def spent_usd(self) -> Decimal:
        return Decimal("0")

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        _ = budget
        if self.budget_exhausted:
            raise BudgetExceeded("over budget")
        self.rows.append(call)
        return len(self.rows) - 1

    def settle(self, handle: int, call: CallRecord) -> None:
        self.rows[handle] = call


class BrokenCallLog(MemoryCallLog):
    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        _ = call, budget
        raise SQLAlchemyError("db unavailable")


@pytest.fixture(autouse=True)
def empty_cache() -> Iterator[None]:
    clear_summary_cache()
    yield
    clear_summary_cache()


@pytest.fixture(autouse=True)
def override_app_settings() -> Iterator[None]:
    app.dependency_overrides[get_settings] = lambda: settings(use_mocks=True)
    yield
    app.dependency_overrides.pop(get_settings, None)


def llm(
    transport: FakeTransport,
    config: Settings | None = None,
    call_log: MemoryCallLog | None = None,
) -> LLMClient:
    return LLMClient(config or settings(), transport, call_log or MemoryCallLog())


def test_mock_mode_uses_deterministic_fallback_and_never_calls_llm() -> None:
    transport = FakeTransport()

    result = generate_report_summary(
        wetland_report(), settings(use_mocks=True), lambda: llm(transport)
    )

    assert result.source is ReportSummarySource.FALLBACK
    assert "Health 77.6 / 100" in result.summary_md
    assert transport.requests == []


@requires_db
def test_live_summary_is_schema_validated_and_logged_to_llm_calls() -> None:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    agent = "report_summary"
    with Session(engine) as session:
        seed(session)
        session.execute(delete(LlmCall).where(LlmCall.agent == agent))
        session.commit()
    transport = FakeTransport(
        reply(
            json.dumps(
                {
                    "summary_md": (
                        "## Ecological Performance Report — Q3 2026\n\n"
                        "Health is 77.6 / 100 (grade A), with $4.7M-$17.5M /yr value "
                        "and mid $11.7M at 87% confidence."
                    )
                }
            )
        )
    )

    report = wetland_report()
    result = generate_report_summary(
        report,
        settings(),
        lambda: LLMClient(settings(), transport, DbCallLog(lambda: Session(engine))),
        log_asset_id_factory=lambda: report.asset_id,
    )

    with Session(engine) as session:
        rows = session.exec(
            select(LlmCall).where(LlmCall.agent == agent).order_by(col(LlmCall.id))
        ).all()
        session.execute(delete(LlmCall).where(LlmCall.agent == agent))
        session.commit()
    engine.dispose()
    assert result.source is ReportSummarySource.LIVE
    assert result.summary_md.startswith("## Ecological Performance Report")
    [row] = rows
    assert (row.model, row.tier, row.status) == (NANO, Tier.FAST.value, "ok")
    assert (row.prompt_tokens, row.completion_tokens, row.cost_usd) == (
        180,
        48,
        Decimal("0.000022"),
    )
    prompt = transport.requests[0]["messages"][0]["content"]
    assert "Do not introduce any number" in prompt
    assert "event_id" not in prompt


def test_invented_numbers_trigger_fallback() -> None:
    transport = FakeTransport(reply(json.dumps({"summary_md": "Health is 999 / 100."})))

    result = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))

    assert result.source is ReportSummarySource.FALLBACK
    assert "999" not in result.summary_md


@pytest.mark.parametrize(
    "summary",
    [
        "Health is 77.6 / 100, with USD999M value.",
        "Health is 77.6 / 100, with EUR50M value.",
        "Health is 77.6 / 100, with $11.7B value.",
        "Health is 77.6 / 100, with 11.7 billion value.",
        "Q4 2026 health is 77.6 / 100.",
    ],
)
def test_number_guard_rejects_unprovided_units_scales_and_periods(summary: str) -> None:
    transport = FakeTransport(reply(json.dumps({"summary_md": summary})))

    result = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))

    assert result.source is ReportSummarySource.FALLBACK
    assert result.summary_md != summary


@pytest.mark.parametrize(
    "summary",
    [
        ("Q3 2026 health is 77.6/100 with 87% confidence and $4.7M–$17.5M /yr value, mid $11.7M."),
        (
            "Q3 2026 health is 77.6/100 with 87% confidence and "
            "$4.7M–$17.5M /yr value, mid $11,700,000."
        ),
        (
            "Q3 2026 health is 77.6/100 with 87% confidence and "
            "$4.7M–$17.5M /yr value, mid 11.7 million."
        ),
    ],
)
def test_number_guard_accepts_legitimate_report_number_forms(summary: str) -> None:
    transport = FakeTransport(reply(json.dumps({"summary_md": summary})))

    result = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))

    assert result.source is ReportSummarySource.LIVE
    assert result.summary_md == summary


@pytest.mark.parametrize(
    ("summary", "source"),
    [
        # Since T26 moved the guard to app/agents/guards.py, "87 %" and "87 percent" are read
        # as the percentage fact "87%" (before, they were bare numbers and fell back).
        ("Health is 77.6 / 100 with 87 % confidence.", ReportSummarySource.LIVE),
        ("Health is 77.6 / 100 with 87 percent confidence.", ReportSummarySource.LIVE),
        ("Health is 77.6 / 100; 40 % of the site is water.", ReportSummarySource.FALLBACK),
        ("Health is 77.6 / 100; 40 percent of the site is water.", ReportSummarySource.FALLBACK),
    ],
)
def test_number_guard_reads_spaced_and_spelled_out_percentages(
    summary: str, source: ReportSummarySource
) -> None:
    transport = FakeTransport(reply(json.dumps({"summary_md": summary})))

    result = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))

    assert result.source is source


def test_live_summary_is_cached_per_facts() -> None:
    transport = FakeTransport(
        reply(
            json.dumps(
                {
                    "summary_md": (
                        "Health is 77.6 / 100, with $4.7M-$17.5M /yr value and "
                        "mid $11.7M at 87% confidence."
                    )
                }
            )
        )
    )

    first = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))
    second = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))

    assert (first.source, second.source) == (
        ReportSummarySource.LIVE,
        ReportSummarySource.LIVE,
    )
    assert first.summary_md == second.summary_md
    assert len(transport.requests) == 1


def test_fallback_summary_is_briefly_cached_per_facts() -> None:
    transport = FakeTransport(
        reply(json.dumps({"summary_md": "Health is 999 / 100."})),
        reply(json.dumps({"summary_md": "Health is 77.6 / 100."})),
    )

    first = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))
    second = generate_report_summary(wetland_report(), settings(), lambda: llm(transport))

    assert (first.source, second.source) == (
        ReportSummarySource.FALLBACK,
        ReportSummarySource.FALLBACK,
    )
    assert first.summary_md == second.summary_md
    assert len(transport.requests) == 1


def test_llm_budget_exhaustion_triggers_fallback() -> None:
    transport = FakeTransport()
    config = settings(llm_budget_usd=0)

    result = generate_report_summary(
        wetland_report(),
        config,
        lambda: llm(transport, config, MemoryCallLog(budget_exhausted=True)),
    )

    assert result.source is ReportSummarySource.FALLBACK
    assert transport.requests == []


def test_call_log_database_errors_trigger_fallback() -> None:
    transport = FakeTransport(reply(json.dumps({"summary_md": "Health is 77.6 / 100."})))

    result = generate_report_summary(
        wetland_report(),
        settings(),
        lambda: llm(transport, call_log=BrokenCallLog()),
    )

    assert result.source is ReportSummarySource.FALLBACK


@pytest.fixture
def world_client() -> Iterator[tuple[TestClient, Any]]:
    """A client with a committed visitor world, so the call log's own session sees its assets."""
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        seed(session)
    client = TestClient(app)
    world_id = UUID(client.get("/world").json()["id"])
    yield client, engine
    with Session(engine) as session:
        _delete_world_rows(session, world_id, keep_world=False)
        session.execute(delete(World).where(col(World.id) == world_id))
        session.commit()
    engine.dispose()


def _hero(client: TestClient) -> dict[str, Any]:
    world = client.get("/world").json()
    asset_id = next(a["id"] for a in world["assets"] if a["site_key"] == "wetland_mx")
    body: dict[str, Any] = client.get(f"/assets/{asset_id}").json()
    return body


@requires_db
def test_report_endpoint_returns_summary_source_for_generated_client(
    world_client: tuple[TestClient, Any],
) -> None:
    client, _ = world_client
    report_id = _hero(client)["latest_report"]["id"]

    res = client.get(f"/reports/{report_id}")

    assert res.status_code == 200
    body = res.json()
    assert body["summary_source"] == ReportSummarySource.FALLBACK.value
    assert "Health 76.2 / 100 (grade A)" in body["summary_md"]
    assert "deterministic satellite metrics for 207 ha" in body["summary_md"]


@requires_db
def test_report_endpoint_live_mode_uses_fake_client_and_logs_call(
    monkeypatch: pytest.MonkeyPatch, world_client: tuple[TestClient, Any]
) -> None:
    client, engine = world_client
    agent = "report_summary"
    hero = _hero(client)
    with Session(engine) as session:
        session.execute(delete(LlmCall).where(LlmCall.agent == agent))
        session.commit()
    transport = FakeTransport(
        reply(
            json.dumps(
                {
                    "summary_md": (
                        "Q3 2026 health is 76.2/100 with 71% confidence and "
                        "$2.1M–$2.7M /yr value, mid $2.7M."
                    )
                }
            )
        )
    )

    def fake_summary_client(config: Settings) -> LLMClient:
        return LLMClient(config, transport, DbCallLog(lambda: Session(engine)))

    app.dependency_overrides[get_settings] = lambda: settings(use_mocks=False)
    monkeypatch.setattr(reports_router, "_summary_client", fake_summary_client)
    clear_summary_cache()  # reading the asset above cached the fallback

    res = client.get(f"/reports/{hero['latest_report']['id']}")

    with Session(engine) as session:
        rows = session.exec(select(LlmCall).where(LlmCall.agent == agent)).all()
        session.execute(delete(LlmCall).where(LlmCall.agent == agent))
        session.commit()
    assert res.status_code == 200
    assert res.json()["summary_source"] == ReportSummarySource.LIVE.value
    [row] = rows
    assert (row.agent, row.status, row.asset_id) == (agent, "ok", UUID(hero["id"]))


@requires_db
def test_asset_detail_uses_the_same_summary_as_report_endpoint(
    world_client: tuple[TestClient, Any],
) -> None:
    client, _ = world_client
    asset = _hero(client)

    report = client.get(f"/reports/{asset['latest_report']['id']}").json()

    assert asset["latest_report"]["summary_md"] == report["summary_md"]
    assert asset["latest_report"]["summary_source"] == report["summary_source"]


def test_simulated_reports_are_never_summarised_as_observed() -> None:
    report = wetland_report().model_copy(update={"simulated": True, "period": "2026Q4"})

    result = generate_report_summary(report, settings(use_mocks=True), None)

    assert "## Ecological Performance Report — Q4 2026" in result.summary_md
    assert "simulated Time Machine scenario" in result.summary_md
    assert "satellite metrics" not in result.summary_md


def test_simulated_reports_never_reach_the_model() -> None:
    """A live reply could drop the scenario warning, so simulated reports use the fallback."""
    transport = FakeTransport(
        reply(
            json.dumps({"summary_md": "Satellite observations show grade A health this quarter."})
        )
    )
    report = wetland_report().model_copy(update={"simulated": True, "period": "2026Q4"})

    result = generate_report_summary(report, settings(), lambda: llm(transport))

    assert result.source is ReportSummarySource.FALLBACK
    assert "simulated Time Machine scenario" in result.summary_md
    assert "not an observation" in result.summary_md
    assert "Satellite observations" not in result.summary_md
    assert transport.requests == []


def _live_reply() -> Any:
    return reply(json.dumps({"summary_md": "Health is 77.6 / 100 at 87% confidence."}))


def test_copies_of_a_report_in_other_worlds_share_one_summary() -> None:
    transport = FakeTransport(_live_reply())
    context = SummaryContext(asset_name="Xochimilco Wetland", area_ha=Decimal("206.70"))
    template = wetland_report()
    copy = template.model_copy(update={"id": uuid4(), "asset_id": uuid4()})

    first = generate_report_summary(template, settings(), lambda: llm(transport), context=context)
    second = generate_report_summary(copy, settings(), lambda: llm(transport), context=context)

    assert (first.source, second.source) == (ReportSummarySource.LIVE, ReportSummarySource.LIVE)
    assert second.summary_md == first.summary_md
    assert len(transport.requests) == 1


def test_a_new_event_gives_a_new_summary() -> None:
    transport = FakeTransport(_live_reply(), _live_reply())
    quiet = SummaryContext(asset_name="Xochimilco Wetland", area_ha=Decimal("206.70"))
    event = EventOut(
        id=uuid4(),
        asset_id=wetland_report().asset_id,
        source="admin",
        title="Fire",
        impact_type="fire",
        direction=-1,
        severity=4,
        summary="A fire burned the reed beds.",
        created_at=datetime(2026, 10, 7, tzinfo=UTC),
    )
    busy = replace(quiet, event=event)

    generate_report_summary(wetland_report(), settings(), lambda: llm(transport), context=quiet)
    generate_report_summary(wetland_report(), settings(), lambda: llm(transport), context=busy)

    assert len(transport.requests) == 2

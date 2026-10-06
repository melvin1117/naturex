"""LLM client (T09): routing, structured output, retries, fallback, logging and budget cap."""

from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import httpx
import openai
import pytest
from alembic import command
from pydantic import BaseModel
from sqlalchemy import create_engine, delete
from sqlmodel import Session

from app.config import Settings, get_settings
from app.llm import (
    BudgetExceeded,
    CallRecord,
    DbCallLog,
    LLMClient,
    LLMError,
    ModelNotConfigured,
    Tier,
    cost_usd,
    get_llm_client,
)
from app.models import LlmCall
from tests.conftest import alembic_cfg, requires_db

NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
SUPER = "nvidia/nemotron-3-super-120b-a12b"
ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b"
REQUEST = httpx.Request("POST", "https://api.tokenfactory.nebius.com/v1/chat/completions")


class Event(BaseModel):
    impact_type: str
    direction: int


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "model_fast": NANO,
        "model_orchestrator": SUPER,
        "model_auditor": ULTRA,
        "llm_budget_usd": 20.0,
        "nebius_api_key": "",
    }
    return Settings(_env_file=None, **{**base, **overrides})


def reply(
    content: str | None = None,
    tool_calls: list[Any] | None = None,
    reasoning: str | None = None,
    prompt_tokens: int = 100,
    completion_tokens: int = 20,
) -> Any:
    message = SimpleNamespace(
        content=content,
        tool_calls=tool_calls,
        model_extra={"reasoning": reasoning} if reasoning else {},
    )
    usage = SimpleNamespace(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


def tool_call(name: str, arguments: str) -> Any:
    return SimpleNamespace(id="call_1", function=SimpleNamespace(name=name, arguments=arguments))


class FakeTransport:
    """Replays scripted replies (or raises scripted errors) and records every request."""

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
    def __init__(self, spent: str = "0") -> None:
        self.spent = Decimal(spent)
        self.records: list[CallRecord] = []

    def spent_usd(self) -> Decimal:
        return self.spent + sum((r.cost_usd for r in self.records), Decimal(0))

    def record(self, call: CallRecord) -> None:
        self.records.append(call)


def client(
    transport: FakeTransport, log: MemoryCallLog | None = None, **overrides: Any
) -> LLMClient:
    return LLMClient(settings(**overrides), transport, log or MemoryCallLog())


GOOD = '{"impact_type": "fire", "direction": -1}'
MESSAGES = [{"role": "user", "content": "Classify: wildfire near the wetland"}]


# --- Pricing ---------------------------------------------------------------------------------


def test_cost_uses_the_catalogue_price_per_million_tokens() -> None:
    assert cost_usd(NANO, 1_000_000, 1_000_000) == Decimal("0.30")
    assert cost_usd(ULTRA, 1_000, 500) == Decimal("0.0025")


def test_a_model_without_a_known_price_is_refused() -> None:
    llm = client(FakeTransport(), model_fast="vendor/unknown-model")

    with pytest.raises(ModelNotConfigured):
        llm.structured(agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event)


def test_an_empty_model_setting_is_refused() -> None:
    with pytest.raises(ModelNotConfigured):
        client(FakeTransport(), model_auditor="").model_for(Tier.AUDITOR)


# --- Structured output -----------------------------------------------------------------------


def test_structured_answer_is_validated_and_logged_with_its_cost() -> None:
    log = MemoryCallLog()
    transport = FakeTransport(reply(GOOD, prompt_tokens=400, completion_tokens=50))

    result = client(transport, log).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    assert result.value == Event(impact_type="fire", direction=-1)
    assert (result.model, result.tier, result.degraded, result.attempts) == (
        NANO,
        Tier.FAST,
        False,
        1,
    )
    [record] = log.records
    assert (record.agent, record.model, record.status) == ("news_scout", NANO, "ok")
    assert (record.prompt_tokens, record.completion_tokens) == (400, 50)
    assert record.cost_usd == cost_usd(NANO, 400, 50)


def test_request_uses_the_openai_json_schema_shape_and_reasoning_off() -> None:
    transport = FakeTransport(reply(GOOD))

    client(transport).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    request = transport.requests[0]
    assert request["response_format"]["type"] == "json_schema"
    assert request["response_format"]["json_schema"]["name"] == "Event"
    assert request["response_format"]["json_schema"]["strict"] is True
    assert request["response_format"]["json_schema"]["schema"] == Event.model_json_schema()
    assert request["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False}}
    assert request["temperature"] == 0
    assert "JSON Schema" in request["messages"][-1]["content"], "schema is also in the prompt"
    assert request["messages"][: len(MESSAGES)] == MESSAGES


def test_reasoning_on_sends_no_toggle_and_returns_the_reasoning_text() -> None:
    transport = FakeTransport(reply(GOOD, reasoning="The article reports a fire, so..."))

    result = client(transport).structured(
        agent="auditor", tier=Tier.AUDITOR, messages=MESSAGES, schema=Event, reasoning=True
    )

    assert transport.requests[0]["extra_body"] is None
    assert result.reasoning == "The article reports a fire, so..."


def test_fenced_or_think_prefixed_json_is_accepted() -> None:
    transport = FakeTransport(reply("<think>hmm</think>\n```json\n" + GOOD + "\n```"))

    result = client(transport).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    assert result.value.direction == -1


# --- Retries and fallback --------------------------------------------------------------------


def test_invalid_json_is_retried_once_on_the_same_model() -> None:
    log = MemoryCallLog()
    transport = FakeTransport(reply("not json"), reply(GOOD))

    result = client(transport, log).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    assert result.attempts == 2
    assert not result.degraded
    assert [r.status for r in log.records] == ["invalid_output", "ok"]
    assert [r["model"] for r in transport.requests] == [NANO, NANO]


def test_schema_violations_count_as_invalid_output() -> None:
    log = MemoryCallLog()
    transport = FakeTransport(reply('{"impact_type": "fire"}'), reply(GOOD))

    client(transport, log).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    assert log.records[0].status == "invalid_output"


def test_auditor_falls_back_to_super_and_is_marked_degraded() -> None:
    log = MemoryCallLog()
    transport = FakeTransport(reply("nope"), reply("nope"), reply(GOOD))

    result = client(transport, log).structured(
        agent="auditor", tier=Tier.AUDITOR, messages=MESSAGES, schema=Event
    )

    assert [r["model"] for r in transport.requests] == [ULTRA, ULTRA, SUPER]
    assert (result.model, result.tier, result.degraded) == (SUPER, Tier.ORCHESTRATOR, True)


def test_every_failed_attempt_is_logged_before_giving_up() -> None:
    log = MemoryCallLog()
    transport = FakeTransport(*[reply("nope") for _ in range(4)])

    with pytest.raises(LLMError, match="4 attempts"):
        client(transport, log).structured(
            agent="auditor", tier=Tier.AUDITOR, messages=MESSAGES, schema=Event
        )

    assert [r.model for r in log.records] == [ULTRA, ULTRA, SUPER, NANO]
    assert all(r.status == "invalid_output" for r in log.records)
    assert sum(r.cost_usd for r in log.records) > 0, "failed attempts still cost money"


def test_timeouts_are_retried_and_logged_as_errors() -> None:
    log = MemoryCallLog()
    transport = FakeTransport(openai.APITimeoutError(request=REQUEST), reply(GOOD))

    result = client(transport, log).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    assert result.attempts == 2
    assert [(r.status, r.cost_usd) for r in log.records][0] == ("error", Decimal(0))


def test_a_rejected_request_fails_fast_without_falling_back() -> None:
    log = MemoryCallLog()
    rejected = openai.BadRequestError(
        "json_schema.name is required",
        response=httpx.Response(422, request=REQUEST),
        body=None,
    )
    transport = FakeTransport(rejected)

    with pytest.raises(LLMError, match="HTTP 422"):
        client(transport, log).structured(
            agent="auditor", tier=Tier.AUDITOR, messages=MESSAGES, schema=Event
        )

    assert len(transport.requests) == 1
    assert [r.status for r in log.records] == ["error"]


# --- Budget cap ------------------------------------------------------------------------------


def test_budget_cap_refuses_the_call_before_it_is_made() -> None:
    transport = FakeTransport(reply(GOOD))
    log = MemoryCallLog(spent="19.9999")

    with pytest.raises(BudgetExceeded):
        client(transport, log, llm_budget_usd=20.0).structured(
            agent="auditor", tier=Tier.AUDITOR, messages=MESSAGES, schema=Event, max_tokens=4096
        )

    assert transport.requests == [], "no tokens are spent once the cap is reached"


def test_budget_is_checked_again_before_each_retry() -> None:
    log = MemoryCallLog(spent="0")
    big = reply("nope", prompt_tokens=1_000_000, completion_tokens=1_000_000)
    transport = FakeTransport(big, reply(GOOD))

    with pytest.raises(BudgetExceeded):
        client(transport, log, llm_budget_usd=4.001).structured(
            agent="auditor", tier=Tier.AUDITOR, messages=MESSAGES, schema=Event
        )

    assert len(transport.requests) == 1
    assert log.records[0].cost_usd == Decimal("4.00")


def test_calls_under_the_cap_go_ahead() -> None:
    log = MemoryCallLog(spent="19.00")

    result = client(FakeTransport(reply(GOOD)), log, llm_budget_usd=20.0).structured(
        agent="news_scout", tier=Tier.FAST, messages=MESSAGES, schema=Event
    )

    assert result.value.impact_type == "fire"


# --- Text and tool steps ---------------------------------------------------------------------


def test_text_retries_an_empty_answer() -> None:
    transport = FakeTransport(reply("   "), reply("The wetland is stable."))

    result = client(transport).text(agent="summary", tier=Tier.FAST, messages=MESSAGES)

    assert result.value == "The wetland is stable."
    assert "response_format" not in transport.requests[0]


def test_tool_step_returns_the_assistant_message_with_its_tool_calls() -> None:
    call = tool_call("earth_obs", json.dumps({"asset_id": "a1", "data_version": "2026Q3"}))
    tools = [{"type": "function", "function": {"name": "earth_obs", "parameters": {}}}]
    transport = FakeTransport(reply(None, tool_calls=[call]))

    result = client(transport).tool_step(
        agent="orchestrator", tier=Tier.ORCHESTRATOR, messages=MESSAGES, tools=tools
    )

    assert result.value.tool_calls[0].function.name == "earth_obs"
    assert transport.requests[0]["tools"] == tools
    assert transport.requests[0]["tool_choice"] == "auto"


def test_tool_step_retries_unparseable_tool_arguments() -> None:
    log = MemoryCallLog()
    good = tool_call("earth_obs", '{"asset_id": "a1"}')
    transport = FakeTransport(
        reply(None, tool_calls=[tool_call("earth_obs", "{not json")]),
        reply(None, tool_calls=[good]),
    )

    result = client(transport, log).tool_step(
        agent="orchestrator", tier=Tier.ORCHESTRATOR, messages=MESSAGES, tools=[]
    )

    assert result.attempts == 2
    assert log.records[0].status == "invalid_output"


def test_production_client_needs_an_api_key() -> None:
    with pytest.raises(ModelNotConfigured):
        get_llm_client(settings(nebius_api_key=""), lambda: Session())


# --- Database call log -----------------------------------------------------------------------


@pytest.fixture
def db_log() -> Iterator[tuple[DbCallLog, str]]:
    command.upgrade(alembic_cfg(), "head")
    engine = create_engine(get_settings().database_url)
    agent = f"test-{uuid4()}"
    yield DbCallLog(lambda: Session(engine)), agent
    with Session(engine) as session:
        session.execute(delete(LlmCall).where(LlmCall.agent == agent))
        session.commit()
    engine.dispose()


@requires_db
def test_db_call_log_records_every_attempt_and_sums_spend(db_log: tuple[DbCallLog, str]) -> None:
    log, agent = db_log
    before = log.spent_usd()
    transport = FakeTransport(
        reply("nope", prompt_tokens=1000, completion_tokens=100),
        reply(GOOD, prompt_tokens=1000, completion_tokens=100),
    )

    LLMClient(settings(), transport, log).structured(
        agent=agent, tier=Tier.AUDITOR, messages=MESSAGES, schema=Event
    )

    engine = create_engine(get_settings().database_url)
    with Session(engine) as session:
        rows = session.query(LlmCall).filter(LlmCall.agent == agent).order_by(LlmCall.id).all()
    engine.dispose()
    assert [(r.model, r.tier, r.status) for r in rows] == [
        (ULTRA, "auditor", "invalid_output"),
        (ULTRA, "auditor", "ok"),
    ]
    assert all(r.latency_ms is not None for r in rows)
    assert log.spent_usd() - before == 2 * cost_usd(ULTRA, 1000, 100)

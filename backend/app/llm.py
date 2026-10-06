"""The one client for every model call (dev-spec §3, ADR-0003, T09).

All AI calls go through Nebius Token Factory (OpenAI-compatible API). This module:
- routes a *tier* (fast / orchestrator / auditor) to the model ID configured in `.env`;
- asks for structured output with `response_format` `json_schema` in the OpenAI shape
  (`name`, `schema`, `strict`) and validates it with Pydantic (T02: the raw-schema shape
  in the Token Factory docs returns 422);
- turns Nemotron's reasoning off unless the caller asks for it
  (`chat_template_kwargs.enable_thinking`, on by default per the NVIDIA model card);
- retries a failed or invalid attempt once on the same model, then falls back one tier
  (auditor → orchestrator → fast) and marks the result `degraded`;
- logs every attempt, failed ones included, to `llm_calls` with tokens, latency and cost;
- refuses a call that could push total spend past `LLM_BUDGET_USD`.

Sources:
  https://docs.tokenfactory.nebius.com/ai-models-inference/json.md
  https://docs.tokenfactory.nebius.com/ai-models-inference/function-calling.md
  https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 (reasoning off)
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID

import openai
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, text
from sqlmodel import Session, select

from app.config import Settings
from app.models import LlmCall

log = logging.getLogger(__name__)

PER_MILLION = Decimal(1_000_000)
# USD per 1M tokens (input, output) from the Token Factory catalogue, 2026-10-05 (ADR-0003).
# A model missing here is refused rather than guessed, so the budget cap can't be bypassed.
PRICES_PER_M: dict[str, tuple[Decimal, Decimal]] = {
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": (Decimal("0.06"), Decimal("0.24")),
    "nvidia/Nemotron-3_5-Lightning": (Decimal("0.06"), Decimal("0.24")),
    "nvidia/nemotron-3-super-120b-a12b": (Decimal("0.30"), Decimal("0.90")),
    "nvidia/Nemotron-3-Ultra-550b-a55b": (Decimal("1.00"), Decimal("3.00")),
    "openbmb/MiniCPM-V-4_5": (Decimal("0.658"), Decimal("1.11")),
    "Qwen/Qwen3-Embedding-8B": (Decimal("0.01"), Decimal("0")),
}
# Conservative lower bound on characters per token, so the prompt reserve overestimates.
CHARS_PER_TOKEN = 2
# Postgres advisory-lock key that serialises budget reservations across processes.
BUDGET_LOCK_KEY = 0x4E584C4C
REQUEST_TIMEOUT_S = 60.0
THINKING_OFF: dict[str, Any] = {"chat_template_kwargs": {"enable_thinking": False}}


class Tier(StrEnum):
    FAST = "fast"
    ORCHESTRATOR = "orchestrator"
    AUDITOR = "auditor"


# The first tier gets a retry; each fallback tier gets one attempt (dev-spec §3).
FALLBACK: dict[Tier, tuple[Tier, ...]] = {
    Tier.AUDITOR: (Tier.AUDITOR, Tier.ORCHESTRATOR, Tier.FAST),
    Tier.ORCHESTRATOR: (Tier.ORCHESTRATOR, Tier.FAST),
    Tier.FAST: (Tier.FAST,),
}


class LLMError(RuntimeError):
    """No attempt produced a usable answer. Callers fall back to cached results."""


class BudgetExceeded(LLMError):
    """The call could push total spend past LLM_BUDGET_USD, so it was not made."""


class ModelNotConfigured(LLMError):
    """The tier's MODEL_* setting is empty, or its price is unknown."""


class ChatTransport(Protocol):
    """`OpenAI(...).chat.completions`, or a fake in tests."""

    def create(self, **kwargs: Any) -> Any: ...


@dataclass(frozen=True, slots=True)
class CallRecord:
    agent: str
    tier: Tier
    model: str
    status: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: int
    cost_usd: Decimal
    world_id: UUID | None = None
    asset_id: UUID | None = None


class CallLog(Protocol):
    """Spend ledger. `reserve` must be atomic across processes so the cap is hard."""

    def spent_usd(self) -> Decimal: ...

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        """Record `call` (status `reserved`, cost = worst case) unless that would push total
        spend past `budget`; then raise BudgetExceeded. Returns a handle for `settle`."""
        ...

    def settle(self, handle: int, call: CallRecord) -> None:
        """Replace the reservation with what the attempt actually cost."""
        ...


class DbCallLog:
    """`llm_calls` in Postgres, in its own short transactions, so spend is recorded even if
    the caller's transaction later rolls back. A transaction-scoped advisory lock makes
    check-and-reserve atomic across workers. A reservation left behind by a crash keeps
    counting at its worst-case cost (fail closed)."""

    def __init__(self, session_factory: Callable[[], Session]) -> None:
        self._session_factory = session_factory

    def spent_usd(self) -> Decimal:
        with self._session_factory() as session:
            total = session.exec(select(func.coalesce(func.sum(LlmCall.cost_usd), 0))).one()
        return Decimal(total)

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        with self._session_factory() as session:
            session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": BUDGET_LOCK_KEY})
            spent = Decimal(
                session.exec(select(func.coalesce(func.sum(LlmCall.cost_usd), 0))).one()
            )
            if spent + call.cost_usd > budget:
                raise BudgetExceeded(_over_budget(budget, spent, call.cost_usd))
            row = _row(call)
            session.add(row)
            session.commit()
            assert row.id is not None
            return row.id

    def settle(self, handle: int, call: CallRecord) -> None:
        with self._session_factory() as session:
            row = session.get(LlmCall, handle)
            if row is None:
                raise LLMError(f"llm_calls row {handle} vanished before settling")
            for key, value in _row(call).model_dump(exclude={"id", "created_at"}).items():
                setattr(row, key, value)
            session.add(row)
            session.commit()


def _row(call: CallRecord) -> LlmCall:
    return LlmCall(
        world_id=call.world_id,
        asset_id=call.asset_id,
        agent=call.agent,
        model=call.model,
        tier=call.tier.value,
        status=call.status,
        prompt_tokens=call.prompt_tokens,
        completion_tokens=call.completion_tokens,
        latency_ms=call.latency_ms,
        cost_usd=call.cost_usd,
    )


def _over_budget(budget: Decimal, spent: Decimal, reserve: Decimal) -> str:
    return (
        f"LLM budget ${budget} would be exceeded "
        f"(spent ${spent:.4f}, this call may cost up to ${reserve:.4f})"
    )


@dataclass(frozen=True, slots=True)
class LLMResult[T]:
    value: T
    model: str
    tier: Tier
    degraded: bool
    """True when a fallback tier answered (dev-spec §3: flag the report `degraded_model`)."""
    attempts: int
    reasoning: str | None
    """Nemotron's reasoning text when reasoning was on (returned in `message.reasoning`)."""


def _describe(exc: Exception) -> str:
    status = getattr(exc, "status_code", None)
    return f"HTTP {status}" if status else type(exc).__name__


def cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> Decimal:
    price_in, price_out = _prices(model)
    return (prompt_tokens * price_in + completion_tokens * price_out) / PER_MILLION


def _prices(model: str) -> tuple[Decimal, Decimal]:
    if model not in PRICES_PER_M:
        raise ModelNotConfigured(f"no price for {model}; add it to PRICES_PER_M (ADR-0003)")
    return PRICES_PER_M[model]


def _reserve_usd(model: str, messages: Sequence[dict[str, Any]], max_tokens: int) -> Decimal:
    """Worst-case cost of one attempt: generous prompt estimate plus the full output cap."""
    prompt_chars = len(json.dumps(messages, default=str))
    return cost_usd(model, prompt_chars // CHARS_PER_TOKEN + 1, max_tokens)


def _strip_wrappers(text: str) -> str:
    """Drop a leading reasoning block or Markdown fences around a JSON answer."""
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        text = text.rsplit("```", 1)[0]
    return text.strip()


def _reasoning(message: Any) -> str | None:
    extra = getattr(message, "model_extra", None) or {}
    text = extra.get("reasoning") or extra.get("reasoning_content")
    return str(text) if text else None


def _classify(exc: openai.APIError) -> str:
    """`retry` (transient or malformed response) or `fail` (our request is wrong)."""
    if isinstance(exc, openai.APIStatusError):
        return "retry" if exc.status_code == 429 or exc.status_code >= 500 else "fail"
    return "retry"  # timeouts, connection errors, response validation errors


class LLMClient:
    def __init__(
        self,
        settings: Settings,
        transport: ChatTransport,
        call_log: CallLog,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self._settings = settings
        self._transport = transport
        self._log = call_log
        self._clock = clock

    def model_for(self, tier: Tier) -> str:
        model = {
            Tier.FAST: self._settings.model_fast,
            Tier.ORCHESTRATOR: self._settings.model_orchestrator,
            Tier.AUDITOR: self._settings.model_auditor,
        }[tier]
        if not model:
            raise ModelNotConfigured(f"MODEL_* for tier {tier} is empty in .env")
        _prices(model)
        return model

    def structured[T: BaseModel](
        self,
        *,
        agent: str,
        tier: Tier,
        messages: Sequence[dict[str, Any]],
        schema: type[T],
        reasoning: bool = False,
        max_tokens: int = 1024,
        world_id: UUID | None = None,
        asset_id: UUID | None = None,
    ) -> LLMResult[T]:
        """A Pydantic-validated JSON answer. The schema is sent both in `response_format`
        and in the prompt (T02: both together are the most reliable)."""
        json_schema = schema.model_json_schema()
        full = [
            *messages,
            {
                "role": "system",
                "content": "Reply with one JSON object that matches this JSON Schema, and "
                "nothing else:\n" + json.dumps(json_schema),
            },
        ]
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "schema": json_schema, "strict": True},
        }

        def parse(message: Any) -> T:
            return schema.model_validate_json(_strip_wrappers(message.content or ""))

        return self._call(
            agent=agent,
            tier=tier,
            messages=full,
            parse=parse,
            reasoning=reasoning,
            max_tokens=max_tokens,
            world_id=world_id,
            asset_id=asset_id,
            response_format=response_format,
        )

    def text(
        self,
        *,
        agent: str,
        tier: Tier,
        messages: Sequence[dict[str, Any]],
        reasoning: bool = False,
        max_tokens: int = 1024,
        world_id: UUID | None = None,
        asset_id: UUID | None = None,
    ) -> LLMResult[str]:
        """A plain-text answer (summaries, Copilot). Empty answers count as invalid."""

        def parse(message: Any) -> str:
            content = (message.content or "").strip()
            if not content:
                raise ValueError("empty answer")
            return content

        return self._call(
            agent=agent,
            tier=tier,
            messages=list(messages),
            parse=parse,
            reasoning=reasoning,
            max_tokens=max_tokens,
            world_id=world_id,
            asset_id=asset_id,
        )

    def tool_step(
        self,
        *,
        agent: str,
        tier: Tier,
        messages: Sequence[dict[str, Any]],
        tools: Sequence[dict[str, Any]],
        tool_choice: str | dict[str, Any] = "auto",
        reasoning: bool = False,
        max_tokens: int = 1024,
        world_id: UUID | None = None,
        asset_id: UUID | None = None,
    ) -> LLMResult[Any]:
        """One step of a tool-calling loop. Returns the assistant message; the caller
        executes any `tool_calls` and validates their arguments against its own tools."""

        def parse(message: Any) -> Any:
            for call in message.tool_calls or []:
                json.loads(call.function.arguments or "{}")
            if not message.tool_calls and not (message.content or "").strip():
                raise ValueError("neither a tool call nor an answer")
            return message

        return self._call(
            agent=agent,
            tier=tier,
            messages=list(messages),
            parse=parse,
            reasoning=reasoning,
            max_tokens=max_tokens,
            world_id=world_id,
            asset_id=asset_id,
            tools=list(tools),
            tool_choice=tool_choice,
        )

    def _attempts(self, tier: Tier) -> list[Tier]:
        chain = FALLBACK[tier]
        return [chain[0], *chain]

    def _call[T](
        self,
        *,
        agent: str,
        tier: Tier,
        messages: list[dict[str, Any]],
        parse: Callable[[Any], T],
        reasoning: bool,
        max_tokens: int,
        world_id: UUID | None,
        asset_id: UUID | None,
        **request: Any,
    ) -> LLMResult[T]:
        failures: list[str] = []
        budget = Decimal(str(self._settings.llm_budget_usd))
        for attempt, attempt_tier in enumerate(self._attempts(tier), start=1):
            model = self.model_for(attempt_tier)
            reserve = _reserve_usd(model, messages, max_tokens)
            planned = CallRecord(
                agent=agent,
                tier=attempt_tier,
                model=model,
                status="reserved",
                prompt_tokens=0,
                completion_tokens=0,
                latency_ms=0,
                cost_usd=reserve,
                world_id=world_id,
                asset_id=asset_id,
            )
            handle = self._log.reserve(planned, budget)
            start = self._clock()

            try:
                completion = self._transport.create(
                    model=model,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=0,
                    timeout=REQUEST_TIMEOUT_S,
                    extra_body=None if reasoning else THINKING_OFF,
                    **request,
                )
            except openai.APIError as exc:
                if _classify(exc) == "fail":
                    # Rejected requests aren't billed.
                    self._settle(handle, planned, start, "error", 0, 0, Decimal(0))
                    raise LLMError(f"{model} rejected the request: {_describe(exc)}") from exc
                # Unknown whether tokens were billed, so keep the worst-case charge.
                self._settle(handle, planned, start, "error", 0, 0, reserve)
                failures.append(f"{model}: {_describe(exc)}")
                continue
            except Exception:
                # Not an API error (a bug on our side): keep the worst-case charge and surface it.
                self._settle(handle, planned, start, "error", 0, 0, reserve)
                raise

            usage = getattr(completion, "usage", None)
            prompt = int(getattr(usage, "prompt_tokens", 0) or 0)
            output = int(getattr(usage, "completion_tokens", 0) or 0)
            spent = cost_usd(model, prompt, output) if usage else reserve
            try:
                message = completion.choices[0].message
                value = parse(message)
            except (ValidationError, ValueError, LookupError, AttributeError, TypeError) as exc:
                self._settle(handle, planned, start, "invalid_output", prompt, output, spent)
                failures.append(f"{model}: invalid output ({str(exc)[:80]})")
                continue

            self._settle(handle, planned, start, "ok", prompt, output, spent)
            return LLMResult(
                value=value,
                model=model,
                tier=attempt_tier,
                degraded=attempt_tier != tier,
                attempts=attempt,
                reasoning=_reasoning(message),
            )
        raise LLMError(f"{agent}: no usable answer after {len(failures)} attempts: {failures}")

    def _settle(
        self,
        handle: int,
        planned: CallRecord,
        start: float,
        status: str,
        prompt_tokens: int,
        completion_tokens: int,
        cost: Decimal,
    ) -> None:
        self._log.settle(
            handle,
            replace(
                planned,
                status=status,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                latency_ms=int((self._clock() - start) * 1000),
                cost_usd=cost,
            ),
        )


class OpenAITransport:
    """Adapts the OpenAI SDK's overloaded `chat.completions.create` to ChatTransport."""

    def __init__(self, sdk: openai.OpenAI) -> None:
        self._sdk = sdk

    def create(self, **kwargs: Any) -> Any:
        return self._sdk.chat.completions.create(**kwargs)


def get_llm_client(settings: Settings, session_factory: Callable[[], Session]) -> LLMClient:
    """The production client: Token Factory over the OpenAI SDK, spend logged in Postgres."""
    if not settings.nebius_api_key:
        raise ModelNotConfigured("NEBIUS_API_KEY is empty; run `make check-keys`")
    sdk = openai.OpenAI(
        base_url=settings.token_factory_base_url,
        api_key=settings.nebius_api_key,
        max_retries=0,  # retries are ours, so every attempt is logged and counted
    )
    return LLMClient(settings, OpenAITransport(sdk), DbCallLog(session_factory))

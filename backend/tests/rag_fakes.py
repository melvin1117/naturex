"""Fakes for Copilot tests (T39): a scripted Token Factory and an in-memory spend log."""

from __future__ import annotations

import json
from dataclasses import replace
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from app.config import Settings
from app.llm import BudgetExceeded, CallRecord, LLMClient
from app.rag.embed import hash_vector

NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
QWEN = "Qwen/Qwen3-Embedding-8B"


def live_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "model_fast": NANO,
        "model_orchestrator": "nvidia/nemotron-3-super-120b-a12b",
        "model_auditor": "nvidia/Nemotron-3-Ultra-550b-a55b",
        "model_embed": QWEN,
        "llm_budget_usd": 20.0,
        "nebius_api_key": "test-key",
        "use_mocks": False,
    }
    return Settings(_env_file=None, **{**base, **overrides})


def draft(answer: str, insufficient: bool = False) -> Any:
    """A chat completion whose content is a CopilotDraft."""
    content = json.dumps({"answer": answer, "insufficient": insufficient})
    message = SimpleNamespace(content=content, tool_calls=None, model_extra={})
    usage = SimpleNamespace(prompt_tokens=900, completion_tokens=60)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


class FakeTokenFactory:
    """Chat replies from a script; embeddings from the deterministic hash embedder (so a fake
    "real" model still ranks sensibly). Records every request."""

    def __init__(self, *script: Any) -> None:
        self.script = list(script)
        self.requests: list[dict[str, Any]] = []
        self.embed_requests: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def embed(self, **kwargs: Any) -> Any:
        self.embed_requests.append(kwargs)
        texts: list[str] = kwargs["input"]
        data = [
            SimpleNamespace(index=i, embedding=hash_vector(text.split("Query: ")[-1]))
            for i, text in enumerate(texts)
        ]
        tokens = sum(len(t) for t in texts) // 4
        return SimpleNamespace(data=data, usage=SimpleNamespace(prompt_tokens=tokens))


class MemoryLog:
    def __init__(self, budget_exhausted: bool = False) -> None:
        self.budget_exhausted = budget_exhausted
        self.rows: list[CallRecord] = []

    def spent_usd(self) -> Decimal:
        return sum((r.cost_usd for r in self.rows), Decimal(0))

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        if self.budget_exhausted or self.spent_usd() + call.cost_usd > budget:
            raise BudgetExceeded("over budget")
        self.rows.append(call)
        return len(self.rows) - 1

    def settle(self, handle: int, call: CallRecord) -> None:
        self.rows[handle] = call

    def mark(self, handle: int, status: str) -> None:
        self.rows[handle] = replace(self.rows[handle], status=status)


def fake_client(
    transport: FakeTokenFactory, log: MemoryLog | None = None, **settings: Any
) -> tuple[LLMClient, MemoryLog]:
    log = log or MemoryLog()
    client = LLMClient(
        live_settings(**settings), transport, log, clock=lambda: 0.0, embeddings=transport
    )
    return client, log

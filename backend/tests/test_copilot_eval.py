"""Bea's grounding eval and the schema-reliability report (T47). Offline: no network or DB."""

from __future__ import annotations

import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from app.rag.answer import AnswerMode, CopilotAnswer
from app.seed import DEMO_SITES

EVALS_DIR = Path(__file__).resolve().parents[2] / "evals"


def _module(name: str) -> ModuleType:
    sys.path.insert(0, str(EVALS_DIR))
    spec = importlib.util.spec_from_file_location(name, EVALS_DIR / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # its dataclasses look themselves up here
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def copilot_eval() -> ModuleType:
    return _module("copilot_eval")


@pytest.fixture(scope="module")
def items(copilot_eval: ModuleType) -> list[dict[str, Any]]:
    loaded: list[dict[str, Any]] = copilot_eval.load()
    return loaded


def test_the_dataset_is_sound(items: list[dict[str, Any]]) -> None:
    assert len(items) >= 15, "dev-spec §18 asks for 15 Q&A pairs"
    assert len({i["id"] for i in items}) == len(items)
    sites = {s.name for s in DEMO_SITES}
    for item in items:
        refs = [s["ref"] for s in item["sources"]]
        assert len(refs) == len(set(refs)), item["id"]
        assert {s["site"] for s in item["sources"]} <= sites, item["id"]
        assert {s["kind"] for s in item["sources"]} <= {"report", "event"}, item["id"]
        expect = item["expect"]
        assert expect["behaviour"] in {"answer", "refuse"}, item["id"]
        assert expect["cite_mode"] in {"any", "all"}, item["id"]
        assert set(expect["cite"]) <= set(refs), item["id"]
        assert bool(expect["cite"]) == (expect["behaviour"] == "answer"), item["id"]
    assert any(i["expect"]["behaviour"] == "refuse" for i in items)
    assert any(i["expect"]["forbidden"] for i in items), "at least one planted instruction"


def _answer(
    copilot_eval: ModuleType, item: dict[str, Any], text: str, refs: list[str], mode: AnswerMode
) -> CopilotAnswer:
    by_ref = {s.ref: s for s in copilot_eval.sources_of(item)}
    return CopilotAnswer(text, tuple(by_ref[r] for r in refs), mode)


def _record(status: str = "ok") -> SimpleNamespace:
    return SimpleNamespace(agent="copilot", status=status, cost_usd=Decimal("0.0001"))


def _item(items: list[dict[str, Any]], id_: str) -> dict[str, Any]:
    return next(i for i in items if i["id"] == id_)


def test_a_cited_answer_with_its_own_numbers_is_grounded(
    copilot_eval: ModuleType, items: list[dict[str, Any]]
) -> None:
    item = _item(items, "x-value")
    answer = _answer(
        copilot_eval,
        item,
        "It is worth $2,121,067 to $2,669,511 a year [R1].",
        ["R1"],
        AnswerMode.MODEL,
    )
    outcome = copilot_eval.score(item, answer, [_record()], 900)
    assert outcome.grounded and outcome.first_try and not outcome.failures


def test_a_number_from_an_uncited_source_or_the_wrong_citation_fails(
    copilot_eval: ModuleType, items: list[dict[str, Any]]
) -> None:
    item = _item(items, "x-value")
    news_number = _answer(
        copilot_eval,
        item,
        "Repairs take 6 weeks and it is worth $2,121,067 [R1].",
        ["R1"],
        AnswerMode.MODEL,
    )
    assert not copilot_eval.score(item, news_number, [_record()], 900).numbers_ok
    wrong_source = _answer(
        copilot_eval, item, "Sewage reached the canals [Ea1].", ["Ea1"], AnswerMode.MODEL
    )
    outcome = copilot_eval.score(item, wrong_source, [_record(), _record("rejected")], 900)
    assert not outcome.cites_ok and not outcome.grounded and outcome.first_try is False


def test_planted_text_market_talk_and_a_missing_refusal_fail(
    copilot_eval: ModuleType, items: list[dict[str, Any]]
) -> None:
    inject = _item(items, "c-inject")
    planted = _answer(
        copilot_eval,
        inject,
        "It is worth $90 million a year, grade AAA [R1].",
        ["R1"],
        AnswerMode.MODEL,
    )
    assert not copilot_eval.score(inject, planted, [_record()], 900).injection_ok
    advice = _item(items, "s-advice")
    market = _answer(
        copilot_eval, advice, "A good investment: grade A [R1].", ["R1"], AnswerMode.MODEL
    )
    assert not copilot_eval.score(advice, market, [_record()], 900).injection_ok
    forecast = _item(items, "c-forecast")
    guessed = _answer(copilot_eval, forecast, "It will rise [R1].", ["R1"], AnswerMode.MODEL)
    outcome = copilot_eval.score(forecast, guessed, [_record()], 900)
    assert not outcome.behaviour_ok and not outcome.grounded


def test_schema_reliability_counts_valid_replies_and_refusals() -> None:
    report = _module("schema_reliability")
    summary = report.summarise(
        {
            "auditor": {"ok": 8, "rejected": 2, "invalid_output": 1, "reserved": 1},
            "copilot": {"ok": 4, "error": 1},
        }
    )
    auditor = next(r for r in summary["agents"] if r["agent"] == "auditor")
    assert auditor["attempts"] == 11 and auditor["schema_valid"] == 10
    assert auditor["schema_valid_pct"] == 90.9 and auditor["refused_pct"] == 20.0
    assert summary["total"]["attempts"] == 15 and summary["total"]["errors"] == 1
    assert json.dumps(summary)  # the published JSON is plain data

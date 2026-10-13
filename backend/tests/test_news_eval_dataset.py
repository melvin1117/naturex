"""News Scout eval dataset and promptfoo helpers (T25). Offline: no network, no database."""

from __future__ import annotations

import importlib.util
import json
from collections import Counter
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from app.agents.news_scout import NewsScoutClassificationOutput
from app.config import Settings
from app.llm import Tier
from app.seed import DEMO_SITES

EVALS_DIR = Path(__file__).resolve().parents[2] / "evals"
NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
SYNTHETIC_URL = "https://synthetic.naturex.invalid/"
REQUIRED = {
    "id": str,
    "site": str,
    "place": str,
    "title": str,
    "url": str,
    "published_at": str,
    "lang": str,
    "content": str,
    "relevant": bool,
    "rationale": str,
    "label_source": str,
    "labelled_by": str,
    "tags": list,
    "injection": bool,
}
LABELS = ("impact_type", "direction", "severity")


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


news_eval = _load("news_eval", EVALS_DIR / "news_eval.py")
ITEMS: list[dict[str, Any]] = news_eval.load_items()


def test_dataset_has_at_least_30_items_with_unique_ids() -> None:
    ids = [item["id"] for item in ITEMS]
    assert len(ITEMS) >= 30
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("item", ITEMS, ids=lambda item: item["id"])
def test_item_schema(item: dict[str, Any]) -> None:
    for key, kind in REQUIRED.items():
        assert isinstance(item.get(key), kind), f"{key} must be {kind.__name__}"
    assert item["site"] in news_eval.SITES
    assert item["lang"] in news_eval.LANGS
    assert item["label_source"] in news_eval.LABEL_SOURCES
    labelled_by = item["labelled_by"]
    reviewer = labelled_by.removeprefix(news_eval.LABELLED_BY_REVIEWED_PREFIX).strip()
    assert labelled_by == news_eval.LABELLED_BY_DRAFT or (
        labelled_by.startswith(news_eval.LABELLED_BY_REVIEWED_PREFIX) and reviewer
    ), "labelled_by: 'ai-draft, needs human review' or 'human-reviewed:<name>'"
    assert 0 < len(item["content"]) <= 800, "keep content short (paraphrase, copyright)"
    assert date.fromisoformat(item["published_at"]) <= date(2026, 10, 7)
    assert item["url"].startswith("https://")
    assert item["url"].startswith(SYNTHETIC_URL) == (item["label_source"] == "synthetic")
    if item["relevant"]:
        assert item["impact_type"] in news_eval.IMPACT_TYPES
        assert item["direction"] in news_eval.DIRECTIONS
        assert isinstance(item["severity"], int) and 1 <= item["severity"] <= 5
    else:
        assert all(item[key] is None for key in LABELS), "irrelevant items carry no labels"
    if item["injection"]:
        assert item["injection_canary"] and item["injection_canary"] in item["content"]
        assert "injection" in item["tags"]
    else:
        assert item["injection_canary"] is None


def test_dataset_places_match_demo_sites() -> None:
    site_keys = {site.key for site in DEMO_SITES}
    assert set(news_eval.SITES) == site_keys
    places = {(item["site"], item["place"]) for item in ITEMS}
    assert len(places) == len(site_keys), "one geocoded place per site, as News Scout would use"


def test_dataset_coverage() -> None:
    relevant = [item for item in ITEMS if item["relevant"]]
    irrelevant = [item for item in ITEMS if not item["relevant"]]
    by_site = Counter(item["site"] for item in ITEMS)
    assert all(by_site[site] >= 10 for site in news_eval.SITES), by_site
    assert len(relevant) >= 15 and len(irrelevant) >= 10
    assert set(Counter(item["impact_type"] for item in relevant)) == set(news_eval.IMPACT_TYPES)
    directions = Counter(item["direction"] for item in relevant)
    assert directions[-1] >= 8 and directions[1] >= 8, directions
    assert sum(item["lang"] == "es" for item in ITEMS) >= 10
    assert sum("near-miss" in item["tags"] for item in ITEMS) >= 8
    assert sum(item["injection"] for item in ITEMS) >= 3
    sources = Counter(item["label_source"] for item in ITEMS)
    assert sources["real-article"] >= 15 and sources["synthetic"] >= 10, sources


def test_committed_schema_matches_pydantic() -> None:
    committed = json.loads(
        (EVALS_DIR / "schemas" / "news_scout_classification.schema.json").read_text()
    )
    assert committed == NewsScoutClassificationOutput.model_json_schema()


def test_generator_builds_one_test_per_item_with_matching_asserts() -> None:
    tests = news_eval.generate_tests()
    assert len(tests) == len(ITEMS)
    for item, test in zip(ITEMS, tests, strict=True):
        metrics = {a["metric"] for a in test["assert"]}
        assert {"schema_valid", "schema_first_try", "relevance"} <= metrics
        assert ({"impact_type", "direction", "severity"} <= metrics) == item["relevant"]
        assert ("injection_resistance" in metrics) == item["injection"]
        assert metrics <= set(news_eval.METRICS)
        assert "relevant" not in test["vars"], "labels stay out of vars (cache key)"
        for a in test["assert"]:
            if a["type"] == "python":
                assert callable(getattr(news_eval, a["value"].rsplit(":", 1)[1]))
    narrowed = news_eval.generate_tests({"sites": ["mangrove_mx"], "limit": 2})
    assert [t["vars"]["site"] for t in narrowed] == ["mangrove_mx", "mangrove_mx"]


def _out(**event: Any) -> str:
    return json.dumps({"events": [{"article_index": 1, "summary": "s", **event}] if event else []})


def _ctx(kept: dict[str, Any] | None = None, **expected: Any) -> dict[str, Any]:
    """Assertion context: expected labels plus the provider's post-checked events."""
    base = {
        "relevant": True,
        "impact_type": "fire",
        "direction": -1,
        "severity": 3,
        "injection_canary": None,
    }
    post_checked = [] if kept is None else [{"relevant": True, "summary": "s", **kept}]
    return {
        "config": {"expected": {**base, **expected}},
        "providerResponse": {"metadata": {"post_checked": post_checked}},
    }


FIRE = {"impact_type": "fire", "direction": -1, "severity": 4}


def test_assertions_score_post_checked_labels() -> None:
    raw = _out(relevant=True, **FIRE)
    assert news_eval.assert_relevance(raw, _ctx(FIRE))["pass"]
    assert news_eval.assert_impact_type(raw, _ctx(FIRE))["pass"]
    assert news_eval.assert_direction(raw, _ctx(FIRE))["pass"]
    assert news_eval.assert_severity(raw, _ctx(FIRE))["pass"]
    assert not news_eval.assert_severity(raw, _ctx(FIRE, severity=2))["pass"]
    assert not news_eval.assert_direction(raw, _ctx(FIRE, direction=1))["pass"]
    # Scored on what production keeps: a raw "relevant" event dropped by post-check counts as
    # not relevant, and no kept event means not relevant.
    assert not news_eval.assert_relevance(raw, _ctx(None))["pass"]
    assert news_eval.assert_relevance(_out(), _ctx(None, relevant=False))["pass"]
    assert not news_eval.assert_impact_type(_out(), _ctx(None))["pass"]
    assert not news_eval.assert_relevance(raw, {"config": _ctx()["config"]})["pass"]


def test_injection_assertion_catches_canary_and_steered_labels() -> None:
    clean = _out(relevant=True, **FIRE)
    assert news_eval.assert_injection(clean, _ctx(FIRE, injection_canary="PWNED-1"))["pass"]
    leaked = _out(relevant=True, **{**FIRE, "summary": "pwned-1"})
    assert not news_eval.assert_injection(leaked, _ctx(FIRE, injection_canary="PWNED-1"))["pass"]
    # The canary is checked on the raw output, so it counts even if post-check dropped the event.
    dropped = _out(relevant=False, impact_type="other", direction=0, severity=1, summary="PWNED-1")
    ctx = _ctx(None, relevant=False, injection_canary="PWNED-1")
    assert not news_eval.assert_injection(dropped, ctx)["pass"]
    steered = {"impact_type": "restoration", "direction": 1, "severity": 5}
    assert not news_eval.assert_injection(_out(relevant=True, **steered), _ctx(steered))["pass"]
    inflated = {**FIRE, "severity": 5}
    result = news_eval.assert_injection(_out(relevant=True, **inflated), _ctx(inflated, severity=3))
    assert not result["pass"] and "severity" in result["reason"]


def test_first_try_assertion_reads_provider_metadata() -> None:
    ok = {"providerResponse": {"metadata": {"attempts": 1, "degraded": False}}}
    retried = {"providerResponse": {"metadata": {"attempts": 2, "degraded": False}}}
    assert news_eval.assert_first_try("{}", ok)["pass"]
    assert not news_eval.assert_first_try("{}", retried)["pass"]
    assert not news_eval.assert_first_try("{}", {})["pass"]


def test_summarise_counts_errored_rows_as_failures() -> None:
    summarize = _load("summarize", EVALS_DIR / "summarize.py")
    relevant = next(i for i in ITEMS if i["relevant"] and not i["injection"])
    irrelevant = next(i for i in ITEMS if not i["relevant"] and not i["injection"])
    passed = [
        {"assertion": {"metric": a["metric"]}, "pass": True, "reason": "ok"}
        for a in news_eval.build_test(irrelevant)["assert"]
    ]
    data = {
        "results": {
            "results": [
                {
                    "provider": {"id": "p", "label": "nano"},
                    "vars": {"id": irrelevant["id"]},
                    "success": True,
                    "response": {"output": "{}", "metadata": {"latency_ms": 10}},
                    "gradingResult": {"componentResults": passed},
                },
                {
                    "provider": {"id": "p", "label": "nano"},
                    "vars": {"id": relevant["id"]},
                    "success": False,
                    "failureReason": 2,
                    "response": {"error": "BudgetExceeded: eval budget"},
                    "gradingResult": None,
                },
            ]
        }
    }
    stats = summarize.summarise(data, ITEMS)["nano"]
    assert stats["errors"] == 1 and stats["tests"] == 2 and stats["passed"] == 1
    assert stats["metrics"]["relevance"] == [1, 2]
    assert stats["metrics"]["impact_type"] == [0, 1], "errored relevant item fails label metrics"
    table = summarize.render({"nano": stats})
    assert "| nano | 1/2 | 1 |" in table and "provider error" in table


class _FakeTransport:
    def __init__(self, content: str) -> None:
        self.content = content
        self.requests: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        message = SimpleNamespace(content=self.content, tool_calls=None, model_extra={})
        usage = SimpleNamespace(prompt_tokens=600, completion_tokens=90)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


@pytest.fixture
def provider() -> Iterator[tuple[ModuleType, _FakeTransport]]:
    module = _load("news_scout_provider", EVALS_DIR / "providers" / "news_scout_provider.py")
    settings = Settings(_env_file=None, model_fast=NANO, llm_budget_usd=20.0)
    fake = _FakeTransport(_out(relevant=True, impact_type="pollution", direction=-1, severity=3))
    ledger = module.MemoryCallLog(module.Decimal("0.01"))
    module._RUNTIMES["memory"] = module.make_runtime(settings, fake, ledger)
    yield module, fake
    module._RUNTIMES.pop("memory", None)


def test_provider_runs_real_news_scout_path_and_caches(
    provider: tuple[ModuleType, _FakeTransport], tmp_path: Path
) -> None:
    module, fake = provider
    item = next(i for i in ITEMS if i["injection"] and i["relevant"])
    variables = news_eval.build_test(item)["vars"]
    first = module.classify(variables, tier=Tier.FAST, call_log="memory", cache_dir=tmp_path)
    again = module.classify(variables, tier=Tier.FAST, call_log="memory", cache_dir=tmp_path)

    assert len(fake.requests) == 1, "second call is served from the transport cache"
    request = fake.requests[0]
    prompt = request["messages"][1]["content"]
    assert "<untrusted_content>" in prompt
    assert item["injection_canary"] not in prompt, "T72 cuts the injected text before the model"
    assert "chinampa restoration zone" in prompt, "the real event is still sent"
    assert request["response_format"]["json_schema"]["strict"] is True
    assert first["tokenUsage"]["prompt"] == 600 and first["cost"] > 0
    assert first["metadata"]["attempts"] == 1 and first["metadata"]["model"] == NANO
    assert first["metadata"]["post_checked"][0]["url"] == item["url"]
    assert again["cached"] is True and again["cost"] == 0.0
    assert again["output"] == first["output"]
    assert again["metadata"]["cost_usd"] == first["metadata"]["cost_usd"] > 0
    assert again["metadata"]["prompt_tokens"] == 600


def test_provider_cache_misses_when_messages_change(
    provider: tuple[ModuleType, _FakeTransport], tmp_path: Path
) -> None:
    module, fake = provider
    variables = news_eval.build_test(ITEMS[0])["vars"]
    changed = {**variables, "content": variables["content"] + " Update: more debris found."}
    module.classify(variables, tier=Tier.FAST, call_log="memory", cache_dir=tmp_path)
    second = module.classify(changed, tier=Tier.FAST, call_log="memory", cache_dir=tmp_path)
    assert len(fake.requests) == 2
    assert second["cached"] is False
    base = {k: v for k, v in fake.requests[0].items() if k != "timeout"}
    tweaked = {**base, "temperature": 0.5}
    assert module.transport_cache_key(base) != module.transport_cache_key(tweaked)
    assert module.transport_cache_key(base) == module.transport_cache_key({**base, "timeout": 1.0})

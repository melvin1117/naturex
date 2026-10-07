"""News Scout eval dataset and promptfoo helpers (T25). Offline: no network, no database."""

from __future__ import annotations

import importlib.util
import json
from collections import Counter
from datetime import date
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from app.agents.news_scout import NewsScoutClassificationOutput
from app.config import Settings
from app.llm import LLMClient, Tier
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
    assert "needs human review" in item["labelled_by"]
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


def _ctx(**expected: Any) -> dict[str, Any]:
    base = {
        "relevant": True,
        "impact_type": "fire",
        "direction": -1,
        "severity": 3,
        "injection_canary": None,
    }
    return {"config": {"expected": {**base, **expected}}}


def test_assertions_score_labels() -> None:
    good = _out(relevant=True, impact_type="fire", direction=-1, severity=4)
    assert news_eval.assert_relevance(good, _ctx())["pass"]
    assert news_eval.assert_impact_type(good, _ctx())["pass"]
    assert news_eval.assert_direction(good, _ctx())["pass"]
    assert news_eval.assert_severity(good, _ctx())["pass"]
    assert not news_eval.assert_severity(good, _ctx(severity=2))["pass"]
    assert not news_eval.assert_direction(good, _ctx(direction=1))["pass"]
    # No event for the article means "not relevant", as in production.
    assert news_eval.assert_relevance(_out(), _ctx(relevant=False))["pass"]
    assert not news_eval.assert_impact_type(_out(), _ctx())["pass"]
    assert not news_eval.assert_relevance("not json", _ctx())["pass"]


def test_injection_assertion_catches_canary_and_steered_labels() -> None:
    ctx = _ctx(injection_canary="PWNED-1")
    clean = _out(relevant=True, impact_type="fire", direction=-1, severity=3)
    assert news_eval.assert_injection(clean, ctx)["pass"]
    leaked = _out(relevant=True, impact_type="fire", direction=-1, severity=3, summary="pwned-1")
    assert not news_eval.assert_injection(leaked, ctx)["pass"]
    steered = _out(relevant=True, impact_type="restoration", direction=1, severity=5)
    assert not news_eval.assert_injection(steered, ctx)["pass"]


def test_first_try_assertion_reads_provider_metadata() -> None:
    ok = {"providerResponse": {"metadata": {"attempts": 1, "degraded": False}}}
    retried = {"providerResponse": {"metadata": {"attempts": 2, "degraded": False}}}
    assert news_eval.assert_first_try("{}", ok)["pass"]
    assert not news_eval.assert_first_try("{}", retried)["pass"]
    assert not news_eval.assert_first_try("{}", {})["pass"]


class _FakeTransport:
    def __init__(self, content: str) -> None:
        self.content = content
        self.requests: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.requests.append(kwargs)
        message = SimpleNamespace(content=self.content, tool_calls=None, model_extra={})
        usage = SimpleNamespace(prompt_tokens=600, completion_tokens=90)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=usage)


def test_provider_runs_real_news_scout_path_and_caches(tmp_path: Path) -> None:
    provider = _load("news_scout_provider", EVALS_DIR / "providers" / "news_scout_provider.py")
    settings = Settings(_env_file=None, model_fast=NANO, llm_budget_usd=20.0)
    transport = _FakeTransport(
        _out(relevant=True, impact_type="pollution", direction=-1, severity=3)
    )
    log = provider.RecordingCallLog(provider.MemoryCallLog(provider.Decimal("0.01")))
    runtime = provider._Runtime(LLMClient(settings, transport, log), log)
    provider._RUNTIMES["memory"] = runtime
    try:
        item = next(i for i in ITEMS if i["injection"] and i["relevant"])
        variables = news_eval.build_test(item)["vars"]
        first = provider.classify(variables, tier=Tier.FAST, call_log="memory", cache_dir=tmp_path)
        again = provider.classify(variables, tier=Tier.FAST, call_log="memory", cache_dir=tmp_path)
    finally:
        provider._RUNTIMES.pop("memory", None)

    assert len(transport.requests) == 1, "second call is served from the provider cache"
    prompt = transport.requests[0]["messages"][1]["content"]
    assert "<untrusted_content>" in prompt and item["injection_canary"] in prompt
    assert first["tokenUsage"]["prompt"] == 600 and first["cost"] > 0
    assert first["metadata"]["attempts"] == 1 and first["metadata"]["model"] == NANO
    assert first["metadata"]["post_checked"][0]["url"] == item["url"]
    assert again["cached"] is True and again["cost"] == 0.0
    assert again["output"] == first["output"]

"""The Tavily credit guard: account-wide credits from `/usage`, cached, fail-open."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import httpx
import pytest

from app.agents.news_scout import NewsScoutAsset, NewsScoutCache, run_news_scout
from app.config import Settings
from app.services.tavily_credits import TavilyCredits, credits_left

USAGE = {"key": {"usage": 47}, "account": {"plan_limit": 1000, "plan_usage": 900}}


def test_credits_left_reads_the_account_plan() -> None:
    assert credits_left(USAGE) == 100
    assert credits_left({"account": {"plan_limit": 1000, "plan_usage": 1200}}) == 0
    assert credits_left({"account": {"plan_limit": None, "plan_usage": 5}}) is None
    assert credits_left({}) is None


def test_the_answer_is_cached_for_a_minute() -> None:
    now = [0.0]
    calls: list[str] = []

    def get(key: str) -> dict[str, Any]:
        calls.append(key)
        return USAGE

    credits = TavilyCredits("tvly-k", get=get, clock=lambda: now[0])
    assert credits.left() == 100
    now[0] = 59.0
    assert credits.left() == 100
    now[0] = 61.0
    credits.left()
    assert calls == ["tvly-k", "tvly-k"]


@pytest.mark.parametrize("failure", [httpx.ConnectError("down"), ValueError("not json")])
def test_an_unknown_balance_never_blocks(failure: Exception) -> None:
    def get(_key: str) -> dict[str, Any]:
        raise failure

    credits = TavilyCredits("tvly-k", get=get)
    assert credits.left() is None
    assert credits.allows(150)


def test_the_guard_closes_below_the_minimum() -> None:
    credits = TavilyCredits("tvly-k", get=lambda _k: USAGE)
    assert credits.allows(100)
    assert not credits.allows(101)


class NoSearch:
    def search(self, *_a: Any, **_k: Any) -> list[Any]:
        raise AssertionError("must not search")


class NoGeocode:
    def reverse(self, *_a: Any) -> Any:
        raise AssertionError("must not geocode")


class Closed:
    def allows(self, minimum_left: int) -> bool:
        return False


def test_news_scout_pauses_without_searching_when_credits_run_low() -> None:
    asset = NewsScoutAsset(UUID(int=1), "Key West", 24.55, -81.76, "US")

    output = run_news_scout(
        asset,
        settings=Settings(_env_file=None, use_mocks=False),
        llm=None,  # type: ignore[arg-type]
        geocoder=NoGeocode(),
        news_search=NoSearch(),
        cache=NewsScoutCache(),
        credits=Closed(),
    )

    assert output.news_paused and output.events == [] and output.searches == []

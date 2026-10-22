"""Tavily credits left on the whole account, from `GET /usage` (every environment counts).

News Scout checks this before it searches, so a dev laptop, a CI run and the deployed demo
share one guard. The answer is cached for a minute. When Tavily can't say (network error, no
plan limit), the guard stays open: Tavily itself refuses requests past the free plan's limit, so
an open guard can never cause a charge.

Source: https://docs.tavily.com/documentation/api-reference/endpoint/usage
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

import httpx

TAVILY_USAGE_URL = "https://api.tavily.com/usage"
USAGE_CACHE_S = 60.0
USAGE_TIMEOUT_S = 5.0

UsageGet = Callable[[str], Mapping[str, Any]]


def _get_usage(api_key: str) -> Mapping[str, Any]:
    with httpx.Client(timeout=USAGE_TIMEOUT_S, follow_redirects=False) as client:
        response = client.get(TAVILY_USAGE_URL, headers={"Authorization": "Bearer " + api_key})
        response.raise_for_status()
        body = response.json()
    if not isinstance(body, dict):
        raise ValueError("expected a JSON object from Tavily /usage")
    return body


def credits_left(body: Mapping[str, Any]) -> int | None:
    """The account's plan credits left (plan limit minus plan usage), or None if unlimited or
    unknown."""
    account = body.get("account")
    if not isinstance(account, Mapping):
        return None
    limit, used = account.get("plan_limit"), account.get("plan_usage")
    if not isinstance(limit, int) or not isinstance(used, int):
        return None
    return max(0, limit - used)


class TavilyCredits:
    def __init__(
        self,
        api_key: str,
        *,
        get: UsageGet = _get_usage,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._api_key = api_key
        self._get = get
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: tuple[float, int | None] | None = None

    def left(self) -> int | None:
        with self._lock:
            now = self._clock()
            if self._cached is not None and now - self._cached[0] < USAGE_CACHE_S:
                return self._cached[1]
            try:
                value = credits_left(self._get(self._api_key))
            except (httpx.HTTPError, ValueError):
                value = None
            self._cached = (now, value)
            return value

    def allows(self, minimum_left: int) -> bool:
        left = self.left()
        return left is None or left >= minimum_left


_SHARED: dict[str, TavilyCredits] = {}
_SHARED_LOCK = threading.Lock()


def shared_credits(api_key: str) -> TavilyCredits:
    """One cached checker per key for the whole process."""
    with _SHARED_LOCK:
        if api_key not in _SHARED:
            _SHARED[api_key] = TavilyCredits(api_key)
        return _SHARED[api_key]

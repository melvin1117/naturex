"""promptfoo Python provider: one labelled article through the real News Scout path (T25).

It builds the prompt with News Scout's own `_messages` (untrusted-content guard included), calls
`LLMClient.structured` with the index-bound classification schema (same retry, validation and
spend logging as production) and runs `_post_check`. The promptfoo prompt text is ignored; the
article comes from the test vars.

Provider config (promptfooconfig.yaml):
  tier:      fast | orchestrator | auditor  -> MODEL_FAST / MODEL_ORCHESTRATOR / MODEL_AUDITOR
  call_log:  db (default: llm_calls in DATABASE_URL, counts against LLM_BUDGET_USD)
             | memory (no database; capped by EVAL_BUDGET_USD, default 0.50)
  NEWS_EVAL_CALL_LOG in the environment overrides call_log.
  cache:     true (default) | false. NEWS_EVAL_CACHE=0 also disables it.

Caching: promptfoo 0.124's own Python-provider cache never hits across runs, because its key
includes per-run vars (`__evalId`). So this provider keeps its own disk cache under
evals/output/cache/news_scout/, keyed by model ID + the exact messages + schema + max_tokens:
a prompt, article or model change misses, an unchanged re-run costs nothing. Cached answers
report cost 0 and keep the original call's tokens, cost and latency in `metadata`.

Docs: https://www.promptfoo.dev/docs/providers/python/ (call_api signature, tokenUsage, cost,
metadata in the response, persistent workers).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from collections.abc import Callable
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

REPO_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import openai  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlmodel import Session  # noqa: E402

from app.agents.news_scout import (  # noqa: E402
    NewsArticle,
    NewsScoutAsset,
    NewsScoutClassificationOutput,
    _max_tokens_for_articles,
    _messages,
    _post_check,
)
from app.config import Settings  # noqa: E402
from app.llm import (  # noqa: E402
    BudgetExceeded,
    CallLog,
    CallRecord,
    DbCallLog,
    LLMClient,
    LLMError,
    OpenAITransport,
    Tier,
)
from app.seed import DEMO_SITES  # noqa: E402

AGENT = "news_scout_eval"
# Bump to invalidate every cached answer (e.g. after changing what the response contains).
CACHE_VERSION = 1
DEFAULT_CACHE_DIR = REPO_DIR / "evals" / "output" / "cache" / "news_scout"
DEFAULT_MEMORY_BUDGET_USD = "0.50"


class MemoryCallLog:
    """In-process spend ledger for runs without Postgres, capped at EVAL_BUDGET_USD."""

    def __init__(self, cap: Decimal) -> None:
        self._cap = cap
        self._costs: dict[int, Decimal] = {}
        self._lock = threading.Lock()

    def spent_usd(self) -> Decimal:
        with self._lock:
            return sum(self._costs.values(), Decimal(0))

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        limit = min(budget, self._cap)
        with self._lock:
            spent = sum(self._costs.values(), Decimal(0))
            if spent + call.cost_usd > limit:
                raise BudgetExceeded(f"eval budget ${limit} would be exceeded (spent ${spent:.4f})")
            handle = len(self._costs) + 1
            self._costs[handle] = call.cost_usd
            return handle

    def settle(self, handle: int, call: CallRecord) -> None:
        with self._lock:
            self._costs[handle] = call.cost_usd


class RecordingCallLog:
    """Forwards to the real ledger and remembers settled attempts, so the provider can report
    tokens and cost to promptfoo (LLMResult doesn't carry usage)."""

    def __init__(self, inner: CallLog) -> None:
        self._inner = inner
        self.settled: list[CallRecord] = []

    def spent_usd(self) -> Decimal:
        return self._inner.spent_usd()

    def reserve(self, call: CallRecord, budget: Decimal) -> int:
        return self._inner.reserve(call, budget)

    def settle(self, handle: int, call: CallRecord) -> None:
        self._inner.settle(handle, call)
        self.settled.append(call)


# A plain class, not a dataclass: promptfoo loads this file without registering it in
# sys.modules, which breaks @dataclass's annotation lookup.
class _Runtime:
    def __init__(self, client: LLMClient, log: RecordingCallLog) -> None:
        self.client = client
        self.log = log
        self.lock = threading.Lock()


_RUNTIMES: dict[str, _Runtime] = {}
_RUNTIMES_LOCK = threading.Lock()


def _settings() -> Settings:
    # Absolute env files: promptfoo's worker cwd isn't backend/, where Settings' defaults look.
    return Settings(_env_file=(REPO_DIR / ".env", BACKEND_DIR / ".env"))


def _runtime(call_log: str) -> _Runtime:
    with _RUNTIMES_LOCK:
        cached = _RUNTIMES.get(call_log)
        if cached is not None:
            return cached
        settings = _settings()
        if not settings.nebius_api_key:
            raise LLMError("NEBIUS_API_KEY is empty; put it in the repo-root .env")
        inner: CallLog
        if call_log == "db":
            engine = create_engine(settings.database_url, pool_pre_ping=True)
            factory: Callable[[], Session] = lambda: Session(engine)  # noqa: E731
            inner = DbCallLog(factory)
        elif call_log == "memory":
            cap = Decimal(os.environ.get("EVAL_BUDGET_USD", DEFAULT_MEMORY_BUDGET_USD))
            inner = MemoryCallLog(cap)
        else:
            raise ValueError(f"call_log must be 'db' or 'memory', not {call_log!r}")
        sdk = openai.OpenAI(
            base_url=settings.token_factory_base_url,
            api_key=settings.nebius_api_key,
            max_retries=0,
        )
        log = RecordingCallLog(inner)
        runtime = _Runtime(LLMClient(settings, OpenAITransport(sdk), log), log)
        _RUNTIMES[call_log] = runtime
        return runtime


def _asset(site_key: str) -> NewsScoutAsset:
    for site in DEMO_SITES:
        if site.key == site_key:
            return NewsScoutAsset(
                id=site.id,
                name=site.name,
                centroid_lat=site.centroid_lat,
                centroid_lon=site.centroid_lon,
                country=site.country,
            )
    raise ValueError(f"unknown site {site_key!r}")


def _article(variables: dict[str, Any]) -> NewsArticle:
    published = variables.get("published_at")
    return NewsArticle(
        title=str(variables["title"]),
        url=str(variables["url"]),
        published_at=date.fromisoformat(str(published)) if published else None,
        content=str(variables["content"]),
        raw_content=None,
        score=1.0,
    )


def _cache_key(model: str, messages: list[dict[str, Any]], max_tokens: int) -> str:
    payload = {
        "v": CACHE_VERSION,
        "model": model,
        "messages": messages,
        "schema": NewsScoutClassificationOutput.model_json_schema(),
        "max_tokens": max_tokens,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _cache_read(cache_dir: Path | None, key: str) -> dict[str, Any] | None:
    if cache_dir is None:
        return None
    path = cache_dir / f"{key}.json"
    if not path.is_file():
        return None
    response: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    usage = response.get("tokenUsage") or {}
    response["cached"] = True
    response["tokenUsage"] = {"cached": usage.get("total", 0), "total": usage.get("total", 0)}
    response["cost"] = 0.0
    response.setdefault("metadata", {})["cached"] = True
    return response


def _cache_write(cache_dir: Path | None, key: str, response: dict[str, Any]) -> None:
    if cache_dir is None:
        return
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp = cache_dir / f"{key}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(response, ensure_ascii=False), encoding="utf-8")
    tmp.replace(cache_dir / f"{key}.json")


def classify(
    variables: dict[str, Any],
    *,
    tier: Tier,
    call_log: str = "db",
    cache_dir: Path | None = DEFAULT_CACHE_DIR,
) -> dict[str, Any]:
    """Classify one article; returns a promptfoo ProviderResponse dict."""
    runtime = _runtime(call_log)
    asset = _asset(str(variables["site"]))
    article = _article(variables)
    messages = _messages(asset, str(variables["place"]), [article])
    max_tokens = _max_tokens_for_articles(1)
    key = _cache_key(runtime.client.model_for(tier), messages, max_tokens)
    cached = _cache_read(cache_dir, key)
    if cached is not None:
        return cached

    with runtime.lock:
        first = len(runtime.log.settled)
        started = time.perf_counter()
        try:
            result = runtime.client.structured(
                agent=AGENT,
                tier=tier,
                messages=messages,
                schema=NewsScoutClassificationOutput,
                max_tokens=max_tokens,
                asset_id=asset.id,
            )
            error: str | None = None
        except LLMError as exc:
            error = str(exc)
        latency_ms = int((time.perf_counter() - started) * 1000)
        attempts = runtime.log.settled[first:]

    prompt_tokens = sum(a.prompt_tokens for a in attempts)
    completion_tokens = sum(a.completion_tokens for a in attempts)
    usage = {
        "total": prompt_tokens + completion_tokens,
        "prompt": prompt_tokens,
        "completion": completion_tokens,
        "numRequests": len(attempts),
    }
    cost = float(sum((a.cost_usd for a in attempts), Decimal(0)))
    if error is not None:
        return {"error": error, "tokenUsage": usage, "cost": cost}

    kept = _post_check(result.value.events, [article], today=date.today)
    response: dict[str, Any] = {
        "output": result.value.model_dump_json(),
        "tokenUsage": usage,
        "cost": cost,
        "metadata": {
            "model": result.model,
            "tier": result.tier.value,
            "degraded": result.degraded,
            "attempts": result.attempts,
            "latency_ms": latency_ms,
            "cost_usd": cost,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "post_checked": [item.model_dump(mode="json") for item in kept],
        },
    }
    _cache_write(cache_dir, key, response)
    return response


def call_api(prompt: str, options: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    config = options.get("config") or {}
    tier = Tier(str(config.get("tier", Tier.FAST.value)))
    call_log = os.environ.get("NEWS_EVAL_CALL_LOG") or str(config.get("call_log", "db"))
    use_cache = bool(config.get("cache", True)) and os.environ.get("NEWS_EVAL_CACHE", "1") != "0"
    try:
        return classify(
            context["vars"],
            tier=tier,
            call_log=call_log,
            cache_dir=DEFAULT_CACHE_DIR if use_cache else None,
        )
    except Exception as exc:  # promptfoo shows `error`; a crash would hide which test failed
        return {"error": f"{type(exc).__name__}: {exc}"}

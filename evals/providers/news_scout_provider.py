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
includes per-run vars (`__evalId`). So this provider caches at the transport level instead:
`CachingTransport` wraps the Token Factory transport and keys each answer on the exact
`chat.completions.create` payload (model, messages including LLMClient's schema instruction,
response_format, temperature, max_tokens, extra_body), minus `timeout`. Any change to the
News Scout prompt, the article, the model or llm.py's request misses; an unchanged re-run makes
no API call. Only the attempt LLMClient accepted is stored, so an invalid answer is never
replayed into a retry. A cached answer still goes through LLMClient (validation, `llm_calls`
row with 0 tokens and $0) and reports cost 0 to promptfoo; the original call's tokens, cost and
latency stay in `metadata`. Files live in evals/output/cache/news_scout/ (git-ignored).

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
from types import SimpleNamespace
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
    ChatTransport,
    DbCallLog,
    LLMClient,
    LLMError,
    OpenAITransport,
    Tier,
    cost_usd,
)
from app.seed import DEMO_SITES  # noqa: E402

AGENT = "news_scout_eval"
# Bump to invalidate every cached answer (e.g. after changing what a cache file holds).
CACHE_VERSION = 2
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


class TransportCall:
    """One `create()` seen by CachingTransport, with the original call's usage and latency."""

    def __init__(
        self,
        *,
        model: str,
        cached: bool,
        prompt_tokens: int,
        completion_tokens: int,
        latency_ms: int,
    ) -> None:
        self.model = model
        self.cached = cached
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.latency_ms = latency_ms


def transport_cache_key(request: dict[str, Any]) -> str:
    payload = {key: value for key, value in request.items() if key != "timeout"}
    blob = json.dumps({"v": CACHE_VERSION, "request": payload}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


class CachingTransport:
    """Disk cache in front of a ChatTransport, keyed on the exact request payload."""

    def __init__(self, inner: ChatTransport, cache_dir: Path | None = None) -> None:
        self._inner = inner
        self.cache_dir = cache_dir
        self.calls: list[TransportCall] = []
        self._pending: list[tuple[str, dict[str, Any]]] = []

    def create(self, **kwargs: Any) -> Any:
        key = transport_cache_key(kwargs)
        model = str(kwargs.get("model", ""))
        path = self.cache_dir / f"{key}.json" if self.cache_dir else None
        if path is not None and path.is_file():
            record = json.loads(path.read_text(encoding="utf-8"))
            self.calls.append(
                TransportCall(
                    model=model,
                    cached=True,
                    prompt_tokens=int(record["prompt_tokens"]),
                    completion_tokens=int(record["completion_tokens"]),
                    latency_ms=int(record["latency_ms"]),
                )
            )
            message = SimpleNamespace(content=record["content"], tool_calls=None, model_extra={})
            # Zero usage: LLMClient logs the replay at $0 instead of charging the budget again.
            no_usage = SimpleNamespace(prompt_tokens=0, completion_tokens=0)
            return SimpleNamespace(choices=[SimpleNamespace(message=message)], usage=no_usage)

        started = time.perf_counter()
        completion = self._inner.create(**kwargs)
        latency_ms = int((time.perf_counter() - started) * 1000)
        usage = getattr(completion, "usage", None)
        prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        self.calls.append(
            TransportCall(
                model=model,
                cached=False,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                latency_ms=latency_ms,
            )
        )
        try:
            content = completion.choices[0].message.content
        except (AttributeError, IndexError):
            content = None
        if isinstance(content, str):
            self._pending.append(
                (
                    key,
                    {
                        "model": model,
                        "content": content,
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "latency_ms": latency_ms,
                    },
                )
            )
        return completion

    def commit_last(self) -> None:
        """Store only the attempt LLMClient accepted (the last one), then forget the rest."""
        pending, self._pending = self._pending, []
        if self.cache_dir is None or not pending:
            return
        key, record = pending[-1]
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_dir / f"{key}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.cache_dir / f"{key}.json")

    def discard(self) -> None:
        self._pending = []


# A plain class, not a dataclass: promptfoo loads this file without registering it in
# sys.modules, which breaks @dataclass's annotation lookup.
class _Runtime:
    def __init__(self, client: LLMClient, log: RecordingCallLog, transport: CachingTransport):
        self.client = client
        self.log = log
        self.transport = transport
        self.lock = threading.Lock()


def make_runtime(settings: Settings, transport: ChatTransport, call_log: CallLog) -> _Runtime:
    caching = CachingTransport(transport)
    log = RecordingCallLog(call_log)
    return _Runtime(LLMClient(settings, caching, log), log, caching)


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
        runtime = make_runtime(settings, OpenAITransport(sdk), inner)
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
    with runtime.lock:
        transport = runtime.transport
        transport.cache_dir = cache_dir
        first_settled = len(runtime.log.settled)
        first_call = len(transport.calls)
        try:
            result = runtime.client.structured(
                agent=AGENT,
                tier=tier,
                messages=messages,
                schema=NewsScoutClassificationOutput,
                max_tokens=_max_tokens_for_articles(1),
                asset_id=asset.id,
            )
            error: str | None = None
            transport.commit_last()
        except LLMError as exc:
            error = str(exc)
            transport.discard()
        settled = runtime.log.settled[first_settled:]
        calls = transport.calls[first_call:]

    # What this run spent (0 for replays) vs. what the answer cost when it was first made.
    live_prompt = sum(a.prompt_tokens for a in settled)
    live_completion = sum(a.completion_tokens for a in settled)
    live_cost = float(sum((a.cost_usd for a in settled), Decimal(0)))
    orig_prompt = sum(c.prompt_tokens for c in calls)
    orig_completion = sum(c.completion_tokens for c in calls)
    orig_cost = float(
        sum(
            (cost_usd(c.model, c.prompt_tokens, c.completion_tokens) for c in calls),
            Decimal(0),
        )
    )
    all_cached = bool(calls) and all(c.cached for c in calls)
    usage: dict[str, int] = (
        {"cached": orig_prompt + orig_completion, "total": orig_prompt + orig_completion}
        if all_cached
        else {
            "total": live_prompt + live_completion,
            "prompt": live_prompt,
            "completion": live_completion,
            "numRequests": sum(1 for c in calls if not c.cached),
        }
    )
    if error is not None:
        return {"error": error, "tokenUsage": usage, "cost": live_cost}

    kept = _post_check(result.value.events, [article], today=date.today)
    return {
        "output": result.value.model_dump_json(),
        "tokenUsage": usage,
        "cost": live_cost,
        "cached": all_cached,
        "metadata": {
            "model": result.model,
            "tier": result.tier.value,
            "degraded": result.degraded,
            "attempts": result.attempts,
            "cached": all_cached,
            "latency_ms": sum(c.latency_ms for c in calls),
            "cost_usd": orig_cost,
            "prompt_tokens": orig_prompt,
            "completion_tokens": orig_completion,
            "post_checked": [item.model_dump(mode="json") for item in kept],
        },
    }


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

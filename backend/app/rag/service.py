"""Copilot request flow (T39): rate limit → visible assets → lazy index → retrieve → answer.

The router stays thin: `prepare` runs in a dependency, before the SSE response starts, so its
refusals are ordinary HTTP errors (429, 503); the answer is written while streaming.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, text
from sqlmodel import Session, col, select

from app.authz import Actor
from app.config import Settings
from app.db import engine
from app.llm import LLMClient, get_llm_client
from app.models import CopilotQuestion, LlmCall
from app.rag.answer import COPILOT_AGENT, Source
from app.rag.embed import EMBED_AGENT, Embedder, HashEmbedder, LlmEmbedder
from app.rag.index import IndexStats, index_assets
from app.rag.retrieve import retrieve, visible_assets

RATE_WINDOW = timedelta(hours=1)
COPILOT_AGENTS = (COPILOT_AGENT, EMBED_AGENT)


class CopilotRateLimited(RuntimeError):
    """The account or the world used its hourly Copilot questions or calls."""


class CopilotUnavailable(RuntimeError):
    """Spending would cut into LLM_RESERVE_USD, kept for Time Machine and listings."""


@dataclass(frozen=True, slots=True)
class CopilotModels:
    embedder: Embedder
    llm: LLMClient | None
    """None: answers are extractive (USE_MOCKS=true)."""


def copilot_models(
    settings: Settings, session_factory: Callable[[], Session] = lambda: Session(engine)
) -> CopilotModels:
    """Token Factory models (raises `ModelNotConfigured` without a key or `MODEL_EMBED`), or
    the deterministic stand-ins under USE_MOCKS=true."""
    if settings.use_mocks:
        return CopilotModels(HashEmbedder(), None)
    client = get_llm_client(settings, session_factory)
    return CopilotModels(LlmEmbedder(client), client)


@dataclass(frozen=True, slots=True)
class PreparedQuestion:
    question: str
    world_id: UUID
    asset_id: UUID | None
    sources: list[Source]
    llm: LLMClient | None
    indexed: IndexStats


# Advisory-lock namespace for the Copilot's rate limits (namespace, hash of the world ID).
RATE_LOCK_NAMESPACE = 0x4E585251


def reserve_question(
    session: Session, world_id: UUID, user_id: UUID | None, settings: Settings, now: datetime
) -> None:
    """Check the hourly limits and record the question, atomically: the check and the insert
    run under a per-world transaction lock (held for two counts and an insert), so concurrent
    questions can't all pass the last free slot. Commits; raises CopilotRateLimited."""
    session.execute(
        text("SELECT pg_advisory_xact_lock(:ns, hashtext(:world))"),
        {"ns": RATE_LOCK_NAMESPACE, "world": str(world_id)},
    )
    since = now - RATE_WINDOW
    asked = session.exec(
        select(func.count())
        .select_from(CopilotQuestion)
        .where(CopilotQuestion.world_id == world_id, CopilotQuestion.created_at >= since)
    ).one()
    by_user = (
        0
        if user_id is None
        else session.exec(
            select(func.count())
            .select_from(CopilotQuestion)
            .where(CopilotQuestion.user_id == user_id, CopilotQuestion.created_at >= since)
        ).one()
    )
    calls = session.exec(
        select(func.count())
        .select_from(LlmCall)
        .where(
            LlmCall.world_id == world_id,
            col(LlmCall.agent).in_(COPILOT_AGENTS),
            LlmCall.created_at >= since,
        )
    ).one()
    if (
        by_user >= settings.copilot_questions_per_user_per_hour
        or asked >= settings.copilot_questions_per_world_per_hour
        or calls >= settings.copilot_calls_per_world_per_hour
    ):
        session.rollback()
        raise CopilotRateLimited
    if user_id is not None:
        session.add(CopilotQuestion(world_id=world_id, user_id=user_id, created_at=now))
    session.commit()


def check_reserve(llm: LLMClient, settings: Settings) -> None:
    """Like API-triggered rating runs (`rating_runs`), the Copilot leaves `LLM_RESERVE_USD`."""
    reserve = Decimal(str(settings.llm_reserve_usd))
    if reserve <= 0:
        return
    remaining = Decimal(str(settings.llm_budget_usd)) - llm.spent_usd()
    if remaining < reserve:
        raise CopilotUnavailable


def prepare(
    session: Session,
    actor: Actor | None,
    world_id: UUID,
    question: str,
    asset_id: UUID | None,
    models: CopilotModels,
    settings: Settings,
    now: datetime | None = None,
) -> PreparedQuestion:
    """Everything before the answer. Raises CopilotRateLimited, CopilotUnavailable (the budget
    reserve), or LLMError when the question can't be embedded. Commits, which also returns the
    DB connection to the pool before the (slower) answer streams. With real models only: the
    mocks spend nothing."""
    if models.llm is not None:
        check_reserve(models.llm, settings)
        user_id = actor.user_id if actor is not None else None
        reserve_question(session, world_id, user_id, settings, now or datetime.now(UTC))
    assets = visible_assets(session, actor, world_id, asset_id)
    names = {a.id: a.name for a in assets}
    stats = index_assets(session, world_id, assets, models.embedder)
    session.commit()
    sources: list[Source] = []
    if names:
        vector = models.embedder.embed([question], purpose="query", world_id=world_id)[0]
        sources = retrieve(
            session,
            world_id,
            names,
            models.embedder.model,
            vector,
            min_similarity=models.embedder.min_similarity,
        )
        session.commit()
    return PreparedQuestion(question, world_id, asset_id, sources, models.llm, stats)

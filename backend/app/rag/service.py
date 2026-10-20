"""Copilot request flow (T39): rate limit → visible assets → lazy index → retrieve → answer.

The router stays thin: `prepare` runs in a dependency, before the SSE response starts, so its
refusals are ordinary HTTP errors (429, 503); the answer is written while streaming.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, select

from app.authz import Actor
from app.config import Settings
from app.db import engine
from app.llm import LLMClient, get_llm_client
from app.models import LlmCall
from app.rag.answer import COPILOT_AGENT, Source
from app.rag.embed import Embedder, HashEmbedder, LlmEmbedder
from app.rag.index import IndexStats, index_assets
from app.rag.retrieve import retrieve, visible_assets

RATE_WINDOW = timedelta(hours=1)


class CopilotRateLimited(RuntimeError):
    """The world used its hourly Copilot model calls."""


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


def check_rate_limit(session: Session, world_id: UUID, settings: Settings, now: datetime) -> None:
    used = session.exec(
        select(func.count())
        .select_from(LlmCall)
        .where(
            LlmCall.world_id == world_id,
            LlmCall.agent == COPILOT_AGENT,
            LlmCall.created_at >= now - RATE_WINDOW,
        )
    ).one()
    if used >= settings.copilot_calls_per_world_per_hour:
        raise CopilotRateLimited


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
    """Everything before the answer. Raises CopilotRateLimited, or LLMError when the question
    can't be embedded. Commits the index, which also returns the DB connection to the pool
    before the (slower) answer streams."""
    if models.llm is not None:
        check_rate_limit(session, world_id, settings, now or datetime.now(UTC))
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

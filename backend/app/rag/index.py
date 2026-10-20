"""The per-world Copilot index (T39): idempotent, lazy, budget-aware, short locks.

`index_assets` brings `doc_chunks` up to date for some assets of one world just before a
question is answered: each asset's latest `REPORTS_PER_ASSET` reports and `EVENTS_PER_ASSET`
news events are chunked (`rag.chunking`), and the stored chunks are reconciled chunk by chunk
(source, seq, hash, embedding model): unchanged chunks stay, changed or out-of-window ones are
deleted. A vector already computed for the same text and model (in any world: sandbox copies
share their template's text) is reused, so only new text is embedded.

1. Claim, briefly, under a per-world advisory lock taken with `pg_try_advisory_xact_lock` and a
   short wait (`LOCK_WAIT_S`; if another request holds it longer, this one skips indexing and
   answers from what is indexed): delete stale rows, insert reusable vectors, and insert the
   rest (at most `MAX_EMBED_PER_REQUEST`) as claims, rows without an embedding. Commit.
2. Embed outside any lock or transaction, batch by batch, committing each batch's vectors, so a
   later failure (no key, provider down, `LLM_BUDGET_USD` reached) keeps the batches already
   paid for. Unfilled claims of a failed run are deleted; a claim left by a crashed request is
   retried after `CLAIM_TTL`. Another request meanwhile sees the fresh claims and doesn't embed
   the same chunks again. Retrieval ignores claims (NULL embedding).
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, text, update
from sqlalchemy import select as sa_select
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, col, select

from app.llm import LLMError
from app.models import Asset, ChunkSource, DocChunk, Event, Report
from app.rag.chunking import ChunkDraft, EventFacts, ReportFacts, event_chunks, report_chunks
from app.rag.embed import EMBED_BATCH, Embedder

log = logging.getLogger(__name__)

REPORTS_PER_ASSET = 5
EVENTS_PER_ASSET = 20
# Advisory-lock namespace for indexing (two-key form: namespace, hash of the world ID).
INDEX_LOCK_NAMESPACE = 0x4E585247
# Wait at most this long for another request's claim step (which takes milliseconds).
LOCK_WAIT_S = 2.0
# New chunks embedded per question (3 requests of 32); the rest wait for the next question.
MAX_EMBED_PER_REQUEST = 96
# A claim (row without an embedding) older than this was left by a failed request.
CLAIM_TTL = timedelta(minutes=5)


@dataclass(frozen=True, slots=True)
class SourceDraft:
    kind: ChunkSource
    source_id: UUID
    asset_id: UUID
    chunks: tuple[ChunkDraft, ...]


@dataclass(frozen=True, slots=True)
class IndexStats:
    added: int = 0
    removed: int = 0
    embedded: int = 0
    reused: int = 0
    skipped: int = 0
    """Chunks left for a later question: over `MAX_EMBED_PER_REQUEST`, or embedding failed."""
    busy: bool = False
    """Another request held the world's index lock; nothing was written."""


def _latest(
    session: Session, model: Any, world_id: UUID, asset_ids: Sequence[UUID], order: Any, n: int
) -> list[Any]:
    """Each asset's newest `n` rows of `model` (a window function, one query)."""
    rank = func.row_number().over(partition_by=model.asset_id, order_by=order).label("rank")
    ranked = (
        select(model.id.label("id"), rank)
        .where(model.world_id == world_id, col(model.asset_id).in_(asset_ids))
        .subquery()
    )
    ids = select(ranked.c.id).where(ranked.c.rank <= n)
    return list(session.exec(select(model).where(col(model.id).in_(ids))).all())


def report_facts(report: Report, asset: Asset, previous: Report | None) -> ReportFacts:
    stored: dict[str, Any] = report.auditor_json or {}
    rating: dict[str, Any] = stored.get("rating") or {}
    metrics: dict[str, Any] = rating.get("metrics") or {}
    return ReportFacts(
        asset_name=asset.name,
        version=report.version,
        issued=report.created_at.date() if report.created_at else None,
        data_version=metrics.get("data_version"),
        period=rating.get("period"),
        simulated=bool(metrics.get("simulated", False)),
        health_score=report.health_score,
        grade=report.grade,
        confidence=report.confidence,
        value_low=report.value_low,
        value_mid=report.value_mid,
        value_high=report.value_high,
        fair_value_per_share=report.fair_value_per_share,
        previous_version=previous.version if previous else None,
        previous_health=previous.health_score if previous else None,
        previous_grade=previous.grade if previous else None,
        flags=tuple(report.flags or ()),
        recommendations=tuple(str(r) for r in report.recommendations or ()),
        summary_md=report.summary_md,
    )


def event_facts(event: Event, asset: Asset) -> EventFacts:
    return EventFacts(
        asset_name=asset.name,
        source=event.source.value,
        title=event.title,
        summary=event.summary,
        impact_type=event.impact_type,
        direction=event.direction,
        severity=event.severity,
        published_at=event.published_at,
        recorded=event.created_at.date() if event.created_at else None,
    )


def desired_sources(session: Session, world_id: UUID, assets: Sequence[Asset]) -> list[SourceDraft]:
    """The chunks each asset's indexed reports and events should have now."""
    if not assets:
        return []
    by_id = {a.id: a for a in assets}
    ids = list(by_id)
    # One extra report per asset, so the oldest indexed one still knows its predecessor.
    reports = _latest(
        session, Report, world_id, ids, col(Report.version).desc(), REPORTS_PER_ASSET + 1
    )
    events = _latest(
        session,
        Event,
        world_id,
        ids,
        (col(Event.created_at).desc(), col(Event.id).desc()),
        EVENTS_PER_ASSET,
    )
    sources: list[SourceDraft] = []
    per_asset: dict[UUID, list[Report]] = defaultdict(list)
    for report in reports:
        per_asset[report.asset_id].append(report)
    for asset_id, rows in per_asset.items():
        rows.sort(key=lambda r: r.version, reverse=True)
        for i, report in enumerate(rows[:REPORTS_PER_ASSET]):
            previous = rows[i + 1] if i + 1 < len(rows) else None
            chunks = report_chunks(report_facts(report, by_id[asset_id], previous))
            sources.append(SourceDraft(ChunkSource.REPORT, report.id, asset_id, tuple(chunks)))
    for event in events:
        chunks = event_chunks(event_facts(event, by_id[event.asset_id]))
        sources.append(SourceDraft(ChunkSource.EVENT, event.id, event.asset_id, tuple(chunks)))
    return sources


def _try_lock_world(
    session: Session,
    world_id: UUID,
    wait_s: float,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """The world's index lock for this transaction, polling `pg_try_advisory_xact_lock` for at
    most `wait_s`, so a waiter never blocks behind a slow request."""
    deadline = time.monotonic() + wait_s
    while True:
        got = session.execute(
            text("SELECT pg_try_advisory_xact_lock(:ns, hashtext(:world))"),
            {"ns": INDEX_LOCK_NAMESPACE, "world": str(world_id)},
        ).scalar_one()
        if got:
            return True
        if time.monotonic() >= deadline:
            return False
        sleep(0.05)


def _reusable_vectors(session: Session, model: str, hashes: set[str]) -> dict[str, list[float]]:
    if not hashes:
        return {}
    rows = session.exec(
        select(DocChunk.content_sha256, DocChunk.embedding)
        .where(
            DocChunk.embed_model == model,
            col(DocChunk.content_sha256).in_(hashes),
            col(DocChunk.embedding).is_not(None),
        )
        .distinct(col(DocChunk.content_sha256))
    ).all()
    return {sha: [float(x) for x in vector] for sha, vector in rows if vector is not None}


def _row(source: SourceDraft, chunk: ChunkDraft, world_id: UUID, model: str) -> DocChunk:
    return DocChunk(
        world_id=world_id,
        asset_id=source.asset_id,
        source_kind=source.kind,
        report_id=source.source_id if source.kind is ChunkSource.REPORT else None,
        event_id=source.source_id if source.kind is ChunkSource.EVENT else None,
        seq=chunk.seq,
        content=chunk.content,
        content_sha256=chunk.sha256,
        embed_model=model,
    )


@dataclass(frozen=True, slots=True)
class _Claims:
    rows: dict[str, list[UUID]]
    """Claimed row IDs by content hash (identical text is embedded once)."""
    texts: dict[str, str]
    added: int
    removed: int
    reused: int
    over_cap: int


def _claim(
    session: Session,
    world_id: UUID,
    asset_ids: Sequence[UUID],
    desired: Sequence[SourceDraft],
    model: str,
    now: datetime,
    max_embed: int,
) -> _Claims:
    """Step 1, under the lock: reconcile and claim. The caller commits."""
    existing = session.execute(
        sa_select(
            col(DocChunk.id),
            col(DocChunk.report_id),
            col(DocChunk.event_id),
            col(DocChunk.seq),
            col(DocChunk.content_sha256),
            col(DocChunk.embed_model),
            col(DocChunk.embedding).is_not(None),
            col(DocChunk.created_at),
        ).where(col(DocChunk.world_id) == world_id, col(DocChunk.asset_id).in_(asset_ids))
    ).all()
    want = {(s.source_id, c.seq): (s, c) for s in desired for c in s.chunks}
    kept: set[tuple[UUID, int]] = set()
    stale: list[UUID] = []
    for row_id, report_id, event_id, seq, sha, row_model, has_vector, created_at in existing:
        key = (report_id or event_id, seq)
        target = want.get(key)
        fresh_claim = has_vector or created_at >= now - CLAIM_TTL
        if target is None or target[1].sha256 != sha or row_model != model or not fresh_claim:
            stale.append(row_id)
        else:
            kept.add(key)
    if stale:
        session.execute(delete(DocChunk).where(col(DocChunk.id).in_(stale)))

    pending = [pair for key, pair in want.items() if key not in kept]
    vectors = _reusable_vectors(session, model, {c.sha256 for _, c in pending})
    rows: dict[str, list[UUID]] = defaultdict(list)
    texts: dict[str, str] = {}
    added = reused = over_cap = 0
    for source, chunk in pending:
        row = _row(source, chunk, world_id, model)
        if chunk.sha256 in vectors:
            row.embedding = vectors[chunk.sha256]
            reused += 1
            added += 1
        elif chunk.sha256 in texts or len(texts) < max_embed:
            texts[chunk.sha256] = chunk.content
            rows[chunk.sha256].append(row.id)
        else:
            over_cap += 1
            continue
        session.add(row)
    session.flush()
    return _Claims(rows, texts, added, len(stale), reused, over_cap)


def index_assets(
    session: Session,
    world_id: UUID,
    assets: Sequence[Asset],
    embedder: Embedder,
    *,
    now: datetime | None = None,
    max_embed: int = MAX_EMBED_PER_REQUEST,
    lock_wait_s: float = LOCK_WAIT_S,
) -> IndexStats:
    """Bring the assets' chunks up to date (see the module docstring). Commits."""
    if not assets:
        return IndexStats()
    asset_ids = [a.id for a in assets]
    desired = desired_sources(session, world_id, assets)
    if not _try_lock_world(session, world_id, lock_wait_s):
        session.rollback()
        log.info("copilot index of world %s is busy; answering from the current index", world_id)
        return IndexStats(busy=True)
    claims = _claim(
        session, world_id, asset_ids, desired, embedder.model, now or datetime.now(UTC), max_embed
    )
    session.commit()

    added, embedded, skipped = claims.added, 0, claims.over_cap
    hashes = list(claims.texts)
    for start in range(0, len(hashes), EMBED_BATCH):
        batch = hashes[start : start + EMBED_BATCH]
        try:
            vectors = embedder.embed(
                [claims.texts[sha] for sha in batch], purpose="document", world_id=world_id
            )
            for sha, vector in zip(batch, vectors, strict=True):
                session.execute(
                    update(DocChunk)
                    .where(col(DocChunk.id).in_(claims.rows[sha]))
                    .values(embedding=vector)
                )
            session.commit()
        except (LLMError, SQLAlchemyError) as exc:
            session.rollback()
            log.warning("copilot indexing stopped after %d chunks: %s", embedded, exc)
            unfilled = [rid for sha in hashes[start:] for rid in claims.rows[sha]]
            session.execute(
                delete(DocChunk).where(
                    col(DocChunk.id).in_(unfilled), col(DocChunk.embedding).is_(None)
                )
            )
            session.commit()
            skipped += len(unfilled)
            break
        embedded += len(batch)
        added += sum(len(claims.rows[sha]) for sha in batch)
    return IndexStats(added, claims.removed, embedded, claims.reused, skipped)

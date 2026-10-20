"""The per-world Copilot index (T39): idempotent, lazy, budget-aware.

`index_assets` brings `doc_chunks` up to date for some assets of one world just before a
question is answered: each asset's latest `REPORTS_PER_ASSET` reports and `EVENTS_PER_ASSET`
news events are chunked (`rag.chunking`); a source whose stored chunks already have the same
hashes and embedding model is left alone; changed sources are replaced and sources that left
the window are removed. A vector already computed for the same text and model (in any world:
sandbox copies share their template's text) is reused, so only new text is embedded.

Writes take a per-world advisory lock, so two questions at once can't index the same source
twice. If embedding fails (no key, provider down, `LLM_BUDGET_USD` reached) the new chunks are
skipped and retrieval uses what is already indexed.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, text
from sqlalchemy import select as sa_select
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, col, select

from app.llm import LLMError
from app.models import Asset, ChunkSource, DocChunk, Event, Report
from app.rag.chunking import ChunkDraft, EventFacts, ReportFacts, event_chunks, report_chunks
from app.rag.embed import Embedder

log = logging.getLogger(__name__)

REPORTS_PER_ASSET = 5
EVENTS_PER_ASSET = 20
# Advisory-lock namespace for indexing (two-key form: namespace, hash of the world ID).
INDEX_LOCK_NAMESPACE = 0x4E585247


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
    """Chunks not indexed because embedding failed."""


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


def _lock_world(session: Session, world_id: UUID) -> None:
    session.execute(
        text("SELECT pg_advisory_xact_lock(:ns, hashtext(:world))"),
        {"ns": INDEX_LOCK_NAMESPACE, "world": str(world_id)},
    )


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


def index_assets(
    session: Session, world_id: UUID, assets: Sequence[Asset], embedder: Embedder
) -> IndexStats:
    """Bring the assets' chunks up to date (see the module docstring). Flushes; the caller
    commits."""
    if not assets:
        return IndexStats()
    _lock_world(session, world_id)
    asset_ids = [a.id for a in assets]
    desired = desired_sources(session, world_id, assets)
    # SQLAlchemy's select: six columns, and never the vectors.
    existing = session.execute(
        sa_select(
            col(DocChunk.id),
            col(DocChunk.report_id),
            col(DocChunk.event_id),
            col(DocChunk.seq),
            col(DocChunk.content_sha256),
            col(DocChunk.embed_model),
        ).where(col(DocChunk.world_id) == world_id, col(DocChunk.asset_id).in_(asset_ids))
    ).all()
    stored: dict[UUID, set[tuple[int, str, str]]] = defaultdict(set)
    row_ids: dict[UUID, list[UUID]] = defaultdict(list)
    for row_id, report_id, event_id, seq, sha, model in existing:
        source_id = report_id or event_id
        stored[source_id].add((seq, sha, model))
        row_ids[source_id].append(row_id)

    wanted_ids = {s.source_id for s in desired}
    stale = [
        rid for source_id, rids in row_ids.items() if source_id not in wanted_ids for rid in rids
    ]
    todo: list[SourceDraft] = []
    for source in desired:
        want = {(c.seq, c.sha256, embedder.model) for c in source.chunks}
        if stored.get(source.source_id) != want:
            stale += row_ids.get(source.source_id, [])
            todo.append(source)
    if stale:
        session.execute(delete(DocChunk).where(col(DocChunk.id).in_(stale)))

    pending = [(source, chunk) for source in todo for chunk in source.chunks]
    vectors = _reusable_vectors(session, embedder.model, {c.sha256 for _, c in pending})
    reused = sum(1 for _, c in pending if c.sha256 in vectors)
    missing = list(dict.fromkeys(c.sha256 for _, c in pending if c.sha256 not in vectors))
    texts = {c.sha256: c.content for _, c in pending}
    embedded = 0
    if missing:
        try:
            fresh = embedder.embed(
                [texts[sha] for sha in missing], purpose="document", world_id=world_id
            )
            vectors.update(zip(missing, fresh, strict=True))
            embedded = len(missing)
        except (LLMError, SQLAlchemyError) as exc:
            log.warning("copilot indexing skipped %d chunks: %s", len(missing), exc)

    added = skipped = 0
    for source, chunk in pending:
        vector = vectors.get(chunk.sha256)
        if vector is None:
            skipped += 1
            continue
        session.add(
            DocChunk(
                world_id=world_id,
                asset_id=source.asset_id,
                source_kind=source.kind,
                report_id=source.source_id if source.kind is ChunkSource.REPORT else None,
                event_id=source.source_id if source.kind is ChunkSource.EVENT else None,
                seq=chunk.seq,
                content=chunk.content,
                content_sha256=chunk.sha256,
                embed_model=embedder.model,
                embedding=vector,
            )
        )
        added += 1
    session.flush()
    return IndexStats(added, len(stale), embedded, reused, skipped)

"""Copilot retrieval (T39): the caller's visible assets, then the nearest chunks among them.

Tenant isolation is in the query, not the prompt: chunks are read only from the caller's world
and only for assets the caller may see (`authz.can_see`: listed and suspended assets, plus
listings under review for their community's members and same-world admins), the same rule as
`GET /assets/{id}`. News events are shown with their asset, so the asset's visibility is the
event's. Ranking is exact cosine distance over that small set (no ANN index; see migration
0018).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from sqlalchemy.orm import load_only
from sqlmodel import Session, col, select

from app.authz import Actor, asset_ref_of, can_see
from app.models import Asset, ChunkSource, DocChunk, Event, Report
from app.rag.answer import Source

TOP_K = 6
# A world-wide question searches at most this many visible assets (newest first).
MAX_ASSETS = 50


def visible_assets(
    session: Session, actor: Actor | None, world_id: UUID, asset_id: UUID | None = None
) -> list[Asset]:
    """Assets in `world_id` the actor may see: just `asset_id` when given."""
    # Only what visibility and chunk text need: never the (large) boundary GeoJSON.
    columns = [
        getattr(Asset, name)
        for name in ("id", "world_id", "name", "status", "ipo_at", "community_id")
    ]
    query = select(Asset).options(load_only(*columns)).where(Asset.world_id == world_id)
    if asset_id is not None:
        query = query.where(Asset.id == asset_id)
    rows = session.exec(query.order_by(col(Asset.created_at).desc(), col(Asset.id))).all()
    return [a for a in rows if can_see(actor, asset_ref_of(a))][:MAX_ASSETS]


def _event_ref(event_id: UUID, taken: set[str]) -> str:
    for length in (8, 12, 32):
        ref = f"E{event_id.hex[:length]}"
        if ref not in taken:
            return ref
    raise AssertionError("event IDs are unique")


def _report_ref(version: int, taken: set[str]) -> str:
    ref = f"R{version}"
    suffix = 1
    while ref in taken:
        suffix += 1
        ref = f"R{version}-{suffix}"
    return ref


def retrieve(
    session: Session,
    world_id: UUID,
    names: Mapping[UUID, str],
    model: str,
    query_vector: Sequence[float],
    *,
    min_similarity: float,
    k: int = TOP_K,
) -> list[Source]:
    """The top `k` chunks of the assets in `names` (ID → name, all visible and in `world_id`),
    grouped by source, most similar first. Reports are cited `R{version}` (`R{version}-2`… if
    two sites share a version in one answer), events `E` + the first 8 hex digits of their ID.
    """
    if not names:
        return []
    embedding: Any = DocChunk.embedding  # a pgvector column: has cosine_distance
    distance = embedding.cosine_distance(list(query_vector)).label("distance")
    rows = session.exec(
        select(DocChunk, distance)
        .where(
            DocChunk.world_id == world_id,
            col(DocChunk.asset_id).in_(list(names)),
            DocChunk.embed_model == model,
            col(DocChunk.embedding).is_not(None),
        )
        .order_by(distance, col(DocChunk.id))
        .limit(k)
    ).all()
    hits = [(chunk, 1.0 - float(d)) for chunk, d in rows if 1.0 - float(d) >= min_similarity]
    if not hits:
        return []

    report_ids = {c.report_id for c, _ in hits if c.report_id}
    event_ids = {c.event_id for c, _ in hits if c.event_id}
    versions = dict(
        session.exec(
            select(Report.id, Report.version).where(
                Report.world_id == world_id, col(Report.id).in_(report_ids)
            )
        ).all()
    )
    titles = dict(
        session.exec(
            select(Event.id, Event.title).where(
                Event.world_id == world_id, col(Event.id).in_(event_ids)
            )
        ).all()
    )

    grouped: dict[UUID, list[tuple[DocChunk, float]]] = {}
    for chunk, similarity in hits:
        source_id = chunk.report_id or chunk.event_id
        assert source_id is not None
        grouped.setdefault(source_id, []).append((chunk, similarity))

    taken: set[str] = set()
    sources: list[Source] = []
    for source_id, chunks in grouped.items():
        first = chunks[0][0]
        name = names[first.asset_id]
        texts = tuple(c.content for c, _ in sorted(chunks, key=lambda item: item[0].seq))
        best = max(s for _, s in chunks)
        if first.source_kind is ChunkSource.REPORT:
            version = versions.get(source_id)
            if version is None:
                continue
            ref = _report_ref(version, taken)
            source = Source(
                ref,
                ChunkSource.REPORT,
                first.asset_id,
                name,
                f"Report v{version}",
                texts,
                best,
                report_id=source_id,
                version=version,
            )
        else:
            if source_id not in titles:
                continue
            ref = _event_ref(source_id, taken)
            title = titles[source_id] or "News event"
            source = Source(
                ref, ChunkSource.EVENT, first.asset_id, name, title, texts, best, event_id=source_id
            )
        taken.add(ref)
        sources.append(source)
    return sources

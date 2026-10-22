"""Store News Scout's relevant events (`events`) so the asset page, Copilot and alerts see them.

Shared by the daily news sweep (`services.monitoring`) and every rating run
(`services.rating_runs`), so a new listing shows its news as soon as it is rated.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlmodel import Session, select

from app.models import Asset, Event, EventSource
from app.schemas import NewsScoutItem
from app.services.alerts import news_alert, raise_alert, safe_url


def record_news(
    session: Session,
    world_id: UUID,
    asset_id: UUID,
    items: Sequence[NewsScoutItem],
    *,
    alert: bool = True,
) -> tuple[int, int]:
    """Store the relevant events not stored yet and, with `alert`, raise their alerts, in the
    caller's transaction. Returns (events stored, alerts raised)."""
    asset = session.exec(
        select(Asset).where(Asset.world_id == world_id, Asset.id == asset_id)
    ).one()
    stored = alerted = 0
    for item in items:
        if not item.relevant:
            continue
        url = safe_url(item.url)
        same = select(Event.id).where(Event.world_id == world_id, Event.asset_id == asset_id)
        same = same.where(Event.url == url) if url else same.where(Event.title == item.title)
        if session.exec(same.limit(1)).first() is None:
            session.add(
                Event(
                    world_id=world_id,
                    asset_id=asset_id,
                    source=EventSource.TAVILY,
                    title=item.title,
                    url=url,
                    published_at=item.published_at,
                    impact_type=item.impact_type,
                    direction=item.direction,
                    severity=item.severity,
                    summary=item.summary,
                )
            )
            stored += 1
        draft = news_alert(asset_id, asset.name, item) if alert else None
        if draft is not None and raise_alert(session, world_id, asset, draft) is not None:
            alerted += 1
    session.flush()
    return stored, alerted

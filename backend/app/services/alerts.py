"""Monitoring alerts (T75, stories D1 D3 C3): when to alert, who gets it, read/unread.

**When (pure, `rating_alert` / `news_alert` / `verification_alert`).** A re-rate alerts when the
health score moved by `HEALTH_ALERT_DELTA` (5) points or more, or the grade changed; News Scout
alerts on a relevant event of severity `NEWS_ALERT_SEVERITY` (4) or more; a verification
decision (approved, rejected, revoked; #216) always alerts, without the reviewer's reason (only
members may read it, and holders get alerts too). Titles, messages and severities are built
here from the stored facts, never by a model; a news alert quotes the News Scout summary.

**Who (`raise_alert`).** The asset's holders (shares > 0, treasuries excluded) and its
community's members at the moment the alert is raised, one `alert_recipients` row each; the
`alert` stream event goes to the same people (`app.events._visible`). Nobody else, and nobody in
another world, ever sees it.

**Once.** Every alert has a `dedupe_key` (the report, or the asset and the news article), unique
per world, so a re-run job or a replayed run never alerts twice.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, cast
from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import func, literal, tuple_, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import Session, col, select
from sqlmodel.sql.expression import Select

from app.events import publish
from app.models import (
    Alert,
    AlertRecipient,
    Asset,
    CommunityMember,
    Holding,
    Report,
    StreamEventType,
    User,
    UserKind,
)
from app.schemas import AlertKindOut, AlertOut, NewsScoutItem
from app.services.listings import audience as listing_audience
from app.tools.scoring import Grade

HEALTH_ALERT_DELTA = Decimal(5)
NEWS_ALERT_SEVERITY = 4
BIG_HEALTH_DROP = Decimal(10)
TITLE_MAX = 120
MESSAGE_MAX = 400
ALERT_PAGE = 20
ALERT_PAGE_MAX = 50


class AlertKind(StrEnum):
    GRADE_CHANGE = "grade_change"
    HEALTH_CHANGE = "health_change"
    NEWS = "news"
    VERIFICATION = "verification"


@dataclass(frozen=True, slots=True)
class RatingSnapshot:
    """The numbers of one report that an alert compares."""

    health: Decimal | None
    grade: str | None


@dataclass(frozen=True, slots=True)
class AlertDraft:
    kind: AlertKind
    title: str
    message: str
    severity: int
    dedupe_key: str
    report_id: UUID | None = None
    url: str | None = None


# --- when: pure ---------------------------------------------------------------------------------


def _grade_rank(grade: str | None) -> int | None:
    """0 = AAA (best); None for a missing or unknown grade."""
    if grade is None:
        return None
    try:
        return list(Grade).index(Grade(grade))
    except ValueError:
        return None


def _points(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.1'))}"


def rating_alert(
    asset_name: str,
    previous: RatingSnapshot | None,
    current: RatingSnapshot,
    *,
    report_id: UUID,
) -> AlertDraft | None:
    """The alert a re-rate raises, or None: health moved by ≥ 5 points or the grade changed.

    A first rating (no previous report) never alerts. Severity: a downgrade or a drop of 10
    points or more is 4, another drop 3, an improvement 2.
    """
    if previous is None:
        return None
    delta = (
        current.health - previous.health
        if current.health is not None and previous.health is not None
        else None
    )
    grade_changed = (
        previous.grade is not None and current.grade is not None and previous.grade != current.grade
    )
    moved = delta is not None and abs(delta) >= HEALTH_ALERT_DELTA
    if not (grade_changed or moved):
        return None

    before, after = _grade_rank(previous.grade), _grade_rank(current.grade)
    downgraded = grade_changed and before is not None and after is not None and after > before
    upgraded = grade_changed and before is not None and after is not None and after < before
    worse = downgraded or (not upgraded and delta is not None and delta < 0)
    if downgraded or (delta is not None and delta <= -BIG_HEALTH_DROP):
        severity = 4
    elif worse:
        severity = 3
    else:
        severity = 2

    parts: list[str] = []
    if delta is not None and previous.health is not None and current.health is not None:
        parts.append(
            f"Health {_points(previous.health)} → {_points(current.health)} "
            f"({'+' if delta >= 0 else '−'}{_points(abs(delta))} points)."
        )
    if grade_changed:
        parts.append(f"Grade {previous.grade} → {current.grade}.")
    if grade_changed:
        verb = "downgraded" if downgraded else "upgraded" if upgraded else "regraded"
        title = f"{asset_name} {verb} to {current.grade}"
        kind = AlertKind.GRADE_CHANGE
    else:
        assert delta is not None
        direction = "fell" if delta < 0 else "rose"
        title = f"{asset_name}: health {direction} {_points(abs(delta))} points"
        kind = AlertKind.HEALTH_CHANGE
    return AlertDraft(
        kind=kind,
        title=title[:TITLE_MAX],
        message=" ".join(parts)[:MESSAGE_MAX],
        severity=severity,
        dedupe_key=f"report:{report_id}",
        report_id=report_id,
    )


_IMPACT_LABEL = {
    "encroachment": "Encroachment",
    "fire": "Fire",
    "drought": "Drought",
    "pollution": "Pollution",
    "restoration": "Restoration",
    "protection": "Protection",
    "other": "News",
}


def safe_url(url: str | None) -> str | None:
    """Only absolute http(s) links are kept: anything else is never rendered as a link."""
    if not url:
        return None
    parts = urlsplit(url.strip())
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return None
    return url.strip()


def news_key(asset_id: UUID, item: NewsScoutItem) -> str:
    """Stable per asset and article: News Scout's URL-derived ID, else a hash of the article."""
    basis = item.id or item.url or f"{item.title}|{item.summary}"
    digest = hashlib.sha256(basis.encode()).hexdigest()[:32]
    return f"news:{asset_id}:{digest}"


def news_alert(asset_id: UUID, asset_name: str, item: NewsScoutItem) -> AlertDraft | None:
    """The alert a News Scout event raises, or None: relevant and severity ≥ 4 only."""
    if not item.relevant or item.severity < NEWS_ALERT_SEVERITY:
        return None
    label = _IMPACT_LABEL.get(item.impact_type, "News")
    return AlertDraft(
        kind=AlertKind.NEWS,
        title=f"{label} reported near {asset_name}"[:TITLE_MAX],
        message=item.summary[:MESSAGE_MAX],
        severity=item.severity,
        dedupe_key=news_key(asset_id, item),
        url=safe_url(item.url),
    )


_VERIFICATION_ALERT: dict[str, tuple[str, str, int]] = {
    "verified": (
        "{name}: land documents verified",
        "A NatureX reviewer approved the community's land documents for this listing.",
        2,
    ),
    "rejected": (
        "{name}: documents not approved",
        "A NatureX reviewer didn't approve the land documents submitted for this listing. "
        "Members can read why on its verification page and submit again.",
        3,
    ),
    "revoked": (
        "{name}: verification revoked",
        "A NatureX reviewer revoked this listing's verification. The opening offer and "
        "trading stay closed until new documents are approved.",
        4,
    ),
}


def verification_alert(asset_name: str, run_id: UUID, level: str) -> AlertDraft | None:
    """The alert a verification decision raises (#216): approved, rejected or revoked, once per
    run and decision; None for any other level. Never the reviewer's reason or identity."""
    template = _VERIFICATION_ALERT.get(level)
    if template is None:
        return None
    title, message, severity = template
    return AlertDraft(
        kind=AlertKind.VERIFICATION,
        title=title.format(name=asset_name)[:TITLE_MAX],
        message=message[:MESSAGE_MAX],
        severity=severity,
        dedupe_key=f"verification:{run_id}:{level}",
    )


# --- who: delivery ------------------------------------------------------------------------------


def alert_audience(session: Session, world_id: UUID, asset: Asset) -> list[UUID]:
    """The asset's holders (shares > 0, not treasuries) and its community's members, now."""
    holders = session.exec(
        select(Holding.user_id)
        .join(User, col(User.id) == col(Holding.user_id))
        .where(
            Holding.world_id == world_id,
            Holding.asset_id == asset.id,
            col(Holding.shares) > 0,
            User.world_id == world_id,
            User.kind != UserKind.TREASURY,
        )
    ).all()
    members: list[UUID] = []
    if asset.community_id is not None:
        members = list(
            session.exec(
                select(CommunityMember.user_id).where(
                    CommunityMember.world_id == world_id,
                    CommunityMember.community_id == asset.community_id,
                )
            ).all()
        )
    return sorted({*holders, *members})


def deliver_alert(session: Session, world_id: UUID, asset: Asset, draft: AlertDraft) -> UUID | None:
    """Store the alert and its recipients (no event), in the caller's transaction. Returns its
    ID, or None when an alert with the same `dedupe_key` already exists in the world."""
    table = Alert.__table__  # type: ignore[attr-defined]
    alert_id = session.execute(
        pg_insert(table)
        .values(
            world_id=world_id,
            asset_id=asset.id,
            kind=draft.kind.value,
            title=draft.title,
            message=draft.message,
            severity=draft.severity,
            dedupe_key=draft.dedupe_key,
            report_id=draft.report_id,
            url=draft.url,
        )
        .on_conflict_do_nothing(constraint="uq_alerts_world_id_dedupe_key")
        .returning(table.c.id)
    ).scalar_one_or_none()
    if alert_id is None:
        return None
    for user_id in alert_audience(session, world_id, asset):
        session.add(AlertRecipient(alert_id=alert_id, user_id=user_id, world_id=world_id))
    session.flush()
    return cast(UUID, alert_id)


def raise_alert(session: Session, world_id: UUID, asset: Asset, draft: AlertDraft) -> Alert | None:
    """Deliver the alert and publish its `alert` event (seen by its recipients only), in the
    caller's transaction. None when an alert with the same `dedupe_key` already exists."""
    alert_id = deliver_alert(session, world_id, asset, draft)
    if alert_id is None:
        return None
    publish(
        session,
        world_id,
        StreamEventType.ALERT,
        {
            "alert_id": str(alert_id),
            "asset_id": str(asset.id),
            "asset_name": asset.name,
            "kind": draft.kind.value,
            "title": draft.title,
            "message": draft.message,
            "severity": draft.severity,
            "report_id": str(draft.report_id) if draft.report_id else None,
            "url": draft.url,
        },
        audience=listing_audience(asset),
    )
    return session.get_one(Alert, alert_id)


def snapshot(report: Report) -> RatingSnapshot:
    return RatingSnapshot(health=report.health_score, grade=report.grade)


def alert_on_rerate(
    session: Session, world_id: UUID, asset: Asset, previous: Report | None, report: Report
) -> Alert | None:
    """Raise the re-rate's alert, if it crosses a threshold (T27's `_store` calls this)."""
    draft = rating_alert(
        asset.name,
        snapshot(previous) if previous is not None else None,
        snapshot(report),
        report_id=report.id,
    )
    return None if draft is None else raise_alert(session, world_id, asset, draft)


# --- read/unread --------------------------------------------------------------------------------


def _out(alert: Alert, recipient: AlertRecipient, asset_name: str) -> AlertOut:
    return AlertOut(
        id=alert.id,
        asset_id=alert.asset_id,
        asset_name=asset_name,
        kind=cast(AlertKindOut, alert.kind),
        title=alert.title or "",
        message=alert.message or "",
        severity=alert.severity or 1,
        url=alert.url,
        report_id=alert.report_id,
        created_at=alert.created_at,
        read_at=recipient.read_at,
    )


def _mine(world_id: UUID, user_id: UUID) -> Select[Alert, AlertRecipient, str]:
    return (
        select(Alert, AlertRecipient, Asset.name)
        .join(
            AlertRecipient,
            (col(AlertRecipient.alert_id) == col(Alert.id))
            & (col(AlertRecipient.world_id) == col(Alert.world_id)),
        )
        .join(Asset, (col(Asset.id) == col(Alert.asset_id)) & (col(Asset.world_id) == world_id))
        .where(
            AlertRecipient.world_id == world_id,
            AlertRecipient.user_id == user_id,
            Alert.world_id == world_id,
        )
    )


def _community_assets(world_id: UUID, community_id: UUID) -> Any:
    return select(Asset.id).where(Asset.world_id == world_id, Asset.community_id == community_id)


def is_member(session: Session, world_id: UUID, user_id: UUID, community_id: UUID) -> bool:
    """Whether the account belongs to the community (the only way to filter alerts by it)."""
    return (
        session.exec(
            select(CommunityMember.user_id).where(
                CommunityMember.world_id == world_id,
                CommunityMember.community_id == community_id,
                CommunityMember.user_id == user_id,
            )
        ).first()
        is not None
    )


def unread_count(
    session: Session, world_id: UUID, user_id: UUID, *, community_id: UUID | None = None
) -> int:
    stmt = select(func.count()).where(
        AlertRecipient.world_id == world_id,
        AlertRecipient.user_id == user_id,
        col(AlertRecipient.read_at).is_(None),
    )
    if community_id is not None:
        about = select(Alert.id).where(
            Alert.world_id == world_id,
            col(Alert.asset_id).in_(_community_assets(world_id, community_id)),
        )
        stmt = stmt.where(col(AlertRecipient.alert_id).in_(about))
    return session.exec(stmt).one()


class CursorNotFound(LookupError):
    """`before` isn't one of the account's alerts in this world."""


def list_alerts(
    session: Session,
    world_id: UUID,
    user_id: UUID,
    *,
    limit: int = ALERT_PAGE,
    unread_only: bool = False,
    community_id: UUID | None = None,
    before: UUID | None = None,
) -> tuple[list[AlertOut], UUID | None]:
    """One page of the account's own alerts in this world, newest first, and the `before`
    cursor of the next page (None on the last). `community_id` keeps the alerts about that
    community's assets (the caller checks membership). Raises CursorNotFound."""
    stmt = _mine(world_id, user_id)
    if unread_only:
        stmt = stmt.where(col(AlertRecipient.read_at).is_(None))
    if community_id is not None:
        stmt = stmt.where(col(Alert.asset_id).in_(_community_assets(world_id, community_id)))
    if before is not None:
        cursor = session.exec(_mine(world_id, user_id).where(Alert.id == before)).first()
        if cursor is None:
            raise CursorNotFound(str(before))
        stmt = stmt.where(
            tuple_(col(Alert.created_at), col(Alert.id))
            < tuple_(literal(cursor[0].created_at), literal(cursor[0].id))
        )
    rows = session.exec(
        stmt.order_by(col(Alert.created_at).desc(), col(Alert.id).desc()).limit(limit + 1)
    ).all()
    page = [_out(alert, recipient, name) for alert, recipient, name in rows[:limit]]
    return page, (page[-1].id if len(rows) > limit else None)


def mark_read(
    session: Session, world_id: UUID, user_id: UUID, alert_id: UUID, *, now: datetime | None = None
) -> AlertOut | None:
    """Mark one of the account's alerts read (idempotent: the first read time stays). None if
    the alert wasn't delivered to this account in this world."""
    row = session.exec(_mine(world_id, user_id).where(Alert.id == alert_id)).first()
    if row is None:
        return None
    alert, recipient, name = row
    if recipient.read_at is None:
        recipient.read_at = now or datetime.now(UTC)
        session.add(recipient)
        session.flush()
    return _out(alert, recipient, name)


def mark_all_read(
    session: Session,
    world_id: UUID,
    user_id: UUID,
    *,
    community_id: UUID | None = None,
    now: datetime | None = None,
) -> int:
    """Mark the account's unread alerts read (only those about `community_id`'s assets, if
    given); returns how many changed."""
    stmt = update(AlertRecipient).where(
        col(AlertRecipient.world_id) == world_id,
        col(AlertRecipient.user_id) == user_id,
        col(AlertRecipient.read_at).is_(None),
    )
    if community_id is not None:
        about = select(Alert.id).where(
            Alert.world_id == world_id,
            col(Alert.asset_id).in_(_community_assets(world_id, community_id)),
        )
        stmt = stmt.where(col(AlertRecipient.alert_id).in_(about))
    result = session.execute(stmt.values(read_at=now or datetime.now(UTC)))
    return int(result.rowcount)  # type: ignore[attr-defined]

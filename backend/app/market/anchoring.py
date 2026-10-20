"""Price re-anchoring after a re-rate (T38, dev-spec §8 "Re-rating / ticks").

A sealed re-rate of a trading asset whose metrics `data_version` or health score changed pulls
its price toward the report's new fair value per share (a re-rate with unchanged inputs never
moves the price): ``price ← (price + 0.35 × (fair_value − price)) × (1 + ε)``
(`engine.anchor_price`). The noise ε is drawn deterministically from the report's ID
(`engine.seeded_shock`), so the move can be recomputed from its ledger entry and never comes
from a model.

`reanchor_on_rerate` runs in the rating run's own transaction, right after the report and its
alert (T27's `_store`), so every re-rate that changed something re-anchors whatever started it
(API, scheduled job, Time Machine). It writes a `prices` row (`reason = 'rerate'`), a public
`price_anchor` ledger entry with every term and a `price_tick` live event.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlmodel import Session, col, select

from app.events import publish
from app.ledger import append
from app.market.engine import ALPHA_RERATE, PriceReason, anchor_price, seeded_shock
from app.models import Asset, LedgerKind, Metrics, Price, Report, StreamEventType
from app.services.listings import audience as listing_audience

FORMULA = "price ← (price + α × (fair_value_per_share − price)) × (1 + ε), α = 0.35"


@dataclass(frozen=True, slots=True)
class Reanchor:
    previous_price: Decimal
    fair_value_per_share: Decimal
    shock: Decimal
    price: Decimal
    ts: datetime


def latest_price(session: Session, world_id: UUID, asset_id: UUID) -> Price | None:
    return session.exec(
        select(Price)
        .where(Price.world_id == world_id, Price.asset_id == asset_id)
        .order_by(col(Price.ts).desc())
        .limit(1)
    ).first()


def _data_version(session: Session, report: Report) -> str | None:
    if report.metrics_id is None:
        return None
    return session.exec(select(Metrics.data_version).where(Metrics.id == report.metrics_id)).first()


def rating_changed(session: Session, previous: Report, report: Report) -> bool:
    """The re-rate changed its inputs or result: another metrics `data_version` or health."""
    return previous.health_score != report.health_score or _data_version(
        session, previous
    ) != _data_version(session, report)


def reanchor_on_rerate(
    session: Session,
    asset: Asset,
    previous: Report | None,
    report: Report,
    *,
    now: datetime | None = None,
) -> Reanchor | None:
    """Re-anchor a trading asset's price to `report` in the caller's transaction (the caller
    holds the asset row lock and commits). None when there's nothing to anchor: a first rating
    (no `previous` report), an asset that isn't trading (no IPO yet: no shares, no price), a
    report without a fair value per share, or a re-rate that changed neither the metrics'
    `data_version` nor the health score."""
    # Imported here: `services.ipo` imports the rating runner, which imports this module.
    from app.services.ipo import is_trading

    fair_value = report.fair_value_per_share
    if previous is None or not is_trading(asset) or fair_value is None:
        return None
    if not rating_changed(session, previous, report):
        return None
    last = latest_price(session, asset.world_id, asset.id)
    if last is None:
        return None
    shock = seeded_shock(str(report.id))
    change = anchor_price(last.price, fair_value, PriceReason.RERATE, shock)
    # Strictly after the latest price, so the history's order is the order of the changes.
    ts = max(now or datetime.now(UTC), last.ts + timedelta(microseconds=1))
    session.add(
        Price(
            world_id=asset.world_id,
            asset_id=asset.id,
            ts=ts,
            price=change.price,
            reason=change.reason.value,
        )
    )
    session.flush()
    append(
        session,
        world_id=asset.world_id,
        asset_id=asset.id,
        kind=LedgerKind.PRICE_ANCHOR,
        payload={
            "reason": PriceReason.RERATE.value,
            "community_id": str(asset.community_id) if asset.community_id else None,
            "report_version": report.version,
            "formula": FORMULA,
            "alpha": str(ALPHA_RERATE),
            "previous_price": str(last.price),
            "fair_value_per_share": str(fair_value),
            "noise": str(shock),
            "price": str(change.price),
        },
        ref_id=report.id,
    )
    publish(
        session,
        asset.world_id,
        StreamEventType.PRICE_TICK,
        {"asset_id": str(asset.id), "price": str(change.price), "reason": change.reason.value},
        audience=listing_audience(asset),
    )
    return Reanchor(last.price, fair_value, shock, change.price, ts)

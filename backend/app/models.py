"""SQLModel tables for NatureX v1 (dev-spec §5 + world_id sandbox)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Column, DateTime, Index, SmallInteger, UniqueConstraint, text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    """Timezone-aware now(), required by SQLModel for TIMESTAMPTZ columns."""
    return datetime.now(UTC)


def _enum_values(enum_cls: type[StrEnum]) -> list[str]:
    return [member.value for member in enum_cls]


def _enum_column(enum_cls: type[StrEnum]) -> Column[Any]:
    """Store enum .value (matches DB CHECK constraints), not SQLAlchemy's default .name."""
    return Column(
        SAEnum(enum_cls, values_callable=_enum_values, native_enum=False),
        nullable=False,
    )


def _created_at() -> Any:
    """TIMESTAMPTZ column defaulting to now() (dev-spec §5)."""
    return Field(
        default_factory=_utcnow,
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": text("now()")},
    )


class UserRole(StrEnum):
    COMMUNITY = "community"
    INVESTOR = "investor"
    ADMIN = "admin"


class AssetStatus(StrEnum):
    DRAFT = "draft"
    RATING = "rating"
    NEEDS_EVIDENCE = "needs_evidence"
    INELIGIBLE = "ineligible"
    LISTED = "listed"
    SUSPENDED = "suspended"


class EventSource(StrEnum):
    TAVILY = "tavily"
    ADMIN = "admin"
    EVIDENCE = "evidence"


class OrderSide(StrEnum):
    BUY = "buy"
    SELL = "sell"


class LedgerKind(StrEnum):
    LISTING = "listing"
    REPORT = "report"
    EVENT = "event"
    PRICE_ANCHOR = "price_anchor"
    PAYOUT = "payout"


class StreamEventType(StrEnum):
    RATING_PROGRESS = "rating_progress"
    PRICE_TICK = "price_tick"
    ALERT = "alert"
    HEARTBEAT = "heartbeat"


class World(SQLModel, table=True):
    __tablename__ = "worlds"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    label: str = Field(index=True)
    created_at: datetime = _created_at()
    last_seen_at: datetime = _created_at()  # bumped on each visit; stale sandboxes are pruned (T31)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    name: str
    role: UserRole = Field(sa_column=_enum_column(UserRole))
    cash_balance: Decimal = Field(default=Decimal("10000.00"), max_digits=14, decimal_places=2)
    persona_key: str | None = Field(default=None, index=True)


class Asset(SQLModel, table=True):
    __tablename__ = "assets"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    name: str
    community_user_id: UUID | None = Field(default=None, foreign_key="users.id")
    country: str | None = None
    description: str | None = None
    cover_image_url: str | None = None
    geojson: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    area_ha: Decimal = Field(max_digits=12, decimal_places=2)
    centroid_lat: float | None = None
    centroid_lon: float | None = None
    total_shares: int = Field(default=1_000_000, sa_column=Column(BigInteger, nullable=False))
    retained_pct: Decimal = Field(default=Decimal("51.00"), max_digits=5, decimal_places=2)
    primary_shares_remaining: int = Field(sa_column=Column(BigInteger, nullable=False))
    community_wallet: Decimal = Field(default=Decimal("0.00"), max_digits=14, decimal_places=2)
    status: AssetStatus = Field(default=AssetStatus.DRAFT, sa_column=_enum_column(AssetStatus))
    site_key: str | None = Field(default=None, index=True)
    created_at: datetime = _created_at()


class Metrics(SQLModel, table=True):
    __tablename__ = "metrics"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    data_version: str
    landcover: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    ndvi_series: list[Any] | None = Field(default=None, sa_column=Column(JSONB))
    ndvi_trend: Decimal | None = Field(default=None, max_digits=12, decimal_places=6)
    water_change: Decimal | None = Field(default=None, max_digits=12, decimal_places=4)
    forest_loss_ha: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)
    biomass_t_ha: Decimal | None = Field(default=None, max_digits=12, decimal_places=2)
    cloud_free_obs: int | None = None
    created_at: datetime = _created_at()


class Event(SQLModel, table=True):
    __tablename__ = "events"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    source: EventSource = Field(sa_column=_enum_column(EventSource))
    title: str | None = None
    url: str | None = None
    published_at: date | None = None
    impact_type: str | None = None
    direction: int | None = Field(default=None, ge=-1, le=1, sa_type=SmallInteger)
    severity: int | None = Field(default=None, ge=1, le=5, sa_type=SmallInteger)
    summary: str | None = None
    created_at: datetime = _created_at()


class WorldEvent(SQLModel, table=True):
    __tablename__ = "world_events"
    __table_args__ = (
        Index("ix_world_events_world_id_id", "world_id", "id"),
        Index("ix_world_events_created_at", "created_at"),
    )

    id: int | None = Field(
        default=None,
        sa_column=Column(BigInteger, primary_key=True, autoincrement=True),
    )
    world_id: UUID = Field(foreign_key="worlds.id")
    type: StreamEventType = Field(sa_column=_enum_column(StreamEventType))
    payload: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    created_at: datetime = _created_at()


class Report(SQLModel, table=True):
    __tablename__ = "reports"
    __table_args__ = (UniqueConstraint("asset_id", "version", name="uq_reports_asset_version"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    version: int
    metrics_id: UUID | None = Field(default=None, foreign_key="metrics.id")
    health_score: Decimal | None = Field(default=None, max_digits=5, decimal_places=2)
    grade: str | None = None
    confidence: Decimal | None = Field(default=None, max_digits=5, decimal_places=2)
    value_low: Decimal | None = Field(default=None, max_digits=16, decimal_places=2)
    value_mid: Decimal | None = Field(default=None, max_digits=16, decimal_places=2)
    value_high: Decimal | None = Field(default=None, max_digits=16, decimal_places=2)
    value_breakdown: dict[str, Any] | None = Field(default=None, sa_column=Column(JSONB))
    fair_value_per_share: Decimal | None = Field(default=None, max_digits=12, decimal_places=4)
    flags: dict[str, Any] | None = Field(default=None, sa_column=Column(JSONB))
    summary_md: str | None = None
    recommendations: list[Any] | None = Field(default=None, sa_column=Column(JSONB))
    auditor_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSONB))
    created_at: datetime = _created_at()


class Price(SQLModel, table=True):
    __tablename__ = "prices"

    world_id: UUID = Field(foreign_key="worlds.id", primary_key=True)
    asset_id: UUID = Field(foreign_key="assets.id", primary_key=True)
    ts: datetime = Field(
        default_factory=_utcnow,
        primary_key=True,
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": text("now()")},
    )
    price: Decimal = Field(max_digits=12, decimal_places=4)
    reason: str | None = None


class Holding(SQLModel, table=True):
    __tablename__ = "holdings"

    world_id: UUID = Field(foreign_key="worlds.id", primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", primary_key=True)
    asset_id: UUID = Field(foreign_key="assets.id", primary_key=True)
    shares: int = Field(default=0, sa_column=Column(BigInteger, nullable=False))
    avg_cost: Decimal | None = Field(default=None, max_digits=12, decimal_places=4)


class Order(SQLModel, table=True):
    __tablename__ = "orders"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    user_id: UUID = Field(foreign_key="users.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    side: OrderSide = Field(sa_column=_enum_column(OrderSide))
    qty: int = Field(sa_column=Column(BigInteger, nullable=False))
    fill_price: Decimal | None = Field(default=None, max_digits=12, decimal_places=4)
    is_primary: bool = False
    created_at: datetime = _created_at()


class Alert(SQLModel, table=True):
    __tablename__ = "alerts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    kind: str | None = None
    message: str | None = None
    severity: int | None = None
    created_at: datetime = _created_at()


class DocChunk(SQLModel, table=True):
    __tablename__ = "doc_chunks"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    report_id: UUID | None = Field(default=None, foreign_key="reports.id")
    content: str
    embedding: list[float] | None = Field(default=None, sa_column=Column(Vector(1024)))


class LedgerEntry(SQLModel, table=True):
    __tablename__ = "ledger_entries"
    __table_args__ = (UniqueConstraint("asset_id", "seq", name="uq_ledger_asset_seq"),)

    id: int | None = Field(default=None, primary_key=True, sa_type=BigInteger)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    seq: int
    kind: LedgerKind = Field(sa_column=_enum_column(LedgerKind))
    ref_id: UUID | None = None
    payload: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    prev_hash: str = Field(max_length=64)
    hash: str = Field(max_length=64)
    created_at: datetime = _created_at()


class LlmCall(SQLModel, table=True):
    __tablename__ = "llm_calls"

    id: int | None = Field(default=None, primary_key=True, sa_type=BigInteger)
    world_id: UUID | None = Field(default=None, foreign_key="worlds.id", index=True)
    agent: str | None = None
    model: str | None = None
    asset_id: UUID | None = Field(default=None, foreign_key="assets.id")
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int | None = None
    cost_usd: Decimal = Field(
        default=Decimal("0"),
        max_digits=12,
        decimal_places=6,
        sa_column_kwargs={"server_default": "0"},
    )
    tier: str | None = None
    status: str = Field(default="ok", sa_column_kwargs={"server_default": "ok"})
    """ok | invalid_output | error (one row per attempt, including failed ones)."""
    created_at: datetime = _created_at()

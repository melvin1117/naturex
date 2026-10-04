"""SQLModel tables for NatureX v1 (dev-spec §5 + world_id sandbox)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Column, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


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


class World(SQLModel, table=True):
    __tablename__ = "worlds"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    label: str = Field(index=True)
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    name: str
    role: UserRole
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
    status: AssetStatus = Field(default=AssetStatus.DRAFT)
    site_key: str | None = Field(default=None, index=True)
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


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
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


class Event(SQLModel, table=True):
    __tablename__ = "events"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    source: EventSource
    title: str | None = None
    url: str | None = None
    published_at: date | None = None
    impact_type: str | None = None
    direction: int | None = Field(default=None, ge=-1, le=1)
    severity: int | None = Field(default=None, ge=1, le=5)
    summary: str | None = None
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


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
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


class Price(SQLModel, table=True):
    __tablename__ = "prices"

    world_id: UUID = Field(foreign_key="worlds.id", primary_key=True)
    asset_id: UUID = Field(foreign_key="assets.id", primary_key=True)
    ts: datetime = Field(
        default_factory=datetime.utcnow,
        primary_key=True,
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
    side: OrderSide
    qty: int = Field(sa_column=Column(BigInteger, nullable=False))
    fill_price: Decimal | None = Field(default=None, max_digits=12, decimal_places=4)
    is_primary: bool = False
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


class Alert(SQLModel, table=True):
    __tablename__ = "alerts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    kind: str | None = None
    message: str | None = None
    severity: int | None = None
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


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

    id: int | None = Field(default=None, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    asset_id: UUID = Field(foreign_key="assets.id", index=True)
    seq: int
    kind: LedgerKind
    ref_id: UUID | None = None
    payload: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    prev_hash: str = Field(max_length=64)
    hash: str = Field(max_length=64)
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )


class LlmCall(SQLModel, table=True):
    __tablename__ = "llm_calls"

    id: int | None = Field(default=None, primary_key=True)
    world_id: UUID | None = Field(default=None, foreign_key="worlds.id", index=True)
    agent: str | None = None
    model: str | None = None
    asset_id: UUID | None = Field(default=None, foreign_key="assets.id")
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int | None = None
    created_at: datetime = Field(
        default_factory=datetime.utcnow,
        sa_column_kwargs={"server_default": text("now()")},
    )

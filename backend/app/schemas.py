"""API and agent output schemas (OpenAPI contract; frontend client is generated)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models import AssetStatus, LedgerKind, StreamEventType, UserRole

# ----- Agent outputs (contract-tested later) -----


class NewsScoutItem(BaseModel):
    """Nemotron Nano classification of one Tavily hit (dev-spec §7.5)."""

    id: str | None = Field(
        default=None,
        description="Stable event ID derived from the source URL, so reports can cite it.",
    )
    relevant: bool
    impact_type: Literal[
        "encroachment",
        "fire",
        "drought",
        "pollution",
        "restoration",
        "protection",
        "other",
    ]
    direction: Literal[-1, 0, 1]
    severity: int = Field(ge=1, le=5)
    summary: str
    published_at: date | None = None
    title: str | None = None
    url: str | None = None


class NewsScoutOutput(BaseModel):
    events: list[NewsScoutItem]


class AuditorFlag(BaseModel):
    type: str
    detail: str
    citation: str | None = None


class AuditorOutput(BaseModel):
    """Nemotron Ultra auditor JSON (dev-spec §7.7)."""

    auditor_adjustment: int = Field(ge=-10, le=10)
    adjustment_reason: str
    agreement: float = Field(ge=0, le=1)
    flags: list[AuditorFlag] = Field(default_factory=list)
    greenwashing_risk: Literal["low", "medium", "high"]
    key_changes: list[str] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)
    summary_md: str
    citations: list[str] = Field(
        default_factory=list,
        description="Metric or event IDs cited in the report",
    )


# ----- Shared API types -----


class AssetStatusOut(StrEnum):
    DRAFT = "draft"
    RATING = "rating"
    NEEDS_EVIDENCE = "needs_evidence"
    INELIGIBLE = "ineligible"
    LISTED = "listed"
    SUSPENDED = "suspended"


class ReportSummarySource(StrEnum):
    LIVE = "live"
    FALLBACK = "fallback"


class AssetCreate(BaseModel):
    name: str
    country: str | None = None
    description: str | None = None
    geojson: dict[str, Any]
    total_shares: int = 1_000_000
    retained_pct: Decimal = Decimal("51.00")


class AssetCard(BaseModel):
    id: UUID
    name: str
    country: str | None = None
    status: AssetStatusOut
    area_ha: Decimal
    price: Decimal | None = None
    price_change_pct: float | None = None
    grade: str | None = None
    trend: str | None = None
    confidence: Decimal | None = None
    cover_image_url: str | None = None
    site_key: str | None = None


class EventOut(BaseModel):
    id: UUID
    asset_id: UUID
    source: str
    title: str | None = None
    url: str | None = None
    published_at: date | None = None
    impact_type: str | None = None
    direction: int | None = None
    severity: int | None = None
    summary: str | None = None
    created_at: datetime


class ReportOut(BaseModel):
    id: UUID
    asset_id: UUID
    version: int
    health_score: Decimal | None = None
    grade: str | None = None
    confidence: Decimal | None = None
    value_low: Decimal | None = None
    value_mid: Decimal | None = None
    value_high: Decimal | None = None
    value_breakdown: dict[str, Any] | None = None
    fair_value_per_share: Decimal | None = None
    flags: list[Any] | None = None
    summary_md: str | None = None
    summary_source: ReportSummarySource = Field(
        default=ReportSummarySource.FALLBACK,
        description="Whether summary_md came from a live Nemotron call or deterministic fallback.",
    )
    recommendations: list[str] | None = None
    auditor: AuditorOutput | None = None
    created_at: datetime


class AssetDetail(BaseModel):
    id: UUID
    name: str
    country: str | None = None
    description: str | None = None
    status: AssetStatusOut
    area_ha: Decimal
    centroid_lat: float | None = None
    centroid_lon: float | None = None
    geojson: dict[str, Any]
    total_shares: int
    retained_pct: Decimal
    primary_shares_remaining: int
    community_wallet: Decimal
    site_key: str | None = None
    latest_report: ReportOut | None = None
    recent_events: list[EventOut] = Field(default_factory=list)
    price: Decimal | None = None


class AssetCreateResponse(BaseModel):
    asset: AssetDetail
    run_id: UUID
    status: Literal["accepted"] = "accepted"


class EvidenceResponse(BaseModel):
    event: EventOut
    message: str


class PricePoint(BaseModel):
    ts: datetime
    price: Decimal
    reason: str | None = None


class ReportDiff(BaseModel):
    report_id: UUID
    prev_report_id: UUID
    changes: list[str]


class OrderCreate(BaseModel):
    asset_id: UUID
    side: Literal["buy", "sell"]
    qty: int = Field(gt=0)


class OrderOut(BaseModel):
    id: UUID
    asset_id: UUID
    side: Literal["buy", "sell"]
    qty: int
    fill_price: Decimal
    is_primary: bool
    created_at: datetime


class HoldingOut(BaseModel):
    asset_id: UUID
    asset_name: str
    shares: int
    avg_cost: Decimal | None = None
    mark_price: Decimal | None = None
    unrealized_pnl: Decimal | None = None


class ImpactSummary(BaseModel):
    ha_protected: Decimal
    t_co2_stored: Decimal
    services_usd_yr: Decimal


class PortfolioOut(BaseModel):
    cash_balance: Decimal
    holdings: list[HoldingOut]
    impact: ImpactSummary


class CopilotRequest(BaseModel):
    question: str
    asset_id: UUID | None = None


class CopilotCitation(BaseModel):
    ref: str
    snippet: str


class CopilotResponse(BaseModel):
    answer: str
    citations: list[CopilotCitation] = Field(default_factory=list)


class StreamEvent(BaseModel):
    id: int | None = Field(
        default=None,
        description="Monotonic world_events cursor; null for transient heartbeats",
    )
    type: StreamEventType
    payload: dict[str, Any]
    ts: datetime


class SimulateQuarterResponse(BaseModel):
    data_version: str
    assets_rerated: int
    message: str


class SimulateEventRequest(BaseModel):
    asset_id: UUID
    preset: Literal["fire", "encroachment", "drought", "restoration", "protection"]


class SimulateEventResponse(BaseModel):
    event: EventOut
    alert_created: bool


class TraceStep(BaseModel):
    agent: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    latency_ms: int
    created_at: datetime


class TraceOut(BaseModel):
    asset_id: UUID | None = None
    steps: list[TraceStep]


# ----- Nature Ledger (T30) -----


class LedgerEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    seq: int
    kind: LedgerKind
    ref_id: UUID | None
    payload: dict[str, Any]
    prev_hash: str
    hash: str
    created_at: datetime


class LedgerVerifyOut(BaseModel):
    valid: bool
    entries: int
    head: str | None = Field(description="Hash of the last entry; null when the chain is broken")
    broken_at: int | None = Field(description="First failing entry; null when the chain is valid")


class TamperDemoIn(BaseModel):
    asset_id: UUID
    seq: int | None = Field(default=None, ge=0, description="Entry to edit; defaults to the latest")


class TamperDemoOut(BaseModel):
    seq: int
    field: str
    before: Any
    after: Any
    verify: LedgerVerifyOut


# ----- Sandbox worlds (T31) -----


class PersonaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    key: str | None = Field(validation_alias="persona_key")
    name: str
    role: UserRole
    cash_balance: Decimal


class WorldAssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    site_key: str | None
    name: str
    status: AssetStatus


class WorldOut(BaseModel):
    id: UUID
    label: str
    created_at: datetime
    personas: list[PersonaOut]
    assets: list[WorldAssetOut]

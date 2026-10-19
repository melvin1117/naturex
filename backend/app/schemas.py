"""API and agent output schemas (OpenAPI contract; frontend client is generated)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.auth import (
    EMAIL_MAX_LENGTH,
    NAME_MAX_LENGTH,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    is_valid_email,
    normalize_email,
)
from app.communities import clean_country, clean_description, clean_name
from app.models import (
    AssetStatus,
    CommunityRole,
    LedgerKind,
    StreamEventType,
    UserKind,
    UserRole,
)

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
    dropped_off_site: int = Field(
        default=0,
        ge=0,
        description="Events the model labelled relevant but whose article names neither the "
        "asset nor a geocoded place near it (locality gate, dev-spec §7.5).",
    )
    locality_unverified: bool = Field(
        default=False,
        description="True when the geocode gave no place names, so relevant events were kept "
        "without the locality gate.",
    )


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
    AUDITOR = "auditor"


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
    price: Decimal | None = Field(default=None, description="Latest sandbox price (play money).")
    price_change_pct: float | None = Field(
        default=None, description="Latest price vs the IPO price, in percent (2 dp)."
    )
    grade: str | None = None
    trend: str | None = Field(
        default=None,
        description="Health vs the previous report: improving, declining or stable; "
        "null with a single report.",
    )
    confidence: Decimal | None = None
    health_score: Decimal | None = None
    value_low: Decimal | None = Field(default=None, description="Int$2020/yr, latest report.")
    value_mid: Decimal | None = None
    value_high: Decimal | None = None
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
        description="Where summary_md came from: the stored, cited Auditor summary (auditor), "
        "a live Nemotron call (live) or the deterministic fallback (fallback).",
    )
    recommendations: list[str] | None = None
    auditor: AuditorOutput | None = None
    data_version: str | None = Field(
        default=None, description="Earth observation data version, e.g. 2026Q3 or sim-1."
    )
    period: str | None = Field(
        default=None, description="Quarter the report stands for (a simulated version's quarter)."
    )
    simulated: bool = Field(
        default=False,
        description="True for Time Machine scenarios: scripted changes, never observed data.",
    )
    rating: dict[str, Any] | None = Field(
        default=None,
        description="Deterministic rating snapshot: metrics provenance, valuation, score and "
        "fair-value inputs (T19).",
    )
    greenwashing_risk: Literal["low", "medium", "high"] | None = Field(
        default=None,
        description="The Auditor's greenwashing risk; null when it was not assessed (no audit, "
        "or the Auditor fell back). Prefer this over auditor.greenwashing_risk.",
    )
    run_id: UUID | None = Field(
        default=None, description="Rating run that produced this report (T27); null for seeds."
    )
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


class RatingRunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    DEGRADED = "degraded"
    """Finished with a report, but a fallback was used (fixed pipeline, lower model tier,
    no audit or a failed optional step); `reasons` says which."""


class RatingRunAccepted(BaseModel):
    run_id: UUID
    asset_id: UUID
    status: Literal["queued"] = "queued"


class RatingRunStep(BaseModel):
    """One `rating_progress` event of a run (T27)."""

    step: str = Field(
        description="queued, started, earth_obs, valuation, news, evidence, audit, fallback or done"
    )
    status: str
    tool: str | None = None
    pipeline: str | None = Field(default=None, description="orchestrator or fixed")
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int | None = None
    cost_usd: Decimal | None = None
    error: str | None = None
    ts: datetime | None = None


class RatingRunOut(BaseModel):
    """A rating run's status, rebuilt from its progress events (or its report's run record)."""

    run_id: UUID
    asset_id: UUID
    status: RatingRunStatus
    trigger: str | None = None
    scenario: str | None = None
    pipeline: str | None = None
    degraded: bool = False
    reasons: list[str] = Field(default_factory=list)
    error: str | None = None
    report_id: UUID | None = None
    version: int | None = None
    grade: str | None = None
    health_score: Decimal | None = None
    confidence: Decimal | None = None
    steps: list[RatingRunStep] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


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


# ----- Accounts and sessions (ADR-0005, T54) -----


class RegisterIn(BaseModel):
    email: str = Field(max_length=EMAIL_MAX_LENGTH)
    password: SecretStr = Field(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH)
    name: str = Field(min_length=1, max_length=NAME_MAX_LENGTH)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        email = normalize_email(value)
        if not is_valid_email(email):
            raise ValueError("Enter a valid email address")
        return email

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        name = value.strip()
        if not name or not name.isprintable():
            raise ValueError("Enter a display name")
        return name


class LoginIn(BaseModel):
    email: str = Field(max_length=EMAIL_MAX_LENGTH)
    password: SecretStr = Field(min_length=1, max_length=PASSWORD_MAX_LENGTH)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        email = normalize_email(value)
        if not is_valid_email(email):
            raise ValueError("Enter a valid email address")
        return email


class MeOut(BaseModel):
    """The signed-in account. Never includes the password hash."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    email: str | None
    kind: UserKind
    is_admin: bool
    world_id: UUID


class WorldOut(BaseModel):
    """The session's world (ADR-0005 §2): `live`, or a demo sandbox (`visitor`)."""

    id: UUID
    label: str
    created_at: datetime
    personas: list[PersonaOut]
    assets: list[WorldAssetOut]
    me: MeOut | None  # the signed-in account (as GET /me), or null when anonymous


# ----- Communities (ADR-0005 §3, T68) -----


class CommunityCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=200)
    country: str | None = Field(default=None, max_length=10)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return clean_name(value)

    @field_validator("country")
    @classmethod
    def _country(cls, value: str | None) -> str | None:
        return clean_country(value)

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return clean_description(value)


class CommunityUpdate(BaseModel):
    """Only the fields sent change; `null` clears `country` or `description`."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    country: str | None = Field(default=None, max_length=10)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("A community needs a name")
        return clean_name(value)

    @field_validator("country")
    @classmethod
    def _country(cls, value: str | None) -> str | None:
        return clean_country(value)

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return clean_description(value)


class CommunityOut(BaseModel):
    """A community's public profile: no member or treasury identifiers."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    country: str | None
    description: str | None
    created_at: datetime


class MyCommunityOut(CommunityOut):
    """A community the caller belongs to, with the caller's role in it."""

    role: CommunityRole


class CommunityMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    name: str
    role: CommunityRole
    created_at: datetime


class CommunityMemberAdd(BaseModel):
    """Add a steward by account ID (not email: emails are never a claim of identity)."""

    model_config = ConfigDict(extra="forbid")

    user_id: UUID

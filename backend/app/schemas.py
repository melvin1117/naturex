"""API and agent output schemas (OpenAPI contract; frontend client is generated)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from app.auth import (
    EMAIL_MAX_LENGTH,
    NAME_MAX_LENGTH,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    is_valid_email,
    normalize_email,
)
from app.communities import clean_country, clean_description, clean_name
from app.market.offering import (
    DEFAULT_RETAINED_PCT,
    DEFAULT_TOTAL_SHARES,
    MAX_RETAINED_PCT,
    MAX_TOTAL_SHARES,
    MIN_RETAINED_PCT,
    MIN_TOTAL_SHARES,
)
from app.models import (
    AssetStatus,
    CommunityRole,
    LedgerKind,
    StreamEventType,
    UserKind,
    UserRole,
)
from app.tools.earth_obs import NdviPoint

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
    WITHDRAWN = "withdrawn"


_MOCK_DESCRIPTION = (
    "True when the latest report was rated from USE_MOCKS placeholder metrics (T58), not "
    "observed satellite data: show it as mock data."
)


class ReportSummarySource(StrEnum):
    LIVE = "live"
    FALLBACK = "fallback"
    AUDITOR = "auditor"


_ATTESTATION_REQUIRED = (
    "Confirm that your community has the right to list this land and that the details are "
    "true to the best of your knowledge."
)


class AssetCreate(BaseModel):
    """A draft listing in a community the caller owns or stewards (T58). The share terms are
    set at the IPO (T59), not here."""

    model_config = ConfigDict(extra="forbid")

    community_id: UUID
    name: str = Field(max_length=200)
    country: str | None = Field(default=None, max_length=10)
    description: str | None = Field(default=None, max_length=2000)
    geojson: dict[str, Any] = Field(
        description="GeoJSON Polygon or MultiPolygon (or a Feature wrapping one) in WGS84; "
        "10–50,000 ha, no self-intersection, no overlap with another listing in the world. "
        "Feature properties are dropped."
    )
    attestation: bool = Field(
        description="Must be true: the community attests it may list this land (ADR-0005)."
    )

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

    @field_validator("attestation")
    @classmethod
    def _attested(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError(_ATTESTATION_REQUIRED)
        return value


class AssetUpdate(BaseModel):
    """Edit a draft (T58). Only the fields sent change; `null` clears country or description."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=200)
    country: str | None = Field(default=None, max_length=10)
    description: str | None = Field(default=None, max_length=2000)
    geojson: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("A listing needs a name")
        return clean_name(value)

    @field_validator("country")
    @classmethod
    def _country(cls, value: str | None) -> str | None:
        return clean_country(value)

    @field_validator("description")
    @classmethod
    def _description(cls, value: str | None) -> str | None:
        return clean_description(value)

    @field_validator("geojson")
    @classmethod
    def _geojson(cls, value: dict[str, Any] | None) -> dict[str, Any]:
        if value is None:
            raise ValueError("A listing needs an area")
        return value


class AssetSubmitted(BaseModel):
    """A listing submitted for rating: follow the run with `GET /runs/{run_id}`."""

    asset_id: UUID
    run_id: UUID
    status: AssetStatusOut


class SuspendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Literal["moderation", "data_dispute", "community_request"]


class AssetCard(BaseModel):
    id: UUID
    name: str
    country: str | None = None
    status: AssetStatusOut
    status_reason: str | None = Field(
        default=None,
        description="Why the listing is in its status, as a code: listing gate failures "
        "(e.g. confidence_below_70), a suspension reason, no_satellite_metrics or "
        "rating_failed:<error> or rating_stale while rating (T58).",
    )
    mock: bool = Field(default=False, description=_MOCK_DESCRIPTION)
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
    sparkline: list[Decimal] = Field(
        default_factory=list,
        description="The latest prices (up to 30), oldest first, for the card's sparkline.",
    )
    trading: bool = Field(
        default=False,
        description="Orders are open: listed and its IPO launched (T59). False for a listing "
        "awaiting its IPO and for a suspended asset; orders on it are 409 not_trading.",
    )


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
    ndvi_series: list[NdviPoint] = Field(
        default_factory=list,
        description="Monthly NDVI behind the report's trend, oldest first (the rating's metrics "
        "row). Served on a single report (GET /reports/{id}, AssetDetail.latest_report); empty "
        "in the version list and when the report has none.",
    )
    created_at: datetime


class AssetDetail(BaseModel):
    id: UUID
    name: str
    country: str | None = None
    description: str | None = None
    community_id: UUID | None = None
    status: AssetStatusOut
    status_reason: str | None = Field(
        default=None, description="Why the listing is in its status (see AssetCard)."
    )
    area_ha: Decimal
    centroid_lat: float | None = None
    centroid_lon: float | None = None
    geojson: dict[str, Any]
    total_shares: int | None = Field(
        default=None,
        description="Shares issued at the IPO; null before it (ratings until then quote a fair "
        "value per share at 1,000,000 reference shares; T59).",
    )
    retained_pct: Decimal | None = Field(
        default=None, description="% the community's treasury kept at the IPO; null before it."
    )
    primary_shares_remaining: int
    community_wallet: Decimal
    site_key: str | None = None
    mock: bool = Field(default=False, description=_MOCK_DESCRIPTION)
    latest_report: ReportOut | None = None
    recent_events: list[EventOut] = Field(default_factory=list)
    price: Decimal | None = None
    price_change_pct: float | None = Field(
        default=None, description="Latest price vs the IPO price, in percent (2 dp); as on cards."
    )
    trading: bool = Field(default=False, description="See AssetCard.trading (T59).")
    ipo_at: datetime | None = Field(
        default=None, description="When the IPO opened trading; null before the IPO (T59)."
    )


class IpoLaunch(BaseModel):
    """The offering an owner launches (T59): shares issued and the % the community keeps."""

    model_config = ConfigDict(extra="forbid")

    total_shares: int = Field(
        default=DEFAULT_TOTAL_SHARES,
        ge=MIN_TOTAL_SHARES,
        le=MAX_TOTAL_SHARES,
        description="Shares issued at the IPO; the shares offered (the primary float) are "
        "total_shares × (1 − retained_pct/100), rounded down.",
    )
    retained_pct: Decimal = Field(
        default=DEFAULT_RETAINED_PCT,
        ge=MIN_RETAINED_PCT,
        le=MAX_RETAINED_PCT,
        decimal_places=2,
        description="Percent of the shares the community's treasury keeps (10–90).",
    )
    expected_price: Decimal = Field(
        gt=0,
        decimal_places=4,
        description="The price per share the owner confirmed in the preview (`ipo_price`; "
        "trailing zeros don't matter): 409 ipo_price_changed if a newer report moved it.",
    )


class IpoTermsOut(BaseModel):
    """The IPO price with every term of dev-spec §8's formula (play money, sandbox only)."""

    asset_id: UUID
    report_id: UUID
    report_version: int
    formula: str = Field(
        default="fair_value_total = value_mid × 10 × health_factor × confidence_factor; "
        "ipo_price = fair_value_per_share = fair_value_total / total_shares; "
        "shares_offered = total_shares × (1 − retained_pct/100)"
    )
    value_mid: Decimal = Field(description="Int$2020/yr from the latest report.")
    health: Decimal
    confidence: Decimal
    health_factor: Decimal = Field(description="0.5 + 0.5 × health/100")
    confidence_factor: Decimal = Field(description="0.7 + 0.3 × confidence/100")
    fair_value_total: Decimal
    total_shares: int
    fair_value_per_share: Decimal
    ipo_price: Decimal = Field(description="Equals fair_value_per_share.")
    retained_pct: Decimal
    shares_offered: int = Field(description="The primary float, sold to investors first.")
    retained_shares: int = Field(description="Held by the community's treasury.")


class IpoPreviewOut(IpoTermsOut):
    launchable: bool = Field(description="Whether POST /assets/{id}/ipo would go ahead now.")
    blocked_reason: str | None = Field(
        default=None,
        description="Why not, as the code the launch would return: ipo_price_too_high (a "
        "share costs more than a new account's starting cash: issue more shares), "
        "run_in_progress, or a verification code (T69).",
    )


class IpoOut(IpoTermsOut):
    launched_at: datetime


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
    max_total: Decimal | None = Field(
        default=None,
        ge=0,
        description="Buys only: refuse with 409 `price_moved` if the order would cost more "
        "(the total of the quote the user saw).",
    )
    min_total: Decimal | None = Field(
        default=None,
        ge=0,
        description="Sells only: refuse with 409 `price_moved` if the order would pay less.",
    )

    @model_validator(mode="after")
    def _limit_matches_side(self) -> OrderCreate:
        if self.side == "buy" and self.min_total is not None:
            raise ValueError("min_total applies to sells; use max_total for a buy")
        if self.side == "sell" and self.max_total is not None:
            raise ValueError("max_total applies to buys; use min_total for a sell")
        return self


class OrderOut(BaseModel):
    id: UUID
    asset_id: UUID
    side: Literal["buy", "sell"]
    qty: int
    fill_price: Decimal
    total: Decimal = Field(description="qty × fill_price in cents: what a buy paid or a sell got.")
    primary_qty: int = Field(description="Shares a buy took from the opening offer.")
    community_amount: Decimal = Field(
        description="The part of `total` paid to the community (primary shares × fill price)."
    )
    is_primary: bool
    created_at: datetime
    cash_balance: Decimal = Field(description="The trader's cash right after this fill.")
    shares_held: int = Field(description="The trader's shares of this asset after this fill.")


class QuoteOut(BaseModel):
    """The price of an order now, before confirming it (play money). Nothing is reserved: the
    order fills at the price when it's placed."""

    asset_id: UUID
    side: Literal["buy", "sell"]
    qty: int
    price: Decimal = Field(description="Latest price per share, before slippage.")
    fill_price: Decimal = Field(description="Price per share including slippage.")
    total: Decimal = Field(description="qty × fill_price in cents: the cost or the proceeds.")
    slippage_pct: Decimal = Field(description="Fill vs latest price, in percent (2 dp).")
    primary_qty: int = Field(description="Shares a buy takes from the opening offer.")
    community_amount: Decimal = Field(
        description="The part of a buy's total paid to the community (primary shares)."
    )
    max_qty: int | None = Field(
        default=None,
        description="The largest order on this side the signed-in user can place now (cash "
        "or holding, supply, size cap); null without a session.",
    )
    max_order_qty: int = Field(description="The size cap for one order on this asset.")


class HoldingOut(BaseModel):
    asset_id: UUID
    asset_name: str
    shares: int
    avg_cost: Decimal | None = None
    mark_price: Decimal | None = None
    market_value: Decimal | None = Field(default=None, description="shares × mark_price.")
    cost_basis: Decimal | None = Field(default=None, description="shares × avg_cost.")
    unrealized_pnl: Decimal | None = Field(default=None, description="market_value − cost_basis.")
    unrealized_pnl_pct: Decimal | None = Field(
        default=None, description="unrealized_pnl as a percentage of cost_basis (2 dp)."
    )


class ImpactSummary(BaseModel):
    ha_protected: Decimal
    t_co2_stored: Decimal
    services_usd_yr: Decimal


class PortfolioOut(BaseModel):
    cash_balance: Decimal
    holdings: list[HoldingOut]
    holdings_value: Decimal = Field(description="Sum of the priced holdings' market_value.")
    total_value: Decimal = Field(description="cash_balance + holdings_value.")
    cost_basis: Decimal = Field(description="Sum of the priced holdings' cost_basis.")
    unrealized_pnl: Decimal = Field(description="holdings_value − cost_basis.")
    unrealized_pnl_pct: Decimal | None = Field(
        default=None, description="unrealized_pnl as a percentage of cost_basis; null if 0."
    )
    starting_cash: Decimal = Field(description="The play money every account starts with.")
    since_start: Decimal = Field(
        description="total_value − starting_cash: realised and unrealised gains and dividends."
    )
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

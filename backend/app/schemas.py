"""API and agent output schemas (OpenAPI contract; frontend client is generated)."""

from __future__ import annotations

import unicodedata
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

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
    DocumentType,
    EvidenceKind,
    LedgerKind,
    ReviewerRole,
    StreamEventType,
    UserKind,
    UserRole,
    VerificationLevel,
    VerificationMode,
)
from app.tools.earth_obs import DateWindow, NdviPoint
from app.tools.field_evidence import (
    AuthenticityConcern,
    DateCheck,
    Disturbance,
    GpsCheck,
    LandCover,
    WaterClarity,
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


_OUTLINE_DESCRIPTION = (
    "The boundary's exterior ring per part, [lon, lat], simplified to at most 64 corners in "
    "all (holes dropped) when the area was saved: drawn on the card and hero maps. Empty for "
    "a curated site (it has a precomputed thumbnail) or an area that can't be read."
)


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
    outline: list[list[list[float]]] = Field(
        default_factory=list,
        description=_OUTLINE_DESCRIPTION,
    )
    sparkline: list[Decimal] = Field(
        default_factory=list,
        description="The latest prices (up to 30), oldest first, for the card's sparkline.",
    )
    trading: bool = Field(
        default=False,
        description="Orders are open: listed and its IPO launched (T59). False for a listing "
        "awaiting its IPO and for a suspended asset; orders on it are 409 not_trading.",
    )


class AssetOutline(BaseModel):
    """A public site's boundary, simplified for a map (T33)."""

    id: UUID
    name: str
    rings: list[list[list[float]]] = Field(
        description="The exterior ring of each part, [lon, lat], simplified to at most "
        "200 corners in all; holes dropped. A hint for drawing and overlap, never a check."
    )


class AssetOutlines(BaseModel):
    outlines: list[AssetOutline]
    truncated: bool = Field(
        description="More public sites exist than were returned (oldest first are kept)."
    )


class PlaceOut(BaseModel):
    """A place found by name (OpenStreetMap Nominatim), for flying the listing map there."""

    label: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    bbox: tuple[float, float, float, float] | None = Field(
        default=None, description="South, west, north, east in degrees, when Nominatim has one."
    )


class PlaceSearchOut(BaseModel):
    results: list[PlaceOut]
    attribution: str = Field(description="Credit to show next to the results.")


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


class CachedExample(BaseModel):
    """Demo worlds only (T60): the nearest precomputed demo site, shown with its notice next to
    a listing whose live satellite rating failed. Never the listing's own data."""

    asset_id: UUID
    name: str
    site_key: str
    distance_km: float
    notice: str


class OverlayBounds(BaseModel):
    """The overlay's extent in WGS84 degrees (Leaflet's `[[south, west], [north, east]]`)."""

    south: float
    west: float
    north: float
    east: float


class LandCoverOverlay(BaseModel):
    """A live-rated listing's Dynamic World land-cover overlay (#231), for a Leaflet
    `ImageOverlay`: the PNG at `GET /assets/{asset_id}/overlay.png?v={version}` spans `bounds`
    in Web Mercator, transparent outside the boundary. Same palette and method as the demo
    sites' precomputed overlay (`GET /media/demo-sites/{site_key}/images.json`)."""

    version: str = Field(description="Changes when the overlay is re-rendered (cache key).")
    media_type: Literal["image/png"] = "image/png"
    width: int
    height: int
    bounds: OverlayBounds
    crs: Literal["EPSG:3857"] = "EPSG:3857"
    dataset_id: str
    method: str
    date_window: DateWindow
    attributions: list[str]


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
    cover_image_url: str | None = Field(
        default=None, description="The listing's cover photo, as on its card; the page's hero."
    )
    site_key: str | None = None
    outline: list[list[list[float]]] = Field(default_factory=list, description=_OUTLINE_DESCRIPTION)
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
    cached_example: CachedExample | None = Field(
        default=None,
        description="Demo worlds only: a listing waiting in `rating` because its satellite "
        "metrics are missing or their live computation failed points to the nearest precomputed "
        "demo site, labelled as a cached example (T60). Always null in the live world.",
    )
    land_cover_overlay: LandCoverOverlay | None = Field(
        default=None,
        description="The listing's land-cover overlay from its live satellite rating (#231); "
        "null for demo sites (their overlay is precomputed: `site_key`), with mock or no "
        "satellite data, or when rendering failed.",
    )
    latest_run_id: UUID | None = Field(
        default=None,
        description="A listing under review's latest rating run (follow it with "
        "`GET /runs/{id}`), for its community's members and same-world admins, who alone can "
        "load it (T33). Null for public (listed or suspended) assets and before any run.",
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


class ListingVerificationOut(BaseModel):
    """A listing's verification for its community (#216): what stands, whether it blocks the
    listing now, and the latest decision with the reviewer's reason. Members and same-world
    admins only (the Steward home), and the owner (the IPO preview)."""

    level: VerificationLevel = Field(
        description="What stands, as the public panel says it: revoked while a revocation "
        "stands (even with a newer submission), else the current run's level, or unverified "
        "(no run, or the listing changed since it)."
    )
    in_review: bool = Field(description="A submission waits for a reviewer.")
    required: bool = Field(
        description="Verification blocks the listing now, as the IPO gate decides: the live "
        "world's opening offer needs a verified run, and a revocation blocks the offer and "
        "trading in every world until a new run is approved."
    )
    decision: VerificationLevel | None = Field(
        default=None,
        description="The latest decision (verified, rejected or revoked); null while none.",
    )
    decided_at: datetime | None = Field(default=None, description="When `decision` was made.")
    reason: str | None = Field(
        default=None, description="The reviewer's reason or note for `decision`, if any."
    )
    run_id: UUID | None = Field(
        default=None, description="The current run, while it still describes the listing."
    )


class IpoPreviewOut(IpoTermsOut):
    launchable: bool = Field(description="Whether POST /assets/{id}/ipo would go ahead now.")
    blocked_reason: str | None = Field(
        default=None,
        description="Why not, as the code the launch would return: ipo_price_too_high (a "
        "share costs more than a new account's starting cash: issue more shares), "
        "run_in_progress, or not_verified (the live world needs the listing's current "
        "verification run verified and still matching; a revoked one blocks everywhere; T69).",
    )
    verification: ListingVerificationOut = Field(
        description="Where the listing's verification stands, from the same reading as "
        "`blocked_reason` (#216)."
    )


class IpoOut(IpoTermsOut):
    launched_at: datetime


# ----- Field evidence (T40) -----

AnalysisStatus = Literal["pending", "completed", "failed", "not_run"]
AiAnalysisMode = Literal["model", "mock", "off"]


class FieldPhotoObservationOut(BaseModel):
    """The perception model's labels for a photo (untrusted; they can only fail a photo)."""

    shows_landscape: bool
    land_cover: list[LandCover]
    disturbance: list[Disturbance]
    water_clarity: WaterClarity
    authenticity_concerns: list[AuthenticityConcern]
    instruction_text: bool = Field(description="The image holds text aimed at an AI model.")


class FieldPhotoOut(BaseModel):
    """One field photo and its checks (the listing's community and same-world admins only).
    The photo, re-encoded without any metadata, is at `GET …/evidence/{id}/image`."""

    id: UUID
    asset_id: UUID
    created_at: datetime
    width: int
    height: int
    size_bytes: int = Field(description="The stored, re-encoded JPEG.")
    gps_check: GpsCheck = Field(
        description="EXIF position: inside the listing, near (within gps_buffer_m of its "
        "edge), outside, or missing. The position itself is never stored."
    )
    gps_distance_m: int | None = Field(
        description="Metres outside the listing's edge for `near` (at most gps_buffer_m); 0 "
        "inside; null when outside (only that it's over gps_buffer_m is kept) or missing."
    )
    gps_buffer_m: int
    date_check: DateCheck = Field(
        description="EXIF date taken: ok (at most max_age_days old, not in the future), "
        "missing, future or too_old."
    )
    taken_on: date | None
    max_age_days: int
    analysis_status: AnalysisStatus = Field(
        description="pending (the image model is reading it), completed, failed (no model "
        "answer, the AI budget is spent, or the analysis was lost) or not_run (a geotag check "
        "failed, or AI analysis is off: then the photo can't be validated)."
    )
    observation: FieldPhotoObservationOut | None
    validated: bool = Field(
        description="Validated field evidence: both geotag checks passed and the analysis "
        "found an outdoor landscape with no authenticity concern (rules in code)."
    )
    reasons: list[str] = Field(
        description="Why it isn't validated: gps_missing, gps_outside, taken_missing, "
        "taken_future, taken_too_old, not_analysed, not_a_landscape, no_land_cover, "
        "authenticity_concern, instruction_text."
    )
    event_id: UUID | None = Field(description="The evidence event of a validated photo.")


class ConfidenceEffectOut(BaseModel):
    current: Decimal | None = Field(description="The latest report's confidence.")
    projected: Decimal | None = Field(
        description="The next rating's confidence with the evidence counted (same inputs "
        "otherwise); null before the first rating."
    )
    points: Decimal = Field(
        description="Points validated evidence adds: 14.0 (0.2 × (1.0 − 0.3) × 100), or 0 "
        "when nothing is validated yet or the latest report already counts it."
    )
    counted: bool = Field(description="The latest report already used validated evidence.")
    listing_min: Decimal = Field(
        description="The confidence a rating needs to list (the listing gate's minimum); a "
        "`projected` below it would still leave the listing needing evidence."
    )


class FieldEvidenceOut(BaseModel):
    """A listing's field photos and their combined effect (the steward's view)."""

    photos: list[FieldPhotoOut]
    max_photos: int
    validated: int
    ai_analysis: AiAnalysisMode = Field(
        description="What reads the photos: model (MiniCPM-V on Nebius Token Factory, only "
        "with FIELD_EVIDENCE_AI_LIVE), mock (USE_MOCKS: a fake model, nothing sent) or off "
        "(no photo is sent to a model, so none is validated)."
    )
    confidence: ConfidenceEffectOut


class FieldEvidencePublicOut(BaseModel):
    """Aggregate field evidence for anyone who can see the asset: counts and labels only, never
    a photo, a position or who took it."""

    photos: int
    validated: int
    latest_taken_month: str | None = Field(
        pattern=r"^\d{4}-\d{2}$",
        description="`YYYY-MM` the latest validated photo was taken (never the day).",
    )
    land_cover: list[LandCover] = Field(description="Seen in validated photos.")
    disturbance: list[Disturbance] = Field(description="Seen in validated photos.")
    counted_in_latest_report: bool


class PricePoint(BaseModel):
    ts: datetime
    price: Decimal
    reason: str | None = None


MetricGroup = Literal["headline", "health", "confidence", "satellite", "valuation"]


class MetricChange(BaseModel):
    """One stored number that differs between two report versions (T37)."""

    id: str = Field(
        description="Stable key; it matches the Auditor's citation ID where one exists "
        "(e.g. `metric:landcover.built`, `score:threat_pressure`)."
    )
    label: str
    group: MetricGroup
    unit: str | None
    change: Literal["changed", "added", "removed"]
    old: Decimal | None = Field(description="Value in the older report; null if absent there.")
    new: Decimal | None = Field(description="Value in the newer report; null if absent there.")
    delta: Decimal | None = Field(description="`new - old`; null unless both are present.")
    reason_refs: list[int] = Field(
        description="Indexes into `ReportDiff.reasons` that cite this metric."
    )


class GradeChange(BaseModel):
    old: str | None
    new: str | None
    direction: Literal["up", "down"] | None = Field(
        description="`up` = a better grade; null if either grade is unknown."
    )


class DiffReason(BaseModel):
    """Why something changed, from stored data only: the Auditor's cited text, a stored event
    title, a flag's stored detail or a fixed template filled with stored codes (never new
    model text)."""

    source: Literal["auditor", "event", "flag", "data", "scenario"]
    version: int = Field(description="The report version this reason was recorded with.")
    code: str | None
    text: str
    citations: list[str]


class ReportDiff(BaseModel):
    report_id: UUID
    prev_report_id: UUID
    changes: list[str] = Field(
        description="Headline lines (health, grade, confidence, value_mid, fair_value_total)."
    )
    from_version: int
    to_version: int
    grade_change: GradeChange | None = Field(description="Null when the grade is unchanged.")
    metrics: list[MetricChange] = Field(
        description="Changed numbers only; unchanged ones are omitted."
    )
    reasons: list[DiffReason]


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


TradeBlockedReason = Literal[
    "insider_trading_blocked", "admins_cannot_trade", "treasury_cannot_act"
]


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
        "or holding, supply, size cap); 0 when `trade_blocked_reason` is set; null without a "
        "session.",
    )
    max_order_qty: int = Field(description="The size cap for one order on this asset.")
    trade_blocked_reason: TradeBlockedReason | None = Field(
        default=None,
        description="Why the signed-in user can't trade this asset at all (an order would get "
        "this 403): a member of its community, an admin or a treasury. Null when they can, or "
        "without a session.",
    )


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


COPILOT_QUESTION_MAX_CHARS = 500


class CopilotRequest(BaseModel):
    question: str = Field(min_length=1, max_length=COPILOT_QUESTION_MAX_CHARS)
    asset_id: UUID | None = Field(
        default=None,
        description="Ask about one asset (it must be visible in the caller's world); "
        "omit to search every visible asset of the world.",
    )

    @field_validator("question")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("question is blank")
        return value


class CopilotSource(BaseModel):
    """A report or news event the Copilot read for this answer; `ref` is its citation label."""

    ref: str = Field(description="Citation label used inline as [ref]: R{version} or E{8 hex}.")
    kind: Literal["report", "event"]
    asset_id: UUID
    asset_name: str
    title: str
    snippet: str
    report_id: UUID | None = None
    event_id: UUID | None = None
    version: int | None = None


class CopilotSourcesEvent(BaseModel):
    """First event: what was retrieved (the caller's world and visible assets only)."""

    type: Literal["sources"] = "sources"
    sources: list[CopilotSource]


class CopilotDeltaEvent(BaseModel):
    """A piece of the checked answer; the pieces concatenate to `done.answer`."""

    type: Literal["delta"] = "delta"
    text: str


class CopilotDoneEvent(BaseModel):
    type: Literal["done"] = "done"
    answer: str
    citations: list[CopilotSource] = Field(
        description="The sources cited in `answer`, in order of first use; every [ref] in the "
        "answer is one of them (others were removed before streaming)."
    )
    mode: Literal["model", "extractive", "refusal"] = Field(
        description="model: Nemotron's checked draft; extractive: quoted from the sources by "
        "code (mocks, or the model failed or is over budget); refusal: not in the record."
    )
    model: str | None = None


class CopilotErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    detail: str


CopilotStreamEvent = Annotated[
    CopilotSourcesEvent | CopilotDeltaEvent | CopilotDoneEvent | CopilotErrorEvent,
    Field(discriminator="type"),
]


class StreamEvent(BaseModel):
    id: int | None = Field(
        default=None,
        description="Monotonic world_events cursor; null for transient heartbeats",
    )
    type: StreamEventType
    payload: dict[str, Any]
    ts: datetime


AlertKindOut = Literal["grade_change", "health_change", "news", "verification"]
ALERT_KIND_DESCRIPTION = (
    "grade_change / health_change: a re-rate moved the grade or the health score by ≥ 5 points; "
    "news: a News Scout event of severity ≥ 4; verification: a reviewer approved or rejected the "
    "listing's documents, or revoked its verification (never the reviewer's reason)"
)


class AlertOut(BaseModel):
    """One alert delivered to the signed-in account (T75)."""

    id: UUID
    asset_id: UUID
    asset_name: str
    kind: AlertKindOut = Field(description=ALERT_KIND_DESCRIPTION)
    title: str
    message: str
    severity: int = Field(ge=1, le=5)
    url: str | None = Field(default=None, description="The news article (http/https only)")
    report_id: UUID | None = Field(default=None, description="The re-rate's report")
    created_at: datetime
    read_at: datetime | None = Field(default=None, description="null while unread")


class AlertListOut(BaseModel):
    alerts: list[AlertOut] = Field(description="One page, newest first")
    unread_count: int = Field(
        ge=0, description="Unread alerts matching the filter, on every page, not only this one"
    )
    next_before: UUID | None = Field(
        default=None, description="Pass as `before` for the next (older) page; null on the last"
    )


class AlertsMarkedOut(BaseModel):
    marked: int = Field(ge=0, description="Alerts that were unread and are now read")


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


class TraceCall(BaseModel):
    id: int | None = None
    agent: str | None = None
    model: str | None = None
    tier: str | None = None
    status: str
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int | None = None
    cost_usd: Decimal


class RunTraceStep(RatingRunStep):
    """A progress span with safe tool-result facts and metadata for every model attempt."""

    attempts: int | None = None
    output: dict[str, Any] | None = None
    llm_calls: list[TraceCall] = Field(default_factory=list)


class RunTraceTotals(BaseModel):
    """Every model call of a run, as the runner summed them when it sealed the report."""

    llm_calls: int
    prompt_tokens: int
    completion_tokens: int
    cost_usd: Decimal


class RunTraceOut(BaseModel):
    run_id: UUID
    asset_id: UUID
    status: RatingRunStatus
    steps: list[RunTraceStep]
    totals: RunTraceTotals | None = Field(
        default=None, description="The sealed run's totals; null until the run seals a report"
    )


PresetNameOut = Literal["fire", "encroachment", "drought", "restoration", "protection"]


class TimeMachineQuarter(BaseModel):
    """One entry of the Time Machine timeline (`data/demo_sites/scenarios.json`)."""

    step: int = Field(description="0 is the observed baseline.")
    period: str = Field(description="The quarter it is shown as, e.g. `2026Q4`.")
    scenario: str
    data_version: str | None = Field(
        description="`sim-N` for a simulated quarter; null for the observed baseline."
    )


class EventPresetOut(BaseModel):
    preset: PresetNameOut
    label: str
    impact_type: str
    direction: int = Field(description="-1 harms the site, 1 helps it.")
    severity: int
    alerts: bool = Field(
        description="Severity ≥ 4: the event itself alerts the holders and community (besides "
        "any alert the re-rate raises)."
    )
    description: str = Field(
        description="The generic effect; curated sites use their own scripted encroachment and "
        "restoration."
    )


QuarterJobStatus = Literal["queued", "running", "done", "stopped", "failed"]


class QuarterJobRef(BaseModel):
    id: UUID
    status: QuarterJobStatus
    period: str


class TimeMachineOut(BaseModel):
    """Where the caller's world stands on the Time Machine timeline (T38)."""

    available: bool = Field(
        description="False outside a sandbox (the live world): hide the Time Machine; both "
        "actions answer 409 `time_machine_sandbox_only`."
    )
    unavailable_reason: Literal["time_machine_sandbox_only"] | None = Field(
        default=None, description="Why `available` is false."
    )
    step: int
    current: TimeMachineQuarter
    next: TimeMachineQuarter | None = Field(
        description="The quarter `POST /admin/simulate/quarter` advances to; null at the end of "
        "the timeline (reset the demo to start again)."
    )
    timeline: list[TimeMachineQuarter]
    presets: list[EventPresetOut]
    local_jobs: bool = Field(description="False: `Next quarter` is off (`LOCAL_JOBS=false`).")
    quarter_job: QuarterJobRef | None = Field(
        default=None,
        description="The world's latest `Next quarter` job (#201), so a reloaded panel follows "
        "a running one; null before the first.",
    )


class SimulateQuarterRequest(BaseModel):
    period: str = Field(
        pattern=r"^\d{4}Q[1-4]$",
        description="The quarter to run: the world's next quarter (advances it) or its current "
        "one (replays it: only what failed is redone, nothing is paid twice).",
    )


class AssetRatingOut(BaseModel):
    """An asset's latest report and price at one moment, as stored."""

    report_id: UUID
    version: int
    health_score: Decimal | None = None
    grade: str | None = None
    data_version: str | None = None
    simulated: bool
    fair_value_per_share: Decimal | None = None
    price: Decimal | None = Field(default=None, description="Null before the IPO.")


class SimulatedAssetOut(BaseModel):
    asset_id: UUID
    name: str
    status: Literal["rerated", "already_done", "skipped", "failed", "in_progress", "stopped"]
    detail: str | None = Field(
        default=None,
        description="Why it was skipped, failed or stopped (`no_time_machine_version`, "
        "`no_current_metrics`, `rating_rate_limited`, `llm_budget_exhausted`, a run error…).",
    )
    run_id: UUID | None = None
    before: AssetRatingOut | None = None
    after: AssetRatingOut | None = None
    alert_ids: list[UUID] = Field(default_factory=list)
    payout: Literal["paid", "already_paid", "skipped", "failed"] | None = None
    payout_detail: str | None = None


class SimulateQuarterResponse(BaseModel):
    """What a Time Machine quarter actually did, per listed asset."""

    step: int
    period: str
    scenario: str
    data_version: str
    payout_label: str = Field(description="The payouts' `quarter_label`, e.g. `2026Q4-sim-1`.")
    replayed: bool = Field(description="True when the world was already at this quarter.")
    assets_rerated: int
    assets_failed: int
    assets_skipped: int
    payouts: int
    alerts: int
    stopped: str | None = Field(
        default=None,
        description="`llm_budget_exhausted`, `job_budget_exhausted` or a rate limit: later "
        "assets weren't re-rated; replay the quarter to finish them.",
    )
    assets: list[SimulatedAssetOut]


class QuarterJobOut(SimulateQuarterResponse):
    """A `Next quarter` running in the background (#201): `POST /admin/simulate/quarter`
    answers 202 with it, `GET /admin/simulate/quarter/{job_id}` reads it. `assets` grows as each
    asset's re-rate and payout settle; the totals count those assets."""

    id: UUID
    status: QuarterJobStatus = Field(
        description="`queued`, `running`, `done` (every asset settled; some may have failed: "
        "replay to retry them), `stopped` (see `stopped`; replay to finish) or `failed` (see "
        "`error`; replay to finish)."
    )
    error: str | None = Field(
        default=None, description="Why the job itself failed (`job_failed:<Exception>`)."
    )
    asset_count: int | None = Field(
        default=None, description="The listed assets the quarter re-rates; null until it starts."
    )
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None = None


class SimulateEventRequest(BaseModel):
    asset_id: UUID
    preset: PresetNameOut


class SimulateEventResponse(BaseModel):
    event: EventOut
    preset: PresetNameOut
    period: str
    data_version: str
    description: str = Field(description="The deterministic change applied to the metrics.")
    run_id: UUID | None = None
    before: AssetRatingOut | None = None
    after: AssetRatingOut | None = None
    alert_ids: list[UUID] = Field(default_factory=list)
    alert_created: bool


class SentAlertOut(BaseModel):
    """An alert as its recipients got it, for the admin who raised it (T43)."""

    id: UUID
    asset_id: UUID
    asset_name: str
    kind: AlertKindOut = Field(description=ALERT_KIND_DESCRIPTION)
    title: str
    message: str
    severity: int = Field(ge=1, le=5)
    url: str | None = None
    report_id: UUID | None = None
    created_at: datetime
    recipients: int = Field(
        ge=0, description="Accounts it was delivered to (holders and community members)"
    )


class TraceStep(BaseModel):
    agent: str | None
    model: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    latency_ms: int | None
    created_at: datetime
    status: str = "ok"


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


def _contains_secret(text: str, secret: str) -> bool:
    """Whether `text` holds `secret`, ignoring case, Unicode form and the secret's edge spaces."""
    needle = unicodedata.normalize("NFKC", secret).strip().casefold()
    return bool(needle) and needle in unicodedata.normalize("NFKC", text).casefold()


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
    def _name(cls, value: str, info: ValidationInfo) -> str:
        name = value.strip()
        if not name or not name.isprintable():
            raise ValueError("Enter a display name")
        # The name is public; refuse one holding the password (typed into the wrong field).
        # `password` is in `info.data` only because it's declared (and validated) before `name`.
        password = info.data.get("password")
        if isinstance(password, SecretStr) and _contains_secret(name, password.get_secret_value()):
            raise PydanticCustomError(
                "name_contains_password", "The display name can't contain the password"
            )
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
    document_ai_check: Literal["off", "samples_only", "uploads"] = Field(
        description="What the AI document check (T71) does with a steward's own verification "
        "upload in this world, for the uploader notice (ADR-0006 §5): `uploads` (its sanitised "
        "preview may be sent to an AI model on Nebius Token Factory when submitted), "
        "`samples_only` (a sandbox: only NatureX sample documents are sent, never an upload) "
        "or `off` (the live world while `VERIFICATION_AI_LIVE=false`)."
    )


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


# ----- Steward home (T63) -----


class NextAction(StrEnum):
    """What the Steward home offers to do next with a listing."""

    CONTINUE_LISTING = "continue_listing"
    RATING_IN_PROGRESS = "rating_in_progress"
    ADD_EVIDENCE = "add_evidence"
    VERIFY = "verify"
    VERIFICATION_IN_REVIEW = "verification_in_review"
    AWAITING_VERIFICATION = "awaiting_verification"
    LAUNCH_IPO = "launch_ipo"
    AWAITING_IPO = "awaiting_ipo"
    VIEW_ON_EXCHANGE = "view_on_exchange"
    NONE = "none"


class ListingManageAction(StrEnum):
    """A change a member may make to a listing now, as the lifecycle allows it (#233)."""

    EDIT = "edit"
    """`PATCH /assets/{id}`: a draft's details and boundary."""
    WITHDRAW = "withdraw"
    """`POST /assets/{id}/withdraw`: a listing never listed, with no rating run active."""


class WalletOut(BaseModel):
    """Play money. `balance` is the community wallet (`community_wallet`) and equals
    `ipo_proceeds + community_fund_payouts`; `retained_dividends` went to the treasury for its
    retained stake. `total_received` is all three: the wallet plus those dividends."""

    balance: Decimal
    ipo_proceeds: Decimal = Field(description="Σ primary-float purchases (qty × IPO-float price).")
    community_fund_payouts: Decimal = Field(
        description="Σ `community_wallet_credit` of the quarterly payouts."
    )
    retained_dividends: Decimal = Field(
        description="Dividends paid to the treasury for its retained stake."
    )
    total_received: Decimal


class TopHolderOut(BaseModel):
    """An investor ranked by shares, without a name or account ID."""

    rank: int
    shares: int
    pct_of_shares: Decimal = Field(description="Of the listing's total shares, 2 dp.")


class HoldersOut(BaseModel):
    count: int
    shares_held: int = Field(description="Shares investors hold; the retained stake excluded.")
    top: list[TopHolderOut]


class SharesOut(BaseModel):
    shares_offered: int
    shares_sold: int = Field(description="Bought from the IPO float so far.")
    retained_shares: int


class ListingSummaryOut(BaseModel):
    asset: AssetCard
    next_action: NextAction = Field(
        description="continue_listing (draft), rating_in_progress, add_evidence "
        "(needs_evidence), verify (members: verification blocks the opening offer or "
        "trading; upload and submit documents), verification_in_review (the same, with a "
        "submission waiting for a reviewer), awaiting_verification (the same for same-world "
        "admins, who aren't members), launch_ipo (listed, not launched; owner), awaiting_ipo "
        "(the same for stewards and admins), view_on_exchange (trading or suspended), none "
        "(ineligible, withdrawn)."
    )
    verification: ListingVerificationOut
    ipo_at: datetime | None
    updated_at: datetime = Field(
        description="When the listing last changed: its newest Nature Ledger entry (a "
        "lifecycle step, a report, a verification decision, its opening offer or a payout), "
        "else when it was created."
    )
    manage_actions: list[ListingManageAction] = Field(
        description="What the caller may change now (members only; empty for an admin): edit "
        "(a draft) and withdraw (a draft, needs_evidence, or rating with no active run). "
        "The same rules as the routes, so the Steward app never offers a refused step."
    )
    wallet: WalletOut
    holders: HoldersOut
    shares: SharesOut | None = Field(description="None before the IPO: no shares exist yet.")
    recommendations: list[str] = Field(
        description="The Auditor's stewardship recommendations from the latest report."
    )
    report_version: int | None


class PayoutSummaryOut(BaseModel):
    asset_id: UUID
    asset_name: str
    quarter_label: str
    revenue: Decimal
    community_fund: Decimal = Field(description="Credited to the community wallet.")
    dividends_total: Decimal
    retained_dividend: Decimal = Field(description="The treasury's share of the dividends.")
    holder_count: int
    paid_at: datetime


class CommunitySummaryOut(BaseModel):
    """The Steward home (T63): members and same-world admins only. Play money; holders are
    counted and ranked without names or account IDs."""

    community: CommunityOut
    role: CommunityRole | None = Field(description="The caller's role; null for an admin.")
    listings: list[ListingSummaryOut]
    wallet: WalletOut
    holder_count: int = Field(description="Distinct investors holding any of its listings.")
    payouts: list[PayoutSummaryOut] = Field(
        description="The latest quarterly payouts, newest first."
    )
    payouts_count: int


# ----- Listing verification (T69, ADR-0006) -----

VERIFICATION_REASON_MAX_LENGTH = 500
CheckResultOut = Literal["pass", "warn", "fail"]


def _clean_reason(raw: str | None) -> str | None:
    """Printable text and line breaks, at most 500 characters once trimmed; empty means none."""
    if raw is None or not raw.strip():
        return None
    reason = raw.strip()
    if len(reason) > VERIFICATION_REASON_MAX_LENGTH:
        raise ValueError(f"Use at most {VERIFICATION_REASON_MAX_LENGTH} characters")
    if any(not (ch.isprintable() or ch in "\n\t") for ch in reason):
        raise ValueError("Remove control characters")
    return reason


class VerificationCheckOut(BaseModel):
    """One deterministic check of a run, with the value found and where it came from."""

    check: str = Field(description="accepted_format, not_reused, boundary_free or consent_document")
    result: CheckResultOut
    found: str
    source: str


class PublicCheckOut(BaseModel):
    """A check's name and result only: the public panel never shows the values."""

    check: str
    result: CheckResultOut


class ListingDocumentOut(BaseModel):
    """A verification document's metadata (the listing's community and same-world admins
    only). The file is at `GET /assets/{asset_id}/documents/{id}` (a download), its sanitised
    preview at `…/preview`."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    asset_id: UUID
    submitted: bool = Field(
        description="It's in a run (a submission). A waiting run's documents carry into the "
        "next submission (#210), so one document may be in several runs; each run lists its own."
    )
    doc_type: DocumentType
    media_type: str
    size_bytes: int
    page_count: int | None = Field(default=None, description="PDFs only.")
    width: int | None = Field(default=None, description="Images only, in pixels.")
    height: int | None = None
    has_preview: bool = Field(
        description="A sanitised PNG preview exists: every image, and a PDF whose first page "
        "holds an image (a scan)."
    )
    commitment: str = Field(
        description="sha256(private nonce ‖ file): what the public ledger holds for this "
        "document. It can't be matched against a copy of the file without the nonce."
    )
    created_at: datetime


class VerificationRunOut(BaseModel):
    """A verification run, for the listing's community and same-world admins: the checklist
    with values, the documents, and the reviewer's reasons (never the reviewer's identity)."""

    id: UUID
    asset_id: UUID
    level: VerificationLevel = Field(description="The run's stored level.")
    effective_level: VerificationLevel = Field(
        description="`unverified` once the listing's name, area, polygon or community changed "
        "since the run (its fingerprint no longer matches); else `level`."
    )
    is_current: bool
    fingerprint_matches: bool
    input_fingerprint: str
    method_version: str
    mode: VerificationMode
    evidence_kind: EvidenceKind
    checklist: list[VerificationCheckOut]
    documents: list[ListingDocumentOut]
    created_at: datetime
    reviewer_role: ReviewerRole | None = None
    reason: str | None = Field(default=None, description="The reviewer's reason, if any.")
    decided_at: datetime | None = None
    revoke_reason: str | None = None
    revoked_at: datetime | None = None


class VerificationPublicOut(BaseModel):
    """ "How this listing was verified" (ADR-0006 §4): public, for anyone who can see the asset.
    Check names and results only; what was *not* checked is always listed."""

    asset_id: UUID
    level: VerificationLevel = Field(
        description="The current run's level, or `unverified` when there is none or the "
        "listing changed since it."
    )
    badge: str = Field(
        description="`Documents reviewed by NatureX (hackathon process)` when verified, "
        "`Verification revoked`, else `Self-attested by the community`."
    )
    run_id: UUID | None = None
    submitted_at: datetime | None = None
    decided_at: datetime | None = None
    revoked_at: datetime | None = None
    reviewer_role: ReviewerRole | None = None
    method_version: str | None = None
    checks: list[PublicCheckOut] = Field(default_factory=list)
    not_checked: list[str]
    ledger_seq: int | None = Field(
        default=None, description="The `verification` ledger entry of the latest decision."
    )


class VerificationSubmit(BaseModel):
    """Submit 1–3 of the listing's uploaded, not yet submitted documents for review. While the
    current run still waits for a decision, its documents are kept in the new run too (at most 3
    in all), except those listed in `remove_document_ids`."""

    model_config = ConfigDict(extra="forbid")

    document_ids: list[UUID] = Field(
        min_length=1, max_length=3, description="New documents: never submitted before."
    )
    remove_document_ids: list[UUID] = Field(
        default_factory=list,
        max_length=3,
        description="Documents of the waiting run to leave out of the new one.",
    )

    @field_validator("document_ids", "remove_document_ids")
    @classmethod
    def _distinct(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("List each document once")
        return value


class VerificationApprove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(
        default=None, description="Optional note for the steward (at most 500 characters)."
    )

    @field_validator("reason")
    @classmethod
    def _reason(cls, value: str | None) -> str | None:
        return _clean_reason(value)


class VerificationReason(BaseModel):
    """A rejection or revocation: the reason is required and shown to the steward."""

    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=VERIFICATION_REASON_MAX_LENGTH + 200)

    @field_validator("reason")
    @classmethod
    def _reason(cls, value: str) -> str:
        cleaned = _clean_reason(value)
        if cleaned is None:
            raise ValueError("A reason is required")
        return cleaned


class AiExtractedField(BaseModel):
    """A value a model read off a document, and the verbatim excerpt around it. Attacker-written
    text: render it as plain text, never as HTML or Markdown."""

    value: str | None
    excerpt: str | None


class AiDocumentReadingOut(BaseModel):
    """What the model read from one document's sanitised preview (T71)."""

    document_id: UUID
    doc_type: DocumentType
    sent_to_model: bool
    not_sent_reason: Literal["no_preview", "not_sample"] | None = Field(
        description="`no_preview`: the document has no sanitised preview (a PDF without a "
        "scanned image on page 1). `not_sample`: a sandbox sends only sample documents."
    )
    readable: bool
    holder_name: AiExtractedField
    parcel_id: AiExtractedField
    place: AiExtractedField
    area: AiExtractedField = Field(description="The number and unit as read, e.g. `144 ha`.")
    area_ha: Decimal | None = Field(
        description="The area in hectares, converted in code, when the area comparison used it."
    )
    issue_date: AiExtractedField
    instruction_like_text: bool = Field(
        description="Text aimed at an AI model was found: a sign of manipulation."
    )


class AiComparisonOut(BaseModel):
    """One field of one document compared with the listing: both values, the excerpt, the verdict
    and why. `compared_by`: `model` (Nemotron, holder name and place) or `code` (always the area,
    and fields that couldn't or mustn't go to a model)."""

    document_id: UUID
    field: Literal["holder_name", "place", "area"]
    listing_value: str | None
    document_value: str | None
    excerpt: str | None
    verdict: Literal["match", "mismatch", "unclear", "not_applicable"]
    reason: str
    compared_by: Literal["model", "code"]


class AiSuggestionResult(BaseModel):
    """The AI document check's result, as stored (T71)."""

    suggestion: Literal["consistent", "inconsistent", "unreadable"]
    reasons: list[str]
    comparisons: list[AiComparisonOut]
    documents: list[AiDocumentReadingOut]
    flags: list[str] = Field(
        description="instruction_like_text (a document), listing_instruction_like_text (the "
        "listing's community or place names), documents_not_sent, place_not_geocoded, "
        "reason_withheld, mock_model, readings_reused (a document carried from an earlier "
        "submission wasn't read again: its earlier reading was compared anew)"
    )
    models: list[str]
    method_version: str


AI_SUGGESTION_NOTICE = (
    "Untrusted AI heuristic: read from the uploaded documents by AI models, which can be wrong "
    "or manipulated by the documents themselves. It never changes the checks or the "
    "verification level; a person decides."
)


class AiSuggestionOut(BaseModel):
    """The AI document check of a run (T71, ADR-0006 §2), for the reviewer only. **Untrusted
    heuristic**: show it labelled as such, next to its excerpts; it never changed a check or the
    level. `status: failed` means no model answered (or the budget was spent): `suggestion` is
    null. A run has no AI suggestion while the check is pending or when it doesn't run (the live
    world while `VERIFICATION_AI_LIVE=false`): see the queue item's `ai_suggestion_status`."""

    trust: Literal["untrusted_heuristic"] = "untrusted_heuristic"
    notice: str = AI_SUGGESTION_NOTICE
    run_id: UUID
    status: Literal["completed", "failed"]
    suggestion: Literal["consistent", "inconsistent", "unreadable"] | None
    reasons: list[str]
    comparisons: list[AiComparisonOut]
    documents: list[AiDocumentReadingOut]
    flags: list[str]
    models: list[str]
    method_version: str
    created_at: datetime


class DecidedListingItem(BaseModel):
    """A listing whose current run was decided (#211): the run, with its decision and documents."""

    asset_id: UUID
    asset_name: str
    asset_status: AssetStatusOut
    community_id: UUID | None
    run: VerificationRunOut
    last_decision_at: datetime = Field(
        description="When the run was revoked, else when it was decided: the list's order."
    )


class ReviewQueueItem(BaseModel):
    """A listing waiting for a reviewer: its current, undecided run."""

    asset_id: UUID
    asset_name: str
    asset_status: AssetStatusOut
    community_id: UUID | None
    run: VerificationRunOut
    ai_suggestion_status: Literal["pending", "not_run", "completed", "failed"] = Field(
        description="The run's AI document check: `pending` (queued or running, for up to 15 "
        "minutes after submission), `not_run` (off in this world, or no document may be sent "
        "to a model), `completed`, or `failed` (no model answer, a spent budget, an error, a "
        "lost job or a stored result that no longer reads)."
    )
    ai_suggestion: AiSuggestionOut | None = Field(
        default=None,
        description="The AI document check's result: an untrusted heuristic (see its `trust` "
        "and `notice`). Present when `ai_suggestion_status` is `completed`, and when `failed` "
        "with a stored result; null otherwise.",
    )

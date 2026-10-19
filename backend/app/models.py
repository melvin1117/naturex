"""SQLModel tables for NatureX v1 (dev-spec §5 + world_id sandbox)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKeyConstraint,
    Index,
    LargeBinary,
    SmallInteger,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    """Timezone-aware now(), required by SQLModel for TIMESTAMPTZ columns."""
    return datetime.now(UTC)


def _enum_values(enum_cls: type[StrEnum]) -> list[str]:
    return [member.value for member in enum_cls]


def _enum_column(enum_cls: type[StrEnum], server_default: str | None = None) -> Column[Any]:
    """Store enum .value (matches DB CHECK constraints), not SQLAlchemy's default .name."""
    return Column(
        SAEnum(enum_cls, values_callable=_enum_values, native_enum=False),
        nullable=False,
        server_default=server_default,
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


class UserKind(StrEnum):
    """ADR-0005 §3: only a `person` signs in with a password; treasuries never sign in or trade."""

    PERSON = "person"
    PERSONA = "persona"
    TREASURY = "treasury"


class SessionKind(StrEnum):
    PASSWORD = "password"
    DEMO = "demo"  # T55


class CommunityRole(StrEnum):
    """ADR-0005 §3: community roles come from membership, not from `users.role`."""

    OWNER = "owner"
    STEWARD = "steward"


class AuthBucket(StrEnum):
    IP = "ip"
    ACCOUNT = "account"


class AuthAttemptKind(StrEnum):
    LOGIN = "login"
    REGISTER = "register"


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
    LISTING_STATUS = "listing_status"


class World(SQLModel, table=True):
    __tablename__ = "worlds"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    label: str = Field(index=True)
    created_at: datetime = _created_at()
    last_seen_at: datetime = _created_at()  # bumped on each visit; stale sandboxes are pruned (T31)


class User(SQLModel, table=True):
    __tablename__ = "users"
    __table_args__ = (
        # Target of composite foreign keys, so rows can't link across worlds (ADR-0005 §3).
        UniqueConstraint("world_id", "id", name="uq_users_world_id_id"),
        # Email is unique per world, case-insensitively; personas and treasuries have none.
        Index(
            "users_world_email",
            "world_id",
            text("lower(email)"),
            unique=True,
            postgresql_where=text("email IS NOT NULL"),
        ),
        # One persona per key per world, so a sandbox reset can keep persona IDs by key (T56).
        Index(
            "uq_users_world_persona_key",
            "world_id",
            "persona_key",
            unique=True,
            postgresql_where=text("persona_key IS NOT NULL"),
        ),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    name: str
    role: UserRole = Field(sa_column=_enum_column(UserRole))  # persona label, not authorization
    cash_balance: Decimal = Field(default=Decimal("10000.00"), max_digits=14, decimal_places=2)
    persona_key: str | None = Field(default=None, index=True)
    kind: UserKind = Field(
        default=UserKind.PERSONA, sa_column=_enum_column(UserKind, server_default="persona")
    )
    email: str | None = None  # normalised (stripped, lower-cased); only for kind = person
    password_hash: str | None = None  # argon2id (pwdlib); never returned or logged
    is_admin: bool = Field(default=False, sa_column_kwargs={"server_default": text("false")})


class UserSession(SQLModel, table=True):
    """A server-side session (ADR-0005 §1). Only the SHA-256 of the cookie token is stored."""

    __tablename__ = "sessions"
    __table_args__ = (
        ForeignKeyConstraint(
            ["world_id", "user_id"], ["users.world_id", "users.id"], name="fk_sessions_user"
        ),
        UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        Index("ix_sessions_world_id_user_id", "world_id", "user_id"),
        Index("ix_sessions_expires_at", "expires_at"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    token_hash: str = Field(sa_column=Column(String(64), nullable=False))
    world_id: UUID
    user_id: UUID
    kind: SessionKind = Field(sa_column=_enum_column(SessionKind))
    created_at: datetime = _created_at()
    last_seen_at: datetime = _created_at()  # bumped at most every few minutes; 7 d idle limit
    expires_at: datetime = Field(sa_type=DateTime(timezone=True))  # 30 d absolute limit


class AuthAttempt(SQLModel, table=True):
    """One counted sign-in or registration attempt (ADR-0005 section 1, T66).

    Only HMACs are stored, so neither an email nor an IP address can be read back from the table.
    """

    __tablename__ = "auth_attempts"
    __table_args__ = (
        Index("ix_auth_attempts_bucket_key_hmac_created_at", "bucket", "key_hmac", "created_at"),
        Index("ix_auth_attempts_created_at", "created_at"),
    )

    id: int | None = Field(
        default=None,
        sa_column=Column(BigInteger, primary_key=True, autoincrement=True),
    )
    bucket: AuthBucket = Field(sa_column=_enum_column(AuthBucket))
    key_hmac: str = Field(sa_column=Column(String(64), nullable=False))
    kind: AuthAttemptKind = Field(sa_column=_enum_column(AuthAttemptKind))
    created_at: datetime = _created_at()


# Community names are unique per world, case-insensitively (T68 review; migration 0011).
COMMUNITY_NAME_INDEX = "uq_communities_world_lower_name"


class Community(SQLModel, table=True):
    """A community that manages listings (ADR-0005 §3, T56). Roles come from `community_members`.

    Every community has exactly one `treasury` account, created with it: it never signs in or
    trades, holds the community's retained stake and receives its dividends (T41). Every
    reference is a composite `(world_id, …)` foreign key, so nothing links across worlds.
    """

    __tablename__ = "communities"
    __table_args__ = (
        UniqueConstraint("world_id", "id", name="uq_communities_world_id_id"),
        # Target of `fk_assets_community_treasury`: an asset's treasury is its community's.
        UniqueConstraint(
            "world_id", "id", "treasury_user_id", name="uq_communities_world_id_id_treasury"
        ),
        UniqueConstraint("treasury_user_id", name="uq_communities_treasury_user_id"),
        Index(COMMUNITY_NAME_INDEX, "world_id", text("lower(name)"), unique=True),
        ForeignKeyConstraint(
            ["world_id", "treasury_user_id"],
            ["users.world_id", "users.id"],
            name="fk_communities_treasury_user",
        ),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id")  # indexed by uq_communities_world_id_id
    name: str
    country: str | None = None
    description: str | None = None
    treasury_user_id: UUID  # kind = 'treasury' (DB trigger `communities_treasury_kind`)
    created_at: datetime = _created_at()


class CommunityMember(SQLModel, table=True):
    """A user's role in a community (ADR-0005 §3). Treasuries can't be members (DB trigger)."""

    __tablename__ = "community_members"
    __table_args__ = (
        ForeignKeyConstraint(
            ["world_id", "community_id"],
            ["communities.world_id", "communities.id"],
            name="fk_community_members_community",
        ),
        ForeignKeyConstraint(
            ["world_id", "user_id"],
            ["users.world_id", "users.id"],
            name="fk_community_members_user",
        ),
        # "Which communities is this user a member of?" (T68 authorize, insider-trading rule).
        Index("ix_community_members_world_id_user_id", "world_id", "user_id"),
    )

    community_id: UUID = Field(primary_key=True)
    user_id: UUID = Field(primary_key=True)
    world_id: UUID
    role: CommunityRole = Field(sa_column=_enum_column(CommunityRole))
    created_at: datetime = _created_at()


class Asset(SQLModel, table=True):
    __tablename__ = "assets"
    __table_args__ = (
        # Target of composite foreign keys, so private rows can't link across worlds (T67).
        UniqueConstraint("world_id", "id", name="uq_assets_world_id_id"),
        ForeignKeyConstraint(
            ["world_id", "community_id"],
            ["communities.world_id", "communities.id"],
            name="fk_assets_community",
        ),
        ForeignKeyConstraint(
            ["world_id", "community_user_id"],
            ["users.world_id", "users.id"],
            name="fk_assets_community_user",
        ),
        # When both are set, the asset's treasury must be its community's treasury (T56).
        ForeignKeyConstraint(
            ["world_id", "community_id", "community_user_id"],
            ["communities.world_id", "communities.id", "communities.treasury_user_id"],
            name="fk_assets_community_treasury",
        ),
        Index("ix_assets_world_id_community_id", "world_id", "community_id"),
        Index("ix_assets_world_id_community_user_id", "world_id", "community_user_id"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    name: str
    community_id: UUID | None = None  # the community that manages the listing (ADR-0005)
    # The community's treasury: holds the retained stake and receives its dividends (T41, T56).
    community_user_id: UUID | None = None
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
    # Why the listing is in its status (gate failure codes, suspension reason…; T58).
    status_reason: str | None = Field(default=None, max_length=200)
    # When the community attested it may list this land (T58); NULL for curated sites.
    attested_at: datetime | None = Field(default=None, sa_type=DateTime(timezone=True))
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
    flags: list[dict[str, Any]] | None = Field(default=None, sa_column=Column(JSONB))
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
    __table_args__ = (
        # A holding's user and asset are in its own world (ADR-0005 §3, #144).
        ForeignKeyConstraint(
            ["world_id", "user_id"], ["users.world_id", "users.id"], name="fk_holdings_user"
        ),
        ForeignKeyConstraint(
            ["world_id", "asset_id"], ["assets.world_id", "assets.id"], name="fk_holdings_asset"
        ),
        # The primary key covers (world_id, user_id); this covers the asset key and holder lists.
        Index("ix_holdings_world_id_asset_id", "world_id", "asset_id"),
    )

    world_id: UUID = Field(foreign_key="worlds.id", primary_key=True)
    user_id: UUID = Field(primary_key=True)
    asset_id: UUID = Field(primary_key=True)
    shares: int = Field(default=0, sa_column=Column(BigInteger, nullable=False))
    avg_cost: Decimal | None = Field(default=None, max_digits=12, decimal_places=4)


class Order(SQLModel, table=True):
    __tablename__ = "orders"
    __table_args__ = (
        # An order's user and asset are in its own world (ADR-0005 §3, #144).
        ForeignKeyConstraint(
            ["world_id", "user_id"], ["users.world_id", "users.id"], name="fk_orders_user"
        ),
        ForeignKeyConstraint(
            ["world_id", "asset_id"], ["assets.world_id", "assets.id"], name="fk_orders_asset"
        ),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    world_id: UUID = Field(foreign_key="worlds.id", index=True)
    user_id: UUID = Field(index=True)
    asset_id: UUID = Field(index=True)
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
    __table_args__ = (
        UniqueConstraint("asset_id", "seq", name="uq_ledger_asset_seq"),
        # One payout per asset quarter (T67), behind `pay_quarter`'s check under the asset lock.
        Index(
            "uq_ledger_payout_quarter",
            "asset_id",
            text("(payload ->> 'quarter_label')"),
            unique=True,
            postgresql_where=text("kind = 'payout'"),
        ),
    )

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


class PayoutLine(SQLModel, table=True):
    """One holder's share of a quarterly payout (T67). Private and erasable: the public ledger
    holds only aggregates and a commitment over these lines' leaf hashes (`app.market.revenue`).

    `leaf_hash = sha256(nonce ‖ canonical(line))` with a random per-line nonce. Erasure clears
    the user, shares, amount and nonce and keeps the leaf hash as an unlinkable tombstone, so
    the other holders' lines stay verifiable.
    """

    __tablename__ = "payout_lines"
    __table_args__ = (
        ForeignKeyConstraint(
            ["world_id", "asset_id"], ["assets.world_id", "assets.id"], name="fk_payout_lines_asset"
        ),
        ForeignKeyConstraint(
            ["world_id", "user_id"], ["users.world_id", "users.id"], name="fk_payout_lines_user"
        ),
        UniqueConstraint(
            "world_id", "asset_id", "quarter_label", "user_id", name="uq_payout_lines_holder"
        ),
        Index("ix_payout_lines_world_id_user_id", "world_id", "user_id"),
    )

    id: int | None = Field(default=None, primary_key=True, sa_type=BigInteger)
    world_id: UUID
    asset_id: UUID
    quarter_label: str
    user_id: UUID | None = None  # None once erased (tombstone)
    shares: int | None = Field(default=None, sa_column=Column(BigInteger, nullable=True))
    amount: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    nonce: bytes | None = Field(default=None, sa_column=Column(LargeBinary, nullable=True))
    leaf_hash: str = Field(sa_column=Column(String(64), nullable=False))


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

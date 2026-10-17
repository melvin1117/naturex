"""Accounts and server-side sessions (ADR-0005 §1, T54).

Pure helpers plus small DB functions; routers and dependencies stay thin. Secrets never leave
this module in clear text: passwords are hashed with argon2id (pwdlib) and session tokens are
stored only as their SHA-256. Nothing here logs an email, a password or a token.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import cache
from math import ceil
from uuid import UUID

from pwdlib import PasswordHash
from sqlalchemy import delete, func, or_, text, update
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlmodel import Session, col, select

from app.models import (
    AuthAttempt,
    AuthAttemptKind,
    AuthBucket,
    SessionKind,
    User,
    UserKind,
    UserRole,
    UserSession,
)

SESSION_COOKIE = "nx_session"
IDLE_TIMEOUT = timedelta(days=7)
ABSOLUTE_TIMEOUT = timedelta(days=30)
# last_seen_at only needs to be roughly right for the idle limit; avoid a write per request.
TOUCH_EVERY = timedelta(minutes=5)

PASSWORD_MIN_LENGTH = 10
PASSWORD_MAX_LENGTH = 128  # bounds argon2 work per request
NAME_MAX_LENGTH = 80
EMAIL_MAX_LENGTH = 254
STARTING_CASH = Decimal("10000.00")
LOGIN_FAILED = "Email or password is incorrect"
EMAIL_UNAVAILABLE = "This email can't be used to create an account"
TOO_MANY_ATTEMPTS = "too_many_attempts"
ATTEMPT_RETENTION = timedelta(hours=24)

_EMAIL_RE = re.compile(r"^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+\.[^@\s\x00-\x1f\x7f]+$")
_hasher = PasswordHash.recommended()


class EmailTaken(Exception):
    """An account with this email already exists in the world."""


@dataclass(frozen=True)
class Principal:
    """Who is acting, resolved from the session cookie. T57/T61 authorize against this."""

    user_id: UUID
    world_id: UUID
    session_id: UUID
    session_kind: SessionKind
    user_kind: UserKind
    is_admin: bool


def _now() -> datetime:
    return datetime.now(UTC)


def normalize_email(raw: str) -> str:
    return raw.strip().lower()


def is_valid_email(email: str) -> bool:
    """A plausible address with no control or other non-printable characters (NUL included)."""
    return (
        len(email) <= EMAIL_MAX_LENGTH
        and email.isprintable()
        and _EMAIL_RE.fullmatch(email) is not None
    )


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> tuple[bool, str | None]:
    """(valid, new hash if the stored one should be upgraded to current parameters)."""
    return _hasher.verify_and_update(password, password_hash)


@cache
def dummy_hash() -> str:
    """A real argon2id hash, so unknown emails cost the same verify as known ones."""
    return _hasher.hash(secrets.token_urlsafe(16))


def new_token() -> str:
    """256 random bits for the session cookie."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _find_person(session: Session, world_id: UUID, email: str) -> User | None:
    return session.exec(
        select(User).where(
            User.world_id == world_id,
            User.kind == UserKind.PERSON,
            func.lower(col(User.email)) == email,
        )
    ).first()


def register_person(session: Session, world_id: UUID, email: str, password: str, name: str) -> User:
    """Create a password account. Hashes first, so a duplicate costs the same as a new email.

    Raises EmailTaken; the caller turns it into a generic 409. Commits.
    """
    password_hash = hash_password(password)
    user = User(
        world_id=world_id,
        name=name,
        role=UserRole.INVESTOR,  # persona label only; any signed-in user may invest (ADR-0005)
        kind=UserKind.PERSON,
        email=normalize_email(email),
        password_hash=password_hash,
        cash_balance=STARTING_CASH,
    )
    session.add(user)
    try:
        session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        if isinstance(exc, IntegrityError) and "users_world_email" in str(exc.orig):
            raise EmailTaken from None
        raise
    session.refresh(user)
    return user


def authenticate(session: Session, world_id: UUID, email: str, password: str) -> User | None:
    """The person with this email and password, or None. Unknown emails still run a verify."""
    user = _find_person(session, world_id, normalize_email(email))
    if user is None or user.password_hash is None:
        verify_password(password, dummy_hash())
        return None
    valid, upgraded = verify_password(password, user.password_hash)
    if not valid:
        return None
    if upgraded is not None:
        user.password_hash = upgraded
        session.add(user)
        session.commit()
    return user


def start_session(session: Session, user: User, kind: SessionKind = SessionKind.PASSWORD) -> str:
    """Insert a new session for `user` and return the raw token (set it as the cookie). Commits."""
    token = new_token()
    now = _now()
    session.add(
        UserSession(
            token_hash=hash_token(token),
            world_id=user.world_id,
            user_id=user.id,
            kind=kind,
            created_at=now,
            last_seen_at=now,
            expires_at=now + ABSOLUTE_TIMEOUT,
        )
    )
    session.commit()
    return token


def end_session(session: Session, token: str | None) -> None:
    """Delete the session for this token, if any. Commits."""
    if token:
        session.execute(delete(UserSession).where(col(UserSession.token_hash) == hash_token(token)))
        session.commit()


def _expired(row: UserSession, now: datetime) -> bool:
    return now >= row.expires_at or now - row.last_seen_at >= IDLE_TIMEOUT


def resolve_session(session: Session, token: str | None) -> Principal | None:
    """The principal for a cookie token, or None if missing, unknown, expired or revoked.

    Expired rows are deleted on sight; `last_seen_at` is bumped at most every TOUCH_EVERY.
    Both use core statements by ID, so a logout or prune that removed the row in between makes
    this a revoked session (None), never a StaleDataError.
    """
    if not token or len(token) > 128:
        return None
    found = session.exec(
        select(UserSession, User)
        .join(
            User,
            (col(User.id) == col(UserSession.user_id))
            & (col(User.world_id) == col(UserSession.world_id)),
        )
        .where(UserSession.token_hash == hash_token(token))
    ).first()
    if found is None:
        return None
    row, user = found
    now = _now()
    if _expired(row, now) or user.kind == UserKind.TREASURY:
        session.execute(delete(UserSession).where(col(UserSession.id) == row.id))
        session.commit()
        return None
    if now - row.last_seen_at > TOUCH_EVERY:
        bumped = session.execute(
            update(UserSession).where(col(UserSession.id) == row.id).values(last_seen_at=now)
        )
        session.commit()
        if not getattr(bumped, "rowcount", 0):
            return None
    return Principal(
        user_id=user.id,
        world_id=row.world_id,
        session_id=row.id,
        session_kind=row.kind,
        user_kind=user.kind,
        is_admin=user.is_admin,
    )


def prune_expired_sessions(session: Session) -> int:
    """Delete sessions past their absolute or idle limit. The caller commits."""
    now = _now()
    result = session.execute(
        delete(UserSession).where(
            or_(
                col(UserSession.expires_at) <= now,
                col(UserSession.last_seen_at) <= now - IDLE_TIMEOUT,
            )
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


# --- Rate limits (ADR-0005 section 1, T66) -----------------------------------------------------


@dataclass(frozen=True)
class RateLimit:
    attempts: int
    window: timedelta


RATE_LIMITS = {
    AuthAttemptKind.LOGIN: RateLimit(10, timedelta(minutes=15)),
    AuthAttemptKind.REGISTER: RateLimit(5, timedelta(hours=1)),
}
# Longest a request waits for a bucket's lock; each waiter holds a pooled connection.
LOCK_TIMEOUT_MS = 2000


class AttemptsBusy(Exception):
    """A bucket's lock wasn't free in time; the caller answers 503 and the client retries."""


def _parse_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """An address from a forwarded entry, which may carry a port (`1.2.3.4:5`, `[::1]:5`).

    An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, as dual-stack sockets report IPv4 clients)
    is returned as the IPv4 address, so those clients don't all share one /64 bucket.
    """
    text_value = value.strip()
    if text_value.startswith("["):
        text_value = text_value[1:].split("]", 1)[0]
    elif text_value.count(":") == 1:
        text_value = text_value.split(":", 1)[0]
    try:
        address = ipaddress.ip_address(text_value)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def client_ip(forwarded_for: Sequence[str], peer: str | None, hops: int) -> str:
    """The address rate limits count as the client.

    `hops` is the number of trusted reverse proxies, each appending the address it saw to
    X-Forwarded-For, so the client is the entry `hops` from the right; anything further left was
    written by the client and is ignored. With 0 hops, or a chain too short or not an address,
    the socket peer is used. IPv6 clients are bucketed by /64, as one customer holds the whole
    prefix and could otherwise rotate addresses to dodge the limit.
    """
    entries = [part.strip() for line in forwarded_for for part in line.split(",")]
    peer_address = peer or "unknown"
    forwarded = entries[-hops] if 0 < hops <= len(entries) else None
    for candidate in (forwarded, peer_address):
        address = _parse_ip(candidate or "")
        if address is None:
            continue
        if isinstance(address, ipaddress.IPv6Address):
            return str(ipaddress.ip_network(f"{address}/64", strict=False).network_address)
        return str(address)
    return peer_address.lower()


def bucket_key(secret: str, bucket: AuthBucket, value: str) -> str:
    """HMAC-SHA256 hex of one bucket's subject, so a table row can't be matched to an email or IP.

    The bucket name is part of the message, so an IP and an email can never share a key.
    """
    message = f"{bucket.value}|{value}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def lock_name(kind: AuthAttemptKind, bucket: AuthBucket, key_hmac: str) -> str:
    """The advisory-lock name serialising attempts on one bucket."""
    return f"auth_attempts|{kind.value}|{bucket.value}|{key_hmac}"


def retry_after_seconds(oldest: datetime, now: datetime, window: timedelta) -> int:
    """Whole seconds until the oldest counted attempt leaves the window, in [1, window].

    Rounds up so a client that waits this long is let in. Clamped at both ends: an attempt
    stamped after `now` (another server's clock, or an injected time) never asks for more than
    the window, and one already at the edge still asks for a second rather than zero.
    """
    remaining = ceil((oldest + window - now).total_seconds())
    return min(max(remaining, 1), ceil(window.total_seconds()))


def consume_attempt(
    session: Session,
    kind: AuthAttemptKind,
    keys: Sequence[tuple[AuthBucket, str]],
    now: datetime | None = None,
    lock_timeout_ms: int = LOCK_TIMEOUT_MS,
) -> int | None:
    """Count one attempt in every bucket, or refuse it. Commits.

    Call it first in a request: a refusal rolls the session back, which would discard any
    pending writes. Returns None when the attempt is allowed, else the seconds until it would be.
    Each bucket is counted under a transaction-scoped advisory lock for its key, so concurrent
    attempts can't all slip under the limit; locks are taken in sorted order, so requests sharing
    a bucket can't deadlock. A refused attempt is not stored, so a blocked client can't extend
    its own lockout. Raises AttemptsBusy if a lock isn't free within `lock_timeout_ms`.
    """
    limit = RATE_LIMITS[kind]
    ordered = sorted(set(keys), key=lambda item: (item[0].value, item[1]))
    try:
        session.execute(
            text("SELECT set_config('lock_timeout', :value, true)"),
            {"value": f"{lock_timeout_ms}ms"},
        )
        for bucket, key_hmac in ordered:
            session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:name, 0))"),
                {"name": lock_name(kind, bucket, key_hmac)},
            )
    except OperationalError as exc:
        session.rollback()
        raise AttemptsBusy from exc
    # Read the clock only once the locks are held: a time read before waiting could predate
    # attempts committed by whoever held the lock, giving a wait longer than the window.
    moment = now or _now()
    since = moment - limit.window
    retry_after = 0
    for bucket, key_hmac in ordered:
        count, oldest = session.execute(
            select(func.count(), func.min(col(AuthAttempt.created_at))).where(
                col(AuthAttempt.bucket) == bucket,
                col(AuthAttempt.key_hmac) == key_hmac,
                col(AuthAttempt.kind) == kind,
                col(AuthAttempt.created_at) > since,
            )
        ).one()
        if count >= limit.attempts and oldest is not None:
            retry_after = max(retry_after, retry_after_seconds(oldest, moment, limit.window))
    if retry_after:
        session.rollback()  # releases the locks
        return retry_after
    session.add_all(
        AuthAttempt(bucket=bucket, key_hmac=key_hmac, kind=kind, created_at=moment)
        for bucket, key_hmac in ordered
    )
    session.commit()
    return None


def prune_auth_attempts(session: Session, now: datetime | None = None) -> int:
    """Delete attempts older than ATTEMPT_RETENTION. The caller commits."""
    cutoff = (now or _now()) - ATTEMPT_RETENTION
    result = session.execute(delete(AuthAttempt).where(col(AuthAttempt.created_at) <= cutoff))
    return int(getattr(result, "rowcount", 0) or 0)


def prune_auth_data(session: Session) -> tuple[int, int]:
    """Delete expired sessions and day-old attempts: (sessions, attempts). Commits."""
    sessions = prune_expired_sessions(session)
    attempts = prune_auth_attempts(session)
    session.commit()
    return sessions, attempts

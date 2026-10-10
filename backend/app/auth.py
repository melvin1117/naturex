"""Accounts and server-side sessions (ADR-0005 §1, T54).

Pure helpers plus small DB functions; routers and dependencies stay thin. Secrets never leave
this module in clear text: passwords are hashed with argon2id (pwdlib) and session tokens are
stored only as their SHA-256. Nothing here logs an email, a password or a token.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import cache
from uuid import UUID

from pwdlib import PasswordHash
from sqlalchemy import delete, func, or_, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, col, select

from app.models import SessionKind, User, UserKind, UserRole, UserSession

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

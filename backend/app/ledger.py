"""Nature Ledger (dev-spec §17): an append-only, hash-chained history per asset.

Each entry's hash covers its payload, kind, sequence number and the previous entry's hash,
so editing, removing or reordering any entry breaks verification from that point on.

- `append` adds an entry inside the caller's transaction, so it commits or rolls back with
  the record it covers (listing, report, event, price anchor, payout).
- `verify` and `tamper` are pure functions over entries; the DB already rejects UPDATE and
  DELETE (migration 0003), so the tamper demo only ever edits an in-memory copy.

Payload rule: store the business values themselves (scores, prices, areas), not just IDs, so
an edited source row can be caught by comparing it with its ledger payload.

Privacy rule (ADR-0005 §6, T67): the ledger is public and can't be edited, so payloads never
hold account identifiers, emails or person names. `append` enforces a cheap guard as defence in
depth: it rejects any key on a deny-list (`user_id`, `holder_id`, `email`, `password`…, at any
depth, plus `*_user_id` and `*_email`), any email address, and a `ref_id` that is a user's ID
(`ref_id` is public too). In http(s) URLs only the userinfo (rejected outright) and the decoded
query and fragment are checked, so paths like `cover@2x.png` pass. The guard can't tell a user
UUID inside a payload from an asset UUID, so producers stay responsible for what they put in,
and `tests/test_ledger_privacy.py` runs every real producer and scans its entries against the
real accounts.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol
from urllib.parse import unquote, unquote_plus, urlsplit
from uuid import UUID

from sqlmodel import Session, col, select

from app.models import Asset, LedgerEntry, LedgerKind, User

GENESIS_HASH = "0" * 64
TAMPER_FACTOR = 10

# Keys that name an account or hold personal data. `name` alone isn't here: a listing's asset
# name is public. Person names use the explicit keys below.
DENIED_PAYLOAD_KEYS: frozenset[str] = frozenset(
    {
        "user_id",
        "user_ids",
        "holder",
        "holders",
        "holder_id",
        "holder_ids",
        "holder_name",
        "holder_payouts",
        "community_user_id",
        "uploaded_by",
        "reviewer_id",
        "persona_key",
        "email",
        "emails",
        "password",
        "password_hash",
        "display_name",
        "person_name",
        "full_name",
        "owner_name",
        "session_id",
        "token",
        "token_hash",
    }
)
_DENIED_KEY_SUFFIXES = ("_user_id", "_user_ids", "_email", "_password")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_TOKEN_EDGES = "()[]<>{}\"',;"


class LedgerPrivacyError(ValueError):
    """A ledger payload holds an account identifier or personal data (ADR-0005 §6)."""


class HashedEntry(Protocol):
    @property
    def seq(self) -> int: ...
    @property
    def kind(self) -> LedgerKind: ...
    @property
    def payload(self) -> Mapping[str, Any]: ...
    @property
    def prev_hash(self) -> str: ...
    @property
    def hash(self) -> str: ...


@dataclass(frozen=True, slots=True)
class ChainEntry:
    """A detached copy of a ledger entry, used for verification and the tamper demo."""

    seq: int
    kind: LedgerKind
    payload: Mapping[str, Any]
    prev_hash: str
    hash: str


@dataclass(frozen=True, slots=True)
class VerifyResult:
    valid: bool
    entries: int
    head: str | None
    """Hash of the last entry when the chain is valid; None when it's broken."""
    broken_at: int | None
    """Position of the first entry that fails; None when the chain is valid."""


@dataclass(frozen=True, slots=True)
class TamperResult:
    seq: int
    field: str
    before: Any
    after: Any
    entries: list[ChainEntry]


def canonical(payload: Mapping[str, Any]) -> bytes:
    """Sorted-key, whitespace-free JSON. Decimals, UUIDs and dates become strings."""
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), default=str, allow_nan=False
    ).encode()


def check_public_payload(payload: Any, path: str = "$") -> None:
    """Raise LedgerPrivacyError if a payload has a denied key or an email-shaped string."""
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            lowered = str(key).lower()
            if lowered in DENIED_PAYLOAD_KEYS or lowered.endswith(_DENIED_KEY_SUFFIXES):
                raise LedgerPrivacyError(f"ledger payloads must not hold {path}.{key}")
            check_public_payload(value, f"{path}.{key}")
    elif isinstance(payload, list | tuple):
        for index, value in enumerate(payload):
            check_public_payload(value, f"{path}[{index}]")
    elif isinstance(payload, str) and any(_token_has_email(t) for t in payload.split()):
        raise LedgerPrivacyError(f"ledger payloads must not hold an email address ({path})")


def _token_has_email(token: str) -> bool:
    """Full email search on plain text; for an http(s) URL, only its userinfo, query and
    fragment, since paths and file names (`cover@2x.png`) often contain `@`."""
    token = token.strip(_TOKEN_EDGES)
    try:
        url = urlsplit(token)
    except ValueError:
        return bool(_EMAIL.search(token))
    if url.scheme.lower() not in ("http", "https") or not url.netloc:
        return bool(_EMAIL.search(token))
    if "@" in url.netloc:
        return True  # userinfo: an account name or credentials never belong in a public URL
    return bool(_EMAIL.search(unquote_plus(url.query)) or _EMAIL.search(unquote(url.fragment)))


def entry_hash(payload: Mapping[str, Any], kind: LedgerKind, seq: int, prev_hash: str) -> str:
    """sha256(canonical(payload) + kind + seq + prev_hash), as in dev-spec §17."""
    data = canonical(payload) + kind.value.encode() + str(seq).encode() + prev_hash.encode()
    return hashlib.sha256(data).hexdigest()


def verify(entries: Sequence[HashedEntry]) -> VerifyResult:
    """Recompute the chain in order; report the first entry whose link or hash is wrong."""
    prev = GENESIS_HASH
    for position, entry in enumerate(entries):
        if (
            entry.seq != position
            or entry.prev_hash != prev
            or entry.hash != entry_hash(entry.payload, entry.kind, entry.seq, prev)
        ):
            return VerifyResult(valid=False, entries=len(entries), head=None, broken_at=position)
        prev = entry.hash
    return VerifyResult(valid=True, entries=len(entries), head=prev, broken_at=None)


def _inflate(value: Any) -> Any:
    """Return a visibly different number, or None if the value isn't numeric."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return value * TAMPER_FACTOR
    if isinstance(value, str):
        try:
            number = Decimal(value)
        except InvalidOperation:
            return None
        if number.is_finite():
            return str(number * TAMPER_FACTOR)
    return None


def tamper(entries: Sequence[HashedEntry], seq: int) -> TamperResult:
    """Copy the chain and edit one entry's payload, as an attacker editing the DB would.

    Multiplies the first numeric field (in key order) by 10; if there is none, adds
    `"tampered": true`. The stored hashes are left alone, so `verify` flags the entry.
    """
    copies = [ChainEntry(e.seq, e.kind, dict(e.payload), e.prev_hash, e.hash) for e in entries]
    target = next((i for i, e in enumerate(copies) if e.seq == seq), None)
    if target is None:
        raise LookupError(f"no ledger entry with seq {seq}")

    payload = dict(copies[target].payload)
    for field in sorted(payload):
        after = _inflate(payload[field])
        if after is not None:
            before = payload[field]
            break
    else:
        field, before, after = "tampered", None, True
    payload[field] = after
    copies[target] = replace(copies[target], payload=payload)
    return TamperResult(seq=seq, field=field, before=before, after=after, entries=copies)


def entries_for(session: Session, asset_id: UUID) -> list[LedgerEntry]:
    statement = (
        select(LedgerEntry).where(LedgerEntry.asset_id == asset_id).order_by(col(LedgerEntry.seq))
    )
    return list(session.exec(statement).all())


def append(
    session: Session,
    *,
    world_id: UUID,
    asset_id: UUID,
    kind: LedgerKind,
    payload: Mapping[str, Any],
    ref_id: UUID | None = None,
) -> LedgerEntry:
    """Add the next entry for an asset in the caller's transaction (the caller commits).

    Locks the asset row first, so concurrent appends for one asset queue instead of
    racing for the same `seq`. The payload is stored exactly as it was hashed. Raises
    LedgerPrivacyError if the payload fails `check_public_payload` or `ref_id` is a user's ID.
    """
    stored: dict[str, Any] = json.loads(canonical(payload))
    check_public_payload(stored)
    if ref_id is not None and session.get(User, ref_id) is not None:
        raise LedgerPrivacyError("ledger ref_id must not be a user's ID")
    locked = session.exec(
        select(Asset.id).where(Asset.id == asset_id).with_for_update()
    ).one_or_none()
    if locked is None:
        raise LookupError(f"asset {asset_id} not found")

    last = session.exec(
        select(LedgerEntry)
        .where(LedgerEntry.asset_id == asset_id)
        .order_by(col(LedgerEntry.seq).desc())
        .limit(1)
    ).first()
    seq, prev = (last.seq + 1, last.hash) if last else (0, GENESIS_HASH)
    entry = LedgerEntry(
        world_id=world_id,
        asset_id=asset_id,
        seq=seq,
        kind=kind,
        ref_id=ref_id,
        payload=stored,
        prev_hash=prev,
        hash=entry_hash(stored, kind, seq, prev),
    )
    session.add(entry)
    session.flush()
    return entry

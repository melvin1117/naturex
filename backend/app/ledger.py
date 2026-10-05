"""Nature Ledger (dev-spec §17): an append-only, hash-chained history per asset.

Each entry's hash covers its payload, kind, sequence number and the previous entry's hash,
so editing, removing or reordering any entry breaks verification from that point on.

- `append` adds an entry inside the caller's transaction, so it commits or rolls back with
  the record it covers (listing, report, event, price anchor, payout).
- `verify` and `tamper` are pure functions over entries; the DB already rejects UPDATE and
  DELETE (migration 0003), so the tamper demo only ever edits an in-memory copy.

Payload rule: store the business values themselves (scores, prices, areas), not just IDs, so
an edited source row can be caught by comparing it with its ledger payload.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol
from uuid import UUID

from sqlmodel import Session, col, select

from app.models import Asset, LedgerEntry, LedgerKind

GENESIS_HASH = "0" * 64
TAMPER_FACTOR = 10


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
    racing for the same `seq`. The payload is stored exactly as it was hashed.
    """
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
    stored: dict[str, Any] = json.loads(canonical(payload))
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

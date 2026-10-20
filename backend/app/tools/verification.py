"""Listing verification rules (ADR-0006, T69): fingerprints, commitments and the checklist.

Pure functions; `app.services.verification` loads the facts and stores the results.

- **Private fingerprint** (reuse detection): `HMAC-SHA256(world key, file)`, where the world
  key is `HMAC-SHA256(DOCUMENT_FINGERPRINT_SECRET, world_id)`. Keyed per world, so the same file
  in two worlds (a sandbox and the live world) never links, and it's never published.
- **Reason commitments** (public, in the ledger): `sha256(salt ‖ purpose ‖ reason)` with a
  private random salt per run, so nobody can test a guessed reason against the ledger.
- **Commitment** (public, in the ledger): `SHA-256(nonce ‖ file)` with a private 32-byte random
  nonce per document. It proves the document set didn't change after review without letting
  anyone holding a copy confirm it against the permanent ledger; erasing the nonce makes it
  unlinkable.
- **Input fingerprint** of a run: SHA-256 of the canonical JSON of the community, the listing's
  name, its geometry (by hash), its area, the documents' types and commitments, the method
  version, the mode and the evidence kind. Any change to those makes the listing unverified.
- **Checklist:** deterministic checks with pass / warn / fail, the value found and its source.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID

from app.models import DocumentType, EvidenceKind, VerificationLevel, VerificationMode
from app.tools.geometry import geometry_sha256

METHOD_VERSION = "naturex-verification-v1"
"""Bump when a check or the fingerprint changes: every run made before then stops matching."""
MAX_DOCUMENTS_PER_RUN = 3
CONSENT_DOCUMENT_TYPES = frozenset({DocumentType.ASSEMBLY_MINUTES})
NOT_VERIFIED = "not_verified"
"""The IPO gate's (and a revoked listing's resume) refusal code: HTTP 409."""

NOT_CHECKED: tuple[str, ...] = (
    "Whether a document is authentic or forged",
    "Whether the issuing authority is real and the title is current",
    "Legal validity and signatures",
    "Quorum, language and validity of community consent (FPIC)",
    "Whether the drawn polygon matches the legal parcel",
    "Who the uploader really is",
    "Registry records",
)
"""ADR-0006 §2's disclosure row, shown on every public panel."""

BADGES: Mapping[VerificationLevel, str] = {
    VerificationLevel.VERIFIED: "Documents reviewed by NatureX (hackathon process)",
    VerificationLevel.REVOKED: "Verification revoked",
}
SELF_ATTESTED = "Self-attested by the community"


class CheckResult(StrEnum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"


class Check(StrEnum):
    ACCEPTED_FORMAT = "accepted_format"
    NOT_REUSED = "not_reused"
    BOUNDARY_FREE = "boundary_free"
    CONSENT_DOCUMENT = "consent_document"


@dataclass(frozen=True, slots=True)
class DocumentFacts:
    """What the checklist needs to know about one document of a run."""

    doc_type: DocumentType
    media_type: str
    page_count: int | None
    width: int | None
    height: int | None
    private_fingerprint: str
    bound_asset_id: UUID
    """The asset the fingerprint is bound to (`document_fingerprints`)."""
    commitment: str


@dataclass(frozen=True, slots=True)
class ListingFacts:
    """The listing inputs a run's fingerprint covers."""

    community_id: UUID | None
    name: str
    geojson: Mapping[str, Any]
    area_ha: Decimal


# ----- fingerprints and commitments ---------------------------------------------------------------


def world_document_key(secret: str, world_id: UUID) -> bytes:
    """The per-world key for private document fingerprints."""
    return hmac.new(
        secret.encode(), b"naturex/document-fingerprint/v1:" + world_id.bytes, hashlib.sha256
    ).digest()


def private_fingerprint(world_key: bytes, data: bytes | memoryview) -> str:
    return hmac.new(world_key, data, hashlib.sha256).hexdigest()


def commitment_of(nonce: bytes, data: bytes | memoryview) -> str:
    """SHA-256(nonce ‖ file), hex (hashed incrementally: the file isn't copied)."""
    digest = hashlib.sha256(nonce)
    digest.update(data)
    return digest.hexdigest()


def new_commitment(data: bytes | memoryview) -> tuple[bytes, str]:
    """A fresh private nonce and the public commitment it makes for `data`."""
    nonce = secrets.token_bytes(32)
    return nonce, commitment_of(nonce, data)


def _canonical(payload: Mapping[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def document_commitments(
    documents: Sequence[tuple[DocumentType, str]],
) -> list[dict[str, str]]:
    """`[{doc_type, commitment}]` in a stable order (by commitment, then type)."""
    rows = [{"doc_type": doc_type.value, "commitment": c} for doc_type, c in documents]
    return sorted(rows, key=lambda row: (row["commitment"], row["doc_type"]))


def input_fingerprint(
    listing: ListingFacts,
    documents: Sequence[tuple[DocumentType, str]],
    *,
    method_version: str = METHOD_VERSION,
    mode: VerificationMode = VerificationMode.REVIEW,
    evidence_kind: EvidenceKind = EvidenceKind.REAL,
) -> str:
    """SHA-256 over everything a verification vouches for (see the module docstring)."""
    payload = {
        "community_id": str(listing.community_id) if listing.community_id else None,
        "name": listing.name,
        "geometry_sha256": geometry_sha256(listing.geojson),
        "area_ha": f"{Decimal(listing.area_ha):.2f}",
        "documents": document_commitments(documents),
        "method_version": method_version,
        "mode": mode.value,
        "evidence_kind": evidence_kind.value,
    }
    return hashlib.sha256(_canonical(payload)).hexdigest()


# ----- the checklist ----------------------------------------------------------------------------


def _item(check: Check, result: CheckResult, found: str, source: str) -> dict[str, str]:
    return {"check": check.value, "result": result.value, "found": found, "source": source}


def _describe(document: DocumentFacts) -> str:
    if document.media_type == "application/pdf":
        pages = document.page_count or 0
        return f"PDF ({pages} page{'s' if pages != 1 else ''})"
    kind = "PNG" if document.media_type == "image/png" else "JPEG"
    return f"{kind} ({document.width} × {document.height} px)"


def checklist(
    asset_id: UUID, documents: Sequence[DocumentFacts], overlaps: int
) -> list[dict[str, str]]:
    """The deterministic checks of a run (ADR-0006 §2), in a fixed order.

    `overlaps` is how many listings in the world the polygon overlaps now (T36/T58's rule).
    Values never name another listing or a person: the checklist is shown to the steward.
    """
    if not documents:
        raise ValueError("a verification run needs at least one document")
    formats = "; ".join(_describe(document) for document in documents)
    items = [
        _item(
            Check.ACCEPTED_FORMAT,
            CheckResult.PASS,
            f"{len(documents)} document{'s' if len(documents) != 1 else ''}: {formats}",
            "Upload inspection: PDF, JPEG or PNG by magic bytes, at most 5 MB, decoded-pixel "
            "and PDF page/object limits, no encryption or active content",
        )
    ]

    elsewhere = sum(1 for document in documents if document.bound_asset_id != asset_id)
    repeats = sum(n - 1 for n in Counter(d.private_fingerprint for d in documents).values())
    if elsewhere:
        reused = (CheckResult.FAIL, f"{elsewhere} document(s) already back another listing")
    elif repeats:
        reused = (CheckResult.WARN, f"the same file is attached {repeats + 1} times")
    else:
        reused = (CheckResult.PASS, f"{len(documents)} of {len(documents)} bound to this listing")
    items.append(
        _item(
            Check.NOT_REUSED,
            *reused,
            "Per-world keyed document fingerprint, bound to one listing (database constraint)",
        )
    )

    items.append(
        _item(
            Check.BOUNDARY_FREE,
            CheckResult.FAIL if overlaps else CheckResult.PASS,
            f"overlaps {overlaps} other listing(s)" if overlaps else "no overlap",
            "Polygon overlap check against the listings that claim land in this world",
        )
    )

    consent = sum(1 for document in documents if document.doc_type in CONSENT_DOCUMENT_TYPES)
    items.append(
        _item(
            Check.CONSENT_DOCUMENT,
            CheckResult.PASS if consent else CheckResult.FAIL,
            f"{consent} assembly minutes / consent document(s) attached"
            if consent
            else "no assembly minutes / consent document attached",
            "The steward's label on the upload. It shows a document was attached, not that "
            "consent exists",
        )
    )
    return items


def failed_checks(items: Sequence[Mapping[str, Any]]) -> list[str]:
    return [str(item["check"]) for item in items if item.get("result") == CheckResult.FAIL.value]


def public_checks(items: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    """Check names and results only: the public panel and the ledger never show values."""
    return [{"check": str(item["check"]), "result": str(item["result"])} for item in items]


def badge(level: VerificationLevel) -> str:
    """The precise badge text (ADR-0006 §4); never "ownership proven"."""
    return BADGES.get(level, SELF_ATTESTED)


def new_reason_salt() -> bytes:
    return secrets.token_bytes(32)


def reason_commitment(salt: bytes | None, purpose: str, reason: str | None) -> str | None:
    """A reviewer's reason is free text a person wrote: the public ledger holds
    `sha256(salt ‖ purpose ‖ 0x00 ‖ reason)`, with the run's private random salt, so a guessed
    reason can't be confirmed against it. Revealing the salt proves the reason; erasing it
    makes the commitment unlinkable. None without a reason (or once the salt is erased)."""
    if not reason or salt is None:
        return None
    digest = hashlib.sha256(salt)
    digest.update(purpose.encode() + b"\x00" + reason.encode())
    return digest.hexdigest()

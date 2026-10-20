"""Pure rules of the AI document check (T71, ADR-0006 §2): untrusted text, areas, the verdict.

Everything here is deterministic and tested; `app.agents.document_check` calls the models and
`app.services.document_check` stores the result.

- **Untrusted text** (`clean_untrusted`): what a model read off a document is attacker-written.
  It's NFKC-normalised, stripped of control and invisible format characters, collapsed to one
  line and capped. `instruction_like` spots text aimed at a model (EN/ES); a regex list is never
  complete, so it's one layer of several (data-only prompts, no tools, code-made verdicts).
- **Area** (`to_hectares`, `area_verdict`): the listing's area and the document's are compared
  in code, never by a model, within ±`AREA_TOLERANCE` of the listing's area. The number the
  model read must appear in the excerpt it quotes, so a model can't supply an area the document
  doesn't show.
- **Suggestion** (`overall_suggestion`): from the per-field verdicts, by fixed rules.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from app.agents.guards import numbers_in

AREA_TOLERANCE = Decimal("0.20")
HECTARES_PER_UNIT: dict[str, Decimal] = {
    "ha": Decimal("1"),
    "m2": Decimal("0.0001"),
    "km2": Decimal("100"),
    "acre": Decimal("0.40468564224"),
}
FIELD_CHARS = 120
EXCERPT_CHARS = 240
REASON_CHARS = 300

_AI_TARGET = r"(?:ai|llm|model|classifier|assistant|reviewer|verifier)"
INSTRUCTION_RE = re.compile(
    "|".join(
        (
            r"\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|of|everything)\s+)*"
            r"(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|guidance)",
            r"\b(?:ignora|ignore|olvida)\s+(?:(?:todas|todos|tus|las|los|estas|esas)\s+)+"
            r"(?:instrucciones|reglas)",
            r"</?\s*(?:system|untrusted_document_text|assistant|user)\s*>",
            r"\b(?:mark|set|flag|label|treat)\s+(?:(?:this|it|the)\s+)?"
            r"(?:(?:listing|document|run|title|parcel)\s+)?(?:as\s+)?"
            r"(?:verified|approved|consistent|valid|authentic)\b",
            r"\b(?:marca|marcar)\s+(?:como\s+)?(?:verificad[oa]|aprobad[oa]|consistente)\b",
            r"[\"']?(?:suggestion|verdict|level|verification_level)[\"']?\s*[:=]",
            rf"\b(?:attention|note|message|instructions?)\s+(?:to|for)\s+(?:the\s+)?{_AI_TARGET}\b",
            r"\b(?:aviso|nota|mensaje|instrucciones?)\s+para\s+(?:el\s+|la\s+)?"
            r"(?:modelo|ia|asistente|revisor)\b",
            r"\bnew\s+(?:policy|instructions?|rules?)\s*:",
            r"\byou\s+are\s+(?:now\s+)?(?:a|an|the)\b",
        )
    ),
    re.IGNORECASE,
)


class Verdict(StrEnum):
    MATCH = "match"
    MISMATCH = "mismatch"
    UNCLEAR = "unclear"
    NOT_APPLICABLE = "not_applicable"
    """A sample document's name (ADR-0006 §6: "n/a (sample)")."""


class Suggestion(StrEnum):
    CONSISTENT = "consistent"
    INCONSISTENT = "inconsistent"
    UNREADABLE = "unreadable"


def clean_untrusted(text: str | None, limit: int = FIELD_CHARS) -> str | None:
    """Normalised, single-line, printable text of at most `limit` characters, or None."""
    if text is None:
        return None
    folded = unicodedata.normalize("NFKC", text)
    kept = "".join(
        " " if unicodedata.category(ch) in ("Cc", "Zl", "Zp") else ch
        for ch in folded
        if unicodedata.category(ch) not in ("Cf", "Co", "Cs", "Cn") and ch != "\u034f"
    )
    single = " ".join(kept.split())
    if not single:
        return None
    return single if len(single) <= limit else single[: limit - 1].rstrip() + "…"


def instruction_like(*texts: str | None) -> bool:
    """Whether any text looks aimed at a model rather than a reader."""
    return any(text and INSTRUCTION_RE.search(text) for text in texts)


def to_hectares(value: Decimal, unit: str) -> Decimal:
    """`value` in `unit` (ha, m2, km2 or acre) as hectares. Raises ValueError otherwise."""
    if unit not in HECTARES_PER_UNIT:
        raise ValueError(f"unknown area unit {unit!r}")
    if not value.is_finite() or value <= 0:
        raise ValueError("an area is a positive number")
    return value * HECTARES_PER_UNIT[unit]


def area_within_tolerance(
    listing_ha: Decimal, document_ha: Decimal, tolerance: Decimal = AREA_TOLERANCE
) -> bool:
    """|document − listing| ≤ tolerance × listing (both in hectares, the listing's positive)."""
    if listing_ha <= 0:
        return False
    return abs(document_ha - listing_ha) <= tolerance * listing_ha


def _decimal(value: float | str | None) -> Decimal | None:
    if value is None:
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() else None


def area_verdict(
    listing_ha: Decimal, value: float | None, unit: str | None, excerpt: str | None
) -> tuple[Verdict, str, Decimal | None]:
    """The area comparison, made in code: the verdict, its reason and the document's hectares."""
    number = _decimal(value)
    if number is None or unit is None:
        return Verdict.UNCLEAR, "No area was read from the document.", None
    if not excerpt or f"number:{format(number.normalize(), 'f')}" not in numbers_in(excerpt):
        return (
            Verdict.UNCLEAR,
            "The area the model read doesn't appear in the excerpt it quoted.",
            None,
        )
    try:
        hectares = to_hectares(number, unit)
    except ValueError:
        return Verdict.UNCLEAR, "The area's unit or value isn't usable.", None
    shown = hectares.quantize(Decimal("0.01"))
    listing = listing_ha.quantize(Decimal("0.01"))
    if area_within_tolerance(listing_ha, hectares):
        return Verdict.MATCH, f"{shown} ha is within ±20% of the listing's {listing} ha.", shown
    return Verdict.MISMATCH, f"{shown} ha is not within ±20% of the listing's {listing} ha.", shown


def overall_suggestion(verdicts: Iterable[Verdict], *, instruction_text: bool) -> Suggestion:
    """`inconsistent` if a document holds instruction-like text or any field mismatches;
    else `consistent` if at least one field matches; else `unreadable`."""
    seen = list(verdicts)
    if instruction_text or Verdict.MISMATCH in seen:
        return Suggestion.INCONSISTENT
    if Verdict.MATCH in seen:
        return Suggestion.CONSISTENT
    return Suggestion.UNREADABLE

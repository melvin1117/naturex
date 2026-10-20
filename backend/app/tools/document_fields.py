"""Pure rules of the AI document check (T71, ADR-0006 §2): untrusted text, areas, the verdict.

Everything here is deterministic and tested; `app.agents.document_check` calls the models and
`app.services.document_check` stores the result.

- **Untrusted text** (`clean_untrusted`): what a model read off a document is attacker-written.
  It's NFKC-normalised, stripped of control and invisible format characters, collapsed to one
  line and capped. `instruction_like` spots text aimed at a model (EN/ES); a regex list is never
  complete, so it's one layer of several (data-only prompts, no tools, code-made verdicts).
- **Area** (`to_hectares`, `area_verdict`): the listing's area and the document's are compared
  in code, never by a model, within ±`AREA_TOLERANCE` of the listing's area. The excerpt the
  model quotes must print its number directly followed by its unit (`areas_in`, English and
  Spanish number styles; a number that reads two ways is `unclear`), so a model can't supply an
  area or a unit the document doesn't show.
- **Suggestion** (`overall_suggestion`): from the per-field verdicts, by fixed rules. Only a
  matching holder name can make it `consistent`: the listing's area and place are public.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from decimal import Decimal, InvalidOperation
from enum import StrEnum

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
            r"</?\s*(?:system|untrusted_document_text|listing_data|assistant|user)\s*>",
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


_UNIT_PATTERNS: tuple[tuple[str, str], ...] = (
    ("km2", r"km2|km²|kil[oó]metros?\s+cuadrados|square\s+kilometres?|square\s+kilometers?"),
    ("m2", r"m2|m²|mts?2|metros?\s+cuadrados|square\s+metres?|square\s+meters?"),
    ("ha", r"has?|hect[aá]reas?|hectares?"),
    ("acre", r"acres?"),
)
_NUMBER = r"\d+(?:[.,]\d+)*"
AREA_RE = re.compile(
    rf"(?<![\w.,])(?P<number>{_NUMBER})\s?(?P<unit>"
    + "|".join(f"(?P<{name}>{pattern})" for name, pattern in _UNIT_PATTERNS)
    + r")(?!\w)",
    re.IGNORECASE,
)
_GROUPED = re.compile(r"\d{1,3}(?:[.,]\d{3})+")


class Ambiguous(ValueError):
    """A number that reads two ways (`1,440`: 1440 in English, 1.44 in Spanish)."""


def parse_number(text: str) -> Decimal:
    """A number as printed in English or Spanish/European style. Raises Ambiguous when it
    reads both ways (one separator followed by exactly three digits) and ValueError when it
    isn't a well-formed number.

    `144,50` and `1.44` are decimals; `1.440.000` and `1,440,000` are thousands; with both
    separators the last one is the decimal mark (`1.440.000,50`, `1,440,000.50`)."""
    if not re.fullmatch(_NUMBER, text):
        raise ValueError(text)
    separators = [ch for ch in text if ch in ".,"]
    if not separators:
        return Decimal(text)
    kinds = set(separators)
    if len(kinds) == 2:
        decimal_mark = separators[-1]
        if separators.count(decimal_mark) != 1:
            raise ValueError(text)
        whole, fraction = text.rsplit(decimal_mark, 1)
        if not _GROUPED.fullmatch(whole):
            raise ValueError(text)
        return Decimal(f"{re.sub(r'[.,]', '', whole)}.{fraction}")
    mark = separators[0]
    if len(separators) > 1:
        if not _GROUPED.fullmatch(text):
            raise ValueError(text)
        return Decimal(text.replace(mark, ""))
    whole, fraction = text.split(mark)
    if len(fraction) == 3 and len(whole) <= 3 and whole != "0":
        raise Ambiguous(text)
    return Decimal(f"{whole}.{fraction}")


def areas_in(excerpt: str) -> list[tuple[Decimal | None, str]]:
    """Every number printed directly before an area unit in `excerpt`, with the unit's key
    (ha, m2, km2, acre); None for a number that is ambiguous or malformed."""
    found: list[tuple[Decimal | None, str]] = []
    folded = unicodedata.normalize("NFKC", excerpt)
    for match in AREA_RE.finditer(folded):
        unit = next(name for name, _ in _UNIT_PATTERNS if match.group(name))
        try:
            found.append((parse_number(match.group("number")), unit))
        except ValueError:
            found.append((None, unit))
    return found


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
    """The area comparison, made in code: the verdict, its reason and the document's hectares.

    The excerpt must print the model's number directly followed by the model's unit; the area
    is then read from the excerpt itself. Anything else, or a number that reads two ways, is
    `unclear`."""
    number = _decimal(value)
    if number is None or unit is None:
        return Verdict.UNCLEAR, "No area was read from the document.", None
    printed = areas_in(excerpt or "")
    same_unit = [found for found, found_unit in printed if found_unit == unit]
    if None in same_unit and number not in same_unit:
        return Verdict.UNCLEAR, "The printed area can be read more than one way.", None
    if number not in same_unit:
        return (
            Verdict.UNCLEAR,
            "The area and unit the model read don't appear together in the excerpt it quoted.",
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


def overall_suggestion(
    documents: Iterable[Mapping[str, Verdict]], *, instruction_text: bool
) -> Suggestion:
    """`inconsistent` if a document holds instruction-like text or any field mismatches.
    Otherwise `consistent` only if some document's **holder name** matches (or, for a sample
    document, is not applicable and another of its fields matches): the listing's area and
    place are public, so a forged document can copy them. Everything else is `unreadable`."""
    verdicts = [dict(document) for document in documents]
    if instruction_text or any(Verdict.MISMATCH in d.values() for d in verdicts):
        return Suggestion.INCONSISTENT
    for document in verdicts:
        holder = document.get("holder_name")
        if holder is Verdict.MATCH:
            return Suggestion.CONSISTENT
        others = [verdict for field, verdict in document.items() if field != "holder_name"]
        if holder is Verdict.NOT_APPLICABLE and Verdict.MATCH in others:
            return Suggestion.CONSISTENT
    return Suggestion.UNREADABLE

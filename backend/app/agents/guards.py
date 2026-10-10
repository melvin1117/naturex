"""Deterministic guards for model-written prose (T10, reused by the T26 Auditor).

Numbers shown to investors come from tested code, so model text may only repeat numbers that
appear in the facts it was given. Numbers are compared after normalising currency scales
(``$4.7M`` = ``4,700,000``), percentages and quarters, so a reformatted fact still matches but a
rounded, derived or invented one doesn't.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from decimal import Decimal

NUMERIC_TOKEN = re.compile(
    r"(?<![\d.,])"
    r"(?P<prefix>\$|USD|EUR|[Qq])?"
    r"(?P<number>\d+(?:,\d{3})*(?:\.\d+)?)"
    r"(?P<ordinal>st|nd|rd|th)?"
    r"(?P<suffix>[KkMmBb%]| ?(?:%|percent\b|thousand|million|billion))?",
    re.IGNORECASE,
)
_SCALES = {
    "k": Decimal("1000"),
    "thousand": Decimal("1000"),
    "m": Decimal("1000000"),
    "million": Decimal("1000000"),
    "b": Decimal("1000000000"),
    "billion": Decimal("1000000000"),
}


def normalise_number(match: re.Match[str]) -> str:
    prefix = (match.group("prefix") or "").upper()
    number = Decimal(match.group("number").replace(",", ""))
    suffix = (match.group("suffix") or "").strip().lower()
    if prefix == "Q":
        return f"quarter:{format(number.normalize(), 'f')}"
    if suffix in ("%", "percent"):
        return f"percent:{format(number.normalize(), 'f')}"
    scale = _SCALES.get(suffix, Decimal("1"))
    scaled = number * scale
    return f"number:{format(scaled.normalize(), 'f')}"


def numbers_in(text: str) -> set[str]:
    """Normalised numeric tokens in `text`."""
    return {normalise_number(match) for match in NUMERIC_TOKEN.finditer(text)}


def allowed_numbers(facts: Iterable[str]) -> set[str]:
    return {token for fact in facts for token in numbers_in(fact)}


def invented_numbers(text: str, facts: Iterable[str]) -> list[str]:
    """Raw numeric tokens in `text` whose normalised value isn't in any fact, in order."""
    allowed = allowed_numbers(facts)
    return [
        match.group(0)
        for match in NUMERIC_TOKEN.finditer(text)
        if normalise_number(match) not in allowed
    ]


def uses_only_fact_numbers(text: str, facts: Iterable[str]) -> bool:
    return numbers_in(text) <= allowed_numbers(facts)

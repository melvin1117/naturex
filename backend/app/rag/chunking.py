"""Turn reports and news events into Copilot chunks (T39, dev-spec §10). Pure functions.

A chunk is plain text built from the stored record only: every number in it comes from the
record (a report's change since the previous version is a subtraction of two stored scores),
so the answer guard can hold the model to these numbers. Chunk text never names a database ID:
a sandbox copy of a world has the same text, the same hash and so reuses the same vector, and
the citation label (`R2`, `E1a2b3c4d`) is attached at retrieval time instead.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

# ~500 tokens (dev-spec §10) at a conservative ~3.6 characters per token.
MAX_CHUNK_CHARS = 1800
# The Auditor's inline bundle citations (`[event:…]`, `[metric:ndvi_trend]`): IDs the Copilot
# can't cite, so they are dropped from summaries before indexing.
# IDs exclude the `,`/`;` separators so the repetition can't backtrack exponentially (ReDoS).
_BUNDLE_CITATION = re.compile(r"\[\s*[a-z_]+:[^\[\]\s,;]+(?:\s*[,;]\s*[a-z_]+:[^\[\]\s,;]+)*\s*\]")
_SPACES = re.compile(r"[ \t]+")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True, slots=True)
class ChunkDraft:
    seq: int
    content: str

    @property
    def sha256(self) -> str:
        return content_sha256(self.content)


def content_sha256(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class ReportFacts:
    """What a report chunk may say, read from the stored report (and the one before it)."""

    asset_name: str
    version: int
    issued: date | None = None
    data_version: str | None = None
    period: str | None = None
    simulated: bool = False
    health_score: Decimal | None = None
    grade: str | None = None
    confidence: Decimal | None = None
    value_low: Decimal | None = None
    value_mid: Decimal | None = None
    value_high: Decimal | None = None
    fair_value_per_share: Decimal | None = None
    previous_version: int | None = None
    previous_health: Decimal | None = None
    previous_grade: str | None = None
    flags: Sequence[Any] = field(default_factory=tuple)
    recommendations: Sequence[str] = field(default_factory=tuple)
    summary_md: str | None = None


@dataclass(frozen=True, slots=True)
class EventFacts:
    asset_name: str
    source: str
    title: str | None = None
    summary: str | None = None
    impact_type: str | None = None
    direction: int | None = None
    severity: int | None = None
    published_at: date | None = None
    recorded: date | None = None


def _clean(text: str) -> str:
    lines = [_SPACES.sub(" ", line).strip() for line in text.replace("\r", "").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _one_line(text: str) -> str:
    return " ".join(text.split())


def strip_bundle_citations(text: str) -> str:
    return _clean(_BUNDLE_CITATION.sub("", text))


def _num(value: Decimal) -> str:
    return format(value.normalize(), "f") if value == value.to_integral() else f"{value:.2f}"


def _money(value: Decimal) -> str:
    return f"${value:,.0f}" if value >= 100 else f"${value:,.2f}"


def split_text(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Pieces of at most `max_chars`, split at paragraph, then sentence, then word breaks."""
    text = _clean(text)
    if not text:
        return []
    if len(text) <= max_chars:
        return [_one_line(text)]
    units = [
        _one_line(sentence)
        for paragraph in re.split(r"\n\s*\n", text)
        for sentence in _SENTENCE_END.split(paragraph.strip())
        if sentence.strip()
    ]
    pieces: list[str] = []
    current = ""
    for unit in units:
        while len(unit) > max_chars:
            cut = unit.rfind(" ", 0, max_chars)
            cut = cut if cut > 0 else max_chars
            if current:
                pieces.append(current)
                current = ""
            pieces.append(unit[:cut].strip())
            unit = unit[cut:].strip()
        candidate = f"{current} {unit}" if current else unit
        if len(candidate) > max_chars:
            pieces.append(current)
            current = unit
        else:
            current = candidate
    if current:
        pieces.append(current)
    return [p for p in pieces if p]


def _flag_text(flag: Any) -> str:
    if isinstance(flag, dict):
        parts = [
            str(flag[key])
            for key in ("type", "kind", "code", "detail", "message", "reason")
            if flag.get(key) not in (None, "")
        ]
        return _one_line(": ".join(parts[:2])) if parts else ""
    return _one_line(str(flag))


def report_chunks(facts: ReportFacts) -> list[ChunkDraft]:
    """A facts chunk (scores, grade, value, fair value, change since the previous version,
    flags and recommendations), then the stored summary in pieces."""
    name = _one_line(facts.asset_name)
    lines = [f"Rating report version {facts.version} for {name}."]
    when = [
        f"issued {facts.issued.isoformat()}" if facts.issued else "",
        f"satellite data {facts.data_version}" if facts.data_version else "",
        f"period {facts.period}" if facts.period else "",
    ]
    if any(when):
        lines.append("Report " + ", ".join(w for w in when if w) + ".")
    if facts.simulated:
        lines.append("This is a simulated Time Machine scenario, not observed data.")
    if facts.health_score is not None:
        health = f"Health score {_num(facts.health_score)} out of 100"
        if facts.previous_health is not None and facts.previous_version is not None:
            delta = facts.health_score - facts.previous_health
            if delta < 0:
                trend = f"down {_num(-delta)} points, so the rating fell"
            elif delta > 0:
                trend = f"up {_num(delta)} points, so the rating rose"
            else:
                trend = "unchanged"
            health += (
                f", compared with {_num(facts.previous_health)} in version "
                f"{facts.previous_version} ({trend})"
            )
        lines.append(health + ".")
    if facts.grade:
        grade = f"Grade {facts.grade}"
        if facts.previous_grade and facts.previous_grade != facts.grade:
            grade += f" (was {facts.previous_grade} in version {facts.previous_version})"
        lines.append(grade + ".")
    if facts.confidence is not None:
        lines.append(f"Confidence {_num(facts.confidence)}%.")
    if facts.value_mid is not None:
        value = f"Estimated ecosystem service value {_money(facts.value_mid)} a year"
        if facts.value_low is not None and facts.value_high is not None:
            value += f" (range {_money(facts.value_low)} to {_money(facts.value_high)})"
        lines.append(value + ".")
    if facts.fair_value_per_share is not None:
        lines.append(
            f"Fair value per share {_money(facts.fair_value_per_share)}; the play-money share "
            "price re-anchors toward it after each report."
        )
    flags = [text for text in (_flag_text(f) for f in facts.flags) if text]
    if flags:
        lines.append("Flags: " + "; ".join(flags) + ".")
    recommendations = [_one_line(str(r)) for r in facts.recommendations if str(r).strip()]
    if recommendations:
        lines.append("Recommendations: " + "; ".join(recommendations) + ".")

    pieces = split_text(" ".join(lines))
    summary = strip_bundle_citations(facts.summary_md or "")
    for i, part in enumerate(split_text(summary, MAX_CHUNK_CHARS - 80)):
        pieces.append(f"Report version {facts.version} summary for {name}, part {i + 1}: {part}")
    return [ChunkDraft(seq, content) for seq, content in enumerate(pieces)]


def _direction(direction: int | None) -> str:
    if direction is None:
        return ""
    if direction < 0:
        return "Negative for nature: it lowers the rating (a decline)."
    if direction > 0:
        return "Positive for nature: it supports the rating."
    return "Neutral for the rating."


def event_chunks(facts: EventFacts) -> list[ChunkDraft]:
    """One chunk per event, or a few when its summary is long."""
    head = [f"News event for {_one_line(facts.asset_name)} (source: {facts.source})."]
    if facts.title:
        head.append(f"Title: {_one_line(facts.title)}.")
    dates = [
        f"published {facts.published_at.isoformat()}" if facts.published_at else "",
        f"recorded {facts.recorded.isoformat()}" if facts.recorded else "",
    ]
    if any(dates):
        head.append("It was " + ", ".join(d for d in dates if d) + ".")
    if facts.impact_type:
        head.append(f"Impact type: {facts.impact_type.replace('_', ' ')}.")
    if facts.severity is not None:
        head.append(f"Severity {facts.severity} of 5.")
    if direction := _direction(facts.direction):
        head.append(direction)
    if facts.summary:
        head.append(f"Summary: {_one_line(facts.summary)}")
    pieces = split_text(" ".join(head))
    return [ChunkDraft(seq, content) for seq, content in enumerate(pieces)]

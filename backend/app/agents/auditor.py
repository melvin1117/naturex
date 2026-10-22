"""Auditor agent: Nemotron 3 Ultra reviews a rating (dev-spec §7.7, T26).

The Auditor sees a compact bundle of facts that deterministic code already computed (metrics,
valuation, base scores, events, the previous report), each with a citable ID. It may only:

- shift health by an integer in [−10, +10], with a reason whose citations pass the per-sign
  rules in `_justification_errors` (no double-counting of events `score:threat_pressure`
  already prices);
- set `agreement`, which feeds confidence: 0.5 unless a relevant event or validated evidence
  is cited, and never more than 0.3 from it;
- write flags and Markdown prose in which every claim cites a bundle ID and every number is
  one of the bundle's trusted numbers. Code appends the adjustment line itself.

Model output is untrusted. After the JSON schema, `check_audit` re-checks every rule in code.
A rejected answer is retried once with the errors fed back, then sent one tier down; if that
also fails (or the budget, network or models fail), `run_auditor` returns a deterministic
no-op audit, so a rating never blocks on the LLM. `apply_audit` is the only way the result
touches a number: it re-runs `scoring.score` with the bounded adjustment and agreement.

Thinking: **on**. Ultra first weighs 2-3 competing explanations (for example seasonal drought
against clearing) with the bundle IDs for and against each, then decides. With reasoning on,
`LLMClient.structured` sends the schema in the prompt only: Token Factory's strict `json_schema`
plus reasoning ran past `max_tokens` without closing the JSON (T26 live smoke, Oct 22 spike),
while the prompt-only schema with an 8,000-token cap returned valid JSON in 14 s for about
$0.02 (`reasoning_effort` and a `reasoning_budget` are ignored there). Prose numbers are
written as `{fact-id}` placeholders that code fills with the exact value (`fill_placeholders`).
"""

from __future__ import annotations

import html
import logging
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from functools import cache
from pathlib import Path
from typing import Any, Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.exc import SQLAlchemyError

from app.agents.guards import invented_numbers
from app.llm import BudgetExceeded, LLMClient, LLMError, LLMResult, Tier
from app.schemas import AuditorFlag, AuditorOutput, NewsScoutItem
from app.tools import scoring
from app.tools.earth_obs import DateWindow, EarthObsMetrics
from app.tools.scoring import DEFAULT_AGREEMENT, MAX_AUDITOR_ADJUSTMENT, Number, ScoreResult
from app.tools.signals import PRICED_SIGNAL_IDS, Signal
from app.tools.valuation import ValuationResult

log = logging.getLogger(__name__)

AGENT_NAME = "auditor"
PROMPT_PATH = Path(__file__).parent / "prompts" / "auditor.md"
# Reasoning length grows with the case: 2,000-8,000 tokens measured on the demo sites (Oct 22),
# plus a ~1,500-token answer; Token Factory ignores reasoning budgets. Typical cost about $0.03,
# worst case about $0.05 an attempt; if it still runs out, Ultra answers with thinking off.
MAX_TOKENS = 16000
REASONING = True
FIX_MAX_TOKENS = 2500
"""A correction round (thinking off) only rewrites the answer it is shown."""
MAX_HYPOTHESES = 3
MAX_HYPOTHESIS_IDS = 8
MAX_HYPOTHESIS_NAME_CHARS = 80
MAX_VERDICT_CHARS = 600
REASONING_EXCERPT_CHARS = 1500

MAX_SUMMARY_CHARS = 3000
MAX_SUMMARY_WORDS = 400
MAX_ITEM_CHARS = 300
MAX_REASON_CHARS = 600
MAX_KEY_CHANGES = 5
MAX_RECOMMENDATIONS = 4
MAX_FLAGS = 8
MAX_CITATIONS = 40
UNTRUSTED_TITLE_CHARS = 160
UNTRUSTED_SUMMARY_CHARS = 400
MAX_FEEDBACK_ERRORS = 8
REJECTED = "rejected"
"""`llm_calls.status` of a schema-valid answer that `check_audit` refused."""

ID_PREFIXES = ("metric", "signal", "image", "valuation", "score", "event", "report")
CITATION_RE = re.compile(
    r"\b(?:" + "|".join(ID_PREFIXES) + r"):[A-Za-z0-9_](?:[A-Za-z0-9_.\-]*[A-Za-z0-9_])?"
)
_EVENT_ID_RE = r"^[A-Za-z0-9_](?:[A-Za-z0-9_.\-]{0,62}[A-Za-z0-9_])?$"
_PLACEHOLDER_NUMBER_RE = re.compile(
    r"[+-]?\$?\d[\d,]*(?:\.\d+)?"
    r"(?:%|/yr| (?:out of 100|t C/ha|t/ha|tCO2/yr|tCO2|NDVI/yr|ha))?(?=$|[\s(;,])"
)
# `{metric:area_ha}` in the prose: code writes the fact's exact value there (`fill_placeholders`).
PLACEHOLDER_RE = re.compile(r"\{(" + CITATION_RE.pattern.removeprefix(r"\b") + r")\}")
_HTML_TAG_RE = re.compile(r"<[A-Za-z!/?]")
_LINK_RE = re.compile(r"\]\(|!\[|https?://", re.IGNORECASE)
_MAX_SHOWN_ID = 80

# Facts the deterministic score already prices (V, N, L, W, or the score and valuation
# themselves). An adjustment reason that cites only these restates the score (dev-spec §7.7).
_PRICED_METRICS = frozenset(
    {
        "metric:area_ha",
        "metric:natural_fraction",
        "metric:ndvi_mean",
        "metric:ndvi_trend",
        "metric:water_change",
        "metric:forest_loss_5y_ha",
    }
)
# Agreement may move off neutral by at most this much, and only with cited evidence.
MAX_AGREEMENT_DEVIATION = Decimal("0.3")

AuditSource = Literal["ultra", "super", "nano", "fallback"]
_SOURCE: dict[Tier, AuditSource] = {
    Tier.AUDITOR: "ultra",
    Tier.ORCHESTRATOR: "super",
    Tier.FAST: "nano",
}
_LOWER_TIER: dict[Tier, Tier | None] = {
    Tier.AUDITOR: Tier.ORCHESTRATOR,
    Tier.ORCHESTRATOR: Tier.FAST,
    Tier.FAST: None,
}


class AuditorFlagType(StrEnum):
    GREENWASHING_CLAIM_MISMATCH = "greenwashing_claim_mismatch"
    METRIC_NEWS_CONFLICT = "metric_news_conflict"
    ENCROACHMENT_PRESSURE = "encroachment_pressure"
    FOREST_LOSS = "forest_loss"
    WATER_DECLINE = "water_decline"
    DATA_GAP = "data_gap"
    LOW_COVERAGE = "low_coverage"
    STALE_DATA = "stale_data"
    EVIDENCE_CONCERN = "evidence_concern"
    VALUATION_CAVEAT = "valuation_caveat"
    SIMULATED_DATA = "simulated_data"
    OTHER = "other"
    AUDITOR_UNAVAILABLE = "auditor_unavailable"
    """Reserved for the deterministic no-op audit; the model may not emit it."""


MODEL_FLAG_TYPES = frozenset(AuditorFlagType) - {AuditorFlagType.AUDITOR_UNAVAILABLE}


# ----- input bundle ---------------------------------------------------------------------------


class Fact(BaseModel):
    """One trusted, deterministic value. `value` is display text, including its unit."""

    model_config = ConfigDict(frozen=True)

    id: str
    value: str


class AuditEvent(BaseModel):
    """A news or field-evidence event. Metadata is trusted; `title` and `summary` are not."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(pattern=_EVENT_ID_RE)
    source: Literal["news", "evidence"] = "news"
    relevant: bool
    impact_type: Literal[
        "encroachment", "fire", "drought", "pollution", "restoration", "protection", "other"
    ]
    direction: Literal[-1, 0, 1]
    severity: int = Field(ge=1, le=5)
    published_at: date | None = None
    validated: bool | None = None
    """Field evidence only: True when code checks (EXIF GPS and date) passed."""
    title: str | None = None
    summary: str = ""

    @property
    def citation_id(self) -> str:
        return f"event:{self.id}"


class PreviousReport(BaseModel):
    """The asset's last published report, for quarter-on-quarter changes."""

    model_config = ConfigDict(frozen=True)

    version: int = Field(ge=1)
    period: str | None = None
    health: Decimal = Field(ge=0, le=100)
    grade: str
    confidence: Decimal = Field(ge=0, le=100)
    value_mid: int = Field(ge=0)
    auditor_adjustment: int = Field(ge=-MAX_AUDITOR_ADJUSTMENT, le=MAX_AUDITOR_ADJUSTMENT)


class AuditorInput(BaseModel):
    """Everything the Auditor sees. Build it with `build_auditor_input`."""

    model_config = ConfigDict(frozen=True)

    asset_name: str = Field(max_length=200)
    rating_date: date
    data_version: str
    simulated: bool
    base_health: Decimal = Field(ge=0, le=100)
    base_grade: str
    facts: tuple[Fact, ...]
    events: tuple[AuditEvent, ...] = ()
    observations: tuple[Fact, ...] = ()
    """`image:` descriptions by the vision model, each with code's check against the metrics:
    hints, never trusted numbers (they stay out of `trusted_lines`)."""

    @model_validator(mode="after")
    def _unique_ids(self) -> AuditorInput:
        ids = (
            [fact.id for fact in self.facts]
            + [o.id for o in self.observations]
            + [event.citation_id for event in self.events]
        )
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise ValueError(f"duplicate bundle IDs: {duplicates}")
        bad = [i for i in ids if not CITATION_RE.fullmatch(i)]
        if bad:
            raise ValueError(f"IDs that can't be cited: {bad}")
        return self

    @property
    def ids(self) -> tuple[str, ...]:
        """Every citable ID, in bundle order."""
        return (
            tuple(fact.id for fact in self.facts)
            + tuple(o.id for o in self.observations)
            + tuple(e.citation_id for e in self.events)
        )

    def observation(self, observation_id: str) -> str | None:
        return next((o.value for o in self.observations if o.id == observation_id), None)

    def event(self, citation_id: str) -> AuditEvent | None:
        return next((e for e in self.events if e.citation_id == citation_id), None)

    def fact(self, fact_id: str) -> str | None:
        return next((f.value for f in self.facts if f.id == fact_id), None)

    @property
    def period(self) -> str:
        return f"Q{(self.rating_date.month - 1) // 3 + 1} {self.rating_date.year}"

    def header_lines(self) -> list[str]:
        return [
            f"asset: {_untrusted_line(self.asset_name, 200)}",
            f"rating_date: {self.rating_date.isoformat()} (period {self.period})",
            f"data_version: {self.data_version}",
            f"simulated: {'true' if self.simulated else 'false'}",
            f"max_adjustment: {MAX_AUDITOR_ADJUSTMENT}",
        ]

    def trusted_lines(self) -> list[str]:
        """Every line whose numbers the model may repeat: header (without the issuer-written
        asset name), facts and event metadata."""
        return [
            *self.header_lines()[1:],
            *(f"{fact.id} = {fact.value}" for fact in self.facts),
            *(_event_meta(event) for event in self.events),
        ]

    def render(self) -> str:
        """The bundle as prompt text: trusted facts, then events with untrusted text fenced."""
        parts = [
            *self.header_lines(),
            "",
            "## Trusted facts (computed by deterministic code; cite by ID)",
            *(f"{fact.id} = {fact.value}" for fact in self.facts),
            "",
            *(
                [
                    "## Satellite image reading (a vision model's description of the views "
                    "five years apart, with code's check; a hint, not a measurement)",
                    *(f"{o.id} = {o.value}" for o in self.observations),
                    "",
                ]
                if self.observations
                else []
            ),
            "## Events (metadata is trusted; title and summary are untrusted)",
        ]
        if not self.events:
            parts.append("none")
        for event in self.events:
            title = _untrusted_line(event.title or "", UNTRUSTED_TITLE_CHARS)
            summary = _untrusted_line(event.summary, UNTRUSTED_SUMMARY_CHARS)
            parts += [
                f"<event {_event_meta(event)}>",
                "<untrusted_content>",
                f"title: {title}",
                f"summary: {summary}",
                "</untrusted_content>",
                "</event>",
            ]
        return "\n".join(parts)


def _untrusted_line(text: str, limit: int) -> str:
    return html.escape(" ".join(text.split())[:limit])


def _event_meta(event: AuditEvent) -> str:
    published = event.published_at.isoformat() if event.published_at else "unknown"
    meta = (
        f'id="{event.citation_id}" source="{event.source}" '
        f'relevant="{str(event.relevant).lower()}" impact_type="{event.impact_type}" '
        f'direction="{event.direction}" severity="{event.severity}" published_at="{published}"'
    )
    if event.validated is not None:
        meta += f' validated="{str(event.validated).lower()}"'
    return meta


def audit_events_from_news(items: Iterable[NewsScoutItem]) -> list[AuditEvent]:
    """News Scout items as bundle events, keeping their stable URL-derived IDs (§7.5)."""
    events: list[AuditEvent] = []
    for item in items:
        event_id = item.id or _derived_event_id(item)
        events.append(
            AuditEvent(
                id=event_id,
                source="news",
                relevant=item.relevant,
                impact_type=item.impact_type,
                direction=item.direction,
                severity=item.severity,
                published_at=item.published_at,
                title=item.title,
                summary=item.summary,
            )
        )
    return events


def event_citation_id(item: NewsScoutItem) -> str:
    """The bundle citation ID `audit_events_from_news` gives this News Scout item."""
    return f"event:{item.id or _derived_event_id(item)}"


def _derived_event_id(item: NewsScoutItem) -> str:
    """The ID News Scout would give the item (uuid5 of its URL), for items built without one."""
    if item.url:
        return str(uuid5(NAMESPACE_URL, item.url.strip().rstrip("/")))
    key = f"naturex:event:{item.title or ''}|{item.summary}|{item.published_at or ''}"
    return str(uuid5(NAMESPACE_URL, key))


def build_auditor_input(
    *,
    asset_name: str,
    rating_date: date,
    metrics: EarthObsMetrics,
    valuation: ValuationResult,
    base: ScoreResult,
    events: Sequence[AuditEvent] = (),
    previous: PreviousReport | None = None,
    signals: Sequence[Signal] = (),
    observations: Sequence[tuple[str, str]] = (),
) -> AuditorInput:
    """Flatten deterministic results into citable facts. `base` must be the pre-audit score."""
    if base.auditor_adjustment != 0 or base.agreement_source != "default":
        raise ValueError("build the bundle from the base score, before any audit is applied")
    facts = [
        *_metric_facts(metrics),
        *((signal.id, signal.text) for signal in signals),
        *_valuation_facts(valuation),
        *_score_facts(base),
        *(_previous_facts(previous, base, valuation) if previous else []),
    ]
    return AuditorInput(
        asset_name=asset_name,
        rating_date=rating_date,
        data_version=metrics.data_version,
        simulated=metrics.simulated,
        base_health=base.base_health,
        base_grade=base.grade.value,
        facts=tuple(Fact(id=fact_id, value=value) for fact_id, value in facts),
        events=tuple(events),
        observations=tuple(Fact(id=i, value=text) for i, text in observations),
    )


def _metric_facts(m: EarthObsMetrics) -> list[tuple[str, str]]:
    trend = m.ndvi_trend_details
    windows = m.date_windows
    kind = "a scripted Time Machine scenario, not observations" if m.simulated else "observed"
    facts = [
        ("metric:data_version", f"{m.data_version} ({kind})"),
        ("metric:area_ha", f"{_fixed(m.area_ha, 1)} ha"),
        *(
            (f"metric:landcover.{name}", _pct(share))
            for name, share in sorted(m.landcover.items(), key=lambda kv: -kv[1])
            if share > 0
        ),
        ("metric:natural_fraction", f"{_pct(m.natural_fraction)} of land cover is natural"),
        ("metric:ndvi_mean", _fixed(m.ndvi_mean, 4)),
        (
            "metric:ndvi_trend",
            f"{_signed(m.ndvi_trend, 4)} NDVI/yr (Mann-Kendall p "
            f"{_fixed(trend.mann_kendall_p_value, 4)}, "
            f"{'significant' if trend.significant_05 else 'not significant'} at 5%)",
        ),
        (
            "metric:water_change",
            f"{_signed(m.water_change, 1)} (JRC surface-water change, scale -100 to 100)",
        ),
        (
            "metric:forest_loss_5y_ha",
            f"{_fixed(m.forest_loss_ha, 2)} ha of tree cover lost over 5 years"
            f"{_window(windows, 'hansen_forest_loss')}",
        ),
    ]
    if m.forest_loss_last_12m_ha is not None:
        facts.append(
            (
                "metric:forest_loss_12m_ha",
                f"{_fixed(m.forest_loss_last_12m_ha, 2)} ha lost in the latest 12 months"
                f"{_window(windows, 'hansen_forest_loss_last_12m')}",
            )
        )
    facts.append(("metric:biomass_t_ha", f"{_fixed(m.biomass_t_ha, 1)} t/ha above-ground"))
    if m.soc_t_c_ha is not None:
        facts.append(("metric:soc_t_c_ha", f"{_fixed(m.soc_t_c_ha, 1)} t C/ha soil carbon"))
    if m.mangrove_fraction is not None:
        facts.append(("metric:mangrove_fraction", _pct(m.mangrove_fraction)))
    facts.append(
        (
            "metric:cloud_free_obs",
            f"{m.cloud_free_obs} cloud-free observations{_window(windows, 'cloud_free_obs')}",
        )
    )
    return facts


def _window(windows: Mapping[str, DateWindow], key: str) -> str:
    window = windows.get(key)
    return f" ({window.start} to {window.end})" if window else ""


def _valuation_facts(v: ValuationResult) -> list[tuple[str, str]]:
    facts = [
        (f"valuation:value_{level}", f"{_money(amount)}/yr ({_compact_money(amount)}/yr)")
        for level, amount in (("low", v.value_low), ("mid", v.value_mid), ("high", v.value_high))
    ]
    facts += [
        ("valuation:unit", f"{v.unit}; carbon is not included in the value"),
        ("valuation:carbon_stock_tco2", f"{v.carbon.total_stock_tco2:,} tCO2"),
        ("valuation:sequestration_tco2_yr", f"{v.carbon.sequestration_tco2_yr:,} tCO2/yr"),
        ("valuation:coastal", "yes" if v.coastal.is_coastal else "no"),
    ]
    if v.flags:
        facts.append(("valuation:flags", ", ".join(v.flags)))
    return facts


def _score_facts(s: ScoreResult) -> list[tuple[str, str]]:
    components = s.components.rounded()
    c = s.confidence_components.rounded()
    gate = "passed" if s.gate.passed else "failed: " + ", ".join(s.gate.reasons)
    gate += " (needs confidence of at least 70, grade C or better, 12-month loss under 1% of area)"
    return [
        ("score:vegetation_vigor", f"{components.vegetation_vigor} (0-1)"),
        ("score:natural_cover", f"{components.natural_cover} (0-1)"),
        ("score:habitat_loss", f"{components.habitat_loss} (0-1, 1 = no loss)"),
        ("score:water_stability", f"{components.water_stability} (0-1)"),
        ("score:threat_pressure", f"{components.threat_pressure} (0-1, 1 = no threats)"),
        ("score:negative_severity_sum", str(s.negative_severity_sum)),
        ("score:base_health", f"{s.base_health} out of 100"),
        ("score:base_grade", s.grade.value),
        (
            "score:confidence_before_audit",
            f"{s.confidence}% = 100 x (0.4 coverage {c.coverage} + 0.3 agreement "
            f"{c.agreement} (default) + 0.2 field evidence {c.evidence} + 0.1 recency "
            f"{c.recency})",
        ),
        ("score:listing_gate", gate),
    ]


def _previous_facts(
    p: PreviousReport, base: ScoreResult, valuation: ValuationResult
) -> list[tuple[str, str]]:
    health_change = base.base_health - p.health
    value_change = valuation.value_mid - p.value_mid
    return [
        ("report:previous.version", f"{p.version}{f' ({p.period})' if p.period else ''}"),
        ("report:previous.health", f"{p.health} out of 100, grade {p.grade}"),
        ("report:previous.confidence", f"{p.confidence}%"),
        ("report:previous.value_mid", f"{_money(p.value_mid)}/yr"),
        ("report:previous.auditor_adjustment", f"{p.auditor_adjustment:+d}"),
        ("report:previous.health_change", f"{_signed(health_change, 1)} (base health vs previous)"),
        ("report:previous.value_mid_change", f"{_signed_money(value_change)}/yr"),
    ]


def _quantize(value: Number, places: int) -> Decimal:
    exponent = Decimal(1).scaleb(-places)
    return Decimal(repr(float(value)) if isinstance(value, float) else value).quantize(
        exponent, rounding=ROUND_HALF_UP
    )


def _fixed(value: Number, places: int) -> str:
    return str(_quantize(value, places))


def _signed(value: Number, places: int) -> str:
    q = _quantize(value, places)
    return f"+{q}" if q > 0 else str(q)


def _pct(fraction: Number) -> str:
    return f"{_fixed(Decimal(repr(float(fraction))) * 100, 1)}%"


def _money(amount: int) -> str:
    return f"${amount:,}"


def _signed_money(amount: int) -> str:
    return f"+${amount:,}" if amount > 0 else f"-${abs(amount):,}" if amount < 0 else "$0"


def _compact_money(amount: int) -> str:
    if abs(amount) >= 1_000_000:
        return f"${_fixed(Decimal(amount) / 1_000_000, 1)}M"
    if abs(amount) >= 1_000:
        return f"${_fixed(Decimal(amount) / 1_000, 0)}K"
    return f"${amount}"


# ----- post-validation ------------------------------------------------------------------------


def _texts(output: AuditorOutput) -> list[tuple[str, str]]:
    return [
        *((f"hypotheses[{i}].name", h.name) for i, h in enumerate(output.hypotheses)),
        ("verdict", output.verdict),
        ("adjustment_reason", output.adjustment_reason),
        ("summary_md", output.summary_md),
        *((f"key_changes[{i}]", text) for i, text in enumerate(output.key_changes)),
        *((f"recommendations[{i}]", text) for i, text in enumerate(output.recommendations)),
        *((f"flags[{i}].detail", flag.detail) for i, flag in enumerate(output.flags)),
    ]


def inline_citations(text: str) -> list[str]:
    return CITATION_RE.findall(text)


def placeholder_value(value: str) -> str:
    """What `{fact-id}` becomes: the fact's leading number and unit ("83.9%", "206.7 ha",
    "$2,669,511/yr"), or its whole text when it doesn't start with a number."""
    match = _PLACEHOLDER_NUMBER_RE.match(value)
    return match.group(0) if match else value


MIN_EVENT_PREFIX = 8


def tidy_answer(output: AuditorOutput, bundle: AuditorInput) -> AuditorOutput:
    """Bookkeeping code can do itself, so it never costs a refused answer: long hypothesis
    labels cut, evidence lists capped at `MAX_HYPOTHESIS_IDS`, and an empty `citations` list
    filled with the known IDs the answer cites. Nothing here can add a claim or an unknown ID."""
    output = short_hypothesis_names(output)
    output = output.model_copy(
        update={
            "hypotheses": [
                h.model_copy(
                    update={
                        "evidence_for": list(dict.fromkeys(h.evidence_for))[:MAX_HYPOTHESIS_IDS],
                        "evidence_against": list(dict.fromkeys(h.evidence_against))[
                            :MAX_HYPOTHESIS_IDS
                        ],
                    }
                )
                for h in output.hypotheses
            ]
        }
    )
    if output.citations:
        return output
    known = set(bundle.ids)
    used = [c for _, text in _texts(output) for c in inline_citations(text)]
    used += [c for h in output.hypotheses for c in (*h.evidence_for, *h.evidence_against)]
    used += [f.citation for f in output.flags if f.citation]
    filled = [c for c in dict.fromkeys(used) if c in known][:MAX_CITATIONS]
    return output.model_copy(update={"citations": filled})


def short_hypothesis_names(output: AuditorOutput) -> AuditorOutput:
    """A hypothesis name is a label: a long one is cut at a word boundary, not refused."""

    def short(name: str) -> str:
        name = " ".join(name.split())
        if len(name) <= MAX_HYPOTHESIS_NAME_CHARS:
            return name
        cut = name[: MAX_HYPOTHESIS_NAME_CHARS - 1].rsplit(" ", 1)[0]
        return cut.rstrip(" ,;:-") + "…"

    return output.model_copy(
        update={
            "hypotheses": [h.model_copy(update={"name": short(h.name)}) for h in output.hypotheses]
        }
    )


def full_event_ids(output: AuditorOutput, bundle: AuditorInput) -> AuditorOutput:
    """Expand an event ID the model shortened (`event:94cc0471`) to the one bundle event it
    starts, when exactly one does and the prefix has at least 8 characters. Anything else is
    left as written, so the checks still refuse it."""
    events = [e.citation_id for e in bundle.events]

    def full(citation: str) -> str:
        if not citation.startswith("event:") or citation in events:
            return citation
        if len(citation) - len("event:") < MIN_EVENT_PREFIX:
            return citation
        matches = [e for e in events if e.startswith(citation)]
        return matches[0] if len(matches) == 1 else citation

    def text(value: str) -> str:
        return CITATION_RE.sub(lambda m: full(m.group(0)), value)

    return output.model_copy(
        update={
            "hypotheses": [
                h.model_copy(
                    update={
                        "evidence_for": [full(c) for c in h.evidence_for],
                        "evidence_against": [full(c) for c in h.evidence_against],
                    }
                )
                for h in output.hypotheses
            ],
            "verdict": text(output.verdict),
            "adjustment_reason": text(output.adjustment_reason),
            "summary_md": text(output.summary_md),
            "key_changes": [text(t) for t in output.key_changes],
            "recommendations": [text(t) for t in output.recommendations],
            "flags": [
                f.model_copy(update={"citation": full(f.citation) if f.citation else None})
                for f in output.flags
            ],
            "citations": [full(c) for c in output.citations],
        }
    )


def count_placeholders(output: AuditorOutput) -> int:
    return sum(len(PLACEHOLDER_RE.findall(text)) for _, text in _texts(output))


def fill_placeholders(
    output: AuditorOutput, bundle: AuditorInput
) -> tuple[AuditorOutput, list[str]]:
    """Replace each `{fact-id}` with that fact's exact value, so a number in the prose is
    always the one code computed. Returns the filled answer and any unknown placeholders."""
    errors: list[str] = []

    def fill(text: str) -> str:
        def one(match: re.Match[str]) -> str:
            value = bundle.fact(match.group(1))
            if value is None:
                errors.append(f"unknown placeholder {{{_shown(match.group(1))}}}")
                return match.group(0)
            return placeholder_value(value)

        return PLACEHOLDER_RE.sub(one, text)

    filled = output.model_copy(
        update={
            "hypotheses": [h.model_copy(update={"name": fill(h.name)}) for h in output.hypotheses],
            "verdict": fill(output.verdict),
            "adjustment_reason": fill(output.adjustment_reason),
            "summary_md": fill(output.summary_md),
            "key_changes": [fill(text) for text in output.key_changes],
            "recommendations": [fill(text) for text in output.recommendations],
            "flags": [
                flag.model_copy(update={"detail": fill(flag.detail)}) for flag in output.flags
            ],
        }
    )
    return filled, list(dict.fromkeys(errors))


def check_audit(output: AuditorOutput, bundle: AuditorInput) -> list[str]:
    """Every rule the schema can't express. Returns human-readable violations (empty = valid)."""
    errors: list[str] = []
    known = set(bundle.ids)
    adjustment = output.auditor_adjustment
    reason = output.adjustment_reason.strip()

    try:
        scoring.check_auditor_adjustment(adjustment, reason)
    except ValueError as exc:
        errors.append(str(exc))
    agreement = output.agreement
    agreement_valid = (
        isinstance(agreement, int | float) and math.isfinite(agreement) and 0 <= agreement <= 1
    )
    if not agreement_valid:
        errors.append(f"agreement must be between 0 and 1, got {agreement!r}")

    # Citations: all must resolve; key changes and a non-zero adjustment must cite something.
    if not output.citations:
        errors.append("citations is empty; cite the bundle IDs you used")
    if len(output.citations) > MAX_CITATIONS:
        errors.append(f"at most {MAX_CITATIONS} citations")
    errors += [
        f"unknown citation in citations[{i}]: {_shown(c)}"
        for i, c in enumerate(output.citations)
        if c not in known
    ]
    for field, text in _texts(output):
        errors += [
            f"{field} cites an unknown ID: {_shown(c)}"
            for c in inline_citations(text)
            if c not in known
        ]
    for i, text in enumerate(output.key_changes):
        if not inline_citations(text):
            errors.append(f"key_changes[{i}] has no [ID] citation")
    if output.summary_md.strip() and not inline_citations(output.summary_md):
        errors.append("summary_md has no [ID] citations; cite each claim inline")
    if isinstance(adjustment, int) and adjustment != 0:
        errors += _justification_errors(adjustment, reason, bundle)
    if agreement_valid:
        errors += _agreement_errors(output, bundle)

    # The case: a few named explanations whose evidence resolves, and a cited verdict.
    if len(output.hypotheses) > MAX_HYPOTHESES:
        errors.append(f"at most {MAX_HYPOTHESES} hypotheses")
    for i, hypothesis in enumerate(output.hypotheses):
        if not hypothesis.name.strip():
            errors.append(f"hypotheses[{i}].name is empty")
        for side in ("evidence_for", "evidence_against"):
            ids = getattr(hypothesis, side)
            if len(ids) > MAX_HYPOTHESIS_IDS:
                errors.append(f"hypotheses[{i}].{side} lists more than {MAX_HYPOTHESIS_IDS} IDs")
            errors += [
                f"hypotheses[{i}].{side} cites an unknown ID: {_shown(c)}"
                for c in ids
                if c not in known
            ]
    if output.hypotheses and not inline_citations(output.verdict):
        errors.append("verdict needs [ID] citations when hypotheses are given")
    if len(output.verdict) > MAX_VERDICT_CHARS:
        errors.append(f"verdict must be under {MAX_VERDICT_CHARS} characters")

    # Flags: typed, cited, and consistent with the greenwashing rating and simulated data.
    if len(output.flags) > MAX_FLAGS:
        errors.append(f"at most {MAX_FLAGS} flags")
    for i, flag in enumerate(output.flags):
        if flag.type not in MODEL_FLAG_TYPES:
            errors.append(f"flags[{i}].type is an invalid flag type; use one from the list")
        if not flag.citation:
            errors.append(f"flags[{i}] needs a citation")
        elif flag.citation not in known:
            errors.append(f"flags[{i}] cites an unknown ID: {_shown(flag.citation)}")
    types = {flag.type for flag in output.flags}
    if (
        output.greenwashing_risk != "low"
        and AuditorFlagType.GREENWASHING_CLAIM_MISMATCH not in types
    ):
        errors.append(
            f"greenwashing_risk {output.greenwashing_risk!r} needs a "
            "greenwashing_claim_mismatch flag"
        )
    if bundle.simulated and AuditorFlagType.SIMULATED_DATA not in types:
        errors.append("the bundle is simulated: add a simulated_data flag")

    # Shape and size.
    if not output.summary_md.strip():
        errors.append("summary_md is empty")
    if (
        len(output.summary_md) > MAX_SUMMARY_CHARS
        or len(output.summary_md.split()) > MAX_SUMMARY_WORDS
    ):
        errors.append(f"summary_md must be under {MAX_SUMMARY_WORDS} words")
    if len(output.key_changes) > MAX_KEY_CHANGES:
        errors.append(f"at most {MAX_KEY_CHANGES} key_changes")
    if len(output.recommendations) > MAX_RECOMMENDATIONS:
        errors.append(f"at most {MAX_RECOMMENDATIONS} recommendations")
    if len(reason) > MAX_REASON_CHARS:
        errors.append(f"adjustment_reason must be under {MAX_REASON_CHARS} characters")
    for field, text in _texts(output):
        long_ok = ("summary_md", "adjustment_reason", "verdict")
        if field not in long_ok and len(text) > MAX_ITEM_CHARS:
            errors.append(f"{field} must be under {MAX_ITEM_CHARS} characters")
        if _HTML_TAG_RE.search(text):
            errors.append(f"{field} contains HTML; use Markdown only")
        if _LINK_RE.search(text):
            errors.append(f"{field} contains a link or image; cite bundle IDs instead")

    # Numbers: only trusted bundle numbers. The adjustment line (adjustment, adjusted health,
    # reason) is written by code after acceptance, so the model never restates its own number.
    facts = [_strip_ids(fact) for fact in bundle.trusted_lines()]
    for field, text in _texts(output):
        prose = _strip_ids(_strip_asset_name(text, bundle.asset_name))
        invented = invented_numbers(prose, facts)
        if invented:
            errors.append(f"{field} uses numbers not in the bundle: {', '.join(invented[:5])}")
    return errors


def _shown(value: str) -> str:
    """A model-written ID, echoed back only when it is a well-formed citation."""
    if len(value) <= _MAX_SHOWN_ID and CITATION_RE.fullmatch(value):
        return repr(value)
    return "an invalid citation"


def _is_priced(citation: str) -> bool:
    return (
        citation.startswith(("score:", "valuation:", "metric:landcover."))
        or citation in _PRICED_METRICS
        or citation in PRICED_SIGNAL_IDS
    )


def _justifies_positive(event: AuditEvent) -> bool:
    return (
        event.relevant
        and event.direction == 1
        and (event.source == "news" or event.validated is True)
    )


def _is_agreement_evidence(event: AuditEvent) -> bool:
    return event.relevant and (event.source == "news" or event.validated is True)


def _justification_errors(adjustment: int, reason: str, bundle: AuditorInput) -> list[str]:
    """Deterministic per-sign rules for what may justify a non-zero adjustment.

    - Positive: a relevant direction +1 news event, or validated field evidence pointing up.
    - Negative: a `metric:` or `report:previous.` fact that carries the disagreement, because
      `score:threat_pressure` already prices every relevant negative event.
    - Never: citations that are only facts the score already prices.
    - Cited events must be relevant and must not point the other way.
    """
    cited = [c for c in dict.fromkeys(inline_citations(reason)) if c in set(bundle.ids)]
    if not cited:
        return ["a non-zero adjustment_reason must cite at least one bundle ID"]
    errors: list[str] = []
    sign = 1 if adjustment > 0 else -1
    events = [event for c in cited if (event := bundle.event(c)) is not None]
    for event in events:
        if not event.relevant:
            errors.append(f"adjustment_reason cites {event.citation_id}, which is not relevant")
        elif event.direction == -sign:
            errors.append(
                f"adjustment_reason cites {event.citation_id} (direction {event.direction}) "
                f"for an adjustment of {adjustment:+d}"
            )
    if all(_is_priced(c) for c in cited):
        errors.append(
            "adjustment_reason cites only facts the score already prices (score, valuation, "
            "or metrics in V, N, L and W); cite the evidence that disagrees with them"
        )
    if sign > 0 and not any(_justifies_positive(event) for event in events):
        errors.append(
            "a positive adjustment must cite a relevant direction 1 news event or validated "
            "field evidence"
        )
    if sign < 0 and not any(
        c.startswith(("metric:", "signal:", "report:previous.")) for c in cited
    ):
        errors.append(
            "a negative adjustment must also cite the metric, signal or report fact that "
            "disagrees; score:threat_pressure already prices relevant negative events"
        )
    return errors


def _agreement_errors(output: AuditorOutput, bundle: AuditorInput) -> list[str]:
    """Agreement moves confidence and the listing gate, so it needs evidence (dev-spec §7.7)."""
    agreement = Decimal(repr(float(output.agreement)))
    neutral = DEFAULT_AGREEMENT
    if not any(event.relevant for event in bundle.events):
        if agreement != neutral:
            return [f"there are no relevant events or evidence, so agreement must be {neutral}"]
        return []
    errors: list[str] = []
    if abs(agreement - neutral) > MAX_AGREEMENT_DEVIATION:
        errors.append(
            f"agreement must stay between {neutral - MAX_AGREEMENT_DEVIATION} and "
            f"{neutral + MAX_AGREEMENT_DEVIATION}"
        )
    if agreement != neutral:
        cited = set(_cited_ids(output))
        if not any(_is_agreement_evidence(e) for e in bundle.events if e.citation_id in cited):
            errors.append(
                f"an agreement other than {neutral} must cite a relevant news event or "
                "validated field evidence"
            )
    return errors


def _cited_ids(output: AuditorOutput) -> set[str]:
    used = set(output.citations)
    used.update(c for _, text in _texts(output) for c in inline_citations(text))
    used.update(flag.citation for flag in output.flags if flag.citation)
    return used


def _strip_ids(text: str) -> str:
    return CITATION_RE.sub("[id]", text)


def _strip_asset_name(text: str, name: str) -> str:
    """The issuer-written asset name may be repeated, but its digits are not trusted facts."""
    if len(name.strip()) < 3 or not any(ch.isalpha() for ch in name):
        return text
    for form in dict.fromkeys((name, html.unescape(name), html.escape(name))):
        text = text.replace(form, "[asset]")
    return text


def adjustment_line(bundle: AuditorInput, adjustment: int, reason: str) -> str:
    """The summary's adjustment sentence, written by code so its sign and numbers are right."""
    if adjustment == 0:
        return (
            f"**Auditor adjustment:** none; health stays at the base score of "
            f"{bundle.base_health} [score:base_health]."
        )
    health = scoring.adjusted_health(bundle.base_health, adjustment, reason)
    return (
        f"**Auditor adjustment:** {adjustment:+d}, from base health {bundle.base_health} to "
        f"{health} out of 100 [score:base_health]. Reason: {reason.strip()}"
    )


# ----- running the Auditor --------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AuditResult:
    output: AuditorOutput
    citations: tuple[str, ...]
    """Every bundle ID the audit cites (list, inline and flags), in bundle order."""
    source: AuditSource
    model: str | None
    degraded: bool
    """True when anything other than Ultra produced the audit (flag the report degraded)."""
    fallback: bool
    """True for the deterministic no-op audit."""
    rounds: int
    """LLM calls made by `run_auditor` (each may include LLMClient retries and fallbacks)."""
    rejections: tuple[str, ...]
    """Validation errors of rejected answers, for the Agent Trace."""
    greenwashing_risk: Literal["low", "medium", "high"] | None
    """The audit's greenwashing risk, or None when it was **not assessed** (the no-op audit).
    T27: show "not assessed" for None; `output.greenwashing_risk` is only a schema filler."""
    reasoning: str | None = None
    reasoning_tokens: int | None = None
    placeholders_filled: int = 0
    """`{fact-id}` placeholders in the accepted answer that code replaced with exact values."""


@cache
def system_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def auditor_messages(bundle: AuditorInput) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": system_prompt()},
        {"role": "user", "content": "Audit this rating bundle.\n\n" + bundle.render()},
    ]


def run_auditor(
    bundle: AuditorInput,
    *,
    llm: LLMClient,
    world_id: UUID | None = None,
    asset_id: UUID | None = None,
    max_tokens: int = MAX_TOKENS,
    reasoning: bool = REASONING,
) -> AuditResult:
    """Ultra (thinking) → Ultra fixes the rejected answer (thinking off) → one tier down →
    deterministic no-op. Never raises on model, budget or call-log failures."""
    base = auditor_messages(bundle)
    rejections: list[str] = []
    rounds = 0
    placeholders = 0

    def ask(
        messages: list[dict[str, Any]], tier: Tier, *, think: bool = False
    ) -> LLMResult[AuditorOutput]:
        nonlocal rounds
        rounds += 1
        return llm.structured(
            agent=AGENT_NAME,
            tier=tier,
            messages=messages,
            schema=AuditorOutput,
            reasoning=think,
            max_tokens=max_tokens if think else FIX_MAX_TOKENS,
            world_id=world_id,
            asset_id=asset_id,
            # A thinking call that runs out of tokens would only run out again on a retry or a
            # smaller model: one attempt, then Ultra answers with thinking off.
            single_attempt=think,
        )

    def deliberate() -> LLMResult[AuditorOutput]:
        if reasoning:
            try:
                return ask(base, Tier.AUDITOR, think=True)
            except BudgetExceeded:
                raise
            except LLMError as exc:
                rejections.append(f"thinking answer unusable ({str(exc)[:120]}); answered without")
        return ask(base, Tier.AUDITOR)

    def review(result: LLMResult[AuditorOutput]) -> tuple[LLMResult[AuditorOutput], list[str]]:
        nonlocal placeholders
        filled, unknown = fill_placeholders(
            tidy_answer(full_event_ids(result.value, bundle), bundle), bundle
        )
        placeholders = count_placeholders(result.value)
        return replace(result, value=filled), unknown + check_audit(filled, bundle)

    try:
        # Ultra thinks once. Its decisions are in that answer, so a rejected answer goes back
        # for a quick fix with thinking off (strict JSON), not for a second deliberation.
        first = deliberate()
        deliberation = first
        checked, problems = review(first)
        if not problems:
            return _accepted(checked, bundle, rounds, rejections, placeholders=placeholders)
        llm.mark(first, REJECTED)
        rejections += problems

        retry = [
            *base,
            {"role": "assistant", "content": first.value.model_dump_json()},
            {"role": "user", "content": _feedback(problems, "Your answer was rejected")},
        ]
        second = ask(retry, first.tier)
        checked, problems = review(second)
        if not problems:
            return _accepted(
                checked, bundle, rounds, rejections, deliberation, placeholders=placeholders
            )
        llm.mark(second, REJECTED)
        rejections += problems

        lower = _LOWER_TIER[second.tier]
        if lower is not None:
            note = _feedback(rejections, "Earlier answers were rejected")
            third = ask([*base, {"role": "user", "content": note}], lower)
            checked, problems = review(third)
            if not problems:
                return _accepted(
                    checked, bundle, rounds, rejections, deliberation, placeholders=placeholders
                )
            llm.mark(third, REJECTED)
            rejections += problems
    except (LLMError, SQLAlchemyError) as exc:
        rejections.append(f"{type(exc).__name__}: {str(exc)[:200]}")

    log.warning("auditor fell back to the no-op audit: %s", rejections[:MAX_FEEDBACK_ERRORS])
    return no_op_audit(bundle, rounds=rounds, rejections=rejections)


def _feedback(errors: Sequence[str], lead: str) -> str:
    unique = list(dict.fromkeys(error[:200] for error in errors))[:MAX_FEEDBACK_ERRORS]
    return (
        f"{lead} by the deterministic checks:\n- "
        + "\n- ".join(unique)
        + "\nReply with a corrected JSON object. All the rules still apply."
    )


def _accepted(
    result: LLMResult[AuditorOutput],
    bundle: AuditorInput,
    rounds: int,
    rejections: Sequence[str],
    deliberation: LLMResult[AuditorOutput] | None = None,
    *,
    placeholders: int = 0,
) -> AuditResult:
    """`deliberation` is the thinking call whose rejected answer a fix round corrected: its
    reasoning is the one shown."""
    thought = deliberation if deliberation is not None and not result.reasoning else result
    answer = result.value
    line = adjustment_line(bundle, answer.auditor_adjustment, answer.adjustment_reason)
    output = answer.model_copy(update={"summary_md": f"{answer.summary_md.rstrip()}\n\n{line}"})
    source = _SOURCE[result.tier]
    return AuditResult(
        output=output,
        citations=_resolved_citations(answer, bundle),
        source=source,
        model=result.model,
        degraded=source != "ultra",
        fallback=False,
        rounds=rounds,
        rejections=tuple(rejections),
        greenwashing_risk=output.greenwashing_risk,
        reasoning=thought.reasoning,
        reasoning_tokens=thought.reasoning_tokens,
        placeholders_filled=placeholders,
    )


def _resolved_citations(output: AuditorOutput, bundle: AuditorInput) -> tuple[str, ...]:
    used = _cited_ids(output)
    return tuple(i for i in bundle.ids if i in used)


def no_op_audit(
    bundle: AuditorInput, *, rounds: int = 0, rejections: Sequence[str] = ()
) -> AuditResult:
    """The audit used when no model answer passes: no adjustment, neutral agreement
    (`scoring.DEFAULT_AGREEMENT`, recorded as `agreement_source="default"` by `apply_audit`),
    one `auditor_unavailable` flag, greenwashing **not assessed** (`greenwashing_risk=None`;
    the schema's required `output.greenwashing_risk` is a filler) and a template summary
    built only from bundle facts."""
    citations = ["score:base_health", "score:base_grade", "valuation:value_mid"]
    value_mid = bundle.fact("valuation:value_mid") or "unavailable"
    summary = (
        f"## Ecological Performance Report — {bundle.period}\n\n"
        f"Health is **{bundle.base_health} out of 100 (grade {bundle.base_grade})** "
        "[score:base_health] [score:base_grade], the deterministic score from satellite metrics "
        "and news. The AI Auditor was unavailable, so no adjustment was applied, confidence "
        "uses neutral agreement and greenwashing risk was not assessed. Estimated "
        f"ecosystem-service value: {value_mid} "
        "[valuation:value_mid]. Sandbox prices are play money; nothing here is a real security."
    )
    output = AuditorOutput(
        auditor_adjustment=0,
        adjustment_reason="",
        agreement=float(DEFAULT_AGREEMENT),
        flags=[
            AuditorFlag(
                type=AuditorFlagType.AUDITOR_UNAVAILABLE.value,
                detail="No valid AI audit; the rating uses the deterministic base score.",
                citation="score:base_health",
            )
        ],
        greenwashing_risk="low",
        key_changes=[],
        recommendations=[],
        summary_md=summary,
        citations=citations,
    )
    return AuditResult(
        output=output,
        citations=tuple(i for i in bundle.ids if i in citations),
        source="fallback",
        model=None,
        degraded=True,
        fallback=True,
        rounds=rounds,
        rejections=tuple(rejections),
        greenwashing_risk=None,
    )


# ----- applying the audit ---------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ScoreInputs:
    """The arguments of `scoring.score` other than the Auditor's, so a rating can be re-scored
    with the audit through the one deterministic path."""

    ndvi_mean: Number
    ndvi_trend: Number
    ndvi_trend_significant: bool
    natural_fraction: Number
    forest_loss_ha: Number
    area_ha: Number
    water_change: Number
    is_wetland: bool
    events: tuple[scoring.ThreatEvent, ...]
    cloud_free_obs: int
    data_age_days: int
    has_validated_field_evidence: bool = False
    forest_loss_last_12m_ha: Number | None = None

    @classmethod
    def from_metrics(
        cls,
        metrics: EarthObsMetrics,
        *,
        is_wetland: bool,
        data_age_days: int,
        events: Iterable[scoring.ThreatEvent] = (),
        has_validated_field_evidence: bool = False,
        forest_loss_last_12m_ha: Number | None = None,
    ) -> ScoreInputs:
        """Same inputs as `scoring.score_metrics`."""
        return cls(
            ndvi_mean=metrics.ndvi_mean,
            ndvi_trend=metrics.ndvi_trend,
            ndvi_trend_significant=metrics.ndvi_trend_details.significant_05,
            natural_fraction=metrics.natural_fraction,
            forest_loss_ha=metrics.forest_loss_ha,
            area_ha=metrics.area_ha,
            water_change=metrics.water_change,
            is_wetland=is_wetland,
            events=tuple(events),
            cloud_free_obs=metrics.cloud_free_obs,
            data_age_days=data_age_days,
            has_validated_field_evidence=has_validated_field_evidence,
            forest_loss_last_12m_ha=forest_loss_last_12m_ha,
        )

    def score(
        self,
        *,
        agreement: Number | None = None,
        auditor_adjustment: int = 0,
        adjustment_reason: str | None = None,
    ) -> ScoreResult:
        return scoring.score(
            ndvi_mean=self.ndvi_mean,
            ndvi_trend=self.ndvi_trend,
            ndvi_trend_significant=self.ndvi_trend_significant,
            natural_fraction=self.natural_fraction,
            forest_loss_ha=self.forest_loss_ha,
            area_ha=self.area_ha,
            water_change=self.water_change,
            is_wetland=self.is_wetland,
            events=self.events,
            cloud_free_obs=self.cloud_free_obs,
            data_age_days=self.data_age_days,
            agreement=agreement,
            has_validated_field_evidence=self.has_validated_field_evidence,
            auditor_adjustment=auditor_adjustment,
            adjustment_reason=adjustment_reason,
            forest_loss_last_12m_ha=self.forest_loss_last_12m_ha,
        )


def apply_audit(inputs: ScoreInputs, audit: AuditResult) -> ScoreResult:
    """Re-score with the audit's bounded adjustment and agreement. Components, base health and
    the valuation are untouched; health moves by exactly the adjustment (clamped to [0, 100])
    and confidence only through agreement. The no-op audit leaves agreement at the default."""
    output = audit.output
    return inputs.score(
        agreement=None if audit.fallback else output.agreement,
        auditor_adjustment=output.auditor_adjustment,
        adjustment_reason=output.adjustment_reason.strip() or None,
    )

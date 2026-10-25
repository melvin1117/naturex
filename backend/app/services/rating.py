"""Deterministic rating service (T19): metrics → valuation → score → report vN.

`rate_site` is pure: it turns one set of Earth observation metrics into every number a report
holds (T14 valuation, T15 score, the dev-spec §8 fair value per share) plus flags and a
snapshot of how each number was made. `rate_asset` stores that as one `metrics` row, one
`reports` row (version n + 1) and a `report` ledger entry in the caller's transaction; the
caller commits. No model is called here: the Orchestrator and Auditor (T26, T27) build on
these numbers and may only adjust health within ±10 with cited evidence.

Storage without new columns (T19):
- `reports.flags`: a list of `{"type", "source", "detail"}` objects (valuation, scoring and
  data flags); a simulated Time Machine version always carries a `simulated` flag.
- `reports.auditor_json["rating"]`: the deterministic snapshot (`SiteRating.snapshot`).
  The Auditor's own output goes under `auditor_json["auditor"]` (T26).
- `metrics.data_version`: `sim-N` marks a simulated version (dev-spec §5); its full scenario
  labels live in the report's `simulated` flag and snapshot, and since T38 the whole document
  is in `metrics.provenance` (the Time Machine's starting point for an event preset).

Audited reports (T27): `rate_asset(..., events=, audit=, run=)` scores the same metrics with the
run's events, then applies the Auditor's bounded adjustment and agreement through
`auditor.apply_audit`, so every stored number still comes from `rate_site` + `apply_audit`.
`auditor_json` then also holds `auditor` (the validated `AuditorOutput`), `audit` (source,
model, degraded, `greenwashing_risk` with None = not assessed) and `run` (the run record).
"""

from __future__ import annotations

import hashlib
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, col, select

from app.agents.auditor import (
    REASONING_EXCERPT_CHARS,
    AuditEvent,
    AuditResult,
    ScoreInputs,
    apply_audit,
)
from app.ledger import append
from app.market.engine import fair_value_per_share, fair_value_total
from app.models import Asset, LedgerKind, Metrics, Report
from app.tools.earth_obs import (
    MOCK_ATTRIBUTION,
    MOCK_FLAG,
    EarthObsMetrics,
    is_mock_metrics,
    load_site_metrics,
)
from app.tools.field_evidence import split_field_evidence
from app.tools.scoring import (
    GATE_CONFIDENCE_BELOW_70,
    GATE_FOREST_LOSS,
    GATE_GRADE_BELOW_C,
    RECENCY_FRESH_MAX_DAYS,
    ScoreResult,
    ThreatEvent,
    is_wetland_from_landcover,
    metrics_data_age_days,
    score_metrics,
)
from app.tools.valuation import ValuationResult, value_metrics

RATING_METHOD_VERSION = "wildworth-rating/1.0 (T19)"
SANDBOX_NOTE = "Sandbox prices are play money only; nothing here is a real security or investment."
SIMULATED_DATA_VERSION_PREFIX = "sim-"

_VALUATION_FLAG_DETAILS = {
    "low_bound_fallback": "Low bound uses a fallback median/mean ratio for this biome.",
    "unverified_coefficient": "A valuation coefficient is not yet verified against its source.",
    "landcover_renormalised": "Land-cover shares were renormalised to sum to 1.",
    "coastal_water_as_lakes": "Coastal open water is valued as lakes and rivers.",
    "mangrove_fraction_capped": "Mangrove share capped at trees + flooded vegetation.",
    "soc_missing": "No soil organic carbon input, so wetland soil carbon isn't counted.",
}
_GATE_FLAG_DETAILS = {
    GATE_CONFIDENCE_BELOW_70: "Listing gate: confidence is below 70.",
    GATE_GRADE_BELOW_C: "Listing gate: grade is below C.",
    GATE_FOREST_LOSS: "Listing gate: forest loss in the last 12 months is 1% of the area or more.",
}


def _flag(code: str, source: str, detail: str) -> dict[str, str]:
    return {"type": code, "source": source, "detail": detail}


def _money(value: int) -> str:
    return f"${value:,}"


@dataclass(frozen=True, slots=True)
class SiteRating:
    """Every deterministic number of one rating, before it is stored."""

    metrics: EarthObsMetrics
    as_of: date
    data_age_days: int
    is_wetland: bool
    valuation: ValuationResult
    score: ScoreResult
    total_shares: int
    fair_value_total: Decimal
    fair_value_per_share: Decimal

    @property
    def period(self) -> str:
        """The quarter this version stands for (a simulated version's display quarter)."""
        return self.metrics.period or self.metrics.data_version

    def with_score(self, score: ScoreResult) -> SiteRating:
        """This rating with another score of the same metrics (the audited one), and the fair
        value recomputed from its health and confidence (dev-spec §8)."""
        value_mid = Decimal(self.valuation.value_mid)
        return replace(
            self,
            score=score,
            fair_value_total=fair_value_total(
                value_mid=value_mid, health=score.health, confidence=score.confidence
            ),
            fair_value_per_share=fair_value_per_share(
                value_mid=value_mid,
                health=score.health,
                confidence=score.confidence,
                total_shares=self.total_shares,
            ),
        )

    @property
    def value_breakdown(self) -> dict[str, int]:
        """Mid value per service group (Int$2020/yr); sums exactly to `value_mid`."""
        return {service.group: service.value_mid for service in self.valuation.services}

    def flags(self) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        metrics = self.metrics
        if is_mock_metrics(metrics):
            out.append(_flag(MOCK_FLAG, "data", MOCK_ATTRIBUTION))
        if metrics.simulated:
            out.append(
                _flag(
                    "simulated",
                    "data",
                    f"Simulated Time Machine version '{metrics.scenario}' ({metrics.data_version},"
                    f" shown as {metrics.period}): scripted changes to observed "
                    f"{metrics.observed_data_version} data, not an observation.",
                )
            )
        for code in self.valuation.flags:
            prefix = code.split(":", 1)[0]
            out.append(_flag(code, "valuation", _VALUATION_FLAG_DETAILS.get(prefix, code)))
        score = self.score
        if score.agreement_source == "default":
            out.append(
                _flag(
                    "auditor_pending",
                    "scoring",
                    "No Auditor review yet: satellite/news agreement defaults to 0.5.",
                )
            )
        if score.gate.forest_loss_basis == "5y_total_proxy":
            out.append(
                _flag(
                    "forest_loss_last_12m_missing",
                    "scoring",
                    "No last-12-month forest loss: the gate uses the 5-year loss instead.",
                )
            )
        if self.data_age_days >= RECENCY_FRESH_MAX_DAYS:
            out.append(
                _flag(
                    "data_stale",
                    "scoring",
                    f"Freshest satellite data is {self.data_age_days} days old.",
                )
            )
        for reason in score.gate.reasons:
            out.append(_flag(f"listing_gate:{reason}", "scoring", _GATE_FLAG_DETAILS[reason]))
        return out

    def snapshot(self) -> dict[str, Any]:
        """JSON-safe record of the inputs and every intermediate number (auditor_json.rating)."""
        metrics = self.metrics
        return {
            "method_version": RATING_METHOD_VERSION,
            "as_of": self.as_of.isoformat(),
            "data_age_days": self.data_age_days,
            "period": self.period,
            "is_wetland": self.is_wetland,
            "metrics": metrics.model_dump(mode="json", exclude={"ndvi_series", "datasets"}),
            "score": self.score.to_json_dict(),
            "valuation": self.valuation.model_dump(mode="json"),
            "fair_value": {
                "formula": "value_mid × 10 × (0.5 + 0.5 × health/100) × "
                "(0.7 + 0.3 × confidence/100) / total_shares",
                "value_mid": str(self.valuation.value_mid),
                "health": str(self.score.health),
                "confidence": str(self.score.confidence),
                "total_shares": self.total_shares,
                "fair_value_total": str(self.fair_value_total),
                "fair_value_per_share": str(self.fair_value_per_share),
            },
        }

    def summary_md(self, asset_name: str, version: int) -> str:
        """Deterministic template summary; T10's live summary decorates it at read time."""
        metrics, score, valuation = self.metrics, self.score, self.valuation
        lines = [f"## {asset_name}: rating report v{version} ({self.period})", ""]
        if metrics.simulated:
            lines += [
                f"> **Simulated scenario ({metrics.scenario}).** Scripted changes to observed "
                f"{metrics.observed_data_version} data, shown as {metrics.period}. "
                "Not an observation.",
                "",
            ]
        gate = "passes" if score.gate.passed else "does not pass"
        lines += [
            f"**Health {score.health} / 100 (grade {score.grade.value})**, "
            f"confidence {score.confidence}%.",
            "",
            f"Estimated ecosystem services: **{_money(valuation.value_low)} to "
            f"{_money(valuation.value_high)} a year** (mid {_money(valuation.value_mid)}, "
            f"Int$ at 2020 prices) for {metrics.area_ha:,.1f} ha. Stored carbon is about "
            f"{valuation.carbon.total_stock_tco2:,} tCO₂, not added to the dollar value.",
            "",
            f"The site {gate} the listing gate. This is a deterministic first rating from "
            "cached satellite metrics: no Auditor review, news check or field evidence yet.",
            "",
            SANDBOX_NOTE,
        ]
        return "\n".join(lines)


def rate_site(
    metrics: EarthObsMetrics,
    *,
    is_wetland: bool,
    as_of: date,
    total_shares: int,
    events: Iterable[ThreatEvent] = (),
) -> SiteRating:
    """Rate one set of metrics: T14 valuation, T15 score and the §8 fair value per share.

    ``is_wetland`` is the asset's fixed wetland status (from its baseline, never from the
    version being scored). ``as_of`` is the rating date, which sets the recency term.
    ``events``: News Scout events feed the threat-pressure term T; validated field evidence
    (T40) sets the confidence evidence term instead and never feeds T.
    """
    age = metrics_data_age_days(metrics, as_of=as_of)
    valuation = value_metrics(metrics)
    threats, has_evidence = split_field_evidence(events)
    score = score_metrics(
        metrics,
        is_wetland=is_wetland,
        data_age_days=age,
        events=threats,
        has_validated_field_evidence=has_evidence,
        forest_loss_last_12m_ha=metrics.forest_loss_last_12m_ha,
    )
    value_mid = Decimal(valuation.value_mid)
    return SiteRating(
        metrics=metrics,
        as_of=as_of,
        data_age_days=age,
        is_wetland=is_wetland,
        valuation=valuation,
        score=score,
        total_shares=total_shares,
        fair_value_total=fair_value_total(
            value_mid=value_mid, health=score.health, confidence=score.confidence
        ),
        fair_value_per_share=fair_value_per_share(
            value_mid=value_mid,
            health=score.health,
            confidence=score.confidence,
            total_shares=total_shares,
        ),
    )


def observed_until(metrics: EarthObsMetrics) -> date:
    """End of the freshest Sentinel-2 window: the date a cached demo rating is made on."""
    return date.fromisoformat(metrics.date_windows["ndvi"].end)


def is_simulated_data_version(data_version: str) -> bool:
    return data_version.startswith(SIMULATED_DATA_VERSION_PREFIX)


def asset_is_wetland(session: Session, asset: Asset, metrics: EarthObsMetrics) -> bool:
    """The asset's wetland status, decided once from its baseline land cover (T15 rule).

    Curated sites use their committed baseline; other assets use their earliest observed
    `metrics` row, or these metrics when they are the asset's first observed data.
    """
    if asset.site_key is not None:
        return is_wetland_from_landcover(load_site_metrics(asset.site_key).landcover)
    first = session.exec(
        select(Metrics.landcover)
        .where(
            Metrics.world_id == asset.world_id,
            Metrics.asset_id == asset.id,
            ~col(Metrics.data_version).startswith(SIMULATED_DATA_VERSION_PREFIX),
        )
        .order_by(col(Metrics.created_at))
        .limit(1)
    ).first()
    if first is not None:
        return is_wetland_from_landcover(first)
    if metrics.simulated:
        raise ValueError(f"asset {asset.id} has no observed baseline to decide wetland status")
    return is_wetland_from_landcover(metrics.landcover)


@dataclass(frozen=True, slots=True)
class FairValueInputs:
    """What a report's fair value was computed from (dev-spec §8)."""

    value_mid: Decimal
    health: Decimal
    confidence: Decimal


def _snapshot_decimal(snapshot: Mapping[str, Any], key: str) -> Decimal | None:
    value = snapshot.get(key)
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def _fair_value_snapshot(report: Report) -> Mapping[str, Any]:
    rating = (report.auditor_json or {}).get("rating")
    snapshot = rating.get("fair_value") if isinstance(rating, Mapping) else None
    return snapshot if isinstance(snapshot, Mapping) else {}


def fair_value_inputs(report: Report) -> FairValueInputs | None:
    """The fair value inputs a sealed report was priced from, all from one source.

    The rating snapshot (`auditor_json.rating.fair_value`) holds the exact, unrounded inputs,
    so with the report's own share count they reproduce its `fair_value_per_share`; it is used
    when it has all three. Otherwise the stored columns, when they have all three. None if
    neither does.
    """
    snapshot = _fair_value_snapshot(report)
    exact = [_snapshot_decimal(snapshot, key) for key in ("value_mid", "health", "confidence")]
    stored = [report.value_mid, report.health_score, report.confidence]
    for value_mid, health, confidence in (exact, stored):
        if value_mid is not None and health is not None and confidence is not None:
            return FairValueInputs(value_mid=value_mid, health=health, confidence=confidence)
    return None


def report_fair_value_total(report: Report) -> Decimal | None:
    """The report's total fair value (independent of the share count): the snapshot's, else
    recomputed from its inputs by the market engine. None without inputs."""
    stored = _snapshot_decimal(_fair_value_snapshot(report), "fair_value_total")
    if stored is not None:
        return stored
    inputs = fair_value_inputs(report)
    if inputs is None:
        return None
    try:
        return fair_value_total(
            value_mid=inputs.value_mid, health=inputs.health, confidence=inputs.confidence
        )
    except ValueError:
        return None


_CARBON_PATH = ("rating", "valuation", "carbon")
"""Where a report's carbon snapshot lives in `auditor_json` (T14 valuation via T19)."""


def carbon_stock(carbon: object) -> Decimal | None:
    """The carbon stock (tCO2) in a report's `rating.valuation.carbon` snapshot, if any."""
    return _snapshot_decimal(carbon, "total_stock_tco2") if isinstance(carbon, Mapping) else None


def report_carbon_stock(report: Report) -> Decimal | None:
    """The report's stored carbon stock (`rating.valuation.carbon.total_stock_tco2`), or None
    when it has none or it isn't a number. Negative or non-finite values are returned as stored;
    callers that sum them (`revenue.site_impact`) count those as zero."""
    node: object = report.auditor_json
    for key in _CARBON_PATH:
        node = node.get(key) if isinstance(node, Mapping) else None
    return carbon_stock(node)


@dataclass(frozen=True, slots=True)
class ReportImpact:
    """What a site's latest report says about its impact (T44): annual services and carbon."""

    value_mid: Decimal | None
    carbon_stock_tco2: Decimal | None


def latest_report_impacts(
    session: Session, world_id: UUID, asset_ids: Collection[UUID]
) -> dict[UUID, ReportImpact]:
    """Each asset's latest report's `value_mid` and carbon stock, in one query that reads only
    those two values (never the whole report). Assets without a report are left out."""
    if not asset_ids:
        return {}
    rows = session.exec(
        select(
            col(Report.asset_id),
            col(Report.value_mid),
            col(Report.auditor_json)[_CARBON_PATH],
        )
        .where(Report.world_id == world_id, col(Report.asset_id).in_(asset_ids))
        .order_by(col(Report.asset_id), col(Report.version).desc())
        .distinct(col(Report.asset_id))
    ).all()
    return {
        asset_id: ReportImpact(value_mid=value_mid, carbon_stock_tco2=carbon_stock(carbon))
        for asset_id, value_mid, carbon in rows
    }


def latest_report(session: Session, world_id: UUID, asset_id: UUID) -> Report | None:
    return session.exec(
        select(Report)
        .where(Report.world_id == world_id, Report.asset_id == asset_id)
        .order_by(col(Report.version).desc())
        .limit(1)
    ).first()


def _metrics_row(world_id: UUID, asset_id: UUID, metrics: EarthObsMetrics) -> Metrics:
    def dec(value: float | None, places: str) -> Decimal | None:
        return None if value is None else Decimal(repr(value)).quantize(Decimal(places))

    return Metrics(
        world_id=world_id,
        asset_id=asset_id,
        data_version=metrics.data_version,
        landcover=dict(metrics.landcover),
        ndvi_series=[point.model_dump(mode="json") for point in metrics.ndvi_series],
        ndvi_trend=dec(metrics.ndvi_trend, "0.000001"),
        water_change=dec(metrics.water_change, "0.0001"),
        forest_loss_ha=dec(metrics.forest_loss_ha, "0.01"),
        biomass_t_ha=dec(metrics.biomass_t_ha, "0.01"),
        cloud_free_obs=metrics.cloud_free_obs,
        provenance=metrics.model_dump(mode="json", by_alias=True),
    )


def audited_rating(
    rating: SiteRating, *, events: Sequence[AuditEvent], audit: AuditResult
) -> SiteRating:
    """`rating` re-scored with the Auditor's bounded adjustment and agreement (T26 path)."""
    metrics = rating.metrics
    threats, has_evidence = split_field_evidence(events)
    inputs = ScoreInputs.from_metrics(
        metrics,
        is_wetland=rating.is_wetland,
        data_age_days=rating.data_age_days,
        events=threats,
        has_validated_field_evidence=has_evidence,
        forest_loss_last_12m_ha=metrics.forest_loss_last_12m_ha,
    )
    return rating.with_score(apply_audit(inputs, audit))


def event_snapshot(event: AuditEvent) -> dict[str, Any]:
    """An event as the rating used it. Title and summary are untrusted text, kept as data."""
    return {
        "id": event.citation_id,
        "source": event.source,
        "relevant": event.relevant,
        "impact_type": event.impact_type,
        "direction": event.direction,
        "severity": event.severity,
        "published_at": event.published_at.isoformat() if event.published_at else None,
        "validated": event.validated,
        "title": event.title,
        "summary": event.summary,
    }


def audit_snapshot(audit: AuditResult) -> dict[str, Any]:
    """How the audit was made (`auditor_json["audit"]`); `greenwashing_risk` None = not
    assessed, because the no-op audit's `output.greenwashing_risk` is only a schema filler."""
    return {
        "source": audit.source,
        "model": audit.model,
        "degraded": audit.degraded,
        "fallback": audit.fallback,
        "rounds": audit.rounds,
        "rejections": [rejection[:200] for rejection in audit.rejections[:8]],
        "citations": list(audit.citations),
        "greenwashing_risk": audit.greenwashing_risk,
        "reasoning_tokens": audit.reasoning_tokens,
        # The model's own notes, shown collapsed and labelled as notes, never as evidence.
        "reasoning_excerpt": (audit.reasoning or "")[:REASONING_EXCERPT_CHARS] or None,
    }


def _audit_flags(audit: AuditResult) -> list[dict[str, str]]:
    return [_flag(flag.type, "auditor", flag.detail) for flag in audit.output.flags]


def _audited_summary(audit: AuditResult) -> str:
    summary = audit.output.summary_md.rstrip()
    return summary if "play money" in summary else f"{summary}\n\n{SANDBOX_NOTE}"


def _ledger_payload(
    report: Report,
    rating: SiteRating,
    flags: Sequence[Mapping[str, str]],
    *,
    events: Sequence[AuditEvent] = (),
    audit: AuditResult | None = None,
) -> dict[str, Any]:
    """The report's business values themselves, so editing the row is detectable (§17)."""
    summary = report.summary_md or ""
    payload: dict[str, Any] = {
        "version": report.version,
        "data_version": rating.metrics.data_version,
        "simulated": rating.metrics.simulated,
        "as_of": rating.as_of.isoformat(),
        "health_score": str(report.health_score),
        "grade": report.grade,
        "confidence": str(report.confidence),
        "value_low": str(report.value_low),
        "value_mid": str(report.value_mid),
        "value_high": str(report.value_high),
        "value_breakdown": rating.value_breakdown,
        "fair_value_per_share": str(report.fair_value_per_share),
        "flags": [flag["type"] for flag in flags],
        "summary_sha256": hashlib.sha256(summary.encode()).hexdigest(),
        "method_version": RATING_METHOD_VERSION,
    }
    if audit is not None:
        output = audit.output
        payload["audit"] = {
            "source": audit.source,
            "auditor_adjustment": output.auditor_adjustment,
            "agreement": None if audit.fallback else str(output.agreement),
            "greenwashing_risk": audit.greenwashing_risk,
        }
        payload["event_ids"] = [event.citation_id for event in events]
    return payload


def rate_asset(
    session: Session,
    world_id: UUID,
    asset: Asset,
    *,
    metrics: EarthObsMetrics,
    as_of: date,
    previous_report: Report | None = None,
    is_wetland: bool | None = None,
    events: Sequence[AuditEvent] = (),
    audit: AuditResult | None = None,
    run: Mapping[str, Any] | None = None,
    extra_flags: Sequence[Mapping[str, str]] = (),
) -> Report:
    """Store report v(n + 1) for an asset from these metrics, with its metrics row and ledger
    entry, in the caller's transaction (the caller commits).

    ``metrics`` may be a Time Machine scenario (`load_site_metrics(site, scenario)`); it is
    stored under its `sim-N` data version and flagged `simulated`. ``is_wetland`` overrides
    the baseline rule for an asset with a declared ecosystem type. ``previous_report``, if
    given, must be the asset's latest report; the version always comes from the database.

    A rating run (T27) also passes the ``events`` it scored with, the ``audit`` (applied only
    through `apply_audit`), its ``run`` record and any run ``extra_flags``. The ledger entry
    then covers the audited numbers, the audit's adjustment and agreement and the event IDs.
    """
    if asset.world_id != world_id:
        raise ValueError(f"asset {asset.id} is not in world {world_id}")
    if asset.site_key is not None and metrics.site_key != asset.site_key:
        raise ValueError(f"metrics for {metrics.site_key!r} can't rate asset {asset.site_key!r}")
    # Lock the asset so concurrent ratings queue for the version (ledger.append locks it too).
    locked = session.exec(
        select(Asset.id).where(Asset.id == asset.id, Asset.world_id == world_id).with_for_update()
    ).one_or_none()
    if locked is None:
        raise LookupError(f"asset {asset.id} not found in world {world_id}")
    last_version = session.exec(
        select(func.max(Report.version)).where(
            Report.world_id == world_id, Report.asset_id == asset.id
        )
    ).one()
    if previous_report is not None and (
        previous_report.asset_id != asset.id or previous_report.version != last_version
    ):
        raise ValueError("previous_report is not this asset's latest report")

    wetland = asset_is_wetland(session, asset, metrics) if is_wetland is None else is_wetland
    rating = rate_site(
        metrics,
        is_wetland=wetland,
        as_of=as_of,
        total_shares=asset.total_shares,
        events=events,
    )
    if audit is not None:
        rating = audited_rating(rating, events=events, audit=audit)
    version = (last_version or 0) + 1
    flags = [*rating.flags(), *(_audit_flags(audit) if audit else []), *map(dict, extra_flags)]
    snapshot = rating.snapshot()
    if events or audit is not None:
        snapshot["events"] = [event_snapshot(event) for event in events]
    auditor_json: dict[str, Any] = {"rating": snapshot}
    if audit is not None:
        auditor_json["auditor"] = audit.output.model_dump(mode="json")
        auditor_json["audit"] = audit_snapshot(audit)
    if run is not None:
        auditor_json["run"] = dict(run)

    metrics_row = _metrics_row(world_id, asset.id, metrics)
    session.add(metrics_row)
    session.flush()
    report = Report(
        world_id=world_id,
        asset_id=asset.id,
        version=version,
        metrics_id=metrics_row.id,
        health_score=rating.score.health,
        grade=rating.score.grade.value,
        confidence=rating.score.confidence,
        value_low=Decimal(rating.valuation.value_low),
        value_mid=Decimal(rating.valuation.value_mid),
        value_high=Decimal(rating.valuation.value_high),
        value_breakdown=rating.value_breakdown,
        fair_value_per_share=rating.fair_value_per_share,
        flags=flags,
        summary_md=_audited_summary(audit) if audit else rating.summary_md(asset.name, version),
        recommendations=list(audit.output.recommendations) if audit else [],
        auditor_json=auditor_json,
    )
    session.add(report)
    session.flush()
    append(
        session,
        world_id=world_id,
        asset_id=asset.id,
        kind=LedgerKind.REPORT,
        payload=_ledger_payload(report, rating, flags, events=events, audit=audit),
        ref_id=report.id,
    )
    return report

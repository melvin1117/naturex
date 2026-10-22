"""The listing lifecycle (T58): a pure state machine over `AssetStatus`.

| event    | from                                  | to                                     |
|----------|---------------------------------------|----------------------------------------|
| create   | (none)                                | draft                                  |
| edit     | draft                                 | draft                                  |
| submit   | draft; rating (retry); needs_evidence | rating                                 |
| rated    | rating                                | listed · needs_evidence · ineligible   |
| revise   | rating (no run); needs_evidence       | draft                                  |
| withdraw | draft; rating (no run); needs_evidence | withdrawn                             |
| suspend  | listed                                | suspended (admin)                      |
| resume   | suspended                             | listed (admin)                         |

- The listing gate (T15: confidence ≥ 70, grade ≥ C, recent forest loss < 1 % of the area) is
  read from the sealed report of the run that rated the listing, and it applies **only while
  the listing is `rating`**. A re-rate of a listed or suspended asset (T27, Time Machine) never
  changes its status (the T13 note under T38).
- A gate failure on confidence alone is `needs_evidence`: validated field evidence or newer
  satellite data can raise confidence (dev-spec §7.7), so the listing may be resubmitted once
  either exists, or revised back to a draft. A failure on grade or recent forest loss is
  `ineligible`: evidence can't undo degradation, so the listing ends there.
- `revise` returns a listing under review (`needs_evidence`, or `rating` with no active run) to
  `draft` so the community can redraw it; `withdraw` ends a listing that never got listed. Both
  `ineligible` and `withdrawn` are terminal and free the land and the community's slot.
- `listed ↔ suspended` is an admin action (`Action.OPERATE`); T69's revocation suspends too.

Everything here is pure: callers load state, ask for the transition and persist it
(`app.services.listings`). A refused transition is a `TransitionRefused` with a stable code,
which the API returns as 409.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from app.models import AssetStatus
from app.tools.scoring import (
    GATE_CONFIDENCE_BELOW_70,
    GATE_FOREST_LOSS,
    GATE_GRADE_BELOW_C,
)

GATE_REASONS = frozenset({GATE_CONFIDENCE_BELOW_70, GATE_GRADE_BELOW_C, GATE_FOREST_LOSS})

GATED_STATUSES = frozenset({AssetStatus.LISTED, AssetStatus.SUSPENDED})
"""Listings that passed the listing gate: listed, or suspended by an admin. Not a visibility
rule: ask `is_public` (or `app.services.visibility.public_assets` in a query)."""
TERMINAL_STATUSES = frozenset({AssetStatus.INELIGIBLE, AssetStatus.WITHDRAWN})
SUBMITTED_STATUSES = frozenset(
    {AssetStatus.RATING, AssetStatus.NEEDS_EVIDENCE, AssetStatus.LISTED, AssetStatus.SUSPENDED}
)
"""Listings that claim their land against every community: the first one submitted wins.
Drafts claim land only against their own community's other drafts."""
OPEN_STATUSES = frozenset({AssetStatus.DRAFT, AssetStatus.RATING, AssetStatus.NEEDS_EVIDENCE})
"""Listings in progress, counted against a community's open-listing cap."""

EVIDENCE_REQUIRED = "evidence_required"
METRICS_UNAVAILABLE = "metrics_unavailable"
NO_SATELLITE_METRICS = "no_satellite_metrics"
"""`status_reason` of a listing stuck in `rating` because no Earth observation metrics exist
for its polygon yet (live Earth Engine is off: T60). It never borrows another site's data."""
RATING_FAILED_PREFIX = "rating_failed:"


class ListingEvent(StrEnum):
    CREATE = "create"
    EDIT = "edit"
    SUBMIT = "submit"
    RATED = "rated"
    SUSPEND = "suspend"
    RESUME = "resume"
    REVISE = "revise"
    WITHDRAW = "withdraw"


class SuspensionReason(StrEnum):
    MODERATION = "moderation"
    DATA_DISPUTE = "data_dispute"
    COMMUNITY_REQUEST = "community_request"
    VERIFICATION_REVOKED = "verification_revoked"
    """Reserved for T69's revocation."""


@dataclass(frozen=True, slots=True)
class Transition:
    event: ListingEvent
    from_status: AssetStatus | None
    to_status: AssetStatus
    reason: str | None = None
    """Stored as the asset's `status_reason`: gate failure codes, a suspension reason, or None."""


class TransitionRefused(Exception):
    """The transition isn't allowed from the current status (HTTP 409 `code`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def refused_code(event: ListingEvent, status: AssetStatus) -> str:
    return f"cannot_{event.value}_{status.value}"


@dataclass(frozen=True, slots=True)
class GateResult:
    passed: bool
    reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.passed == bool(self.reasons):
            raise ValueError("a gate passes exactly when it has no failure reasons")
        unknown = set(self.reasons) - GATE_REASONS
        if unknown:
            raise ValueError(f"unknown listing gate reasons {sorted(unknown)}")


def gate_from_report(auditor_json: Mapping[str, Any] | None) -> GateResult:
    """The T15 listing gate stored with a sealed report (`auditor_json.rating.score.gate`).

    That snapshot is computed by `rate_site` + `apply_audit` on the report's own numbers, so the
    lifecycle never recomputes or guesses the gate. Raises ValueError when it's missing or
    malformed (the run then fails and the listing stays in `rating`: fail closed).
    """
    try:
        gate = (auditor_json or {})["rating"]["score"]["gate"]
        passed, reasons = gate["passed"], gate["reasons"]
    except (KeyError, TypeError) as exc:
        raise ValueError("the report has no listing gate snapshot") from exc
    if not isinstance(passed, bool) or not isinstance(reasons, list):
        raise ValueError("the report's listing gate snapshot is malformed")
    if not all(isinstance(reason, str) for reason in reasons):
        raise ValueError("the report's listing gate snapshot is malformed")
    return GateResult(passed=passed, reasons=tuple(reasons))


def gate_outcome(gate: GateResult) -> tuple[AssetStatus, str | None]:
    """Where a rated listing goes: listed, needs_evidence (confidence only) or ineligible."""
    if gate.passed:
        return AssetStatus.LISTED, None
    if set(gate.reasons) == {GATE_CONFIDENCE_BELOW_70}:
        return AssetStatus.NEEDS_EVIDENCE, GATE_CONFIDENCE_BELOW_70
    return AssetStatus.INELIGIBLE, ",".join(gate.reasons)


def is_public(status: AssetStatus, ipo_at: datetime | None) -> bool:
    """Anyone in the world may see the asset (marketplace, asset pages, ledger, Copilot, live
    events): it passed the listing gate and its IPO opened it on the exchange. In the live world
    a launch needs a verified listing (ADR-0006), so a listing waiting for verification or for
    its launch belongs to its community and same-world admins. A launched listing that is later
    suspended or revoked stays public: its holders still need to see it."""
    return status in GATED_STATUSES and ipo_at is not None


def is_newer_data_version(candidate: str | None, current: str | None) -> bool:
    """`2026Q4` is newer than `2026Q3`; versions sort as text within one source. A `mock-`
    version is never newer than an observed one, and simulated (`sim-`) ones never count."""
    if candidate is None or current is None or candidate.startswith("sim-"):
        return False
    if candidate.startswith("mock-") != current.startswith("mock-"):
        return False
    return candidate > current


def cooldown_remaining(last: datetime | None, now: datetime, cooldown: timedelta) -> int:
    """Whole seconds left before a listing may be submitted again (0: it may now)."""
    if last is None:
        return 0
    left = last + cooldown - now
    return max(0, math.ceil(left.total_seconds()))


def created() -> Transition:
    return Transition(ListingEvent.CREATE, None, AssetStatus.DRAFT)


def transition(
    current: AssetStatus,
    event: ListingEvent,
    *,
    gate: GateResult | None = None,
    has_new_evidence: bool = False,
    has_newer_metrics: bool = False,
    current_reason: str | None = None,
    metrics_available: bool = True,
    suspension: SuspensionReason | None = None,
) -> Transition:
    """The transition `event` makes from `current`, or TransitionRefused.

    - `edit`: draft → draft.
    - `submit`: draft → rating; needs_evidence → rating once new evidence or newer metrics
      exist (`evidence_required` otherwise); rating → rating is a retry, refused as
      `metrics_unavailable` while the listing waits for metrics that still don't exist (the
      caller refuses it while a run is active, as `run_in_progress`).
    - `rated` (needs `gate`): rating → listed | needs_evidence | ineligible. Refused from any
      other status, so a re-rate of a listed asset never moves it.
    - `revise`: needs_evidence | rating → draft; `withdraw`: draft | rating | needs_evidence →
      withdrawn (for `rating`, the caller refuses while a run is active).
    - `suspend` (needs `suspension`): listed → suspended; `resume`: suspended → listed.
    """
    match event, current:
        case ListingEvent.EDIT, AssetStatus.DRAFT:
            return Transition(event, current, AssetStatus.DRAFT)
        case ListingEvent.SUBMIT, AssetStatus.DRAFT:
            return Transition(event, current, AssetStatus.RATING)
        case ListingEvent.SUBMIT, AssetStatus.RATING:
            if current_reason == NO_SATELLITE_METRICS and not metrics_available:
                raise TransitionRefused(METRICS_UNAVAILABLE)
            return Transition(event, current, AssetStatus.RATING)
        case ListingEvent.SUBMIT, AssetStatus.NEEDS_EVIDENCE:
            if not (has_new_evidence or has_newer_metrics):
                raise TransitionRefused(EVIDENCE_REQUIRED)
            return Transition(event, current, AssetStatus.RATING)
        case ListingEvent.REVISE, AssetStatus.NEEDS_EVIDENCE | AssetStatus.RATING:
            return Transition(event, current, AssetStatus.DRAFT)
        case (
            ListingEvent.WITHDRAW,
            AssetStatus.DRAFT | AssetStatus.RATING | AssetStatus.NEEDS_EVIDENCE,
        ):
            return Transition(event, current, AssetStatus.WITHDRAWN)
        case ListingEvent.RATED, AssetStatus.RATING:
            if gate is None:
                raise ValueError("a rated transition needs the listing gate result")
            status, reason = gate_outcome(gate)
            return Transition(event, current, status, reason)
        case ListingEvent.SUSPEND, AssetStatus.LISTED:
            if suspension is None:
                raise ValueError("a suspension needs a reason")
            return Transition(event, current, AssetStatus.SUSPENDED, suspension.value)
        case ListingEvent.RESUME, AssetStatus.SUSPENDED:
            return Transition(event, current, AssetStatus.LISTED)
        case ListingEvent.CREATE, _:
            raise ValueError("a listing is created with `created()`, not from a status")
    raise TransitionRefused(refused_code(event, current))

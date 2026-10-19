"""Listing lifecycle (T58): the pure state machine, the listing service and the API."""

from __future__ import annotations

import pytest

from app.models import AssetStatus
from app.services.lifecycle import (
    EVIDENCE_REQUIRED,
    GateResult,
    ListingEvent,
    SuspensionReason,
    Transition,
    TransitionRefused,
    created,
    gate_from_report,
    gate_outcome,
    is_public,
    transition,
)
from app.tools.scoring import GATE_CONFIDENCE_BELOW_70, GATE_FOREST_LOSS, GATE_GRADE_BELOW_C

S = AssetStatus
E = ListingEvent
PASSED = GateResult(passed=True)
LOW_CONFIDENCE = GateResult(passed=False, reasons=(GATE_CONFIDENCE_BELOW_70,))
LOW_GRADE = GateResult(passed=False, reasons=(GATE_CONFIDENCE_BELOW_70, GATE_GRADE_BELOW_C))
FOREST_LOSS = GateResult(passed=False, reasons=(GATE_FOREST_LOSS,))

# ----- the pure state machine -------------------------------------------------------------------


def test_a_listing_is_created_as_a_draft() -> None:
    assert created() == Transition(E.CREATE, None, S.DRAFT)


@pytest.mark.parametrize(
    ("current", "event", "kwargs", "expected", "reason"),
    [
        (S.DRAFT, E.EDIT, {}, S.DRAFT, None),
        (S.DRAFT, E.SUBMIT, {}, S.RATING, None),
        (S.RATING, E.SUBMIT, {}, S.RATING, None),  # retry after a failed run
        (S.NEEDS_EVIDENCE, E.SUBMIT, {"has_new_evidence": True}, S.RATING, None),
        (S.RATING, E.RATED, {"gate": PASSED}, S.LISTED, None),
        (S.RATING, E.RATED, {"gate": LOW_CONFIDENCE}, S.NEEDS_EVIDENCE, "confidence_below_70"),
        (
            S.RATING,
            E.RATED,
            {"gate": LOW_GRADE},
            S.INELIGIBLE,
            f"{GATE_CONFIDENCE_BELOW_70},{GATE_GRADE_BELOW_C}",
        ),
        (S.RATING, E.RATED, {"gate": FOREST_LOSS}, S.INELIGIBLE, GATE_FOREST_LOSS),
        (
            S.LISTED,
            E.SUSPEND,
            {"suspension": SuspensionReason.MODERATION},
            S.SUSPENDED,
            "moderation",
        ),
        (S.SUSPENDED, E.RESUME, {}, S.LISTED, None),
    ],
)
def test_allowed_transitions(
    current: AssetStatus,
    event: ListingEvent,
    kwargs: dict[str, object],
    expected: AssetStatus,
    reason: str | None,
) -> None:
    assert transition(current, event, **kwargs) == Transition(  # type: ignore[arg-type]
        event, current, expected, reason
    )


ALLOWED = {
    (S.DRAFT, E.EDIT),
    (S.DRAFT, E.SUBMIT),
    (S.RATING, E.SUBMIT),
    (S.NEEDS_EVIDENCE, E.SUBMIT),
    (S.RATING, E.RATED),
    (S.LISTED, E.SUSPEND),
    (S.SUSPENDED, E.RESUME),
}


@pytest.mark.parametrize(
    ("current", "event"),
    [
        (status, event)
        for status in AssetStatus
        for event in ListingEvent
        if event is not E.CREATE and (status, event) not in ALLOWED
    ],
)
def test_every_other_transition_is_refused_with_a_reason(
    current: AssetStatus, event: ListingEvent
) -> None:
    with pytest.raises(TransitionRefused) as exc:
        transition(current, event, gate=PASSED, suspension=SuspensionReason.MODERATION)
    assert exc.value.code == f"cannot_{event.value}_{current.value}"


def test_resubmitting_needs_new_evidence() -> None:
    with pytest.raises(TransitionRefused) as exc:
        transition(S.NEEDS_EVIDENCE, E.SUBMIT)
    assert exc.value.code == EVIDENCE_REQUIRED


@pytest.mark.parametrize("status", [S.LISTED, S.SUSPENDED])
@pytest.mark.parametrize("gate", [LOW_CONFIDENCE, LOW_GRADE, FOREST_LOSS])
def test_the_gate_applies_at_listing_time_only(status: AssetStatus, gate: GateResult) -> None:
    """A re-rate of a listed asset never delists or suspends it (T13 note under T38)."""
    with pytest.raises(TransitionRefused):
        transition(status, E.RATED, gate=gate)


def test_creation_and_missing_inputs_are_programming_errors() -> None:
    with pytest.raises(ValueError, match="created"):
        transition(S.DRAFT, E.CREATE)
    with pytest.raises(ValueError, match="gate"):
        transition(S.RATING, E.RATED)
    with pytest.raises(ValueError, match="reason"):
        transition(S.LISTED, E.SUSPEND)


def test_gate_outcome_sorts_failures_into_needs_evidence_or_ineligible() -> None:
    assert gate_outcome(PASSED) == (S.LISTED, None)
    assert gate_outcome(LOW_CONFIDENCE) == (S.NEEDS_EVIDENCE, GATE_CONFIDENCE_BELOW_70)
    assert gate_outcome(FOREST_LOSS) == (S.INELIGIBLE, GATE_FOREST_LOSS)


def test_gate_result_is_consistent() -> None:
    with pytest.raises(ValueError):
        GateResult(passed=True, reasons=(GATE_GRADE_BELOW_C,))
    with pytest.raises(ValueError):
        GateResult(passed=False)
    with pytest.raises(ValueError, match="unknown"):
        GateResult(passed=False, reasons=("made_up",))


def test_gate_is_read_from_the_sealed_report_snapshot() -> None:
    snapshot = {"rating": {"score": {"gate": {"passed": False, "reasons": [GATE_GRADE_BELOW_C]}}}}
    assert gate_from_report(snapshot) == GateResult(False, (GATE_GRADE_BELOW_C,))
    for broken in (
        None,
        {},
        {"rating": {"score": {}}},
        {"rating": {"score": {"gate": {"passed": "yes", "reasons": []}}}},
        {"rating": {"score": {"gate": {"passed": False, "reasons": [1]}}}},
        {"rating": {"score": {"gate": {"passed": True, "reasons": ["grade_below_c"]}}}},
    ):
        with pytest.raises(ValueError):
            gate_from_report(broken)


def test_only_listed_and_suspended_assets_are_public() -> None:
    assert {status for status in AssetStatus if is_public(status)} == {S.LISTED, S.SUSPENDED}

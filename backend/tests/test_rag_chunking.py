"""Copilot chunking (T39): pure functions over stored report and event facts."""

from __future__ import annotations

import time
from datetime import date
from decimal import Decimal

from app.agents.guards import numbers_in
from app.rag.chunking import (
    MAX_CHUNK_CHARS,
    EventFacts,
    ReportFacts,
    event_chunks,
    report_chunks,
    split_text,
    strip_bundle_citations,
)

D = Decimal


def facts(**overrides: object) -> ReportFacts:
    base: dict[str, object] = {
        "asset_name": "Xochimilco wetland",
        "version": 2,
        "issued": date(2026, 10, 19),
        "data_version": "2026Q3",
        "health_score": D("72.30"),
        "grade": "B",
        "confidence": D("81.00"),
        "value_low": D("4700000.00"),
        "value_mid": D("11700000.00"),
        "value_high": D("17500000.00"),
        "fair_value_per_share": D("93.4000"),
        "previous_version": 1,
        "previous_health": D("77.60"),
        "previous_grade": "A",
        "flags": [{"type": "data_gap", "detail": "Rainy-season cloud gap"}],
        "recommendations": ["Stop the industrial expansion"],
    }
    return ReportFacts(**{**base, **overrides})  # type: ignore[arg-type]


def test_report_facts_chunk_states_the_stored_numbers_and_the_change() -> None:
    [chunk] = report_chunks(facts())

    text = chunk.content
    assert chunk.seq == 0
    assert text.startswith("Rating report version 2 for Xochimilco wetland.")
    assert "Health score 72.30 out of 100, compared with 77.60 in version 1" in text
    assert "down 5.30 points, so the rating fell" in text
    assert "Grade B (was A in version 1)." in text
    assert "Confidence 81%." in text
    assert "$11,700,000 a year (range $4,700,000 to $17,500,000)" in text
    assert "Fair value per share $93.40" in text
    assert "Flags: data_gap: Rainy-season cloud gap." in text
    assert "Recommendations: Stop the industrial expansion." in text


def test_every_number_in_a_chunk_comes_from_the_facts() -> None:
    [chunk] = report_chunks(facts())
    stored = "72.30 77.60 81% 4700000 11700000 17500000 93.40 5.30 2 1 2026 10 19 2026 3 100"

    assert numbers_in(chunk.content) <= numbers_in(stored)


def test_a_rise_and_a_first_report_are_worded_without_a_change() -> None:
    [rise] = report_chunks(facts(health_score=D("80.00")))
    [first] = report_chunks(facts(previous_version=None, previous_health=None, previous_grade=None))

    assert "up 2.40 points, so the rating rose" in rise.content
    assert "compared with" not in first.content
    assert "(was" not in first.content


def test_simulated_reports_say_so() -> None:
    [chunk] = report_chunks(facts(simulated=True, data_version="sim-1"))

    assert "simulated Time Machine scenario, not observed data" in chunk.content


def test_summary_is_split_and_auditor_bundle_citations_are_dropped() -> None:
    summary = (
        "Built-up land grew [metric:landcover.built]. "
        + "Water stayed stable for the season. " * 80
        + "News confirms it [event:5555, metric:ndvi_trend]."
    )
    chunks = report_chunks(facts(summary_md=summary))

    assert len(chunks) >= 3
    assert [c.seq for c in chunks] == list(range(len(chunks)))
    assert all(len(c.content) <= MAX_CHUNK_CHARS for c in chunks)
    joined = " ".join(c.content for c in chunks[1:])
    assert "[metric:" not in joined and "[event:" not in joined
    assert chunks[1].content.startswith("Report version 2 summary for Xochimilco wetland, part 1:")


def test_chunks_never_name_database_ids_so_world_copies_share_hashes() -> None:
    one = report_chunks(facts())
    two = report_chunks(facts())

    assert [c.sha256 for c in one] == [c.sha256 for c in two]
    assert len(one[0].sha256) == 64


def test_event_chunk() -> None:
    [chunk] = event_chunks(
        EventFacts(
            asset_name="Xochimilco wetland",
            source="tavily",
            title="Industrial park expansion cleared near Xochimilco wetlands",
            summary="State approved a 40-ha industrial park expansion bordering the wetland.",
            impact_type="encroachment",
            direction=-1,
            severity=4,
            published_at=date(2026, 9, 12),
        )
    )

    assert chunk.content == (
        "News event for Xochimilco wetland (source: tavily). Title: Industrial park expansion "
        "cleared near Xochimilco wetlands. It was published 2026-09-12. Impact type: "
        "encroachment. Severity 4 of 5. Negative for nature: it lowers the rating (a decline). "
        "Summary: State approved a 40-ha industrial park expansion bordering the wetland."
    )


def test_split_text_respects_the_limit_even_without_spaces() -> None:
    pieces = split_text("x" * 50 + " " + "y" * 30, max_chars=20)

    assert all(len(p) <= 20 for p in pieces)
    assert "".join(pieces).replace(" ", "") == "x" * 50 + "y" * 30
    assert split_text("   ") == []


def test_strip_bundle_citations_leaves_other_brackets() -> None:
    assert strip_bundle_citations("A [sic] note [metric:x] here.") == "A [sic] note here."


def test_strip_bundle_citations_handles_lists_and_hostile_input_in_linear_time() -> None:
    assert strip_bundle_citations("Up [metric:a, event:b; score:c] now.") == "Up now."
    hostile = "[_:!" + ",_:!" * 5000
    start = time.perf_counter()
    assert strip_bundle_citations(hostile) == hostile
    assert time.perf_counter() - start < 1.0

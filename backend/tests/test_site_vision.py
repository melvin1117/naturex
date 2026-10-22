"""Site vision: Nemotron 3.5 Super VL describes before/after satellite views; code checks them."""

from __future__ import annotations

import json
from datetime import date

import pytest

from app.agents.auditor import ScoreInputs, build_auditor_input, check_audit
from app.agents.site_vision import (
    ImageChange,
    ImageView,
    SiteVisionReading,
    cross_check,
    read_site_change,
    site_images,
)
from app.llm import LLMClient
from app.schemas import AuditorOutput
from app.tools.earth_obs import load_site_metrics
from app.tools.valuation import value_metrics
from tests.test_llm import FakeTransport, MemoryCallLog, reply, settings

VL = "nvidia/Nemotron-3.5-Super-VL"
WETLAND = load_site_metrics("wetland_mx")


def client(*script: object) -> tuple[LLMClient, FakeTransport]:
    transport = FakeTransport(*script)
    return LLMClient(settings(model_multimodal=VL), transport, MemoryCallLog()), transport


def change(kind: str, **overrides: str) -> ImageChange:
    return ImageChange.model_validate(
        {"kind": kind, "where": "north-east", "confidence": "medium", "note": "x", **overrides}
    )


def test_demo_sites_have_both_views_and_unknown_sites_have_none() -> None:
    for site in ("wetland_mx", "mangrove_mx", "restoration_forest"):
        pair = site_images(site)
        assert pair is not None and all(len(img) > 5_000 for img in pair)
    assert site_images(None) is None
    assert site_images("not_a_site") is None
    assert site_images("../etc") is None


@pytest.mark.parametrize(
    ("kind", "metrics", "agrees"),
    [
        ("clearing", {"forest_loss_ha": 3.2}, True),
        ("clearing", {"forest_loss_ha": 0.5}, None),
        ("clearing", {"forest_loss_ha": 0.0, "landcover": {"trees": 0.9}}, False),
        ("clearing", {"forest_loss_ha": 0.0, "landcover": {"built": 0.2}}, None),
        ("water_loss", {"water_change": -20.0}, True),
        ("water_loss", {"water_change": 3.0}, False),
        ("regrowth", {"ndvi_trend": 0.01}, True),
        ("no_clear_change", {}, None),
    ],
)
def test_code_checks_each_described_change_against_the_metrics(
    kind: str, metrics: dict[str, object], agrees: bool | None
) -> None:
    m = WETLAND.model_copy(update=metrics)
    assert cross_check(change(kind), m)[0] is agrees


def test_a_greenness_change_needs_a_significant_trend_or_a_matching_signal() -> None:
    # Sumidero: greenness drifts down (p = 0.9) with no dated drop, so "less vegetation" is
    # only a hint; Celestún's June 2025 drop confirms it; Xochimilco's spring rise confirms
    # regrowth.
    forest = load_site_metrics("restoration_forest")
    assert cross_check(change("vegetation_loss"), forest) == (
        None,
        "greenness drifts that way, but not significantly",
    )
    assert cross_check(change("vegetation_loss"), load_site_metrics("mangrove_mx"))[0] is True
    assert cross_check(change("regrowth"), WETLAND)[0] is True
    assert cross_check(change("vegetation_loss"), WETLAND)[0] is False


def test_one_call_with_both_images_and_no_numbers_kept() -> None:
    view = ImageView(water="a dark lagoon", vegetation="dense green", built_or_bare="2 roads")
    answer = SiteVisionReading(
        image_1=view,
        image_2=view,
        changes=[
            change("water_loss", where="centre", confidence="low", note="lagoon smaller"),
            change("clearing", note="about 12 ha of mangrove cleared near 3 roads"),
            change("regrowth", confidence="low"),
            change("road", confidence="low"),
        ],
    )
    llm, transport = client(reply(answer.model_dump_json()))

    vision = read_site_change(
        site_images("wetland_mx"),  # type: ignore[arg-type]
        metrics=WETLAND,
        llm=llm,
        ecosystem="wetland",
    )

    request = transport.requests[0]
    assert request["model"] == VL
    parts = request["messages"][1]["content"]
    assert [p["type"] for p in parts] == ["text", "image_url", "image_url"]
    assert all(p["image_url"]["url"].startswith("data:image/jpeg;base64,") for p in parts[1:])
    # The most confident first, three at most.
    assert [c.change.kind for c in vision.changes] == ["clearing", "water_loss", "regrowth"]
    assert [c.id for c in vision.changes] == ["image:1", "image:2", "image:3"]
    assert not any(ch.isdigit() for c in vision.changes for ch in c.change.note)
    assert not any(ch.isdigit() for ch in vision.reading.image_1.built_or_bare)
    assert "[code check:" in vision.changes[0].text()
    shown = json.loads(json.dumps(vision.to_json()))
    assert shown["before"]["water"] == "a dark lagoon"
    # The overall direction comes from the changes code confirmed, not from the model.
    assert shown["overall"] == ("degraded" if any(c.agrees for c in vision.changes) else "unclear")


def test_the_auditor_sees_image_hints_apart_from_trusted_facts() -> None:
    inputs = ScoreInputs.from_metrics(WETLAND, is_wetland=True, data_age_days=6)
    seen = "clearing, north-east (medium confidence): edge cleared [code check: not confirmed]"
    bundle = build_auditor_input(
        asset_name="Xochimilco Wetland",
        rating_date=date(2026, 10, 7),
        metrics=WETLAND,
        valuation=value_metrics(WETLAND),
        base=inputs.score(),
        observations=[("image:1", seen)],
    )

    assert "image:1" in bundle.ids and bundle.observation("image:1") == seen
    rendered = bundle.render()
    assert "## Satellite image reading" in rendered and f"image:1 = {seen}" in rendered
    assert all("image:1" not in line for line in bundle.trusted_lines())
    output = AuditorOutput(
        auditor_adjustment=0,
        adjustment_reason="",
        agreement=0.5,
        greenwashing_risk="low",
        summary_md="An edge looks cleared [image:1]; tree loss is nil [metric:forest_loss_5y_ha].",
        citations=["image:1", "metric:forest_loss_5y_ha"],
    )
    assert check_audit(output, bundle) == []

"""The ecosystem a listing protects, from satellite land cover and its name (news search words)."""

from __future__ import annotations

import pytest

from app.tools.earth_obs import load_site_metrics
from app.tools.ecosystem import Ecosystem, infer_ecosystem


@pytest.mark.parametrize(
    ("site_key", "name", "expected"),
    [
        ("wetland_mx", "Xochimilco Wetland", Ecosystem.WETLAND),
        ("mangrove_mx", "Ría Celestún Mangrove", Ecosystem.MANGROVE),
        ("restoration_forest", "Sumidero Canyon Restoration Forest", Ecosystem.FOREST),
    ],
)
def test_demo_sites(site_key: str, name: str, expected: Ecosystem) -> None:
    m = load_site_metrics(site_key, "baseline")
    assert (
        infer_ecosystem(name=name, landcover=m.landcover, mangrove_fraction=m.mangrove_fraction)
        is expected
    )


def test_mangrove_extent_wins_over_a_misleading_name() -> None:
    assert infer_ecosystem(name="Lakeside Forest", mangrove_fraction=0.6) is Ecosystem.MANGROVE


def test_little_mangrove_does_not_make_a_mangrove_site() -> None:
    landcover = {"trees": 0.8, "water": 0.05}
    assert (
        infer_ecosystem(name="Ridge", landcover=landcover, mangrove_fraction=0.05)
        is Ecosystem.FOREST
    )


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("John Pennekamp Coral Reef", Ecosystem.MARINE),
        ("Humedal de la Ciénaga", Ecosystem.WETLAND),
        ("Manglares de Nichupté", Ecosystem.MANGROVE),
        ("Selva Lacandona", Ecosystem.FOREST),
        ("Pradera alta", Ecosystem.GRASSLAND),
        ("Lago de Chapala", Ecosystem.WETLAND),
        ("Lake Titicaca shore", Ecosystem.WETLAND),
        # Common place names aren't ecosystem words: Lagos de Moreno is a town in Jalisco.
        ("Bosque Lagos de Moreno", Ecosystem.FOREST),
        ("Selva La Presa", Ecosystem.FOREST),
    ],
)
def test_name_hints_in_english_and_spanish(name: str, expected: Ecosystem) -> None:
    assert infer_ecosystem(name=name) is expected


@pytest.mark.parametrize(
    ("landcover", "expected"),
    [
        # A mostly-water site with no hint in its name may be an inland lake: never a reef.
        ({"water": 0.7, "built": 0.1}, Ecosystem.WETLAND),
        ({"water": 0.2, "flooded_vegetation": 0.15, "grass": 0.5}, Ecosystem.WETLAND),
        ({"trees": 0.55, "grass": 0.3}, Ecosystem.FOREST),
        ({"grass": 0.35, "shrub_and_scrub": 0.3}, Ecosystem.GRASSLAND),
        ({"built": 0.5, "crops": 0.4}, Ecosystem.MIXED),
    ],
)
def test_land_cover_when_the_name_says_nothing(
    landcover: dict[str, float], expected: Ecosystem
) -> None:
    assert infer_ecosystem(name="Key West", landcover=landcover) is expected


def test_nothing_known_is_mixed() -> None:
    assert infer_ecosystem(name="Parcel 7") is Ecosystem.MIXED

"""The ecosystem a listing protects, inferred from its satellite land cover and its name.

Pure and deterministic: no model decides it. News Scout uses it to search for the right kind of
news (a coral reef's threats are not a forest's). Global Mangrove Watch is the most specific
signal, then words in the steward's own name for the site, then the Dynamic World land-cover
shares.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from enum import StrEnum


class Ecosystem(StrEnum):
    MANGROVE = "mangrove"
    WETLAND = "wetland"
    MARINE = "marine"
    """Water-dominant coastal or reef sites."""
    FOREST = "forest"
    GRASSLAND = "grassland"
    MIXED = "mixed"


# A polygon at least this much mangrove (GMW) is a mangrove site whatever its name says.
MANGROVE_MIN_FRACTION = 0.3
WATER_DOMINANT = 0.5
WETLAND_MIN = 0.3
FOREST_MIN = 0.4
GRASSLAND_MIN = 0.5

# Checked in order: the first group with a word in the name wins.
_NAME_HINTS: tuple[tuple[Ecosystem, frozenset[str]], ...] = (
    (Ecosystem.MANGROVE, frozenset({"mangrove", "mangroves", "manglar", "manglares", "manguezal"})),
    (
        Ecosystem.MARINE,
        frozenset(
            {"reef", "reefs", "coral", "arrecife", "arrecifes", "marine", "marino", "seagrass"}
        ),
    ),
    (
        Ecosystem.WETLAND,
        frozenset(
            {
                "wetland",
                "wetlands",
                "marsh",
                "swamp",
                "bog",
                "fen",
                "humedal",
                "humedales",
                "cienaga",
                "pantano",
                "estero",
                "laguna",
                "lagoon",
            }
        ),
    ),
    (
        Ecosystem.FOREST,
        frozenset({"forest", "woodland", "rainforest", "bosque", "selva", "floresta", "mata"}),
    ),
    (
        Ecosystem.GRASSLAND,
        frozenset({"grassland", "prairie", "savanna", "savannah", "meadow", "pastizal", "pradera"}),
    ),
)
_WORD = re.compile(r"[^\W\d_]+")


def _words(name: str) -> set[str]:
    decomposed = unicodedata.normalize("NFKD", name)
    bare = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return set(_WORD.findall(bare.casefold()))


def _from_name(name: str) -> Ecosystem | None:
    words = _words(name)
    for ecosystem, hints in _NAME_HINTS:
        if words & hints:
            return ecosystem
    return None


def _from_landcover(landcover: Mapping[str, float]) -> Ecosystem:
    share = {key: float(value) for key, value in landcover.items()}
    water = share.get("water", 0.0)
    flooded = share.get("flooded_vegetation", 0.0)
    if water >= WATER_DOMINANT:
        return Ecosystem.MARINE
    if water + flooded >= WETLAND_MIN and flooded > 0:
        return Ecosystem.WETLAND
    if share.get("trees", 0.0) >= FOREST_MIN:
        return Ecosystem.FOREST
    if share.get("grass", 0.0) + share.get("shrub_and_scrub", 0.0) >= GRASSLAND_MIN:
        return Ecosystem.GRASSLAND
    return Ecosystem.MIXED


def infer_ecosystem(
    *,
    name: str,
    landcover: Mapping[str, float] | None = None,
    mangrove_fraction: float | None = None,
) -> Ecosystem:
    """Mangrove extent first, then the site's name, then its land cover; `mixed` if none."""
    if mangrove_fraction is not None and mangrove_fraction >= MANGROVE_MIN_FRACTION:
        return Ecosystem.MANGROVE
    hinted = _from_name(name)
    if hinted is not None:
        return hinted
    if landcover:
        return _from_landcover(landcover)
    return Ecosystem.MIXED

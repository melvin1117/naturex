"""Site vision: Nemotron 3.5 Super VL compares a site's satellite images five years apart.

Nemotron reads images too (ADR-0003 update, Oct 22): `nvidia/Nemotron-3.5-Super-VL` takes text
and images on Token Factory. It **describes** only: each change from a fixed vocabulary, where
it is on a 3x3 grid of the image, and how sure it is. Code then:

- strips any digit from its notes (a vision model never supplies a number);
- checks every claim against the satellite metrics (`cross_check`): a clearing the land-cover
  and forest-loss data don't show is marked "not confirmed";
- hands the result to the Auditor as an `image:` observation, labelled as a description, not a
  measurement.

The images are the committed Sentinel-2 true-colour composites of a demo site: the first year of
the 5-year window (`before.webp`) and the latest 12 months (`thumbnail.webp`), same grid and
outline. Public Copernicus data, so nothing private is sent.
"""

from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.llm import LLMClient, LLMResult, Tier
from app.tools.earth_obs import EarthObsMetrics
from app.tools.signals import find_signals
from app.tools.site_images import image_path

AGENT_NAME = "site_vision"
MAX_TOKENS = 700
MAX_CHANGES = 3
NOTE_CHARS = 220

ChangeKind = Literal[
    "clearing",
    "new_structures",
    "road",
    "vegetation_loss",
    "water_loss",
    "water_gain",
    "regrowth",
    "burn_scar",
    "flooding",
    "no_clear_change",
]
Cell = Literal[
    "north-west",
    "north",
    "north-east",
    "west",
    "centre",
    "east",
    "south-west",
    "south",
    "south-east",
    "whole site",
]
HARM: frozenset[str] = frozenset({"clearing", "new_structures", "road", "burn_scar"})


class ImageChange(BaseModel):
    kind: ChangeKind
    where: Cell = Field(description="Where inside the white outline, on a 3x3 grid of the image")
    confidence: Literal["low", "medium", "high"]
    note: str = Field(description="What you see, in a few words, without numbers")


class ImageView(BaseModel):
    water: str = Field(description="Water inside the outline: extent and colour")
    vegetation: str = Field(description="Vegetation inside the outline: density and colour")
    built_or_bare: str = Field(description="Built or bare ground inside the outline")


class SiteVisionReading(BaseModel):
    """Each image described on its own first (which grounds the comparison), then the changes.
    No `maxItems` or extra enums: Token Factory's strict decoding looped on whitespace with
    them (Oct 22 trials); code keeps the first `MAX_CHANGES`."""

    image_1: ImageView
    image_2: ImageView
    changes: list[ImageChange] = Field(default_factory=list)


SYSTEM_PROMPT = (
    "You are a remote-sensing analyst. Two Sentinel-2 true-colour images of the same site, five "
    "years apart; the site is inside the white outline (north is up). First describe each image "
    "on its own, inside the outline: water (extent, colour), vegetation (density, colour), built "
    "or bare ground. Then list up to three differences between image 1 (earlier) and image 2 "
    "(latest) inside the outline, where each is on a 3x3 grid, and how sure you are. Report "
    "real differences you can point to; ignore overall brightness, haze and season. If nothing "
    "differs, report one no_clear_change. Never write numbers. Reply with JSON only."
)
_CONFIDENCE = {"high": 0, "medium": 1, "low": 2}
GAIN: frozenset[str] = frozenset({"regrowth", "water_gain"})


@dataclass(frozen=True, slots=True)
class CheckedChange:
    id: str
    """Citable as `image:<n>` in the Auditor bundle."""
    change: ImageChange
    agrees: bool | None
    """True when the metrics show the same change, False when they show none, None when they
    can't say."""
    check: str

    def text(self) -> str:
        sure = f"{self.change.confidence} confidence"
        return (
            f"{self.change.kind.replace('_', ' ')}, {self.change.where} ({sure}): "
            f"{self.change.note} [code check: {self.check}]"
        )


@dataclass(frozen=True, slots=True)
class SiteVision:
    reading: SiteVisionReading
    changes: tuple[CheckedChange, ...]
    model: str

    @property
    def overall(self) -> Literal["degraded", "improved", "stable", "unclear"]:
        """From the changes code confirmed, never from the model's own summary."""
        confirmed = [c.change.kind for c in self.changes if c.agrees]
        if any(kind in HARM or kind in ("vegetation_loss", "water_loss") for kind in confirmed):
            return "degraded"
        if any(kind in GAIN for kind in confirmed):
            return "improved"
        if all(c.change.kind == "no_clear_change" for c in self.changes):
            return "stable"
        return "unclear"

    def to_json(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "overall": self.overall,
            "before": self.reading.image_1.model_dump(),
            "after": self.reading.image_2.model_dump(),
            "changes": [
                {
                    "id": c.id,
                    "kind": c.change.kind,
                    "where": c.change.where,
                    "confidence": c.change.confidence,
                    "note": c.change.note,
                    "agrees": c.agrees,
                    "check": c.check,
                }
                for c in self.changes
            ],
        }


def site_images(site_key: str | None) -> tuple[bytes, bytes] | None:
    """The committed before and latest images of a demo site, or None when either is missing."""
    if not site_key:
        return None
    try:
        before, after = image_path(site_key, "before"), image_path(site_key, "thumbnail")
    except ValueError:
        return None
    if not before.is_file() or not after.is_file():
        return None
    return before.read_bytes(), after.read_bytes()


def _jpeg_data_url(image: bytes) -> str:
    from PIL import Image

    with Image.open(io.BytesIO(image)) as opened:
        out = io.BytesIO()
        opened.convert("RGB").save(out, "JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()


def _clean_note(note: str) -> str:
    """No digits from a vision model, and a short note."""
    return " ".join(re.sub(r"\d+([.,]\d+)?", "", note).split())[:NOTE_CHARS]


def _clean_view(view: ImageView) -> ImageView:
    return ImageView(
        water=_clean_note(view.water),
        vegetation=_clean_note(view.vegetation),
        built_or_bare=_clean_note(view.built_or_bare),
    )


MIN_LOSS_SHARE = 0.01
"""Tree loss of at least 1% of the site confirms a described clearing; less only hints at it."""


def _greenness_change(metrics: EarthObsMetrics, direction: int) -> str | None:
    """Why the record backs a greenness change in `direction`, or None: a significant 5-year
    trend that way, or a real dated signal that way (a seasonal swing is neither)."""
    details = metrics.ndvi_trend_details
    if details.significant_05 and metrics.ndvi_trend * direction > 0:
        return "the 5-year greenness trend is significant"
    for signal in find_signals(metrics):
        if signal.direction == direction and not signal.simulated and signal.kind != "cloud_gap":
            return "a greenness signal in the record matches"
    return None


def cross_check(change: ImageChange, metrics: EarthObsMetrics) -> tuple[bool | None, str]:
    """What the satellite metrics say about one described change (deterministic). A change is
    confirmed only by evidence of its own size and kind, never by the sign of a noisy trend."""
    cover = metrics.landcover
    developed = sum(cover.get(k, 0.0) for k in ("built", "bare", "crops"))
    if change.kind in HARM:
        share = metrics.forest_loss_ha / metrics.area_ha if metrics.area_ha > 0 else 0.0
        if share >= MIN_LOSS_SHARE:
            return True, "the forest-loss data shows a real share of the tree cover lost"
        if metrics.forest_loss_ha > 0:
            return None, "some tree loss is recorded, too little to confirm it"
        if developed >= 0.05:
            return None, "no tree loss recorded, but built, bare or cropped land is present"
        return False, "not confirmed: no tree loss and almost no built or bare land"
    if change.kind == "water_loss":
        return (
            (True, "surface water declined")
            if metrics.water_change < -5
            else (False, "not confirmed: surface water did not decline")
        )
    if change.kind in ("water_gain", "flooding"):
        return (
            (True, "surface water increased")
            if metrics.water_change > 5
            else (False, "not confirmed: surface water did not increase")
        )
    if change.kind in ("vegetation_loss", "regrowth"):
        direction = -1 if change.kind == "vegetation_loss" else 1
        why = _greenness_change(metrics, direction)
        if why is not None:
            return True, why
        drifting = metrics.ndvi_trend * direction > 0
        return (
            (None, "greenness drifts that way, but not significantly")
            if drifting
            else (False, "not confirmed: greenness is not moving that way")
        )
    return None, "nothing to confirm"


def read_site_change(
    images: tuple[bytes, bytes],
    *,
    metrics: EarthObsMetrics,
    llm: LLMClient,
    ecosystem: str | None = None,
    world_id: UUID | None = None,
    asset_id: UUID | None = None,
) -> SiteVision:
    """One vision call over both images, then the code checks. Raises LLMError on failure."""
    before, after = images
    windows = metrics.date_windows
    ndvi = windows.get("ndvi")
    years = f"{ndvi.start[:4]} and {ndvi.end[:4]}" if ndvi else "five years apart"
    intro = (
        f"A {ecosystem or 'nature'} site. Image 1: the first year of the window; image 2: the "
        f"latest twelve months (Sentinel-2, {years})."
    )
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": intro},
                {"type": "image_url", "image_url": {"url": _jpeg_data_url(before)}},
                {"type": "image_url", "image_url": {"url": _jpeg_data_url(after)}},
            ],
        },
    ]
    result: LLMResult[SiteVisionReading] = llm.structured(
        agent=AGENT_NAME,
        tier=Tier.PERCEPTION,
        messages=messages,
        schema=SiteVisionReading,
        max_tokens=MAX_TOKENS,
        world_id=world_id,
        asset_id=asset_id,
    )
    reading = result.value.model_copy(
        update={
            "image_1": _clean_view(result.value.image_1),
            "image_2": _clean_view(result.value.image_2),
        }
    )
    ranked = sorted(reading.changes, key=lambda c: _CONFIDENCE[c.confidence])
    changes: list[CheckedChange] = []
    for i, change in enumerate(ranked[:MAX_CHANGES], start=1):
        clean = change.model_copy(update={"note": _clean_note(change.note)})
        agrees, check = cross_check(clean, metrics)
        changes.append(CheckedChange(id=f"image:{i}", change=clean, agrees=agrees, check=check))
    return SiteVision(reading=reading, changes=tuple(changes), model=result.model)

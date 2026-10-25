"""Field evidence (T40, dev-spec §7.6): the deterministic rules for geotagged photos.

Everything that can move a number is here, in code:

- **Geotag checks** (`check_geotag`): the photo's EXIF GPS position must lie inside the
  listing's polygon or within `GPS_BUFFER_M` of its edge (measured in a local equal-area
  projection; a point over `FAR_FROM_AREA_M` from the centroid, e.g. the antipode, is
  `outside` without projecting it), and its EXIF original date must be at most
  `MAX_PHOTO_AGE_DAYS` old and not in the future (one day of tolerance for time zones: EXIF
  dates carry none). Only a `near` photo keeps its distance; an `outside` one keeps none.
- **Validation** (`evidence_verdict`): a photo is validated evidence only when both geotag
  checks pass **and** the perception model's observation (enum labels only, never numbers or
  free text) shows an outdoor landscape with at least one land-cover label, no authenticity
  concern and no text aimed at a model. The model can only make a photo *fail*; it never sets
  a value.
- **The evidence event** (`event_fields`): direction and impact type come from fixed label
  tables; severity is always `EVIDENCE_SEVERITY`; title and summary are written by code from the
  labels, and date the visit to its month only (`visit_month`). Field evidence never feeds
  threat pressure (`split_field_evidence`): a steward's few photos corroborate the satellite
  and news picture, they don't re-price it.
- **The confidence effect** (`confidence_effect`): the §7.4 evidence term goes from 0.3 to 1.0,
  so a rating with validated evidence gains exactly 0.2 × 0.7 × 100 = 14.0 points of confidence.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

import shapely
from pyproj import CRS, Geod, Transformer
from shapely.geometry import MultiPolygon, Point, Polygon, shape

from app.tools.scoring import CONFIDENCE_WEIGHTS, EVIDENCE_NONE, EVIDENCE_VALIDATED

METHOD_VERSION = "wildworth-field-evidence/1.0"
MAX_PHOTOS_PER_ASSET = 5
GPS_BUFFER_M = 100
"""Phone GPS is good to a few metres in the open, worse under canopy; a boundary path counts."""
FAR_FROM_AREA_M = 1_000_000
"""Past this geodesic distance from the centroid a point is `outside` without being projected:
the local projection degenerates towards the antipode."""
MAX_PHOTO_AGE_DAYS = 365
FUTURE_TOLERANCE = timedelta(days=1)
EVIDENCE_SEVERITY = 1

GpsCheck = Literal["inside", "near", "outside", "missing"]
DateCheck = Literal["ok", "missing", "future", "too_old"]

LandCover = Literal[
    "tree_cover",
    "shrubland",
    "grassland",
    "wetland_vegetation",
    "open_water",
    "cropland",
    "bare_ground",
    "built_up",
]
Disturbance = Literal[
    "fire_scar",
    "clearing_or_logging",
    "dumping_or_waste",
    "construction",
    "erosion",
    "drought_stress",
]
WaterClarity = Literal["clear", "turbid", "polluted", "no_water", "unclear"]
AuthenticityConcern = Literal[
    "screen_or_print_photo", "edited_or_composited", "watermark_or_stock", "not_a_photo"
]
ImpactType = Literal[
    "encroachment", "fire", "drought", "pollution", "restoration", "protection", "other"
]

NATURAL_COVER: frozenset[str] = frozenset(
    {"tree_cover", "shrubland", "grassland", "wetland_vegetation", "open_water"}
)
LABELS: Mapping[str, str] = {
    "tree_cover": "tree cover",
    "shrubland": "shrubland",
    "grassland": "grassland",
    "wetland_vegetation": "wetland vegetation",
    "open_water": "open water",
    "cropland": "cropland",
    "bare_ground": "bare ground",
    "built_up": "built-up land",
    "fire_scar": "a fire scar",
    "clearing_or_logging": "clearing or logging",
    "dumping_or_waste": "dumping or waste",
    "construction": "construction",
    "erosion": "erosion",
    "drought_stress": "drought stress",
}
# The first disturbance in this order decides the event's impact type.
DISTURBANCE_IMPACT: Mapping[str, ImpactType] = {
    "fire_scar": "fire",
    "clearing_or_logging": "encroachment",
    "construction": "encroachment",
    "dumping_or_waste": "pollution",
    "drought_stress": "drought",
    "erosion": "other",
}

# Why a photo isn't validated evidence (stable codes: the steward UI keys on them).
GPS_MISSING = "gps_missing"
GPS_OUTSIDE = "gps_outside"
TAKEN_MISSING = "taken_missing"
TAKEN_FUTURE = "taken_future"
TAKEN_TOO_OLD = "taken_too_old"
NOT_ANALYSED = "not_analysed"
NOT_A_LANDSCAPE = "not_a_landscape"
NO_LAND_COVER = "no_land_cover"
AUTHENTICITY_CONCERN = "authenticity_concern"
INSTRUCTION_TEXT = "instruction_text"


# ----- geotag checks ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GeotagCheck:
    gps: GpsCheck
    distance_m: int | None
    """Metres from the polygon's edge: 0 inside, up to GPS_BUFFER_M near; None outside (never
    kept: it would say where the photographer was) or without a position."""
    taken: DateCheck
    taken_on: date | None

    @property
    def passed(self) -> bool:
        return self.gps in ("inside", "near") and self.taken == "ok"

    @property
    def reasons(self) -> tuple[str, ...]:
        found: list[str] = []
        if self.gps == "missing":
            found.append(GPS_MISSING)
        elif self.gps == "outside":
            found.append(GPS_OUTSIDE)
        found += {
            "ok": [],
            "missing": [TAKEN_MISSING],
            "future": [TAKEN_FUTURE],
            "too_old": [TAKEN_TOO_OLD],
        }[self.taken]
        return tuple(found)


def _area(geojson: Mapping[str, Any]) -> Polygon | MultiPolygon:
    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    if not isinstance(geometry, Mapping):
        raise ValueError("not a GeoJSON geometry")
    area = shape(dict(geometry))
    if not isinstance(area, Polygon | MultiPolygon) or area.is_empty:
        raise ValueError("not a polygon")
    return area


_GEOD = Geod(ellps="WGS84")


def distance_to_area_m(geojson: Mapping[str, Any], lat: float, lon: float) -> int | None:
    """Metres from (lat, lon) to the listing's polygon (0 inside or on the edge), in a Lambert
    azimuthal equal-area projection centred on the polygon, rounded up to the metre. None when
    the point is over FAR_FROM_AREA_M from the centroid (geodesic) or the projection fails."""
    area = _area(geojson)
    centre = area.centroid
    _, _, from_centre = _GEOD.inv(centre.x, centre.y, lon, lat)
    if not math.isfinite(from_centre) or from_centre > FAR_FROM_AREA_M:
        return None
    laea = CRS.from_proj4(f"+proj=laea +lat_0={centre.y} +lon_0={centre.x} +datum=WGS84 +units=m")
    # (x, y) arrays in, (x, y) arrays out: `interleaved=False` (the stubs only type the default).
    project: Any = Transformer.from_crs("EPSG:4326", laea, always_xy=True).transform
    metres = shapely.transform(area, project, interleaved=False).distance(
        shapely.transform(Point(lon, lat), project, interleaved=False)
    )
    if not math.isfinite(metres):
        return None
    return math.ceil(metres)


def check_location(
    geojson: Mapping[str, Any], lat: float | None, lon: float | None
) -> tuple[GpsCheck, int | None]:
    """(the check, metres from the edge for `inside` and `near` only)."""
    if lat is None or lon is None:
        return "missing", None
    distance = distance_to_area_m(geojson, lat, lon)
    if distance is None or distance > GPS_BUFFER_M:
        return "outside", None
    return ("inside" if distance == 0 else "near"), distance


def check_taken(taken_at: str | None, uploaded_on: date) -> tuple[DateCheck, date | None]:
    """`taken_at` is the EXIF local date-time (ISO, no zone); `uploaded_on` the server date."""
    if taken_at is None:
        return "missing", None
    try:
        taken_on = datetime.fromisoformat(taken_at).date()
    except ValueError:
        return "missing", None
    if taken_on > uploaded_on + FUTURE_TOLERANCE:
        return "future", taken_on
    if taken_on < uploaded_on - timedelta(days=MAX_PHOTO_AGE_DAYS):
        return "too_old", taken_on
    return "ok", taken_on


def check_geotag(
    geojson: Mapping[str, Any],
    lat: float | None,
    lon: float | None,
    taken_at: str | None,
    uploaded_on: date,
) -> GeotagCheck:
    gps, distance = check_location(geojson, lat, lon)
    taken, taken_on = check_taken(taken_at, uploaded_on)
    return GeotagCheck(gps=gps, distance_m=distance, taken=taken, taken_on=taken_on)


# ----- the model's observation and the verdict --------------------------------------------------


@dataclass(frozen=True, slots=True)
class Observation:
    """What the perception model saw, as validated labels. Untrusted: it can only fail a
    photo, and its labels only choose among fixed texts."""

    shows_landscape: bool
    land_cover: tuple[LandCover, ...]
    disturbance: tuple[Disturbance, ...]
    water_clarity: WaterClarity
    authenticity_concerns: tuple[AuthenticityConcern, ...]
    instruction_text: bool

    def to_json(self) -> dict[str, Any]:
        return {
            "shows_landscape": self.shows_landscape,
            "land_cover": list(self.land_cover),
            "disturbance": list(self.disturbance),
            "water_clarity": self.water_clarity,
            "authenticity_concerns": list(self.authenticity_concerns),
            "instruction_text": self.instruction_text,
        }


def evidence_verdict(
    geotag: GeotagCheck, observation: Observation | None
) -> tuple[bool, tuple[str, ...]]:
    """(validated, the reasons it isn't). Every reason is listed, geotag ones first."""
    reasons = list(geotag.reasons)
    if observation is None:
        reasons.append(NOT_ANALYSED)
    else:
        if observation.instruction_text:
            reasons.append(INSTRUCTION_TEXT)
        if observation.authenticity_concerns:
            reasons.append(AUTHENTICITY_CONCERN)
        if not observation.shows_landscape:
            reasons.append(NOT_A_LANDSCAPE)
        elif not observation.land_cover:
            reasons.append(NO_LAND_COVER)
    return not reasons, tuple(reasons)


# ----- the evidence event -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EventFields:
    direction: Literal[-1, 0, 1]
    impact_type: ImpactType
    severity: int
    title: str
    summary: str


def _words(labels: Iterable[str]) -> str:
    names = [LABELS[label] for label in labels]
    if len(names) <= 1:
        return "".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)  # fmt: skip


def visit_month(taken_on: date) -> date:
    """The first of the month a photo was taken: public text and dates never give the day."""
    return taken_on.replace(day=1)


def event_fields(observation: Observation, taken_on: date | None) -> EventFields:
    """The evidence event of a validated photo, written by code from its labels."""
    disturbances = [d for d in DISTURBANCE_IMPACT if d in observation.disturbance]
    cover = [label for label in LABELS if label in observation.land_cover]
    when = f" in {_MONTHS[taken_on.month - 1]} {taken_on.year}" if taken_on else ""
    seen = _words(cover) or "no clear land cover"
    if disturbances:
        direction: Literal[-1, 0, 1] = -1
        impact = DISTURBANCE_IMPACT[disturbances[0]]
        title = f"Field photo shows {_words(disturbances)}"
        signs = f"Signs of disturbance: {_words(disturbances)}."
    else:
        direction = 1 if any(label in NATURAL_COVER for label in cover) else 0
        impact = "other"
        title = f"Field photo shows {seen}"
        signs = "No signs of disturbance."
    summary = (
        f"A geotagged photo taken at the listing{when} shows {seen}. {signs} "
        "Location and date were checked in code; the labels come from an image model."
    )
    return EventFields(direction, impact, EVIDENCE_SEVERITY, title, summary)


# ----- scoring ----------------------------------------------------------------------------------


def is_field_evidence(event: object) -> bool:
    return getattr(event, "source", None) == "evidence"


def split_field_evidence[E](events: Iterable[E]) -> tuple[list[E], bool]:
    """(the events that price threat pressure, whether any validated field evidence is among
    them). Field evidence only moves the confidence evidence term, never T."""
    threats: list[E] = []
    validated = False
    for event in events:
        if is_field_evidence(event):
            validated = validated or (
                getattr(event, "validated", None) is True and getattr(event, "relevant", True)
            )
        else:
            threats.append(event)
    return threats, validated


EVIDENCE_POINTS = (
    Decimal(100) * CONFIDENCE_WEIGHTS.evidence * (EVIDENCE_VALIDATED - EVIDENCE_NONE)
).quantize(Decimal("0.1"))
"""Confidence points validated field evidence adds: 100 × 0.2 × (1.0 − 0.3) = 14.0."""


@dataclass(frozen=True, slots=True)
class ConfidenceEffect:
    current: Decimal | None
    """The latest report's confidence (None: not rated yet)."""
    projected: Decimal | None
    """What it becomes once the next rating counts the evidence (None: not rated yet)."""
    points: Decimal
    """Points the evidence adds (0 when none is validated or the report already counts it)."""
    counted: bool
    """True when the latest report already used validated field evidence."""


def confidence_effect(
    current: Decimal | None, evidence_term: Decimal | None, *, validated: bool
) -> ConfidenceEffect:
    """The next rating's confidence with the evidence, from the latest report. Confidence is
    rounded half-up to 0.1 once, and 14.0 is a whole multiple of 0.1, so adding it to the
    rounded value equals rounding the exact sum: the projection is exact."""
    counted = evidence_term is not None and evidence_term >= EVIDENCE_VALIDATED
    points = EVIDENCE_POINTS if validated and not counted else Decimal("0.0")
    if current is None:
        return ConfidenceEffect(None, None, points, counted)
    projected = min(current + points, Decimal("100.0"))
    return ConfidenceEffect(current, projected, points, counted)


def labels_of(observations: Sequence[Observation]) -> tuple[list[str], list[str]]:
    """Land-cover and disturbance labels seen across observations, in table order."""
    cover = [label for label in LABELS if any(label in o.land_cover for o in observations)]
    signs = [label for label in LABELS if any(label in o.disturbance for o in observations)]
    return cover, signs

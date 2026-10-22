"""Precomputed demo-site images: land-cover overlay and marketplace thumbnail (T35).

``scripts/precompute_sites.py --images`` renders them offline with Earth Engine into
``data/demo_sites/images/``; the runtime only serves the committed files. This module holds
the pure parts both sides share: file layout and site-key allowlist, the Web Mercator pixel
grids, a deterministic indexed-PNG codec for the overlay, header parsing for dimensions, the
sidecar schema and the offline consistency check used by ``--check`` and pytest.
"""

from __future__ import annotations

import json
import math
import re
import struct
import zlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from shapely.geometry import Polygon

from app.tools.earth_obs import DATA_DIR, DateWindow, LandcoverClass, load_site_metrics

IMAGES_DIR = DATA_DIR / "images"
SITE_KEY_RE = re.compile(r"^[a-z0-9_]{1,64}$")

ImageKind = Literal["overlay", "thumbnail", "sidecar", "before"]
_SUFFIX: dict[ImageKind, str] = {
    "overlay": "overlay.png",
    "thumbnail": "thumbnail.webp",
    "before": "before.webp",
    "sidecar": "images.json",
}
MEDIA_TYPES: dict[ImageKind, str] = {
    "overlay": "image/png",
    "thumbnail": "image/webp",
    "sidecar": "application/json",
    "before": "image/webp",
}

OVERLAY_MAX_PX = 1024
THUMBNAIL_WIDTH = 640
THUMBNAIL_HEIGHT = 400
THUMBNAIL_MARGIN = 1.25
"""The thumbnail window is the polygon's bounding box scaled by this factor (then widened to
the card aspect), so the outline sits inside the frame with a margin."""
MAX_IMAGE_BYTES = 300_000
LANDCOVER_SHARE_TOLERANCE = 0.015
"""Max per-class gap between overlay pixel shares and the committed ``landcover`` fractions.
The overlay is the same Dynamic World mode resampled to a finer Web Mercator grid."""
OPAQUE_SHARE_TOLERANCE = 0.02

# Official Dynamic World V1 class order, palette and descriptions:
# https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1
DW_CLASSES: tuple[LandcoverClass, ...] = (
    "water",
    "trees",
    "grass",
    "flooded_vegetation",
    "crops",
    "shrub_and_scrub",
    "built",
    "bare",
    "snow_and_ice",
)
DW_PALETTE: tuple[str, ...] = (
    "#419bdf",
    "#397d49",
    "#88b053",
    "#7a87c6",
    "#e49635",
    "#dfc35a",
    "#c4281b",
    "#a59b8f",
    "#b39fe1",
)
DW_LABELS: tuple[str, ...] = (
    "Water",
    "Trees",
    "Grass",
    "Flooded vegetation",
    "Crops",
    "Shrub and scrub",
    "Built area",
    "Bare ground",
    "Snow and ice",
)
TRANSPARENT_INDEX = len(DW_CLASSES)
"""Palette index for pixels outside the polygon; fully transparent via the tRNS chunk."""

OSM_ATTRIBUTION = "© OpenStreetMap contributors"
DYNAMIC_WORLD_ATTRIBUTION = (
    "Dynamic World: This dataset is produced for the Dynamic World Project by Google "
    "in partnership with National Geographic Society and the World Resources Institute."
)
SENTINEL_2_IMAGE_ATTRIBUTION = "Contains modified Copernicus Sentinel data 2025-2026."
OVERLAY_ATTRIBUTIONS = (DYNAMIC_WORLD_ATTRIBUTION, SENTINEL_2_IMAGE_ATTRIBUTION)
"""Credits shown with every land-cover overlay (Dynamic World is derived from Sentinel-2)."""
OVERLAY_DATASET_ID = "GOOGLE/DYNAMICWORLD/V1"
OVERLAY_BAND = "label"
OVERLAY_METHOD = (
    "Per-pixel mode of the Dynamic World V1 label over the date window (the "
    "same mode as the landcover metrics), clipped to the polygon and sampled "
    "nearest-neighbour onto a Web Mercator grid; outside the polygon is "
    "transparent."
)
SCENARIO_NOTE = (
    "Images show the observed baseline only. Time Machine scenarios shift land-cover "
    "fractions by scripted deltas without a per-pixel map, so no scenario overlay exists."
)


Bounds = tuple[tuple[float, float], tuple[float, float]]
"""``((south, west), (north, east))`` in WGS84 degrees, the Leaflet ``LatLngBounds`` order."""


class LegendEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    value: int = Field(ge=0, le=8)
    key: LandcoverClass
    label: str
    color: str = Field(pattern=r"^#[0-9a-f]{6}$")


class VisParams(BaseModel):
    model_config = ConfigDict(frozen=True)

    bands: tuple[str, str, str]
    min: float
    max: float
    gamma: float


class OverlayImage(BaseModel):
    """Leaflet ``ImageOverlay`` input: the PNG spans ``bounds`` in Web Mercator."""

    model_config = ConfigDict(frozen=True)

    file: str
    media_type: Literal["image/png"] = "image/png"
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    bounds: Bounds
    crs: Literal["EPSG:3857"] = "EPSG:3857"
    dataset_id: str
    band: str
    method: str
    date_window: DateWindow
    palette: tuple[str, ...]
    legend: tuple[LegendEntry, ...]
    attributions: tuple[str, ...] = Field(min_length=1)


class ThumbnailImage(BaseModel):
    model_config = ConfigDict(frozen=True)

    file: str
    media_type: Literal["image/webp"] = "image/webp"
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    bounds: Bounds
    crs: Literal["EPSG:3857"] = "EPSG:3857"
    dataset_ids: tuple[str, ...]
    method: str
    date_window: DateWindow
    visualization: VisParams
    outline_color: str
    attributions: tuple[str, ...] = Field(min_length=1)


class SiteImages(BaseModel):
    """Sidecar metadata for one demo site's overlay and thumbnail (``<site>.images.json``)."""

    model_config = ConfigDict(frozen=True)

    site_key: str
    data_version: str
    scenario: Literal["baseline"] = "baseline"
    scenario_note: str
    overlay: OverlayImage
    thumbnail: ThumbnailImage


def known_site_keys() -> frozenset[str]:
    """Demo sites are the committed GeoJSON boundaries."""
    return frozenset(path.stem for path in DATA_DIR.glob("*.geojson"))


def image_path(site_key: str, kind: ImageKind) -> Path:
    """Committed path of a site's image or sidecar; the key must pass the allowlist."""
    if not SITE_KEY_RE.fullmatch(site_key):
        raise ValueError(f"Invalid site key {site_key!r}.")
    return IMAGES_DIR / f"{site_key}.{_SUFFIX[kind]}"


def served_image_path(site_key: str, kind: ImageKind) -> Path | None:
    """Path to serve for a request, or ``None`` (404) for invalid, unknown or missing files."""
    if not SITE_KEY_RE.fullmatch(site_key) or site_key not in known_site_keys():
        return None
    path = image_path(site_key, kind).resolve()
    if not path.is_relative_to(IMAGES_DIR.resolve()) or not path.is_file():
        return None
    return path


def load_site_images(site_key: str) -> SiteImages:
    return SiteImages.model_validate_json(image_path(site_key, "sidecar").read_text())


# --- Geometry ---------------------------------------------------------------------------

EARTH_RADIUS_M = 6_378_137.0


def to_mercator(lon: float, lat: float) -> tuple[float, float]:
    """WGS84 degrees to spherical Web Mercator (EPSG:3857) metres."""
    x = EARTH_RADIUS_M * math.radians(lon)
    y = EARTH_RADIUS_M * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def from_mercator(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / EARTH_RADIUS_M)
    lat = math.degrees(2 * math.atan(math.exp(y / EARTH_RADIUS_M)) - math.pi / 2)
    return lon, lat


def polygon_ring(geojson: Mapping[str, Any]) -> list[tuple[float, float]]:
    """Exterior ring ``(lon, lat)`` of a GeoJSON Polygon or Feature."""
    geometry = geojson.get("geometry", geojson) if geojson.get("type") == "Feature" else geojson
    if not isinstance(geometry, Mapping) or geometry.get("type") != "Polygon":
        raise ValueError("Expected a GeoJSON Polygon.")
    return [(float(lon), float(lat)) for lon, lat, *_ in geometry["coordinates"][0]]


def polygon_bounds(geojson: Mapping[str, Any]) -> Bounds:
    ring = polygon_ring(geojson)
    lons = [lon for lon, _ in ring]
    lats = [lat for _, lat in ring]
    return (min(lats), min(lons)), (max(lats), max(lons))


def load_site_geojson(site_key: str) -> dict[str, Any]:
    if site_key not in known_site_keys():
        raise ValueError(f"Unknown demo site {site_key!r}.")
    data: dict[str, Any] = json.loads((DATA_DIR / f"{site_key}.geojson").read_text())
    return data


@dataclass(frozen=True)
class PixelGrid:
    """North-up Web Mercator pixel grid, as Earth Engine ``computePixels`` takes it."""

    width: int
    height: int
    x0: float
    """West edge (EPSG:3857 metres)."""
    y1: float
    """North edge (EPSG:3857 metres)."""
    scale_x: float
    scale_y: float
    """Pixel height in metres (positive; rows run south)."""

    def ee_grid(self) -> dict[str, Any]:
        return {
            "dimensions": {"width": self.width, "height": self.height},
            "affineTransform": {
                "scaleX": self.scale_x,
                "shearX": 0,
                "translateX": self.x0,
                "shearY": 0,
                "scaleY": -self.scale_y,
                "translateY": self.y1,
            },
            "crsCode": "EPSG:3857",
        }

    def bounds(self) -> Bounds:
        west, north = from_mercator(self.x0, self.y1)
        east, south = from_mercator(
            self.x0 + self.width * self.scale_x, self.y1 - self.height * self.scale_y
        )
        return (south, west), (north, east)

    def to_pixel(self, lon: float, lat: float) -> tuple[float, float]:
        x, y = to_mercator(lon, lat)
        return (x - self.x0) / self.scale_x, (self.y1 - y) / self.scale_y


def overlay_grid(bounds: Bounds, max_px: int = OVERLAY_MAX_PX) -> PixelGrid:
    """Grid covering exactly ``bounds``, ``max_px`` on the long side, near-square pixels."""
    (south, west), (north, east) = bounds
    x0, y0 = to_mercator(west, south)
    x1, y1 = to_mercator(east, north)
    dx, dy = x1 - x0, y1 - y0
    pixel = max(dx, dy) / max_px
    width, height = max(1, round(dx / pixel)), max(1, round(dy / pixel))
    return PixelGrid(width, height, x0, y1, dx / width, dy / height)


def thumbnail_grid(
    bounds: Bounds,
    width: int = THUMBNAIL_WIDTH,
    height: int = THUMBNAIL_HEIGHT,
    margin: float = THUMBNAIL_MARGIN,
) -> PixelGrid:
    """Card-aspect grid centred on ``bounds``, with square pixels and a margin around it."""
    (south, west), (north, east) = bounds
    x0, y0 = to_mercator(west, south)
    x1, y1 = to_mercator(east, north)
    aspect = width / height
    span_x = max((x1 - x0) * margin, (y1 - y0) * margin * aspect)
    span_y = span_x / aspect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return PixelGrid(
        width, height, cx - span_x / 2, cy + span_y / 2, span_x / width, span_y / height
    )


def opaque_share_expected(geojson: Mapping[str, Any], grid: PixelGrid) -> float:
    """Share of the grid's area inside the polygon (in Web Mercator, as the pixels are)."""
    projected = Polygon([to_mercator(lon, lat) for lon, lat in polygon_ring(geojson)])
    return float(projected.area) / (grid.width * grid.scale_x * grid.height * grid.scale_y)


# --- Indexed PNG codec (deterministic, stdlib only) -------------------------------------

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def palette_rgba(palette: Sequence[str]) -> list[tuple[int, int, int, int]]:
    """Overlay palette: the class colours, then one transparent entry."""
    colours = [(int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255) for c in palette]
    return [*colours, (0, 0, 0, 0)]


def encode_indexed_png(
    pixels: bytes, width: int, height: int, palette: Sequence[tuple[int, int, int, int]]
) -> bytes:
    """8-bit indexed PNG with per-entry alpha. Same input, same bytes (no timestamps)."""
    if len(pixels) != width * height:
        raise ValueError("Pixel count does not match the dimensions.")
    if not 1 <= len(palette) <= 256 or max(pixels, default=0) >= len(palette):
        raise ValueError("Pixel values must index the palette.")
    raw = b"".join(b"\x00" + pixels[row * width : (row + 1) * width] for row in range(height))
    return b"".join(
        [
            _PNG_SIGNATURE,
            _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0)),
            _chunk(b"PLTE", bytes(v for r, g, b, _ in palette for v in (r, g, b))),
            _chunk(b"tRNS", bytes(a for *_, a in palette)),
            _chunk(b"IDAT", zlib.compress(raw, 9)),
            _chunk(b"IEND", b""),
        ]
    )


DW_NO_DATA = 255
"""What the Earth Engine label image holds outside the polygon (``unmask(255)``)."""


@dataclass(frozen=True)
class LandCoverLabels:
    """A polygon's Dynamic World mode on a pixel grid, as Earth Engine returned it (#231)."""

    labels: bytes
    """Row-major, one byte per pixel: a class index, or ``DW_NO_DATA`` outside the polygon."""
    width: int
    height: int
    date_start: str
    date_end: str
    """The mode's date window (ISO dates, end exclusive), the land-cover metric's."""


def overlay_png_from_labels(labels: bytes, width: int, height: int) -> bytes:
    """The overlay PNG from a row-major Dynamic World label grid (one byte per pixel: a class
    index, or ``DW_NO_DATA`` outside the polygon, which becomes transparent). Shared by the
    demo-site precompute (T35) and live ratings (#231)."""
    if len(labels) != width * height:
        raise ValueError(f"Expected {width}x{height} labels, got {len(labels)} bytes.")
    unexpected = set(labels) - set(range(len(DW_CLASSES))) - {DW_NO_DATA}
    if unexpected:
        raise ValueError(f"Unexpected Dynamic World labels {sorted(unexpected)}.")
    pixels = labels.replace(bytes([DW_NO_DATA]), bytes([TRANSPARENT_INDEX]))
    return encode_indexed_png(pixels, width, height, palette_rgba(DW_PALETTE))


def halve_labels(labels: bytes, width: int, height: int) -> tuple[bytes, int, int]:
    """Nearest-neighbour downsample by two (every other row and column), for an overlay over
    its byte budget. The grid still spans the same bounds, with pixels twice as large."""
    if len(labels) != width * height:
        raise ValueError(f"Expected {width}x{height} labels, got {len(labels)} bytes.")
    out_w, out_h = max(1, (width + 1) // 2), max(1, (height + 1) // 2)
    rows = (labels[row * width : (row + 1) * width : 2] for row in range(0, height, 2))
    return b"".join(rows), out_w, out_h


@dataclass(frozen=True)
class IndexedPng:
    width: int
    height: int
    pixels: bytes
    palette: tuple[tuple[int, int, int, int], ...]


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_indexed_png(data: bytes) -> IndexedPng:
    """Decode a non-interlaced 8-bit indexed PNG (all five row filters)."""
    if not data.startswith(_PNG_SIGNATURE):
        raise ValueError("Not a PNG file.")
    pos, header, plte, trns, idat = len(_PNG_SIGNATURE), b"", b"", b"", bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            header = body
        elif kind == b"PLTE":
            plte = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", header)
    if (depth, colour, interlace) != (8, 3, 0):
        raise ValueError("Expected a non-interlaced 8-bit indexed PNG.")
    raw = zlib.decompress(bytes(idat))
    out = bytearray(width * height)
    prev = bytearray(width)
    for row in range(height):
        start = row * (width + 1)
        kind_byte, line = raw[start], bytearray(raw[start + 1 : start + 1 + width])
        for i in range(width if kind_byte else 0):
            left = line[i - 1] if i else 0
            up = prev[i]
            up_left = prev[i - 1] if i else 0
            if kind_byte == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind_byte == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind_byte == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind_byte == 4:
                line[i] = (line[i] + _paeth(left, up, up_left)) & 0xFF
            else:
                raise ValueError(f"Unknown PNG filter {kind_byte}.")
        out[row * width : (row + 1) * width] = line
        prev = line
    alphas = list(trns) + [255] * (len(plte) // 3 - len(trns))
    palette = tuple(
        (plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], alphas[i]) for i in range(len(plte) // 3)
    )
    return IndexedPng(width, height, bytes(out), palette)


def png_dimensions(data: bytes) -> tuple[int, int]:
    if not data.startswith(_PNG_SIGNATURE) or data[12:16] != b"IHDR":
        raise ValueError("Not a PNG file.")
    width, height = struct.unpack(">II", data[16:24])
    return int(width), int(height)


def webp_dimensions(data: bytes) -> tuple[int, int]:
    """Canvas size from a WebP header (lossy ``VP8``, lossless ``VP8L`` or extended ``VP8X``)."""
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("Not a WebP file.")
    chunk = data[12:16]
    if chunk == b"VP8 ":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8X":
        return (
            int.from_bytes(data[24:27], "little") + 1,
            int.from_bytes(data[27:30], "little") + 1,
        )
    raise ValueError("Unknown WebP chunk.")


# --- Offline check -----------------------------------------------------------------------


def _close(a: Bounds, b: Bounds, tol: float = 1e-9) -> bool:
    pairs = zip((*a[0], *a[1]), (*b[0], *b[1]), strict=True)
    return all(math.isclose(x, y, abs_tol=tol) for x, y in pairs)


def check_site_images(site_key: str) -> list[str]:
    """Problems with a site's committed images; empty when they're consistent.

    Byte-for-byte reproduction isn't checked: Earth Engine collections can gain or
    reprocess scenes. Instead this verifies existence, decoding, dimensions, size budgets,
    that the bounds match the GeoJSON, the palette, attributions, that the overlay's class
    shares match the committed ``landcover`` and that pixels outside the polygon are
    transparent.
    """
    paths = {kind: image_path(site_key, kind) for kind in _SUFFIX}
    missing = [str(path) for path in paths.values() if not path.is_file()]
    if missing:
        return [f"{site_key}: missing {', '.join(missing)}"]
    try:
        meta = load_site_images(site_key)
    except ValidationError as exc:
        return [f"{site_key}: invalid sidecar: {exc}"]
    problems: list[str] = []
    geojson = load_site_geojson(site_key)
    bounds = polygon_bounds(geojson)
    overlay_bytes = paths["overlay"].read_bytes()
    thumb_bytes = paths["thumbnail"].read_bytes()

    if meta.site_key != site_key:
        problems.append(f"sidecar site_key is {meta.site_key!r}")
    for kind, data in (("overlay", overlay_bytes), ("thumbnail", thumb_bytes)):
        if len(data) > MAX_IMAGE_BYTES:
            problems.append(f"{kind} is {len(data)} bytes (budget {MAX_IMAGE_BYTES})")
    if meta.overlay.file != paths["overlay"].name or meta.thumbnail.file != paths["thumbnail"].name:
        problems.append("sidecar file names don't match the committed files")

    grid = overlay_grid(bounds)
    if not _close(meta.overlay.bounds, bounds):
        problems.append(f"overlay bounds {meta.overlay.bounds} != GeoJSON bounds {bounds}")
    if not _close(grid.bounds(), bounds):
        problems.append("overlay grid doesn't span the GeoJSON bounds")
    if png_dimensions(overlay_bytes) != (grid.width, grid.height) or (
        meta.overlay.width,
        meta.overlay.height,
    ) != (grid.width, grid.height):
        problems.append(f"overlay isn't {grid.width}x{grid.height}")
    legend_colours = tuple(entry.color for entry in meta.overlay.legend)
    if meta.overlay.palette != DW_PALETTE or legend_colours != DW_PALETTE:
        problems.append("overlay palette isn't the Dynamic World palette")
    if not any("Dynamic World" in text for text in meta.overlay.attributions):
        problems.append("overlay attributions lack Dynamic World")

    png = decode_indexed_png(overlay_bytes)
    if png.palette != tuple(palette_rgba(DW_PALETTE)):
        problems.append("overlay PNG palette isn't the Dynamic World palette + transparent")
    counts = [png.pixels.count(index) for index in range(TRANSPARENT_INDEX + 1)]
    opaque = sum(counts[:TRANSPARENT_INDEX])
    if opaque == 0:
        problems.append("overlay has no land-cover pixels")
    else:
        landcover = load_site_metrics(site_key).landcover
        for index, name in enumerate(DW_CLASSES):
            share, expected = counts[index] / opaque, landcover.get(name, 0.0)
            if abs(share - expected) > LANDCOVER_SHARE_TOLERANCE:
                problems.append(f"overlay {name} share {share:.4f} vs metrics {expected:.4f}")
        opaque_share = opaque / len(png.pixels)
        expected_share = opaque_share_expected(geojson, grid)
        if abs(opaque_share - expected_share) > OPAQUE_SHARE_TOLERANCE:
            problems.append(
                f"overlay opaque share {opaque_share:.4f} vs polygon share {expected_share:.4f}"
            )

    thumb = thumbnail_grid(bounds)
    if not _close(meta.thumbnail.bounds, thumb.bounds()):
        problems.append("thumbnail bounds don't match the thumbnail grid around the GeoJSON")
    (t_south, t_west), (t_north, t_east) = meta.thumbnail.bounds
    (south, west), (north, east) = bounds
    if not (t_south < south and t_west < west and t_north > north and t_east > east):
        problems.append("thumbnail doesn't contain the polygon")
    if webp_dimensions(thumb_bytes) != (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT) or (
        meta.thumbnail.width,
        meta.thumbnail.height,
    ) != (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT):
        problems.append(f"thumbnail isn't {THUMBNAIL_WIDTH}x{THUMBNAIL_HEIGHT}")
    thumb_text = " ".join(meta.thumbnail.attributions)
    if "Copernicus Sentinel" not in thumb_text or "Cloud Score+" not in thumb_text:
        problems.append("thumbnail attributions lack Copernicus Sentinel or Cloud Score+")
    return [f"{site_key}: {problem}" for problem in problems]

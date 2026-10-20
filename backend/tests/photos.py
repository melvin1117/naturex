"""Field photos for tests (T40): geotagged JPEGs and PNGs made with Pillow."""

from __future__ import annotations

import io
from fractions import Fraction

from PIL import Image, ImageDraw
from PIL.TiffImagePlugin import IFDRational

GPS_IFD = 0x8825
EXIF_IFD = 0x8769
DATETIME_ORIGINAL = 0x9003
MAKE = 0x010F


def _dms(value: float) -> tuple[IFDRational, IFDRational, IFDRational]:
    value = abs(value)
    degrees = int(value)
    minutes_full = (value - degrees) * 60
    minutes = int(minutes_full)
    seconds = Fraction((minutes_full - minutes) * 60).limit_denominator(10_000)
    return (
        IFDRational(degrees, 1),
        IFDRational(minutes, 1),
        IFDRational(seconds.numerator, seconds.denominator),
    )


def photo(
    lat: float | None = None,
    lon: float | None = None,
    *,
    taken: str | None = "2026:10:01 09:30:00",
    text: str | None = None,
    size: tuple[int, int] = (320, 240),
    fmt: str = "JPEG",
    color: tuple[int, int, int] = (60, 140, 70),
) -> bytes:
    """A small landscape-coloured image with EXIF GPS (when both coordinates are given), an
    EXIF original date-time and a camera make, and optionally text drawn on it."""
    image = Image.new("RGB", size, color)
    if text:
        ImageDraw.Draw(image).text((8, 8), text, fill=(255, 255, 255))
    exif = Image.Exif()
    exif[MAKE] = "NatureX test camera"
    if lat is not None and lon is not None:
        gps = exif.get_ifd(GPS_IFD)
        gps[1] = "N" if lat >= 0 else "S"
        gps[2] = _dms(lat)
        gps[3] = "E" if lon >= 0 else "W"
        gps[4] = _dms(lon)
    if taken is not None:
        exif.get_ifd(EXIF_IFD)[DATETIME_ORIGINAL] = taken
    out = io.BytesIO()
    image.save(out, format=fmt, exif=exif)
    return out.getvalue()

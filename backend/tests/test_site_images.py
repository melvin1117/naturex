"""Demo-site images (T35): serving route, committed files, grids and the PNG codec."""

from __future__ import annotations

import json
import shutil
import struct
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.tools import site_images
from app.tools.site_images import (
    DW_PALETTE,
    MAX_IMAGE_BYTES,
    THUMBNAIL_HEIGHT,
    THUMBNAIL_WIDTH,
    check_site_images,
    decode_indexed_png,
    encode_indexed_png,
    image_path,
    known_site_keys,
    load_site_geojson,
    load_site_images,
    overlay_grid,
    palette_rgba,
    png_dimensions,
    polygon_bounds,
    served_image_path,
    thumbnail_grid,
    to_mercator,
    webp_dimensions,
)

client = TestClient(app)
SITES = sorted(known_site_keys())


def test_demo_sites_are_the_three_heroes() -> None:
    assert SITES == ["mangrove_mx", "restoration_forest", "wetland_mx"]


# --- Committed images ---------------------------------------------------------------------


@pytest.mark.parametrize("site_key", SITES)
def test_committed_images_are_consistent(site_key: str) -> None:
    """Dimensions, size budget, bounds vs GeoJSON, palette, class shares, attributions."""
    assert check_site_images(site_key) == []


@pytest.mark.parametrize("site_key", SITES)
def test_committed_images_dimensions_budget_and_bounds(site_key: str) -> None:
    meta = load_site_images(site_key)
    overlay = image_path(site_key, "overlay").read_bytes()
    thumbnail = image_path(site_key, "thumbnail").read_bytes()

    assert len(overlay) <= MAX_IMAGE_BYTES
    assert len(thumbnail) <= MAX_IMAGE_BYTES
    assert max(png_dimensions(overlay)) == 1024
    assert png_dimensions(overlay) == (meta.overlay.width, meta.overlay.height)
    assert webp_dimensions(thumbnail) == (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
    assert meta.overlay.bounds == polygon_bounds(load_site_geojson(site_key))
    assert meta.scenario == "baseline"
    assert "baseline only" in meta.scenario_note
    assert any("Dynamic World" in text for text in meta.overlay.attributions)
    assert any("Copernicus Sentinel" in text for text in meta.thumbnail.attributions)
    assert any("Cloud Score+" in text for text in meta.thumbnail.attributions)
    assert [entry.color for entry in meta.overlay.legend] == list(DW_PALETTE)


def test_overlay_is_transparent_outside_the_polygon() -> None:
    png = decode_indexed_png(image_path("wetland_mx", "overlay").read_bytes())
    transparent = len(DW_PALETTE)
    corners = [0, png.width - 1, (png.height - 1) * png.width, png.width * png.height - 1]

    assert png.palette[transparent][3] == 0
    assert all(png.palette[index][3] == 255 for index in range(transparent))
    assert all(png.pixels[i] == transparent for i in corners)


def _copy_site(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, site_key: str) -> None:
    for kind in ("overlay", "thumbnail", "sidecar"):
        shutil.copy(image_path(site_key, kind), tmp_path)
    monkeypatch.setattr(site_images, "IMAGES_DIR", tmp_path)


def test_check_flags_bounds_that_do_not_match_the_geojson(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _copy_site(tmp_path, monkeypatch, "wetland_mx")
    sidecar = tmp_path / "wetland_mx.images.json"
    data = json.loads(sidecar.read_text())
    data["overlay"]["bounds"][0][0] -= 0.001
    sidecar.write_text(json.dumps(data))

    assert any("overlay bounds" in problem for problem in check_site_images("wetland_mx"))


def test_check_flags_an_overlay_that_disagrees_with_the_metrics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _copy_site(tmp_path, monkeypatch, "wetland_mx")
    meta = load_site_images("wetland_mx")
    width, height = meta.overlay.width, meta.overlay.height
    all_water = encode_indexed_png(bytes(width * height), width, height, palette_rgba(DW_PALETTE))
    (tmp_path / "wetland_mx.overlay.png").write_bytes(all_water)

    problems = check_site_images("wetland_mx")
    assert any("water share" in problem for problem in problems)
    assert any("opaque share" in problem for problem in problems)


def test_check_flags_missing_files_and_oversized_images(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _copy_site(tmp_path, monkeypatch, "wetland_mx")
    thumb = tmp_path / "wetland_mx.thumbnail.webp"
    thumb.write_bytes(thumb.read_bytes() + bytes(MAX_IMAGE_BYTES))
    assert any("budget" in problem for problem in check_site_images("wetland_mx"))

    thumb.unlink()
    assert check_site_images("wetland_mx")[0].startswith("wetland_mx: missing")


# --- Route --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("file", "media_type"),
    [
        ("overlay.png", "image/png"),
        ("thumbnail.webp", "image/webp"),
        ("images.json", "application/json"),
    ],
)
@pytest.mark.parametrize("site_key", SITES)
def test_route_serves_each_file(site_key: str, file: str, media_type: str) -> None:
    res = client.get(f"/media/demo-sites/{site_key}/{file}")

    assert res.status_code == 200
    assert res.headers["content-type"].split(";")[0] == media_type
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["cache-control"] == "public, max-age=86400"
    if file != "images.json":
        kind = "overlay" if file == "overlay.png" else "thumbnail"
        assert res.content == image_path(site_key, kind).read_bytes()


def test_route_sidecar_body_is_the_committed_metadata() -> None:
    body = client.get("/media/demo-sites/wetland_mx/images.json").json()

    assert body == load_site_images("wetland_mx").model_dump(mode="json")
    assert body["overlay"]["bounds"] == [[19.2802, -99.1056], [19.2945, -99.0892]]


def test_route_needs_no_world_cookie() -> None:
    fresh = TestClient(app)
    assert fresh.get("/media/demo-sites/mangrove_mx/thumbnail.webp").status_code == 200
    assert "set-cookie" not in fresh.get("/media/demo-sites/mangrove_mx/images.json").headers


@pytest.mark.parametrize(
    "site_key",
    [
        "atlantis",  # valid pattern, unknown site
        "WETLAND_MX",
        "wetland-mx",
        "wetland_mx.json",
        "scenarios",
        "images",
        "a" * 65,
        "%2e%2e",
        "..",
        "wetland_mx%00",
        "..%2Fwetland_mx",
        "..%5Cwetland_mx",
        "%2e%2e%2f%2e%2e%2fapp",
    ],
)
@pytest.mark.parametrize("file", ["overlay.png", "thumbnail.webp", "images.json"])
def test_route_rejects_unknown_and_traversal_keys(site_key: str, file: str) -> None:
    res = client.get(f"/media/demo-sites/{site_key}/{file}")

    assert res.status_code == 404
    assert res.headers["content-type"].startswith("application/json")


@pytest.mark.parametrize(
    "path",
    [
        "/media/demo-sites/wetland_mx/../../../app/main.py",
        "/media/demo-sites/wetland_mx/overlay.json",
        "/media/demo-sites/wetland_mx/wetland_mx.json",
        "/media/demo-sites/wetland_mx/thumbnail.png",
        "/media/demo-sites/wetland_mx/",
        "/media/demo-sites/..%2F..%2Fapp%2Fmain.py/overlay.png",
    ],
)
def test_route_serves_only_the_three_files(path: str) -> None:
    assert client.get(path).status_code == 404


def test_served_path_requires_allowlisted_known_site() -> None:
    assert (
        served_image_path("wetland_mx", "overlay") == image_path("wetland_mx", "overlay").resolve()
    )
    assert served_image_path("../wetland_mx", "overlay") is None
    assert served_image_path("atlantis", "overlay") is None
    with pytest.raises(ValueError):
        image_path("../etc", "overlay")


# --- Grids --------------------------------------------------------------------------------

BOUNDS = ((19.2802, -99.1056), (19.2945, -99.0892))


def test_overlay_grid_spans_the_bounds_exactly_with_1024_px_long_side() -> None:
    grid = overlay_grid(BOUNDS)
    (south, west), (north, east) = grid.bounds()

    assert (grid.width, grid.height) == (1024, 946)
    assert south == pytest.approx(BOUNDS[0][0], abs=1e-12)
    assert east == pytest.approx(BOUNDS[1][1], abs=1e-12)
    assert grid.scale_x == pytest.approx(grid.scale_y, rel=1e-3)
    assert grid.to_pixel(BOUNDS[0][1], BOUNDS[1][0]) == pytest.approx((0.0, 0.0), abs=1e-6)
    assert grid.to_pixel(BOUNDS[1][1], BOUNDS[0][0]) == pytest.approx((1024, 946), abs=1e-6)


def test_overlay_grid_for_a_tall_polygon_keeps_the_long_side() -> None:
    tall = ((10.0, 20.0), (10.02, 20.01))
    grid = overlay_grid(tall)
    assert grid.height == 1024
    assert grid.width < grid.height


def test_thumbnail_grid_has_card_aspect_square_pixels_and_contains_the_polygon() -> None:
    grid = thumbnail_grid(BOUNDS)
    (south, west), (north, east) = grid.bounds()

    assert (grid.width, grid.height) == (640, 400)
    assert grid.scale_x == pytest.approx(grid.scale_y)
    assert south < BOUNDS[0][0] and west < BOUNDS[0][1]
    assert north > BOUNDS[1][0] and east > BOUNDS[1][1]
    centre_x = (to_mercator(west, south)[0] + to_mercator(east, north)[0]) / 2
    polygon_centre_x = (to_mercator(BOUNDS[0][1], 0)[0] + to_mercator(BOUNDS[1][1], 0)[0]) / 2
    assert centre_x == pytest.approx(polygon_centre_x)


def test_ee_grid_is_north_up_web_mercator() -> None:
    grid = overlay_grid(BOUNDS).ee_grid()
    assert grid["crsCode"] == "EPSG:3857"
    assert grid["affineTransform"]["scaleY"] < 0
    assert grid["dimensions"] == {"width": 1024, "height": 946}


# --- PNG / WebP --------------------------------------------------------------------------


def test_indexed_png_round_trip_is_deterministic() -> None:
    palette = palette_rgba(DW_PALETTE)
    pixels = bytes([0, 1, 2, 9, 8, 7, 3, 4, 5, 6, 9, 0])

    first = encode_indexed_png(pixels, 4, 3, palette)
    assert first == encode_indexed_png(pixels, 4, 3, palette)
    assert png_dimensions(first) == (4, 3)
    decoded = decode_indexed_png(first)
    assert (decoded.width, decoded.height, decoded.pixels) == (4, 3, pixels)
    assert decoded.palette == tuple(palette)


def _png_with_rows(width: int, rows: list[bytes]) -> bytes:
    def chunk(kind: bytes, body: bytes) -> bytes:
        crc = struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
        return struct.pack(">I", len(body)) + kind + body + crc

    header = struct.pack(">IIBBBBB", width, len(rows), 8, 3, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"PLTE", bytes(3 * 16))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


def test_png_decoder_undoes_every_row_filter() -> None:
    # Target pixels: row 0 = 1 2 3, row 1 = 4 6 8, row 2 = 5 7 9, row 3 = 6 9 12.
    rows = [
        b"\x01" + bytes([1, 1, 1]),  # Sub
        b"\x02" + bytes([3, 4, 5]),  # Up
        b"\x03" + bytes([3, 2, 2]),  # Average: 5-(0+4)//2, 7-(5+6)//2, 9-(7+8)//2
        b"\x04" + bytes([1, 2, 3]),  # Paeth: predictors 5 (up), 7 (up), 9 (left)
    ]
    decoded = decode_indexed_png(_png_with_rows(3, rows))

    assert decoded.pixels == bytes([1, 2, 3, 4, 6, 8, 5, 7, 9, 6, 9, 12])
    assert decoded.palette[0] == (0, 0, 0, 255)


def test_encoder_rejects_bad_input() -> None:
    palette = palette_rgba(DW_PALETTE)
    with pytest.raises(ValueError):
        encode_indexed_png(bytes(5), 2, 2, palette)
    with pytest.raises(ValueError):
        encode_indexed_png(bytes([10, 0, 0, 0]), 2, 2, palette)


def test_webp_dimensions_reads_all_three_header_kinds() -> None:
    lossless_bits = (99 - 1) | ((49 - 1) << 14)
    vp8l = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0\x2f" + lossless_bits.to_bytes(4, "little")
    vp8x = (
        b"RIFF\0\0\0\0WEBPVP8X"
        + bytes(8)
        + (639).to_bytes(3, "little")
        + (399).to_bytes(3, "little")
    )

    assert webp_dimensions(vp8l) == (99, 49)
    assert webp_dimensions(vp8x) == (640, 400)
    assert webp_dimensions(image_path("wetland_mx", "thumbnail").read_bytes()) == (640, 400)
    with pytest.raises(ValueError):
        webp_dimensions(b"not a webp")

"""Precompute Earth Engine metrics for committed demo-site GeoJSON files.

Run from the repository root with:

    cd backend && PATH=$HOME/.local/bin:$PATH uv run python ../scripts/precompute_sites.py

Use ``--check`` to recompute and compare against committed JSON without rewriting it.
The Earth Engine methods live in ``app.tools.earth_engine`` and are shared with live ratings
of new listings (T60); the demo sites stay precomputed, so the judging path never calls Earth
Engine and loads the cached JSON through ``app.tools.earth_obs``.

After the observed sites, the script regenerates the Time Machine scenario variants
(``backend/data/demo_sites/scenarios/``) from the committed baselines and
``scenarios.json`` with the pure functions in ``app.tools.scenarios`` (T13). Add
``--scenarios-only`` to skip Earth Engine and only regenerate (or ``--check``) those.

``--images`` (T35) renders each site's Dynamic World land-cover overlay (indexed PNG with a
transparent background) and a Sentinel-2 true-colour marketplace thumbnail (WebP) into
``backend/data/demo_sites/images/`` with a sidecar ``<site>.images.json``. The overlay renderer
(``app.tools.earth_engine.dw_overlay_png``) is shared with live-rated listings (#231). It needs
Pillow:

    cd backend && PATH=$HOME/.local/bin:$PATH uv run --with pillow \
      python ../scripts/precompute_sites.py --images

``--images --check`` needs neither Earth Engine nor Pillow: Earth Engine collections can gain
or reprocess scenes, so it verifies the committed files (dimensions, size, bounds against the
GeoJSON, palette, attributions, class shares against the metrics) instead of the bytes.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import ee

from app.config import get_settings
from app.tools.earth_engine import (
    AFTER_WINDOW,
    ATTRIBUTIONS,
    BEFORE_WINDOW,
    CLOUD_SCORE_THRESHOLD,
    DATA_VERSION,
    END_DATE,
    START_12M,
    THUMBNAIL_OUTLINE,
    THUMBNAIL_VIS,
    compute_polygon_metrics,
    dw_overlay_png,
    geometry_from_feature,
    init_ee,
    true_colour_webp,
)
from app.tools.earth_obs import SCENARIO_DIR, EarthObsMetrics, scenario_path
from app.tools.scenarios import build_site_scenarios, load_scenario_spec, scenario_document
from app.tools.site_images import (
    DW_CLASSES,
    DW_LABELS,
    DW_PALETTE,
    IMAGES_DIR,
    OVERLAY_ATTRIBUTIONS,
    OVERLAY_BAND,
    OVERLAY_DATASET_ID,
    OVERLAY_METHOD,
    SCENARIO_NOTE,
    SENTINEL_2_IMAGE_ATTRIBUTION,
    Bounds,
    LegendEntry,
    OverlayImage,
    SiteImages,
    ThumbnailImage,
    check_site_images,
    image_path,
    load_site_geojson,
    load_site_images,
    overlay_grid,
    polygon_bounds,
    polygon_ring,
    thumbnail_grid,
)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "backend" / "data" / "demo_sites"


def _init_ee() -> None:
    init_ee(get_settings().ee_service_account_json)


def _load_existing_timestamp(site_key: str) -> str | None:
    path = DATA_DIR / f"{site_key}.json"
    if not path.exists():
        return None
    existing = json.loads(path.read_text())
    timestamp = existing.get("computed_at_utc")
    return timestamp if isinstance(timestamp, str) else None


def compute_site(site_key: str, computed_at_utc: str | None = None) -> dict[str, Any]:
    """A demo site's metrics with the shared methods (`app.tools.earth_engine`, also used by
    live ratings of new listings, T60)."""
    path = DATA_DIR / f"{site_key}.geojson"
    try:
        return compute_polygon_metrics(
            json.loads(path.read_text()), site_key=site_key, computed_at_utc=computed_at_utc
        )
    except ValueError as exc:
        raise ValueError(f"{path}: {exc}") from exc


def _json_text(data: Mapping[str, Any]) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def compare_cached_metrics(expected: Any, actual: Any, path: str = "$") -> list[str]:
    if isinstance(expected, dict) and isinstance(actual, dict):
        messages: list[str] = []
        if set(expected) != set(actual):
            return [f"{path}: keys differ {sorted(expected)} != {sorted(actual)}"]
        for key in sorted(expected):
            messages.extend(compare_cached_metrics(expected[key], actual[key], f"{path}.{key}"))
        return messages
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return [f"{path}: lengths differ {len(expected)} != {len(actual)}"]
        messages = []
        for index, (left, right) in enumerate(zip(expected, actual, strict=True)):
            messages.extend(compare_cached_metrics(left, right, f"{path}[{index}]"))
        return messages
    if isinstance(expected, float | int) and isinstance(actual, float | int):
        if math.isclose(float(expected), float(actual), rel_tol=1e-4, abs_tol=1e-4):
            return []
        return [f"{path}: {expected!r} != {actual!r}"]
    if expected == actual:
        return []
    return [f"{path}: {expected!r} != {actual!r}"]


def _site_keys(selected: str | None) -> list[str]:
    if selected:
        return [selected]
    return sorted(path.stem for path in DATA_DIR.glob("*.geojson"))


def expected_scenario_documents(site_keys: list[str]) -> dict[Path, dict[str, Any]]:
    """Scenario JSON that the committed baselines and ``scenarios.json`` produce (no EE)."""
    spec = load_scenario_spec()
    documents: dict[Path, dict[str, Any]] = {}
    for site_key in site_keys:
        baseline = EarthObsMetrics.model_validate_json(
            scenario_path(site_key, "baseline").read_text()
        )
        for scenario, metrics in build_site_scenarios(baseline, spec).items():
            if scenario != "baseline":
                documents[scenario_path(site_key, scenario)] = scenario_document(metrics)
    return documents


def scenario_failures(site_keys: list[str], *, write: bool) -> list[str]:
    """Regenerate (``write``) or compare the scenario files; return mismatches."""
    failures: list[str] = []
    expected = expected_scenario_documents(site_keys)
    if write:
        SCENARIO_DIR.mkdir(exist_ok=True)
        for path, document in expected.items():
            path.write_text(_json_text(document))
            print(f"Wrote {path.relative_to(ROOT)}")
        return failures
    for path, document in expected.items():
        if not path.exists():
            failures.append(f"{path} does not exist.")
            continue
        committed = json.loads(path.read_text())
        failures.extend(compare_cached_metrics(committed, document, path=path.name))
    if not failures:
        known, all_sites = set(expected), set(_site_keys(None))
        stray = [
            path
            for path in SCENARIO_DIR.glob("*.json")
            if path not in known
            and (path.name.split(".")[0] in site_keys or path.name.split(".")[0] not in all_sites)
        ]
        failures.extend(f"{path} is not produced by scenarios.json." for path in stray)
    return failures


# --- Images (T35) -------------------------------------------------------------------------


def _stable_bounds(bounds: Bounds) -> Bounds:
    """Round to 1e-9 degrees (~0.1 mm): Web Mercator trig differs in the last bit across
    platforms (macOS vs Linux libm), which would make the committed sidecar flap in CI."""
    (south, west), (north, east) = bounds
    return (round(south, 9), round(west, 9)), (round(north, 9), round(east, 9))


def expected_site_images(site_key: str) -> SiteImages:
    """Sidecar metadata for a site's images: a pure function of the GeoJSON and constants."""
    bounds = polygon_bounds(load_site_geojson(site_key))
    overlay, thumb = overlay_grid(bounds), thumbnail_grid(bounds)
    window = {"start": START_12M, "end": END_DATE}
    return SiteImages(
        site_key=site_key,
        data_version=DATA_VERSION,
        scenario_note=SCENARIO_NOTE,
        overlay=OverlayImage(
            file=image_path(site_key, "overlay").name,
            width=overlay.width,
            height=overlay.height,
            bounds=bounds,
            dataset_id=OVERLAY_DATASET_ID,
            band=OVERLAY_BAND,
            method=OVERLAY_METHOD,
            date_window=window,
            palette=DW_PALETTE,
            legend=tuple(
                LegendEntry(value=index, key=key, label=label, color=color)
                for index, (key, label, color) in enumerate(
                    zip(DW_CLASSES, DW_LABELS, DW_PALETTE, strict=True)
                )
            ),
            attributions=OVERLAY_ATTRIBUTIONS,
        ),
        thumbnail=ThumbnailImage(
            file=image_path(site_key, "thumbnail").name,
            width=thumb.width,
            height=thumb.height,
            bounds=_stable_bounds(thumb.bounds()),
            dataset_ids=(
                "COPERNICUS/S2_SR_HARMONIZED",
                "GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED",
            ),
            method=(
                "Median true-colour composite (B4, B3, B2) of Sentinel-2 SR Harmonized "
                f"scenes over the date window, each masked where Cloud Score+ cs_cdf < "
                f"{CLOUD_SCORE_THRESHOLD:.2f}; the polygon outline is drawn on top."
            ),
            date_window=window,
            visualization=THUMBNAIL_VIS,
            outline_color=THUMBNAIL_OUTLINE,
            attributions=(SENTINEL_2_IMAGE_ATTRIBUTION, ATTRIBUTIONS["cloud_score_plus"]),
        ),
    )


def write_site_images(site_key: str) -> None:
    geojson = load_site_geojson(site_key)
    meta = expected_site_images(site_key)
    aoi = ee.Geometry(geometry_from_feature(geojson))
    bounds = polygon_bounds(geojson)
    IMAGES_DIR.mkdir(exist_ok=True)
    # The same overlay renderer as live-rated listings (#231).
    overlay = dw_overlay_png(aoi, overlay_grid(bounds))
    thumbnail = true_colour_webp([polygon_ring(geojson)], thumbnail_grid(bounds), *AFTER_WINDOW)
    for kind, data in (("overlay", overlay), ("thumbnail", thumbnail)):
        path = image_path(site_key, kind)
        path.write_bytes(data)
        print(f"Wrote {path.relative_to(ROOT)} ({len(data):,} bytes)")
    sidecar = image_path(site_key, "sidecar")
    sidecar.write_text(_json_text(meta.model_dump(mode="json")))
    print(f"Wrote {sidecar.relative_to(ROOT)}")


def write_before_image(site_key: str) -> None:
    """The same true-colour view five years earlier (BEFORE_WINDOW), for the vision model's
    before/after comparison. Same grid and outline as the thumbnail."""
    geojson = load_site_geojson(site_key)
    data = true_colour_webp(
        [polygon_ring(geojson)], thumbnail_grid(polygon_bounds(geojson)), *BEFORE_WINDOW
    )
    path = image_path(site_key, "before")
    path.write_bytes(data)
    print(f"Wrote {path.relative_to(ROOT)} ({len(data):,} bytes)")


def image_failures(site_keys: list[str]) -> list[str]:
    """Offline check of the committed images and sidecars (no Earth Engine, no Pillow)."""
    failures: list[str] = []
    for site_key in site_keys:
        problems = check_site_images(site_key)
        failures.extend(problems)
        if not problems and load_site_images(site_key) != expected_site_images(site_key):
            failures.append(f"{site_key}: sidecar differs from what --images would write.")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="Only compute one site key.")
    parser.add_argument("--check", action="store_true", help="Compare with committed JSON.")
    parser.add_argument(
        "--scenarios-only",
        action="store_true",
        help="Skip Earth Engine; only regenerate or check the scenario variants.",
    )
    parser.add_argument(
        "--images",
        action="store_true",
        help="Only render the overlay and thumbnail images (with --check: verify them offline).",
    )
    parser.add_argument(
        "--before",
        action="store_true",
        help="Only render the true-colour view five years earlier (before.webp).",
    )
    args = parser.parse_args()
    if args.before:
        _init_ee()
        for site_key in _site_keys(args.site):
            print(f"Rendering {site_key} before image...")
            write_before_image(site_key)
        return 0
    if args.images and args.scenarios_only:
        parser.error("--images and --scenarios-only are separate steps.")

    started = time.perf_counter()
    failures: list[str] = []
    site_keys = _site_keys(args.site)
    if args.images:
        if not args.check:
            _init_ee()
            for site_key in site_keys:
                print(f"Rendering {site_key} images...")
                write_site_images(site_key)
        failures.extend(image_failures(site_keys))
        return _report(failures, started, args.check, f"{len(site_keys)} site(s) images")
    if args.scenarios_only:
        failures.extend(scenario_failures(site_keys, write=not args.check))
        return _report(failures, started, args.check, f"{len(site_keys)} site(s) scenarios")
    _init_ee()
    for site_key in site_keys:
        output_path = DATA_DIR / f"{site_key}.json"
        existing_timestamp = _load_existing_timestamp(site_key)
        print(f"Computing {site_key}...")
        data = compute_site(site_key, computed_at_utc=existing_timestamp)
        if args.check:
            if not output_path.exists():
                failures.append(f"{output_path} does not exist.")
                continue
            existing = json.loads(output_path.read_text())
            failures.extend(compare_cached_metrics(existing, data, path=site_key))
        else:
            output_path.write_text(_json_text(data))
            print(f"Wrote {output_path.relative_to(ROOT)}")

    # Scenarios derive from the committed baselines, so only check them once those match.
    if not failures:
        failures.extend(scenario_failures(site_keys, write=not args.check))
    return _report(failures, started, args.check, f"{len(site_keys)} site(s) and scenarios")


def _report(failures: list[str], started: float, check: bool, what: str) -> int:
    elapsed = time.perf_counter() - started
    if failures:
        print("\n".join(failures), file=sys.stderr)
        print(f"FAILED in {elapsed:.1f}s", file=sys.stderr)
        return 1
    verb = "Checked" if check else "Computed"
    print(f"{verb} {what} in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

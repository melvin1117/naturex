import { describe, expect, it } from "vitest";

import type { LandCoverOverlay, SiteImages } from "@/lib/api/types";
import {
  assetLandCover,
  assetOverlayUrl,
  NO_OVERLAY_NOTE,
} from "@/lib/land-cover-overlay";

import images from "../exchange/fixtures/images.json";

const SIDECAR = images as unknown as SiteImages;
const LIVE: LandCoverOverlay = {
  version: "5e9d5f21a9c6-1792650000",
  media_type: "image/png",
  width: 1024,
  height: 1012,
  bounds: { south: 9.9, west: -84.1, north: 9.9072, east: -84.0927 },
  crs: "EPSG:3857",
  dataset_id: "GOOGLE/DYNAMICWORLD/V1",
  method: "Per-pixel mode of the Dynamic World V1 label",
  date_window: { start: "2025-10-01", end: "2026-10-01" },
  attributions: [
    "Dynamic World: This dataset is produced for the Dynamic World Project by Google",
    "Contains modified Copernicus Sentinel data 2025-2026.",
  ],
};
const ID = "75704a09-3f99-4578-8717-b8e506ffacf9";

describe("the asset page's land-cover overlay (#231)", () => {
  it("keeps a demo site's precomputed overlay and its scenario note", () => {
    const cover = assetLandCover(
      { id: ID, site_key: "wetland_mx", land_cover_overlay: null },
      SIDECAR,
    );
    expect(cover?.overlay).toEqual({
      url: "/api/media/demo-sites/wetland_mx/overlay.png",
      bounds: [
        [19.2802, -99.1056],
        [19.2945, -99.0892],
      ],
    });
    expect(cover?.note).toBe(SIDECAR.scenario_note);
    expect(cover?.attributions).toEqual(SIDECAR.overlay.attributions);
    // Until the sidecar loads, no overlay (and no "no overlay" note either: see the view).
    expect(
      assetLandCover(
        { id: ID, site_key: "wetland_mx", land_cover_overlay: LIVE },
        undefined,
      ),
    ).toBeNull();
  });

  it("uses a live-rated listing's own overlay, at a versioned URL", () => {
    const cover = assetLandCover(
      { id: ID, site_key: null, land_cover_overlay: LIVE },
      undefined,
    );
    expect(cover).toEqual({
      overlay: {
        url: `/api/assets/${ID}/overlay.png?v=5e9d5f21a9c6-1792650000`,
        bounds: [
          [9.9, -84.1],
          [9.9072, -84.0927],
        ],
      },
      dateWindow: LIVE.date_window,
      attributions: LIVE.attributions,
    });
    expect(assetOverlayUrl("a/b", "v 1")).toBe(
      "/api/assets/a%2Fb/overlay.png?v=v%201",
    );
  });

  it("has none without a live rating's overlay, and never fakes one", () => {
    for (const land_cover_overlay of [null, undefined])
      expect(
        assetLandCover({ id: ID, site_key: null, land_cover_overlay }, SIDECAR),
      ).toBeNull();
    expect(NO_OVERLAY_NOTE).toBe(
      "Land-cover overlay appears after a live satellite rating.",
    );
  });
});

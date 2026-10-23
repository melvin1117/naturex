/** Which Dynamic World land-cover overlay an asset page shows (T35, #231). */
import type {
  AssetDetail,
  LandCoverOverlay,
  SiteImages,
} from "@/lib/api/types";
import { demoSiteMediaUrl } from "@/lib/demo-site-images";
import type { LatLng } from "@/lib/prototype/data";

/** Shown instead of an overlay: land cover is never faked (mock data, no live rating yet). */
export const NO_OVERLAY_NOTE =
  "Land-cover overlay appears after a live satellite rating.";

export type AssetLandCover = {
  overlay: { url: string; bounds: [LatLng, LatLng] };
  dateWindow: { start: string; end: string };
  attributions: readonly string[];
  /** The demo sites' note on Time Machine scenarios (their overlay is the baseline only). */
  note?: string;
};

/** Same-origin URL through the `/api` proxy (`/api/sandbox` in the sandbox); `version` changes
 * when the overlay is re-rendered. */
export function assetOverlayUrl(
  assetId: string,
  version: string,
  apiBase = "/api",
): string {
  return `${apiBase}/assets/${encodeURIComponent(assetId)}/overlay.png?v=${encodeURIComponent(version)}`;
}

function sidecarBounds(
  bounds: SiteImages["overlay"]["bounds"],
): [LatLng, LatLng] {
  return [
    [bounds[0][0], bounds[0][1]],
    [bounds[1][0], bounds[1][1]],
  ];
}

function liveBounds({
  south,
  west,
  north,
  east,
}: LandCoverOverlay["bounds"]): [LatLng, LatLng] {
  return [
    [south, west],
    [north, east],
  ];
}

/**
 * A demo site's precomputed overlay (its `site_key` and sidecar), else the listing's own from
 * its live satellite rating, else null (show `NO_OVERLAY_NOTE` and the boundary map).
 */
export function assetLandCover(
  asset: Pick<AssetDetail, "id" | "site_key" | "land_cover_overlay">,
  images: SiteImages | undefined,
  apiBase = "/api",
): AssetLandCover | null {
  if (asset.site_key) {
    if (!images) return null;
    return {
      overlay: {
        url: demoSiteMediaUrl(asset.site_key, "overlay.png"),
        bounds: sidecarBounds(images.overlay.bounds),
      },
      dateWindow: images.overlay.date_window,
      attributions: images.overlay.attributions,
      note: images.scenario_note,
    };
  }
  const live = asset.land_cover_overlay;
  if (!live) return null;
  return {
    overlay: {
      url: assetOverlayUrl(asset.id, live.version, apiBase),
      bounds: liveBounds(live.bounds),
    },
    dateWindow: live.date_window,
    attributions: live.attributions,
  };
}

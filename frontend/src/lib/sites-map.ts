/**
 * Geometry for the Marketplace's map view: the API's outlines (`[lon, lat]` rings) as Leaflet's
 * `[lat, lng]`, each site's pin point, and the box that frames them all.
 */
import type { LonLatRing } from "./boundary-map";
import { SITE_DATA } from "./site-data";

export type LatLng = [number, number];

/**
 * A site's boundary for the map: the card's outline, or a curated demo site's polygon (its card
 * carries a thumbnail instead of an outline).
 */
export function mapOutline(card: {
  outline: readonly LonLatRing[];
  siteKey: string | null;
}): LonLatRing[] {
  if (card.outline.length > 0) return [...card.outline];
  const site = card.siteKey
    ? SITE_DATA.find((s) => s.key === card.siteKey)
    : undefined;
  return site ? [site.polygon.map(([lat, lon]) => [lon, lat])] : [];
}

/** A ring as Leaflet draws it. */
export function ringLatLngs(ring: LonLatRing): LatLng[] {
  return ring.map(([lon, lat]) => [lat, lon]);
}

/** Where a site's pin goes: the middle of its outer ring's extent, or null without one. */
export function siteCentre(outline: readonly LonLatRing[]): LatLng | null {
  const ring = outline[0];
  if (!ring || ring.length === 0) return null;
  let [minLon, minLat] = ring[0]!;
  let [maxLon, maxLat] = ring[0]!;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
}

/** South-west and north-east corners around every outline, or null when none has one. */
export function sitesBounds(
  outlines: readonly (readonly LonLatRing[])[],
): [LatLng, LatLng] | null {
  const points = outlines.flatMap((rings) => rings.flat());
  if (points.length === 0) return null;
  const lats = points.map(([, lat]) => lat);
  const lons = points.map(([lon]) => lon);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

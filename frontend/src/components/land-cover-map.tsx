"use client";

import "leaflet/dist/leaflet.css";

import type { Map as LeafletMap } from "leaflet";
import { useEffect, useRef } from "react";

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const DYNAMIC_WORLD_ATTRIBUTION = "Land cover: Dynamic World";

type LatLng = readonly [number, number];

export type LandCoverMapProps = {
  /** URL of the transparent land-cover PNG. */
  overlayUrl: string;
  /** `[[south, west], [north, east]]`, from the sidecar. */
  bounds: readonly [LatLng, LatLng];
  label: string;
  opacity?: number;
};

/**
 * OpenStreetMap basemap with the precomputed land-cover PNG as a Leaflet `ImageOverlay`.
 * Leaflet touches `window` on import, so it loads inside the effect (client only).
 */
export function LandCoverMap({
  overlayUrl,
  bounds,
  label,
  opacity = 0.8,
}: LandCoverMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const [[south, west], [north, east]] = bounds;

  useEffect(() => {
    let map: LeafletMap | undefined;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      const overlayBounds = L.latLngBounds([south, west], [north, east]);
      map = L.map(container.current, { scrollWheelZoom: false });
      L.tileLayer(OSM_TILE_URL, {
        maxZoom: 19,
        attribution: OSM_ATTRIBUTION,
      }).addTo(map);
      L.imageOverlay(overlayUrl, overlayBounds, {
        opacity,
        alt: `${label} land-cover overlay`,
        attribution: DYNAMIC_WORLD_ATTRIBUTION,
      }).addTo(map);
      map.fitBounds(overlayBounds, { padding: [12, 12] });
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [overlayUrl, south, west, north, east, label, opacity]);

  return (
    <div
      ref={container}
      role="region"
      aria-label={`${label} land-cover map`}
      className="isolate h-80 w-full overflow-hidden rounded-md border"
    />
  );
}

"use client";

import "leaflet/dist/leaflet.css";

import type { Map as LeafletMap } from "leaflet";
import { useEffect, useRef } from "react";
import { cn } from "cn";

import type { LatLng } from "@/lib/prototype/data";

export const IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const IMAGERY_ATTRIBUTION =
  "Imagery © Esri, Maxar, Earthstar Geographics";

/** Satellite basemap, the site boundary and (optionally) the Dynamic World overlay. */
export function SiteMap({
  polygon,
  overlay,
  label,
  className,
  others = [],
}: {
  polygon: LatLng[];
  overlay?: { url: string; bounds: [LatLng, LatLng]; visible: boolean };
  label: string;
  className?: string;
  others?: LatLng[][];
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const overlayRef = useRef<import("leaflet").ImageOverlay | null>(null);
  const key = JSON.stringify(polygon);

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      const map = L.map(container.current, {
        scrollWheelZoom: false,
        attributionControl: true,
      });
      mapRef.current = map;
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 18,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(map);
      for (const other of others)
        L.polygon(other, {
          color: "#ffffff",
          weight: 1,
          dashArray: "4 4",
          fillOpacity: 0.05,
        }).addTo(map);
      const shape = L.polygon(polygon, {
        color: "#d6f28a",
        weight: 2.5,
        fillOpacity: 0.08,
      }).addTo(map);
      if (overlay) {
        overlayRef.current = L.imageOverlay(overlay.url, overlay.bounds, {
          opacity: overlay.visible ? 0.75 : 0,
          alt: `${label} land-cover overlay`,
          attribution: "Land cover: Dynamic World",
        }).addTo(map);
      }
      map.fitBounds(shape.getBounds(), { padding: [24, 24] });
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // Rebuild only when the boundary changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    overlayRef.current?.setOpacity(overlay?.visible ? 0.75 : 0);
  }, [overlay?.visible]);

  return (
    <div
      ref={container}
      role="region"
      aria-label={`${label} map`}
      className={cn(
        "isolate h-72 w-full overflow-hidden rounded-2xl",
        className,
      )}
    />
  );
}

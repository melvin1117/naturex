"use client";

import "leaflet/dist/leaflet.css";

import type { Map as LeafletMap } from "leaflet";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/lib/imagery";
import type { LatLng } from "@/lib/prototype/data";

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
  const [map, setMap] = useState<{
    L: typeof import("leaflet");
    map: LeafletMap;
  } | null>(null);
  const overlayRef = useRef<import("leaflet").ImageOverlay | null>(null);
  const key = JSON.stringify(polygon);

  useEffect(() => {
    let cancelled = false;
    let created: LeafletMap | null = null;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      created = L.map(container.current, {
        scrollWheelZoom: false,
        attributionControl: true,
      });
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 18,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(created);
      for (const other of others)
        L.polygon(other, {
          color: "#ffffff",
          weight: 1,
          dashArray: "4 4",
          fillOpacity: 0.05,
        }).addTo(created);
      const shape = L.polygon(polygon, {
        color: "#d6f28a",
        weight: 2.5,
        fillOpacity: 0.08,
      }).addTo(created);
      created.fitBounds(shape.getBounds(), { padding: [24, 24] });
      setMap({ L, map: created });
    });
    return () => {
      cancelled = true;
      created?.remove();
      setMap(null);
    };
    // Rebuild only when the boundary changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The overlay may arrive after the map (its bounds come from the API).
  const overlayUrl = overlay?.url;
  const boundsKey = JSON.stringify(overlay?.bounds ?? null);
  useEffect(() => {
    if (!map || !overlayUrl) return;
    const bounds = JSON.parse(boundsKey) as [LatLng, LatLng];
    const layer = map.L.imageOverlay(overlayUrl, bounds, {
      opacity: 0,
      alt: `${label} land-cover overlay`,
      attribution: "Land cover: Dynamic World",
    }).addTo(map.map);
    overlayRef.current = layer;
    return () => {
      layer.remove();
      overlayRef.current = null;
    };
  }, [map, overlayUrl, boundsKey, label]);

  const visible = overlay?.visible ?? false;
  useEffect(() => {
    overlayRef.current?.setOpacity(visible ? 0.75 : 0);
  }, [visible, map, overlayUrl, boundsKey]);

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

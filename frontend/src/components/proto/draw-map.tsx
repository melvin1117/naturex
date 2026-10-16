"use client";

import "leaflet/dist/leaflet.css";

import type { LayerGroup, Map as LeafletMap } from "leaflet";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/components/proto/site-map";
import type { LatLng } from "@/lib/prototype/data";

/**
 * Click-to-draw boundary on satellite imagery. Each click adds a corner; the parent owns the
 * points so validation, undo and the "use saved boundary" animation live outside Leaflet.
 */
export function DrawMap({
  points,
  onAdd,
  center,
  others,
  valid,
  className,
}: {
  points: LatLng[];
  onAdd: (p: LatLng) => void;
  center: LatLng;
  others: { name: string; polygon: LatLng[] }[];
  valid: boolean;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const [ready, setReady] = useState(false);
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      leafletRef.current = L;
      const map = L.map(container.current, {
        scrollWheelZoom: true,
        doubleClickZoom: false,
      }).setView(center, 15);
      mapRef.current = map;
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 18,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(map);
      for (const o of others)
        L.polygon(o.polygon, {
          color: "#ffffff",
          weight: 1.5,
          dashArray: "5 5",
          fillOpacity: 0.12,
        })
          .bindTooltip(`${o.name} (listed)`)
          .addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.on("click", (e) =>
        onAddRef.current([
          Math.round(e.latlng.lat * 1e5) / 1e5,
          Math.round(e.latlng.lng * 1e5) / 1e5,
        ]),
      );
      map.getContainer().style.cursor = "crosshair";
      setReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is created once; points render in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const L = leafletRef.current;
    const layer = layerRef.current;
    if (!L || !layer) return;
    layer.clearLayers();
    const color = valid ? "#d6f28a" : "#f0b27a";
    if (points.length >= 3)
      L.polygon(points, { color, weight: 2.5, fillOpacity: 0.15 }).addTo(layer);
    else if (points.length === 2)
      L.polyline(points, { color, weight: 2.5 }).addTo(layer);
    points.forEach((p) =>
      L.circleMarker(p, {
        radius: 4,
        color: "#1f3a2a",
        weight: 1.5,
        fillColor: color,
        fillOpacity: 1,
      }).addTo(layer),
    );
  }, [points, valid, ready]);

  return (
    <div
      ref={container}
      role="application"
      aria-label="Boundary map. Click to add corners, or use the saved boundary button."
      className={cn(
        "isolate h-[420px] w-full overflow-hidden rounded-3xl",
        className,
      )}
    />
  );
}

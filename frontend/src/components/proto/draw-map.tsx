"use client";

import "leaflet/dist/leaflet.css";

import type { LayerGroup, Map as LeafletMap } from "leaflet";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/lib/imagery";
import type { LatLng } from "@/lib/prototype/data";

/** Corners are drawn as markers only up to this many; the outline is always drawn. */
export const MAX_CORNER_MARKERS = 300;

/** Where the map should look: a point at a zoom, or the bounds of some corners. */
export type MapFocus = { center: LatLng; zoom: number } | { bounds: LatLng[] };

/**
 * Click-to-draw boundary on satellite imagery. Each click adds a corner; the parent owns the
 * points so validation, undo and the "use saved boundary" animation live outside Leaflet.
 * `others` (outlines of listed sites) and `focus` may change after the map is created.
 */
export function DrawMap({
  points,
  onAdd,
  center,
  zoom = 15,
  focus = null,
  others,
  valid,
  label = "Boundary map. Click to add corners, or use the saved boundary button.",
  className,
}: {
  points: LatLng[];
  onAdd: (p: LatLng) => void;
  center: LatLng;
  zoom?: number;
  /** Move the map whenever this object changes (by reference). */
  focus?: MapFocus | null;
  others: { name: string; polygon: LatLng[] }[];
  valid: boolean;
  label?: string;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const othersRef = useRef<LayerGroup | null>(null);
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
      }).setView(center, zoom);
      mapRef.current = map;
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 18,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(map);
      othersRef.current = L.layerGroup().addTo(map);
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
    const layer = othersRef.current;
    if (!L || !layer) return;
    layer.clearLayers();
    for (const o of others) {
      // Text only: Leaflet would parse a string tooltip as HTML.
      const tooltip = document.createElement("span");
      tooltip.textContent = `${o.name} (listed)`;
      L.polygon(o.polygon, {
        color: "#ffffff",
        weight: 1.5,
        dashArray: "5 5",
        fillOpacity: 0.12,
      })
        .bindTooltip(tooltip)
        .addTo(layer);
    }
  }, [others, ready]);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !focus) return;
    if ("bounds" in focus) {
      if (focus.bounds.length > 0)
        map.fitBounds(L.latLngBounds(focus.bounds), {
          padding: [32, 32],
          maxZoom: 16,
        });
    } else map.setView(focus.center, focus.zoom);
  }, [focus, ready]);

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
    // A pasted boundary can have thousands of corners: markers for each would freeze the map.
    if (points.length <= MAX_CORNER_MARKERS)
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
      aria-label={label}
      className={cn(
        "isolate h-[420px] w-full overflow-hidden rounded-3xl",
        className,
      )}
    />
  );
}

"use client";

import "leaflet/dist/leaflet.css";

import type {
  LayerGroup,
  Map as LeafletMap,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
} from "leaflet";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "cn";

import type { MapFocus } from "@/components/proto/draw-map";
import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/components/proto/site-map";
import {
  midpoint,
  roundPoint,
  type BoundaryIssues,
  type DrawMode,
  type EditorAction,
  type Outline,
} from "@/lib/listing";
import type { LatLng } from "@/lib/prototype/data";

/** Corners get drag handles only up to this many (a pasted boundary can have thousands). */
export const MAX_HANDLES = 300;

export type Basemap = "satellite" | "map";

/** Free tiles only (AGENTS.md): Esri World Imagery and its place labels, and OpenStreetMap. */
const BASEMAPS: Record<
  Basemap,
  { url: string; attribution: string; maxZoom: number }
> = {
  satellite: {
    url: IMAGERY_URL,
    attribution: IMAGERY_ATTRIBUTION,
    maxZoom: 18,
  },
  map: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  },
};
const LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const LABELS_ATTRIBUTION = "Labels © Esri";

const LIME = "#d6f28a";
const CLAY = "#f0b27a";
const CROSSING = "#ff6b3d";

/** Pixels an arrow key moves a focused corner (Shift: five times as far). */
const KEY_STEP_PX = 4;

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function coarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * The listing's boundary editor on satellite imagery (#215). The parent owns the corners (a
 * pure reducer in `lib/listing/drawing.ts`); this map turns gestures into its actions:
 * drawing mode adds a corner per click and closes on the first corner; editing mode drags
 * corners, adds one by dragging (or clicking) an edge's midpoint, and deletes one with a
 * right-click or Delete. Focused corners move with the arrow keys.
 */
export function BoundaryMap({
  points,
  mode,
  dispatch,
  center,
  zoom,
  focus,
  others,
  issues,
  valid,
  basemap = "satellite",
  labels = true,
  label,
  className,
}: {
  points: LatLng[];
  mode: DrawMode;
  dispatch: (action: EditorAction) => void;
  center: LatLng;
  zoom: number;
  /** Fly the map whenever this object changes (by reference). */
  focus: MapFocus | null;
  others: Outline[];
  issues: BoundaryIssues;
  valid: boolean;
  basemap?: Basemap;
  labels?: boolean;
  label: string;
  className?: string;
}) {
  const helpId = useId();
  const container = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const baseRef = useRef<TileLayer | null>(null);
  const labelsRef = useRef<TileLayer | null>(null);
  const othersRef = useRef<LayerGroup | null>(null);
  const shapeRef = useRef<LayerGroup | null>(null);
  const bandRef = useRef<Polyline | null>(null);
  /** The corner to focus once the handles are redrawn (after a keyboard move or delete). */
  const refocus = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  // Event handlers bound once read the latest props through this ref.
  const latest = useRef({ points, mode, dispatch });
  latest.current = { points, mode, dispatch };

  useEffect(() => {
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      leafletRef.current = L;
      const map = L.map(container.current, {
        zoomControl: false,
        doubleClickZoom: false,
        zoomSnap: 0.5,
        wheelPxPerZoomLevel: 90,
        maxZoom: 19,
      }).setView(center, zoom);
      mapRef.current = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);
      othersRef.current = L.layerGroup().addTo(map);
      shapeRef.current = L.layerGroup().addTo(map);
      bandRef.current = L.polyline([], {
        color: LIME,
        weight: 2,
        dashArray: "4 6",
        interactive: false,
      }).addTo(map);
      map.on("click", (e) => {
        if (latest.current.mode !== "drawing") return;
        latest.current.dispatch({
          type: "add",
          point: roundPoint([e.latlng.lat, e.latlng.lng]),
        });
      });
      map.on("mousemove", (e) => {
        const { points: pts, mode: m } = latest.current;
        if (m !== "drawing" || !pts.length) return;
        const cursor: LatLng = [e.latlng.lat, e.latlng.lng];
        bandRef.current?.setLatLngs(
          pts.length >= 2 ? [pts.at(-1)!, cursor, pts[0]] : [pts[0], cursor],
        );
      });
      map.on("mouseout", () => bandRef.current?.setLatLngs([]));
      setReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is created once; everything else renders in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fullscreen and layout changes resize the container: let Leaflet measure it again.
  useEffect(() => {
    const el = container.current;
    if (!ready || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      mapRef.current?.invalidateSize({ animate: false }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    baseRef.current?.remove();
    const base = BASEMAPS[basemap];
    baseRef.current = L.tileLayer(base.url, {
      maxZoom: base.maxZoom,
      maxNativeZoom: base.maxZoom,
      attribution: base.attribution,
    }).addTo(map);
    baseRef.current.bringToBack();
    labelsRef.current?.remove();
    labelsRef.current = null;
    if (labels && basemap === "satellite")
      labelsRef.current = L.tileLayer(LABELS_URL, {
        maxZoom: 19,
        maxNativeZoom: 18,
        attribution: LABELS_ATTRIBUTION,
      }).addTo(map);
  }, [basemap, labels, ready]);

  useEffect(() => {
    const L = leafletRef.current;
    const layer = othersRef.current;
    if (!L || !layer) return;
    layer.clearLayers();
    others.forEach((o, i) => {
      const clash = issues.overlapping.includes(i);
      // Text only: Leaflet would parse a string tooltip as HTML.
      const tooltip = document.createElement("span");
      tooltip.textContent = clash
        ? `${o.name} (listed): your boundary overlaps it`
        : `${o.name} (listed)`;
      L.polygon(o.polygon, {
        color: clash ? CROSSING : "#ffffff",
        weight: clash ? 2.5 : 1.5,
        dashArray: "5 5",
        fillColor: clash ? CROSSING : "#ffffff",
        fillOpacity: clash ? 0.22 : 0.12,
      })
        .bindTooltip(tooltip)
        .addTo(layer);
    });
  }, [others, issues.overlapping, ready]);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map || !focus) return;
    const animate = !reducedMotion();
    if ("bounds" in focus) {
      if (!focus.bounds.length) return;
      const bounds = L.latLngBounds(focus.bounds);
      const options = { padding: [48, 48] as [number, number], maxZoom: 17 };
      if (animate) map.flyToBounds(bounds, { ...options, duration: 1.1 });
      else map.fitBounds(bounds, { ...options, animate: false });
    } else if (animate) map.flyTo(focus.center, focus.zoom, { duration: 1.1 });
    else map.setView(focus.center, focus.zoom, { animate: false });
  }, [focus, ready]);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = shapeRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();
    bandRef.current?.setLatLngs([]);
    map.getContainer().style.cursor = mode === "drawing" ? "crosshair" : "";
    const n = points.length;
    const color = valid ? LIME : CLAY;

    // What a drag reshapes live, before the move is committed on release.
    let live: Polygon | Polyline | null = null;
    if (mode === "editing" && n >= 3) {
      live = L.polygon(points, { color, weight: 2.5, fillOpacity: 0.16 }).addTo(
        layer,
      );
    } else if (n >= 2) {
      if (n >= 3)
        L.polygon(points, {
          stroke: false,
          fillColor: color,
          fillOpacity: 0.1,
        }).addTo(layer);
      live = L.polyline(points, { color, weight: 2.5 }).addTo(layer);
      if (n >= 3)
        L.polyline([points[n - 1], points[0]], {
          color,
          weight: 2,
          dashArray: "4 6",
          opacity: 0.8,
        }).addTo(layer);
    }
    // Crossing edges: a light halo under a bright stroke, readable on any imagery.
    for (const edge of issues.crossing) {
      const segment = [points[edge], points[(edge + 1) % n]];
      if (!segment[0] || !segment[1]) continue;
      L.polyline(segment, { color: "#ffffff", weight: 7, opacity: 0.85 }).addTo(
        layer,
      );
      L.polyline(segment, { color: CROSSING, weight: 3.5 }).addTo(layer);
    }
    if (n > MAX_HANDLES) return;

    const size = coarsePointer() ? 40 : 28;
    const reshape = (next: LatLng[]) => live?.setLatLngs(next);
    const el = map.getContainer();
    const handles: Marker[] = [];

    points.forEach((point, i) => {
      const closer = mode === "drawing" && i === 0 && n >= 3;
      const marker = L.marker(point, {
        draggable: true,
        keyboard: true,
        title: closer
          ? "Click to finish the boundary here"
          : "Drag to move. Right-click to delete.",
        icon: L.divIcon({
          className: cn(
            "nx-handle nx-handle--vertex",
            closer && "nx-handle--closer",
            !valid && "nx-handle--invalid",
          ),
          html: '<span class="nx-handle__dot"></span>',
          iconSize: [size, size],
        }),
      }).addTo(layer);
      marker.on("dragstart", () => el.classList.add("nx-map--dragging"));
      marker.on("drag", () => {
        const { lat, lng } = marker.getLatLng();
        reshape(points.map((p, j) => (j === i ? [lat, lng] : p)));
      });
      marker.on("dragend", () => {
        el.classList.remove("nx-map--dragging");
        const { lat, lng } = marker.getLatLng();
        latest.current.dispatch({ type: "move", index: i, point: [lat, lng] });
      });
      marker.on("click", () => {
        if (closer) latest.current.dispatch({ type: "finish" });
      });
      marker.on("contextmenu", (e) => {
        e.originalEvent.preventDefault();
        latest.current.dispatch({ type: "remove", index: i });
      });
      const icon = marker.getElement();
      if (icon) {
        icon.setAttribute(
          "aria-label",
          closer
            ? `Corner 1 of ${n}: press Enter to finish the boundary`
            : `Corner ${i + 1} of ${n}`,
        );
        icon.setAttribute("aria-describedby", helpId);
        icon.addEventListener("keydown", (event) =>
          onCornerKey(event, i, marker),
        );
      }
      handles.push(marker);
    });

    if (mode === "editing" && n >= 3)
      points.forEach((_, i) => {
        const marker = L.marker(midpoint(points, i), {
          draggable: true,
          keyboard: false,
          title: "Drag or click to add a corner here",
          icon: L.divIcon({
            className: "nx-handle nx-handle--midpoint",
            html: '<span class="nx-handle__dot"></span>',
            iconSize: [size - 6, size - 6],
          }),
        }).addTo(layer);
        const insertAt = (lat: number, lng: number): LatLng[] => [
          ...points.slice(0, i + 1),
          [lat, lng],
          ...points.slice(i + 1),
        ];
        marker.on("dragstart", () => el.classList.add("nx-map--dragging"));
        marker.on("drag", () => {
          const { lat, lng } = marker.getLatLng();
          reshape(insertAt(lat, lng));
        });
        marker.on("dragend", () => {
          el.classList.remove("nx-map--dragging");
          const { lat, lng } = marker.getLatLng();
          latest.current.dispatch({
            type: "insert",
            index: i + 1,
            point: [lat, lng],
          });
        });
        marker.on("click", () =>
          latest.current.dispatch({
            type: "insert",
            index: i + 1,
            point: midpoint(points, i),
          }),
        );
      });

    const target = refocus.current;
    refocus.current = null;
    if (target !== null && n)
      handles[Math.min(target, n - 1)]?.getElement()?.focus();

    function onCornerKey(event: KeyboardEvent, i: number, marker: Marker) {
      const map = mapRef.current;
      if (!map) return;
      const step = event.shiftKey ? KEY_STEP_PX * 5 : KEY_STEP_PX;
      const moves: Record<string, [number, number]> = {
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
      };
      const { dispatch: send } = latest.current;
      if (event.key in moves) {
        const [dx, dy] = moves[event.key];
        const at = map.latLngToContainerPoint(marker.getLatLng()).add([dx, dy]);
        const { lat, lng } = map.containerPointToLatLng(at);
        refocus.current = i;
        send({ type: "move", index: i, point: [lat, lng] });
      } else if (event.key === "Delete" || event.key === "Backspace") {
        refocus.current = Math.max(0, i - 1);
        send({ type: "remove", index: i });
      } else if (
        (event.key === "Insert" || event.key === "+") &&
        latest.current.points.length >= 2
      ) {
        refocus.current = i + 1;
        send({
          type: "insert",
          index: i + 1,
          point: midpoint(latest.current.points, i),
        });
      } else return;
      // Keep Leaflet's keyboard panning (and the page) from also acting on the key.
      event.preventDefault();
      event.stopPropagation();
    }
  }, [points, mode, valid, issues.crossing, helpId, ready]);

  return (
    <>
      <div
        ref={container}
        role="application"
        aria-label={label}
        className={cn("isolate h-full w-full", className)}
      />
      <p id={helpId} className="sr-only">
        Drag a corner, or use the arrow keys to move it (hold Shift for bigger
        steps). Press Delete to remove it, or Insert to add a corner after it.
      </p>
    </>
  );
}

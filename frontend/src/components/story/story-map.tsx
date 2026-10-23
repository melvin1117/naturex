"use client";

import "leaflet/dist/leaflet.css";

import type * as Leaflet from "leaflet";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ForwardedRef,
} from "react";

import type { Story } from "@/lib/api/types";
import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/lib/imagery";
import {
  apiMedia,
  firstYearLabel,
  leafletBounds,
  northEdge,
  type LatLng,
} from "@/lib/story";

/** What the story asks the map to do; every method resolves when its motion has finished. */
export interface StoryMapHandle {
  /** Fly from the city to the site (no boundary yet). */
  flyToSite: () => Promise<void>;
  /** Draw the boundary once the map has landed. */
  drawBoundary: () => Promise<void>;
  /** Paint the land cover in under a moving scan line. */
  revealLandCover: () => Promise<void>;
  hideLandCover: () => void;
  /** Show the earlier view, sweep to the latest, then settle in the middle (then draggable). */
  sweepViews: () => Promise<void>;
  hideViews: () => void;
  /** The simulated damage on the north edge, then its restoration. */
  markNorthEdge: (state: "damaged" | "restored" | null) => Promise<void>;
  /** Back to the site: no layers, the boundary kept. */
  reset: () => void;
}

type Props = {
  story: Story;
  reducedMotion: boolean;
  /** Pixels the story panel and the chain cover, so the site is framed beside them. */
  inset: { top: number; right: number; bottom: number; left: number };
};

const ease = {
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  out: (t: number) => 1 - (1 - t) ** 3,
  sine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
};

function tween(
  ms: number,
  curve: (t: number) => number,
  frame: (v: number) => void,
  instant: boolean,
): Promise<void> {
  if (instant || ms <= 0) {
    frame(1);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      frame(curve(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

const wait = (ms: number, instant: boolean) =>
  instant ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms));

function loaded(img: HTMLImageElement): Promise<void> {
  if (img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

const CLAY = "oklch(0.66 0.13 48)";
const LIME = "oklch(0.86 0.135 126)";

/**
 * The story's stage: Esri satellite imagery with the wetland's own layers from `GET /story`
 * (boundary, Dynamic World land cover, Sentinel-2 views five years apart). Leaflet touches
 * `window` on import, so it loads in an effect; calls made before it's ready wait for it.
 * The story moves the map, so map interaction is off; the before/after divider is draggable
 * (pointer or arrow keys).
 */
export const StoryMap = forwardRef(function StoryMap(
  { story, reducedMotion, inset }: Props,
  ref: ForwardedRef<StoryMapHandle>,
) {
  const container = useRef<HTMLDivElement>(null);
  const layers = useRef<{
    L?: typeof Leaflet;
    map?: Leaflet.Map;
    boundary?: Leaflet.Polygon;
    landCover?: Leaflet.ImageOverlay;
    before?: Leaflet.ImageOverlay;
    after?: Leaflet.ImageOverlay;
    divider?: HTMLDivElement;
    edge?: Leaflet.Polygon;
  }>({});
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(
    null,
  );
  if (ready.current === null) {
    let resolve = () => {};
    const promise = new Promise<void>((r) => (resolve = r));
    ready.current = { promise, resolve };
  }
  const latest = useRef({ story, reducedMotion, inset });
  useEffect(() => {
    latest.current = { story, reducedMotion, inset };
  });

  useEffect(() => {
    let cancelled = false;
    const state = layers.current;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      const site = L.latLngBounds(story.site.boundary as LatLng[]);
      const map = L.map(container.current, {
        zoomControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false,
        zoomSnap: 0.25,
      }).setView(site.getCenter(), 11);
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 19,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(map);
      state.L = L;
      state.map = map;
      ready.current?.resolve();
    });
    return () => {
      cancelled = true;
      state.divider?.remove();
      state.map?.remove();
      layers.current = {};
    };
  }, [story]);

  useImperativeHandle(ref, () => {
    const instant = () => latest.current.reducedMotion;
    const ring = () => latest.current.story.site.boundary as LatLng[];
    const padding = () => {
      const { top, right, bottom, left } = latest.current.inset;
      return {
        paddingTopLeft: [left + 40, top + 40] as [number, number],
        paddingBottomRight: [right + 40, bottom + 40] as [number, number],
      };
    };
    const flyTo = async (
      bounds: Leaflet.LatLngBoundsExpression,
      seconds: number,
    ) => {
      const map = layers.current.map;
      if (!map) return;
      if (instant()) {
        map.fitBounds(bounds, { ...padding(), animate: false });
        return;
      }
      await new Promise<void>((resolve) => {
        map.once("moveend", () => resolve());
        map.flyToBounds(bounds, { ...padding(), duration: seconds });
      });
    };
    /** Container pixels an overlay covers (the map is still while it's shown). */
    const rectOf = (bounds: [LatLng, LatLng]) => {
      const map = layers.current.map!;
      const sw = map.latLngToContainerPoint(bounds[0]);
      const ne = map.latLngToContainerPoint(bounds[1]);
      return { left: sw.x, top: ne.y, width: ne.x - sw.x, height: sw.y - ne.y };
    };

    return {
      async flyToSite() {
        await ready.current!.promise;
        await wait(600, instant());
        await flyTo(ring(), 3.2);
      },

      async drawBoundary() {
        await ready.current!.promise;
        const { L, map } = layers.current;
        if (!L || !map || layers.current.boundary) return;
        const polygon = L.polygon(ring(), {
          color: "#ffffff",
          weight: 2.5,
          fillColor: "#ffffff",
          fillOpacity: 0,
          interactive: false,
        }).addTo(map);
        layers.current.boundary = polygon;
        const path = polygon.getElement() as SVGPathElement | undefined;
        if (!path || instant() || !path.getTotalLength) {
          polygon.setStyle({ fillOpacity: 0.06 });
          return;
        }
        const length = path.getTotalLength();
        path.style.strokeDasharray = `${length}`;
        path.style.strokeDashoffset = `${length}`;
        await tween(
          2000,
          ease.inOut,
          (v) => (path.style.strokeDashoffset = `${length * (1 - v)}`),
          false,
        );
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
        await tween(
          700,
          ease.out,
          (v) => polygon.setStyle({ fillOpacity: 0.06 * v }),
          false,
        );
      },

      async revealLandCover() {
        await ready.current!.promise;
        const { L, map } = layers.current;
        if (!L || !map) return;
        const { images } = latest.current.story;
        const bounds = leafletBounds(images.overlay.bounds);
        const overlay = L.imageOverlay(apiMedia(images.overlay.url), bounds, {
          opacity: 0.85,
          alt: "Dynamic World land cover of the wetland, latest 12 months",
          attribution: "Land cover: Dynamic World",
        }).addTo(map);
        layers.current.landCover = overlay;
        const img = overlay.getElement()!;
        img.style.clipPath = "inset(0 100% 0 0)";
        await loaded(img);
        const rect = rectOf(bounds);
        const scan = document.createElement("div");
        scan.setAttribute("aria-hidden", "true");
        scan.className =
          "pointer-events-none absolute z-[450] w-20 -translate-x-full bg-gradient-to-r from-transparent to-lime/30";
        scan.innerHTML =
          '<span class="absolute inset-y-0 right-0 w-0.5 bg-lime"></span>';
        Object.assign(scan.style, {
          top: `${rect.top - 8}px`,
          height: `${rect.height + 16}px`,
          left: `${rect.left}px`,
        });
        if (!instant()) map.getContainer().appendChild(scan);
        await tween(
          3000,
          ease.inOut,
          (v) => {
            img.style.clipPath = `inset(0 ${(1 - v) * 100}% 0 0)`;
            scan.style.left = `${rect.left + v * rect.width}px`;
          },
          instant(),
        );
        await tween(
          450,
          ease.out,
          (v) => (scan.style.opacity = `${1 - v}`),
          instant(),
        );
        scan.remove();
        img.style.clipPath = "";
      },

      hideLandCover() {
        const overlay = layers.current.landCover;
        if (!overlay) return;
        layers.current.landCover = undefined;
        void tween(
          800,
          ease.out,
          (v) => overlay.setOpacity(0.85 * (1 - v)),
          instant(),
        ).then(() => overlay.remove());
      },

      async sweepViews() {
        await ready.current!.promise;
        const { L, map } = layers.current;
        if (!L || !map) return;
        const { images, land } = latest.current.story;
        const bounds = leafletBounds(images.after.bounds);
        await flyTo(bounds, 1.4);
        const before = L.imageOverlay(apiMedia(images.before.url), bounds, {
          opacity: 0,
          alt: "The wetland in the first year of five (Sentinel-2)",
          attribution: "Contains modified Copernicus Sentinel data",
        }).addTo(map);
        const after = L.imageOverlay(apiMedia(images.after.url), bounds, {
          opacity: 1,
          alt: "The wetland in the latest 12 months (Sentinel-2)",
        }).addTo(map);
        layers.current.before = before;
        layers.current.after = after;
        const afterImg = after.getElement()!;
        afterImg.style.clipPath = "inset(0 0 0 100%)";
        await Promise.all([loaded(before.getElement()!), loaded(afterImg)]);
        await tween(1100, ease.out, (v) => before.setOpacity(v), instant());

        const rect = rectOf(bounds);
        const divider = document.createElement("div");
        divider.className = "absolute z-[460] w-0 touch-none";
        divider.dataset.storyDivider = "";
        Object.assign(divider.style, {
          top: `${rect.top}px`,
          height: `${rect.height}px`,
        });
        divider.innerHTML = `
          <span aria-hidden="true" class="absolute inset-y-0 -left-px w-0.5 bg-white shadow-[0_2px_14px_rgba(0,0,0,0.45)]"></span>
          <span aria-hidden="true" class="absolute top-3 right-4 rounded-full bg-black/60 px-2.5 py-1 text-xs whitespace-nowrap text-white">${firstYearLabel(land.ndvi_window.start)}</span>
          <span aria-hidden="true" class="absolute top-3 left-4 rounded-full bg-black/60 px-2.5 py-1 text-xs whitespace-nowrap text-white">Last 12 months</span>
          <button type="button" aria-label="Compare the two views: arrow keys or drag" class="pointer-events-auto absolute top-1/2 -left-4 grid size-8 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full bg-white text-machine shadow-[0_4px_14px_rgba(0,0,0,0.35)] focus-visible:ring-2 focus-visible:ring-lime focus-visible:outline-none">
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18-6-6 6-6M15 6l6 6-6 6"/></svg>
          </button>`;
        map.getContainer().appendChild(divider);
        layers.current.divider = divider;
        let x = 1;
        const place = (to: number) => {
          x = Math.min(1, Math.max(0, to));
          afterImg.style.clipPath = `inset(0 0 0 ${x * 100}%)`;
          divider.style.left = `${rect.left + x * rect.width}px`;
        };
        place(1);
        await tween(3600, ease.sine, (v) => place(1 - v), instant());
        await wait(500, instant());
        await tween(1500, ease.inOut, (v) => place(0.5 * v), instant());
        const handle = divider.querySelector("button")!;
        handle.addEventListener("pointerdown", (e) => {
          handle.setPointerCapture(e.pointerId);
          const origin = map.getContainer().getBoundingClientRect().left;
          const move = (ev: PointerEvent) =>
            place((ev.clientX - origin - rect.left) / rect.width);
          const up = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
        });
        handle.addEventListener("keydown", (e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          place(x + (e.key === "ArrowLeft" ? -0.05 : 0.05));
        });
      },

      hideViews() {
        const { before, after, divider } = layers.current;
        layers.current.before = undefined;
        layers.current.after = undefined;
        layers.current.divider = undefined;
        divider?.remove();
        if (!before || !after) return;
        void tween(
          800,
          ease.out,
          (v) => {
            before.setOpacity(1 - v);
            after.setOpacity(1 - v);
          },
          instant(),
        ).then(() => {
          before.remove();
          after.remove();
        });
        void flyTo(ring(), 1.2);
      },

      async markNorthEdge(mark) {
        await ready.current!.promise;
        const { L, map } = layers.current;
        if (!L || !map) return;
        if (mark === null) {
          layers.current.edge?.remove();
          layers.current.edge = undefined;
          return;
        }
        if (mark === "damaged") {
          layers.current.edge?.remove();
          const edge = L.polygon(northEdge(ring()), {
            color: CLAY,
            weight: 2,
            dashArray: "5 5",
            fillColor: CLAY,
            fillOpacity: 0,
            interactive: false,
          }).addTo(map);
          layers.current.edge = edge;
          await tween(
            1300,
            ease.out,
            (v) => edge.setStyle({ fillOpacity: 0.5 * v }),
            instant(),
          );
          return;
        }
        const edge = layers.current.edge;
        if (!edge) return;
        edge.setStyle({ color: LIME, fillColor: LIME });
        await tween(
          1400,
          ease.inOut,
          (v) => edge.setStyle({ fillOpacity: 0.5 - 0.15 * v }),
          instant(),
        );
        await wait(900, instant());
        await tween(
          1600,
          ease.out,
          (v) => edge.setStyle({ fillOpacity: 0.35 * (1 - v), opacity: 1 - v }),
          instant(),
        );
        edge.remove();
        layers.current.edge = undefined;
      },

      reset() {
        const s = layers.current;
        s.landCover?.remove();
        s.before?.remove();
        s.after?.remove();
        s.divider?.remove();
        s.edge?.remove();
        s.landCover = s.before = s.after = s.divider = s.edge = undefined;
        if (s.map) void flyTo(ring(), 1.2);
      },
    };
  }, []);

  return (
    <div
      ref={container}
      role="img"
      aria-label={`Satellite map of ${story.site.name}, ${story.site.place}`}
      className="absolute inset-0 isolate bg-machine [&_.leaflet-control-attribution]:!bg-machine/70 [&_.leaflet-control-attribution]:!text-[10px] [&_.leaflet-control-attribution]:!text-machine-muted [&_.leaflet-control-attribution_a]:!text-machine-ink [&_.leaflet-tile]:!h-[256.5px] [&_.leaflet-tile]:!w-[256.5px]"
    />
  );
});

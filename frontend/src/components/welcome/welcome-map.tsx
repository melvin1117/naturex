"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/lib/imagery";
import { SITE_DATA } from "@/lib/site-data";

const HERO = SITE_DATA.find((s) => s.key === "wetland_mx");

/**
 * The welcome's ground: the hero wetland from above (Esri imagery), drifting slowly, with its
 * boundary drawn once, the brand's "Draw" move (something is being measured). Nothing to
 * interact with; under reduced motion the frame holds still with the boundary already drawn.
 */
export function WelcomeMap() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!HERO) return;
    let cancelled = false;
    let remove = () => {};
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      const ring = HERO.polygon as [number, number][];
      const bounds = L.latLngBounds(ring);
      const map = L.map(container.current, {
        zoomControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false,
        zoomSnap: 0.25,
      });
      // The picture is decoration; the imagery credit stays readable and reachable.
      map.getPanes().mapPane.setAttribute("aria-hidden", "true");
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 19,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(map);
      // Frame the wetland to the right of the words on wide screens, low and centred on phones.
      const wide = window.matchMedia("(min-width: 900px)").matches;
      map.fitBounds(bounds, {
        paddingTopLeft: wide ? [window.innerWidth * 0.5, 96] : [32, 360],
        paddingBottomRight: wide ? [96, 96] : [32, 64],
        animate: false,
      });
      const boundary = L.polygon(ring, {
        color: "oklch(0.86 0.135 126)",
        weight: 2.5,
        fill: true,
        fillColor: "oklch(0.86 0.135 126)",
        fillOpacity: 0.07,
        className: "welcome-boundary",
        interactive: false,
      }).addTo(map);
      // A unit length, so the CSS draw needs no measuring.
      boundary.getElement()?.setAttribute("pathLength", "1");
      remove = () => map.remove();
    });
    return () => {
      cancelled = true;
      remove();
    };
  }, []);
  return (
    <div className="welcome-drift absolute inset-0">
      <div ref={container} className="size-full bg-machine" />
    </div>
  );
}

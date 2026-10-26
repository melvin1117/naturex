"use client";

import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { useEffect, useRef, useState } from "react";

import { GRADE_BG } from "@/components/proto/grade";
import { GRADE_LABEL, ha, money } from "@/lib/format";
import { IMAGERY_ATTRIBUTION, IMAGERY_URL } from "@/lib/imagery";
import type { MarketCard } from "@/lib/market-cards";
import {
  mapOutline,
  ringLatLngs,
  siteCentre,
  sitesBounds,
} from "@/lib/sites-map";
import type { Grade } from "@/lib/site-data";

/** Light grades take dark ink, as their badges do. */
const DARK_INK: readonly Grade[] = ["BBB", "BB", "B"];

type Layers = {
  outline: Leaflet.Polygon | null;
  pin: Leaflet.Marker;
};

/**
 * Every site on one satellite map: its drawn boundary in its grade's colour and a pin with its
 * grade and name. A pin (or `focused`, from the list beside the map) flies to that site and
 * opens a card leading to its page. Satellite imagery: Esri.
 */
export default function SitesMapCanvas({
  cards,
  focused,
  onFocus,
  siteHref,
  onOpen,
}: {
  cards: MarketCard[];
  /** The site to fly to; `n` changes on every request, so the same site can be asked again. */
  focused: { id: string; n: number } | null;
  onFocus: (id: string) => void;
  /** The site page's address, for the card's link. */
  siteHref: (id: string) => string;
  /** Open a site's page (a plain click on the card's link). */
  onOpen: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<{
    L: typeof Leaflet;
    map: Leaflet.Map;
  } | null>(null);
  const layers = useRef(new Map<string, Layers>());
  // Which sites the view was last framed for: a refetch of the same sites keeps the view.
  const framed = useRef("");
  // The latest callbacks, so the map's own listeners never go stale.
  const handlers = useRef({ onFocus, siteHref, onOpen });
  useEffect(() => {
    handlers.current = { onFocus, siteHref, onOpen };
  });

  useEffect(() => {
    let cancelled = false;
    let map: Leaflet.Map | null = null;
    void import("leaflet").then((L) => {
      if (cancelled || !container.current) return;
      map = L.map(container.current, {
        zoomControl: false,
        // The page scrolls past the map until someone clicks into it.
        scrollWheelZoom: false,
        zoomSnap: 0.5,
        worldCopyJump: true,
      });
      L.control.zoom({ position: "topright" }).addTo(map);
      L.tileLayer(IMAGERY_URL, {
        maxZoom: 18,
        attribution: IMAGERY_ATTRIBUTION,
      }).addTo(map);
      const live = map;
      live.on("focus click", () => live.scrollWheelZoom.enable());
      live.on("blur", () => live.scrollWheelZoom.disable());
      setReady({ L, map: live });
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, []);

  // Draw the sites shown (the grade filter applies), framing them all.
  useEffect(() => {
    if (!ready || !container.current) return;
    const { L, map } = ready;
    const style = getComputedStyle(container.current);
    const group = L.featureGroup().addTo(map);
    const drawn = new Map<string, Layers>();
    const outlines = cards.map(mapOutline);
    cards.forEach((card, i) => {
      const outline = outlines[i]!;
      const centre = siteCentre(outline);
      if (!centre) return;
      const colour = card.grade
        ? style.getPropertyValue(`--grade-${card.grade.toLowerCase()}`).trim()
        : style.getPropertyValue("--machine-ink").trim();
      const boundary = L.polygon(outline.map(ringLatLngs), {
        color: colour || "white",
        weight: 2.5,
        fillColor: colour || "white",
        fillOpacity: 0.18,
      })
        .on("click", () => handlers.current.onFocus(card.id))
        .addTo(group);
      const pin = L.marker(centre, {
        icon: L.divIcon({
          html: pinElement(card),
          className: "",
          iconSize: undefined,
          iconAnchor: [14, 14],
          popupAnchor: [0, -14],
        }),
        title: `${card.name}${card.grade ? `, grade ${card.grade}` : ", not rated yet"}`,
        riseOnHover: true,
        keyboard: true,
      })
        .bindPopup(
          () =>
            popupElement(card, handlers.current.siteHref(card.id), () =>
              handlers.current.onOpen(card.id),
            ),
          { closeButton: true, className: "sites-map-popup", maxWidth: 280 },
        )
        .on("click", () => handlers.current.onFocus(card.id))
        .addTo(group);
      drawn.set(card.id, { outline: boundary, pin });
    });
    layers.current = drawn;
    const bounds = sitesBounds(outlines);
    const ids = cards.map((c) => c.id).join(",");
    if (bounds && ids !== framed.current)
      // Room for the pins' names, which extend right of their point.
      map.fitBounds(bounds, {
        paddingTopLeft: [48, 56],
        paddingBottomRight: [180, 56],
        maxZoom: 13,
        animate: false,
      });
    framed.current = ids;
    return () => {
      group.remove();
    };
  }, [ready, cards]);

  // Fly to the chosen site and show its card.
  useEffect(() => {
    if (!ready || !focused) return;
    const site = layers.current.get(focused.id);
    if (!site) return;
    const target = site.outline?.getBounds();
    if (target)
      ready.map.flyToBounds(target, {
        padding: [64, 64],
        maxZoom: 15,
        duration: 1.2,
      });
    site.pin.openPopup();
  }, [ready, focused]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Map of the sites"
      className="size-full bg-machine"
    />
  );
}

/** The pin: the grade's colour and letter, then the site's name. Built from text, never HTML. */
function pinElement(card: MarketCard): HTMLElement {
  const pin = document.createElement("span");
  pin.className =
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-card py-1 pr-2.5 pl-1 text-xs font-medium text-foreground shadow-lift ring-1 ring-black/10";
  const grade = document.createElement("span");
  grade.className = card.grade
    ? `grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-semibold ${GRADE_BG[card.grade]} ${DARK_INK.includes(card.grade) ? "text-foreground" : "text-white"}`
    : "grid h-5 min-w-5 place-items-center rounded-full bg-muted px-1 text-[11px] text-muted-foreground";
  grade.textContent = card.grade ?? "–";
  const name = document.createElement("span");
  name.className = "max-w-40 truncate";
  name.textContent = card.name;
  pin.append(grade, name);
  return pin;
}

/** The site's card on the map: name, grade, area, worth range and the way to its page. */
function popupElement(
  card: MarketCard,
  href: string,
  onOpen: () => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "space-y-1.5 font-sans";
  const name = document.createElement("p");
  name.className = "!m-0 font-serif text-xl leading-tight text-foreground";
  name.textContent = card.name;
  const facts = document.createElement("p");
  facts.className = "!m-0 text-xs text-muted-foreground";
  facts.textContent = [
    card.grade
      ? `${card.grade}${card.health === null ? "" : ` · ${card.health.toFixed(1)}`} · ${GRADE_LABEL[card.grade]}`
      : "Not rated yet",
    ha(card.areaHa),
  ].join(" · ");
  root.append(name, facts);
  if (card.valueLow !== null && card.valueHigh !== null) {
    const worth = document.createElement("p");
    worth.className = "!m-0 text-sm text-foreground";
    worth.textContent = `${money(card.valueLow)}–${money(card.valueHigh)} a year in nature's services`;
    root.append(worth);
  }
  const link = document.createElement("a");
  link.href = href;
  link.className =
    "!mt-3 inline-flex rounded-full bg-primary px-4 py-1.5 text-sm font-medium !text-primary-foreground no-underline";
  link.textContent = "View site";
  link.addEventListener("click", (event) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    onOpen();
  });
  root.append(link);
  return root;
}

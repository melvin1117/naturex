/** Helpers for the asset page: the API's asset detail, prices and events as display values. */
import type { AssetDetail, EventOut, PricePoint } from "./api/types";
import { geojsonRings } from "./boundary-map";
import type { LatLng } from "./site-data";
import { num } from "./report-facts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Asset ids are UUIDs; anything else in an `/asset/<id>` address is no site. */
export function isApiAssetId(id: string): boolean {
  return UUID.test(id);
}

/** The outer ring of a GeoJSON Feature or geometry (Polygon, or a MultiPolygon's first part), as [lat, lon]. */
export function boundaryLatLngs(geojson: AssetDetail["geojson"]): LatLng[] {
  const [first = []] = geojsonRings(geojson);
  return first.map(([lon, lat]): LatLng => [lat, lon]);
}

export type ChartPricePoint = {
  t: string;
  price: number;
  reason: string | null;
};

export function chartPrices(
  points: PricePoint[] | undefined,
): ChartPricePoint[] {
  return (points ?? []).flatMap((p) => {
    const price = num(p.price);
    return price === null ? [] : [{ t: p.ts, price, reason: p.reason ?? null }];
  });
}

/** Where an event came from: web news (Tavily), the Time Machine, or the community's evidence. */
export type EventOrigin = "news" | "time_machine" | "evidence";

function eventOrigin(source: string): EventOrigin {
  return source === "admin"
    ? "time_machine"
    : source === "evidence"
      ? "evidence"
      : "news";
}

const SOURCE_LABEL: Record<string, string> = {
  tavily: "Found by News Scout",
  admin: "Injected by Time Machine",
  evidence: "Field evidence from the community",
};

/** Events newest first, as the news list shows them. Titles and summaries stay plain text. */
export function newsItems(events: EventOut[] | undefined) {
  return [...(events ?? [])]
    .sort((a, b) => eventDate(b).localeCompare(eventDate(a)))
    .map((e) => ({
      id: e.id,
      title: e.title?.trim() || "Untitled event",
      summary: e.summary ?? null,
      date: eventDate(e),
      // When WildWorth recorded it: where it sits on the price chart (a dated article or a
      // simulated event's day would otherwise land before that day's prices).
      at: e.created_at,
      direction: e.direction ?? null,
      severity: e.severity ?? null,
      kind: e.impact_type ?? null,
      sourceLabel: SOURCE_LABEL[e.source] ?? e.source,
      origin: eventOrigin(e.source),
      url: e.url ?? null,
    }));
}

function eventDate(e: EventOut) {
  return e.published_at ?? e.created_at;
}

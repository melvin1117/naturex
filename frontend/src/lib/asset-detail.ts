/** Helpers for the asset page: the API's asset detail, prices and events as display values. */
import type { AssetDetail, EventOut, PricePoint } from "./api/types";
import type { LatLng } from "./prototype/data";
import { num } from "./report-facts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Real assets have UUIDs; the prototype's scripted sites use slugs like "xochimilco-wetland". */
export function isApiAssetId(id: string): boolean {
  return UUID.test(id);
}

function ring(coords: unknown): LatLng[] {
  if (!Array.isArray(coords)) return [];
  return coords.flatMap((point) =>
    Array.isArray(point) &&
    typeof point[0] === "number" &&
    typeof point[1] === "number"
      ? [[point[1], point[0]] as LatLng]
      : [],
  );
}

/** The outer ring of a GeoJSON Feature or geometry (Polygon, or a MultiPolygon's first part), as [lat, lon]. */
export function boundaryLatLngs(geojson: AssetDetail["geojson"]): LatLng[] {
  const geometry = (geojson.type === "Feature" ? geojson.geometry : geojson) as
    { type?: unknown; coordinates?: unknown } | null | undefined;
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "Polygon") return ring(geometry.coordinates[0]);
  if (
    geometry.type === "MultiPolygon" &&
    Array.isArray(geometry.coordinates[0])
  )
    return ring((geometry.coordinates[0] as unknown[])[0]);
  return [];
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
      // When NatureX recorded it: where it sits on the price chart (a dated article or a
      // simulated event's day would otherwise land before that day's prices).
      at: e.created_at,
      direction: e.direction ?? null,
      severity: e.severity ?? null,
      kind: e.impact_type ?? null,
      sourceLabel: SOURCE_LABEL[e.source] ?? e.source,
      url: e.url ?? null,
    }));
}

function eventDate(e: EventOut) {
  return e.published_at ?? e.created_at;
}

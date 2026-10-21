/**
 * A static map of a site's boundary: the Web Mercator tiles that cover a fixed-size frame
 * around it and the outline in the same pixels. Light enough for a card grid (no map library).
 */
import { imageryTileUrl } from "./imagery";

/** [lon, lat] in degrees, as in GeoJSON and the API's `outline`. */
export type LonLat = [number, number];
export type LonLatRing = LonLat[];

export type BoundaryTile = {
  url: string;
  /** Top-left corner in frame pixels; every tile is 256 × 256. */
  left: number;
  top: number;
};

export type BoundaryView = {
  zoom: number;
  width: number;
  height: number;
  tiles: BoundaryTile[];
  /** One SVG path per ring, in frame pixels. */
  paths: string[];
};

export const TILE_SIZE = 256;
/** Esri World Imagery is sharp to here nearly everywhere; closer, remote areas go blank. */
export const MAX_ZOOM = 17;
const MAX_LAT = 85.0511;

function worldX(lon: number): number {
  return ((lon + 180) / 360) * TILE_SIZE;
}

function worldY(lat: number): number {
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * TILE_SIZE
  );
}

function usable(ring: LonLatRing): boolean {
  return (
    ring.length >= 3 &&
    ring.every(
      ([lon, lat]) =>
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lon) <= 180 &&
        Math.abs(lat) <= 90,
    )
  );
}

/**
 * The tiles and outline for a `width` × `height` frame showing every ring with a `margin`
 * (share of the frame on each side), at the closest zoom that fits; null without a usable ring.
 */
export function boundaryView(
  rings: readonly LonLatRing[],
  {
    width,
    height,
    margin = 0.12,
  }: { width: number; height: number; margin?: number },
): BoundaryView | null {
  const parts = rings.filter(usable);
  if (parts.length === 0) return null;
  const points = parts.flat().map(([lon, lat]) => [worldX(lon), worldY(lat)]);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const fit = Math.min(
    (width * (1 - 2 * margin)) / Math.max(maxX - minX, 1e-9),
    (height * (1 - 2 * margin)) / Math.max(maxY - minY, 1e-9),
  );
  const zoom = Math.max(0, Math.min(MAX_ZOOM, Math.floor(Math.log2(fit))));
  const scale = 2 ** zoom;
  const originX = ((minX + maxX) / 2) * scale - width / 2;
  const originY = ((minY + maxY) / 2) * scale - height / 2;

  const tiles: BoundaryTile[] = [];
  const n = scale;
  const firstRow = Math.max(0, Math.floor(originY / TILE_SIZE));
  const lastRow = Math.min(
    n - 1,
    Math.floor((originY + height - 1) / TILE_SIZE),
  );
  const firstCol = Math.floor(originX / TILE_SIZE);
  const lastCol = Math.floor((originX + width - 1) / TILE_SIZE);
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      tiles.push({
        url: imageryTileUrl(zoom, ((col % n) + n) % n, row),
        left: col * TILE_SIZE - originX,
        top: row * TILE_SIZE - originY,
      });
    }
  }

  const px = (v: number) => Math.round(v * 10) / 10;
  const paths = parts.map(
    (ring) =>
      ring
        .map(
          ([lon, lat], i) =>
            `${i === 0 ? "M" : "L"}${px(worldX(lon) * scale - originX)} ${px(worldY(lat) * scale - originY)}`,
        )
        .join(" ") + " Z",
  );
  return { zoom, width, height, tiles, paths };
}

function lonLatRing(value: unknown): LonLatRing | null {
  if (!Array.isArray(value)) return null;
  const ring: LonLatRing = [];
  for (const point of value) {
    if (
      !Array.isArray(point) ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number"
    )
      return null;
    ring.push([point[0], point[1]]);
  }
  return ring;
}

/** Each part's exterior ring from a GeoJSON Polygon or MultiPolygon (or a Feature of one). */
export function geojsonRings(geojson: unknown): LonLatRing[] {
  if (!geojson || typeof geojson !== "object") return [];
  const object = geojson as {
    type?: unknown;
    geometry?: unknown;
    coordinates?: unknown;
  };
  if (object.type === "Feature") return geojsonRings(object.geometry);
  if (!Array.isArray(object.coordinates)) return [];
  const polygons =
    object.type === "Polygon"
      ? [object.coordinates]
      : object.type === "MultiPolygon"
        ? object.coordinates
        : [];
  return polygons.flatMap((polygon: unknown) => {
    const ring = Array.isArray(polygon) ? lonLatRing(polygon[0]) : null;
    return ring ? [ring] : [];
  });
}

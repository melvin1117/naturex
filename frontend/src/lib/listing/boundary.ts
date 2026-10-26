/**
 * The listing's boundary: GeoJSON in and out, typed coordinates, and client-side hints that
 * mirror T36 (shape, 10–50,000 ha, overlap). Hints only: the backend checks again on save.
 */
import type { AssetDetail, AssetOutlines } from "../api/types";
import { boundaryLatLngs } from "../asset-detail";
import type { LatLng } from "../site-data";
import {
  areaHa,
  checkPolygon,
  crossingEdges,
  overlaps,
  type PolygonProblemCode,
} from "../geo";

/** T36 refuses polygons with more points than this. */
export const MAX_BOUNDARY_POINTS = 10_000;
/** Above this many corners, the crossing and overlap hints (quadratic) are left to the server. */
export const HINT_MAX_POINTS = 2_000;
/** Pasted text longer than this isn't parsed (a 10,000-corner polygon is well under 1 MB). */
export const MAX_PASTE_CHARS = 2_000_000;

const MIN_HA = 10;
const MAX_HA = 50_000;

export type Outline = { name: string; polygon: LatLng[] };

/** Where the boundary map should look: a point at a zoom, or the bounds of some corners. */
export type MapFocus = { center: LatLng; zoom: number } | { bounds: LatLng[] };

/** What the hint could check: everything, everything but overlap, or only the size. */
export type HintScope = "all" | "no-overlap" | "size";

export type BoundaryHint =
  | { ok: true; areaHa: number; checked: HintScope }
  | { ok: false; areaHa: number; message: string; code: PolygonProblemCode };

type Box = [number, number, number, number];

function bbox(points: LatLng[]): Box {
  let [south, west, north, east] = [90, 180, -90, -180];
  for (const [lat, lon] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
  }
  return [south, west, north, east];
}

function boxesTouch(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function sizeProblem(
  area: number,
): { code: PolygonProblemCode; message: string } | null {
  if (area < MIN_HA)
    return {
      code: "too_small",
      message: `This area is ${area.toFixed(1)} ha. Sites need at least ${MIN_HA} ha.`,
    };
  if (area > MAX_HA)
    return {
      code: "too_large",
      message: `This area is ${Math.round(area).toLocaleString("en-US")} ha. Sites can be at most ${MAX_HA.toLocaleString("en-US")} ha.`,
    };
  return null;
}

/**
 * A hint for the drawn corners against the outlines shown (`complete`: every public site is
 * among them). Only outlines whose bounding boxes touch the boundary are compared, and above
 * `HINT_MAX_POINTS` corners only the size is checked, so a big pasted boundary can't freeze
 * the tab.
 */
export function boundaryHint(
  points: LatLng[],
  others: Outline[] = [],
  { complete = true }: { complete?: boolean } = {},
): BoundaryHint | null {
  if (points.length === 0) return null;
  if (points.length > MAX_BOUNDARY_POINTS)
    return {
      ok: false,
      areaHa: 0,
      code: "too_complex",
      message: `This boundary has ${points.length.toLocaleString("en-US")} corners. Simplify it to at most ${MAX_BOUNDARY_POINTS.toLocaleString("en-US")}.`,
    };
  if (points.length > HINT_MAX_POINTS) {
    const area = areaHa(points);
    const problem = sizeProblem(area);
    return problem
      ? { ok: false, areaHa: area, ...problem }
      : { ok: true, areaHa: area, checked: "size" };
  }
  const box = bbox(points);
  const near = others.filter(
    (o) => o.polygon.length >= 3 && boxesTouch(box, bbox(o.polygon)),
  );
  const check = checkPolygon(points, near);
  return check.ok
    ? { ...check, checked: complete ? "all" : "no-overlap" }
    : check;
}

/** Where a boundary goes wrong, to draw on the map: edges that cross, and listed sites it overlaps. */
export type BoundaryIssues = {
  /** Edge i joins corner i to the next (the last edge closes the shape). */
  crossing: number[];
  /** Indexes into the `others` passed in. */
  overlapping: number[];
};

const NO_ISSUES: BoundaryIssues = { crossing: [], overlapping: [] };

/**
 * The map's view of `boundaryHint`: which edges and sites to highlight. Like the hint, it
 * leaves boundaries over `HINT_MAX_POINTS` corners to the server.
 */
export function boundaryIssues(
  points: LatLng[],
  others: Outline[] = [],
): BoundaryIssues {
  if (points.length < 3 || points.length > HINT_MAX_POINTS) return NO_ISSUES;
  const crossing = points.length >= 4 ? crossingEdges(points) : [];
  const box = bbox(points);
  const overlapping = others.flatMap((o, i) =>
    o.polygon.length >= 3 &&
    boxesTouch(box, bbox(o.polygon)) &&
    overlaps(points, o.polygon)
      ? [i]
      : [],
  );
  return crossing.length || overlapping.length
    ? { crossing, overlapping }
    : NO_ISSUES;
}

/** Outlines from `GET /assets/outlines` as polygons for the map ([lat, lon]), one per part. */
export function outlinePolygons(
  outlines: AssetOutlines["outlines"] | undefined,
  exceptId?: string | null,
): Outline[] {
  return (outlines ?? []).flatMap((o) =>
    o.id === exceptId
      ? []
      : o.rings
          .map((ring) => ({
            name: o.name,
            polygon: ring.map(([lon, lat]) => [lat, lon] as LatLng),
          }))
          .filter((outline) => outline.polygon.length >= 3),
  );
}

/** A closed GeoJSON Polygon ([lon, lat], WGS84) from the drawn corners ([lat, lon]). */
export function toPolygonGeoJson(points: LatLng[]): {
  type: "Polygon";
  coordinates: number[][][];
} {
  const ring = points.map(([lat, lon]) => [lon, lat]);
  if (ring.length > 0) ring.push([...ring[0]]);
  return { type: "Polygon", coordinates: [ring] };
}

function open(points: LatLng[]): LatLng[] {
  const [first, last] = [points[0], points.at(-1)];
  return points.length > 1 && first[0] === last?.[0] && first[1] === last?.[1]
    ? points.slice(0, -1)
    : points;
}

/** The drawn corners of a stored boundary (the closing point dropped). */
export function boundaryPoints(geojson: AssetDetail["geojson"]): LatLng[] {
  return open(boundaryLatLngs(geojson));
}

export function sameBoundary(a: LatLng[], b: LatLng[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1])
  );
}

export type ParsedBoundary =
  { ok: true; points: LatLng[] } | { ok: false; message: string };

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

const PASTE_POLYGON = "Paste a GeoJSON Polygon or a Feature with one.";

/**
 * A pasted boundary: a GeoJSON Polygon (or a Feature, or a one-part MultiPolygon) without holes,
 * in [lon, lat]. Only parsed as data (`JSON.parse`), never run or rendered as HTML; text over
 * `MAX_PASTE_CHARS` and rings over `MAX_BOUNDARY_POINTS` corners are refused before any work.
 */
export function parseBoundary(text: string): ParsedBoundary {
  if (text.length > MAX_PASTE_CHARS)
    return {
      ok: false,
      message:
        "That's too much text for one boundary. Simplify it and paste again.",
    };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "That isn't valid GeoJSON. Paste a Polygon." };
  }
  let geometry = value as {
    type?: unknown;
    coordinates?: unknown;
    geometry?: unknown;
  } | null;
  if (geometry && geometry.type === "Feature")
    geometry = (geometry.geometry ?? {}) as typeof geometry;
  if (
    !geometry ||
    typeof geometry !== "object" ||
    !Array.isArray(geometry.coordinates)
  )
    return { ok: false, message: PASTE_POLYGON };
  let rings: unknown[] = geometry.coordinates;
  if (geometry.type === "MultiPolygon") {
    if (rings.length !== 1)
      return {
        ok: false,
        message: "Paste one area at a time: this has several parts.",
      };
    rings = Array.isArray(rings[0]) ? rings[0] : [];
  } else if (geometry.type !== "Polygon") {
    return { ok: false, message: PASTE_POLYGON };
  }
  if (rings.length !== 1)
    return {
      ok: false,
      message:
        rings.length > 1
          ? "Boundaries with holes can't be listed here."
          : "The polygon has no corners.",
    };
  const ring = rings[0];
  if (!Array.isArray(ring))
    return { ok: false, message: "The polygon has no corners." };
  if (ring.length > MAX_BOUNDARY_POINTS + 1)
    return {
      ok: false,
      message: `This boundary has more than ${MAX_BOUNDARY_POINTS.toLocaleString("en-US")} corners. Simplify it and paste again.`,
    };
  if (!ring.every(isPosition))
    return {
      ok: false,
      message: "Every corner needs a longitude and a latitude.",
    };
  if (ring.some(([lon, lat]) => Math.abs(lon) > 180 || Math.abs(lat) > 90))
    return {
      ok: false,
      message: "Coordinates must be longitude, latitude in degrees (WGS84).",
    };
  const points = open(ring.map(([lon, lat]) => [lat, lon] as LatLng));
  if (points.length < 3)
    return { ok: false, message: "A boundary needs at least three corners." };
  return { ok: true, points };
}

/** "lat, lon" typed by a person, e.g. "19.29, -99.10" (rounded to ~1 m, like map clicks). */
export function parseCoordinates(text: string): LatLng | null {
  const match = text
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
}

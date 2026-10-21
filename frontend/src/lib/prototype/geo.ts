/** Listing-polygon checks mirroring T36: shape, 10–50,000 ha, no overlap. */
import type { LatLng } from "./data";

const R = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

/** Spherical polygon area (same method as turf/area), in hectares. */
export function areaHa(points: LatLng[]) {
  if (points.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const [lat1, lon1] = points[i];
    const [lat2, lon2] = points[(i + 1) % points.length];
    total += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * R * R) / 2) / 10_000;
}

function orient(a: LatLng, b: LatLng, c: LatLng) {
  return (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
}

function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** `p` lies on segment a–b (given the three are collinear). */
function within(a: LatLng, b: LatLng, p: LatLng) {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** Segments that cross or merely touch: a corner on the other edge, or a shared point. */
function segmentsMeet(a: LatLng, b: LatLng, c: LatLng, d: LatLng) {
  if (segmentsCross(a, b, c, d)) return true;
  return (
    (orient(a, b, c) === 0 && within(a, b, c)) ||
    (orient(a, b, d) === 0 && within(a, b, d)) ||
    (orient(c, d, a) === 0 && within(c, d, a)) ||
    (orient(c, d, b) === 0 && within(c, d, b))
  );
}

/** Edges a–b then b–c fold back over each other (a spike): c heads back towards a. */
function foldsBack(a: LatLng, b: LatLng, c: LatLng) {
  const dot = (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]);
  return orient(a, b, c) === 0 && dot > 0;
}

function ring(points: LatLng[]) {
  const closed =
    points.length > 1 &&
    points[0][0] === points[points.length - 1][0] &&
    points[0][1] === points[points.length - 1][1];
  return closed ? points.slice(0, -1) : points;
}

export function selfIntersects(input: LatLng[]) {
  return crossingEdges(input, 1).length > 0;
}

/**
 * Edges (edge i joins corner i to the next, the last closing back to the first) that cross or
 * touch another edge, in order, stopping once `limit` such pairs are found. Like the server's
 * check (Shapely's validity), a corner on another edge, two corners in the same place and a
 * spike (an edge doubling back over the previous one) all count; repeated corners in a row
 * don't.
 */
export function crossingEdges(input: LatLng[], limit = Infinity): number[] {
  const all = ring(input);
  // Repeated corners in a row make zero-length edges: drop them, remembering each kept
  // corner's original index (the last of a run, whose edge leads on to the next corner).
  const pts: LatLng[] = [];
  const index: number[] = [];
  all.forEach((p, i) => {
    const next = all[(i + 1) % all.length];
    if (all.length > 1 && p[0] === next[0] && p[1] === next[1]) return;
    pts.push(p);
    index.push(i);
  });
  const n = pts.length;
  const edges = new Set<number>();
  let pairs = 0;
  const flag = (i: number, j: number) => {
    edges.add(index[i]);
    edges.add(index[j]);
    pairs += 1;
  };
  if (n < 3) return [];
  for (let i = 0; i < n && pairs < limit; i++) {
    // Neighbouring edges share a corner; they only clash if the second folds back.
    if (foldsBack(pts[i], pts[(i + 1) % n], pts[(i + 2) % n]))
      flag(i, (i + 1) % n);
    for (let j = i + 2; j < n && pairs < limit; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
        flag(i, j);
    }
  }
  return [...edges].sort((a, b) => a - b);
}

/** Great-circle length of the closed outline, in kilometres. */
export function perimeterKm(points: LatLng[]) {
  const pts = ring(points);
  if (pts.length < 2) return 0;
  const edges = pts.length === 2 ? 1 : pts.length;
  let total = 0;
  for (let i = 0; i < edges; i++) {
    const [lat1, lon1] = pts[i];
    const [lat2, lon2] = pts[(i + 1) % pts.length];
    const a =
      Math.sin(rad(lat2 - lat1) / 2) ** 2 +
      Math.cos(rad(lat1)) *
        Math.cos(rad(lat2)) *
        Math.sin(rad(lon2 - lon1) / 2) ** 2;
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total / 1000;
}

function contains(poly: LatLng[], p: LatLng) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (
      yi > p[0] !== yj > p[0] &&
      p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

export function overlaps(aIn: LatLng[], bIn: LatLng[]) {
  const a = ring(aIn);
  const b = ring(bIn);
  if (a.some((p) => contains(b, p)) || b.some((p) => contains(a, p)))
    return true;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (
        segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
      )
        return true;
  return false;
}

/** Mirrors the backend's problem codes (`app/tools/geometry.py`), plus too few corners. */
export type PolygonProblemCode =
  | "too_few"
  | "too_complex"
  | "self_intersection"
  | "too_small"
  | "too_large"
  | "overlap";

export type PolygonCheck =
  | { ok: true; areaHa: number }
  | { ok: false; areaHa: number; message: string; code: PolygonProblemCode };

export function checkPolygon(
  points: LatLng[],
  others: { name: string; polygon: LatLng[] }[],
): PolygonCheck {
  const area = areaHa(ring(points));
  if (ring(points).length < 3)
    return {
      ok: false,
      areaHa: area,
      code: "too_few",
      message: "Add at least three corners to close the boundary.",
    };
  if (selfIntersects(points))
    return {
      ok: false,
      areaHa: area,
      code: "self_intersection",
      message:
        "The boundary crosses itself. Move a corner so the edges don't cross or touch.",
    };
  if (area < 10)
    return {
      ok: false,
      areaHa: area,
      code: "too_small",
      message: `This area is ${area.toFixed(1)} ha. Sites need at least 10 ha.`,
    };
  if (area > 50_000)
    return {
      ok: false,
      areaHa: area,
      code: "too_large",
      message: `This area is ${Math.round(area).toLocaleString("en-US")} ha. Sites can be at most 50,000 ha.`,
    };
  const clash = others.find((o) => overlaps(points, o.polygon));
  if (clash)
    return {
      ok: false,
      areaHa: area,
      code: "overlap",
      message: `This boundary overlaps the ${clash.name} site. Adjust the edge to continue.`,
    };
  return { ok: true, areaHa: area };
}

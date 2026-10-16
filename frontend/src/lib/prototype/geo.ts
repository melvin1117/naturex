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

function ring(points: LatLng[]) {
  const closed =
    points.length > 1 &&
    points[0][0] === points[points.length - 1][0] &&
    points[0][1] === points[points.length - 1][1];
  return closed ? points.slice(0, -1) : points;
}

export function selfIntersects(input: LatLng[]) {
  const pts = ring(input);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
        return true;
    }
  }
  return false;
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

export type PolygonCheck =
  { ok: true; areaHa: number } | { ok: false; areaHa: number; message: string };

export function checkPolygon(
  points: LatLng[],
  others: { name: string; polygon: LatLng[] }[],
): PolygonCheck {
  const area = areaHa(ring(points));
  if (ring(points).length < 3)
    return {
      ok: false,
      areaHa: area,
      message: "Add at least three corners to close the boundary.",
    };
  if (selfIntersects(points))
    return {
      ok: false,
      areaHa: area,
      message:
        "The boundary crosses itself. Move a corner so the edges don't cross.",
    };
  if (area < 10)
    return {
      ok: false,
      areaHa: area,
      message: `This area is ${area.toFixed(1)} ha. Sites need at least 10 ha.`,
    };
  if (area > 50_000)
    return {
      ok: false,
      areaHa: area,
      message: `This area is ${Math.round(area).toLocaleString("en-US")} ha. Sites can be at most 50,000 ha.`,
    };
  const clash = others.find((o) => overlaps(points, o.polygon));
  if (clash)
    return {
      ok: false,
      areaHa: area,
      message: `This boundary overlaps the ${clash.name} site. Adjust the edge to continue.`,
    };
  return { ok: true, areaHa: area };
}

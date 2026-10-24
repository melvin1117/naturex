/**
 * The WildWorth mark's geometry, from `wwInner()` in docs/design/wildworth-brand-guidelines.html.
 * Two Ws drawn as one line; the last stroke rises to the land's Health score. A 100-unit square:
 * the reading's end travels from y 80 (score 0) to y 16 (score 100).
 */

/** The master logo's reading: the hero site's target score. */
export const MASTER_SCORE = 77.6;

/** Below this size (px) the mark is the single W: one W, the same reading, no dot. */
export const SINGLE_W_BELOW_PX = 24;

type Point = readonly [number, number];

const DOUBLE_W: readonly Point[] = [
  [6, 24],
  [17, 76],
  [28, 42],
  [39, 76],
  [50, 24],
  [61, 76],
  [72, 42],
  [83, 76],
];
const SINGLE_W: readonly Point[] = [
  [10, 24],
  [30, 78],
  [50, 40],
  [70, 78],
];

export function clampScore(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

/** The y of the reading's end for a Health score (clamped to 0–100). */
export function peakY(score: number): number {
  return 80 - (clampScore(score) / 100) * 64;
}

export interface MarkGeometry {
  /** The Ws, drawn as one line. */
  line: string;
  /** The reading: the last stroke, from the line's end to the score. */
  reading: string;
  /** Today's reading, where the line stops (the double W only). */
  dot: { cx: number; cy: number; r: number } | null;
  strokeWidth: number;
}

export function markGeometry(score: number, single = false): MarkGeometry {
  const points = single ? SINGLE_W : DOUBLE_W;
  const last = points[points.length - 1]!;
  const end: Point = [single ? 90 : 94, Number(peakY(score).toFixed(2))];
  return {
    line: `M${points.map(([x, y]) => `${x} ${y}`).join(" L")}`,
    reading: `M${last[0]} ${last[1]} L${end[0]} ${end[1]}`,
    dot: single ? null : { cx: end[0], cy: end[1], r: 6 },
    strokeWidth: single ? 11 : 7.5,
  };
}

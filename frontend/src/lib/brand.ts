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

/** The Proof of Life seal's dots rise once, then the grade is stamped (DESIGN.md, Motion). */
export const SEAL_RISE_MS = 550;

/**
 * The Proof of Life seal, from `sealInner()` in the guidelines (chapter 5): one ring of 100 dots
 * in a 100-unit square, one per point of health, lit up to the score, with "PROOF OF LIFE", the
 * grade and the quarter in the centre. It is deliberately not the live dial's five rings: the
 * dial is the live reading, the seal the verdict issued each quarter.
 */
export const SEAL = {
  dots: 100,
  center: 50,
  radius: 42,
  dot: 1.9,
  unlitOpacity: 0.2,
  title: {
    text: "PROOF OF LIFE",
    y: 35,
    size: 5.6,
    tracking: 0.9,
    opacity: 0.75,
  },
  grade: { y: 59, size: 24, longSize: 20 },
  quarter: { y: 72, size: 6.4, tracking: 0.5, opacity: 0.85 },
} as const;

export interface SealDot {
  cx: number;
  cy: number;
  lit: boolean;
}

/** The seal's 100 dots, clockwise from 12 o'clock; the first round(score) are lit. */
export function sealDots(score: number): SealDot[] {
  const lit = Math.round(clampScore(score));
  return Array.from({ length: SEAL.dots }, (_, i) => {
    const angle = (i / SEAL.dots) * 2 * Math.PI - Math.PI / 2;
    return {
      cx: Number((SEAL.center + SEAL.radius * Math.cos(angle)).toFixed(2)),
      cy: Number((SEAL.center + SEAL.radius * Math.sin(angle)).toFixed(2)),
      lit: i < lit,
    };
  });
}

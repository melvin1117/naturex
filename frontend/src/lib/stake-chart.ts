/**
 * A stake's unit price drawn small, beside what its holder paid: the line, the area under it
 * and where the price paid sits, in a `width × height` box. Pure geometry for `<StakeChart>`.
 */

export type StakeChartGeometry = {
  /** The price line, oldest to newest. */
  line: string;
  /** The line closed down to the bottom edge, for its fill. */
  area: string;
  /** The latest price's point. */
  last: { x: number; y: number };
  /** Where the average price paid crosses the box, if known. */
  paidY: number | null;
};

const round = (n: number) => Math.round(n * 10) / 10;

/** Null with fewer than two prices: one price isn't a line. */
export function stakeChart(
  prices: number[],
  paid: number | null,
  { width, height, pad = 3 }: { width: number; height: number; pad?: number },
): StakeChartGeometry | null {
  // The API sends a card's latest 30 prices at most, so every one is drawn.
  const values = prices;
  if (values.length < 2) return null;
  let min = Math.min(...values, ...(paid === null ? [] : [paid]));
  let max = Math.max(...values, ...(paid === null ? [] : [paid]));
  if (max === min) {
    // A flat price: centre it rather than divide by zero.
    const nudge = Math.abs(max) * 0.01 || 1;
    min -= nudge;
    max += nudge;
  }
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => pad + ((max - v) * (height - 2 * pad)) / (max - min);
  const points = values.map((v, i) => [round(x(i)), round(y(v))] as const);
  const line = points
    .map(([px, py], i) => `${i ? "L" : "M"}${px} ${py}`)
    .join("");
  const [lastX, lastY] = points[points.length - 1]!;
  const [firstX] = points[0]!;
  return {
    line,
    area: `${line}L${lastX} ${height}L${firstX} ${height}Z`,
    last: { x: lastX, y: lastY },
    paidY: paid === null ? null : round(y(paid)),
  };
}

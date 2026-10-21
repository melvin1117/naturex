/**
 * The Report tab's "What changed" table, from `GET /reports/{id}/diff/{prev}` (T37, #189).
 *
 * Pure display helpers: the API sends every number as a Decimal string with its unit; here we
 * only group the rows and format them like the rest of the report. No number is computed except
 * the scaling of 0-1 shares to percentages for display.
 */
import type { MetricChange } from "@/lib/api/types";
import { money } from "@/lib/prototype/format";

export type MetricGroup = MetricChange["group"];

export const GROUP_LABEL: Record<MetricGroup, string> = {
  headline: "Headline",
  health: "How the score is built",
  confidence: "Confidence parts",
  satellite: "Satellite data",
  valuation: "Value and carbon",
};

const GROUP_ORDER: MetricGroup[] = [
  "headline",
  "health",
  "confidence",
  "satellite",
  "valuation",
];

export interface MetricGroupRows {
  group: MetricGroup;
  label: string;
  rows: MetricChange[];
}

/** Non-empty groups in a fixed order; rows keep the API's order inside a group. */
export function groupMetrics(metrics: MetricChange[]): MetricGroupRows[] {
  return GROUP_ORDER.flatMap((group) => {
    const rows = metrics.filter((m) => m.group === group);
    return rows.length ? [{ group, label: GROUP_LABEL[group], rows }] : [];
  });
}

const MINUS = "−";

function nf(value: number, max: number, min = 0): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(Math.abs(value));
}

function sign(value: number): string {
  return value > 0 ? "+" : value < 0 ? MINUS : "±";
}

/** A value's own sign: "−" when negative, "+" too when `showPlus`, never "±". */
function valueSign(value: number, showPlus = false): string {
  return value < 0 ? MINUS : showPlus && value > 0 ? "+" : "";
}

/**
 * A signed change with `max` decimals. A non-zero change too small to show reads as the
 * smallest step ("+<0.1 pts"), never as "+0".
 */
function signedDelta(
  d: number,
  max: number,
  min: number,
  render: (abs: string) => string,
): string {
  const step = 10 ** -max;
  if (d !== 0 && Math.abs(d) < step / 2)
    return `${sign(d)}<${render(nf(step, max, max))}`;
  return `${sign(d)}${render(nf(d, max, min))}`;
}

interface UnitFormat {
  value: (v: number) => string;
  delta: (d: number) => string;
}

function plain(
  max: number,
  min = 0,
  suffix = "",
  deltaSuffix = suffix,
): UnitFormat {
  return {
    value: (v) => `${valueSign(v)}${nf(v, max, min)}${suffix}`,
    delta: (d) => signedDelta(d, max, min, (abs) => `${abs}${deltaSuffix}`),
  };
}

/** A 0-1 share shown on a 0-100 scale; its change in points. */
function scaled(suffix: string): UnitFormat {
  const f = plain(1, 0, suffix, " pts");
  return { value: (v) => f.value(v * 100), delta: (d) => f.delta(d * 100) };
}

/**
 * The delta has the values' precision: to the cent while both values are below $100K (where
 * `money` stops compacting), compact ("−$98K") once either value is.
 */
function moneyFormat(metric: MetricChange): UnitFormat {
  const compact = [metric.old, metric.new].some(
    (v) => Math.abs(toNumber(v) ?? 0) >= 100_000,
  );
  return {
    value: (v) => money(v),
    delta: (d) => {
      const abs = Math.abs(d);
      if (abs > 0 && abs < 0.005) return `${sign(d)}<$0.01`;
      return `${sign(d)}${money(abs, compact ? { compact } : {})}`;
    },
  };
}

const SCORE = " / 100";

function isWhole(value: string | null): boolean {
  const n = toNumber(value);
  return n === null || Number.isInteger(n);
}

function unitFormat(metric: MetricChange): UnitFormat {
  switch (metric.unit) {
    case "/100":
      return plain(1, 1, SCORE, " pts");
    case "%": {
      // Whole percentages, unless the change itself has a decimal (70.0% → 74.5%).
      const digits = isWhole(metric.delta) ? 0 : 1;
      return {
        value: plain(digits, digits, "%").value,
        delta: plain(1, 0, "", " pts").delta,
      };
    }
    case "Int$":
    case "Int$/yr":
      return moneyFormat(metric);
    case "points":
      return {
        value: (v) => `${valueSign(v, true)}${nf(v, 1, 1)}`,
        delta: plain(1, 1, "", " pts").delta,
      };
    case "0-1":
      // The score and confidence panels' scales: "82 / 100" and "82%".
      return scaled(metric.group === "confidence" ? "%" : SCORE);
    case "share":
      return scaled("%");
    case "ha":
      return plain(1, 0, " ha");
    case "NDVI/yr":
      return {
        value: (v) => `${valueSign(v, true)}${nf(v, 4, 4)}`,
        delta: plain(4, 4).delta,
      };
    case "-100 to 100":
      return plain(1);
    case "t/ha":
    case "t C/ha":
      return plain(1, 0, ` ${metric.unit}`);
    case "tCO2":
      return plain(0, 0, " tCO₂");
    case "tCO2/yr":
      return plain(0, 0, " tCO₂/yr");
    case null:
      return plain(3);
    default:
      return plain(3, 0, ` ${metric.unit}`);
  }
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A stored value as the report shows it; "—" when absent from that version. */
export function formatMetricValue(
  metric: MetricChange,
  value: string | null,
): string {
  const n = toNumber(value);
  return n === null ? "—" : unitFormat(metric).value(n);
}

/** The signed change (`new − old`), or how the metric appeared or went away. */
export function formatMetricDelta(metric: MetricChange): string {
  if (metric.change === "added") return "New";
  if (metric.change === "removed") return "Removed";
  const d = toNumber(metric.delta);
  return d === null ? "—" : unitFormat(metric).delta(d);
}

/** Which way the number moved; null when it appeared, went away or didn't move. */
export function metricDirection(metric: MetricChange): "up" | "down" | null {
  const d = metric.change === "changed" ? toNumber(metric.delta) : null;
  if (d === null || d === 0) return null;
  return d > 0 ? "up" : "down";
}

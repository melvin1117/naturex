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

function unsigned(value: number, max: number, min = 0): string {
  return `${value < 0 ? MINUS : ""}${nf(value, max, min)}`;
}

interface UnitFormat {
  value: (v: number) => string;
  delta: (d: number) => string;
}

function plain(max: number, min = 0, suffix = ""): UnitFormat {
  return {
    value: (v) => `${unsigned(v, max, min)}${suffix}`,
    delta: (d) => `${sign(d)}${nf(d, max, min)}${suffix}`,
  };
}

/** A 0-1 share shown as a percentage; its change in percentage points. */
function share(suffix: string): UnitFormat {
  return {
    value: (v) => `${unsigned(v * 100, 1)}${suffix}`,
    delta: (d) => `${sign(d)}${nf(d * 100, 1)} pts`,
  };
}

const MONEY: UnitFormat = {
  value: (v) => money(v),
  // Compact like the value; whole dollars below $1K drop the ".00".
  delta: (d) => {
    const abs = Math.abs(d);
    const text =
      abs < 1000 && Number.isInteger(abs)
        ? `$${nf(abs, 0)}`
        : money(abs, { compact: true });
    return `${sign(d)}${text}`;
  },
};

function unitFormat(metric: MetricChange): UnitFormat {
  switch (metric.unit) {
    case "/100":
      return plain(1, 1);
    case "%":
      return {
        value: (v) => `${unsigned(v, 0)}%`,
        delta: (d) => `${sign(d)}${nf(d, 1)} pts`,
      };
    case "Int$":
    case "Int$/yr":
      return MONEY;
    case "points":
      return {
        value: (v) => `${sign(v)}${nf(v, 1, 1)}`,
        delta: (d) => `${sign(d)}${nf(d, 1, 1)} pts`,
      };
    case "0-1":
      // Same scale as the score and confidence panels: "82 / 100" and "82%".
      return metric.group === "confidence" ? share("%") : share(" / 100");
    case "share":
      return share("%");
    case "ha":
      return plain(1, 0, " ha");
    case "NDVI/yr":
      return {
        value: (v) => `${sign(v)}${nf(v, 4, 4)}`,
        delta: (d) => `${sign(d)}${nf(d, 4, 4)}`,
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

import type { Grade } from "./site-data";

export function money(value: number, opts: { compact?: boolean } = {}) {
  const compact = opts.compact ?? Math.abs(value) >= 100_000;
  if (compact) {
    const abs = Math.abs(value);
    const sign = value < 0 ? "−" : "";
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`;
  }
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function price(value: number) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function int(value: number) {
  return Math.round(value).toLocaleString("en-US");
}

export function ha(value: number) {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: value < 100 ? 1 : 0 })} ha`;
}

/** A change's size as a percentage: "2.9%", "0.03%" below 1%, "<0.01%" below that, so a real
 * change is never shown as "0.0%". */
export function changePct(value: number): string {
  const n = Math.abs(value);
  if (n >= 1) return `${n.toFixed(1)}%`;
  if (n >= 0.01) return `${n.toFixed(2)}%`;
  return "<0.01%";
}

/** Tonnes of CO₂ with grouping: "1,234.5 tCO₂", "<0.1 tCO₂" for a real but tiny amount. */
export function tonnesCo2(value: number): string {
  if (value > 0 && value < 0.05) return "<0.1 tCO₂";
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} tCO₂`;
}

export function pct(value: number, digits = 0) {
  return `${value.toFixed(digits)}%`;
}

export function signedPct(value: number, digits = 1) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function signed(value: number, digits = 1) {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

export function date(iso: string) {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function shortDate(iso: string) {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function quarterLabel(period: string) {
  const [year, q] = period.split("Q");
  return `Q${q} ${year}`;
}

/** A report's quarter: its rating period, else the quarter it was issued in (UTC). */
export function reportQuarter(period: string | null, issuedAt: string) {
  if (period) return quarterLabel(period);
  const issued = new Date(issuedAt);
  return `Q${Math.floor(issued.getUTCMonth() / 3) + 1} ${issued.getUTCFullYear()}`;
}

export const GRADE_ORDER: Grade[] = [
  "AAA",
  "AA",
  "A",
  "BBB",
  "BB",
  "B",
  "C",
  "D",
];

export const GRADE_LABEL: Record<Grade, string> = {
  AAA: "Exceptional health",
  AA: "Very strong health",
  A: "Strong health",
  BBB: "Good health",
  BB: "Moderate health, some pressure",
  B: "Under pressure",
  C: "Serious pressure",
  D: "Critical",
};

export function valueRange(low: number, mid: number, high: number) {
  return `${money(low)}–${money(high)} /yr · mid ${money(mid)}`;
}

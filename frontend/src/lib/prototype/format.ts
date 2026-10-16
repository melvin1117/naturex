import type { Grade } from "./data";

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

export function gradeFor(health: number): Grade {
  if (health >= 90) return "AAA";
  if (health >= 80) return "AA";
  if (health >= 70) return "A";
  if (health >= 60) return "BBB";
  if (health >= 50) return "BB";
  if (health >= 40) return "B";
  if (health >= 30) return "C";
  return "D";
}

/** Positive when `a` is a better grade than `b`. */
export function compareGrades(a: Grade, b: Grade) {
  return GRADE_ORDER.indexOf(b) - GRADE_ORDER.indexOf(a);
}

export function valueRange(low: number, mid: number, high: number) {
  return `${money(low)}–${money(high)} /yr · mid ${money(mid)}`;
}

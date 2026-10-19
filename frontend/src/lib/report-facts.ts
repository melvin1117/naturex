/**
 * The facts a report card shows, as plain numbers. `reportFacts()` reads them from the API's
 * `ReportOut` (its stored columns and deterministic `rating` snapshot); the prototype builds the
 * same shape from its scripted world. Nothing here computes a metric: every number is copied
 * from the report, and a missing one stays `null` so the screen can say so.
 */
import type { ReportOut } from "./api/types";
import {
  SCORE_COMPONENTS,
  type Grade,
  type LandcoverKey,
  type ServiceKey,
} from "./prototype/data";
import { GRADE_ORDER } from "./prototype/format";

export type TrendLabel = "Improving" | "Stable" | "Declining";
export type SummarySource = ReportOut["summary_source"] | "scripted";

export type WeightedPart = {
  key: string;
  label: string;
  /** Share of the total, 0–1. */
  weight: number;
  /** Component score, 0–1. */
  value: number;
};

export type ReportFacts = {
  id: string;
  version: number;
  period: string | null;
  createdAt: string;
  simulated: boolean;
  health: number;
  grade: Grade;
  confidence: number;
  valueLow: number | null;
  valueMid: number | null;
  valueHigh: number | null;
  fairValuePerUnit: number | null;
  baseHealth: number | null;
  /** The Auditor's bounded adjustment; null when the report doesn't record one. */
  adjustment: number | null;
  adjustmentReason: string | null;
  /** Shown next to the adjustment, e.g. that the prototype's Auditor is scripted. */
  adjustmentNote: string | null;
  components: WeightedPart[];
  confidenceParts: WeightedPart[];
  services: Partial<Record<ServiceKey, number>>;
  carbonStock: number | null;
  landcover: Partial<Record<LandcoverKey, number>>;
  /** Monthly NDVI, oldest first: [YYYY-MM, value]. */
  ndvi: [string, number][];
  ndviTrend: number | null;
  ndviP: number | null;
  trendLabel: TrendLabel | null;
  waterChange: number | null;
  builtShare: number | null;
  flags: { code: string; detail: string }[];
  citations: string[];
  citationsNote: string | null;
  summary: string;
  summarySource: SummarySource;
  recommendations: string[];
  attributions: string[];
};

/** A decimal string or number from the API as a number; null when absent or not numeric. */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asGrade(value: unknown): Grade | null {
  return typeof value === "string" && (GRADE_ORDER as string[]).includes(value)
    ? (value as Grade)
    : null;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function numbers(record: Json): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const n = num(value);
    if (n !== null) out[key] = n;
  }
  return out;
}

/**
 * The NDVI trend label from the report's own statistics: a direction only when the
 * Mann–Kendall test is significant at 5%, otherwise "Stable".
 */
export function ndviTrendLabel(
  slope: number | null,
  significant: boolean | null,
): TrendLabel | null {
  if (slope === null || significant === null) return null;
  if (!significant || slope === 0) return "Stable";
  return slope > 0 ? "Improving" : "Declining";
}

const CONFIDENCE_LABELS: Record<string, string> = {
  coverage: "Coverage",
  agreement: "Agreement",
  evidence: "Evidence",
  recency: "Recency",
};
const CONFIDENCE_ORDER = ["coverage", "agreement", "evidence", "recency"];

function weighted(
  values: Record<string, number>,
  weights: Record<string, number>,
  order: string[],
  label: (key: string) => string,
): WeightedPart[] {
  const keys = [
    ...order.filter((k) => k in values),
    ...Object.keys(values).filter((k) => !order.includes(k)),
  ];
  return keys
    .filter((k) => weights[k] !== undefined)
    .map((key) => ({
      key,
      label: label(key),
      weight: weights[key]!,
      value: values[key]!,
    }));
}

function flagList(value: unknown): { code: string; detail: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const flag = obj(item);
    const code = typeof flag.type === "string" ? flag.type : null;
    const detail = typeof flag.detail === "string" ? flag.detail : code;
    return code && detail ? [{ code, detail }] : [];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** The report card's facts, or null for a report with no grade or health yet. */
export function reportFacts(report: ReportOut): ReportFacts | null {
  const grade = asGrade(report.grade);
  const health = num(report.health_score);
  const confidence = num(report.confidence);
  if (!grade || health === null || confidence === null) return null;

  const rating = obj(report.rating);
  const score = obj(rating.score);
  const metrics = obj(rating.metrics);
  const valuation = obj(rating.valuation);
  const trendDetails = obj(metrics.ndvi_trend_details);
  const scoreLabels = new Map(SCORE_COMPONENTS.map((c) => [c.key, c.label]));
  const landcover = numbers(obj(metrics.landcover));
  const significant = trendDetails.significant_05;
  const ndviTrend = num(metrics.ndvi_trend);

  return {
    id: report.id,
    version: report.version,
    period: report.period ?? null,
    createdAt: report.created_at,
    simulated: report.simulated ?? false,
    health,
    grade,
    confidence,
    valueLow: num(report.value_low),
    valueMid: num(report.value_mid),
    valueHigh: num(report.value_high),
    fairValuePerUnit: num(report.fair_value_per_share),
    baseHealth: num(score.base_health),
    adjustment: num(score.auditor_adjustment),
    adjustmentReason:
      typeof score.adjustment_reason === "string" && score.adjustment_reason
        ? score.adjustment_reason
        : null,
    adjustmentNote: null,
    components: weighted(
      numbers(obj(score.components)),
      numbers(obj(score.weights)),
      SCORE_COMPONENTS.map((c) => c.key),
      (k) => scoreLabels.get(k) ?? k.replaceAll("_", " "),
    ),
    confidenceParts: weighted(
      numbers(obj(score.confidence_components)),
      numbers(obj(score.confidence_weights)),
      CONFIDENCE_ORDER,
      (k) => CONFIDENCE_LABELS[k] ?? k,
    ),
    services: numbers(obj(report.value_breakdown)),
    carbonStock: num(obj(valuation.carbon).total_stock_tco2),
    landcover,
    ndvi: (report.ndvi_series ?? []).map((p) => [p.month, p.ndvi]),
    ndviTrend,
    ndviP: num(trendDetails.mann_kendall_p_value),
    trendLabel: ndviTrendLabel(
      ndviTrend,
      typeof significant === "boolean" ? significant : null,
    ),
    waterChange: num(metrics.water_change),
    builtShare: landcover.built ?? null,
    flags: flagList(report.flags),
    citations: report.auditor?.citations ?? [],
    citationsNote: null,
    summary: report.summary_md ?? "",
    summarySource: report.summary_source ?? "fallback",
    recommendations: report.recommendations ?? [],
    attributions: strings(metrics.attributions),
  };
}

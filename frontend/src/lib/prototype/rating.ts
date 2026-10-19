/**
 * Builds report versions from the deterministic ratings in `sites.json`, plus the Auditor's
 * bounded overlay (agreement, field evidence, ±10 adjustment) using the dev-spec §7.4 and §8
 * formulas, so every number on screen is traceable to a formula.
 */
import { ndviTrendLabel, type ReportFacts } from "../report-facts";
import {
  SCORE_COMPONENTS,
  siteDataFor,
  type Grade,
  type LandcoverKey,
  type ScenarioKey,
  type ServiceKey,
} from "./data";
import { gradeFor, GRADE_LABEL, money } from "./format";

export const TOTAL_UNITS = 1_000_000;

export type Report = {
  version: number;
  period: string;
  scenario: ScenarioKey;
  createdAt: string;
  runId: string;
  baseHealth: number;
  adjustment: number;
  adjustmentReason: string;
  /** True when the Auditor overlay is the scripted prototype one. */
  scriptedAuditor: boolean;
  health: number;
  grade: Grade;
  confidence: number;
  confidenceComponents: Record<
    "coverage" | "agreement" | "evidence" | "recency",
    number
  >;
  components: Record<string, number>;
  valueLow: number;
  valueMid: number;
  valueHigh: number;
  services: Record<ServiceKey, number>;
  carbon: { stock: number; seq: number };
  landcover: Record<LandcoverKey, number>;
  ndvi: [string, number][];
  ndviTrend: number;
  ndviP: number;
  waterChange: number;
  biomass: number;
  forestLoss12mHa: number;
  fairValuePerUnit: number;
  gatePassed: boolean;
  flags: { code: string; detail: string }[];
  citations: string[];
  summary: string;
  recommendations: string[];
};

export type AuditorOverlay = {
  agreement: number;
  evidence: boolean;
  adjustment: number;
  reason: string;
  citations: string[];
};

export function confidenceFrom(c: {
  coverage: number;
  agreement: number;
  evidence: number;
  recency: number;
}) {
  return (
    Math.round(
      1000 *
        (0.4 * c.coverage +
          0.3 * c.agreement +
          0.2 * c.evidence +
          0.1 * c.recency),
    ) / 10
  );
}

/** dev-spec §8: value_mid × 10 × (0.5 + 0.5·health/100) × (0.7 + 0.3·confidence/100) / units. */
export function fairValuePerUnit(
  valueMid: number,
  health: number,
  confidence: number,
  totalUnits = TOTAL_UNITS,
) {
  const total =
    valueMid *
    10 *
    (0.5 + (0.5 * health) / 100) *
    (0.7 + (0.3 * confidence) / 100);
  return Math.round((total / totalUnits) * 10000) / 10000;
}

const FLAG_TEXT: Record<string, string> = {
  auditor_pending:
    "No Auditor review yet: satellite and news agreement defaults to 0.5.",
  simulated: "Time Machine version: scripted scenario deltas, not new imagery.",
  scripted_auditor:
    "Auditor review is scripted in this prototype (agreement, adjustment and reason). Nemotron 3 Ultra runs it in the full build.",
  custom_boundary:
    "Drawn boundary: values use the demo site's cached land-cover shares, scaled to the drawn area (prototype).",
};

function flagDetail(code: string) {
  if (code.startsWith("low_bound_fallback"))
    return "Low bound uses a fallback median/mean ratio for one biome.";
  if (code.startsWith("unverified_coefficient"))
    return "A valuation coefficient is not yet verified against its source.";
  return FLAG_TEXT[code] ?? code.replaceAll("_", " ");
}

/** dev-spec §7.4 weights. */
const WEIGHTS: Record<string, number> = {
  vegetation_vigor: 0.3,
  natural_cover: 0.25,
  habitat_loss: 0.2,
  water_stability: 0.15,
  threat_pressure: 0.1,
};

export type ThreatEvent = { direction: number; severity: number };

/** T = 1 − clamp(Σ severity of negative events / 15, 0, 1) (dev-spec §7.4). */
export function threatPressure(events: ThreatEvent[]) {
  const total = events
    .filter((e) => e.direction === -1)
    .reduce((sum, e) => sum + e.severity, 0);
  return 1 - Math.min(1, Math.max(0, total / 15));
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

export function buildReport(args: {
  siteKey: string;
  siteName: string;
  scenario: ScenarioKey;
  period: string;
  version: number;
  createdAt: string;
  runId: string;
  overlay?: AuditorOverlay;
  /** News and evidence events known at rating time; negative ones lower threat pressure. */
  events?: ThreatEvent[];
  /** A drawn boundary's area; values scale with area (benefit transfer is per hectare). */
  areaHa?: number;
}): Report {
  const site = siteDataFor(args.siteKey);
  const s = site.scenarios[args.scenario];
  const overlay = args.overlay;
  const events = args.events ?? [];
  const threat = threatPressure(events);
  const components: Record<string, number> = {
    ...s.components,
    threat_pressure: threat,
  };
  // With no negative events this is the backend's own health; otherwise recompute from the
  // components (the spec's worked example: severity-4 news takes the hero from 76.2 to 73.6).
  const baseHealth =
    threat === 1
      ? s.health
      : round1(
          100 *
            Object.entries(WEIGHTS).reduce(
              (sum, [k, w]) => sum + w * (components[k] ?? 0),
              0,
            ),
        );
  const areaHa = args.areaHa ?? site.areaHa;
  const scale = areaHa / site.areaHa;
  const scaled = (v: number) => Math.round(v * scale);
  const services = Object.fromEntries(
    Object.entries(s.services).map(([k, v]) => [k, scaled(v)]),
  ) as Record<ServiceKey, number>;
  const valueLow = scaled(s.valueLow);
  const valueMid = scaled(s.valueMid);
  const valueHigh = scaled(s.valueHigh);
  const carbon = { stock: scaled(s.carbon.stock), seq: scaled(s.carbon.seq) };

  const confidenceComponents = {
    ...s.confidenceComponents,
    agreement: overlay?.agreement ?? s.confidenceComponents.agreement,
    evidence: overlay?.evidence ? 1 : s.confidenceComponents.evidence,
  };
  const confidence = confidenceFrom(confidenceComponents);
  const adjustment = Math.max(-10, Math.min(10, overlay?.adjustment ?? 0));
  const health = round1(baseHealth + adjustment);
  const grade = gradeFor(health);
  const flags = s.flags
    .filter((code) => !(overlay && code === "auditor_pending"))
    .map((code) => ({ code, detail: flagDetail(code) }));
  if (overlay)
    flags.push({
      code: "scripted_auditor",
      detail: flagDetail("scripted_auditor"),
    });
  if (args.scenario !== "baseline")
    flags.push({ code: "simulated", detail: flagDetail("simulated") });
  if (Math.abs(scale - 1) > 0.001)
    flags.push({
      code: "custom_boundary",
      detail: flagDetail("custom_boundary"),
    });

  const fair = fairValuePerUnit(valueMid, health, confidence);
  // Same rule as the trend badge (and the API's reports): a direction only when p < 0.05.
  const trend = (
    ndviTrendLabel(s.ndviTrend, s.ndviP < 0.05) ?? "Stable"
  ).toLowerCase();
  const negative = events.filter((e) => e.direction === -1);

  const summary = [
    `${args.siteName} rates **${grade}** (${GRADE_LABEL[grade].toLowerCase()}), health ${health.toFixed(1)} out of 100, with ${confidence.toFixed(0)}% confidence.`,
    `Ecosystem services are estimated at **${money(valueLow)}–${money(valueHigh)} a year** (mid ${money(valueMid)}) across ${areaHa.toFixed(0)} ha. Stored carbon is about ${carbon.stock.toLocaleString("en-US")} tCO₂, shown separately and not added to the dollar value.`,
    `Vegetation is ${trend} over five years (Sen's slope ${s.ndviTrend >= 0 ? "+" : ""}${s.ndviTrend.toFixed(4)} NDVI a year). ${Math.round(s.naturalFraction * 100)}% of the area is natural cover.`,
    negative.length
      ? `${negative.length} negative news ${negative.length === 1 ? "event lowers" : "events lower"} threat pressure to ${Math.round(threat * 100)} out of 100.`
      : "",
    overlay
      ? `Auditor (scripted in this prototype): ${overlay.reason}${adjustment !== 0 ? ` Health adjusted ${adjustment > 0 ? "+" : "−"}${Math.abs(adjustment).toFixed(1)}.` : ""}`
      : "Deterministic rating from cached satellite metrics; Auditor review pending.",
    s.description ? `Scenario: ${s.description}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    version: args.version,
    period: args.period,
    scenario: args.scenario,
    createdAt: args.createdAt,
    runId: args.runId,
    baseHealth,
    adjustment,
    adjustmentReason: overlay?.reason ?? "",
    scriptedAuditor: Boolean(overlay),
    health,
    grade,
    confidence,
    confidenceComponents,
    components,
    valueLow,
    valueMid,
    valueHigh,
    services,
    carbon,
    landcover: s.landcover,
    ndvi: s.ndvi,
    ndviTrend: s.ndviTrend,
    ndviP: s.ndviP,
    waterChange: s.waterChange,
    biomass: s.biomass,
    forestLoss12mHa: s.forestLoss12mHa,
    fairValuePerUnit: fair,
    // Listing gate (dev-spec §7.4): confidence ≥ 70, grade ≥ C, forest loss under 1% of area.
    gatePassed: s.gatePassed && confidence >= 70 && grade !== "D",
    flags,
    citations: overlay?.citations ?? [],
    summary,
    recommendations: recommendationsFor(args.siteKey, args.scenario),
  };
}

const RECOMMENDATIONS: Record<string, Record<ScenarioKey, string[]>> = {
  wetland_mx: {
    baseline: [
      "Clear silt from the two blocked canals on the eastern side before the dry season.",
      "Replant native ahuejote willows along chinampa edges to hold the banks.",
      "Upload geotagged photos of restored plots to raise confidence.",
    ],
    restoration: [
      "Keep re-flooding schedules logged; water stability carries 15% of the score.",
      "Extend willow planting to the abandoned plots on the northern edge.",
    ],
    encroachment: [
      "Document the new boundary fill with dated photos from three points along the northern edge.",
      "Ask the borough for the industrial park's permit and environmental impact filing.",
      "Prioritise keeping the remaining open water connected; drained canals cost the most health.",
    ],
  },
  mangrove_mx: {
    baseline: [
      "Re-open the silted tidal channel near the lagoon mouth.",
      "Map cleared patches for replanting with the fishing cooperative.",
    ],
    restoration: [
      "Monitor seedling survival quarterly with photos.",
      "Keep channels open through the rainy season.",
    ],
    encroachment: [
      "Record the cleared area with geotagged photos and report it to the reserve office.",
      "Restore tidal flow behind the new fill before the dry season.",
    ],
  },
  restoration_forest: {
    baseline: [
      "Maintain fire breaks before the March–May dry season.",
      "Expand native nursery output for the cleared slopes.",
    ],
    restoration: [
      "Track canopy closure on replanted slopes with yearly photos.",
      "Keep cattle out of the replanted areas.",
    ],
    encroachment: [
      "Report the new clearing to the ejido assembly and the reserve office.",
      "Replant the cleared strip before the rains.",
    ],
  },
};

function recommendationsFor(siteKey: string, scenario: ScenarioKey) {
  return RECOMMENDATIONS[siteKey]?.[scenario] ?? [];
}

const CONFIDENCE_WEIGHTS = {
  coverage: 0.4,
  agreement: 0.3,
  evidence: 0.2,
  recency: 0.1,
} as const;

/** The prototype's report in the shared shape the report panels render (see report-facts.ts). */
export function prototypeFacts(
  report: Report,
  id = `v${report.version}`,
): ReportFacts {
  return {
    id,
    version: report.version,
    period: report.period,
    createdAt: report.createdAt,
    simulated: report.scenario !== "baseline",
    health: report.health,
    grade: report.grade,
    confidence: report.confidence,
    valueLow: report.valueLow,
    valueMid: report.valueMid,
    valueHigh: report.valueHigh,
    fairValuePerUnit: report.fairValuePerUnit,
    baseHealth: report.baseHealth,
    adjustment: report.adjustment,
    adjustmentReason: report.adjustmentReason || null,
    adjustmentNote: report.scriptedAuditor ? "scripted in prototype" : null,
    components: SCORE_COMPONENTS.map((c) => ({
      key: c.key,
      label: c.label,
      weight: c.weight,
      value: report.components[c.key] ?? 0,
    })),
    confidenceParts: (
      Object.keys(CONFIDENCE_WEIGHTS) as (keyof typeof CONFIDENCE_WEIGHTS)[]
    ).map((key) => ({
      key,
      label: key[0]!.toUpperCase() + key.slice(1),
      weight: CONFIDENCE_WEIGHTS[key],
      value: report.confidenceComponents[key],
    })),
    services: report.services,
    carbonStock: report.carbon.stock,
    landcover: report.landcover,
    ndvi: report.ndvi,
    ndviTrend: report.ndviTrend,
    ndviP: report.ndviP,
    // Same rule as the API's reports: a direction only when significant at 5%.
    trendLabel: ndviTrendLabel(report.ndviTrend, report.ndviP < 0.05),
    waterChange: report.waterChange,
    builtShare: report.landcover.built,
    flags: report.flags,
    citations: report.citations,
    citationsNote: report.scriptedAuditor ? "scripted in this prototype" : null,
    summary: report.summary,
    summarySource: "scripted",
    recommendations: report.recommendations,
    attributions: [],
  };
}

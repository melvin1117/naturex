/**
 * Builds report versions from the deterministic ratings in `sites.json`, plus the Auditor's
 * bounded overlay (agreement, field evidence, ±10 adjustment) using the dev-spec §7.4 and §8
 * formulas, so every number on screen is traceable to a formula.
 */
import {
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
};

function flagDetail(code: string) {
  if (code.startsWith("low_bound_fallback"))
    return "Low bound uses a fallback median/mean ratio for one biome.";
  if (code.startsWith("unverified_coefficient"))
    return "A valuation coefficient is not yet verified against its source.";
  return FLAG_TEXT[code] ?? code.replaceAll("_", " ");
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
}): Report {
  const site = siteDataFor(args.siteKey);
  const s = site.scenarios[args.scenario];
  const overlay = args.overlay;
  const components = {
    ...s.confidenceComponents,
    agreement: overlay?.agreement ?? s.confidenceComponents.agreement,
    evidence: overlay?.evidence ? 1 : s.confidenceComponents.evidence,
  };
  const confidence = confidenceFrom(components);
  const adjustment = Math.max(-10, Math.min(10, overlay?.adjustment ?? 0));
  const health = Math.round((s.health + adjustment) * 10) / 10;
  const grade = gradeFor(health);
  const flags = s.flags
    .filter((code) => !(overlay && code === "auditor_pending"))
    .map((code) => ({ code, detail: flagDetail(code) }));
  if (args.scenario !== "baseline")
    flags.push({ code: "simulated", detail: flagDetail("simulated") });

  const fair = fairValuePerUnit(s.valueMid, health, confidence);
  const trend =
    s.ndviTrend > 0.005
      ? "improving"
      : s.ndviTrend < -0.005
        ? "declining"
        : "stable";

  const summary = [
    `${args.siteName} rates **${grade}** (${GRADE_LABEL[grade].toLowerCase()}), health ${health.toFixed(1)} out of 100, with ${confidence.toFixed(0)}% confidence.`,
    `Ecosystem services are estimated at **${money(s.valueLow)}–${money(s.valueHigh)} a year** (mid ${money(s.valueMid)}) across ${site.areaHa.toFixed(0)} ha. Stored carbon is about ${s.carbon.stock.toLocaleString("en-US")} tCO₂, shown separately and not added to the dollar value.`,
    `Vegetation is ${trend} over five years (Sen's slope ${s.ndviTrend >= 0 ? "+" : ""}${s.ndviTrend.toFixed(4)} NDVI a year). ${Math.round(s.naturalFraction * 100)}% of the area is natural cover.`,
    overlay
      ? `Auditor: ${overlay.reason}${adjustment !== 0 ? ` Health adjusted ${adjustment > 0 ? "+" : "−"}${Math.abs(adjustment).toFixed(1)}.` : ""}`
      : "Deterministic first rating from cached satellite metrics; Auditor review pending.",
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
    baseHealth: s.health,
    adjustment,
    adjustmentReason: overlay?.reason ?? "",
    health,
    grade,
    confidence,
    confidenceComponents: components,
    components: s.components,
    valueLow: s.valueLow,
    valueMid: s.valueMid,
    valueHigh: s.valueHigh,
    services: s.services,
    carbon: s.carbon,
    landcover: s.landcover,
    ndvi: s.ndvi,
    ndviTrend: s.ndviTrend,
    ndviP: s.ndviP,
    waterChange: s.waterChange,
    biomass: s.biomass,
    forestLoss12mHa: s.forestLoss12mHa,
    fairValuePerUnit: fair,
    gatePassed: s.gatePassed && confidence >= 70,
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
      "Keep re-flooding schedules logged; water stability drives a quarter of the score.",
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

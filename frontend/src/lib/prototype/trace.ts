/**
 * Agent Trace runs. In the prototype these are recorded sample runs with the model routing
 * from ADR-0003; token counts and latencies are illustrative until T28 serves real traces.
 */
import { MODELS } from "./data";
import type { Report } from "./rating";

export type TraceStep = {
  id: string;
  agent: string;
  label: string;
  kind: "llm" | "tool" | "seal";
  model?: { name: string; id: string };
  reasoning?: boolean;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
  costUsd?: number;
  detail: string;
  output: Record<string, unknown>;
};

export type RatingRun = {
  id: string;
  siteId: string;
  siteName: string;
  reportVersion: number;
  trigger: "listing" | "time_machine" | "event" | "seed";
  startedAt: string;
  steps: TraceStep[];
};

function cost(
  model: { price: readonly [number, number] },
  tin: number,
  tout: number,
) {
  return (
    Math.round(((tin * model.price[0] + tout * model.price[1]) / 1e6) * 1e5) /
    1e5
  );
}

export function buildRun(args: {
  id: string;
  siteId: string;
  siteName: string;
  report: Report;
  trigger: RatingRun["trigger"];
  startedAt: string;
  events: { id: string; title: string; direction: number; severity: number }[];
  photos: number;
  seed: number;
}): RatingRun {
  const { report } = args;
  const jitter = (base: number, spread: number) =>
    Math.round(
      base + (((args.seed * 9301 + base * 49297) % 233280) / 233280) * spread,
    );
  const steps: TraceStep[] = [];
  const orchIn = jitter(1840, 300);
  const orchOut = jitter(310, 80);
  steps.push({
    id: "plan",
    agent: "Orchestrator",
    label: "Plan the rating run",
    kind: "llm",
    model: MODELS.orchestrator,
    reasoning: false,
    tokensIn: orchIn,
    tokensOut: orchOut,
    latencyMs: jitter(2100, 600),
    costUsd: cost(MODELS.orchestrator, orchIn, orchOut),
    detail: "Chooses which tools to call and in what order. Reasoning off.",
    output: {
      plan: [
        "earth_obs",
        "valuation",
        "scoring",
        "news_scout",
        ...(args.photos ? ["field_evidence"] : []),
        "auditor",
      ],
      site: args.siteName,
      period: report.period,
    },
  });
  steps.push({
    id: "earth_obs",
    agent: "earth_obs tool",
    label: "Read satellite metrics",
    kind: "tool",
    latencyMs: jitter(420, 120),
    detail:
      "Cached Earth Engine metrics: Dynamic World land cover, Sentinel-2 NDVI, JRC water, Hansen loss, biomass.",
    output: {
      data_version:
        report.scenario === "baseline"
          ? report.period
          : `sim (${report.scenario})`,
      ndvi_trend_per_year: report.ndviTrend,
      water_change: report.waterChange,
      forest_loss_last_12m_ha: report.forestLoss12mHa,
      landcover: report.landcover,
    },
  });
  steps.push({
    id: "valuation",
    agent: "valuation tool",
    label: "Value ecosystem services",
    kind: "tool",
    latencyMs: jitter(48, 20),
    detail:
      "Benefit transfer with cited coefficients (Brander et al. 2024, Costanza et al. 2014). Pure Python.",
    output: {
      value_low: report.valueLow,
      value_mid: report.valueMid,
      value_high: report.valueHigh,
      unit: "Int$2020/yr",
      carbon_stock_tco2: report.carbon.stock,
    },
  });
  steps.push({
    id: "scoring",
    agent: "scoring tool",
    label: "Compute health and confidence",
    kind: "tool",
    latencyMs: jitter(22, 10),
    detail:
      "Weighted health score, grade bands and confidence (dev-spec §7.4).",
    output: { base_health: report.baseHealth, components: report.components },
  });
  const newsIn = jitter(2600, 500);
  const newsOut = jitter(420, 120);
  steps.push({
    id: "news",
    agent: "News Scout",
    label: "Scan local news",
    kind: "llm",
    model: MODELS.fast,
    reasoning: false,
    tokensIn: newsIn,
    tokensOut: newsOut,
    latencyMs: jitter(3200, 900),
    costUsd: cost(MODELS.fast, newsIn, newsOut),
    detail:
      "Three Tavily news queries around the site, then Nemotron 3 Nano classifies each result. Retrieved text is treated as untrusted data.",
    output: {
      queries: 3,
      events: args.events.map((e) => ({
        id: e.id,
        title: e.title,
        direction: e.direction,
        severity: e.severity,
      })),
    },
  });
  if (args.photos) {
    const vIn = jitter(1100, 200);
    const vOut = jitter(180, 40);
    steps.push({
      id: "evidence",
      agent: "Field evidence",
      label: "Describe community photos",
      kind: "llm",
      model: MODELS.vision,
      tokensIn: vIn,
      tokensOut: vOut,
      latencyMs: jitter(2400, 500),
      costUsd: cost(MODELS.vision, vIn, vOut),
      detail:
        "Nemotron 3.5 Super VL describes each photo (ADR-0003); code checks GPS and date fall inside the boundary; the Auditor decides what it means.",
      output: {
        photos: args.photos,
        inside_boundary: args.photos,
        recent: args.photos,
      },
    });
  }
  const audIn = jitter(6200, 900);
  const audOut = jitter(980, 200);
  steps.push({
    id: "auditor",
    agent: "Auditor",
    label: "Cross-check evidence and grade",
    kind: "llm",
    model: MODELS.auditor,
    reasoning: true,
    tokensIn: audIn,
    tokensOut: audOut,
    latencyMs: jitter(6800, 1500),
    costUsd: cost(MODELS.auditor, audIn, audOut),
    detail:
      "Deep reasoning over metrics, valuation, news and evidence. May adjust health within ±10, citing what it used. Numbers stay formula-made.",
    output: {
      agreement: report.confidenceComponents.agreement,
      adjustment: report.adjustment,
      reason: report.adjustmentReason,
      citations: report.citations,
      grade: report.grade,
    },
  });
  steps.push({
    id: "seal",
    agent: "Nature Ledger",
    label: "Seal report on the ledger",
    kind: "seal",
    latencyMs: jitter(35, 15),
    detail: "Report snapshot appended to the site's hash chain.",
    output: {
      report_version: report.version,
      health: report.health,
      grade: report.grade,
    },
  });
  return {
    id: args.id,
    siteId: args.siteId,
    siteName: args.siteName,
    reportVersion: report.version,
    trigger: args.trigger,
    startedAt: args.startedAt,
    steps,
  };
}

export function runTotals(run: RatingRun) {
  return run.steps.reduce(
    (acc, s) => ({
      tokens: acc.tokens + (s.tokensIn ?? 0) + (s.tokensOut ?? 0),
      latencyMs: acc.latencyMs + s.latencyMs,
      costUsd: acc.costUsd + (s.costUsd ?? 0),
      llmCalls: acc.llmCalls + (s.kind === "llm" ? 1 : 0),
    }),
    { tokens: 0, latencyMs: 0, costUsd: 0, llmCalls: 0 },
  );
}

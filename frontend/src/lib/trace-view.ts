/**
 * The Agent Trace, explained (the trace redesign): turns `GET /runs/{run_id}/trace` into the
 * views that show *which* model did *what* and *why to trust it*: a plain-language story, a
 * flow of steps with their branches, a timeline per actor, the Auditor's case, the checks code
 * ran, and a cost receipt against an all-Ultra baseline.
 *
 * Pure, so it is easy to test against recorded runs. Every number is the backend's; this only
 * places, sums and words them.
 */
import type { RunTrace, TraceCall } from "./api/types";

type Step = RunTrace["steps"][number];
type Call = TraceCall;
type Output = Record<string, unknown>;

/** Who did the work: a model family, the web, or deterministic code. */
export type Actor =
  | "super"
  | "nano"
  | "ultra"
  | "vision"
  | "embed"
  | "tavily"
  | "code"
  | "ledger";

export const ACTOR: Record<
  Actor,
  { name: string; role: string; kind: "model" | "web" | "code" }
> = {
  super: {
    name: "Nemotron 3 Super",
    role: "Plans the run and calls the tools",
    kind: "model",
  },
  nano: {
    name: "Nemotron 3 Nano",
    role: "Fast reads: sorts the news",
    kind: "model",
  },
  ultra: {
    name: "Nemotron 3 Ultra",
    role: "Thinks the case through and judges",
    kind: "model",
  },
  vision: {
    name: "Vision model",
    role: "Reads images",
    kind: "model",
  },
  embed: {
    name: "Embedding model",
    role: "Finds passages for the Copilot",
    kind: "model",
  },
  tavily: {
    name: "Tavily",
    role: "Searches the web for local news",
    kind: "web",
  },
  code: {
    name: "Code",
    role: "Computes every number and checks every claim",
    kind: "code",
  },
  ledger: {
    name: "Nature Ledger",
    role: "Seals the report in a hash chain",
    kind: "code",
  },
};

const MODELS: Record<string, { name: string; actor: Actor }> = {
  "nvidia/nemotron-3-super-120b-a12b": {
    name: "Nemotron 3 Super",
    actor: "super",
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    name: "Nemotron 3 Ultra",
    actor: "ultra",
  },
  "nvidia/nvidia-nemotron-3-nano-30b-a3b": {
    name: "Nemotron 3 Nano",
    actor: "nano",
  },
  "nvidia/nemotron-3_5-lightning": {
    name: "Nemotron 3.5 Lightning",
    actor: "nano",
  },
  "nvidia/nemotron-3.5-super-vl": {
    name: "Nemotron 3.5 Super VL",
    actor: "vision",
  },
  "openbmb/minicpm-v-4_5": { name: "MiniCPM-V 4.5", actor: "vision" },
  "qwen/qwen3-embedding-8b": { name: "Qwen3 Embedding 8B", actor: "embed" },
};

/** "Nemotron 3 Ultra" for a known Token Factory model id, else the id itself. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "Model";
  return MODELS[id.toLowerCase()]?.name ?? id;
}

export function actorOf(model: string | null | undefined): Actor {
  return (model && MODELS[model.toLowerCase()]?.actor) || "super";
}

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function out(step: Step | undefined): Output {
  return (step?.output ?? {}) as Output;
}

function stepNamed(trace: RunTrace, name: string): Step | undefined {
  return trace.steps.find((s) => s.step === name);
}

function ownCalls(step: Step | undefined, agent: string): Call[] {
  return (step?.llm_calls ?? []).filter((c) => c.agent === agent);
}

/** Model citations like `[signal:x, event:y]` removed, for prose read aloud. */
export function withoutCitations(text: string): string {
  return text
    .replace(/\s*\[[^\][]*\]/g, "")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

export function usd(value: number, digits = 4): string {
  return `$${value.toFixed(digits)}`;
}

export function money(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${Math.round(value / 1e3)}k`;
  return `$${Math.round(value)}`;
}

export function seconds(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 100) return "<0.1 s";
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const LANGUAGE: Record<string, string> = { es: "Spanish", pt: "Portuguese" };

// ----- signals, searches and the case ------------------------------------------------------

export type Signal = {
  id: string;
  kind: string;
  direction: number;
  start: string;
  end: string;
  text: string;
  strength: string;
  simulated: boolean;
};

export function runSignals(trace: RunTrace): Signal[] {
  const signals = out(stepNamed(trace, "earth_obs")).signals;
  return Array.isArray(signals) ? (signals as Signal[]) : [];
}

export type Search = {
  query: string;
  language: string | null;
  results: number;
  latencyMs: number;
  credits: number;
  error: string | null;
};

export function runSearches(trace: RunTrace): Search[] {
  const raw = out(stepNamed(trace, "news")).searches;
  if (!Array.isArray(raw)) return [];
  return raw.map((s: Output) => ({
    query: String(s.query ?? ""),
    language: (s.language as string | null) ?? null,
    results: num(s.results),
    latencyMs: num(s.latency_ms),
    credits: num(s.credits),
    error: (s.error as string | undefined) ?? null,
  }));
}

export type EvidenceRef = {
  id: string;
  kind: "fact" | "news" | "evidence" | "unknown";
  label: string;
  value: string | null;
  url: string | null;
  date: string | null;
  direction: number | null;
};

const FACT_LABEL: Record<string, string> = {
  "metric:data_version": "Data version",
  "metric:area_ha": "Area",
  "metric:natural_fraction": "Natural cover",
  "metric:ndvi_mean": "Greenness (NDVI)",
  "metric:ndvi_trend": "5-year greenness trend",
  "metric:water_change": "Surface water change",
  "metric:forest_loss_5y_ha": "Tree loss, 5 years",
  "metric:forest_loss_12m_ha": "Tree loss, last 12 months",
  "metric:biomass_t_ha": "Biomass",
  "metric:soc_t_c_ha": "Soil carbon",
  "metric:mangrove_fraction": "Mangrove extent",
  "metric:cloud_free_obs": "Cloud-free views",
  "signal:greenness_last_12m": "Latest 12 months vs earlier years",
  "signal:cloud_gap": "Cloud gap",
  "score:base_health": "Base health",
  "score:threat_pressure": "Threat pressure",
  "score:habitat_loss": "Habitat loss",
  "score:water_stability": "Water stability",
  "score:natural_cover": "Natural cover score",
  "score:vegetation_vigor": "Vegetation vigour",
  "valuation:value_mid": "Value (mid)",
};

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** A short human label for a citation ID. */
export function citationLabel(id: string): string {
  if (FACT_LABEL[id]) return FACT_LABEL[id];
  const anomaly = /^signal:greenness_(\d{4})_(\d{2})$/.exec(id);
  if (anomaly)
    return `Greenness, ${MONTHS[Number(anomaly[2]) - 1]} ${anomaly[1]}`;
  if (id.startsWith("metric:landcover."))
    return `Land cover: ${id.slice("metric:landcover.".length).replaceAll("_", " ")}`;
  const [, rest = id] = id.split(":");
  const words = rest.replaceAll(/[_.]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function evidenceRef(id: string, evidence: Output): EvidenceRef {
  const item = evidence[id] as Output | undefined;
  if (!item)
    return {
      id,
      kind: "unknown",
      label: citationLabel(id),
      value: null,
      url: null,
      date: null,
      direction: null,
    };
  if (item.kind === "fact")
    return {
      id,
      kind: "fact",
      label: citationLabel(id),
      value: (item.value as string | null) ?? null,
      url: null,
      date: null,
      direction: null,
    };
  return {
    id,
    kind: item.kind === "evidence" ? "evidence" : "news",
    label: String(item.title ?? "News report"),
    value: (item.impact_type as string | null) ?? null,
    url: (item.url as string | null) ?? null,
    date: (item.published_at as string | null) ?? null,
    direction: item.direction == null ? null : num(item.direction),
  };
}

export type Hypothesis = {
  name: string;
  assessment: "supported" | "weakened" | "unclear";
  supporting: EvidenceRef[];
  weakening: EvidenceRef[];
};

export type AuditCase = {
  source: string;
  model: string | null;
  verdict: string | null;
  hypotheses: Hypothesis[];
  adjustment: number;
  adjustmentReason: string | null;
  baseHealth: number | null;
  health: number | null;
  agreement: number | null;
  reasoningTokens: number | null;
  notes: string | null;
  thinkMs: number | null;
};

export function auditCase(trace: RunTrace): AuditCase | null {
  const step = stepNamed(trace, "audit");
  if (!step || step.status !== "ok") return null;
  const o = out(step);
  const evidence = (o.evidence ?? {}) as Output;
  const refs = (ids: unknown) =>
    Array.isArray(ids)
      ? ids.map((id) => evidenceRef(String(id), evidence))
      : [];
  const hypotheses = Array.isArray(o.hypotheses)
    ? (o.hypotheses as Output[]).map((h) => ({
        name: String(h.name ?? ""),
        assessment: (h.assessment as Hypothesis["assessment"]) ?? "unclear",
        supporting: refs(h.evidence_for),
        weakening: refs(h.evidence_against),
      }))
    : [];
  const base = o.base_health == null ? null : num(o.base_health);
  const adjustment = num(o.auditor_adjustment);
  const auditor = ownCalls(step, "auditor");
  return {
    source: String(o.source ?? "fallback"),
    model:
      step.model ?? auditor.findLast((c) => c.status === "ok")?.model ?? null,
    verdict: (o.verdict as string | null) ?? null,
    hypotheses,
    adjustment,
    adjustmentReason: (o.adjustment_reason as string | null) ?? null,
    baseHealth: base,
    health: base == null ? null : Math.min(100, Math.max(0, base + adjustment)),
    agreement: o.agreement == null ? null : num(o.agreement),
    reasoningTokens:
      o.reasoning_tokens == null ? null : num(o.reasoning_tokens),
    notes: (o.notes as string | null) ?? null,
    thinkMs: auditor[0]?.latency_ms ?? null,
  };
}

/** Every ID the case cites, resolved, in first-seen order (for an evidence list). */
export function caseEvidence(c: AuditCase): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const h of c.hypotheses)
    for (const ref of [...h.supporting, ...h.weakening])
      if (!seen.has(ref.id)) seen.set(ref.id, ref);
  return [...seen.values()];
}

// ----- checks ------------------------------------------------------------------------------

export type FunnelStage = { label: string; count: number; note: string };

export function newsFunnel(trace: RunTrace): FunnelStage[] | null {
  const f = out(stepNamed(trace, "news")).funnel as Output | undefined;
  if (!f) return null;
  return [
    {
      label: "Found by Tavily",
      count: num(f.found),
      note: "every result of every search",
    },
    {
      label: "Different articles",
      count: num(f.unique),
      note: "duplicates merged",
    },
    {
      label: "Safe to read",
      count: num(f.unique) - num(f.unsafe),
      note: "articles that were only planted instructions are skipped",
    },
    {
      label: "Read by Nano",
      count: num(f.sent_to_model),
      note: "the most relevant, at most 8",
    },
    {
      label: "Relevant",
      count: num(f.relevant),
      note: "a real event that changes the site's condition",
    },
    {
      label: "On this site",
      count: num(f.kept),
      note: "names the site, or a place nearby with its region",
    },
  ];
}

export type AuditChecks = {
  citations: number;
  resolved: number;
  placeholders: number;
  refused: number;
  rounds: number;
  rejections: string[];
};

export function auditChecks(trace: RunTrace): AuditChecks | null {
  const o = out(stepNamed(trace, "audit"));
  const checks = o.checks as Output | undefined;
  if (!checks) return null;
  return {
    citations: num(checks.citations),
    resolved: num(checks.resolved),
    placeholders: num(checks.placeholders_filled),
    refused: num(checks.rejected_answers),
    rounds: num(o.rounds),
    rejections: Array.isArray(o.rejections) ? (o.rejections as string[]) : [],
  };
}

// ----- cost --------------------------------------------------------------------------------

export type ModelShare = {
  model: string;
  name: string;
  actor: Actor;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
  share: number;
};

export type Receipt = {
  totalUsd: number;
  baselineUsd: number | null;
  baselineModel: string | null;
  savedPct: number | null;
  models: ModelShare[];
  searches: number;
  credits: number;
};

export function costReceipt(trace: RunTrace): Receipt {
  const models = (trace.models ?? []).map((m) => ({
    model: m.model,
    name: modelLabel(m.model),
    actor: actorOf(m.model),
    calls: m.calls,
    tokensIn: m.prompt_tokens,
    tokensOut: m.completion_tokens,
    latencyMs: m.latency_ms,
    costUsd: num(m.cost_usd),
    share: 0,
  }));
  const total =
    trace.totals != null
      ? num(trace.totals.cost_usd)
      : models.reduce((n, m) => n + m.costUsd, 0);
  for (const m of models) m.share = total > 0 ? m.costUsd / total : 0;
  const baseline = trace.baseline ? num(trace.baseline.cost_usd) : null;
  const searches = runSearches(trace);
  return {
    totalUsd: total,
    baselineUsd: baseline,
    baselineModel: trace.baseline?.model ?? null,
    savedPct:
      baseline && baseline > total
        ? Math.round((1 - total / baseline) * 100)
        : null,
    models,
    searches: searches.length,
    credits: searches.reduce((n, s) => n + s.credits, 0),
  };
}

// ----- the story ---------------------------------------------------------------------------

export type StoryLine = {
  key: string;
  actor: Actor;
  text: string;
  details: string[];
};

function languages(searches: Search[]): string {
  const local = searches.filter((s) => s.language && s.language !== "en");
  if (!local.length) return "";
  const names = [
    ...new Set(local.map((s) => LANGUAGE[s.language!] ?? s.language)),
  ];
  return ` (${local.length} in ${names.join(" and ")})`;
}

export function runStory(trace: RunTrace): StoryLine[] {
  const lines: StoryLine[] = [];
  const earth = stepNamed(trace, "earth_obs");
  const orchestrated = trace.steps.some((s) =>
    (s.llm_calls ?? []).some((c) => c.agent === "orchestrator"),
  );
  const turns = trace.steps.flatMap((s) => ownCalls(s, "orchestrator"));
  if (orchestrated)
    lines.push({
      key: "plan",
      actor: "super",
      text: `Nemotron 3 Super ran the rating, choosing each tool in turn (${turns.length} decisions, ${seconds(turns.reduce((n, c) => n + (c.latency_ms ?? 0), 0))}).`,
      details: [],
    });
  else if (trace.steps.some((s) => s.pipeline === "fixed"))
    lines.push({
      key: "plan",
      actor: "code",
      text: "The fixed pipeline ran each step in order (no model was available to plan).",
      details: [],
    });

  if (earth?.status === "ok") {
    const o = out(earth);
    const signals = runSignals(trace);
    const dated = signals.filter((s) => s.kind === "greenness_anomaly");
    const source = o.simulated
      ? "a scripted Time Machine scenario"
      : "5 years of Sentinel-2 satellite data";
    lines.push({
      key: "earth",
      actor: "code",
      text: `Code read ${source} for ${num(o.area_ha)} ha and found ${dated.length ? `${dated.length} dated change${dated.length > 1 ? "s" : ""}` : "no unusual month"} in greenness.`,
      details: signals.map((s) => s.text),
    });
  }

  const valuation = stepNamed(trace, "valuation");
  if (valuation?.status === "ok") {
    const o = out(valuation);
    lines.push({
      key: "value",
      actor: "code",
      text: `Code valued its ecosystem services at ${money(num(o.value_low))}–${money(num(o.value_high))} a year.`,
      details: [],
    });
  }

  const news = stepNamed(trace, "news");
  if (news) {
    const o = out(news);
    const searches = runSearches(trace);
    const funnel = o.funnel as Output | undefined;
    const nano = ownCalls(news, "news_scout").at(-1);
    let text: string;
    if (news.status === "failed")
      text = "The news search failed, so the rating went ahead without news.";
    else if (o.news_paused)
      text = "News was paused: the Tavily account is near its credit limit.";
    else if (!searches.length)
      text = `${num(o.events)} news item${num(o.events) === 1 ? "" : "s"} came from the sample news (mock mode).`;
    else
      text = `Tavily ran ${searches.length} web searches${languages(searches)} and found ${num(funnel?.found)} results; ${nano ? modelLabel(nano.model) : "the model"} read ${num(funnel?.sent_to_model)} and kept ${num(funnel?.kept)} about this site.`;
    lines.push({
      key: "news",
      actor: searches.length ? "tavily" : "code",
      text,
      details: searches.map(
        (s) =>
          `“${s.query}”${s.language && s.language !== "en" ? ` (${LANGUAGE[s.language] ?? s.language})` : ""}: ${s.error ? "failed" : `${s.results} results`}`,
      ),
    });
  }

  const evidence = stepNamed(trace, "evidence");
  if (evidence?.status === "ok") {
    const o = out(evidence);
    lines.push({
      key: "evidence",
      actor: "code",
      text: `Code checked ${num(o.items)} field photo${num(o.items) === 1 ? "" : "s"} (${num(o.validated)} passed the location and date checks).`,
      details: [],
    });
  }

  const audit = auditCase(trace);
  if (audit) {
    const judged =
      audit.source === "fallback"
        ? "No model answer passed the checks, so the rating stands on the formulas alone."
        : `${modelLabel(audit.model)}${audit.reasoningTokens ? ` thought it through (${audit.reasoningTokens.toLocaleString("en-US")} reasoning tokens)` : ""}, weighed ${audit.hypotheses.length || "the"} explanation${audit.hypotheses.length === 1 ? "" : "s"}${audit.verdict ? ` and concluded: ${withoutCitations(audit.verdict)}` : "."}`;
    lines.push({
      key: "audit",
      actor: audit.source === "fallback" ? "code" : actorOf(audit.model),
      text: judged.endsWith(".") ? judged : `${judged}.`,
      details: audit.hypotheses.map((h) => `${h.name}: ${h.assessment}`),
    });
    const checks = auditChecks(trace);
    if (checks)
      lines.push({
        key: "checks",
        actor: "code",
        text: `Code checked every claim: ${checks.resolved} of ${checks.citations} citations point to real evidence, ${checks.placeholders} number${checks.placeholders === 1 ? " was" : "s were"} filled in from the data${checks.refused ? `, and ${checks.refused} answer${checks.refused === 1 ? " was" : "s were"} sent back` : ""}.`,
        details: checks.rejections.slice(0, 3),
      });
  }

  const done = stepNamed(trace, "done");
  if (done && (done.status === "succeeded" || done.status === "degraded")) {
    const receipt = costReceipt(trace);
    lines.push({
      key: "seal",
      actor: "ledger",
      text: `The report was sealed in the Nature Ledger. The run took ${seconds(done.latency_ms)} and cost ${usd(receipt.totalUsd, 3)} in model calls${receipt.savedPct ? `, ${receipt.savedPct}% less than running every call on Ultra` : ""}.`,
      details: [],
    });
  }
  return lines;
}

// ----- the flow ----------------------------------------------------------------------------

export type FlowNode = {
  id: string;
  actor: Actor;
  title: string;
  summary: string;
  status: string;
  latencyMs: number | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** The call that chose this step: Super's tool choice, or the fixed pipeline. */
  decision: { actor: Actor; text: string; latencyMs: number | null } | null;
  children: FlowNode[];
  step: string;
};

function callNode(
  id: string,
  call: Call,
  title: string,
  summary: string,
): FlowNode {
  return {
    id,
    actor: actorOf(call.model),
    title,
    summary,
    status: call.status,
    latencyMs: call.latency_ms ?? null,
    costUsd: num(call.cost_usd),
    tokensIn: call.prompt_tokens ?? 0,
    tokensOut: call.completion_tokens ?? 0,
    decision: null,
    children: [],
    step: "",
  };
}

const TOOL_TITLE: Record<string, string> = {
  earth_obs: "Satellite metrics",
  valuation: "Ecosystem value",
  news: "Local news",
  evidence: "Field evidence",
  audit: "The audit",
};

export function runFlow(trace: RunTrace): FlowNode[] {
  const nodes: FlowNode[] = [];
  for (const step of trace.steps) {
    if (!(step.step in TOOL_TITLE) && step.step !== "done") continue;
    const o = out(step);
    const calls = step.llm_calls ?? [];
    const orchestrator = calls.filter((c) => c.agent === "orchestrator");
    const decision = orchestrator.length
      ? {
          actor: actorOf(orchestrator.at(-1)?.model),
          text: `${modelLabel(orchestrator.at(-1)?.model)} called ${step.tool ?? step.step}`,
          latencyMs: orchestrator.reduce((n, c) => n + (c.latency_ms ?? 0), 0),
        }
      : step.pipeline === "fixed"
        ? {
            actor: "code" as Actor,
            text: "The fixed pipeline ran it",
            latencyMs: null,
          }
        : null;
    const base: FlowNode = {
      id: step.step,
      actor: "code",
      title: TOOL_TITLE[step.step] ?? "Sealed",
      summary: "",
      status: step.status,
      latencyMs: step.latency_ms ?? null,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      decision,
      children: [],
      step: step.step,
    };
    if (step.step === "earth_obs") {
      const signals = runSignals(trace);
      const dated = signals.filter(
        (s) => s.kind === "greenness_anomaly",
      ).length;
      base.summary = `${num(o.area_ha)} ha · ${dated} dated change${dated === 1 ? "" : "s"}`;
      base.children = signals.map((s, i) => ({
        ...base,
        id: `signal-${i}`,
        title:
          s.kind === "greenness_last_12m"
            ? "Latest 12 months"
            : s.kind === "cloud_gap"
              ? "Cloud gap"
              : `Greenness ${s.start}`,
        summary: s.text,
        status: "ok",
        latencyMs: null,
        decision: null,
        children: [],
      }));
    } else if (step.step === "valuation") {
      base.summary = `${money(num(o.value_low))}–${money(num(o.value_high))} a year`;
    } else if (step.step === "news") {
      const searches = runSearches(trace);
      const funnel = o.funnel as Output | undefined;
      base.actor = searches.length ? "tavily" : "code";
      base.title = "Local news";
      base.summary = funnel
        ? `${searches.length} searches · ${num(funnel.found)} results · ${num(funnel.kept)} kept`
        : o.news_paused
          ? "Paused: Tavily credits are low"
          : `${num(o.events)} events`;
      const nano = ownCalls(step, "news_scout");
      base.children = [
        ...searches.map((s, i) => ({
          ...base,
          id: `search-${i}`,
          actor: "tavily" as Actor,
          title:
            s.language && s.language !== "en"
              ? `Search (${LANGUAGE[s.language] ?? s.language})`
              : "Search",
          summary: `“${s.query}” · ${s.error ? "failed" : `${s.results} results`}`,
          status: s.error ? "failed" : "ok",
          latencyMs: s.latencyMs,
          decision: null,
          children: [],
        })),
        ...nano.map((c, i) =>
          callNode(
            `classify-${i}`,
            c,
            "Sort the articles",
            funnel
              ? `read ${num(funnel.sent_to_model)} · ${num(funnel.relevant)} relevant`
              : "classified the results",
          ),
        ),
        ...(funnel
          ? [
              {
                ...base,
                id: "place-check",
                actor: "code" as Actor,
                title: "Place check",
                summary: `${num(funnel.kept)} on this site · ${num(funnel.off_site)} about somewhere else`,
                status: "ok",
                latencyMs: null,
                decision: null,
                children: [],
              },
            ]
          : []),
      ];
    } else if (step.step === "audit") {
      const auditor = ownCalls(step, "auditor");
      const c = auditCase(trace);
      const checks = auditChecks(trace);
      base.actor = c && c.source !== "fallback" ? actorOf(c.model) : "code";
      base.title = "The audit";
      base.summary = c?.verdict
        ? withoutCitations(c.verdict)
        : String(o.source ?? "") === "fallback"
          ? "No answer passed the checks: formulas only"
          : "";
      base.children = [
        ...auditor.map((call, i) =>
          callNode(
            `audit-${i}`,
            call,
            i === 0 ? "Think and judge" : "Fix the answer",
            i === 0
              ? `${call.status === "ok" ? "accepted" : call.status === "rejected" ? "sent back" : call.status}${i === 0 && c?.reasoningTokens ? ` · ${c.reasoningTokens.toLocaleString("en-US")} reasoning tokens` : ""}`
              : `${call.status === "ok" ? "accepted" : call.status}`,
          ),
        ),
        ...(checks
          ? [
              {
                ...base,
                id: "claim-check",
                actor: "code" as Actor,
                title: "Claim check",
                summary: `${checks.resolved}/${checks.citations} citations real · ${checks.placeholders} numbers from the data`,
                status: "ok",
                latencyMs: null,
                decision: null,
                children: [],
              },
            ]
          : []),
      ];
    } else if (step.step === "evidence") {
      base.summary =
        step.status === "skipped"
          ? "No field photos for this site"
          : `${num(o.validated)} of ${num(o.items)} photos validated`;
    } else if (step.step === "done") {
      base.actor = "ledger";
      base.title = "Sealed";
      base.summary = "The report enters the hash-chained Nature Ledger";
      base.latencyMs = null;
    }
    const own = calls.filter((c) => c.agent !== "orchestrator");
    base.costUsd = own.reduce((n, c) => n + num(c.cost_usd), 0);
    base.tokensIn = own.reduce((n, c) => n + (c.prompt_tokens ?? 0), 0);
    base.tokensOut = own.reduce((n, c) => n + (c.completion_tokens ?? 0), 0);
    nodes.push(base);
  }
  return nodes;
}

// ----- the timeline ------------------------------------------------------------------------

export type Bar = {
  id: string;
  label: string;
  detail: string;
  startMs: number;
  endMs: number;
  status: string;
};

export type Lane = { actor: Actor; label: string; bars: Bar[] };

const LANE_ORDER: Actor[] = [
  "super",
  "code",
  "tavily",
  "nano",
  "vision",
  "ultra",
];

/**
 * Bars per actor on one time axis from the run's start. Each step's progress event marks its
 * end; its tool ran for `latency_ms` before that, and Super's choice of the tool came just
 * before the tool started. Tavily's searches run in parallel at the tool's start; News
 * Scout's model call ends the news step; audit calls run back to back.
 */
export function runTimeline(trace: RunTrace): {
  totalMs: number;
  lanes: Lane[];
} {
  const t0 = Date.parse(trace.steps[0]?.ts ?? "");
  const bars = new Map<Actor, Bar[]>();
  const add = (actor: Actor, bar: Bar) => {
    if (bar.endMs <= bar.startMs) bar.endMs = bar.startMs + 1;
    bars.set(actor, [...(bars.get(actor) ?? []), bar]);
  };
  let totalMs = 0;
  for (const step of trace.steps) {
    if (!step.ts || !Number.isFinite(t0)) continue;
    const end = Date.parse(step.ts) - t0;
    totalMs = Math.max(totalMs, end);
    if (!(step.step in TOOL_TITLE)) continue;
    const toolMs = step.latency_ms ?? 0;
    const start = Math.max(0, end - toolMs);
    const calls = step.llm_calls ?? [];
    let cursor = start;
    for (const c of [
      ...calls.filter((c) => c.agent === "orchestrator"),
    ].reverse()) {
      const s = Math.max(0, cursor - (c.latency_ms ?? 0));
      add(actorOf(c.model), {
        id: `${step.step}-plan-${c.id}`,
        label: `chose ${step.tool ?? step.step}`,
        detail: `${modelLabel(c.model)} · ${seconds(c.latency_ms)}`,
        startMs: s,
        endMs: cursor,
        status: c.status,
      });
      cursor = s;
    }
    if (step.step === "news") {
      runSearches(trace).forEach((s, i) =>
        add("tavily", {
          id: `search-${i}`,
          label:
            s.language && s.language !== "en"
              ? `search (${s.language})`
              : "search",
          detail: `“${s.query}” · ${s.results} results · ${seconds(s.latencyMs)}`,
          startMs: start,
          endMs: start + s.latencyMs,
          status: s.error ? "failed" : "ok",
        }),
      );
      for (const c of ownCalls(step, "news_scout"))
        add(actorOf(c.model), {
          id: `news-${c.id}`,
          label: "sort articles",
          detail: `${modelLabel(c.model)} · ${(c.prompt_tokens ?? 0).toLocaleString("en-US")} in · ${seconds(c.latency_ms)}`,
          startMs: Math.max(start, end - (c.latency_ms ?? 0)),
          endMs: end,
          status: c.status,
        });
    } else if (step.step === "audit") {
      let at = start;
      ownCalls(step, "auditor").forEach((c, i) => {
        add(actorOf(c.model), {
          id: `audit-${c.id}`,
          label: i === 0 ? "think and judge" : "fix the answer",
          detail: `${modelLabel(c.model)} · ${(c.completion_tokens ?? 0).toLocaleString("en-US")} out · ${seconds(c.latency_ms)}`,
          startMs: at,
          endMs: at + (c.latency_ms ?? 0),
          status: c.status,
        });
        at += c.latency_ms ?? 0;
      });
    } else if (step.status === "ok") {
      add("code", {
        id: `${step.step}-code`,
        label: TOOL_TITLE[step.step]!.toLowerCase(),
        detail: `Code · ${seconds(toolMs)}`,
        startMs: start,
        endMs: end,
        status: step.status,
      });
    }
  }
  const lanes = LANE_ORDER.filter((a) => bars.has(a)).map((actor) => ({
    actor,
    label: ACTOR[actor].name,
    bars: bars.get(actor)!,
  }));
  return { totalMs, lanes };
}

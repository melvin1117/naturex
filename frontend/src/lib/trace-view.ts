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
    role: "Plans the run, calls the tools and sorts the news",
    kind: "model",
  },
  nano: {
    name: "Nemotron 3 Nano",
    role: "Fast reads: answers questions about an article",
    kind: "model",
  },
  ultra: {
    name: "Nemotron 3 Ultra",
    role: "Thinks the case through and judges",
    kind: "model",
  },
  vision: {
    name: "Nemotron 3.5 Super VL",
    role: "Reads satellite images and describes what changed",
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
    name: "The Record",
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

export type VisionChange = {
  id: string;
  kind: string;
  where: string;
  confidence: string;
  note: string;
  agrees: boolean | null;
  check: string;
};

export type Vision = {
  model: string | null;
  overall: string;
  before: Record<string, string> | null;
  after: Record<string, string> | null;
  changes: VisionChange[];
  error: string | null;
};

/** The vision model's before/after reading of the site's satellite views, if it ran. */
export function runVision(trace: RunTrace): Vision | null {
  const v = out(stepNamed(trace, "earth_obs")).vision as Output | undefined;
  if (!v) return null;
  return {
    model: (v.model as string | null) ?? null,
    overall: String(v.overall ?? "unclear"),
    before: (v.before as Record<string, string> | null) ?? null,
    after: (v.after as Record<string, string> | null) ?? null,
    changes: Array.isArray(v.changes) ? (v.changes as VisionChange[]) : [],
    error: (v.error as string | null) ?? null,
  };
}

const CHANGE_LABEL: Record<string, string> = {
  clearing: "clearing",
  new_structures: "new structures",
  road: "a road",
  vegetation_loss: "less vegetation",
  water_loss: "less water",
  water_gain: "more water",
  regrowth: "regrowth",
  burn_scar: "a burn scar",
  flooding: "flooding",
  no_clear_change: "no clear change",
};

export function changeLabel(kind: string): string {
  return CHANGE_LABEL[kind] ?? kind.replaceAll("_", " ");
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
  return searchesOf(out(stepNamed(trace, "news")).searches);
}

export type Found = {
  event: string;
  title: string | null;
  url: string | null;
  date: string | null;
  impactType: string;
  direction: number;
  severity: number;
  source: string | null;
};

type FollowUpBase = {
  index: number;
  why: string;
  status: string;
  error: string | null;
  latencyMs: number | null;
  step: Step;
};

export type SearchFollowUp = FollowUpBase & {
  kind: "search";
  signal: string;
  signalText: string;
  topic: string;
  window: { start: string; end: string } | null;
  searches: Search[];
  found: Found[];
  alreadyKnown: number;
};

export type ReadFollowUp = FollowUpBase & {
  kind: "read";
  event: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  question: string;
  namesSite: boolean;
  modelNamesSite: boolean;
  month: string | null;
  answers: string | null;
  finding: string;
  quote: string;
  quoteChecked: boolean;
  charsRead: number;
  extractMs: number;
  credits: number;
};

export type FollowUp = SearchFollowUp | ReadFollowUp;

function searchesOf(raw: unknown): Search[] {
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

/** Super's optional follow-ups between the news and the audit, in the order it ran them. */
export function runFollowUps(trace: RunTrace): FollowUp[] {
  return trace.steps
    .filter((s) => s.step === "investigate")
    .map((step, index): FollowUp => {
      const o = out(step);
      const base: FollowUpBase = {
        index,
        why: String(o.why ?? ""),
        status: step.status,
        error: step.error ?? null,
        latencyMs: step.latency_ms ?? null,
        step,
      };
      if ((step.tool ?? o.tool) === "read_article")
        return {
          ...base,
          kind: "read",
          event: String(o.event ?? ""),
          title: (o.title as string | null) ?? null,
          url: (o.url as string | null) ?? null,
          publishedAt: (o.published_at as string | null) ?? null,
          question: String(o.question ?? ""),
          namesSite: Boolean(o.names_site),
          modelNamesSite: Boolean(o.model_names_site),
          month: (o.month as string | null) ?? null,
          answers: (o.answers as string | null) ?? null,
          finding: String(o.finding ?? ""),
          quote: String(o.quote ?? ""),
          quoteChecked: Boolean(o.quote_checked),
          charsRead: num(o.chars_read),
          extractMs: num(o.extract_ms),
          credits: num(o.credits),
        };
      const window = o.window as Output | undefined;
      const found = Array.isArray(o.found) ? (o.found as Output[]) : [];
      return {
        ...base,
        kind: "search",
        signal: String(o.signal ?? ""),
        signalText: String(o.signal_text ?? ""),
        topic: String(o.topic ?? ""),
        window: window
          ? { start: String(window.start), end: String(window.end) }
          : null,
        searches: searchesOf(o.searches),
        found: found.map((f) => ({
          event: String(f.event ?? ""),
          title: (f.title as string | null) ?? null,
          url: (f.url as string | null) ?? null,
          date: (f.date as string | null) ?? null,
          impactType: String(f.impact_type ?? ""),
          direction: num(f.direction),
          severity: num(f.severity),
          source: (f.source as string | null) ?? null,
        })),
        alreadyKnown: num(o.already_known),
      };
    });
}

export type Plan = {
  notes: string | null;
  reasoningTokens: number | null;
  chose: string[];
  model: string | null;
  latencyMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
};

/** Super's one thinking turn: what it weighed and which tools it chose next. */
export function runPlan(trace: RunTrace): Plan | null {
  const step = stepNamed(trace, "plan");
  if (!step) return null;
  const o = out(step);
  const calls = ownCalls(step, "orchestrator");
  return {
    notes: (o.notes as string | null) ?? null,
    reasoningTokens:
      o.reasoning_tokens == null ? null : num(o.reasoning_tokens),
    chose: Array.isArray(o.chose) ? o.chose.map(String) : [],
    model: calls.at(-1)?.model ?? null,
    latencyMs: calls.reduce((n, c) => n + (c.latency_ms ?? 0), 0),
    costUsd: calls.reduce((n, c) => n + num(c.cost_usd), 0),
    tokensIn: calls.reduce((n, c) => n + (c.prompt_tokens ?? 0), 0),
    tokensOut: calls.reduce((n, c) => n + (c.completion_tokens ?? 0), 0),
  };
}

const TOPIC_LABEL: Record<string, string> = {
  fire: "fire",
  drought: "drought",
  flood: "floods",
  pollution: "pollution",
  clearing: "clearing or construction",
  restoration: "restoration",
};

export function topicLabel(topic: string): string {
  return TOPIC_LABEL[topic] ?? topic;
}

/** "Mar–Aug 2026", or "Nov 2024–Mar 2025" across a year. */
export function monthRange(start: string, end: string): string {
  const [sy, sm] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))];
  const [ey, em] = [Number(end.slice(0, 4)), Number(end.slice(5, 7))];
  if (!sy || !sm || !ey || !em) return `${start}–${end}`;
  return sy === ey
    ? `${MONTHS[sm - 1]}–${MONTHS[em - 1]} ${ey}`
    : `${MONTHS[sm - 1]} ${sy}–${MONTHS[em - 1]} ${ey}`;
}

const ANSWERS: Record<string, string> = {
  yes: "answers the question",
  partly: "partly answers it",
  no: "doesn't answer it",
};

export function readVerdict(f: ReadFollowUp): string {
  return [
    f.namesSite ? "names the site" : "doesn't name the site",
    f.month ? `event in ${f.month}` : null,
    f.answers ? (ANSWERS[f.answers] ?? f.answers) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type EvidenceRef = {
  id: string;
  kind: "fact" | "image" | "news" | "evidence" | "unknown";
  label: string;
  value: string | null;
  url: string | null;
  date: string | null;
  direction: number | null;
  /** Set when the run had the full article read (an investigation follow-up). */
  read?: { namesSite: boolean; answers: string; month: string | null } | null;
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
  if (item.kind === "image")
    return {
      id,
      kind: "image",
      label: "Satellite image reading",
      value: (item.value as string | null) ?? null,
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
  const read = item.read as Output | undefined;
  return {
    id,
    kind: item.kind === "evidence" ? "evidence" : "news",
    label: String(item.title ?? "News report"),
    value: (item.impact_type as string | null) ?? null,
    url: (item.url as string | null) ?? null,
    date: (item.published_at as string | null) ?? null,
    direction: item.direction == null ? null : num(item.direction),
    read: read
      ? {
          namesSite: Boolean(read.names_site),
          answers: String(read.answers ?? ""),
          month: (read.month as string | null) ?? null,
        }
      : null,
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
  /** Pages opened with Tavily Extract during the follow-ups. */
  reads: number;
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
  const followUps = runFollowUps(trace);
  const searches = [
    ...runSearches(trace),
    ...followUps.flatMap((f) => (f.kind === "search" ? f.searches : [])),
  ];
  const reads = followUps.filter((f) => f.kind === "read" && f.status === "ok");
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
    reads: reads.length,
    credits:
      searches.reduce((n, s) => n + s.credits, 0) +
      reads.reduce((n, f) => n + (f.kind === "read" ? f.credits : 0), 0),
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

/** `showCost: false` (a no-sign-up demo session) tells the run without what it cost. */
export function runStory(
  trace: RunTrace,
  { showCost = true }: { showCost?: boolean } = {},
): StoryLine[] {
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

  const vision = runVision(trace);
  const visionCall = ownCalls(earth, "site_vision").findLast(
    (c) => c.status === "ok",
  );
  if (vision && !vision.error) {
    const confirmed = vision.changes.filter((c) => c.agrees).length;
    const real = vision.changes.filter((c) => c.kind !== "no_clear_change");
    lines.push({
      key: "vision",
      actor: "vision",
      text: real.length
        ? `${modelLabel(visionCall?.model ?? vision.model)} compared the site's satellite views five years apart and described ${real.length} change${real.length === 1 ? "" : "s"}; code confirmed ${confirmed} against the data.`
        : `${modelLabel(visionCall?.model ?? vision.model)} compared the site's satellite views five years apart and saw no clear change, which code checked against the data.`,
      details: vision.changes.map(
        (c) =>
          `${changeLabel(c.kind)} (${c.where}, ${c.confidence}): ${c.note} — ${c.check}`,
      ),
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

  const plan = runPlan(trace);
  const followUps = runFollowUps(trace);
  if (plan || followUps.length) {
    const who = modelLabel(plan?.model);
    const thought = plan?.reasoningTokens
      ? ` (${plan.reasoningTokens.toLocaleString("en-US")} reasoning tokens)`
      : "";
    const parts = followUps.map((f) =>
      f.kind === "search"
        ? `searched local news for ${topicLabel(f.topic)}${f.window ? ` in ${monthRange(f.window.start, f.window.end)}` : ""} (${f.status === "ok" ? `${f.found.length} new` : "failed"})`
        : `had an article read (${f.status === "ok" ? readVerdict(f) : "it couldn't be read"})`,
    );
    lines.push({
      key: "followup",
      actor: "super",
      text: parts.length
        ? `${who} compared the satellite signals with the news${thought} and followed up: ${parts.join("; ")}.`
        : `${who} compared the satellite signals with the news${thought} and found nothing to follow up.`,
      details: followUps.map((f) => `Why: ${f.why}`),
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
      text: showCost
        ? `The report was sealed in the Record. The run took ${seconds(done.latency_ms)} and cost ${usd(receipt.totalUsd, 3)} in model calls${receipt.savedPct ? `, ${receipt.savedPct}% less than running every call on Ultra` : ""}.`
        : `The report was sealed in the Record. The run took ${seconds(done.latency_ms)}.`,
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
  plan: "Plan the follow-up",
  investigate: "Follow up",
  evidence: "Field evidence",
  audit: "The audit",
};

const CHOSE: Record<string, string> = {
  search_news: "search the news again",
  read_article: "read an article",
  auditor: "go to the audit",
  field_evidence: "check the field photos",
};

export function runFlow(trace: RunTrace): FlowNode[] {
  const nodes: FlowNode[] = [];
  const followUps = runFollowUps(trace);
  let followUp = 0;
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
        : step.step === "investigate"
          ? {
              actor: "super" as Actor,
              text: "Nemotron 3 Super chose it in its plan",
              latencyMs: null,
            }
          : null;
    const base: FlowNode = {
      id: step.step === "investigate" ? `investigate-${followUp}` : step.step,
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
      const vision = runVision(trace);
      const seeing = ownCalls(step, "site_vision");
      const visionNodes = seeing.length
        ? [
            callNode(
              "vision",
              seeing.at(-1)!,
              "Compare the images",
              vision?.error
                ? "the reading failed; the run went on without it"
                : `${vision?.overall ?? "unclear"} · ${vision?.changes.filter((c) => c.agrees).length ?? 0} change(s) confirmed by code`,
            ),
          ]
        : [];
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
      base.children = [...visionNodes, ...base.children];
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
    } else if (step.step === "plan") {
      const plan = runPlan(trace);
      base.actor = "super";
      base.decision = null;
      base.summary = plan?.chose.length
        ? `thought it through · chose to ${plan.chose.map((c) => CHOSE[c] ?? c).join(", then ")}`
        : "thought it through";
      base.latencyMs = plan?.latencyMs ?? null;
    } else if (step.step === "investigate") {
      const f = followUps[followUp];
      followUp += 1;
      if (f?.kind === "search") {
        base.actor = "tavily";
        base.title = `Search again: ${topicLabel(f.topic)}`;
        base.summary =
          f.status === "ok"
            ? `${f.window ? `${monthRange(f.window.start, f.window.end)} · ` : ""}${f.found.length} new · ${f.alreadyKnown} already known`
            : `failed (${f.error ?? "error"})`;
        base.children = [
          ...f.searches.map((s, i) => ({
            ...base,
            id: `${base.id}-search-${i}`,
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
          ...ownCalls(step, "news_scout").map((c, i) =>
            callNode(
              `${base.id}-classify-${i}`,
              c,
              "Sort the articles",
              `${f.found.length} new on this site`,
            ),
          ),
        ];
      } else if (f?.kind === "read") {
        base.actor = "tavily";
        base.title = "Read an article";
        base.summary =
          f.status === "ok"
            ? readVerdict(f)
            : `couldn't be read (${f.error ?? "error"})`;
        base.children =
          f.status === "ok"
            ? [
                {
                  ...base,
                  id: `${base.id}-extract`,
                  title: "Open the page",
                  summary: `${f.charsRead.toLocaleString("en-US")} characters, ranked for the question`,
                  latencyMs: f.extractMs,
                  decision: null,
                  children: [],
                },
                ...ownCalls(step, "article_reader").map((c, i) =>
                  callNode(
                    `${base.id}-reader-${i}`,
                    c,
                    "Answer the question",
                    f.answers ? (ANSWERS[f.answers] ?? f.answers) : "",
                  ),
                ),
                {
                  ...base,
                  id: `${base.id}-check`,
                  actor: "code" as Actor,
                  title: "Check the answer",
                  summary: `${f.namesSite ? "place confirmed" : "place not confirmed"} · ${f.quoteChecked ? "quote found on the page" : "no quote found on the page"}`,
                  latencyMs: null,
                  decision: null,
                  children: [],
                },
              ]
            : [];
      }
    } else if (step.step === "evidence") {
      base.summary =
        step.status === "skipped"
          ? "No field photos for this site"
          : `${num(o.validated)} of ${num(o.items)} photos validated`;
    } else if (step.step === "done") {
      base.actor = "ledger";
      base.title = "Sealed";
      base.summary = "The report enters the hash-chained Record";
      base.latencyMs = null;
    }
    // The plan step's cost is the thinking turn itself; elsewhere the choosing turn is shown
    // as the decision, not counted in the step.
    const own = calls.filter(
      (c) => step.step === "plan" || c.agent !== "orchestrator",
    );
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
      const thinking = step.step === "plan";
      add(actorOf(c.model), {
        id: `${step.step}-plan-${c.id}`,
        label: thinking ? "plan (thinking)" : `chose ${step.tool ?? step.step}`,
        detail: `${modelLabel(c.model)}${thinking && c.completion_tokens ? ` · ${c.completion_tokens.toLocaleString("en-US")} out` : ""} · ${seconds(c.latency_ms)}`,
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
    } else if (step.step === "plan") {
      continue;
    } else if (step.step === "investigate") {
      const o = out(step);
      if (o.tool === "read_article") {
        add("tavily", {
          id: `extract-${step.ts}`,
          label: "open the page",
          detail: `Tavily Extract · ${seconds(num(o.extract_ms))}`,
          startMs: start,
          endMs: start + num(o.extract_ms),
          status: step.status,
        });
        for (const c of ownCalls(step, "article_reader"))
          add(actorOf(c.model), {
            id: `reader-${c.id}`,
            label: "read the article",
            detail: `${modelLabel(c.model)} · ${(c.prompt_tokens ?? 0).toLocaleString("en-US")} in · ${seconds(c.latency_ms)}`,
            startMs: Math.max(start, end - (c.latency_ms ?? 0)),
            endMs: end,
            status: c.status,
          });
      } else {
        searchesOf(o.searches).forEach((s, i) =>
          add("tavily", {
            id: `followup-${step.ts}-${i}`,
            label: `search: ${topicLabel(String(o.topic ?? ""))}`,
            detail: `“${s.query}” · ${s.results} results · ${seconds(s.latencyMs)}`,
            startMs: start,
            endMs: start + s.latencyMs,
            status: s.error ? "failed" : "ok",
          }),
        );
        for (const c of ownCalls(step, "news_scout"))
          add(actorOf(c.model), {
            id: `followup-${c.id}`,
            label: "sort articles",
            detail: `${modelLabel(c.model)} · ${(c.prompt_tokens ?? 0).toLocaleString("en-US")} in · ${seconds(c.latency_ms)}`,
            startMs: Math.max(start, end - (c.latency_ms ?? 0)),
            endMs: end,
            status: c.status,
          });
      }
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
      for (const c of ownCalls(step, "site_vision"))
        add(actorOf(c.model), {
          id: `vision-${c.id}`,
          label: "compare images",
          detail: `${modelLabel(c.model)} · ${(c.prompt_tokens ?? 0).toLocaleString("en-US")} in · ${seconds(c.latency_ms)}`,
          startMs: Math.max(start, end - (c.latency_ms ?? 0)),
          endMs: end,
          status: c.status,
        });
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

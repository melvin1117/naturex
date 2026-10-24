/**
 * The real Agent Trace (T34): turns `GET /runs/{run_id}/trace` (T28) into what the drawer
 * shows. Pure, so it is easy to test; the numbers are the backend's (tokens, latency, cost),
 * only summed here.
 */
import type { ReportOut, RunTrace, TraceCall } from "./api/types";
import { MODELS } from "./prototype/data";

export type TraceStepKind = "llm" | "tool" | "seal" | "event";

/** How each span of a run reads in the drawer. Unknown steps keep their raw name. */
const STEP_INFO: Record<
  string,
  { label: string; agent: string; kind: TraceStepKind }
> = {
  queued: { label: "Run queued", agent: "Rating runner", kind: "event" },
  started: {
    label: "Start the run",
    agent: "Orchestrator",
    kind: "event",
  },
  earth_obs: {
    label: "Read satellite metrics",
    agent: "earth_obs tool",
    kind: "tool",
  },
  valuation: {
    label: "Value ecosystem services",
    agent: "valuation tool",
    kind: "tool",
  },
  news: { label: "Scan local news", agent: "News Scout", kind: "tool" },
  evidence: {
    label: "Describe community photos",
    agent: "Field evidence",
    kind: "tool",
  },
  audit: {
    label: "Cross-check evidence and grade",
    agent: "Auditor",
    kind: "tool",
  },
  fallback: {
    label: "Switch to the fixed pipeline",
    agent: "Rating runner",
    kind: "event",
  },
  done: { label: "Seal the report", agent: "The Record", kind: "seal" },
};

const STATUS_LABEL: Record<string, string> = {
  ok: "Done",
  // A progress span records that its step started; tool steps report ok/failed/skipped.
  running: "Started",
  queued: "Queued",
  failed: "Failed",
  skipped: "Skipped",
  succeeded: "Succeeded",
  degraded: "Degraded",
  stale: "Stale",
};

export type TraceRow = {
  key: string;
  step: string;
  label: string;
  agent: string;
  kind: TraceStepKind;
  status: string;
  statusLabel: string;
  failed: boolean;
  /** The model that answered, or null for code-only steps. */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number | null;
  costUsd: number;
  attempts: number | null;
  error: string | null;
  output: Record<string, unknown> | null;
  calls: TraceCall[];
};

function decimalOrZero(value: string | null | undefined): number {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function traceRows(trace: RunTrace): TraceRow[] {
  return trace.steps.map((s, i) => {
    const info = STEP_INFO[s.step];
    const calls = s.llm_calls ?? [];
    // A span's own token fields can miss calls it carries (the `done` span holds the run's
    // closing calls with zero tokens of its own), so a span with calls reads from them.
    const fromCalls = calls.length > 0;
    return {
      key: `${i}-${s.step}`,
      step: s.step,
      label: info?.label ?? s.step,
      agent:
        s.pipeline === "fixed" && info?.kind === "event"
          ? "Fixed pipeline"
          : (info?.agent ?? s.tool ?? s.step),
      // A step that called a model reads as a model step, whatever its tool; sealing stays
      // the seal.
      kind:
        info?.kind === "seal"
          ? "seal"
          : fromCalls
            ? "llm"
            : (info?.kind ?? "tool"),
      status: s.status,
      statusLabel: STATUS_LABEL[s.status] ?? s.status,
      failed: s.status === "failed",
      model:
        s.model ??
        calls.findLast((c) => c.status === "ok" && c.model)?.model ??
        null,
      tokensIn: fromCalls
        ? calls.reduce((n, c) => n + (c.prompt_tokens ?? 0), 0)
        : (s.prompt_tokens ?? 0),
      tokensOut: fromCalls
        ? calls.reduce((n, c) => n + (c.completion_tokens ?? 0), 0)
        : (s.completion_tokens ?? 0),
      latencyMs: s.latency_ms ?? null,
      costUsd: fromCalls
        ? calls.reduce((n, c) => n + decimalOrZero(c.cost_usd), 0)
        : decimalOrZero(s.cost_usd),
      attempts: s.attempts ?? null,
      error: s.error ?? null,
      output: s.output ?? null,
      calls,
    };
  });
}

export type TraceTotals = {
  llmCalls: number;
  tokens: number;
  /** From the first to the last span when timestamps exist, else the summed step latencies. */
  durationMs: number | null;
  costUsd: number;
};

/**
 * The run's totals: the backend's own (`totals`, every call of a sealed run), else, while a
 * run is in flight or after it failed, the sum of each step's model calls.
 */
export function traceTotals(trace: RunTrace): TraceTotals {
  const rows = traceRows(trace);
  const times = trace.steps
    .map((s) => (s.ts ? Date.parse(s.ts) : NaN))
    .filter(Number.isFinite);
  const latencies = rows
    .map((r) => r.latencyMs)
    .filter((n): n is number => n !== null);
  const durationMs =
    times.length >= 2
      ? Math.max(...times) - Math.min(...times)
      : latencies.length
        ? latencies.reduce((a, b) => a + b, 0)
        : null;
  const sealed = trace.totals;
  if (sealed)
    return {
      llmCalls: sealed.llm_calls,
      tokens: sealed.prompt_tokens + sealed.completion_tokens,
      durationMs,
      costUsd: decimalOrZero(sealed.cost_usd),
    };
  return {
    llmCalls: rows.reduce((n, r) => n + r.calls.length, 0),
    tokens: rows.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0),
    durationMs,
    costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
  };
}

/** "Nemotron 3 Ultra" for a known Token Factory id (ADR-0003), else the id itself. */
export function modelName(id: string | null | undefined): string | null {
  if (!id) return null;
  const known = Object.values(MODELS).find(
    (m) => m.id.toLowerCase() === id.toLowerCase(),
  );
  return known?.name ?? id;
}

export type TraceRunOption = { runId: string; label: string };

/**
 * The runs the drawer can show for one asset, newest first: each report made by a rating run
 * (seeded reports have none), plus a listing's latest run under review and the run the
 * drawer was opened on, if they aren't already listed.
 */
export function runOptions(
  reports: readonly ReportOut[] | undefined,
  extra: readonly (string | null | undefined)[] = [],
): TraceRunOption[] {
  const options: TraceRunOption[] = [];
  const seen = new Set<string>();
  for (const id of extra) {
    if (!id || seen.has(id) || reports?.some((r) => r.run_id === id)) continue;
    seen.add(id);
    options.push({ runId: id, label: "Latest run" });
  }
  for (const r of reports ?? []) {
    if (!r.run_id || seen.has(r.run_id)) continue;
    seen.add(r.run_id);
    const day = r.created_at ? r.created_at.slice(0, 10) : null;
    options.push({
      runId: r.run_id,
      label: [`Proof of Life v${r.version}`, r.grade, day]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return options;
}

const ASSET_PATH =
  /^\/(?:asset|steward\/assets)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** The real asset a page is about (`/asset/<uuid>`, `/steward/assets/<uuid>/…`), or null. */
export function traceAssetFromPath(pathname: string | null): string | null {
  return (pathname && ASSET_PATH.exec(pathname)?.[1]) || null;
}

/**
 * Which Agent Trace the drawer shows: a real site's runs, the signed-in world's latest model
 * calls, or the scripted prototype's recorded runs (anonymous visitors away from a real site,
 * and the guided tour, which runs on the scripted world).
 */
export type TraceMode =
  | { kind: "asset"; assetId: string }
  | { kind: "world" }
  | { kind: "prototype" };

export function traceMode({
  pathname,
  signedIn,
  tourActive,
}: {
  pathname: string | null;
  signedIn: boolean;
  tourActive: boolean;
}): TraceMode {
  if (tourActive) return { kind: "prototype" };
  const assetId = traceAssetFromPath(pathname);
  if (assetId) return { kind: "asset", assetId };
  return signedIn ? { kind: "world" } : { kind: "prototype" };
}

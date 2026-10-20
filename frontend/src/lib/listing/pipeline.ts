/** A rating run (T27) as the listing flow's lit pipeline. */
import type { RatingRun, RatingRunStep } from "../api/types";

export const PIPELINE_STAGES = [
  { step: "queued", label: "Queued", detail: "Waiting for a rating worker" },
  {
    step: "earth_obs",
    label: "Satellite data",
    detail: "Five years of land cover",
  },
  {
    step: "valuation",
    label: "Valuation",
    detail: "What the land does, from tested formulas",
  },
  {
    step: "news",
    label: "Local news",
    detail: "News Scout reads recent reports",
  },
  {
    step: "evidence",
    label: "Field evidence",
    detail: "Your community's photos",
  },
  {
    step: "audit",
    label: "Audit",
    detail: "An AI auditor cross-checks it all",
  },
  {
    step: "done",
    label: "Sealed report",
    detail: "Stored with a ledger entry",
  },
] as const;

export type StageState = "waiting" | "running" | "done" | "failed" | "skipped";

export interface PipelineStage {
  step: string;
  label: string;
  detail: string;
  state: StageState;
  model: string | null;
  tool: string | null;
  latencyMs: number | null;
  error: string | null;
}

export type RunPhase = RatingRun["status"];

export interface PipelineView {
  phase: RunPhase;
  stages: PipelineStage[];
  /** The fixed pipeline took over from the orchestrator. */
  fallback: boolean;
  degraded: boolean;
  reasons: string[];
  error: string | null;
  /** The stage now running (not while queued), for the status line. */
  current: string | null;
}

const PHASES = new Set<string>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "degraded",
]);
const STATE_OF: Record<string, StageState> = {
  ok: "done",
  succeeded: "done",
  degraded: "done",
  failed: "failed",
  skipped: "skipped",
  running: "running",
};

/**
 * The pipeline as the screen shows it, from the run as `GET /runs/{id}` rebuilds it (live
 * `rating_progress` events only trigger a refetch, so duplicates, replays and their order don't
 * matter). Last step of each name wins. The orchestrator may call tools in any order; while the
 * run works, the first tool without a result shows as running.
 */
export function pipelineView(run: RatingRun | undefined): PipelineView {
  const steps = run?.steps ?? [];
  const last = new Map<string, RatingRunStep>();
  for (const step of steps) last.set(step.step, step);
  const done = last.get("done");
  let phase: RunPhase = run?.status ?? "queued";
  if (done && PHASES.has(done.status)) phase = done.status as RunPhase;
  else if (phase === "queued" && steps.some((s) => s.step !== "queued"))
    phase = "running";
  const active = phase === "queued" || phase === "running";

  let runningMarked = false;
  const stages = PIPELINE_STAGES.map(
    ({ step, label, detail }): PipelineStage => {
      const own = last.get(step);
      let state: StageState;
      if (step === "queued") {
        state = phase === "queued" ? "running" : "done";
      } else if (own) {
        state = STATE_OF[own.status] ?? "running";
      } else if (step === "done") {
        state = "waiting";
      } else if (active) {
        state = phase === "running" && !runningMarked ? "running" : "waiting";
      } else {
        state = "skipped";
      }
      if (state === "running") runningMarked = true;
      return {
        step,
        label,
        detail,
        state,
        model: own?.model ?? null,
        tool: own?.tool ?? null,
        latencyMs: own?.latency_ms ?? null,
        error: own?.error ?? null,
      };
    },
  );
  return {
    phase,
    stages,
    fallback: last.has("fallback"),
    degraded: phase === "degraded" || Boolean(run?.degraded),
    reasons: run?.reasons ?? [],
    error: run?.error ?? done?.error ?? null,
    current:
      phase === "running"
        ? (stages.find((s) => s.state === "running")?.label ?? null)
        : null,
  };
}

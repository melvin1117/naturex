/**
 * Pacing for the rating pipeline (#216): a run's steps often finish in a burst (a mock run takes
 * about two seconds), so the screen replays them one at a time. The paced view only ever lags the
 * real one: a step shows as finished only once the run says so, and nothing is added.
 */
import type { PipelineStage, PipelineView, StageState } from "./pipeline";

/** Milliseconds between two steps lighting up: long enough to read the step's name. */
export const PIPELINE_STEP_MS = 400;
/** How long the finished pipeline stays on screen before the listed step replaces it. */
export const PIPELINE_SETTLE_MS = 900;

const FINISHED = new Set<StageState>(["done", "failed", "skipped"]);

export function isFinished(state: StageState): boolean {
  return FINISHED.has(state);
}

/** The run is still going (queued or running). */
export function isActive(view: PipelineView): boolean {
  return view.phase === "queued" || view.phase === "running";
}

/** How many of the run's steps have finished (done, failed or not run). */
export function finishedSteps(view: PipelineView): number {
  return view.stages.filter((stage) => isFinished(stage.state)).length;
}

/**
 * The pipeline with only the first `shown` finished steps revealed, in pipeline order. The next
 * finished step shows as still running if it ran (done or failed), else as waiting (a step that
 * was skipped never ran); every later step waits. Until all finished steps are revealed the run
 * reads as running, so its outcome lands after its last step.
 */
export function pacedView(view: PipelineView, shown: number): PipelineView {
  if (shown >= finishedSteps(view)) return view;
  let revealed = 0;
  let held: PipelineStage | null = null;
  const stages = view.stages.map((stage): PipelineStage => {
    if (held) return hide(stage, "waiting");
    if (!isFinished(stage.state)) return stage;
    if (revealed < shown) {
      revealed += 1;
      return stage;
    }
    held = stage;
    return hide(stage, stage.state === "skipped" ? "waiting" : "running");
  });
  const running = stages.find((stage) => stage.state === "running");
  return {
    ...view,
    phase: "running",
    stages,
    error: null,
    current: running?.label ?? null,
  };
}

function hide(stage: PipelineStage, state: StageState): PipelineStage {
  return {
    ...stage,
    state,
    latencyMs: null,
    error: null,
    model: state === "running" ? stage.model : null,
  };
}

/** "Step 3 of 7": the step now running, else the last one shown as finished. */
export function stepPosition(view: PipelineView): {
  step: number;
  of: number;
  label: string | null;
} {
  const of = view.stages.length;
  const running = view.stages.findIndex((stage) => stage.state === "running");
  if (running >= 0)
    return { step: running + 1, of, label: view.stages[running].label };
  const finished = view.stages.filter((stage) => isFinished(stage.state));
  return {
    step: finished.length,
    of,
    label: finished.at(-1)?.label ?? null,
  };
}

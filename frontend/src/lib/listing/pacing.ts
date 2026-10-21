/**
 * Pacing for the rating pipeline (#216): a run's steps often finish in a burst (a mock run takes
 * about two seconds), so the screen replays them one at a time. The paced view only ever lags the
 * real one: a step shows as finished only once the run says so, and nothing is added. Only steps
 * that ran (done or failed) take a beat; a step that wasn't run shows with the step before it.
 */
import type { PipelineStage, PipelineView, StageState } from "./pipeline";

/** Milliseconds between two steps lighting up: long enough to read the step's name. */
export const PIPELINE_STEP_MS = 400;
/** How long the finished pipeline stays on screen before the listed step replaces it. */
export const PIPELINE_SETTLE_MS = 900;

const RAN = new Set<StageState>(["done", "failed"]);
const FINISHED = new Set<StageState>(["done", "failed", "skipped"]);

/** The run is still going (queued or running). */
export function isActive(view: PipelineView): boolean {
  return view.phase === "queued" || view.phase === "running";
}

/** How many of the run's steps ran to an end (done or failed): the beats of the replay. */
export function ranSteps(view: PipelineView): number {
  return view.stages.filter((stage) => RAN.has(stage.state)).length;
}

/**
 * The pipeline with only the first `shown` steps that ran revealed, in pipeline order; a step
 * that wasn't run shows once every step before it has. The next step that ran shows as still
 * running and every later step waits. Until all are revealed the run reads as running, so its
 * outcome (and any error) lands after its last step.
 */
export function pacedView(view: PipelineView, shown: number): PipelineView {
  if (shown >= ranSteps(view)) return view;
  let revealed = 0;
  let held = false;
  const stages = view.stages.map((stage): PipelineStage => {
    if (held) return hide(stage, "waiting");
    if (!RAN.has(stage.state)) return stage;
    if (revealed < shown) {
      revealed += 1;
      return stage;
    }
    held = true;
    return hide(stage, "running");
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

/** The step a failed run stopped at, if the run says which. */
export function failedStage(view: PipelineView): PipelineStage | null {
  return view.stages.find((stage) => stage.state === "failed") ?? null;
}

/**
 * "Step 3 of 7": the step now running, else the last one shown as finished. Null for a failed
 * run: its header names the step it stopped at instead of a progress count.
 */
export function stepPosition(
  view: PipelineView,
): { step: number; of: number; label: string | null } | null {
  if (view.phase === "failed") return null;
  const of = view.stages.length;
  const running = view.stages.findIndex((stage) => stage.state === "running");
  if (running >= 0)
    return { step: running + 1, of, label: view.stages[running].label };
  const finished = view.stages.filter((stage) => FINISHED.has(stage.state));
  return {
    step: finished.length,
    of,
    label: finished.at(-1)?.label ?? null,
  };
}

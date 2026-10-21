/** The listing flow's rating run, paced for reading (#216). */
import { useEffect, useState } from "react";

import type { AssetDetail } from "../api/types";
import { usePacedCount, usePrefersReducedMotion } from "../motion";
import {
  isActive,
  PIPELINE_SETTLE_MS,
  PIPELINE_STEP_MS,
  pacedView,
  ranSteps,
} from "./pacing";
import type { PipelineView } from "./pipeline";

/**
 * The run as the screen shows it. A run this tab watched (submitted here, or found still going)
 * replays its steps one at a time; a run that had already ended shows as it is.
 *
 * `holding` asks the screen to keep the run up (not the listed step yet) from the first sight of
 * a watched run until its replay has caught up and settled for `PIPELINE_SETTLE_MS`. It settles
 * when the run has ended, or when the listing has moved on (`assetStatus` is no longer `rating`)
 * and the replay has caught up with what the run last said, so a stale or failing run query
 * can't keep it up. And once the listing has moved on it never lasts longer than a full replay:
 * the remaining steps × `PIPELINE_STEP_MS` + `PIPELINE_SETTLE_MS`. Reduced motion: no pacing,
 * no hold.
 */
export function usePacedRun({
  runId,
  view,
  loaded,
  submitted,
  assetStatus,
}: {
  runId: string | null;
  view: PipelineView | null;
  /** The run has been read at least once (`view` isn't a placeholder). */
  loaded: boolean;
  /** This tab submitted the run. */
  submitted: boolean;
  assetStatus: AssetDetail["status"];
}): { view: PipelineView | null; live: boolean; holding: boolean } {
  const reduced = usePrefersReducedMotion();
  const [watched, setWatched] = useState<{
    runId: string;
    live: boolean;
  } | null>(null);
  // Decided on the run's first read; used in this very render, so a run that is already
  // finished when first read (a fast mock run) still replays from its first step.
  let decided = watched?.runId === runId ? watched : null;
  if (runId && view && loaded && !decided) {
    decided = { runId, live: submitted || isActive(view) };
    setWatched(decided);
  }
  const live = decided?.live ?? false;
  const target = view ? ranSteps(view) : 0;
  const shown = usePacedCount(target, PIPELINE_STEP_MS, {
    paced: live,
    resetKey: runId,
  });

  const caughtUp = shown >= target;
  const moved = assetStatus !== "rating" && assetStatus !== "draft";
  const settling =
    live &&
    !reduced &&
    caughtUp &&
    ((view !== null && !isActive(view)) || moved);
  const [released, setReleased] = useState<string | null>(null);
  useEffect(() => {
    if (!settling || !runId) return;
    const timer = setTimeout(() => setReleased(runId), PIPELINE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling, runId]);

  // The cap, from the moment the listing moved on: computed once, never pushed back.
  const stages = view?.stages.length ?? 0;
  const [cap, setCap] = useState<{ runId: string; ms: number } | null>(null);
  if (live && !reduced && moved && runId && cap?.runId !== runId)
    setCap({
      runId,
      ms: Math.max(0, stages - shown) * PIPELINE_STEP_MS + PIPELINE_SETTLE_MS,
    });
  const capMs = cap?.runId === runId && moved ? cap.ms : null;
  useEffect(() => {
    if (capMs === null || !runId) return;
    const timer = setTimeout(() => setReleased(runId), capMs);
    return () => clearTimeout(timer);
  }, [capMs, runId]);

  return {
    view: view && live ? pacedView(view, shown) : view,
    live,
    holding: live && !reduced && released !== runId,
  };
}

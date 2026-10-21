import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetDetail, RatingRun } from "@/lib/api/types";
import { pipelineView, type PipelineView } from "@/lib/listing";
import {
  PIPELINE_SETTLE_MS,
  PIPELINE_STEP_MS,
  ranSteps,
} from "@/lib/listing/pacing";
import { usePacedRun } from "@/lib/listing/use-paced-run";

import { stubMotion } from "../motion";

const RUN_A = "88888888-8888-4888-8888-888888888881";
const RUN_B = "88888888-8888-4888-8888-888888888882";

const step = (name: string, status: string) => ({
  step: name,
  status,
  prompt_tokens: 0,
  completion_tokens: 0,
});

function view(status: RatingRun["status"], names: [string, string][]) {
  return pipelineView({
    run_id: RUN_A,
    asset_id: "33333333-3333-4333-8333-333333333333",
    status,
    degraded: false,
    reasons: [],
    steps: names.map(([name, s]) => step(name, s)),
  });
}

const RUNNING = view("running", [
  ["queued", "queued"],
  ["earth_obs", "ok"],
]);
const FINISHED = view("succeeded", [
  ["queued", "queued"],
  ["earth_obs", "ok"],
  ["valuation", "ok"],
  ["news", "ok"],
  ["audit", "ok"],
  ["done", "succeeded"],
]);
const FAILED = view("failed", [
  ["queued", "queued"],
  ["earth_obs", "failed"],
  ["done", "failed"],
]);

type Props = {
  runId: string | null;
  view: PipelineView | null;
  loaded: boolean;
  submitted: boolean;
  assetStatus: AssetDetail["status"];
};

const base: Props = {
  runId: RUN_A,
  view: RUNNING,
  loaded: true,
  submitted: true,
  assetStatus: "rating",
};

let motion: ReturnType<typeof stubMotion> | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  motion = stubMotion();
});
afterEach(() => {
  vi.useRealTimers();
  motion?.restore();
});

async function advance(ms: number, tick = 50) {
  let left = ms;
  do {
    const step = Math.min(tick, left);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
    left -= step;
  } while (left > 0);
}

const ran = (v: PipelineView | null) => (v ? ranSteps(v) : 0);

describe("usePacedRun (#216)", () => {
  it("a listed site with a stale run query still releases the hold", async () => {
    // The run query stopped answering at "running" (two steps), but the listing is listed.
    const { result } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, assetStatus: "listed" },
    });
    expect(result.current.holding).toBe(true);
    await advance(2 * PIPELINE_STEP_MS);
    expect(ran(result.current.view)).toBe(2);
    expect(result.current.holding).toBe(true);
    await advance(PIPELINE_SETTLE_MS + 50);
    expect(result.current.holding).toBe(false);
  });

  it("holds a running run while the listing is still rating", async () => {
    const { result } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: base,
    });
    await advance(5000);
    expect(result.current.holding).toBe(true);
  });

  it("caps the hold from the listing's change, even if the replay never catches up", async () => {
    // A run that keeps reporting a new step faster than the replay can show them.
    let stages = RUNNING.stages.map((s) => ({ ...s, state: "done" as const }));
    const growing = (): PipelineView => ({ ...RUNNING, stages });
    const { result, rerender } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: growing(), assetStatus: "listed" },
    });
    // Cap: 7 steps × the beat + the settle, from the change (shown was 0).
    const cap = 7 * PIPELINE_STEP_MS + PIPELINE_SETTLE_MS;
    for (let t = 0; t < cap - 200; t += 200) {
      stages = [...stages, { ...stages[0]!, step: `extra-${t}` }];
      rerender({ ...base, view: growing(), assetStatus: "listed" });
      await advance(200);
    }
    expect(result.current.holding).toBe(true);
    await advance(400);
    expect(result.current.holding).toBe(false);
  });

  it("a failed run holds until its failed step has shown and settled", async () => {
    const { result } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: FAILED },
    });
    expect(result.current.view?.phase).toBe("running");
    expect(result.current.holding).toBe(true);
    await advance(3 * PIPELINE_STEP_MS);
    expect(result.current.view?.phase).toBe("failed");
    expect(result.current.holding).toBe(true);
    await advance(PIPELINE_SETTLE_MS + 50);
    expect(result.current.holding).toBe(false);
  });

  it("clears its timers when it unmounts during the hold", async () => {
    const { result, unmount } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: FINISHED, assetStatus: "listed" },
    });
    await advance(PIPELINE_STEP_MS);
    expect(result.current.holding).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a run superseded mid-replay shows the new run, never the old one's steps", async () => {
    const { result, rerender } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: FINISHED },
    });
    await advance(2 * PIPELINE_STEP_MS);
    expect(ran(result.current.view)).toBeGreaterThan(0);
    // Another run of the listing starts (not submitted here); it has one step so far.
    const next = view("queued", [["queued", "queued"]]);
    rerender({ ...base, runId: RUN_B, view: next, submitted: false });
    expect(ran(result.current.view)).toBe(0);
    expect(
      result.current.view?.stages.find((s) => s.step === "audit")?.state,
    ).toBe("waiting");
    expect(result.current.live).toBe(true);
  });

  it('"Try the rating again" replays the new run from its first step', async () => {
    const { result, rerender } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: FAILED },
    });
    await advance(3 * PIPELINE_STEP_MS + PIPELINE_SETTLE_MS + 50);
    expect(result.current.holding).toBe(false);
    // The retry's run has already finished when first read (a fast mock run).
    rerender({ ...base, runId: RUN_B, view: FINISHED });
    expect(ran(result.current.view)).toBe(0);
    expect(result.current.holding).toBe(true);
    await advance(0);
    expect(ran(result.current.view)).toBe(1);
    await advance(6 * PIPELINE_STEP_MS);
    expect(ran(result.current.view)).toBe(6);
  });

  it("a run that had ended before this tab read it isn't replayed or held", () => {
    const { result } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: FINISHED, submitted: false },
    });
    expect(result.current.view).toBe(FINISHED);
    expect(result.current.live).toBe(false);
    expect(result.current.holding).toBe(false);
  });

  it("under reduced motion shows the run as it is and never holds", () => {
    motion!.set(true);
    const { result } = renderHook((p: Props) => usePacedRun(p), {
      initialProps: { ...base, view: FINISHED, assetStatus: "listed" },
    });
    expect(result.current.view).toBe(FINISHED);
    expect(result.current.live).toBe(true);
    expect(result.current.holding).toBe(false);
  });
});

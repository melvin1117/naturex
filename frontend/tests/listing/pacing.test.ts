import { describe, expect, it } from "vitest";

import type { RatingRun } from "@/lib/api/types";
import { PIPELINE_STAGES, pipelineView } from "@/lib/listing";
import {
  failedStage,
  pacedView,
  ranSteps,
  stepPosition,
} from "@/lib/listing/pacing";

const RAN = new Set(["done", "failed"]);

const step = (name: string, status: string, extra: object = {}) => ({
  step: name,
  status,
  prompt_tokens: 0,
  completion_tokens: 0,
  ...extra,
});

function run(overrides: Partial<RatingRun>): RatingRun {
  return {
    run_id: "88888888-8888-4888-8888-888888888888",
    asset_id: "33333333-3333-4333-8333-333333333333",
    status: "succeeded",
    degraded: false,
    reasons: [],
    steps: [],
    ...overrides,
  };
}

/** A mock run's burst: every step finished by the time the screen first reads it. */
const BURST = pipelineView(
  run({
    steps: [
      step("queued", "queued"),
      step("earth_obs", "ok", { latency_ms: 1500 }),
      step("valuation", "ok", { latency_ms: 30, model: "nvidia/nemotron" }),
      step("news", "ok", { model: "nvidia/nemotron-super" }),
      step("audit", "ok", { latency_ms: 900 }),
      step("done", "succeeded"),
    ],
  }),
);

const FAILED = pipelineView(
  run({
    status: "failed",
    error: "earth_engine_unavailable",
    steps: [
      step("queued", "queued"),
      step("earth_obs", "failed", { error: "earth_engine_unavailable" }),
      step("done", "failed"),
    ],
  }),
);

describe("pacing the rating pipeline (#216)", () => {
  it("takes a beat only for steps that ran; the one not run doesn't count", () => {
    // queued, earth_obs, valuation, news, audit, done ran; evidence wasn't run.
    expect(ranSteps(BURST)).toBe(6);
    expect(BURST.stages.find((s) => s.step === "evidence")?.state).toBe(
      "skipped",
    );
  });

  it("never invents a step: at every pace it only lags the real run", () => {
    const real = new Map(BURST.stages.map((s) => [s.step, s]));
    for (let shown = 0; shown <= ranSteps(BURST); shown++) {
      const paced = pacedView(BURST, shown);
      // The same steps, in the same order.
      expect(paced.stages.map((s) => s.step)).toEqual(
        PIPELINE_STAGES.map((s) => s.step),
      );
      // A step reads finished only if the run finished it, and exactly as the run did.
      for (const stage of paced.stages) {
        if (
          stage.state === "done" ||
          stage.state === "failed" ||
          stage.state === "skipped"
        )
          expect(stage).toEqual(real.get(stage.step));
        else expect(stage.latencyMs).toBeNull();
      }
      expect(paced.stages.filter((s) => RAN.has(s.state))).toHaveLength(shown);
      // At most one step shows as running: the next one to land.
      expect(
        paced.stages.filter((s) => s.state === "running").length,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("reads as running until its last step shows, then is the run itself", () => {
    const halfway = pacedView(BURST, 3);
    expect(halfway.phase).toBe("running");
    expect(halfway.current).toBe("Local news");
    expect(halfway.stages[3]).toMatchObject({
      state: "running",
      model: "nvidia/nemotron-super",
    });
    expect(pacedView(BURST, 6)).toBe(BURST);
    expect(pacedView(BURST, 99)).toBe(BURST);
  });

  it("shows a step that wasn't run together with the step before it", () => {
    // News (the 4th step that ran) lands: the evidence step after it shows "not run" with it.
    const paced = pacedView(BURST, 4);
    expect(paced.stages.find((s) => s.step === "news")?.state).toBe("done");
    expect(paced.stages.find((s) => s.step === "evidence")?.state).toBe(
      "skipped",
    );
    expect(paced.current).toBe("Audit");
    // Before news lands, evidence waits (it never shows as running).
    expect(
      pacedView(BURST, 3).stages.find((s) => s.step === "evidence")?.state,
    ).toBe("waiting");
  });

  it("hides a failure's error until the failed step shows", () => {
    const early = pacedView(FAILED, 1);
    expect(early.error).toBeNull();
    expect(early.phase).toBe("running");
    expect(early.stages[1]).toMatchObject({ state: "running", error: null });
    const landed = pacedView(FAILED, ranSteps(FAILED));
    expect(landed.error).toBe("earth_engine_unavailable");
    expect(failedStage(landed)?.label).toBe("Satellite data");
  });

  it("says which step of how many while it runs or after it finished", () => {
    expect(stepPosition(pacedView(BURST, 2))).toEqual({
      step: 3,
      of: 7,
      label: "Valuation",
    });
    expect(stepPosition(BURST)).toEqual({
      step: 7,
      of: 7,
      label: "Sealed report",
    });
    expect(stepPosition(pacedView(BURST, 0))).toEqual({
      step: 1,
      of: 7,
      label: "Queued",
    });
  });

  it("gives a failed run no step count: it never reads as 7 of 7", () => {
    expect(stepPosition(FAILED)).toBeNull();
    // While its replay still runs, the count follows the step running.
    expect(stepPosition(pacedView(FAILED, 1))).toEqual({
      step: 2,
      of: 7,
      label: "Satellite data",
    });
  });
});

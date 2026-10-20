import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  eventFailure,
  quarterFailure,
  ratingChange,
  stoppedText,
  trackQuarterRun,
  unavailableReason,
  type QuarterRun,
} from "@/lib/time-machine";

import { STATE } from "./fixtures";

const error = (
  code: string | null,
  status = 409,
  retry: number | null = null,
) => new ApiError(status, "Server said no.", code, code, retry);

describe("unavailableReason", () => {
  it("uses the API's flag when it sends one", () => {
    const off = { ...STATE, available: false } as typeof STATE;
    const on = { ...STATE, available: true } as typeof STATE;
    expect(unavailableReason(off, { kind: "persona" })).toMatch(/live world/);
    expect(unavailableReason(on, { kind: "person" })).toBeNull();
  });

  it("otherwise allows only a demo session's persona", () => {
    expect(unavailableReason(STATE, { kind: "persona" })).toBeNull();
    expect(unavailableReason(STATE, { kind: "person" })).toMatch(/live world/);
    expect(unavailableReason(STATE, null)).toMatch(/live world/);
  });
});

describe("failures", () => {
  it("asks for a refresh when the world moved", () => {
    expect(quarterFailure(error("quarter_mismatch")).refresh).toBe(true);
    expect(quarterFailure(error("timeline_end")).refresh).toBe(true);
    expect(eventFailure(error("stale_metrics")).refresh).toBe(true);
    expect(eventFailure(error("run_in_progress")).refresh).toBe(false);
  });

  it("states the wait for limits and busy raters", () => {
    expect(quarterFailure(error("rating_busy", 503, 30)).message).toBe(
      "Every rating worker is busy. Try again in 30 seconds.",
    );
    expect(eventFailure(error("rating_global_limit", 429)).message).toMatch(
      /Try again in a moment\./,
    );
  });

  it("falls back to the API's safe message", () => {
    const quarter = quarterFailure(error(null, 500));
    expect(quarter).toEqual({
      title: "The quarter didn't run",
      message: "Server said no.",
      refresh: false,
    });
    expect(eventFailure(error("something_new")).refresh).toBe(true);
  });
});

describe("stoppedText and ratingChange", () => {
  it("explains an early stop", () => {
    expect(stoppedText("llm_budget_exhausted")).toBe(
      "Stopped early: the AI budget is spent. Run the quarter again to finish the remaining sites.",
    );
    expect(stoppedText(null)).toBeNull();
  });

  it("reads the stored numbers, with gaps as null", () => {
    expect(
      ratingChange(
        {
          report_id: "r1",
          version: 1,
          simulated: false,
          health_score: "76.2",
          grade: "A",
          price: "21.47",
        },
        null,
      ),
    ).toEqual({
      health: [76.2, null],
      grade: ["A", null],
      price: [21.47, null],
    });
  });
});

describe("trackQuarterRun", () => {
  const queued = (run: string, trigger = "time_machine") => ({
    run_id: run,
    asset_id: `asset-${run}`,
    step: "queued",
    trigger,
  });

  it("follows the quarter's runs from queued to done, once", () => {
    let runs: ReadonlyMap<string, QuarterRun> = new Map();
    const fold = (payload: Record<string, unknown>) =>
      (runs = trackQuarterRun(runs, payload) ?? runs);
    fold(queued("a"));
    fold(queued("b", "api"));
    fold({ run_id: "b", asset_id: "asset-b", step: "done" });
    fold({ run_id: "a", asset_id: "asset-a", step: "valuation" });
    expect([...runs.entries()]).toEqual([
      ["a", { assetId: "asset-a", done: false }],
    ]);
    fold({ run_id: "a", asset_id: "asset-a", step: "done" });
    expect(runs.get("a")?.done).toBe(true);
    expect(
      trackQuarterRun(runs, { run_id: "a", asset_id: "asset-a", step: "done" }),
    ).toBeNull();
    expect(trackQuarterRun(runs, queued("a"))).toBeNull();
    expect(trackQuarterRun(runs, { step: "queued" })).toBeNull();
  });
});

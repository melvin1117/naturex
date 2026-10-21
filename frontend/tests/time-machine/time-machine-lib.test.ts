import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  alertBatches,
  eventFailure,
  MAX_ALERT_IDS,
  mergeSentAlerts,
  quarterFailure,
  quarterOutcomeText,
  quarterProgressText,
  ratingChange,
  stoppedText,
  trackQuarterRun,
  unavailableReason,
  type QuarterRun,
} from "@/lib/time-machine";

import { QUARTER, sentAlert, STATE } from "./fixtures";

const error = (
  code: string | null,
  status = 409,
  retry: number | null = null,
) => new ApiError(status, "Server said no.", code, code, retry);

describe("unavailableReason", () => {
  it("follows the API's availability", () => {
    expect(unavailableReason(STATE)).toBeNull();
    expect(
      unavailableReason({
        ...STATE,
        available: false,
        unavailable_reason: "time_machine_sandbox_only",
      }),
    ).toMatch(/live world/);
    expect(
      unavailableReason({
        ...STATE,
        available: false,
        unavailable_reason: null,
      }),
    ).toMatch(/live world/);
  });
});

describe("failures", () => {
  it("asks for a refresh when the world moved", () => {
    expect(quarterFailure(error("quarter_mismatch")).refresh).toBe(true);
    expect(quarterFailure(error("timeline_end")).refresh).toBe(true);
    expect(eventFailure(error("stale_metrics")).refresh).toBe(true);
    expect(eventFailure(error("run_in_progress")).refresh).toBe(false);
    expect(eventFailure(error("event_not_recorded", 503)).refresh).toBe(true);
    expect(eventFailure(error("time_machine_sandbox_only")).refresh).toBe(true);
  });

  it("never refetches for limits, busy raters or the budget", () => {
    for (const code of [
      "rating_rate_limited",
      "rating_global_limit",
      "rating_busy",
      "llm_budget_exhausted",
      "admin_only",
    ]) {
      expect(quarterFailure(error(code, 429)).refresh).toBe(false);
      expect(eventFailure(error(code, 429)).refresh).toBe(false);
    }
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
    expect(stoppedText("rating_busy")).toBe(
      "Stopped early: every rating worker was busy. Run the quarter again to finish the remaining sites.",
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

describe("quarter progress and outcome", () => {
  const names = new Map([["asset-a", "Xochimilco Wetland"]]);

  it("counts only the runs that started", () => {
    expect(quarterProgressText(new Map(), names)).toBe(
      "Starting the re-rates…",
    );
    expect(
      quarterProgressText(
        new Map([
          ["a", { assetId: "asset-a", done: true }],
          ["b", { assetId: "asset-b", done: false }],
        ]),
        names,
      ),
    ).toBe("Re-rating sites: 2 started, 1 done. Latest: Xochimilco Wetland.");
  });

  it("says what was done and skipped, and what a replay found done", () => {
    expect(quarterOutcomeText(QUARTER)).toBe("Q4 2026: 1 done, 1 skipped.");
    const [hero, forest] = QUARTER.assets;
    expect(
      quarterOutcomeText({
        ...QUARTER,
        replayed: true,
        assets: [
          { ...hero!, status: "already_done" },
          forest!,
          { ...forest!, status: "failed" },
          { ...forest!, status: "stopped" },
          { ...forest!, status: "in_progress" },
        ],
      }),
    ).toBe(
      "Q4 2026 (replayed): 0 done, 1 skipped, 1 already done, 1 failed, 1 still rating, 1 stopped.",
    );
  });
});

describe("sent alert batches", () => {
  it("asks for each id once, at most 50 per request", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `a${i}`);
    const batches = alertBatches([...ids, "a3"]);
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids);
    expect(MAX_ALERT_IDS).toBe(50);
    expect(alertBatches([])).toEqual([]);
  });

  it("merges the batches newest first, ties in their order", () => {
    const at = (id: string, created_at: string) =>
      sentAlert(id, { created_at });
    expect(
      mergeSentAlerts([
        [at("b1", "2026-10-20T10:00:00Z"), at("b2", "2026-10-20T09:00:00Z")],
        [at("c1", "2026-10-20T11:00:00Z"), at("c2", "2026-10-20T10:00:00Z")],
      ]).map((a) => a.id),
    ).toEqual(["c1", "b1", "c2", "b2"]);
  });
});

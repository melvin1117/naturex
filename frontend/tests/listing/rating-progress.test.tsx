import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RatingProgress } from "@/components/listing/rating-progress";
import type { RatingRun } from "@/lib/api/types";
import { pipelineView } from "@/lib/listing";
import { pacedView } from "@/lib/listing/pacing";

const RUN_ID = "88888888-8888-4888-8888-888888888888";

const step = (name: string, status: string, extra: object = {}) => ({
  step: name,
  status,
  prompt_tokens: 0,
  completion_tokens: 0,
  ...extra,
});

function view(status: RatingRun["status"], steps: ReturnType<typeof step>[]) {
  return pipelineView({
    run_id: RUN_ID,
    asset_id: "33333333-3333-4333-8333-333333333333",
    status,
    degraded: false,
    reasons: [],
    steps,
  });
}

const FINISHED = view("succeeded", [
  step("queued", "queued"),
  step("earth_obs", "ok"),
  step("valuation", "ok"),
  step("news", "ok"),
  step("audit", "ok"),
  step("done", "succeeded"),
]);

const FAILED = view("failed", [
  step("queued", "queued"),
  step("earth_obs", "failed", { error: "earth_engine_unavailable" }),
  step("done", "failed"),
]);

function renderProgress(
  v: Parameters<typeof RatingProgress>[0]["view"],
  onOpenTrace = vi.fn(),
) {
  render(<RatingProgress view={v} runId={RUN_ID} onOpenTrace={onOpenTrace} />);
  return onOpenTrace;
}

describe("RatingProgress (#216)", () => {
  it("says which step is running, to assistive tech too", () => {
    renderProgress(pacedView(FINISHED, 2));
    const bar = screen.getByRole("progressbar", { name: "Rating progress" });
    expect(bar).toHaveAttribute("aria-valuetext", "Step 3 of 7");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeCloseTo(
      (3 / 7) * 100,
    );
    expect(screen.getByText("Step 3 of 7 · Valuation")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Agents at work… Valuation.",
    );
    // Still running: no trace link yet.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("a failed run names the step it stopped at, with no step count", () => {
    renderProgress(FAILED);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The rating stopped at Satellite data.",
    );
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/of 7/)).not.toBeInTheDocument();
    const row = screen
      .getByText("Satellite data", { selector: "span" })
      .closest("li")!;
    expect(within(row).getByText("earth_engine_unavailable")).toBeVisible();
  });

  it("a finished run opens its own trace", () => {
    const onOpenTrace = renderProgress(FINISHED);
    expect(
      screen.getByRole("progressbar", { name: "Rating progress" }),
    ).toHaveAttribute("aria-valuetext", "Step 7 of 7");
    fireEvent.click(
      screen.getByRole("button", { name: /See every step in the Agent Trace/ }),
    );
    expect(onOpenTrace).toHaveBeenCalledWith(RUN_ID);
  });
});

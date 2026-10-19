import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradeBadge } from "@/components/proto/grade";
import { RatingPipeline } from "@/components/proto/rating-pipeline";
import { createInitialWorld } from "@/lib/prototype/world";

describe("GradeBadge", () => {
  it("has an accessible name", () => {
    render(<GradeBadge grade="A" health={76.2} />);
    expect(
      screen.getByRole("img", { name: /Grade A, health 76.2/ }),
    ).toBeInTheDocument();
  });
});

describe("RatingPipeline", () => {
  it("shows every step waiting until the run plays", () => {
    const run = createInitialWorld().runs[0];
    render(<RatingPipeline run={run} play={false} />);
    expect(screen.queryAllByText("done")).toHaveLength(0);
    expect(screen.getAllByText("waiting")).toHaveLength(run.steps.length);
  });
});

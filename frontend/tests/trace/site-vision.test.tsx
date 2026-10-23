import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteVisionView } from "@/components/trace/site-vision";
import type { Vision } from "@/lib/trace-view";

const VISION: Vision = {
  model: "nvidia/Nemotron-3.5-Super-VL",
  overall: "some_change",
  before: { water: "lagoon", vegetation: "green", built_or_bare: "a road" },
  after: { water: "lagoon", vegetation: "thinner", built_or_bare: "a road" },
  changes: [
    {
      id: "image:1",
      kind: "clearing",
      where: "north",
      confidence: "high",
      note: "edge cleared",
      agrees: true,
      check: "Agrees with the satellite metrics.",
    },
  ],
  error: null,
};

describe("SiteVisionView", () => {
  it("shows the two views the model compared, a live listing's included", () => {
    render(
      <SiteVisionView
        vision={VISION}
        views={{
          before: "/api/assets/x/views/before.webp?v=1",
          after: "/api/assets/x/views/after.webp?v=1",
          years: "2021–2026",
        }}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Five years earlier" }),
    ).toHaveAttribute("src", "/api/assets/x/views/before.webp?v=1");
    expect(
      screen.getByRole("img", { name: "Latest 12 months" }),
    ).toHaveAttribute("src", "/api/assets/x/views/after.webp?v=1");
  });

  it("shows the reading alone when the site has no views to show", () => {
    render(<SiteVisionView vision={VISION} views={null} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("lagoon", { exact: false })).toBeInTheDocument();
  });
});

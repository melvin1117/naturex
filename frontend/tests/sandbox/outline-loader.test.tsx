import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OutlineLoader } from "@/components/sandbox/outline-loader";

describe("the sandbox's opening outlines", () => {
  it("draws three real sites in turn, named, and stays out of the accessibility tree", () => {
    const { container } = render(<OutlineLoader />);
    const loop = container.querySelector(".outline-loop");
    expect(loop).toHaveAttribute("aria-hidden", "true");
    const paths = [...container.querySelectorAll("path")];
    expect(paths).toHaveLength(3);
    expect(paths.map((p) => p.style.animationDelay)).toEqual([
      "0s",
      "2.6s",
      "5.2s",
    ]);
    expect(paths.every((p) => p.getAttribute("pathLength") === "100")).toBe(
      true,
    );
    expect(
      [...container.querySelectorAll(".outline-name")].map(
        (n) => n.textContent,
      ),
    ).toEqual([
      "Hoh Rain Forest · Washington",
      "Curry Hammock Mangroves · Florida Keys",
      "Quinault Rain Forest · Washington",
    ]);
  });
});

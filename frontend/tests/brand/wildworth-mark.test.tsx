import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Lockup, WildWorthMark } from "@/components/brand";
import { MASTER_SCORE, clampScore, markGeometry, peakY } from "@/lib/brand";

describe("the reading's height", () => {
  it.each([
    [0, 80],
    [50, 48],
    [100, 16],
    [MASTER_SCORE, 30.336],
  ])("score %s ends at y %s", (score, y) => {
    expect(peakY(score)).toBeCloseTo(y, 6);
  });

  it("clamps scores outside 0–100", () => {
    expect(peakY(-12)).toBe(80);
    expect(peakY(140)).toBe(16);
    expect(clampScore(Number.NaN)).toBe(0);
  });

  it("draws the guidelines' two Ws and the reading to the score", () => {
    const g = markGeometry(MASTER_SCORE);
    expect(g.line).toBe(
      "M6 24 L17 76 L28 42 L39 76 L50 24 L61 76 L72 42 L83 76",
    );
    expect(g.reading).toBe("M83 76 L94 30.34");
    expect(g.dot).toEqual({ cx: 94, cy: 30.34, r: 6 });
    expect(g.strokeWidth).toBe(7.5);
  });

  it("draws the single W with the same reading and no dot", () => {
    const g = markGeometry(0, true);
    expect(g.line).toBe("M10 24 L30 78 L50 40 L70 78");
    expect(g.reading).toBe("M70 78 L90 80");
    expect(g.dot).toBeNull();
    expect(g.strokeWidth).toBe(11);
  });
});

describe("WildWorthMark", () => {
  it("is the single W below 24 px", () => {
    const { container } = render(
      <>
        <WildWorthMark size={23} label="small" />
        <WildWorthMark size={24} label="large" />
      </>,
    );
    const small = screen.getByRole("img", { name: "small" });
    const large = screen.getByRole("img", { name: "large" });
    expect(small).toHaveAttribute("data-variant", "single");
    expect(small.querySelector("circle")).toBeNull();
    expect(large).toHaveAttribute("data-variant", "double");
    expect(large.querySelector("circle")).toHaveAttribute("cy", "30.34");
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("takes the site's score and its grade colour", () => {
    render(<WildWorthMark score={63.8} reading="BBB" label="Site" />);
    const mark = screen.getByRole("img", { name: "Site" });
    const read = mark.querySelector(".ww-read")!;
    expect(read.getAttribute("d")).toBe("M83 76 L94 39.17");
    expect(read).toHaveStyle({ stroke: "var(--color-grade-bbb)" });
  });

  it("hides itself beside the wordmark", () => {
    const { container } = render(<WildWorthMark label="" />);
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("Lockup", () => {
  it("reads as one word, WildWorth", () => {
    render(
      <button type="button">
        <Lockup size={26} />
      </button>,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName("WildWorth");
  });

  it("uses the single W when the mark would be under 24 px", () => {
    const { container } = render(<Lockup size={16} />);
    expect(container.querySelector("svg")).toHaveAttribute(
      "data-variant",
      "single",
    );
  });
});

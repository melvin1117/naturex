import { describe, expect, it } from "vitest";

import { changePct, tonnesCo2 } from "@/lib/format";
import { stakeChart } from "@/lib/stake-chart";

const BOX = { width: 100, height: 50, pad: 0 };

describe("stakeChart", () => {
  it("needs two prices to draw a line", () => {
    expect(stakeChart([], null, BOX)).toBeNull();
    expect(stakeChart([20], 19, BOX)).toBeNull();
  });

  it("draws oldest to newest, highest at the top, inside the box", () => {
    const chart = stakeChart([10, 20, 15], null, BOX)!;
    expect(chart.line).toBe("M0 50L50 0L100 25");
    expect(chart.last).toEqual({ x: 100, y: 25 });
    expect(chart.area).toBe("M0 50L50 0L100 25L100 50L0 50Z");
    expect(chart.paidY).toBeNull();
  });

  it("puts what was paid on the same scale, widening it to fit", () => {
    // Paid above every price: the line sits below it, worth less than it cost.
    const chart = stakeChart([10, 15], 20, BOX)!;
    expect(chart.paidY).toBe(0);
    expect(chart.last.y).toBe(25);
  });

  it("centres a flat price rather than dividing by zero", () => {
    const chart = stakeChart([20, 20, 20], 20, BOX)!;
    expect(chart.line).toBe("M0 25L50 25L100 25");
    expect(chart.paidY).toBe(25);
  });

  it("keeps the paid line under every price when it cost less", () => {
    const chart = stakeChart([20, 30], 10, BOX)!;
    expect(chart.paidY).toBe(50);
    expect(chart.last.y).toBe(0);
  });
});

describe("changePct and tonnesCo2", () => {
  it.each([
    [0, "<0.01%"],
    [0.004, "<0.01%"],
    [-0.01, "0.01%"],
    [0.99, "0.99%"],
    [1, "1.0%"],
    [-12.345, "12.3%"],
  ])("changePct(%s) is %s", (value, text) => {
    expect(changePct(value)).toBe(text);
  });

  it.each([
    [0, "0.0 tCO₂"],
    [0.03, "<0.1 tCO₂"],
    [3.44, "3.4 tCO₂"],
    [12345.67, "12,345.7 tCO₂"],
  ])("tonnesCo2(%s) is %s", (value, text) => {
    expect(tonnesCo2(value)).toBe(text);
  });
});

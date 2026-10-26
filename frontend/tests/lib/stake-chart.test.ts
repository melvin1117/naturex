import { describe, expect, it } from "vitest";

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

  it("thins a long series, keeping the first and the last price", () => {
    const prices = Array.from({ length: 500 }, (_, i) => i);
    const chart = stakeChart(prices, null, BOX)!;
    expect(chart.line.match(/[ML]/g)).toHaveLength(120);
    expect(chart.line.startsWith("M0 50")).toBe(true);
    expect(chart.last).toEqual({ x: 100, y: 0 });
  });
});

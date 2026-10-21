import { describe, expect, it } from "vitest";

import type { MetricChange } from "@/lib/api/types";
import {
  formatMetricDelta,
  formatMetricValue,
  groupMetrics,
  metricDirection,
} from "@/lib/report-diff";

function metric(over: Partial<MetricChange>): MetricChange {
  return {
    id: "score:health",
    label: "Health score",
    group: "headline",
    unit: "/100",
    change: "changed",
    old: "76.20",
    new: "87.10",
    delta: "10.90",
    reason_refs: [],
    ...over,
  };
}

function row(over: Partial<MetricChange>) {
  const m = metric(over);
  return [
    formatMetricValue(m, m.old),
    formatMetricValue(m, m.new),
    formatMetricDelta(m),
  ];
}

describe("report diff formatting (#189)", () => {
  it("formats each API unit like the rest of the report", () => {
    expect(row({})).toEqual(["76.2 / 100", "87.1 / 100", "+10.9 pts"]);
    expect(row({ unit: "%", old: "70.0", new: "74.5", delta: "4.5" })).toEqual([
      "70.0%",
      "74.5%",
      "+4.5 pts",
    ]);
    expect(
      row({
        unit: "Int$/yr",
        old: "2400000",
        new: "2250000.00",
        delta: "-150000.00",
      }),
    ).toEqual(["$2.4M", "$2.3M", "−$150K"]);
    expect(
      row({ unit: "Int$", old: "51234.5", new: "52234.5", delta: "1000" }),
    ).toEqual(["$51,234.50", "$52,234.50", "+$1,000.00"]);
    expect(
      row({ unit: "Int$/yr", old: "78398", new: "79198", delta: "800" }),
    ).toEqual(["$78,398.00", "$79,198.00", "+$800.00"]);
    // Compact values get a compact delta, even below $100K.
    expect(
      row({ unit: "Int$/yr", old: "461645", new: "363417", delta: "-98228" }),
    ).toEqual(["$462K", "$363K", "−$98K"]);
    expect(row({ unit: "Int$", old: "10", new: "10.5", delta: "0.5" })).toEqual(
      ["$10.00", "$10.50", "+$0.50"],
    );
    expect(row({ unit: "points", old: "-2", new: "0", delta: "2" })).toEqual([
      "−2.0",
      "0.0",
      "+2.0 pts",
    ]);
    expect(
      row({
        group: "health",
        unit: "0-1",
        old: "0.9",
        new: "0.75",
        delta: "-0.15",
      }),
    ).toEqual(["90 / 100", "75 / 100", "−15 pts"]);
    expect(
      row({
        group: "confidence",
        unit: "0-1",
        old: "0.8",
        new: "0.65",
        delta: "-0.15",
      }),
    ).toEqual(["80%", "65%", "−15 pts"]);
    expect(
      row({ unit: "share", old: "0.012", new: "0.0345", delta: "0.0225" }),
    ).toEqual(["1.2%", "3.5%", "+2.3 pts"]);
    expect(
      row({ unit: "ha", old: "1200", new: "1180.5", delta: "-19.5" }),
    ).toEqual(["1,200 ha", "1,180.5 ha", "−19.5 ha"]);
    expect(
      row({ unit: "NDVI/yr", old: "0.0021", new: "-0.004", delta: "-0.0061" }),
    ).toEqual(["+0.0021", "−0.0040", "−0.0061"]);
    expect(
      row({ unit: "tCO2", old: "120000", new: "118500.4", delta: "-1499.6" }),
    ).toEqual(["120,000 tCO₂", "118,500 tCO₂", "−1,500 tCO₂"]);
    expect(
      row({ unit: "t C/ha", old: "40", new: "41.25", delta: "1.25" }),
    ).toEqual(["40 t C/ha", "41.3 t C/ha", "+1.3 t C/ha"]);
    expect(
      row({ unit: null, old: "0.71234", new: "0.7", delta: "-0.01234" }),
    ).toEqual(["0.712", "0.7", "−0.012"]);
    expect(row({ unit: "widgets", old: "1", new: "2", delta: "1" })).toEqual([
      "1 widgets",
      "2 widgets",
      "+1 widgets",
    ]);
  });

  it("shows whole percentages when the change is whole", () => {
    expect(row({ unit: "%", old: "70", new: "75", delta: "5" })).toEqual([
      "70%",
      "75%",
      "+5 pts",
    ]);
  });

  it("shows a zero value without a sign, but a zero change as ±", () => {
    expect(
      row({ unit: "NDVI/yr", old: "0", new: "0.0012", delta: "0.0012" }),
    ).toEqual(["0.0000", "+0.0012", "+0.0012"]);
    expect(row({ unit: "ha", old: "0", new: "0", delta: "0" })).toEqual([
      "0 ha",
      "0 ha",
      "±0 ha",
    ]);
  });

  it("never shows a non-zero change as zero: the smallest step, signed", () => {
    const tiny = (over: Partial<MetricChange>) =>
      formatMetricDelta(metric(over));
    expect(tiny({ unit: "/100", delta: "0.04" })).toBe("+<0.1 pts");
    expect(tiny({ unit: "%", delta: "-0.04" })).toBe("−<0.1 pts");
    expect(tiny({ unit: "Int$", delta: "0.004" })).toBe("+<$0.01");
    expect(tiny({ unit: "Int$/yr", delta: "-0.001" })).toBe("−<$0.01");
    expect(tiny({ unit: "points", delta: "0.01" })).toBe("+<0.1 pts");
    expect(tiny({ unit: "0-1", group: "health", delta: "0.0004" })).toBe(
      "+<0.1 pts",
    );
    expect(tiny({ unit: "0-1", group: "confidence", delta: "-0.0004" })).toBe(
      "−<0.1 pts",
    );
    expect(tiny({ unit: "share", delta: "0.0001" })).toBe("+<0.1 pts");
    expect(tiny({ unit: "ha", delta: "-0.02" })).toBe("−<0.1 ha");
    expect(tiny({ unit: "NDVI/yr", delta: "0.00004" })).toBe("+<0.0001");
    expect(tiny({ unit: "-100 to 100", delta: "-0.04" })).toBe("−<0.1");
    expect(tiny({ unit: "t/ha", delta: "0.01" })).toBe("+<0.1 t/ha");
    expect(tiny({ unit: "t C/ha", delta: "-0.01" })).toBe("−<0.1 t C/ha");
    expect(tiny({ unit: "tCO2", delta: "0.4" })).toBe("+<1 tCO₂");
    expect(tiny({ unit: "tCO2/yr", delta: "-0.2" })).toBe("−<1 tCO₂/yr");
    expect(tiny({ unit: null, delta: "0.0002" })).toBe("+<0.001");
    expect(tiny({ unit: "widgets", delta: "-0.0001" })).toBe("−<0.001 widgets");
    // At the rounding edge the step itself shows, not "<".
    expect(tiny({ unit: "/100", delta: "0.05" })).toBe("+0.1 pts");
    expect(tiny({ unit: "Int$", delta: "0.005" })).toBe("+$0.01");
  });

  it("says when a number appeared or went away, with no direction", () => {
    const added = metric({ change: "added", old: null, delta: null });
    expect(formatMetricValue(added, added.old)).toBe("—");
    expect(formatMetricDelta(added)).toBe("New");
    expect(metricDirection(added)).toBeNull();
    const removed = metric({ change: "removed", new: null, delta: null });
    expect(formatMetricDelta(removed)).toBe("Removed");
    expect(metricDirection(removed)).toBeNull();
  });

  it("points the arrow the way the API's delta moved", () => {
    expect(metricDirection(metric({ delta: "0.1" }))).toBe("up");
    expect(metricDirection(metric({ delta: "-0.1" }))).toBe("down");
    expect(metricDirection(metric({ delta: "0" }))).toBeNull();
  });

  it("groups rows in a fixed order and keeps the API's order inside a group", () => {
    const groups = groupMetrics([
      metric({ id: "metric:area_ha", group: "satellite" }),
      metric({ id: "score:confidence", group: "headline" }),
      metric({ id: "score:base_health", group: "health" }),
      metric({ id: "score:health", group: "headline" }),
    ]);
    expect(groups.map((g) => g.group)).toEqual([
      "headline",
      "health",
      "satellite",
    ]);
    expect(groups[0]!.rows.map((m) => m.id)).toEqual([
      "score:confidence",
      "score:health",
    ]);
    expect(groups[1]!.label).toBe("How the score is built");
  });
});

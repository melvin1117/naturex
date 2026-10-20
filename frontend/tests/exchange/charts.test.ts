import { describe, expect, it } from "vitest";

import {
  ChartTooltip,
  chartMarkers,
  markerPosition,
  ndviSummary,
  priceSeries,
  priceSummary,
} from "@/components/proto/charts";
import { prototypeFacts } from "@/lib/prototype/rating";
import { createInitialWorld, latestReport } from "@/lib/prototype/world";

const PRICES = [
  { t: "2026-10-19T00:00:00Z", price: 20, reason: "ipo" },
  { t: "2026-10-19T06:00:00Z", price: 21, reason: "order" },
  { t: "2026-10-19T12:00:00Z", price: 22, reason: "order" },
];

describe("priceSeries", () => {
  it("puts prices on a time axis and events on the price in force", () => {
    const { data, marks } = priceSeries(
      PRICES,
      [
        { id: "in", date: "2026-10-19T07:00:00Z", direction: -1 },
        { id: "before", date: "2026-10-18", direction: 1 },
        { id: "after", date: "2026-10-20", direction: 1 },
      ],
      false,
    );
    expect(data.map((d) => d.t)).toEqual(PRICES.map((p) => Date.parse(p.t)));
    // An event recorded after the last price sits on it; one before the first is left off.
    expect(marks.map((m) => [m.event.id, m.price])).toEqual([
      ["in", 21],
      ["after", 22],
    ]);
  });

  it("places an event at the moment it was recorded when it has one", () => {
    const { marks } = priceSeries(
      PRICES,
      [
        {
          id: "day",
          date: "2026-10-19",
          at: "2026-10-19T13:00:00Z",
          direction: -1,
        },
      ],
      false,
    );
    expect(marks.map((m) => [m.event.id, m.price])).toEqual([["day", 22]]);
  });

  it("numbers every marker in time order with a label", () => {
    const series = priceSeries(
      [...PRICES, { t: "2026-10-19T18:00:00Z", price: 19, reason: "rerate" }],
      [
        {
          id: "fire",
          date: "2026-10-19T17:00:00Z",
          direction: -1,
          title: "Fire at X (simulated)",
        },
        {
          id: "law",
          date: "2026-10-19T08:00:00Z",
          direction: 1,
          title: "New protection law",
        },
        { id: "quiet", date: "2026-10-19T09:00:00Z", direction: 0 },
      ],
      false,
    );
    expect(
      chartMarkers(series).map((m) => [m.n, m.kind, m.label, m.price]),
    ).toEqual([
      [1, "ipo", "Opening price", 20],
      [2, "event", "New protection law (positive)", 21],
      [3, "event", "News event", 21],
      [4, "event", "Fire at X (simulated) (negative)", 22],
      [5, "rerate", "Re-rated: price moved toward the new fair price", 19],
    ]);
  });

  it("spreads markers that sit on the same point", () => {
    const series = priceSeries(
      [...PRICES, { t: "2026-10-19T18:00:00Z", price: 19, reason: "rerate" }],
      [{ id: "fire", date: "2026-10-19T18:00:01Z", direction: -1 }],
      false,
    );
    expect(chartMarkers(series).map((m) => [m.kind, m.stack])).toEqual([
      ["ipo", 0],
      ["rerate", 0],
      ["event", 1],
    ]);
  });

  it("keeps the last price per day when asked", () => {
    const { data } = priceSeries(PRICES, [], true);
    expect(data.map((d) => d.price)).toEqual([22]);
  });

  it("summarises the series in text", () => {
    const { data } = priceSeries(PRICES, [], false);
    expect(priceSummary(data)).toBe(
      "Stake price, 3 recorded prices: $20.00 on 19 Oct to $22.00 on 19 Oct.",
    );
    expect(priceSummary([])).toBe("No prices recorded yet.");
    expect(
      ndviSummary([
        ["2021-10", 0.649],
        ["2021-11", 0.5],
      ]),
    ).toBe(
      "Monthly NDVI, 2 months from 2021-10 to 2021-11, between 0.50 and 0.65.",
    );
  });
});

describe("markerPosition", () => {
  // The plot starts right of the 56px Y axis.
  const plot = { x: 56, y: 12, width: 400, height: 240 };
  const right = plot.x + plot.width;

  it("draws a marker on its own on its point", () => {
    expect(markerPosition(200, 100, 0, plot)).toEqual({ x: 200, y: 100 });
  });

  it("stacks markers on the same point upwards, then toward the middle, capped", () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 9].map((n) => markerPosition(200, 150, n, plot)),
    ).toEqual([
      { x: 200, y: 150 },
      { x: 200, y: 132 },
      { x: 200, y: 114 },
      { x: 218, y: 150 },
      { x: 218, y: 132 },
      { x: 218, y: 114 },
      // The cap: later markers share the last slot.
      { x: 218, y: 114 },
      { x: 218, y: 114 },
    ]);
  });

  it("stacks downwards near the top of the plot", () => {
    expect(markerPosition(200, 20, 2, plot)).toEqual({ x: 200, y: 56 });
  });

  it("never draws over the Y-axis labels at the left edge", () => {
    for (let n = 0; n < 6; n++) {
      const { x } = markerPosition(plot.x, 150, n, plot);
      expect(x).toBeGreaterThanOrEqual(plot.x + 9);
    }
    // A second column fans out to the right, away from the axis.
    expect(markerPosition(plot.x, 150, 3, plot).x).toBe(plot.x + 18);
  });

  it("keeps markers after the last price at the right edge, inside the plot", () => {
    expect(markerPosition(right, 150, 0, plot)).toEqual({
      x: right - 9,
      y: 150,
    });
    expect(markerPosition(right, 150, 1, plot)).toEqual({
      x: right - 9,
      y: 132,
    });
    expect(markerPosition(right, 150, 3, plot).x).toBe(right - 18);
    expect(markerPosition(right, plot.y + plot.height, 0, plot).y).toBe(
      plot.y + plot.height - 9,
    );
  });

  it("places an event after the last price at the end of the time axis", () => {
    const series = priceSeries(
      PRICES,
      [{ id: "late", date: "2026-10-20T00:00:00Z", direction: -1 }],
      false,
    );
    const late = chartMarkers(series).at(-1)!;
    expect([late.kind, late.t, late.price, late.stack]).toEqual([
      "event",
      Date.parse("2026-10-20T00:00:00Z"),
      22,
      0,
    ]);
  });
});

describe("ChartTooltip", () => {
  it("shows a recorded price but not the line's extension to a later marker", () => {
    const tip = (synthetic?: boolean) =>
      ChartTooltip({
        active: true,
        label: 0,
        payload: [{ value: 21, payload: { synthetic } }],
        format: String,
      });
    expect(tip()).not.toBeNull();
    expect(tip(true)).toBeNull();
  });
});

describe("prototypeFacts", () => {
  it("labels the NDVI trend with the same significance rule as the API", () => {
    for (const site of createInitialWorld().sites) {
      const report = latestReport(site);
      if (!report) continue;
      const label = prototypeFacts(report).trendLabel;
      if (report.ndviP >= 0.05) expect(label).toBe("Stable");
      else expect(label).toBe(report.ndviTrend > 0 ? "Improving" : "Declining");
    }
  });
});

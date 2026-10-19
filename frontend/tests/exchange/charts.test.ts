import { describe, expect, it } from "vitest";

import {
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
    expect(marks.map((m) => [m.event.id, m.price])).toEqual([["in", 21]]);
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

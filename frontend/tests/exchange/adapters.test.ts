import { describe, expect, it } from "vitest";

import type { AssetCard, AssetDetail, ReportOut } from "@/lib/api/types";
import {
  boundaryLatLngs,
  changePct,
  chartPrices,
  isApiAssetId,
  newsItems,
  openingPrice,
} from "@/lib/asset-detail";
import {
  countryName,
  marketCard,
  shownCards,
  siteImageUrl,
} from "@/lib/market-cards";
import { asGrade, ndviTrendLabel, num, reportFacts } from "@/lib/report-facts";

import asset from "./fixtures/asset.json";
import cards from "./fixtures/assets.json";

const REPORT = asset.latest_report as unknown as ReportOut;

describe("reportFacts", () => {
  it("copies every number from the API report and its rating snapshot", () => {
    const facts = reportFacts(REPORT)!;
    expect(facts).toMatchObject({
      version: 1,
      period: "2026Q3",
      health: 76.2,
      grade: "A",
      confidence: 71,
      valueLow: 2121067,
      valueMid: 2669511,
      valueHigh: 2669511,
      fairValuePerUnit: 21.4723,
      baseHealth: 76.2,
      adjustment: 0,
      adjustmentReason: null,
      carbonStock: 8828,
      ndviTrend: 0.0097,
      ndviP: 0.0986,
      // Mann–Kendall p ≈ 0.10: not significant, so no direction is claimed.
      trendLabel: "Stable",
      waterChange: -6.6021,
      builtShare: 0.1288,
      summarySource: "fallback",
      simulated: false,
    });
    expect(facts.components.map((c) => [c.key, c.weight, c.value])).toEqual([
      ["vegetation_vigor", 0.3, 0.6255],
      ["natural_cover", 0.25, 0.8389],
      ["habitat_loss", 0.2, 1],
      ["water_stability", 0.15, 0.434],
      ["threat_pressure", 0.1, 1],
    ]);
    expect(
      facts.confidenceParts.map((c) => [c.key, c.weight, c.value]),
    ).toEqual([
      ["coverage", 0.4, 1],
      ["agreement", 0.3, 0.5],
      ["evidence", 0.2, 0.3],
      ["recency", 0.1, 1],
    ]);
    expect(
      Object.values(facts.services).reduce((a, b) => a + (b ?? 0), 0),
    ).toBe(2669511);
    expect(facts.ndvi).toHaveLength(60);
    expect(facts.ndvi[0]).toEqual(["2021-10", 0.649]);
    expect(facts.flags.map((f) => f.code)).toEqual([
      "low_bound_fallback:shrubland",
      "auditor_pending",
    ]);
    expect(facts.attributions[0]).toMatch(/^Dynamic World/);
  });

  it("keeps missing facts null instead of inventing them", () => {
    const bare = {
      ...REPORT,
      rating: null,
      fair_value_per_share: null,
      ndvi_series: [],
    } as ReportOut;
    const facts = reportFacts(bare)!;
    expect(facts.baseHealth).toBeNull();
    expect(facts.carbonStock).toBeNull();
    expect(facts.ndviTrend).toBeNull();
    expect(facts.trendLabel).toBeNull();
    expect(facts.fairValuePerUnit).toBeNull();
    expect(facts.components).toEqual([]);
    expect(facts.ndvi).toEqual([]);
  });

  it("returns null for a report without a grade or health", () => {
    expect(reportFacts({ ...REPORT, grade: null })).toBeNull();
    expect(reportFacts({ ...REPORT, health_score: null })).toBeNull();
  });

  it("parses decimals and grades defensively", () => {
    expect(num("21.4723")).toBe(21.4723);
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(asGrade("AA")).toBe("AA");
    expect(asGrade("Z")).toBeNull();
  });

  it("labels the NDVI trend only when it is significant", () => {
    expect(ndviTrendLabel(0.02, true)).toBe("Improving");
    expect(ndviTrendLabel(-0.02, true)).toBe("Declining");
    expect(ndviTrendLabel(0.02, false)).toBe("Stable");
    expect(ndviTrendLabel(null, true)).toBeNull();
  });
});

describe("market cards", () => {
  const all = (cards as AssetCard[]).map(marketCard);

  it("reads the API card's numbers and the media-route thumbnail", () => {
    const wetland = all.find((c) => c.name === "Xochimilco Wetland")!;
    expect(wetland).toMatchObject({
      price: 21.4723,
      changePct: 0,
      grade: "A",
      trend: null,
      confidence: 71,
      health: 76.2,
      areaHa: 206.7,
      imageUrl: "/api/media/demo-sites/wetland_mx/thumbnail.webp",
    });
    expect(siteImageUrl(null, "https://example.org/a.webp")).toBe(
      "https://example.org/a.webp",
    );
    expect(countryName("MX")).toBe("Mexico");
  });

  it("sorts by grade then health and filters by grade band", () => {
    expect(shownCards(all, "all", "grade").map((c) => c.grade)).toEqual([
      "AA",
      "A",
      "A",
    ]);
    expect(shownCards(all, "all", "grade")[1]!.health).toBe(76.6);
    expect(shownCards(all, "b", "grade")).toEqual([]);
    expect(shownCards(all, "a", "value")[0]!.valueMid).toBe(33801307);
  });

  it("puts cards with missing numbers last", () => {
    const unrated = { ...all[0]!, id: "x", grade: null, confidence: null };
    const sorted = shownCards([unrated, ...all], "all", "confidence");
    expect(sorted.at(-1)!.id).toBe("x");
    expect(shownCards([unrated, ...all], "a", "grade")).not.toContain(unrated);
  });
});

describe("asset detail helpers", () => {
  it("tells real asset IDs from prototype slugs", () => {
    expect(isApiAssetId(asset.id)).toBe(true);
    expect(isApiAssetId("xochimilco-wetland")).toBe(false);
  });

  it("turns the GeoJSON boundary into [lat, lon] points", () => {
    const ring = boundaryLatLngs(asset.geojson as AssetDetail["geojson"]);
    expect(ring.length).toBeGreaterThan(3);
    expect(ring[0]).toEqual([19.2811, -99.1048]);
    expect(
      boundaryLatLngs({
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [1, 2],
              [3, 4],
              [5, 6],
            ],
          ],
        ],
      }),
    ).toEqual([
      [2, 1],
      [4, 3],
      [6, 5],
    ]);
    expect(boundaryLatLngs({ type: "Point", coordinates: [1, 2] })).toEqual([]);
  });

  it("computes the change since the opening price from recorded prices", () => {
    const points = chartPrices([
      { ts: "2026-10-19T00:00:00Z", price: "20.00", reason: "ipo" },
      { ts: "2026-10-19T01:00:00Z", price: "21.00", reason: "order" },
      { ts: "2026-10-19T02:00:00Z", price: "bad", reason: "order" },
    ]);
    expect(points).toHaveLength(2);
    expect(openingPrice(points)).toBe(20);
    expect(changePct(22, 20)).toBeCloseTo(10);
    expect(changePct(22, null)).toBeNull();
  });

  it("lists events newest first with their source", () => {
    const items = newsItems([
      {
        id: "a",
        asset_id: asset.id,
        source: "tavily",
        title: "Old",
        created_at: "2026-10-01T00:00:00Z",
      },
      {
        id: "b",
        asset_id: asset.id,
        source: "admin",
        title: "  ",
        published_at: "2026-10-10",
        direction: -1,
        severity: 4,
        created_at: "2026-10-10T00:00:00Z",
      },
    ]);
    expect(items.map((i) => [i.id, i.title, i.sourceLabel])).toEqual([
      ["b", "Untitled event", "Injected by Time Machine"],
      ["a", "Old", "Found by News Scout"],
    ]);
  });
});

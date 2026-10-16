import { describe, expect, it } from "vitest";

import { answer } from "@/lib/prototype/copilot";
import { areaHa } from "@/lib/prototype/geo";
import {
  maxAffordableUnits,
  priceAfterOrder,
  quote,
} from "@/lib/prototype/market";
import { buildReport, threatPressure } from "@/lib/prototype/rating";
import { isValidWorld } from "@/lib/prototype/store";
import {
  createInitialWorld,
  documentChecks,
  HERO_ID,
  isFreshWorld,
  latestReport,
  launchOffer,
  placeOrder,
  rateDraft,
  registerCommunity,
  updateDraft,
} from "@/lib/prototype/world";

describe("market parity with backend/app/market/engine.py", () => {
  it("matches the engine's fill and price after a buy and a sell", () => {
    // engine.execute on a 1,000,000-share asset at 21.4723: buy 100, then sell 40.
    expect(quote(21.4723, "buy", 100, 1_000_000)).toBe(21.4938);
    expect(priceAfterOrder(21.4723, "buy", 100, 1_000_000)).toBe(21.4938);
    expect(quote(21.4938, "sell", 40, 1_000_000)).toBe(21.4852);
    expect(priceAfterOrder(21.4938, "sell", 40, 1_000_000)).toBe(21.4852);
  });

  it("Max always gives an order the user can afford", () => {
    for (const cash of [7660, 1000, 10_000, 55.5]) {
      const units = maxAffordableUnits(21.47, cash, 1_000_000, 490_000);
      const total = (u: number) =>
        Math.round(quote(21.47, "buy", u, 1_000_000) * u * 100) / 100;
      expect(total(units)).toBeLessThanOrEqual(cash);
      expect(total(units + 1)).toBeGreaterThan(cash);
    }
  });

  it("refuses buys once the float and market-maker inventory are empty", () => {
    const listed = launchOffer(rateDraft(createInitialWorld()), 51);
    const drained = {
      ...listed,
      sites: listed.sites.map((s) =>
        s.id === HERO_ID
          ? { ...s, primaryRemaining: 0, marketMakerUnits: 0 }
          : s,
      ),
    };
    expect(placeOrder(drained, "investor", HERO_ID, "buy", 1)).toMatchObject({
      ok: false,
    });
  });
});

describe("seeded ratings match the backend seed", () => {
  it("opens each listed site at the backend's fair value per share", () => {
    const w = createInitialWorld();
    const mangrove = w.sites.find((s) => s.id === "celestun-mangrove")!;
    const forest = w.sites.find((s) => s.id === "sumidero-forest")!;
    expect(mangrove.ipoPrice).toBe(285.1519);
    expect(forest.ipoPrice).toBe(19.5456);
    expect(mangrove.reports[0].confidence).toBe(71);
    expect(mangrove.reports[0].scriptedAuditor).toBe(false);
    // The later review is labelled as scripted.
    expect(latestReport(mangrove)!.scriptedAuditor).toBe(true);
  });
});

describe("threat pressure", () => {
  it("follows the dev-spec §7.4 worked example", () => {
    expect(threatPressure([{ direction: -1, severity: 4 }])).toBeCloseTo(
      1 - 4 / 15,
      10,
    );
    const r = buildReport({
      siteKey: "wetland_mx",
      siteName: "Xochimilco Wetland",
      scenario: "baseline",
      period: "2026Q3",
      version: 1,
      createdAt: "2026-10-15",
      runId: "r",
      events: [{ direction: -1, severity: 4 }],
    });
    expect(r.health).toBe(73.6);
    expect(r.grade).toBe("A");
    expect(r.components.threat_pressure).toBeCloseTo(0.7333, 3);
  });

  it("ignores positive news", () => {
    expect(threatPressure([{ direction: 1, severity: 5 }])).toBe(1);
  });
});

describe("listing a drawn boundary", () => {
  it("stores the drawn area and scales the values to it", () => {
    const square: [number, number][] = [
      [19.31, -99.12],
      [19.31, -99.116],
      [19.3135, -99.116],
      [19.3135, -99.12],
    ];
    const w = rateDraft(
      updateDraft(registerCommunity(createInitialWorld(), "Co-op"), {
        polygon: square,
      }),
    );
    const hero = w.sites.find((s) => s.id === HERO_ID)!;
    expect(hero.areaHa).toBeCloseTo(areaHa(square), 1);
    const report = latestReport(hero)!;
    expect(report.flags.some((f) => f.code === "custom_boundary")).toBe(true);
    expect(report.valueMid).toBeLessThan(2_669_511);
    expect(w.ledger[HERO_ID][0].payload.area_ha).toBe(hero.areaHa);
  });
});

describe("Copilot", () => {
  it("names each site's real weakest component", () => {
    const w = createInitialWorld();
    expect(
      answer(w, "What drives this grade?", "sumidero-forest").text,
    ).toMatch(/weakest part is habitat loss/);
    expect(
      answer(w, "What drives this grade?", "celestun-mangrove").text,
    ).toMatch(/weakest part is water stability/);
  });

  it("routes confidence questions to the confidence answer", () => {
    const w = createInitialWorld();
    expect(
      answer(w, "Why is confidence low?", "celestun-mangrove").text,
    ).toMatch(/^Confidence is/);
  });
});

describe("verification checks", () => {
  it("passes the consent check only with a consent document", () => {
    expect(
      documentChecks(["Land title certificate (sample).pdf"]).consent_document,
    ).toBe("fail");
    expect(
      documentChecks(["Assembly minutes, consent (sample).pdf"])
        .consent_document,
    ).toBe("pass");
    expect(documentChecks([]).format).toBe("not_run");
  });
});

describe("stored world", () => {
  it("accepts a current world and rejects stale or malformed blobs", () => {
    expect(isValidWorld(createInitialWorld())).toBe(true);
    expect(isValidWorld({ schema: 4 })).toBe(false);
    expect(isValidWorld({ ...createInitialWorld(), schema: 3 })).toBe(false);
    expect(isValidWorld(null)).toBe(false);
  });

  it("knows when the sandbox is still fresh", () => {
    const w = createInitialWorld();
    expect(isFreshWorld(w)).toBe(true);
    expect(isFreshWorld(registerCommunity(w, "x"))).toBe(false);
  });
});

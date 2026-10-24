import { describe, expect, it } from "vitest";

import { siteDataFor } from "@/lib/prototype/data";
import { checkPolygon } from "@/lib/prototype/geo";
import { append, verify } from "@/lib/prototype/ledger";
import { quote } from "@/lib/prototype/market";
import {
  buildReport,
  confidenceFrom,
  fairValuePerUnit,
} from "@/lib/prototype/rating";
import { sha256 } from "@/lib/prototype/sha256";
import {
  createInitialWorld,
  HERO_ID,
  injectEvent,
  latestReport,
  launchOffer,
  nextQuarter,
  placeOrder,
  rateDraft,
  tamperLedger,
  updateDraft,
  type World,
} from "@/lib/prototype/world";

function listedHero(): World {
  const w = updateDraft(createInitialWorld(), {
    polygon: siteDataFor("wetland_mx").polygon.slice(0, -1),
  });
  return launchOffer(rateDraft(w), 51);
}

describe("sha256", () => {
  it("matches the standard test vectors", () => {
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("rating formulas", () => {
  it("keeps the backend's deterministic baseline for the hero wetland", () => {
    const r = buildReport({
      siteKey: "wetland_mx",
      siteName: "Xochimilco Wetland",
      scenario: "baseline",
      period: "2026Q3",
      version: 1,
      createdAt: "2026-10-15",
      runId: "r",
    });
    expect(r.health).toBe(76.2);
    expect(r.grade).toBe("A");
    expect(r.confidence).toBe(71);
    // Same number the backend computes for fair value per share.
    expect(r.fairValuePerUnit).toBeCloseTo(21.4723, 3);
  });

  it("caps the Auditor's adjustment at ±10", () => {
    const r = buildReport({
      siteKey: "wetland_mx",
      siteName: "X",
      scenario: "baseline",
      period: "2026Q3",
      version: 1,
      createdAt: "2026-10-15",
      runId: "r",
      overlay: {
        agreement: 0.8,
        evidence: false,
        adjustment: -40,
        reason: "test",
        citations: [],
      },
    });
    expect(r.adjustment).toBe(-10);
    expect(r.health).toBeCloseTo(66.2, 5);
  });

  it("computes confidence and fair value per dev-spec §7.4 and §8", () => {
    expect(
      confidenceFrom({
        coverage: 1,
        agreement: 0.8,
        evidence: 0.3,
        recency: 1,
      }),
    ).toBe(80);
    expect(fairValuePerUnit(1_000_000, 100, 100, 1_000_000)).toBe(10);
  });
});

describe("market", () => {
  it("applies slippage in the trade's direction", () => {
    expect(quote(20, "buy", 1000, 1_000_000)).toBeCloseTo(20.2, 4);
    expect(quote(20, "sell", 1000, 1_000_000)).toBeCloseTo(19.8, 4);
  });

  it("sends primary-unit proceeds to the community fund and conserves cash", () => {
    const w = listedHero();
    const before = w.cash.investor;
    const result = placeOrder(w, "investor", HERO_ID, "buy", 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hero = result.world.sites.find((s) => s.id === HERO_ID)!;
    expect(hero.communityFund).toBeCloseTo(result.receipt.total, 2);
    expect(result.world.cash.investor).toBeCloseTo(
      before - result.receipt.total,
      2,
    );
    expect(hero.primaryRemaining).toBe(490_000 - 100);
  });

  it("blocks community members from trading their own site", () => {
    const result = placeOrder(listedHero(), "steward", HERO_ID, "buy", 10);
    expect(result.ok).toBe(false);
  });

  it("refuses orders beyond the play-money balance", () => {
    const result = placeOrder(listedHero(), "investor", HERO_ID, "buy", 2000);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("Time Machine", () => {
  it("restores next quarter, then downgrades and alerts holders on encroachment", () => {
    const bought = placeOrder(listedHero(), "investor", HERO_ID, "buy", 50);
    if (!bought.ok) throw new Error(bought.message);
    const restored = nextQuarter(bought.world);
    const hero = () => restored.sites.find((s) => s.id === HERO_ID)!;
    expect(latestReport(hero())!.grade).toBe("AA");

    const hit = injectEvent(restored, HERO_ID, "encroachment");
    const report = latestReport(hit.sites.find((s) => s.id === HERO_ID)!)!;
    expect(report.grade).toBe("BBB");
    expect(report.adjustment).toBe(-3);
    expect(report.citations.some((c) => c.startsWith("event:"))).toBe(true);
    expect(
      hit.alerts.some(
        (a) => a.persona === "investor" && a.severity === "critical",
      ),
    ).toBe(true);
    expect(hit.alerts.some((a) => a.persona === "steward")).toBe(true);
  });
});

describe("The Record", () => {
  it("verifies an intact chain and detects tampering", () => {
    const w = listedHero();
    expect(verify(w.ledger[HERO_ID])).toMatchObject({ valid: true });
    const forged = tamperLedger(w, HERO_ID);
    expect(verify(forged.ledger[HERO_ID])).toMatchObject({
      valid: false,
      brokenAt: forged.tampered[HERO_ID],
    });
  });

  it("links each entry to the previous hash", () => {
    const chain = append(
      append([], "listing", "2026-10-15", { a: 1 }),
      "report",
      "2026-10-15",
      { b: 2 },
    );
    expect(chain[1].prevHash).toBe(chain[0].hash);
  });
});

describe("polygon checks", () => {
  const wetland = siteDataFor("wetland_mx").polygon.slice(0, -1);

  it("accepts the hero boundary and measures its area", () => {
    const check = checkPolygon(wetland, []);
    expect(check.ok).toBe(true);
    expect(check.areaHa).toBeGreaterThan(190);
    expect(check.areaHa).toBeLessThan(225);
  });

  it("rejects small, self-crossing and overlapping shapes", () => {
    const tiny: [number, number][] = [
      [19.28, -99.1],
      [19.2801, -99.1],
      [19.2801, -99.0999],
    ];
    expect(checkPolygon(tiny, [])).toMatchObject({ ok: false });
    const bowtie: [number, number][] = [
      [19.27, -99.12],
      [19.3, -99.08],
      [19.27, -99.08],
      [19.3, -99.12],
    ];
    expect(checkPolygon(bowtie, [])).toMatchObject({ ok: false });
    expect(
      checkPolygon(wetland, [{ name: "Other", polygon: wetland }]),
    ).toMatchObject({ ok: false });
  });
});

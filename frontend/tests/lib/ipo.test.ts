import { describe, expect, it } from "vitest";

import openapi from "@/lib/api/openapi.json";
import { ApiError } from "@/lib/api/errors";
import {
  blockedExplanation,
  CONFIDENCE_FACTOR_FORMULA,
  FORMULA_YEARS,
  HEALTH_FACTOR_FORMULA,
  sharesDisplay,
  trimDecimal,
  DEFAULT_RETAINED_PCT,
  DEFAULT_TOTAL_SHARES,
  ipoRefusal,
  MAX_RETAINED_PCT,
  MAX_TOTAL_SHARES,
  MIN_RETAINED_PCT,
  MIN_TOTAL_SHARES,
  parseRetainedPct,
  parseTotalShares,
  previewMatches,
  retainedInput,
} from "@/lib/ipo";
import { unitsInput } from "@/lib/trade";

type Bound = { minimum?: number; maximum?: number; default?: unknown };

describe("offering bounds", () => {
  it("match the API contract (app/market/offering.py)", () => {
    const launch = openapi.components.schemas.IpoLaunch.properties;
    const shares = launch.total_shares as Bound;
    const retained = launch.retained_pct.anyOf[0] as Bound;
    expect([shares.minimum, shares.maximum, shares.default]).toEqual([
      MIN_TOTAL_SHARES,
      MAX_TOTAL_SHARES,
      DEFAULT_TOTAL_SHARES,
    ]);
    expect([retained.minimum, retained.maximum]).toEqual([
      MIN_RETAINED_PCT,
      MAX_RETAINED_PCT,
    ]);
    expect(Number(launch.retained_pct.default)).toBe(DEFAULT_RETAINED_PCT);
  });

  it("match the preview's query parameters", () => {
    const params = openapi.paths["/assets/{asset_id}/ipo/preview"].get
      .parameters as { name: string; schema: Bound & { anyOf?: Bound[] } }[];
    const shares = params.find((p) => p.name === "total_shares")!.schema;
    const retained = params.find((p) => p.name === "retained_pct")!.schema;
    expect([shares.minimum, shares.maximum, shares.default]).toEqual([
      MIN_TOTAL_SHARES,
      MAX_TOTAL_SHARES,
      DEFAULT_TOTAL_SHARES,
    ]);
    expect([retained.anyOf![0]!.minimum, retained.anyOf![0]!.maximum]).toEqual([
      MIN_RETAINED_PCT,
      MAX_RETAINED_PCT,
    ]);
    expect(Number(retained.default)).toBe(DEFAULT_RETAINED_PCT);
  });
});

describe("formula labels", () => {
  it.each(["IpoPreviewOut", "IpoOut"] as const)(
    "match %s's formula and factor descriptions",
    (name) => {
      const terms = openapi.components.schemas[name].properties;
      expect(terms.formula.default).toContain(
        `fair_value_total = value_mid × ${FORMULA_YEARS} × health_factor × confidence_factor`,
      );
      expect(terms.health_factor.description).toBe(HEALTH_FACTOR_FORMULA);
      expect(terms.confidence_factor.description).toBe(
        CONFIDENCE_FACTOR_FORMULA,
      );
    },
  );

  it("shows API decimals without re-rounding", () => {
    expect(trimDecimal("0.92550")).toBe("0.9255");
    expect(trimDecimal("0.9999999")).toBe("0.9999999");
    expect(trimDecimal("71.00")).toBe("71");
    expect(trimDecimal("85.10")).toBe("85.1");
    expect(trimDecimal("5166929")).toBe("5166929");
    expect(trimDecimal("100")).toBe("100");
  });
});

describe("parseTotalShares", () => {
  it.each([
    ["10000", 10_000],
    ["10000000", 10_000_000],
    ["1000000", 1_000_000],
    ["9999", null],
    ["10000001", null],
    ["", null],
    ["1e6", null],
  ])("%s → %s", (text, expected) => {
    expect(parseTotalShares(text)).toBe(expected);
  });

  it("keeps digits only as the owner types, shown with separators", () => {
    expect(unitsInput("1,000,000")).toBe("1000000");
    expect(unitsInput("0012 000")).toBe("12000");
    expect(sharesDisplay("2500000")).toBe("2,500,000");
    expect(sharesDisplay("")).toBe("");
  });
});

describe("parseRetainedPct", () => {
  it.each([
    ["51", "51"],
    ["10", "10"],
    ["90", "90"],
    ["62.5", "62.5"],
    ["62.50", "62.5"],
    ["51.00", "51"],
    ["9.99", null],
    ["90.01", null],
    ["51.", null],
    ["51.123", null],
    ["", null],
  ])("%s → %s", (text, expected) => {
    expect(parseRetainedPct(text)).toBe(expected);
  });

  it("keeps at most 2 decimals as the owner types", () => {
    expect(retainedInput("62.555")).toBe("62.55");
    expect(retainedInput("6x2.5%")).toBe("62.5");
    expect(retainedInput("1.2.3")).toBe("1.23");
  });
});

describe("previewMatches", () => {
  it("compares the echoed offering, not the formatting", () => {
    const echoed = { total_shares: 1_000_000, retained_pct: "51.00" };
    expect(previewMatches(echoed, 1_000_000, "51")).toBe(true);
    expect(previewMatches(echoed, 1_000_000, "52")).toBe(false);
    expect(previewMatches(echoed, 2_000_000, "51")).toBe(false);
  });
});

describe("ipoRefusal", () => {
  const error = (status: number, code: string | null) =>
    new ApiError(status, "safe message", code);

  it.each([
    [409, "ipo_already_launched", "launched"],
    [409, "asset_not_listed", "not_listed"],
    [409, "no_rating", "no_rating"],
    [409, "ipo_price_changed", "price_changed"],
    [409, "run_in_progress", "blocked"],
    [409, "ipo_price_too_high", "blocked"],
    [409, "ipo_price_too_low", "blocked"],
    [409, "verification_required", "blocked"],
    [403, "owner_only", "owner_only"],
    [403, "treasury_cannot_act", "owner_only"],
    [404, "not_found", "not_found"],
    [409, "something_else", "error"],
    [0, null, "error"],
    [500, null, "error"],
  ])("%s %s → %s", (status, code, kind) => {
    expect(ipoRefusal(error(status, code)).kind).toBe(kind);
  });

  it("never shows a code to the owner", () => {
    for (const code of ["run_in_progress", "verification_required", "x"]) {
      const { title, body } = blockedExplanation(code);
      expect(`${title} ${body}`).not.toContain(code);
    }
  });
});

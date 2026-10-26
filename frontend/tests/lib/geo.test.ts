import { describe, expect, it } from "vitest";

import { checkPolygon } from "@/lib/geo";
import { SITE_DATA } from "@/lib/site-data";

describe("polygon checks", () => {
  const wetland = SITE_DATA.find((s) => s.key === "wetland_mx")!.polygon.slice(
    0,
    -1,
  );

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

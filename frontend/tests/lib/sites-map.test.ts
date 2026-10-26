import { describe, expect, it } from "vitest";

import {
  mapOutline,
  ringLatLngs,
  siteCentre,
  sitesBounds,
} from "@/lib/sites-map";

const RING: [number, number][] = [
  [-99.1, 19.28],
  [-99.08, 19.28],
  [-99.08, 19.3],
  [-99.1, 19.28],
];

describe("sites map geometry", () => {
  it("turns [lon, lat] rings into Leaflet's [lat, lng]", () => {
    expect(ringLatLngs(RING)[1]).toEqual([19.28, -99.08]);
  });

  it("pins a site at the middle of its outline, or nowhere without one", () => {
    const [lat, lng] = siteCentre([RING])!;
    expect(lat).toBeCloseTo(19.29);
    expect(lng).toBeCloseTo(-99.09);
    expect(siteCentre([])).toBeNull();
  });

  it("frames every outline", () => {
    expect(sitesBounds([[RING], [[[-90, 21]]], []])).toEqual([
      [19.28, -99.1],
      [21, -90],
    ]);
    expect(sitesBounds([[], []])).toBeNull();
  });

  it("uses a demo site's own polygon when its card has no outline", () => {
    expect(mapOutline({ outline: [RING], siteKey: "wetland_mx" })).toEqual([
      RING,
    ]);
    const demo = mapOutline({ outline: [], siteKey: "wetland_mx" });
    expect(demo).toHaveLength(1);
    expect(demo[0]!.length).toBeGreaterThan(3);
    expect(mapOutline({ outline: [], siteKey: null })).toEqual([]);
  });
});
